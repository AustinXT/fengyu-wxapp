# 审计报告：消息中心 (16)

**审计时间**：2026-04-25 23:55
**域 ID**：16
**审计员**：claude-opus-4-7
**审计时长**：约 22 分钟
**关联 PR/Ticket**：share-gift / member-birthday / member-thanksgiving / member-level-150d-lock & upgrade benefits

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/message.ts:11-37`（`messages`，22 列 + idx_messages_recipient + uq_messages_idempotency_key partial unique on idempotency_key） | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/messages.ts:52`（getMessagesPaginated）、`:156`（getMessageTypes）、`:173`（deleteMessage）、`:392`（batchSendMessages）、`:312`（getCustomersForBatchMessage）、`:287`（getOrgNodesForBatchMessage） | 无 message route（`staffApi/routes/` 完全不消费 messages 表） | `fengyu-client/cloudfunctions/clientApi/routes/message.js:10/40/55`（list/read/unreadCount） |
| 触发点 | `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:111-118`、`grant-thanksgiving-benefits.ts:127-134`、`refresh-member-levels.ts:238-244`；`actions/customers.ts:836-838`（合并孤儿顾客时迁移 recipient_id） | `staffApi/share-gift.js:131-136`（订单完成首单触发，由 `routes/order.js:1000-1015` 调用） | `clientApi/share-gift.js:131-136`（由 `routes/order.js` 触发）、`payNotify/share-gift.js:131-136`（由 `payNotify/index.js:474-493` 触发） |
| 前端 | `fengyu-admin/src/app/(main)/messages/page.tsx:8-48`（Server Component）+ `_components/messages-page.tsx:70-766`（管理 + 批量发送） | — | `fengyu-client/miniprogram/pagesProfile/messages/messages.ts:1-120` + `messages.wxml:1-52` + `pages/profile/profile.ts:71-74`（unreadCount 角标） |
| 测试 | `fengyu-admin/src/actions/messages.test.ts`（495 行，覆盖 batch/list/orgResolve；表 mock） | — | `fengyu-client/cloudfunctions/clientApi/__tests__/routes/message.test.js`（149 行，list/read/unreadCount 全覆盖） |
| 权限 | `fengyu-admin/src/lib/permissions.ts:30` admin 角色独占 `message:list / message:delete / message:send`；其它 6 角色全部 0 项 | — | 所有 message 路由仅过 `auth` 中间件（`clientApi/index.js:55-57`），未挂 `requirePhone()` |

## 2. 数据流图

```
【写入端】
admin batchSendMessages   → INSERT messages × N（500 一片，无 idempotency_key, message_type 用户输入）
admin mergeClientProfile  → UPDATE messages SET recipient_id = source WHERE recipient_id = orphan
cron-worker STEP 2/3/4    → INSERT messages（idempotency_key = `member-upgrade-{userId}-{toLevel}`
                                            / `birthday-msg-{YYYY}-{userId}`
                                            / `thx-msg-{YYYY-MM}-{userId}`，message_type='system'）
share-gift（3 副本）       → INSERT messages（idempotency_key = `sg-msg-{role}-{saleOrderId}`，
                                              message_type='system'，含 ref_entity_type='sale_order'）

【读取端】
client message.list       → SELECT … WHERE recipient_type='客户' AND recipient_id=$userId
client message.read       → UPDATE … SET is_read=true WHERE id=$id AND recipient_type='客户' AND recipient_id=$userId
client message.unreadCount→ SELECT count(*) WHERE recipient_type='客户' AND recipient_id=$userId AND is_read=false
admin getMessagesPaginated→ SELECT messages JOIN client/staff name; **无 scope 过滤**

【消费缺口】
recipient_type='员工' 数据 → 当前 0 个写入路径 + 0 个读取路径（孤儿枚举）
```

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

- **[P0-16-01]** client `message.list` 缺 `requirePhone()` 守卫，未绑机用户消息可被读取
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:10-35`、`clientApi/index.js:55`
  - 现象：list/read/unreadCount 只过 `auth`（注 OPENID 但 `userId` 可为 null，详见 `middleware/auth.js:54-61`），未挂 requirePhone。当 `ctx.auth.userId` 为 null（用户从未 bindPhone）时，SQL `WHERE recipient_id = $1`（$1 = null）永远返回 0 行，看似无害；但 `points / card / order` 这些读私域数据的接口在 audit-15 已统一被指出应加 requirePhone 兜底（参 audit-15 P0-15-XX），消息中心是同一类隐私入口，规范应一致。
  - 风险：若未来新增"广播给 NULL recipient"或运营误把 batchSend 写入 `recipient_id=NULL` 行（schema notNull 兜底，但 admin 端 batch/孤儿迁移把 messages.recipientId 视为可任意改写——`actions/customers.ts:836-838` 直接把 messages.recipientId 改为 sourceUserId 不带"老 source 不能被改写覆盖" CAS），则未绑机用户也可能命中本地缓存空 userId 调 `message.read` 把别人的消息标已读。
  - 复现：1) 用户授权 OPENID 但跳过 bindPhone；2) 调 `message.read` 传任意 messageId → 命中 `WHERE id=$id AND recipient_id=null` rowCount=0（看似拦下）；3) 但同会话 `userId` 改写场景下守卫薄弱
  - 修复：(L3) `clientApi/routes/message.js:list/read/unreadCount` 函数顶部 `await requirePhone()(ctx, async () => {})`；与 audit-15 points/card 守卫风格一致

- **[P0-16-02]** admin `batchSendMessages` **完全不写 idempotency_key**，重试 / 双击会重复入库
  - 文件：`fengyu-admin/src/actions/messages.ts:460-475`
  - 现象：循环 `values.map((userId) => ({...recipientType:'客户', recipientId, title, body, messageType, isRead:false, createdAt: now}))` 不构造 idempotency_key；`uq_messages_idempotency_key`（partial unique，仅 `WHERE idempotency_key IS NOT NULL`）对此完全无效。
  - 风险：网络抖动 / Server Action 失败 retry / 浏览器双 tab 提交都会让同一批发两份（甚至 N 份）；顾客侧消息列表重复，未读角标翻倍；运营侧无法查重。违反 `real.md` #3 支付幂等的同精神（写入幂等）。
  - 复现：1) admin 选 100 顾客 → 点"确认发送（100 人）"；2) Next.js Server Action 在 hydration 慢的浏览器双击；3) DB 出现 200 行同 title/body/recipient 不同 id
  - 修复：(L7) 生成一次 `batchId = randomUUID()`，每行 idempotency_key = `batch-${batchId}-${userId}`；同一批写入 idempotent；audit 日志 detail 写 batchId 便于追溯

- **[P0-16-03]** admin `getMessagesPaginated` 完全无 scope 过滤，非 admin 角色拿到全网消息（PII 越权）
  - 文件：`fengyu-admin/src/actions/messages.ts:46-50`、`:62-92`
  - 现象：注释明确写 "messages 表无 store_id，不走 scope 过滤；该页面仅 admin 可见（管理员对全局消息做审计/清理）"。但权限矩阵 `permissions.ts:30` 把 `message:list` 仅授给 `admin`，其他 6 角色全无；菜单 `lib/menu.ts` 也按 hasPermission 隐藏。**实际防御依赖 `requirePermission(session, 'message:list')` 单点**（`messages.ts:56`），路由层无 scope condition 兜底。一旦权限矩阵被无意调整或新增角色误授 `message:list`，将立刻穿透看到全网客户姓名、手机号（recipientName JOIN + recipientId 显式输出，含老顾客手机的全列 leftJoin clientWechatUsers）。
  - 风险：违反 `real.md` #5/#6 后端统一鉴权 + 组织域数据隔离；属于"单点权限 + 无门店级兜底"的高 PII 暴露面（audit-10 P0-10-01 同模式）。
  - 修复：(L3 lib + L7 actions) 在 messages.ts 加 `scopeCondition(session, ...)`；recipient_type='客户' 时 JOIN clientWechatUsers + 用 `boundStoreId` scope；recipient_type='员工' 时 JOIN staffWechatUsers + 用 `storeId` scope；管理员（`scopeStoreIds === null`）继续看全部

- **[P0-16-04]** `messageRecipientType='员工'` 是孤儿枚举：staffApi 全部 16 个 routes 没有任何 list/read/unreadCount，写入路径也不存在
  - 文件：`db/schema/enums.ts:87`、`fengyu-staff/cloudfunctions/staffApi/routes/`（grep 0 命中）、`fengyu-staff/cloudfunctions/staffApi/index.js`（无 message.* 路由）
  - 现象：枚举 `["客户","员工"]` 显式定义；admin batchSendMessages 显式注释 "消息仅允许 recipient_type='客户'（员工消息暂不支持批量发送）"（`actions/messages.ts:391`）；staffApi 也无任何 INSERT 'recipient_type=员工' 路径。所以"员工"枚举从未被写入，也无任何读取入口。
  - 风险：spec 与代码脱节（`staff.pr.spec.md:410` 列出 §3.20 消息中心 / `client.pr.spec.md:292` 列出 §3.21 消息中心 标 "未实现"）；将来若管理员误调用 `INSERT … recipient_type='员工'…`（admin batchSendMessages 类型签名暗示可扩展），员工无任何前端入口可读取消息——数据黑洞。也违反 audit-01 三端用户表隔离（员工/顾客 recipient_id 共用 text 列，现 admin batch 仅写 '客户'，但 staff schema PK 为 employee_id，与 client_user_id 同为 text 但全局可能撞碰，暂依赖 recipientType 区分）。
  - 修复：(L0/L7 二选一)
    - 选项 A：staffApi 增加 `routes/message.js` 三接口（list/read/unreadCount，模式照搬 client，过 `requireStaffBound()`）
    - 选项 B：从 `messageRecipientTypeEnum` 删除"员工"，并在 schema 注释中标 "员工消息延后实现"

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-16-05]** message_type 字段未枚举化，admin 端可输入任意 50 字内字符串
  - 文件：`fengyu-admin/src/actions/messages.ts:407-410`、`db/schema/message.ts:21`（`varchar(50)`，无 CHECK）
  - 现象：admin batch 输入"分类"，最长 50 字；cron 用 `'system'`，share-gift 用 `'system'`，client 渲染 `TYPE_COLOR_MAP` 仅识别 `appointment / order / system` 三值（`pagesProfile/messages/messages.ts:8-18`）。批量发送写入 `'promotion'` / `'campaign'` / `'通知'` 等任意值时，client UI 渲染 `dotColor='#999999'` + `iconName='info-o'`（fallback 路径），但 admin 列表筛选下拉只展示 DISTINCT 中已存在的值，开发者难以知道哪些值合法。
  - 风险：数据画像不可控，前端渲染不一致；message_type='促销' vs 'promotion' 同语义两种写入；client 端无识别即落 fallback 配色。
  - 修复：(L0) 新建 `messageTypeEnum`（如 `appointment / order / service / system / promotion / refund / coupon / points`）；admin batchSend 改 select 限定可选；cron-worker 三步 INSERT 复用同枚举

- **[P1-16-06]** cron 三处 INSERT messages 完全不写 `ref_entity_type` / `ref_entity_id`
  - 文件：`grant-birthday-benefits.ts:111-118`、`grant-thanksgiving-benefits.ts:127-134`、`refresh-member-levels.ts:238-244`
  - 现象：share-gift 写了 `ref_entity_type='sale_order'`、`ref_entity_id=saleOrderId`（`share-gift.js:132-135`），cron 三步全部省略；admin batchSend 也省略。
  - 风险：client 前端 `onTapMessage` 按 `record.refEntity / record.refId` 跳详情（`pagesProfile/messages/messages.ts:114-117`），cron 类消息（生日礼/感恩日/升级礼）无法链接到"我的优惠券"或"积分明细"；用户看到"恭喜升级金钻 + 积分券礼包"但点击无任何反馈。
  - 修复：(L7) cron 三步在 INSERT 时 `ref_entity_type='customer_benefit'` + `ref_entity_id=YYYY` 或 `YYYY-MM`；client 端 `onTapMessage` 增加 `customer_benefit` 跳转到积分页/券页

- **[P1-16-07]** client `message.read` 重复点击会反复 UPDATE（无 `AND is_read=false` 守卫）
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:45-49`
  - 现象：`UPDATE messages SET is_read=true WHERE id=$1 AND recipient_type=$2 AND recipient_id=$3` 没有 `AND is_read=false`；每次点击已读消息都会触发一次 DB write 行锁。schema 没有 `read_at` 列（即任务 brief 提及的"首次阅读时间"），现实只有 boolean is_read。
  - 风险：1) 性能：列表上下滑时 `onTapMessage` 异步触发，已读消息浪费写次数；2) CAS 缺失：未来若添 read_at 列，多次写会覆盖首次时间；3) 与 audit 横切 CC2 状态机 CAS 一致缺口。
  - 修复：(L3) `routes/message.js:46` 改 `… WHERE id=$1 AND recipient_type='客户' AND recipient_id=$2 AND is_read=false`，rowCount=0 表示已读直接 success

- **[P1-16-08]** admin `deleteMessage` 物理硬删，无软删，无审计 detail
  - 文件：`fengyu-admin/src/actions/messages.ts:173-191`
  - 现象：直接 `db.delete(messages).where(eq(messages.id, id))`；`logOperation` 仅记 `(action='message.delete', target_id=String(id))`，**不记 title/recipient_id**。删除后无法回查"删了谁的什么消息"。
  - 风险：违反 audit-23 操作日志规范（应在 detail 中保留关键快照）；admin 误删后无法恢复；与 audit-15 P0-15-XX 同类违反"金融级流水不可硬删"原则。
  - 修复：(L0) schema 加 `deleted_at timestamp`；(L7) deleteMessage 改 soft-delete + logOperation 写 detail = `{recipientType, recipientId, title, messageType}`

- **[P1-16-09]** admin `mergeClientProfile` 把 messages.recipient_id 直接 UPDATE 到 source，不做 idempotency_key 冲突预检
  - 文件：`fengyu-admin/src/actions/customers.ts:836-838`
  - 现象：`tx.update(messages).set({recipientId: sourceUserId}).where(and(eq(messages.recipientType,'客户'), eq(messages.recipientId, orphanUserId)))` 一把 UPDATE。但若 source 和 orphan 都收到了同一 cron 类消息（如生日礼，幂等键 `birthday-msg-{YYYY}-${userId}` 因 userId 不同分别命中两条），UPDATE 后两条 messages 都挂 source.recipientId — 但 idempotency_key 仍为不同的 orphan/source 后缀，无 unique 冲突；UI 看上去就是"同一年生日礼礼包发了两份"。
  - 风险：merge 后用户看到重复消息（视觉数据残留），admin 也无法分辨；与 audit-10 客户合并语义未到位。
  - 修复：(L7) merge 前 SELECT messages WHERE recipient_id IN (orphan, source) AND idempotency_key IS NOT NULL；orphan 行若与 source 行 idempotency_key 同根（去掉 -orphan/-source 后缀比对）则 DELETE orphan 行，否则 UPDATE recipient_id

- **[P1-16-10]** uq_messages_idempotency_key partial unique 唯一性维度过松：跨 `recipient_id` 全局唯一
  - 文件：`db/schema/message.ts:33-35`
  - 现象：`uniqueIndex('uq_messages_idempotency_key').on(table.idempotencyKey).where(sql\`idempotency_key IS NOT NULL\`)` 是**全表全局**唯一。share-gift 用 `sg-msg-${role}-${saleOrderId}`（role∈{inviter, invitee}）已带角色后缀避免冲突；cron 生日 `birthday-msg-${YYYY}-${userId}` 带 userId 后缀避免冲突。所以现状没有错乱。但**新增任意"幂等键不带 userId"的消息源**（如系统公告 `system-bulletin-${date}`）只能写一行，第二个收件人会被 ON CONFLICT DO NOTHING 静默吞掉。
  - 风险：未来扩展"全员系统公告"必踩坑（一张公告只发给第一人）。idempotency 应在"发布维度"不在"行维度"。
  - 修复：(L0) 改成 `(idempotency_key, recipient_type, recipient_id) WHERE idempotency_key IS NOT NULL` 复合 unique；现有 5 类幂等键全部兼容（因为已经在 key 里隐含了 userId）

- **[P1-16-11]** client message 列表渲染 `body` 用 `<text>` 直接展示，无 XSS 风险（被 WXML 自动转义），但 admin 端 batch 输入也无 XSS / 链接合法性校验
  - 文件：`fengyu-admin/src/actions/messages.ts:399-410`、`messages-page.tsx:583-588`（textarea）
  - 现象：admin 输入正文直接写入 `body` text 列；微信小程序 WXML `{{item.body}}` 会自动 HTML escape，client 端无 XSS。但 admin 详情 Dialog `messages-page.tsx:512-516` 用 `<div className="whitespace-pre-wrap …">{detail.body}</div>` 也是 React 自动 escape，安全。但 body 可写任意 HTTP 链接，无白名单 / 富文本审核 / 长度上限。
  - 风险：钓鱼链接通过 admin 注入到客户消息（如 `点这里领奖 https://malicious.example/...`），客户长按可复制访问；审核流程缺失。
  - 修复：(L7) admin batchSend 加 body length ≤ 1000 + URL 黑白名单 / 仅允许内站链接；或新增审核流（`pending_review` → admin 二次审批）

### 3.3 P2（代码质量）

- **[P2-16-12]** 错误前缀仅 `INVALID_PARAMS`，缺乏 NOT_FOUND / PERMISSION_DENIED 区分
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:43`
  - 现象：read 仅当缺 messageId 时抛 `INVALID_PARAMS`；id 不存在或归他人时静默 rowCount=0 → success；client 无法区分"已读" / "不存在" / "他人的"。
  - 修复：read 在 UPDATE rowCount=0 时 SELECT 一次确认：若行不存在 → `NOT_FOUND`，若 recipient_id 不匹配 → `PERMISSION_DENIED`，若 is_read=true → success（幂等）

- **[P2-16-13]** unreadCount 缺 dedicated 索引（idx_messages_recipient 已存在 (recipientType, recipientId, isRead)，已覆盖）
  - 文件：`db/schema/message.ts:32`
  - 现象：现有 `idx_messages_recipient ON (recipient_type, recipient_id, is_read)` 完美覆盖 unreadCount + list；EXPLAIN 应是 Index Scan。无需新增。但若 messages 行膨胀到亿级（拉新批量发送），可考虑 partial index `WHERE is_read=false`。
  - 修复：监控/告警驱动；现状 OK

- **[P2-16-14]** 三副本 share-gift.js 冗余维护成本（`fengyu-staff/staffApi/share-gift.js`、`fengyu-client/clientApi/share-gift.js`、`fengyu-client/payNotify/share-gift.js`），已在 audit-04/audit-13 提及
  - 文件：三处 161 行字节级一致代码
  - 现象：注释明确 "以下三份副本必须保持字节级一致"；任何 message 模板修改要 3 处同步。
  - 修复：抽到 `db/scripts/shared/`、CloudBase node_modules 共享包，或部署时构建符号链接

- **[P2-16-15]** message_type 在三端首次定义集合不齐：client 仅识别 3 值（appointment/order/system），cron+share-gift 实际只写 'system'
  - 文件：`pagesProfile/messages/messages.ts:8-18`（client TYPE_COLOR_MAP）
  - 现象：client 配色 TYPE_COLOR_MAP 写了 appointment/order/system，**但全栈无任何 INSERT message_type='appointment' 或 'order'**。预约/订单类消息当前根本不存在；产品规范 `client.pr.spec.md:292-294` 标 "screen_024：类型：预约提醒（蓝）、支付通知（绿）、优惠通知（橙）" 全部"未实现"。
  - 修复：业务侧补足"订单状态变更""预约确认""服务完成"等业务事件触发 INSERT messages（应属 audit-02/06 域，本域仅记录配色已就绪）

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 入口 | 仅"管理 + 批量发送" | **完全无 message route** | list/read/unreadCount | 员工无法读消息，messageRecipientType='员工' 孤儿 | P0-16-04 |
| 鉴权 | requirePermission('message:list/send/delete') | — | 仅 auth，无 requirePhone | client 防御弱 | P0-16-01 |
| Scope | 无 scope 过滤（注释承认） | — | recipient_id 单值过滤 | admin 单点权限风险 | P0-16-03 |
| 幂等 | batchSend 不写 idempotency_key | — | — | 重发翻倍 | P0-16-02 |
| 字段命名 | recipientType / recipientId / messageType / refEntityType / refEntityId | — | 同 | OK |  |
| 枚举值 | recipientType 仅写 '客户'；可读 '客户'+'员工' | — | 仅读 '客户' | '员工' 半实现 | P0-16-04 |
| message_type | 自由文本（admin 输入） | — | 仅识别 3 值（fallback 兜底） | 数据画像不一致 | P1-16-05 |
| ref_entity_type/id | 不写（batch） | share-gift 写 'sale_order' | 按 ref_entity_type 跳转 | cron 消息无跳转 | P1-16-06 |
| read 守卫 | 不适用 | — | 无 `AND is_read=false` | 重复 UPDATE | P1-16-07 |
| 删除 | 物理硬删 | — | 不能删 | 审计断裂 | P1-16-08 |
| body 富文本 | 任意 1000+ 字符 / 含链接 | — | text 渲染（自动 escape） | 钓鱼注入 | P1-16-11 |

## 5. 横切检查（套用 §3 模板）

- [x] CC1 数值：消息无金额字段，N/A
- [ ] CC2 并发幂等：admin batchSend 缺 idempotency_key（**P0-16-02**）；client read 缺 CAS（P1-16-07）；merge 不去重（P1-16-09）；uq_messages_idempotency_key 维度过松（P1-16-10）
- [ ] CC3 隔离：admin getMessagesPaginated 完全无 scope 过滤（**P0-16-03**）；client list/read/unreadCount **OK**（recipient_id 三处一致）
- [ ] CC4 鉴权：client 三接口缺 requirePhone（P0-16-01）；admin 单点 `message:list` 权限（P0-16-03）
- [ ] CC5 错误码：client read NOT_FOUND/PERMISSION_DENIED 缺失（P2-16-12）
- [ ] CC6 PII：admin 详情 Dialog 直显 recipientId（顾客 user_id text）+ recipientName + body（手机号等）；admin scope 防御弱（P0-16-03）；body 富文本无审核（P1-16-11）
- [x] CC7 时间字段：created_at DEFAULT NOW() ✅；无 read_at / sent_at；is_read boolean
- [x] CC8 WXML：client wxml `{{item.body}}` 自动 escape ✅
- [ ] CC9 测试：client `message.test.js` 149 行覆盖 list/read/unreadCount + 越权防御 ✅；admin `messages.test.ts` 495 行覆盖 batch 路径 ✅；但**没有任何测试断言 idempotency_key 写入**（因为根本不写，缺失）；cron 三步 message INSERT 测试存在但未断言 ref_entity_type/id

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/message.ts` | 加 `deletedAt timestamp`；改 `uq_messages_idempotency_key` 为 `(idempotency_key, recipient_type, recipient_id)` 复合；考虑 `messageTypeEnum` 收敛 | P1-16-08 / P1-16-10 / P1-16-05 |
| L0 enums | `db/schema/enums.ts:87` | 决策："员工"是否保留 | P0-16-04 |
| L3 client routes | `fengyu-client/cloudfunctions/clientApi/routes/message.js:10/40/55` | 三函数顶部加 `await requirePhone()(ctx, async () => {})`；read SQL 加 `AND is_read=false`；rowCount=0 时区分 NOT_FOUND/PERMISSION_DENIED/已读幂等 | P0-16-01 / P1-16-07 / P2-16-12 |
| L3 staff routes | `fengyu-staff/cloudfunctions/staffApi/routes/message.js`（新建） | 决策保留"员工"枚举则补 list/read/unreadCount，挂 `requireStaffBound()` | P0-16-04 |
| L3 cron | `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:111`、`grant-thanksgiving-benefits.ts:127`、`refresh-member-levels.ts:238` | INSERT 增加 `ref_entity_type='customer_benefit', ref_entity_id={year/yearMonth}` 列；message_type 用收敛后的枚举 | P1-16-06 / P1-16-05 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:392 batchSendMessages` | 生成 batchId UUID；每行 idempotency_key=`batch-${batchId}-${userId}`；分片 INSERT 用 `ON CONFLICT (idempotency_key, recipient_type, recipient_id) DO NOTHING` | P0-16-02 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:52 getMessagesPaginated` | recipient_type='客户' 时 JOIN clientWechatUsers + scopeCondition；recipient_type='员工' 时 JOIN staffWechatUsers + scopeCondition | P0-16-03 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:173 deleteMessage` | 改软删（`deletedAt = NOW()`）；logOperation detail 写 `{title, recipientType, recipientId, messageType}` | P1-16-08 |
| L7 admin actions | `fengyu-admin/src/actions/customers.ts:836 mergeClientProfile` | merge 前去重 idempotency_key 冲突的 messages 行 | P1-16-09 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:392 batchSendMessages` | body length ≤ 1000；URL 白名单或仅允许内站链接 | P1-16-11 |
| L9 client UI | `fengyu-client/miniprogram/pagesProfile/messages/messages.ts:114` | 增加 `customer_benefit` ref_entity_type 跳转到积分页/券页 | P1-16-06 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- ① 验证 messageRecipientType='员工' 当前是否真无任何写入
SELECT recipient_type, count(*) FROM messages GROUP BY recipient_type;
-- 预期：仅 '客户' 行；'员工' 行为 0 → 印证 P0-16-04

-- ② 验证 admin batchSend 重发翻倍
SELECT recipient_id, title, count(*) AS dup_count
FROM messages
WHERE idempotency_key IS NULL
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY recipient_id, title HAVING count(*) > 1
LIMIT 50;

-- ③ 验证 message_type 实际取值分布（P1-16-05 收敛枚举依据）
SELECT message_type, count(*) FROM messages GROUP BY message_type ORDER BY count DESC;

-- ④ 验证 ref_entity_type 缺失率
SELECT
  message_type,
  count(*) AS total,
  count(*) FILTER (WHERE ref_entity_type IS NOT NULL) AS with_ref,
  count(*) FILTER (WHERE ref_entity_type IS NULL) AS no_ref
FROM messages
GROUP BY message_type;
-- 预期：cron 三类（生日/感恩/升级）+ batch 全部 no_ref；share-gift 全部 with_ref

-- ⑤ unreadCount 索引使用情况
EXPLAIN SELECT count(*) FROM messages
WHERE recipient_type = '客户' AND recipient_id = 'U-001' AND is_read = false;
-- 预期：Index Scan using idx_messages_recipient

-- ⑥ 验证 list 分页 ORDER BY created_at DESC 索引情况
EXPLAIN SELECT * FROM messages
WHERE recipient_type = '客户' AND recipient_id = 'U-001'
ORDER BY created_at DESC LIMIT 20;
-- 评估是否需要新建 (recipient_type, recipient_id, created_at DESC) 复合 idx
```

## 8. 回归测试用例（建议）

1. client `message.read` 重复点击：第二次返回 success，rowCount=0 不计为错误
2. client 未绑机用户调 `message.list/read/unreadCount`：应返回 PHONE_REQUIRED
3. admin batchSendMessages 双触发同一批：DB 仅写一份（idempotency_key 兜底）
4. admin 非 admin 角色调 getMessagesPaginated：应 PERMISSION_DENIED
5. admin scope 改为 manager 后调 getMessagesPaginated：仅看到本店 customer 的消息（修复 P0-16-03 后）
6. cron grant-birthday-benefits 重跑同日：messages 不重复（idempotency_key 已 ON CONFLICT DO NOTHING）
7. mergeClientProfile：source 和 orphan 都有 birthday-msg-2026-X：merge 后仅一条
8. 新增 `messageRecipientType='员工'` 数据：staff 端 list 接口可读取（修复 P0-16-04 后）

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☐（messages 表非交易关键，可全表清洗）
- 修复成本：M（admin batch idempotency 是 1 周内可改完；scope 过滤需要思考与 audit-10 客户域协作；员工消息 staffApi route 是 1 周新增）

## 10. 后续待办

- [ ] 与 audit-10 客户域、audit-22 权限矩阵协作，决定 admin getMessagesPaginated 的 scope 策略（recipient_type='客户' 时 JOIN clientWechatUsers.boundStoreId / recipient_type='员工' 时 JOIN staffWechatUsers.storeId）
- [ ] 与 audit-23 操作日志域协作，messages.delete 软删后 logOperation detail 是否含 body
- [ ] 业务侧补"订单状态变更"/"预约确认"/"服务完成"消息触发（spec §3.20/§3.21 标"未实现"）
- [ ] 与 audit-04 payNotify、audit-13 coupons 域协作，share-gift.js 三副本是否抽公共包
- [ ] 决策 messageRecipientType='员工' 保留 / 删除（产品 + 工程对齐）
