# 审计报告：消息中心 (16)

**审计时间**：2026-04-26
**域 ID**：16
**审计员**：claude-sonnet-4-6
**审计时长**：约 28 分钟（独立重审）
**关联 PR/Ticket**：share-gift / member-birthday / member-thanksgiving / member-level upgrade benefits

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/message.ts:11`（`messages` 表，bigserial PK，messageRecipientTypeEnum，partial unique index on idempotency_key） | ↑ 共用 | ↑ 共用 |
| Action/Route | `fengyu-admin/src/actions/messages.ts`（getMessagesPaginated/getMessageTypes/deleteMessage/batchSendMessages/getCustomersForBatchMessage/getOrgNodesForBatchMessage） | 无 message route（staffApi/routes/ 中 grep 无任何 messages 表访问） | `fengyu-client/cloudfunctions/clientApi/routes/message.js`（list/read/unreadCount） |
| 前端 | `fengyu-admin/src/app/(main)/messages/page.tsx` + `_components/messages-page.tsx` | — | `fengyu-client/miniprogram/pagesProfile/messages/messages.ts` + `messages.wxml`；未读角标 `pages/profile/profile.ts:71-74` |
| 消息写入触发 | `src/cron/steps/grant-birthday-benefits.ts:111-118`<br>`src/cron/steps/grant-thanksgiving-benefits.ts:127-134`<br>`src/cron/steps/refresh-member-levels.ts:238-244`<br>`src/actions/customers.ts:836-839`（合并孤儿档案时迁移 recipient_id）<br>admin batchSendMessages（L7） | `cloudfunctions/staffApi/share-gift.js:132-136`（首单完成触发） | `cloudfunctions/clientApi/share-gift.js:132-136`<br>`cloudfunctions/payNotify/share-gift.js:132-136`（payNotify 触发） |
| 权限 | `lib/permissions.ts:30` — admin 角色独占 `message:list / message:delete / message:send`；其余 6 角色均未授权 | — | 所有 message.* 路由仅过 `auth` 中间件，未挂 `requirePhone()` |
| 测试 | `fengyu-admin/src/actions/messages.test.ts`（batchSend/list/orgResolve mock 测试） | — | `fengyu-client/cloudfunctions/clientApi/__tests__/routes/message.test.js`（list/read/unreadCount 三 describe 块） |

---

## 2. 数据流图

```
【写入端（当前已实现）】
admin batchSendMessages   → INSERT messages × N（分片 500，无 idempotency_key）
admin mergeClientProfile  → UPDATE messages SET recipient_id=sourceUserId WHERE recipient_id=orphanUserId
cron STEP-2 升降级        → INSERT … idempotency_key='member-upgrade-{userId}-{toLevel}', message_type='system'
cron STEP-3 生日          → INSERT … idempotency_key='birthday-msg-{YYYY}-{userId}', message_type='system'
cron STEP-4 感恩          → INSERT … idempotency_key='thx-msg-{YYYY-MM}-{userId}', message_type='system'
share-gift (3副本)        → INSERT … idempotency_key='sg-msg-{role}-{saleOrderId}', ref_entity_type='sale_order'

【读取端（当前已实现）】
client message.list       → SELECT … WHERE recipient_type='客户' AND recipient_id=$userId
client message.read       → UPDATE … SET is_read=true WHERE id=$1 AND recipient_type='客户' AND recipient_id=$2
client message.unreadCount→ SELECT count(*) WHERE recipient_type='客户' AND recipient_id=$userId AND is_read=false
admin getMessagesPaginated→ SELECT … JOIN clientWechatUsers / staffWechatUsers（无 scope 过滤）

【当前缺口】
recipient_type='员工'     → 0 个写入路径 + 0 个读取路径（枚举定义 db/schema/enums.ts:95 但业务侧孤儿）
业务事件触发消息          → 预约确认 / 服务完成 / 订单状态变更 均无 INSERT messages（client.pr.spec.md 标"未实现"）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

- **[P0-16-01]** client `message.list / read / unreadCount` 缺 `requirePhone()` 守卫
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:10,41,56`；`clientApi/index.js:55-57`；`middleware/auth.js:54-61`
  - 现象：三个接口仅过 `auth` 中间件（OPENID → userId，userId 可为 null——见 `middleware/auth.js:54-56`），未挂 `requirePhone()`。当 userId 为 null 时，SQL `WHERE recipient_id = $1` 参数为 null，PostgreSQL `= NULL` 永远为 false，查询返回 0 行，看似自保。但存在以下薄弱点：
    - `message.read` 传 `messageId` + `userId=null`：`UPDATE … WHERE id=$1 AND recipient_type='客户' AND recipient_id=$2`（$2=null）→ rowCount=0 → 返回 `{ success: true }`，客户端以为成功，无任何报错（静默越权入口）。
    - 与 `points/card/order` 等同类隐私接口规范不一致（这些接口在 audit-15 已被要求统一加 `requirePhone()`）。
  - 风险：未绑机用户可无感知调用消息接口；如果 userId 缓存（`AUTH_CACHE`）命中一个历史绑机用户的缓存（5 分钟 TTL），恶意请求在 TTL 窗口内有机会持 null-userId session 标记他人消息。
  - 复现：1) 用户 OPENID 认证但跳过 bindPhone；2) 调 `message.read { messageId: 12345 }` → 返回 `{ code:0, data:{success:true} }` 无报错；3) 实际无行被修改，但接口语义欺骗调用方
  - 修复：(L3) `routes/message.js` 三函数顶部各加 `if (!ctx.auth.userId) throw new Error('PHONE_REQUIRED: 请先绑定手机号')`；或统一在 `clientApi/index.js` 的 `message.*` 路由添加 `requirePhone()` 中间件

- **[P0-16-02]** admin `batchSendMessages` 完全不写 `idempotency_key`，重复提交导致消息翻倍
  - 文件：`fengyu-admin/src/actions/messages.ts:460-475`
  - 现象：`values` 数组构造（:461-469）不含 `idempotencyKey` 字段，`uq_messages_idempotency_key` partial unique index（`WHERE idempotency_key IS NOT NULL`）对此无效。Server Action 在网络抖动 / 浏览器双 tab 提交 / `router.refresh()` race 时，可多次插入相同 title/body/recipientId 组合。
  - 风险：1000 人批量发送若双击，顾客侧看到 2000 条消息；未读角标计数翻倍；无去重手段。违反项目幂等规范。
  - 复现：1) admin 选 100 顾客 → 点击"确认发送"；2) 两次并发 Server Action 完成；3) 每位顾客 messages 表出现 2 行同 title/body
  - 修复：(L7) 在 batchSendMessages 入口生成 `batchId = crypto.randomUUID()`，每行 `idempotencyKey: \`batch-${batchId}-${userId}\``；分片 INSERT 改为 `ON CONFLICT (idempotency_key, recipient_type, recipient_id) DO NOTHING`（需配合 P1-16-10 的复合 unique 修复）

- **[P0-16-03]** admin `getMessagesPaginated` 无 scope 过滤，单点权限防御，暴露全网顾客 PII
  - 文件：`fengyu-admin/src/actions/messages.ts:46-151`
  - 现象：函数注释明确写 "messages 表无 store_id，不走 scope 过滤；该页面仅 admin 可见"（:46-50），唯一防线是 `requirePermission(session, 'message:list')`（:56）。若权限矩阵新增角色或误授 `message:list`，查询结果含全网顾客 `recipientName`（JOIN `client_wechat_users.name`）+ `recipientId`（user_id text，可关联顾客档案）+ `body`（可含手机号/金额等 PII）。
  - 风险：违反 `real.md` §5/#6 后端统一鉴权 + 组织域隔离。与 audit-10 P0-10-01（客户列表无 scope）同模式。
  - 复现：1) 权限矩阵误给 `finance` 角色授 `message:list`；2) finance 登录 → 可见全网所有顾客消息；3) PII 扩散
  - 修复：(L7) 对 recipient_type='客户' 行加 `JOIN clientWechatUsers + scopeCondition(session, clientWechatUsers.boundStoreId)`；recipient_type='员工' 加 `JOIN staffWechatUsers + scopeCondition(session, staffWechatUsers.storeId)`；`scopeStoreIds === null`（admin）继续全量

- **[P0-16-04]** `messageRecipientType='员工'` 孤儿枚举：零写入路径 + 零读取路径
  - 文件：`db/schema/enums.ts:95`；`fengyu-staff/cloudfunctions/staffApi/routes/`（grep 无 messages 表引用）；`fengyu-admin/src/actions/messages.ts:391`（注释"员工消息暂不支持批量发送"）
  - 现象：枚举 `["客户","员工"]` 已定义并迁移到 PG，但截止审计日：(a) staffApi 16 个 routes 文件均无 `INSERT INTO messages`；(b) staffApi index.js 无 `message.*` 路由；(c) admin batchSendMessages 只发给"客户"；(d) cron/share-gift 只写 `recipient_type='客户'`。"员工"枚举从未落地数据。
  - 风险：spec 与代码脱节；未来若 admin 误向 `recipient_type='员工'` 插入消息，员工无任何前端入口读取（数据黑洞）；employee_id 与 client user_id 同为 text 类型，虽靠 recipient_type 区分但无 FK 约束，数据孤岛风险高。
  - 修复：二选一——(A) staffApi 新建 `routes/message.js` 实现 list/read/unreadCount（挂 staff auth 中间件），员工端 Tab 增消息入口；(B) 从枚举删除"员工"并 DROP 未使用值（需确认产品决策）

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-16-05]** `message_type` 未枚举化，admin 端输入任意字符串，client 渲染 fallback 不一致
  - 文件：`db/schema/message.ts:21`（varchar(50)，无 CHECK）；`fengyu-admin/src/actions/messages.ts:407-410`；`fengyu-client/miniprogram/pagesProfile/messages/messages.ts:8-18`
  - 现象：`TYPE_COLOR_MAP`（client 端）仅识别 `appointment / order / system` 三值；全栈所有 INSERT 实际只写 `'system'`（cron 三步 + share-gift）；admin batchSend 允许运营输入任意分类字符串（如 `'promotion'` / `'通知'`）。这些非标准值在 client 端触发 fallback 配色 `#999999` + `iconName='info-o'`，且 admin 筛选下拉仅呈现 DISTINCT 实际值，运营无法知道哪些值合法。
  - 修复：(L0) 新建 `messageTypeEnum`（如 `system / appointment / order / service / refund / promotion`）；admin batchSend 改 Select 组件；cron/share-gift INSERT 使用枚举值

- **[P1-16-06]** cron 三处写入 messages 不写 `ref_entity_type / ref_entity_id`，client 消息无法导航
  - 文件：`fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:111-118`；`grant-thanksgiving-benefits.ts:127-134`；`refresh-member-levels.ts:238-244`
  - 现象：share-gift 写了 `ref_entity_type='sale_order', ref_entity_id=saleOrderId`；cron 三步均省略这两列（INSERT 不含 ref_entity_type/ref_entity_id，值为 null）。client `messages.ts:114-117` 的 `onTapMessage` 按 `record.refEntity` 路由跳转，null 时不导航。升级/生日/感恩消息点击无任何跳转反应。
  - 修复：(L7 cron) 三步 INSERT 补 `ref_entity_type='customer_benefit', ref_entity_id=<year/yearMonth>`；(L9 client) `onTapMessage` 增加 `customer_benefit` 分支跳转积分页/券页

- **[P1-16-07]** client `message.read` 缺 `AND is_read = false` CAS 守卫，已读消息重复 UPDATE
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:45-49`
  - 现象：`UPDATE messages SET is_read=true WHERE id=$1 AND recipient_type=$2 AND recipient_id=$3` 无 `AND is_read=false`；用户重复点击同一消息（或 `onShow` 重载列表后再次 tap）每次均触发行写。无性能灾难，但冗余写，且若未来加 `read_at` 列会覆盖首次阅读时间。
  - 修复：(L3) 补 `AND is_read = false`；UPDATE rowCount=0 时直接返回 `{ success:true }` 幂等

- **[P1-16-08]** admin `deleteMessage` 物理硬删，审计日志不含消息快照
  - 文件：`fengyu-admin/src/actions/messages.ts:173-191`
  - 现象：`db.delete(messages).where(eq(messages.id, id))`；`logOperation` 仅记 `action='message.delete', target_id=String(id)`，不含 title/recipientId/body。删除后无法通过日志还原"删了谁的什么消息"。
  - 修复：(L0 schema) 加 `deleted_at timestamp`；(L7) deleteMessage 改软删；logOperation detail 含 `{title, recipientType, recipientId, messageType}`

- **[P1-16-09]** admin `mergeClientProfile` 迁移 messages.recipient_id 不去重幂等键冲突
  - 文件：`fengyu-admin/src/actions/customers.ts:836-839`
  - 现象：`tx.update(messages).set({recipientId: sourceUserId}).where(and(eq(messages.recipientType,'客户'), eq(messages.recipientId, orphanUserId)))` 无条件全量 UPDATE。若 orphan 和 source 各自收到了同年生日消息（`birthday-msg-2026-orphan` vs `birthday-msg-2026-source`），UPDATE 后两条均挂 sourceUserId.recipientId，idempotency_key 不同不冲突；顾客看到"两份生日礼消息"，UI 重复。
  - 修复：(L7) merge 前先 DELETE messages（recipient_id=orphan AND idempotency_key 已被 source 同类 key 覆盖的行），余下的再 UPDATE；或 DELETE 冲突行（orphan 的） + INSERT (source 的) ON CONFLICT DO NOTHING

- **[P1-16-10]** `uq_messages_idempotency_key` 全局单列 unique，封堵"系统公告"扩展场景
  - 文件：`db/schema/message.ts:33-35`
  - 现象：`uniqueIndex(...).on(table.idempotencyKey).where(sql\`idempotency_key IS NOT NULL\`)` 是全表单列唯一。若未来引入"全员系统公告"（幂等键 `bulletin-2026-0501`，不含 userId），ON CONFLICT 只允许第一位顾客入库，其余被静默吞掉。
  - 修复：(L0 schema) 改复合 unique：`(idempotency_key, recipient_type, recipient_id) WHERE idempotency_key IS NOT NULL`；现有 5 类幂等键（均已含 userId 后缀）全部兼容

- **[P1-16-11]** client `message.list` 响应不含 `total` 字段，前端分页靠 `length === PAGE_SIZE` 推断
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:22-34`；`fengyu-client/miniprogram/pagesProfile/messages/messages.ts:64,85`
  - 现象：list 仅返回 `{ records: [...] }`，无 `total`；前端判断 `hasMore` 的逻辑为 `newRecords.length === PAGE_SIZE`（:64 / :85）。最后一页恰好整除 PAGE_SIZE（20 条）时，`hasMore=true`，再翻页收到空数组才停止——多发一次无效请求。
  - 修复：(L3 + L9) list 接口补 `SELECT COUNT(*)` 返回 `total`；前端 `hasMore = offset + records.length < total`

### 3.3 P2（代码质量 / 可维护性）

- **[P2-16-12]** client `message.read` 返回值语义不清：id 不存在 / 已读 / 他人的三种情况全返 success
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/message.js:41-49`
  - 现象：UPDATE rowCount=0 无论何原因均 `ctx.result = { success: true }`，调用方无法区分"已读"/"id 不存在"/"归他人"三种情况。
  - 修复：(L3) rowCount=0 时 SELECT 一次判断：不存在 → `NOT_FOUND`；recipient 不匹配 → `PERMISSION_DENIED`；is_read=true → `{ success:true }` 幂等

- **[P2-16-13]** admin batch 正文（body）无长度上限，钓鱼链接可注入至顾客消息
  - 文件：`fengyu-admin/src/actions/messages.ts:406`；`messages-page.tsx:583-588`（textarea 无 maxLength）
  - 现象：body 列为 `text`（无长度约束），admin 输入无 maxLength 限制，可写入任意长度含外链内容。微信小程序 WXML `{{item.body}}` 自动转义，无 XSS；但 body 内含 HTTP 外链（"点这里领奖 http://malicious..."），顾客长按可复制访问。
  - 修复：(L7) batchSendMessages 加 `body.length ≤ 1000`；UI textarea 加 `maxLength={1000}`

- **[P2-16-14]** `message_type='appointment'` 和 `message_type='order'` 在 client `TYPE_COLOR_MAP` 中配置但全栈从无写入
  - 文件：`pagesProfile/messages/messages.ts:8-18`
  - 现象：`TYPE_COLOR_MAP = { appointment:'#096DD9', order:'#52C41A', system:'#FAAD14' }`；当前所有写入路径仅使用 `'system'`，`appointment` / `order` 是死代码。spec 相关功能标"未实现"。
  - 修复：业务侧实现"预约确认"/"服务完成"/"订单支付"等事件触发 INSERT（属 audit-02/06 域范畴，本域仅记录 UI 侧已就绪）

- **[P2-16-15]** share-gift.js 三副本字节级冗余，message INSERT 在三处同步维护
  - 文件：`fengyu-client/cloudfunctions/payNotify/share-gift.js:132-136`；`fengyu-client/cloudfunctions/clientApi/share-gift.js:132-136`；`fengyu-staff/cloudfunctions/staffApi/share-gift.js:132-136`
  - 现象：注释已明确 "以下三份副本必须保持字节级一致"；任何 message 模板修改须三处同步，已违反 DRY 且易产生 drift。
  - 修复：抽到 CloudBase 共享层（shared layer / node_modules 路径）或利用构建时符号链接

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 接口入口 | 管理+批量发送 | **无任何接口** | list/read/unreadCount | 员工消息通道完全缺失 | P0-16-04 |
| 鉴权守卫 | requirePermission（3 权限） | — | 仅 auth，缺 requirePhone | client 防御弱 | P0-16-01 |
| Scope 过滤 | 无（注释承认） | — | recipient_id 精确过滤（OK） | admin 单点权限风险 | P0-16-03 |
| 批量发送幂等 | 缺 idempotency_key | — | — | 重发翻倍 | P0-16-02 |
| message_type | 自由文本输入 | — | 仅识别 3 值（fallback 兜底） | 数据画像不一致 | P1-16-05 |
| ref_entity_type/id | batch 不写；cron 不写 | share-gift 写 'sale_order' | 按 ref_entity_type 跳转 | cron 消息无导航 | P1-16-06 |
| read CAS 守卫 | N/A | — | 缺 `AND is_read=false` | 重复 UPDATE | P1-16-07 |
| 删除方式 | 物理硬删 + 无快照日志 | — | 不能删 | 审计断裂 | P1-16-08 |
| total 字段 | 有（服务端分页） | — | 无（靠 length 推断） | 多一次无效请求 | P1-16-11 |

---

## 5. 横切检查

- [x] **CC1 数值精度**：messages 表无金额字段，N/A
- [ ] **CC2 并发幂等**：admin batchSend 缺 idempotency_key（**P0-16-02**）；client read 缺 CAS（P1-16-07）；mergeClientProfile 不去重幂等键冲突（P1-16-09）；uq_messages_idempotency_key 单列唯一维度过松（P1-16-10）
- [ ] **CC3 组织隔离**：admin getMessagesPaginated 无 scope 过滤（**P0-16-03**）；client list/read/unreadCount recipient_id 精确过滤（✅ OK）
- [ ] **CC4 后端鉴权**：client 三接口缺 requirePhone 守卫（**P0-16-01**）；admin 单点 requirePermission 无 scope 兜底（**P0-16-03**）；staff 端完全无接口（**P0-16-04**）
- [ ] **CC5 错误码**：client read rowCount=0 三种原因统一返 success，不符合 NOT_FOUND/PERMISSION_DENIED 约定（P2-16-12）
- [ ] **CC6 PII**：admin 详情 Dialog 直显 recipientId（user_id text）+ recipientName + body（可含手机号），无 scope 防御（P0-16-03）；admin batch body 无外链审核（P2-16-13）
- [x] **CC7 时间字段**：created_at DEFAULT NOW() ✅；无 read_at / sent_at（is_read boolean 为唯一状态字段，简单场景可接受）
- [x] **CC8 WXML**：client wxml `{{item.body}}` 自动 escape ✅；未读红点 `unread-dot` + `grid-badge` 实现一致 ✅
- [ ] **CC9 测试残留**：client `message.test.js` 三 describe 覆盖，但未断言 null-userId 被 PHONE_REQUIRED 拦截（P0-16-01 测试缺失）；admin `messages.test.ts` 未断言 idempotency_key 写入（因为本来不写，P0-16-02 测试缺失）；cron 三步 message INSERT 测试未断言 ref_entity_type/id（P1-16-06 测试缺失）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/message.ts` | 加 `deleted_at timestamp`；改 `uq_messages_idempotency_key` 为 `(idempotency_key, recipient_type, recipient_id)` 复合 unique | P1-16-08 / P1-16-10 |
| L0 enums | `db/schema/enums.ts:95` | 决策"员工"枚举保留 or 删除（对应 staffApi 是否实现） | P0-16-04 |
| L0 enums | `db/schema/enums.ts` | 新建 `messageTypeEnum`（system/appointment/order/service/promotion/refund/coupon） | P1-16-05 |
| L3 client routes | `fengyu-client/cloudfunctions/clientApi/routes/message.js:10,41,56` | list/read/unreadCount 函数顶部加 `if (!ctx.auth.userId) throw new Error('PHONE_REQUIRED: ...')` | P0-16-01 |
| L3 client routes | `fengyu-client/cloudfunctions/clientApi/routes/message.js:46` | UPDATE 加 `AND is_read = false`；rowCount=0 时区分 NOT_FOUND/PERMISSION_DENIED/幂等 | P1-16-07 / P2-16-12 |
| L3 client routes | `fengyu-client/cloudfunctions/clientApi/routes/message.js:15-21` | 补 `SELECT count(*)` 返回 `total` | P1-16-11 |
| L3 staff routes | `fengyu-staff/cloudfunctions/staffApi/routes/message.js`（新建） | 如决策保留"员工"枚举，实现 list/read/unreadCount；挂 staff auth 中间件 | P0-16-04 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:392 batchSendMessages` | 生成 batchId UUID；每行 `idempotencyKey: \`batch-${batchId}-${userId}\``；INSERT 用 ON CONFLICT DO NOTHING | P0-16-02 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:52 getMessagesPaginated` | recipient_type='客户' 时加 `JOIN clientWechatUsers + scopeCondition(session, boundStoreId)`；recipient_type='员工' 时加 `JOIN staffWechatUsers + scopeCondition(session, storeId)` | P0-16-03 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:173 deleteMessage` | 改软删（`deletedAt = NOW()`）；logOperation detail 含 `{title, recipientType, recipientId}` | P1-16-08 |
| L7 admin actions | `fengyu-admin/src/actions/customers.ts:836 mergeClientProfile` | merge 前去重 idempotency_key 冲突的 messages 行（DELETE 冲突行再 UPDATE） | P1-16-09 |
| L7 admin actions | `fengyu-admin/src/actions/messages.ts:406 batchSendMessages` | body length ≤ 1000；UI textarea 加 maxLength | P2-16-13 |
| L7 cron | `src/cron/steps/grant-birthday-benefits.ts:111` 等三处 | INSERT 补 `ref_entity_type='customer_benefit', ref_entity_id=year/yearMonth`；message_type 用 messageTypeEnum | P1-16-06 / P1-16-05 |
| L9 client UI | `fengyu-client/miniprogram/pagesProfile/messages/messages.ts:114` | `onTapMessage` 增加 `customer_benefit` 分支跳转积分页/券页 | P1-16-06 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- ① 验证 recipient_type='员工' 当前是否零行（P0-16-04 验证）
SELECT recipient_type, count(*) FROM messages GROUP BY recipient_type;
-- 预期：仅 '客户'；'员工' 行 = 0

-- ② 验证 admin batchSend 重发翻倍（找近 7 天无 idempotency_key 的重复组合）
SELECT recipient_id, title, count(*) AS dup_count
FROM messages
WHERE idempotency_key IS NULL
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY recipient_id, title
HAVING count(*) > 1
LIMIT 50;

-- ③ 验证 message_type 实际取值分布（收敛枚举依据，P1-16-05）
SELECT message_type, count(*) FROM messages GROUP BY message_type ORDER BY count(*) DESC;

-- ④ 验证 ref_entity_type 缺失率（P1-16-06）
SELECT
  message_type,
  count(*) AS total,
  count(*) FILTER (WHERE ref_entity_type IS NOT NULL) AS with_ref,
  count(*) FILTER (WHERE ref_entity_type IS NULL) AS no_ref
FROM messages
GROUP BY message_type;

-- ⑤ unreadCount 索引使用验证（idx_messages_recipient 覆盖情况）
EXPLAIN
SELECT count(*) FROM messages
WHERE recipient_type = '客户' AND recipient_id = 'U-TEST-001' AND is_read = false;
-- 预期：Index Scan using idx_messages_recipient

-- ⑥ list 分页 ORDER BY created_at 索引情况
EXPLAIN
SELECT * FROM messages
WHERE recipient_type = '客户' AND recipient_id = 'U-TEST-001'
ORDER BY created_at DESC LIMIT 20;
-- 若 Seq Scan，考虑新建 (recipient_type, recipient_id, created_at DESC) 复合 idx
```

---

## 8. 回归测试用例（建议）

1. 未绑机用户（userId=null）调 `message.list / read / unreadCount` → 应返回 `PHONE_REQUIRED`（P0-16-01 修复后）
2. admin batchSendMessages 同一参数两次提交（模拟双击）→ DB 仅写 N 条（不翻倍），(P0-16-02 修复后 idempotency_key 兜底)
3. 非 admin 角色调 `getMessagesPaginated` → PERMISSION_DENIED（当前已 OK）；manager 角色在加 scope 后仅见本店顾客消息（P0-16-03 修复后）
4. client `message.read` 同一 messageId 点两次 → 第二次 rowCount=0，仍返回 `{success:true}`（幂等）
5. client `message.read` 传不存在的 id → NOT_FOUND；传他人 message id → PERMISSION_DENIED（P2-16-12 修复后）
6. `mergeClientProfile` source 和 orphan 都有 `birthday-msg-2026-X` → merge 后顾客仅见一条生日消息（P1-16-09 修复后）
7. cron `grant-birthday-benefits` 重跑同日 → messages 不重复（idempotency_key ON CONFLICT DO NOTHING ✅ 已覆盖）
8. client 消息列表最后一页 20 条 → hasMore = false（补 total 字段后，P1-16-11 修复后）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☐（messages 表为只追加流水，软删改造仅加列；idempotency_key unique 改复合 unique 需 DROP 原 index + CREATE 新 index，无 data loss）
- 修复成本：
  - P0 三项（01/02/03）：S（01/02 各 < 1 天；03 需参考 scopeCondition 实现约 1 天）
  - P0-16-04（员工消息）：M（新建 staffApi route + 员工端 Tab 约 2-3 天，或决策删枚举 < 0.5 天）
  - P1 六项：S-M（各 0.5-1 天）

---

## 10. 后续待办

- [ ] 产品决策：`messageRecipientType='员工'` 保留 + staffApi 实现，还是删除枚举 — 对齐 audit-04 payNotify 域
- [ ] 与 audit-10 客户域、audit-22 权限矩阵协作，确认 admin getMessagesPaginated 的 scope 策略（P0-16-03）
- [ ] 与 audit-23 操作日志域协作：messages.delete 软删后 logOperation detail 字段范围
- [ ] 业务侧补"订单状态变更"/"预约确认"/"服务完成"等事件 INSERT messages（spec §3.20/§3.21 标"未实现"，属 audit-02/06 域）
- [ ] 与 audit-04 payNotify、audit-07 share-gift 域协作：share-gift.js 三副本是否抽公共层（P2-16-15）
- [ ] cron STEP-2/3/4 消息 ref_entity_type/id 补全后，同步补测试断言（P1-16-06）