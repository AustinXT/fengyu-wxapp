# 审计报告：操作日志 operation_logs (23)

**审计时间**：2026-04-25
**域 ID**：23
**审计员**：claude-opus-4-7
**审计时长**：约 18 分钟
**关联 PR/Ticket**：—（与 audit-01 P1-MODEL-10 v3.3 迁移完整性闭环；与 audit-11/12/19/20 的"staff 路径 0 logs"反复命中收口）

---

## 1. 三端入口对照

| 层 | admin | staff | client | payNotify | cron-worker |
|----|-------|-------|--------|-----------|-------------|
| Schema | `db/schema/operation-log.ts:1-47` | ↑ | ↑ | ↑ | ↑ |
| 写入 helper | `fengyu-admin/src/lib/operation-log.ts:31-118`（`logOperation` / `logUpdate` / `logTransition`） | 无（裸 SQL `INSERT INTO operation_logs`） | 无（裸 SQL） | 无（裸 SQL） | 裸 SQL（`db.execute` + drizzle template） |
| 读取/列表 | `fengyu-admin/src/actions/logs.ts:35-105`（`getLogs` / `getOrderLogs`） | — | — | — | — |
| 读取页面 | `fengyu-admin/src/app/(main)/logs/page.tsx` + `_components/logs-page.tsx` | — | — | — | — |
| 测试 | `fengyu-admin/src/lib/operation-log.test.ts`、`actions/logs.test.ts`、各 action `*.test.ts` 中 `logOperation: vi.fn()` mock 验证 | `__tests__/utils/points.test.js`（settle 失败告警）+ `__tests__/routes/service.test.js`（`rate=0` 告警） | `__tests__/share-gift.test.js`（`share.giftGranted`） | — | `cron/__tests__/*.test.ts` 各 STEP 写入断言 |

DB schema 列：

| 列 | 类型 | 备注 |
|---|------|------|
| `id` | bigserial PK | — |
| `operator_employee_id` | varchar(30) FK→`staff_wechat_users.employee_id` | 系统操作可空 |
| `operator_name` | text | 快照 |
| `operator_role` | text | 快照（manager / beautician 等） |
| `org_node_id` | text FK→`org_nodes.id` | 快照 |
| `org_node_name` | text | 快照 |
| `action` | text NOT NULL | 形如 `module.method` |
| `target_type` | text NOT NULL | order / customer / coupon_template / ... |
| `target_id` | text NOT NULL | 主键字符串 |
| `detail` | jsonb | 业务上下文 |
| `source` | text | adminApi / staffApi / clientApi / payNotify / cronTask |
| `created_at` | timestamp DEFAULT NOW() NOT NULL | — |

索引：`(operator_employee_id)` / `(target_type,target_id)` / `(action)` / `(created_at)`。

---

## 2. 数据流图

```
[admin actions] ── logOperation/logUpdate/logTransition ──┐
                                                          │
[staff staffApi]  ── 裸 SQL INSERT (5 处) ────────────────┤
                                                          │
[client clientApi] ── 裸 SQL INSERT (2 处) ──────────────►  operation_logs
                                                          │           │
[payNotify]       ── 裸 SQL INSERT (2 处) ───────────────┤           ▼
                                                          │   admin /logs 列表
[cron-worker]     ── drizzle template INSERT (5 STEP) ───┘
```

实际写入点全量盘点（grep `INSERT INTO operation_logs` + `logOperation/logUpdate/logTransition`）：

| 端 | 文件 | 写入条数 | action 命名 |
|---|------|----|---|
| admin | `actions/orders.ts` | 6 | `order.create` / `order.confirmPayment` / `order.close` / `order.resetFailed` / `order.create_conversion` / `order.record_payment` |
| admin | `actions/refunds.ts` | 4 | `refund.create` / `refund.overdraftDeducted` / `refund.approve` / `refund.reject` |
| admin | `actions/services.ts` | 4 | `service.start` / `service.complete` / `service.cancel` / `service.create` |
| admin | `actions/appointments.ts` | 3 | `appointment.confirm` / `appointment.checkin` / `appointment.cancel` |
| admin | `actions/allocations.ts` | 3 | `allocation.save` / `allocation.delete` / `allocation.batchSave` |
| admin | `actions/service-commissions.ts` | 1 | `serviceCommission.batchSave` |
| admin | `actions/customers.ts` | 3 | `customer.update` / `customer.create` / `admin.mergeClientProfile` |
| admin | `actions/employees.ts` | 3 | `employee.create` / `permission.scopeSync` / `employee.update` |
| admin | `actions/products.ts` | 16 | `product/category/sku/mall_*/bundle_group/product_kind` 全套 |
| admin | `actions/coupons.ts` | 5 | `coupon.create/update/启用/停用/issue/batchIssue` |
| admin | `actions/messages.ts` | 2 | `message.delete` / `message.batchSend` |
| admin | `actions/store-unbind.ts` | 2 | `store_unbind.approve/reject` |
| admin | `actions/stores.ts` | 2 | `store.create/update` |
| admin | `actions/org.ts` | 3 | `org.create/update/delete` |
| admin | `actions/permissions.ts` | 2 | `permission.assign/revoke` |
| admin | `actions/positions.ts` | 3 | `position.create/update/delete` |
| admin | `actions/skill-tags.ts` | 3 | `skillTag.create/update/delete` |
| admin | `actions/commission.ts` | 3 | `commission.create/update/delete` |
| admin | `actions/auth.ts` | 3 | `auth.changePassword` / `auth.resetPassword` / `auth.resetToDefault` |
| admin | `actions/settings.ts` | 3 | `system.saveConfig` 等 logUpdate |
| admin | `actions/pickup-records.ts` | 1 | `create` (action 命名缺前缀) |
| **admin 合计** | — | ~75 处 | — |
| staff | `staffApi/routes/service.js:419` | 1 | `service.complete.rate_missing`（rate=0 告警，非主审计） |
| staff | `staffApi/utils/points.js:114` | 1 | `points.settleFailed`（settle 失败告警） |
| staff | `staffApi/share-gift.js:141` | 1 | `share.giftGranted` |
| **staff 合计** | — | **3 处** | — |
| client | `clientApi/share-gift.js:141` | 1 | `share.giftGranted` |
| client | `clientApi/utils/points.js:96` | 1 | `points.settleFailed` |
| **client 合计** | — | **2 处** | — |
| payNotify | `payNotify/share-gift.js:141` | 1 | `share.giftGranted` |
| payNotify | `payNotify/points.js:84` | 1 | `points.settleFailed` |
| **payNotify 合计** | — | **2 处** | — |
| cron | `cron/steps/refresh-member-levels.ts` | 3 | `customer.memberLevelChange` ×2 + `customer.memberLevelHeld` |
| cron | `cron/steps/grant-birthday-benefits.ts` | 1 | birthday |
| cron | `cron/steps/grant-thanksgiving-benefits.ts` | 1 | thanksgiving |
| cron | `cron/steps/audit-points-balance.ts` | 1 | `points.balanceMismatch` |
| cron | `cron/steps/audit-role-type-nulls.ts` | 1 | `dataIntegrity.roleTypeNull` |

> **观察**：admin ≈75 路径 vs staff 3 + client 2 + payNotify 2 = **三端总计仅 7 个写入点**。staffApi 的 15 个 routes 文件中**只有 service.js 一个文件写日志**（且仅在 rate_missing 告警分支），其余 14 个文件 0 写入。这就是 audit-11/12/19/20 反复出现 "staff 路径 0 operation_logs" 的根因——不是局部漏写，而是**staffApi 完全没有审计日志写入约定**。

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-23-01] staffApi 全域无审计日志，店长一切高权限操作均无追溯**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`、`customer.js`、`store.js`、`appointment.js`、`allocation.js`、`service.js`（除 rate_missing 单点）
- **现象**：staffApi 共 12 个业务路由文件，仅 `routes/service.js`（rate_missing 告警）+ `share-gift.js`（自动赠送）+ `utils/points.js`（settle 失败）3 处 INSERT operation_logs，**所有店长发起的关键操作均无审计**：
  - `order.create` / `order.confirmOffline` / `order.close` / `order.resetFailed` / `order.createRefund` / `order.approveRefund` / `order.rejectRefund` / `order.createRepayment` / `order.createConversion` / `order.createPickup` — 0
  - `customer.assign`（店长跨员工分配）/ `customer.updateNotes` — 0
  - `store.approveUnbind` / `store.rejectUnbind` — 0（admin 同名路径有 `logTransition`）
  - `appointment.confirm` / `appointment.checkin` — 0
  - `allocation.save` / `allocation.deleteAllocation` — 0（admin 同名路径有 `logOperation`）
  - `service.create` / `service.start` / `service.complete` / `service.cancel` — 0
- **风险**：店长（manager 角色）拥有最广业务权限（开单 / 退款审批 / 分配 / 解绑审批），任何资损 / 误操作 / 内部串通**均无系统证据**。`real.md` 第 5 条"后端统一鉴权"侧重权限控制，但失去日志后所有 ex-post 追溯能力归零；财务复核 / 客诉调单 / 内审都无可用证据链。
- **复现**：店长 A 用 staffApi 调 `order.approveRefund` 把订单 X 退款 → DB 状态变更 + payments 写流水，但 `operation_logs` 没有任何 `refund.approve` 行（admin 同操作有 `refunds.ts:955` 写）。
- **修复**：(L3 staffApi routes)
  - 短期：在 staffApi 各 write 路由的事务 COMMIT 前 `INSERT INTO operation_logs (...) VALUES (...)`，参考 share-gift.js:141 模式。
  - 中期（推荐）：写一个 `staffApi/utils/audit.js` 作为 helper（`logOpStaff(client, ctx, action, targetType, targetId, detail)`），替换裸 SQL，与 admin `lib/operation-log.ts` 形成对称封装；同时把 detail 也按 admin v2 schema（`{_v:2,_t:'transition',from,to,context}` / `{_v:2,_t:'update',changes}`）写，确保前端 `logs-page.tsx` 的 `LogDetail` 渲染兼容。

#### **[P0-23-02] PII 在 detail JSON 中明文写入（phone / id_card / openid）**
- **文件**：`fengyu-admin/src/actions/customers.ts:540`、`employees.ts:348`、`auth.ts:140-318`
- **现象**：
  - `customers.ts:540` — `logOperation('customer.create', ..., { name: data.name, phone: data.phone })`，**完整手机号**入库 detail jsonb。
  - `customers.ts:619` 注释明示 `logUpdate` diff 也会包含 `phone: { from, to }` —— 改号场景旧/新手机号同时落 detail。
  - `employees.ts` 通过 `logUpdate` 把 `idCard` / `phone` / `birthday` 全字段对比，diff 落 detail。
  - `auth.ts` 改密 / 重置密码不写明文密码（OK），但 `auth.changePassword` 仅写 employeeId（合规）。
- **风险**：
  - operation_logs.detail 是 jsonb，前端 `logs-page.tsx:222` 直接 `JSON.stringify` 展示——任何登录 admin（`requirePermission(session,'operation_log:list')` 仅 admin 角色）都能看到完整 PII，违反 `audit-01 P0-PII-06` + 横切 CC6。
  - 出口（导出 / 备份 / 跨机器迁移）会复制 PII。
  - 已有 audit-15 / audit-19 报告 detail 含 openid 敏感信息（横切 CC6 line 331）。
- **复现**：admin → 顾客详情 → 改 phone → 提交 → 进 /logs 页 → 展开 detail → 旧手机号 + 新手机号同屏可见。
- **修复**：(L4 lib helper)
  - 在 `lib/operation-log.ts` 写入前对 `detail` 做白名单脱敏：phone 中间 4 位 `*`、idCard 中间 8 位 `*`、openid 仅留前 4 后 4。
  - 或新增 `redactDetail(obj, fields)` 工具，在 customers/employees actions 显式调用。

#### **[P0-23-03] `operator_employee_id` 在所有 staff/client/payNotify/cron 写入中均为 NULL**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/share-gift.js:141`、`utils/points.js:114`、`fengyu-client/cloudfunctions/clientApi/share-gift.js:141`、`utils/points.js:96`、`fengyu-client/cloudfunctions/payNotify/share-gift.js:141`、`payNotify/points.js:84`、`fengyu-admin/src/cron/steps/*.ts`
- **现象**：除 `staffApi/routes/service.js:419-429` 一处显式写 `ctx.auth.staffWfId/operator_name/operator_role`，其他 6 处裸 SQL INSERT 都**只插 6 列**（`action, target_type, target_id, detail, source, created_at`），`operator_employee_id` / `operator_name` / `operator_role` / `org_node_id` / `org_node_name` 五列全 NULL。
  - 系统级（payNotify、cron）NULL 是合理的（schema 注释允许 cronTask / payNotify NULL）；
  - 但 `staffApi/share-gift.js` 由 staff 用户的 confirmOffline 触发、`clientApi/share-gift.js` 由 client 用户的 pay/confirmPrepaidFull 触发——**有真实操作人但全部记成 NULL**。
- **风险**：日志列表"操作人 = 空"，无法关联到员工 / 顾客的具体身份，与 schema 注释"系统级才允许 NULL"语义偏离；同时 PLAN §2 关键检查点"`operator_employee_id` 写入完整（v3.3 后）"未达成。
- **复现**：店长 A 用 staffApi 触发自动赠送 → operation_logs 出现一行 `share.giftGranted`，但 operator_employee_id IS NULL，看不出是 A 触发的。
- **修复**：(L3) staffApi 写入处补全 `ctx.auth.staffWfId/name/roles[0]`；client 写入处可选写 `client_user_id` 到 detail（非员工，没 employee_id 字段，但应至少在 detail 写一条 `triggeredBy: 'client', userId: ...`）。
  - 进一步：考虑 schema 加一列 `operator_user_id text`（client 顾客触发时填）+ CHECK 约束 "operator_employee_id 与 operator_user_id 至少有一个非空（除非 source IN ('cronTask','payNotify')）"；详见 §E 的 S23-03。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-23-04] `getLogs` 硬编码 LIMIT 500，超过即静默截断**
- **文件**：`fengyu-admin/src/actions/logs.ts:71`
- **现象**：`getLogs` 拼好 WHERE 后 `.limit(500)`，前端 `logs-page.tsx:299` 是**客户端分页**（`filtered.slice(...)`)，意味着**真正历史日志只能看最近 500 条**，超出无法翻页（与 admin 其他 6 个页面"服务端分页"约定不一致，`fengyu-admin/CLAUDE.md` 第 "服务端分页" 条目也未列入 logs）。
- **风险**：
  - 业务量稍大（一天上千条）时，超 500 条的历史日志在 UI 上消失。
  - "查 7 天前的某次开单审计"无法实现。
  - 与 audit-13/15/16 等域审计提到的"列表服务端分页"统一规范不一致。
- **修复**：(L7) 改为服务端分页：`getLogs({ page, pageSize, ...filters })` → 返回 `{ rows, total }`；`logs-page.tsx` 改成 `searchParams` 驱动（参考 orders/services 的实现模板）；同时 SQL 加 `OFFSET` 配合 `idx_op_logs_created_at` 索引。

#### **[P1-23-05] `getLogs` 完全无组织域 scope 过滤（CC3）**
- **文件**：`fengyu-admin/src/actions/logs.ts:35-74`
- **现象**：`requirePermission(session,'operation_log:list')` 仅 admin 角色，但 SELECT 语句**完全不带** `org_node_id IN scopeStoreIds` 等任何 scope condition。当前规则是"只有 admin 能看"，所以全网可见 = 暂时合理；但与 §3 CC3 "所有 SELECT 包含 org_node_id IN (?)" 语义脱节。
- **风险**：
  - 一旦未来给 finance / hr 等角色开放 `operation_log:list`，立刻变成全集团 PII 越权（原作者明显假设了 admin-only）。
  - 缺少灵活的"按 store / 按 employee 自审"能力——manager 看不到自己门店的操作历史，得求 admin 开后台。
- **修复**：(L7) `getLogs` 增加 `scopeCondition(session, operationLogs.orgNodeId)` 兜底（admin 透传，其他角色自动按 scopeStoreIds 收紧）；权限项可拆 `operation_log:list_self` / `operation_log:list_all`。

#### **[P1-23-06] 三端 detail JSON schema 完全不统一（admin v2 vs staff/client/payNotify v1 vs cron 无版本号）**
- **文件**：admin `lib/operation-log.ts:88-117`（`_v:2,_t:'update'/'transition'`）vs staff/client/payNotify `share-gift.js:145`（`_v:1`）vs cron `refresh-member-levels.ts:148`（`_v:3`）
- **现象**：
  - admin 严格 v2：`{ _v:2, _t:'update'|'transition', changes/from/to/context }` —— 前端 `logs-page.tsx:148-218` 的 `LogDetail` 组件按这个 schema 渲染。
  - staff/client/payNotify 三端 share-gift 写 `_v:1`：完全 flat，没有 `_t`。
  - cron `customer.memberLevelChange` 写 `_v:3,_t:'transition'` 但又有自己的 `direction` / `lockedUntil` 等 ad-hoc 字段，不在 admin LogDetail 字段映射 `fieldLabels` 里。
  - rate_missing / settleFailed 完全裸 JSON 没 `_v`。
- **风险**：admin /logs 列表对 `_v:1` / 无版本号 / `_v:3` 的日志降级到"原始 JSON pre"显示，用户体验断崖；后续若想做"按 detail.field 搜索"会发现字段名都不对齐。
- **修复**：(L4) 统一约定 detail v2 schema 文档化（写入 `.42cog/dev/sys.spec.md` 或新增 `audit-log.spec.md`）；存量数据按 `_v` 路由解析；三端 helper 统一封装（参考 P0-23-01 修复方案 staff helper）。

#### **[P1-23-07] 三端 helper 不对称：admin 用 ORM + 自动塞 session，staff/client 全裸 SQL**
- **文件**：`fengyu-admin/src/lib/operation-log.ts` vs staff/client 裸 SQL
- **现象**：admin 通过 `logOperation(session,...)` 自动从 session 提取 `employeeId/name/roles[0]/scopeId→orgNodeId` 五个上下文字段；staff/client 路由内**每次都得手敲六七个 SQL 占位符**——既冗余又容易漏 column。`staffApi/routes/service.js:419-429` 是唯一一处认真写全的，其他 5 处全 NULL（见 P0-23-03）。
- **风险**：(a) 横向扩散后每个新写入点都重复犯错；(b) 日后 schema 加列（如 store_id）需修 N 处。
- **修复**：(L3) 在 `staffApi/utils/audit.js` + `clientApi/utils/audit.js` 新增 `logOp(client, ctx, action, targetType, targetId, detail)`，与 admin helper 函数签名对齐。

#### **[P1-23-08] action 命名不规范——`pickup-records.ts` 仅写 `'create'`**
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:346`
- **现象**：admin 其他所有 action 都遵循 `module.method` 格式（如 `order.create`），唯一例外 `pickup-records.ts:346` 写成 `await logOperation(session, 'create', 'pickup_record', ...)`，`logs-page.tsx:14-60` 的 `actionLabels` 字典里 `'create'` 没映射，前端会显示原始字符串 `create`。
- **风险**：搜索按 action 过滤时 `'create'` 会与未来其他模块同名冲突；前端显示丑。
- **修复**：(L7) 改成 `'pickup.create'` 或 `'pickup_record.create'`；同时把 `actionLabels` 的对应中文加进 logs-page。

#### **[P1-23-09] cron-worker 大量空字符串注入风险（次要）**
- **文件**：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:152-159`
- **现象**：cron 用 `sql\`INSERT ... VALUES (..., 'customer', ${userId}, ${detail}::jsonb, 'cronTask', NOW())\`` —— drizzle template 是参数化没 SQL 注入；但 `userId` 直接字符串塞进 `target_id text`，长度无校验。schema `target_id` 是 text 无长度上限，技术上 OK，但写日志的 `userId` 来源是 client_wechat_users.user_id（最长 30 字符），不会爆——小问题，记录不阻塞。

### 3.3 P2（代码质量）

#### **[P2-23-10] 缺少 `idempotency_key` / 唯一键防重写**
- **现象**：operation_logs 完全没有 idempotency_key 列，schema 里也没有 UNIQUE 约束。重试 / 重复点击场景下，同一逻辑操作会写多条日志（如 share-gift 已有 `messages` 表的 `idempotency_key` 防重，但 operation_logs 仍可能重复）。
- **风险**：日志膨胀、详情不一致（前后两次 transition 可能 from/to 不同）。
- **修复**：(L0) schema 加可空 `idempotency_key text` + partial unique index；写入处对幂等关键路径（pay 回调 / 同一订单的 close）传 key。

#### **[P2-23-11] 缺少 `occurred_at` 区分（仅 created_at）**
- **现象**：schema 仅 `created_at` = 写入时间。如果业务事件发生在 T0 但日志补写在 T0+5min（事务 commit 后 helper 异步），无法区分"业务时间"和"日志记录时间"。当前所有写入都同步在事务内完成，问题暂不显现。
- **修复**：(L0) 长期可加 `occurred_at` 列；近期可不动，仅记录设计 debt。

#### **[P2-23-12] 索引完整性—缺 `(operator_employee_id, created_at DESC)` 复合索引**
- **现象**：`idx_op_logs_operator` 是单列；按"某员工最近 30 天的所有操作"这种业绩复盘类查询会先按 operator 过滤再 sort，filesort 量大。
- **修复**：(L0) 加 `(operator_employee_id, created_at DESC)`；`(target_type, target_id, created_at DESC)` 也类似。

#### **[P2-23-13] LogDetail 组件未做 detail 体积截断**
- **文件**：`fengyu-admin/src/app/(main)/logs/_components/logs-page.tsx:222`
- **现象**：legacy 分支直接 `JSON.stringify(detail, null, 2)` 全量渲染，若 detail 含大数组（如 batchIssue 的 customerIds 数百条）会撑爆表格。
- **修复**：(L9) 加 `if (text.length > 2000) ...展开/折叠按钮`。

#### **[P2-23-14] action 字典分裂：`logs-page.tsx` actionLabels vs 实际写入名**
- **现象**：logs-page 字典缺：`refund.create / refund.approve / refund.reject / refund.overdraftDeducted` / `serviceCommission.batchSave` / `share.giftGranted` / `customer.memberLevelChange` / `customer.memberLevelHeld` / `points.balanceMismatch` / `points.settleFailed` / `dataIntegrity.roleTypeNull` / `auth.changePassword` / `auth.resetPassword` / `auth.resetToDefault` / `admin.mergeClientProfile` / `mall_*` 大部分。前端显示原 module.method。
- **修复**：(L9) 补齐字典；或改成约定式（`module.method` 自动 split + i18n 字典）。

#### **[P2-23-15] `operator_user_id` v3.3 迁移完整性 — RESOLVED**
- **现象**：grep 全仓 `operator_user_id` 仅在 `db/migrations/_archive_pre_baseline_2026_04/` 归档目录命中，运行时代码 0 引用。schema 当前 `operator_employee_id` varchar(30) FK→`staff_wechat_users.employee_id`（与 v3.3 决策一致）。`audit-01 P1-MODEL-10` 提出的"残留检查"在域 23 收口：**已完成迁移**。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | cron | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|------|--------|
| 写入 helper | `logOperation/Update/Transition`（lib helper，自动注入 5 列上下文） | 裸 SQL | 裸 SQL | 裸 SQL | drizzle template | 漂移 / 漏字段 | P0 |
| `operator_employee_id` 写入 | 100% 写入 | 1/3 写（service rate_missing 写，share-gift / settleFailed 不写） | 0/2 写 | 0/2 写 | 0/5 写（系统级合理） | 真人操作记 NULL | P0 |
| detail schema | `_v:2,_t:'update'/'transition'` | `_v:1` flat / 无 `_v` | `_v:1` / 无 `_v` | `_v:1` / 无 `_v` | `_v:3,_t:'transition'` 自定义字段 | UI 渲染兼容性 | P1 |
| action 命名 | `module.method` 100% 遵循（除 pickup） | `module.method` 遵循 | `module.method` 遵循 | `module.method` 遵循 | `module.method` 遵循 | 弱不一致 | P2 |
| 列表 UI | 仅 admin /logs（admin-only） | 无 | 无 | 无 | 无 | 无 staff 自审 | P1 |
| 分页 | 客户端 + LIMIT 500 | — | — | — | — | 历史断层 | P1 |
| scope 过滤 | 无（仅按权限拒绝） | — | — | — | — | 一旦放权立越权 | P1 |
| 关键动作覆盖（开单/退款/分配/审批/解绑/分配/赠送） | 100% 覆盖 | 仅赠送（share-gift） | 仅赠送 | 仅赠送 | 仅会员等级 / 生日 / 感恩 / 余额校验 | staff 全失盲 | **P0** |

---

## 5. 横切检查（套用 §3）

- [x] CC1 数值精度：日志域无金额计算
- [x] CC2 并发幂等：写入是事务内顺序 INSERT，无并发问题；缺 idempotency_key 见 P2-23-10
- [ ] **CC3 组织域隔离**：`getLogs` 无 scope，详 P1-23-05
- [ ] **CC4 后端鉴权**：`requirePermission` OK，但 admin-only 太刚性，详 P1-23-05
- [x] CC5 错误前缀：日志域无错误返回路径
- [ ] **CC6 PII**：detail 含 phone/idCard/openid 明文，详 P0-23-02 + 联动 audit-01 P0-PII-06、CC line 331
- [x] CC7 时间字段：`created_at` DEFAULT NOW() OK
- [x] CC8 WXML/Vant：admin Web，无关
- [ ] **CC9 测试与残留**：`operator_user_id` 已 0 残留（P2-23-15 RESOLVED）；admin actions 都有 logOperation mock 测试；staff 路径无写入 → 无测试可言（与 P0-23-01 同源）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/operation-log.ts` | 加 `idempotency_key text` + partial unique；可选 `operator_user_id`（client 用户触发）+ CHECK 约束；加 `(operator_employee_id, created_at DESC)` 与 `(target_type, target_id, created_at DESC)` 复合索引 | P2-23-10/11/12, P0-23-03 |
| L3 staffApi routes | `staffApi/routes/{order,customer,store,appointment,allocation,service}.js` | 全部 write 路径补 `INSERT INTO operation_logs`；推荐先建 `staffApi/utils/audit.js` 封装 `logOpStaff(client, ctx, action, targetType, targetId, detail)` | **P0-23-01** |
| L3 staffApi helper | `staffApi/utils/audit.js`（**新建**） | 与 admin `lib/operation-log.ts` 函数签名对齐：`logOp` / `logUpdate` / `logTransition` 三件套，自动从 ctx.auth 取 5 列上下文 | P0-23-01, P0-23-03, P1-23-07 |
| L3 clientApi helper | `clientApi/utils/audit.js`（**新建**） | 同上；client 触发场景写 `operator_employee_id NULL` + detail 加 `triggeredBy: 'client', userId` | P0-23-03, P1-23-07 |
| L4 admin lib | `fengyu-admin/src/lib/operation-log.ts` | 加 PII 脱敏：`maskPhone` / `maskIdCard` / `maskOpenid`，写入前 sanitize detail 白名单字段 | **P0-23-02** |
| L7 admin actions | `actions/logs.ts` | 1) 服务端分页 `{ page, pageSize, total }`；2) 加 `scopeCondition(session, operationLogs.orgNodeId)` 兜底；3) `getOrderLogs` 加 LIMIT 防爆 | P1-23-04, P1-23-05 |
| L7 admin actions | `actions/pickup-records.ts:346` | `'create'` → `'pickup.create'` | P1-23-08 |
| L7 admin permissions | `lib/permissions.ts:27` | 拆 `operation_log:list_self` / `operation_log:list_all`（manager 得自己门店、admin 全网） | P1-23-05 |
| L9 admin UI | `app/(main)/logs/_components/logs-page.tsx` | 1) 改为服务端分页 `searchParams` 驱动；2) 补 `actionLabels` 字典（refund / serviceCommission / share / customer.memberLevelChange / mall_* 等约 20 个 action）；3) detail >2KB 折叠 | P1-23-04, P2-23-13, P2-23-14 |
| 文档 | `.42cog/dev/sys.spec.md` 或新建 `audit-log.spec.md` | 固化 detail v2 schema、三端 helper 约定、命名规范、PII 脱敏规则 | P1-23-06, P1-23-07 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- A. 残留检查：v3.3 后是否还有 operator_user_id 列？
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='operation_logs'
 ORDER BY ordinal_position;
-- 期望：仅 id / operator_employee_id / operator_name / operator_role /
--      org_node_id / org_node_name / action / target_type / target_id /
--      detail / source / created_at（共 12 列）

-- B. 关键动作覆盖率（最近 30 天 staffApi 触发的退款审批日志数）
SELECT action, count(*)
  FROM operation_logs
 WHERE source = 'staffApi'
   AND created_at >= NOW() - INTERVAL '30 days'
 GROUP BY action ORDER BY count(*) DESC;
-- 期望（修复前）：仅 'service.complete.rate_missing' / 'points.settleFailed' / 'share.giftGranted' 三种
-- 修复后：应出现 'order.create' / 'refund.approve' / 'allocation.save' / 'customer.assign' 等

-- C. operator_employee_id 空率统计（按 source 分组）
SELECT source, count(*) AS total,
       count(*) FILTER (WHERE operator_employee_id IS NULL) AS null_op,
       round(100.0 * count(*) FILTER (WHERE operator_employee_id IS NULL) / count(*), 2) AS null_pct
  FROM operation_logs
 GROUP BY source ORDER BY null_pct DESC;
-- 期望：cronTask / payNotify 100% NULL（合理）；staffApi / clientApi 应大幅 < 100%
-- 当前观察：staffApi NULL 高（仅 service.complete.rate_missing 一处显式写）

-- D. PII 泄漏扫描（detail JSON 含 11 位手机号文本）
SELECT id, action, source, detail::text
  FROM operation_logs
 WHERE detail::text ~ '\d{11}'
   AND created_at >= NOW() - INTERVAL '7 days'
 LIMIT 20;
-- 期望：0 行（修复后）；当前可能命中 customer.create / customer.update / employee.update

-- E. 索引覆盖性
EXPLAIN SELECT * FROM operation_logs
 WHERE operator_employee_id = 'EMP-001'
 ORDER BY created_at DESC LIMIT 50;
-- 期望：使用 idx_op_logs_operator + Sort
-- 加复合索引后：直接 Index Scan on (operator_employee_id, created_at DESC)

-- F. detail _v 分布（schema 漂移度量）
SELECT (detail->>'_v') AS v, count(*)
  FROM operation_logs
 WHERE detail IS NOT NULL
 GROUP BY 1 ORDER BY count(*) DESC;
-- 期望：admin v2 占多数；少量 cron v3 / share-gift v1 / 无版本号
```

---

## 8. 回归测试用例（建议）

1. **staffApi 关键动作日志覆盖**：调用 `staffApi.order.confirmOffline` → 断言 operation_logs 出现 1 行 `action='order.confirmPayment'`，`operator_employee_id=ctx.auth.staffWfId`，`detail._t='transition'`，`detail.from='待确认收款'`，`detail.to='已支付'`。
2. **PII 脱敏**：`logOperation` 写 `{phone:'13812345678'}` → DB 行 `detail.phone='138****5678'`。
3. **getLogs scope 隔离**：以 manager 身份调（假设修复后 `operation_log:list_self` 开放）→ 仅返回自己门店相关 org_node_id 的日志。
4. **服务端分页**：写入 1500 条日志 → `getLogs({ page:1, pageSize:50 })` 返回 50 行 + total=1500，page:30 也能取到第 1500 行。
5. **action 命名规范**：grep 全仓所有 `logOperation/logUpdate/logTransition` 第二参数 → 100% 匹配 `^[a-z][a-z_]*\.[a-z][a-zA-Z_]*$` 正则。
6. **idempotency**：同一订单连续两次 `confirmOffline`（已支付状态）→ logs 仅写 1 行（凭 idempotency_key 防重）。
7. **detail v2 schema**：所有 admin actions 写入的 detail 必含 `_v: 2`。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB + 第三方）**：☑（admin / staff / client / payNotify / cron-worker / DB schema 全沾边）
- 涉及历史数据：☑（存量日志的 detail schema 不统一；PII 已落库）
- 修复成本：**M-L**（staff helper 新建 + 各 routes 补写 ≈ 12 个文件，admin scope 重构 + 服务端分页 ≈ 3 个文件，PII 脱敏 ≈ 2 个文件，schema migration ≈ 1 个迁移）

---

## 10. 后续待办

- [ ] 与 audit-01 P0-PII-06 / CC line 331（PII 横切热点）合并出"日志 PII 脱敏方案"统一稿
- [ ] 与 audit-11/12/19/20 的"staff 路径 0 logs" 反复出现的现象 closing：本审计 P0-23-01 是其根因
- [ ] 把 staffApi/utils/audit.js 封装方案对齐 cloudbase-deploy skill 工作流
- [ ] detail v2 schema 进 `.42cog/dev/sys.spec.md` 固化
- [ ] 写补丁 migration：加 `idempotency_key` + `(operator_employee_id, created_at DESC)` 复合索引
- [ ] 删除（或显式保留）`operator_user_id` 历史归档目录里的 SQL（已 0 引用，但为 v3.3 完整性建议加 comment 说明 RESOLVED）
