# 12 — `message` 模块

**Schema 文件**：`db/schema/message.ts`
**涉及 PG 表**：`messages`
**WorkFine 源表**：**无**（WorkFine MSSQL 完全无消息/通知/站内信实体；`notes/research/workfine_database.md` 全文检索 "消息/notification/通知/message" 0 命中）
**主要写入入口（运行时）**：
- `fengyu-admin/src/cron/steps/refresh-member-levels.ts:L238-244` — 会员升级消息
- `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:L111-117` — 生日权益消息
- `fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts:L127-133` — 感恩回馈消息（仅每月 20 号）
- `fengyu-client/cloudfunctions/payNotify/share-gift.js:L131-136` — 分享礼消息（邀请人 + 被邀请人）
- `fengyu-client/cloudfunctions/clientApi/share-gift.js:L131-136` — 同上副本
- `fengyu-staff/cloudfunctions/staffApi/share-gift.js:L131-136` — 同上副本
- `db/scripts/verify-member-level-cron.js` — **仅校验脚本**，写到 `recipient_id LIKE 'FYGK-S%'` 的 demo 行后会 DELETE，不入生产

**读入口**：仅客户端
- `fengyu-client/cloudfunctions/clientApi/routes/message.js` — list / read / unreadCount

**主要迁移脚本**：**无**。messages 表不在 `migrate-*.js` / `sync-workfine.js` 任何脚本的 INSERT 列表中；migration 0000 baseline + 0006 加 idempotency_key 之外没有任何 SQL 触及 messages。

---

## 表 1：`messages`

**WorkFine 源表**：无
**当前行数**（PG 5434，2026-04-26 探查）：**1 行**（id=2，title=`'测试'`，recipient='FYGK-20260314-00001'，created_at=2026-04-09，is_read=true）
**WorkFine 源行数**：N/A
**导入脚本**：无（100% 运行时产出 / 6 个 INSERT 副本均未在 5434 留下行）

### PG 现状统计

| 维度 | 值 |
|------|----|
| 总行数 | 1 |
| recipient_type='客户' | 1 |
| recipient_type='员工' | 0 |
| message_type='system' | 1（其余 NULL：0） |
| ref_entity_type 非空 | 0 |
| ref_entity_id 非空 | 0 |
| idempotency_key 非空 | 0 |
| is_read=true | 1 |
| created_at 范围 | 2026-04-09 单点 |

**关键观察**：6 个生产入口（cron 三 STEP × 1 + share-gift × 3 副本）在 5434 baseline reset 后**全部 0 写入**，与 10/points 模块同源问题——cron-worker 在生产环境疑似未正常运转，share-gift 链路也无任何分享单产出。

唯一存量行 id=2 是手工测试残留（title="测试"，body="测试"）。

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|-----------------|------|------|
| id | bigserial | 新系统独立 | DB autoincrement | schema:L14 | |
| recipient_type | enum (`客户`/`员工`) | 新系统独立 | 6 个生产入口**全部硬编码 `'客户'`** | refresh-member-levels.ts:L241 / grant-birthday-benefits.ts:L114 / grant-thanksgiving-benefits.ts:L130 / share-gift.js:L133（×3 副本） | ⚠️ enum 设计有 `'员工'` 值但**无任何代码路径写入员工消息**；员工端无 message 路由也无通知触发器 |
| recipient_id | text | 新系统独立 | 升级类：`client_wechat_users.user_id`；分享礼：`inviter` user_id 或 `order.clientUserId`（被邀请人）| 同上 | 全部为 `client_wechat_users.user_id`（如 `FYGK-20260314-00001`）|
| title | varchar(200) | 新系统独立 | `system_configs.member_level_benefits[level].messageTitle` / `birthday_benefits.messageTitle` / `thanksgiving_benefits.messageTitle` / `share_gift.messageInviterTitle` / `share_gift.messageInviteeTitle` 配置项 | 各入口 | ⚠️ 配置缺失时 cron 跳过该用户但**不报错**（`if (config.messageTitle)`）；share-gift 在 title 为空时 console.warn 跳过该条但 invitee/inviter 另一条照发 |
| body | text | 新系统独立 | 对应配置的 `messageBody`；share-gift 走 `render(t)` 模板替换 `{paidAmount}/{couponValue}/{validityDays}` | refresh-member-levels.ts:L241 / share-gift.js:L120-136 | nullable，可省 |
| message_type | varchar(50) | 新系统独立 | 6 个入口**全部硬编码 `'system'`** | 同 recipient_type | ⚠️ 字段设计预留 `order/appointment/service/system` 多分类（schema 注释 L21），实际只用 `'system'`；客户端 message.js list 接口透传 message_type 给前端展示但当前无法区分类型 |
| is_read | boolean | 默认值/NULL | `default(false)` | schema:L22 | 由 `clientApi/routes/message.js:read` 接口 UPDATE 翻转 |
| ref_entity_type | varchar(50) | 新系统独立 | share-gift 三副本：硬编码 `'sale_order'`；cron 三 STEP：**未写入（NULL）** | share-gift.js:L133 | ⚠️ schema 注释（L24）"如 sale_order/appointment/service_order"，cron 类消息（升级/生日/感恩）本可指向 `'customer'` 或 `'system_config'`，**当前全 NULL** |
| ref_entity_id | text | 新系统独立 | share-gift：`order.saleOrderId`；cron 三 STEP：未写入（NULL）| share-gift.js:L135 | 同上 |
| idempotency_key | text | 新系统独立 | 6 个入口的固定模板（见下表）| 各入口 | migration 0006 加列；附 `uq_messages_idempotency_key` UNIQUE WHERE NOT NULL；ON CONFLICT DO NOTHING 跨重试幂等 |
| created_at | timestamp | 默认值/NULL | `defaultNow()` / SQL `NOW()` | schema:L29 | INSERT 时刻 |

### idempotency_key 命名约定（业务关键）

| 入口 | 格式 | 唯一性维度 |
|------|------|-----------|
| refresh-member-levels（升级） | `member-upgrade-{userId}-{toLevel}` | 同档位升级一生只发一次 |
| grant-birthday-benefits | `birthday-msg-{year}-{userId}` | 年度幂等 |
| grant-thanksgiving-benefits | `thx-msg-{yearMonth}-{userId}` | 月度幂等（仅每月 20 号触发） |
| share-gift × 3 副本 | `sg-msg-{role}-{order.saleOrderId}`（role=inviter/invitee） | 单订单两条（双方各一） |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**N/A**——WorkFine MSSQL 完全无消息实体可读。本表 100% 新系统独立。

---

## 关键决策

1. **WorkFine 完全无源**：messages 是 100% 新系统实体，不存在历史迁移，不存在 sync 路径。最终迁移**不需要任何 SQL** 处理本表，跑空表即可。
2. **冷启动假设**：业务上线前 messages 必然为空。当前 5434 现状（1 行测试残留）符合这个假设。
3. **idempotency_key 是写入路径的核心契约**：6 个入口都用 `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`。任何新写入路径**必须**遵循同一格式（业务前缀 + 时间维度 + 业务实体 ID）以保证可重放。
4. **share-gift 三副本字节级一致**：与 points 模块同样的脆弱性（client / staff / payNotify 三处共用 `share-gift.js`）。任一处修改 messages INSERT 列必须同步改另两端。
5. **cron 写消息但不写 ref_entity_***：升级/生日/感恩消息的 ref_entity_type / ref_entity_id 全 NULL。前端无法做"点击跳转到对应业务实体"，schema 设计意图未实现。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- **`messages` 整表 PG 5434 现状仅 1 行测试残留**：6 个生产 INSERT 入口（cron 三 STEP + share-gift 三副本）在 baseline reset 后**全部 0 写入**。与 10/points 同源问题，疑似 cron-worker 未正常运转 + share-gift 链路从未触发
- `recipient_type='员工'` 永远命中不到：enum 预留员工通知通道，但**无任何代码写入员工消息**，staffApi 也无 message 路由。是死值还是后续要做的接口？需产品侧确认
- `message_type` 仅写 `'system'`，4 类（order/appointment/service/system）压缩为 1 类：前端按 `message_type` 区分图标/分组 UI 当前无法工作
- cron 三 STEP（升级/生日/感恩）写消息时 `ref_entity_type` / `ref_entity_id` **全 NULL**：前端"点击跳详情"路径走不通；如业务期望升级消息能跳到积分流水或会员档案页，需在 cron 入口补 `ref_entity_type='customer', ref_entity_id=userId`
- 没有任何"消息已读批量清理 / TTL 删除 / 归档"路径：messages 表会无限增长，cron 三 STEP × 客户数 × 365 天后量级会失控；最终迁移可考虑补一个清理 cron 或加分区
- 没有"未读数推送"或"客户端消息中心入口主动通知"机制：客户必须主动进消息列表才会触发 read.js → UPDATE is_read，否则一直挂"未读"角标

---

## Review 报告（2026-04-26）

**一致项**：12 / **不一致项**：6（缺漏 4 / 错配 1 / 数据不一致 0 / 过时事实 1）

### 缺漏（4 条）

1. **❗主缺漏**：写入入口清单**漏掉 admin 后台批量发消息入口** `fengyu-admin/src/actions/messages.ts:392-493`（`batchSendMessages` Server Action），UI 侧 `app/(main)/messages/_components/messages-page.tsx:244` 已接通。该路径用 Drizzle `db.insert(messages).values(...)` 分片 500/批，硬编码 `recipient_type='客户'`、`message_type` 由调用方传入（非硬编码 'system'）、`isRead=false`，单次上限 1000 人，写 `operation_logs(action='message.batchSend')`。这意味着：
   - "6 个生产入口全部硬编码 `'system'`"的论断不严谨——admin 批量发可写任意 `messageType`
   - "无任何代码路径写入员工消息" 局部仍成立（batchSend 显式拒绝员工：仅 `recipient_type='客户'`）
2. **缺漏**：admin actions 中的 messages 流水管理入口未列：
   - `getMessagesPaginated`（messages.ts:52）— 全局只读列表（admin 审计/清理用，无 store_id scope，JOIN client/staff 接收人姓名）
   - `deleteMessage`（messages.ts:173）— 物理删除单条，写 `operation_logs(action='message.delete')`
3. **缺漏**：`fengyu-admin/src/actions/customers.ts:836` 在 `mergeClientProfile`（顾客合并）事务内 **UPDATE messages SET recipient_id = sourceUserId WHERE recipient_type='客户' AND recipient_id = orphanUserId**——这是"血缘流向"的重要节点（合并后老消息归属到活跃账户），文档"读入口/写入口"两栏均未覆盖。
4. **缺漏**：未列 `message:list` / `message:send` / `message:delete` 三个权限位 → 决定后台谁可见消息流水/谁可批量发/谁可删；与 schema 设计意图配套但未在文档体现。

### 错配（1 条）

5. **行号偏差（小）**：
   - 文档 `refresh-member-levels.ts:L238-244` 实际为 **L239-244**（INSERT 起始行 +1）
   - 文档 `grant-birthday-benefits.ts:L111-117` 实际为 **L112-117**
   - 文档 `grant-thanksgiving-benefits.ts:L127-133` 实际为 **L128-133**
   - share-gift × 3 的 `:L131-136` 准确无误

### 数据不一致（0 条）

PG 5434 抽样 100% 复现：1 行 / `recipient_type='客户'` / `message_type='system'` / refEntity 全 NULL / idempotency_key 全 NULL / created_at = 2026-04-09 / sample id=2 title='测试' recipient='FYGK-20260314-00001'。enum 双值 `客户/员工` 与 schema 一致；3 个索引（pk + idx_messages_recipient + uq_messages_idempotency_key）齐备。

### 过时事实 / 表述不准（1 条）

6. **`db/scripts/verify-member-level-cron.js` 表述误导**：文档说"写到 `recipient_id LIKE 'FYGK-S%'` 的 demo 行后会 DELETE，不入生产"——实际该脚本通过 `DATABASE_URL` 默认指向 `localhost:54399` 临时 docker PG，**根本不连 5434/5433**；DELETE 是临时库 cleanup，不存在"会写到生产再删"的风险。措辞应改为"仅作用于临时验证 PG，不连生产"。

### Verdict

**minor-fix** — 文档主体 schema/列级血缘/idempotency 命名约定/PG 现状量化全部正确，6 写入入口的核心 6 条 INSERT SQL 行号在 ±1 行误差内。但**漏掉 admin 后台 batchSendMessages 这个真实生产入口**（已有完整 UI 接通，权限 message:send 守卫）属于"写入入口清单不完整"，会导致上层架构图 / 影响分析时低估 messages 写流量。建议补充第 7 个入口（admin batch）+ 2 个 UPDATE/DELETE 维护入口（mergeClientProfile / deleteMessage）+ 修正 verify 脚本表述。

**关键发现**：写入入口数 **6 → 实际 7（+1 admin batchSendMessages）**；维护类入口（merge UPDATE / admin DELETE）零提及；运行时仍是生产 0 写入（cron + share-gift 全空），与 doc 结论一致。

---

## Edge Case 报告 R2（2026-04-26）

**Verdict**: **serious-edge-cases**

抽样：PG 5434 全表 1 行扫；MSSQL 复核（凭据已过期，回退至 `notes/research/workfine_database.md` 全文检索）。8 维风险维度命中 **6/8**（仅"FK 孤立"和"unique 守住"两维干净）。最大问题不是数据脏，而是**整条产品形态在生产 0 写入下被验证为"事实上的死代码"**——6/7 个生产入口编码完整但运行时永远跑不出第二行真实数据。

### 命中维度详表

| # | 维度 | 命中 | 严重度 | 说明 |
|---|------|------|--------|------|
| 1 | FK 孤立 | ❌ 干净 | — | 唯一行 `recipient_id='FYGK-20260314-00001'` JOIN `client_wechat_users` 命中；员工类 0 行无可探。但**无 DB 层 FK 约束**——仅依靠应用代码守约，cron / batchSend / share-gift 任一路径写错 userId 都会留下"读不出名字"的孤儿行（admin 列表会显示 `recipientName=undefined`，但 messages 表本身留存） |
| 2 | NULL/空串/极值 | ⚠️ 命中 | P1 | `title` NOT NULL 守住（max_len=2，min_len 抽到=2 但**应用层无 `title.trim()` 守卫**——cron 三 STEP 直接读 `system_configs.member_level_benefits[level].messageTitle`，配置里如果填 `' '`（纯空格）能写入 messages 通过 NOT NULL 但前端展示为空白条目）；`body` 允许 NULL/`''` 同源问题；schema 无 `title CHECK (length(trim(title)) > 0)` |
| 3 | enum 漂移 | ⚠️ 严重命中 | P0 | （a）`message_recipient_type` enum 双值 `[客户, 员工]`，PG 全表 0 行 `员工`；7 个写入入口**全部硬编码 `'客户'`**（含 admin batchSendMessages 显式拒绝员工：`recipientType: '客户' as const`）；staffApi 也无 message 路由——`员工` 是死值。（b）`message_type` 是 `varchar(50)` **未做 enum 化**，schema 注释说"order/appointment/service/system"4 类但运行时只写 `'system'`；admin batchSendMessages 接受任意字符串（仅 length≤50），客户端 `pagesProfile/messages/messages.ts:8-18` `TYPE_COLOR_MAP` 写死 `appointment/order/system` 三键且 fallback 灰点——**任何不在该 map 内的 messageType 都被静默降级为灰图标**，admin 批量发可写入 `'活动'/'优惠'/...` 等任意值在客户端永远显示同一图标 |
| 4 | unique 守住 | ❌ 干净 | — | `uq_messages_idempotency_key WHERE NOT NULL` 健康；探针 B6（同 recipient/title/type/date）0 重复。但因数据量=1 该结论实质未验证 |
| 5 | 跨模块一致性 | ⚠️ 严重命中 | P0 | （a）cron 三 STEP（升级/生日/感恩）`ref_entity_type/id` **全 NULL**——`pagesProfile/messages/messages.ts:114-118` 跳详情逻辑只支持 `refEntity='order'/'appointment'`，cron 类消息**点击全无反应**（即使有 `ref_entity_type='customer'` 客户端也无 case 处理）。（b）share-gift 写 `'sale_order'` 但前端跳转判断写的是 `record.refEntity === 'order'`——**字符串不等**，share-gift 类消息的"点击跳订单详情"实际**永远走不通**！这是真正的运行时 bug，admin DB 里值是 `'sale_order'` 前端看的是 `'order'`。（c）admin batchSendMessages **从不写 ref_entity_type/id**，但允许设置任意 messageType，运营若发"订单相关"通知 messageType 哪怕填 `'order'` 也无法挂载实体 ID |
| 6 | 死代码 / 永不命中 | ⚠️ 严重命中 | P0 | （a）整个 cron-worker 三 STEP messages INSERT 路径在 PG 5434 baseline reset 至今（17 天）**0 写入**——同 10/points 模块，cron-worker 容器疑似未运行 / `system_configs.*.messageTitle` 配置缺失。（b）share-gift 三副本同样 0 写入。（c）admin batchSendMessages 完整实现含 UI / 权限 `message:send` / 1000 人上限 / 分片 INSERT 但 **5434 现状无任何此类 INSERT 行（无 `mode=filters/userIds` 来源痕迹）**——后台运营从未点过批量发。（d）`recipient_type='员工'` 全代码无写入路径 + staffApi 无 message 路由 = 完全死分支，但 admin getMessagesPaginated/JOIN staff_wechat_users 仍按"未来可能"实现，是 2026-04-26 仍存活的预留代码 |
| 7 | dump-restore 残留 / drift | ⚠️ 命中 | P2 | 唯一行 id=2 title='测试' body='测试' recipient='FYGK-20260314-00001' created_at=2026-04-09T07:52 是手工测试残留（id=2 表示曾有 id=1 被删；bigserial sequence 已推进）。建议最终迁移前 `TRUNCATE messages RESTART IDENTITY` 或 `DELETE WHERE id=2 AND title='测试'`，避免上线时这条带"测试"二字的消息出现在客户端首位 |
| 8 | 运行时安全 | ⚠️ 命中 | P1 | （a）SQL 注入：cron 三 STEP / share-gift 三副本均使用参数化 `$1..$5` ✅ 安全；admin batchSendMessages 走 Drizzle ORM ✅ 安全；admin getMessagesPaginated `search` ilike 已做 `%/_` 转义 ✅ 安全。（b）缺索引：`idx_messages_recipient (recipient_type, recipient_id, is_read)` 是唯一业务索引，admin 列表的高频筛选 `messageType` / `dateFrom..dateTo` 无索引；`getMessageTypes` 跑 `SELECT DISTINCT message_type FROM messages` **无 LIMIT 全表扫**——量级到 100w 行后 SELECT DISTINCT 会拖慢 admin 筛选下拉。（c）admin `deleteMessage` 物理删除**不要求 expectedUpdatedAt 乐观锁**（因表无 updated_at），并发同 id 删可能出现"提示删除成功但实际 result.count=0"的状态紊乱（当前 0 < 1 ms 风险）。（d）admin `batchSendMessages` 分片 500 写入**未包在事务**——前 500 写成功后 500 失败时已发出去的不可回滚，且**无 audit failure log**（成功才写 `message.batchSend`） |

### 高危逐条（按严重度排序）

**E1（P0 / Bug）**：share-gift 三副本写 `ref_entity_type='sale_order'` 但客户端 `messages.ts:114` 期望 `record.refEntity === 'order'` —— **字符串不等**，分享礼消息点击跳订单详情链路**100% 失败**。修法二选一：① 改云函数三副本写 `'order'`（与 schema 注释 L24 "sale_order/appointment/service_order" 不一致）；② 改前端 `(record.refEntity === 'sale_order' || record.refEntity === 'order')` 兜底。推荐 ②，因 schema 注释用的是表名规范 `sale_order`。

**E2（P0 / 死代码 + 0 写入）**：`recipient_type='员工'` 永远命中不到——enum 值 / admin JOIN / 列表筛选下拉全部按"未来可用"保留，但写入路径 0 个；staffApi 无 message 路由。需产品决策：要么砍掉 `员工` enum 值 + admin 相关 JOIN/筛选 UI；要么补 staffApi 路由 + 至少 1 个员工消息触发器（如审批通过 / 解绑申请被驳回）。

**E3（P0 / 跨模块设计未实现）**：cron 三 STEP（升级/生日/感恩）写消息时 `ref_entity_type/id` 全 NULL —— 前端跳详情逻辑 `messages.ts:114-118` 只 case `'order'`/`'appointment'`，cron 类消息**永远走第三个 else 分支即不跳转**。schema 注释 L24 暗示该列要支撑跳详情。修法：cron 三 STEP 都加 `ref_entity_type='customer', ref_entity_id=userId`，前端补 `case 'customer': navigateTo /pagesProfile/profile-edit`。

**E4（P0 / 运行时观测）**：6/7 个生产入口在 PG 5434（业务主库）**0 写入**——cron-worker 三 STEP / share-gift 三副本 / admin batchSendMessages 自 baseline reset（17 天）至今无任何真实生产数据。与 10/points 同源症状，强烈建议在最终迁移前，要求运维方提供 cron-worker 容器近 17 天 stdout 日志 + payNotify 近 30 天调用次数 + admin 后台是否有人点过 `/messages` 页 → 三道证据缺一必须先确认产品形态再讨论数据。

**E5（P1 / 运营误用）**：admin batchSendMessages 允许 `messageType` 任意 50 字以内字符串，前端 `TYPE_COLOR_MAP` 仅识别 `appointment/order/system` 三键，运营若按业务习惯填 `'活动'/'优惠'/'公告'` 全部静默降级为灰点 + 灰图标。建议 admin actions 里加 enum 校验或下拉选项约束。

**E6（P1 / 完整性）**：messages 无 `title NOT EMPTY` 应用守卫——cron 三 STEP 仅 `if (config.messageTitle)` 排除 NULL/`''`/`undefined` 但**不排除全空格 `'   '`**；schema 仅 NOT NULL 不检长度。建议 schema 加 `CHECK (length(trim(title)) > 0)`。

**E7（P1 / 索引缺失）**：admin 列表筛选 `messageType` / `dateFrom..dateTo` 无索引，`getMessageTypes` 跑 SELECT DISTINCT 全表扫。当前数据量 1 行无影响，但产品上线后 N 万行/月增长，需在 messageType + createdAt 加联合索引。

**E8（P2 / dump 残留）**：唯一行是 `title='测试' body='测试'` 测试残留，最终迁移前应 `DELETE FROM messages WHERE id=2 AND title='测试'`，否则上线后客户首次进消息中心看到"测试"。

---

## 字段扩展建议 R2（2026-04-26）

**WF 复核**：MSSQL `wkdb_20220804_86cd3292` 凭据已过期（`SD@47.96.87.33,1433` 报"账户密码已过期"），回退至 `notes/research/workfine_database.md` 全文检索 "消息/notification/通知/message/站内/公告/短信/sms/push/提醒" **0 命中**。R1 结论"WF 完全无消息实体"在 R2 维持不变。本表 100% 新系统独立，**0 字段从 WF 反推**。

下表全部基于"消息中心要从 0 写入走向真实生产"这一假设，从 PG 端"运行时缺什么"反推扩展候选。每行包含：列名 / WF 源（一律 `N/A 新系统`）/ 优先级 / 业务理由 / 抽取式 / 数据量 / 依赖。

| # | PG 应新增列 | WF 源 | 优先级 | 业务理由 | 抽取式 / 默认值 | 数据量 | 依赖 |
|---|-----------|-------|--------|---------|----------------|--------|------|
| 1 | `messages.read_at TIMESTAMP NULL` | N/A 新系统 | **P0** | 当前 `is_read` 翻转无时间戳，admin 审计 / 数据看板"消息打开率/打开时长分布"全无法做；与 14/service-commission 同质（都缺时间戳）；表无 `updated_at`，is_read 翻转的时间窗永久丢失 | clientApi/routes/message.js:read 内 `UPDATE messages SET is_read=true, read_at=NOW() WHERE ...`；现存 1 行回填 `read_at=created_at` 即可 | 1 行回填 + 增量永生效 | 仅改 1 处 SQL + schema 加列 |
| 2 | `messages.priority SMALLINT NOT NULL DEFAULT 0` | N/A 新系统 | **P0** | 现状无任何"重要程度"字段，cron 升级 vs share-gift vs admin 群发同等地位，客户端列表无优先级排序；产品侧已暗示要做"未读重要消息红点"——见 client.pr.spec.md（如存在）。值域：0=普通 / 1=高 / 2=系统强制弹窗（含支付/退款/服务变更等不可错过通知） | cron 三 STEP 升级=2 / 生日=1 / 感恩=1；share-gift=1；admin batchSend 默认 0 可在 UI 选 0/1 | 增量 | 7 个写入入口都要改 1 行 + 客户端列表 orderBy 改 `priority DESC, created_at DESC` |
| 3 | `messages.expires_at TIMESTAMP NULL` | N/A 新系统 | **P1** | share-gift 通知含"X 天后过期"的优惠券面值/有效期信息（body 模板里写死），过期后该消息仍躺在客户消息中心毫无意义；cron 生日权益月初发也有时效；admin 群发"双 11 活动 11/11 截止"同理 | share-gift 副本：`expires_at = expireAt`（已计算）；cron 生日/感恩：发出 + 30/15 天；admin 群发：UI 可选有效期 | 增量 | 客户端列表过滤 `WHERE expires_at IS NULL OR expires_at > NOW()` 或弱化展示（灰显） |
| 4 | `messages.action_url TEXT NULL` / `messages.action_payload JSONB NULL` | N/A 新系统 | **P1** | 当前点击跳转**硬编码**在 `messages.ts:114-118`（仅 order/appointment 两 case），新增任何业务消息（如服务单/积分/储值卡/会员升级跳详情）都要改前端代码。改为后端写 `action_url='/pagesProfile/profile-edit'` 或 `action_payload={"page":"order-detail","saleOrderId":"FY-XSD-..."}` 由前端通用调度 | cron 升级 → `action_url='/pagesProfile/profile-edit?tab=member'`；share-gift → `action_url='/pagesOrder/order-detail?saleOrderId=...'`；可在 7 个入口逐步加 | 增量；老消息列降级为"无跳转" | 客户端跳转逻辑改为通用 `if (record.actionUrl) navigateTo(record.actionUrl)`，去掉硬编码 case |
| 5 | `messages.recipient_type` enum 加 `'全员'` 值 / 或保留双值但落地 `员工` | N/A 新系统 | **P1** | 当前死值 `员工` 占用 enum 槽位但无写入路径。两种处置方案：① **删除 `员工`**（migration 0006+ 风险大需先确认 staffApi 永不做消息中心）；② **保留并落地**——staffApi 加 `message.list/unreadCount/read` 路由，cron-worker 加员工类触发器（如审批通过、申请被驳回、月度业绩通知） | 决策依赖产品方；推荐 ②，扩展性更好 | 0 行影响（员工现状 0 行） | staffApi 加 1 个路由文件 + 至少 1 个写入器；admin getMessagesPaginated 已支持 |
| 6 | `messages.message_type` 升级为 enum + 标准化 | N/A 新系统 | **P1** | 当前 `varchar(50)` 任意字符串，admin batchSend 不做枚举校验，前端 TYPE_COLOR_MAP 三键写死，新增分类全部沦为灰点。建议改为 `pgEnum('message_type', ['system','order','appointment','service','points','coupon','prepaid_card','share_gift','activity'])` | 现存 1 行=`'system'` 兼容；7 个入口逐步分类（cron 升级=`'system'` / 生日=`'system'` / 感恩=`'system'` / share-gift=`'share_gift'` / admin 默认 `'system'`） | 1 行兼容 + 增量 | 前端 TYPE_COLOR_MAP 同步扩 9 键；admin 筛选下拉 |
| 7 | `messages.sender_type / sender_id` | N/A 新系统 | **P2** | admin batchSendMessages 仅写 `operation_logs(operator_employee_id)` 但 messages 表本身**不知道是哪个 admin 发的**——客户消息中心永远显示"系统消息"，运营查"是不是上次 X 经理发的活动"必须翻 operation_logs JOIN。值域：`'system'/'admin'/'staff'`；sender_id 对应 employee_id 或 'cron-worker' / 'share-gift' | cron 三 STEP→`'system'/'cron-worker'`；share-gift→`'system'/'share-gift'`；admin batch→`'admin'/{operatorEmployeeId}` | 增量；现存 1 行=`'system'/'manual-test'` | 7 入口加 2 列 |
| 8 | `messages.tenant_store_id TEXT NULL` | N/A 新系统 | **P2** | 当前 messages 表**无门店维度**，admin getMessagesPaginated 注释明说"messages 表无 store_id，不走 scope 过滤"——但产品上线后店长想查"我门店顾客的消息流水"完全无法 scope；admin batchSendMessages 已经支持 orgNodeId 筛选投递目标，**不写门店 ID 是浪费**——完全可以从 client_wechat_users.bound_store_id 派生写入 | INSERT 时 `(SELECT bound_store_id FROM client_wechat_users WHERE user_id=recipient_id)`；cron 三 STEP / share-gift 副本 / admin 一致 | 增量；现存 1 行回填 | scope 接入 admin getMessagesPaginated；适当索引 |
| 9 | `messages.delivery_channel` SMALLINT 位标记（in-app=1 / wechat-subscribe=2 / sms=4） | N/A 新系统 | **P3** | 当前所有消息只走站内信，未来若接微信订阅消息 / 短信通道，需要在同一行记录"已通过哪几种通道"+ 分别的发送时间戳。当前 messages 表只承担 1 通道，强行加列前请先确认订阅消息会不会另起一张 `message_dispatches` 表 | 默认 1（in-app） | 增量 | 当前不需要，提案性候选 |

**P0 共 2 个**（read_at / priority）；**P1 共 4 个**（expires_at / action_url+payload / recipient_type 落地 / message_type enum 化）；**P2 共 2 个**（sender / tenant_store_id）；**P3 共 1 个**（delivery_channel）。**总扩展候选 9 个，0 个从 WF 反推**（与 R1 一致）。

**最大反推空间为 0**：MSSQL 完全无消息实体，且现有 PG schema 不存在"应同步但未同步"的列。所有候选都是从"产品形态走向生产"角度提的"应该有什么"，而非"WF 有但没接进来"。

