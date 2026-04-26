# 审计报告：操作日志 operation_logs (23)

**审计时间**：2026-04-26
**域 ID**：23
**审计员**：claude-opus-4-7
**审计时长**：v1 ~18 分钟 + v2 ~35 分钟（独立重审）
**关联 PR/Ticket**：—
**版本**：v1+v2 合并版，2026-04-26

> 本报告是 v1（2026-04-25）与 v2（2026-04-26，独立重审，未读 v1）的合并版。v2 较 v1 发现了更详细的文件行号和额外 P1/P2；合并以 v2 为准对齐细节，保留 v1 中 v2 未覆盖的 4 项 P2，以 v1 标题格式为蓝本，新增 §11 合并摘要。`operator_user_id` v3.3 残留 RESOLVED 在两版均已确认（仅 `_archive_pre_baseline_2026_04/` 命中）。

---

## 1. 三端入口对照

| 层 | admin | staff | client | payNotify | cron-worker |
|----|-------|-------|--------|-----------|-------------|
| Schema | `db/schema/operation-log.ts:1-47` | ↑（同一张 `operation_logs` 表） | ↑ | ↑ | ↑ |
| 写入 helper | `fengyu-admin/src/lib/operation-log.ts:31-118`（`logOperation` / `logUpdate` / `logTransition`） | **无统一封装**；散见原生 INSERT 6/9 列 | **无统一封装**；散见原生 INSERT 6 列 | **无统一封装**；散见原生 INSERT 6 列 | drizzle template INSERT（6 列，operator 全 NULL） |
| 列表/读取 | `fengyu-admin/src/actions/logs.ts:35-105`（`getLogs` / `getOrderLogs`） | — | — | — | — |
| 读取页面 | `fengyu-admin/src/app/(main)/logs/page.tsx` + `_components/logs-page.tsx` | — | — | — | — |
| 测试 | `fengyu-admin/src/lib/operation-log.test.ts`、`actions/logs.test.ts`、各 action `*.test.ts` 中 `logOperation: vi.fn()` mock 验证 | `__tests__/utils/points.test.js`（settle 失败告警）+ `__tests__/routes/service.test.js`（`rate=0` 告警） | — | — | `cron/__tests__/*.test.ts` 各 STEP 写入断言 |

**v3.3 迁移收口**（两版均确认）：`operator_user_id` 已从 schema 彻底移除，全仓 grep 仅在 `db/migrations/_archive_pre_baseline_2026_04/` 命中遗留 SQL，运行时代码/测试 0 引用。迁移完整性 RESOLVED（见 P2-23-15 / CC9）。

---

## 2. 数据流图

```
[admin (Server Action)] ── logOperation(session, action, targetType, targetId, detail)
                            ├─ 读 session.roles[0].scopeId → org_nodes 拿 orgNodeName
                            └─ INSERT operation_logs (8 列，含 operator_employee_id / operator_name /
                                  operator_role / org_node_id / org_node_name / source='adminApi')

[staff (云函数)] ──────── 16 个高权限 write 路径 ── 0 INSERT ──► (全盲)
                          ├─ order.js: 162(create) / 678(qrcode) / 771(confirmOffline) /
                          │            1068(close) / 1143(resetFailed) / 1773(createRepayment) /
                          │            2017(createConversion) / 2422(createPickup)
                          ├─ allocation.js: 39(save) / 208(deleteAllocation)
                          ├─ appointment.js: 176(confirm) / 223(checkin)
                          ├─ service.js: 21/238/286/722(create/start/complete/cancel)
                          ├─ customer.js: 967(assign)
                          └─ store.js: 75(approveUnbind) / 112(rejectUnbind)
                          ■ 退款 3 件套 (order.js:1487/1635/1721): INSERT 6 列，operator_* 全 NULL
                            仅 service.js:419 (rate_missing 告警) 用 9 列写法写 operator_*

[client (云函数)] ─── share-gift.js + points.js ── 6 列写法 ──► operator_* 全 NULL

[payNotify]         ── share-gift.js + points.js ── 6 列写法 ──► operator_* 全 NULL
                          (PAYNOTIFY_DISABLED 守卫写 'paynotify.disabled_invocation' 告警)

[cron-worker]       ── 5 STEP drizzle template INSERT ──► source='cronTask', operator_* 全 NULL
```

业务关键动作的覆盖矩阵：见 §3.1 [P0-23-01] 详细清单。

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权 / 审计盲点）

#### **[P0-23-01]** staff/client 端 16 个关键资金/状态变更动作**完全没有 operation_logs 写入**
- **来源**：v1（P0-23-01）+ v2（P0-23-V2-01）合并；以 v2 详细清单为准
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:162`（`order.create`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:678`（`order.qrcode`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:771`（`order.confirmOffline`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1068`（`order.close`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1143`（`order.resetFailed`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1773`（`order.createRepayment`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2017`（`order.createConversion`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2422`（`order.createPickup`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:39`（`allocation.save`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:208`（`allocation.deleteAllocation`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:176`（`appointment.confirm`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:223`（`appointment.checkin`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/service.js:21/238/286/722`（`service.create/start/complete/cancel`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:967`（`customer.assign`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:75`（`store.approveUnbind`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:112`（`store.rejectUnbind`）
- **现象**：`grep -E '(operation_logs|logOperation)' staffApi/routes/*.js` 全仓只命中 4 处（refund 三件套 + service.complete.rate_missing 告警分支）。**所有店长高权限动作均无审计行**。
- **风险**（按违反 `audit_plan.md` §1 P0「越权 / 资损」+ `.42cog/real.md` 后端鉴权 + 审计追溯硬约束）：
  1. **店长开单（含资金）零审计**：admin 列表页只能看到顾客确认 & 退款的轨迹，无法回溯订单是谁开的；客诉 / 财务对账时唯一线索仅来自 `sale_orders.opened_by`。
  2. **`allocation.save` 直接影响员工提成**：店长可在订单已支付后篡改分配，无审计 → 内控完全瞎眼。
  3. **`store.approveUnbind/rejectUnbind` 修改顾客绑店关系**：`bound_store_id` 是"可开单"唯一判定（[memory: client-identity-rule](../../.claude/projects/-Users-nv-proj-xt-com-fengyu-wxapp/memory/project_client_identity_rule.md)），却无审计行；恶意店长可批量解绑跨店顾客而不留痕。
  4. **`customer.assign`** 改 `bound_employee_id` 影响业绩归属，零审计 → 提成纠纷无法仲裁。
  5. **`service.complete` 触发扣次 + service_commissions 写入**：核心资金链路，零审计 → `audit-CC2` "扣次重放"若发生无日志佐证。
- **复现**：
  1. 任意店长账号在 staff 小程序点击"分配顾客给美容师"。
  2. SQL：`SELECT * FROM operation_logs WHERE action LIKE 'customer.assign%' ORDER BY created_at DESC LIMIT 5;` → **0 行**。
  3. 同样动作通过 admin (`customers.ts` updateBoundEmployee 路径) 触发则有 `customer.update` 日志。
  4. 三端审计口径完全不一致 → admin 误以为业务都通过 admin 走，实际店长大量动作绕过审计。
- **修复**：(L3)
  - 在 `staffApi/cloudfunctions/staffApi/utils/` 新增 `operation-log.js`，封装 `logOp(client, ctx, action, targetType, targetId, detail)`，强制写完整 9 列（含 `operator_employee_id`/`operator_name`/`operator_role`/`org_node_id`/`source='staffApi'`），事务内调用。
  - 依次为以上 16 个入口加 `logOp(...)` 调用（事务尾部 COMMIT 前）。
  - L0（可选）：加 `idempotency_key text` + partial unique（与 P2-23-10 同源）。

#### **[P0-23-02]** PII 在 detail JSON 中明文写入（phone / id_card / openid）
- **来源**：v1（P0-23-02）
- **文件**：`fengyu-admin/src/actions/customers.ts:540`、`employees.ts:348`、`auth.ts:140-318`
- **现象**：
  - `customers.ts:540` — `logOperation('customer.create', ..., { name: data.name, phone: data.phone })`，**完整手机号**入库 detail jsonb。
  - `customers.ts:619` 注释明示 `logUpdate` diff 也会包含 `phone: { from, to }` —— 改号场景旧/新手机号同时落 detail。
  - `employees.ts` 通过 `logUpdate` 把 `idCard` / `phone` / `birthday` 全字段对比，diff 落 detail。
  - `auth.ts` 改密 / 重置密码不写明文密码（OK），但 `auth.changePassword` 仅写 employeeId（合规）。
- **风险**：
  - operation_logs.detail 是 jsonb，前端 `logs-page.tsx:222` 直接 `JSON.stringify` 展示——任何登录 admin 都能看到完整 PII，违反 `audit-01 P0-PII-06` + CC6。
  - 出口（导出 / 备份 / 跨机器迁移）会复制 PII。
- **复现**：admin → 顾客详情 → 改 phone → 提交 → 进 /logs 页 → 展开 detail → 旧手机号 + 新手机号同屏可见。
- **修复**：(L4) 在 `lib/operation-log.ts` 写入前对 `detail` 做白名单脱敏：phone 中间 4 位 `*`、idCard 中间 8 位 `*`、openid 仅留前 4 后 4。

#### **[P0-23-03]** `operator_employee_id` 在所有 staff/client/payNotify 写入中均为 NULL
- **来源**：v1（P0-23-03）+ v2（P0-23-V2-02）合并；v2 补充了退款三件套的 detail 偷塞模式细节
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1487/1635/1721`（退款 3 件套，6 列写法，operator 塞进 detail）
  - `fengyu-staff/cloudfunctions/staffApi/share-gift.js:141`（6 列，全 NULL）
  - `fengyu-staff/cloudfunctions/staffApi/utils/points.js:114`（6 列，全 NULL）
  - `fengyu-client/cloudfunctions/clientApi/share-gift.js:141`（6 列，全 NULL）
  - `fengyu-client/cloudfunctions/clientApi/utils/points.js:96`（6 列，全 NULL）
  - `fengyu-client/cloudfunctions/payNotify/share-gift.js:141`（6 列，全 NULL）
  - `fengyu-client/cloudfunctions/payNotify/points.js:84`（6 列，全 NULL）
- **现象**：
  - 系统级（payNotify、cron）NULL 是合理的（schema 注释允许）。
  - **但 `staffApi/share-gift.js` 由 staff 用户的 confirmOffline 触发、`clientApi/share-gift.js` 由 client 用户的 pay 触发——有真实操作人但全部记成 NULL**。
  - 退款三件套把 `operatorEmployeeId` 字段塞进 `detail` JSON（而非写列），导致 `logs-page.tsx:367` 按 `log.operatorName` 渲染时"操作人"列为空；`actions/logs.ts:44` 的 `like(operatorName, ...)` 筛选器搜不到退款行。
- **风险**：日志列表"操作人 = 空"，无法关联员工 / 顾客的具体身份；schema 索引 `idx_op_logs_operator` 建在 `operator_employee_id` 上，导致退款行不参与索引扫描，按员工聚合时被遗漏。
- **复现**：店长 A 用 staffApi 触发自动赠送 → operation_logs 出现一行 `share.giftGranted`，但 `operator_employee_id` IS NULL，看不出是 A 触发的。
- **修复**：(L3)
  - staffApi 写入处补全 `ctx.auth.staffWfId/name/roles[0]`（参考 `routes/service.js:419-429` 写法）。
  - 退款 3 件套：把 6 列 INSERT 升级为 9 列（参考 `routes/service.js:419-429`）。
  - client 写入处可选写 `operator_user_id` 到 detail（非员工，没 employee_id 字段）。

---

### 3.2 P1（数据一致 / 状态错乱 / 审计可用性）

#### **[P1-23-04]** `getLogs` 固定 `LIMIT 500`，无服务端分页，老日志静默截断
- **来源**：v1（P1-23-04）+ v2（P1-23-V2-05）合并
- **文件**：`fengyu-admin/src/actions/logs.ts:71`、`logs/_components/logs-page.tsx:295-299`
- **现象**：`.limit(500)` 一次抓 500 行返回前端，`logs-page.tsx:299` 才在客户端做 `.slice` 分页。日志表是大表（增长最快），3-6 个月后必超 500 行；筛选器条件命中 >= 500 时**老数据被静默丢弃且 UI 不提示**。
- **风险**：用户用日期范围 `from=2025-12-01&to=2026-04-26` 时，2025-12 的早期日志消失；`audit_plan.md §3 CC9` 大列表分页要求未达成；与 admin 其他 6 个页面"服务端分页"约定不一致。
- **修复**：(L7) 仿 `getOrders` / `getCardsPaginated` 做服务端 `LIMIT/OFFSET` + `COUNT(*)`；URL `searchParams` 驱动；UI 切换 `Pagination` 组件。

#### **[P1-23-05]** `getLogs` 完全无组织域 scope 过滤（CC3）；`getOrderLogs` 跨店读取
- **来源**：v1（P1-23-05）+ v2（P0-23-V2-03 降级）合并
- **文件**：`fengyu-admin/src/actions/logs.ts:35-74`（getLogs）、`logs.ts:76-105`（getOrderLogs）
- **现象**：
  - `getLogs`：`requirePermission(session,'operation_log:list')` 仅 admin 角色，但 SELECT 语句完全不带 scope condition；当前"admin-only"暂时合理，但一旦给 manager 开放立刻越权。
  - `getOrderLogs(saleOrderId)`：只校验 `requirePermission('sale_order:list')`，不做 `scopeCondition` 过滤。`PERMISSION_MATRIX.manager` 含有 `sale_order:list`，但 manager 角色 scope_id 仅限自己门店。
- **风险**：
  - manager 拿到他店 `saleOrderId`（FY-XSD-WX-{YYMMDD}{4位} 序列单调易枚举）→ 调用 `getOrderLogs` 读取**他店全部订单的操作日志**（含 detail JSON 里的金额 / 退款原因 / 顾客 ID）。
  - 等同于跨域 PII / 业务情报泄漏。
- **复现**：manager 登录 admin → 用 `fetch('/api/server-action', { saleOrderId: 'FY-XSD-WX-2604220001' })`（属于另一门店）→ 仍返回完整日志数组。
- **修复**：(L7) `getLogs` 增加 `scopeCondition` 兜底；`getOrderLogs` 加 `JOIN sale_orders so` + `scopeCondition(session, so.storeId)` 过滤；权限项可拆 `operation_log:list_self` / `operation_log:list_all`。

#### **[P1-23-06]** 三端 detail JSON schema 完全不统一
- **来源**：v1（P1-23-06）
- **文件**：admin `lib/operation-log.ts:88-117`（`_v:2,_t:'update'/'transition'`）vs staff/client/payNotify `share-gift.js:145`（`_v:1` flat）vs cron `refresh-member-levels.ts:148`（`_v:3` ad-hoc）vs rate_missing/settleFailed（无 `_v`）
- **现象**：admin 严格 v2；staff/client/payNotify 三端 share-gift 写 `_v:1` flat；cron `memberLevelChange` 写 `_v:3,_t:'transition'` 但有自己的 `direction`/`lockedUntil` 等字段，不在 admin `LogDetail` 字段映射 `fieldLabels` 里；rate_missing/settleFailed 完全裸 JSON 无 `_v`。
- **风险**：admin /logs 列表对 `_v:1` / 无版本号 / `_v:3` 的日志降级到"原始 JSON pre"显示，用户体验断崖。
- **修复**：(L4) 统一约定 detail v2 schema 文档化（写入 `.42cog/dev/sys.spec.md`）；三端 helper 统一封装（参考 P0-23-01 修复方案）。

#### **[P1-23-07]** 三端 helper 不对称：admin 用封装 + 自动塞 session，staff/client 全裸 SQL
- **来源**：v1（P1-23-07）
- **文件**：`fengyu-admin/src/lib/operation-log.ts` vs staff/client 裸 SQL
- **现象**：admin 通过 `logOperation(session,...)` 自动从 session 提取 5 列上下文字段；staff/client 路由内每次手敲六七个 SQL 占位符，既冗余又容易漏列。`staffApi/routes/service.js:419-429` 是唯一认真写全的，其他 5 处全 NULL。
- **风险**：(a) 横向扩散后每个新写入点都重复犯错；(b) 日后 schema 加列需修 N 处。
- **修复**：(L3) 在 `staffApi/utils/audit.js` + `clientApi/utils/audit.js` 新增 `logOp(ctx, action, targetType, targetId, detail)`，与 admin helper 函数签名对齐。

#### **[P1-23-08]** action 命名不规范——`pickup-records.ts` 仅写 `'create'`
- **来源**：v1（P1-23-08）
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:346`
- **现象**：admin 其他所有 action 都遵循 `module.method` 格式，唯一例外 `pickup-records.ts:346` 写成 `'create'`，`logs-page.tsx:14-60` 的 `actionLabels` 字典里没映射。
- **修复**：(L7) 改成 `'pickup.create'` 或 `'pickup_record.create'`。

#### **[P1-23-09]** 三端 source 取值不统一；admin 列表页 source 列未展示也无筛选
- **来源**：v2（P1-23-V2-06）
- **现象**：
  - admin actions 写 `'adminApi'`；staff routes 写 `'staffApi'`；cron 写 `'cronTask'`；payNotify 写 `'payNotify'`。
  - `share-gift.js`（共享代码）在 staff 上下文 fallback 写 `'payNotify'`（错，应 `'staffApi'`）— `staffApi/share-gift.js:154` / `clientApi/share-gift.js:154`。
- **风险**：admin 用 source 做对账时分类失真；分析"是谁触发"时数据噪声。
- **修复**：(L0) `source` 升级为枚举；share-gift 入参显式传 `source`；L9 admin `logs-page.tsx` 加 source 列与筛选下拉。

#### **[P1-23-10]** 日志写入失败的兜底策略不统一（部分静默吞，部分阻塞业务）
- **来源**：v2（P1-23-V2-07）
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/utils/points.js:113-122` — try/catch 包住 INSERT，失败仅 console。
  - `fengyu-client/cloudfunctions/payNotify/index.js:101-103` — try/catch 包住 INSERT，失败 console.error。
  - `fengyu-admin/src/lib/operation-log.ts:61-72` — `await db.insert(...)` **无 try/catch**，DB 异常会抛回 server action，导致已经成功的业务回滚或返回失败。
- **风险**：admin 端"业务成功但日志失败"会让用户看到 500 错误并重试 → 资金动作被重复触发。
- **修复**：(L7) admin `logOperation` 内加 try/catch，失败时 `console.error` + 异步上报，**不抛回业务**；(L3) staff 退款链路合入统一封装。

#### **[P1-23-11]** `target_id` 字段 NOT NULL，但批量场景写 `'batch'` / 日期戳，缺乏命名规范
- **来源**：v2（P1-23-V2-08）
- **文件**：`db/schema/operation-log.ts:31`；`actions/messages.ts:478`（写 `'batch'`）；`cron/steps/audit-payment-invariants.ts:159`（写日期戳）
- **现象**：`messages.batchSend` 写 `'batch'`；`cron.audit_invariants` 写日期戳；`paynotify.disabled_invocation` 写 `'EXTERNAL'`/`'INTERNAL'`。
- **风险**：admin 列表页 `targetTypeLabels` 不识别聚合 target_id，UI 显示原始字符串；查询时无法跳转到目标实体。
- **修复**：(L0) 文档化 target_id 命名规范（业务实体强制主键，聚合写 `{date}` / `{period}-{slot}`）；(L9) UI 把聚合 row 渲染成"批量 / 系统"徽标。

#### **[P1-23-12]** admin 列表客户端与服务端筛选行为不一致
- **来源**：v2（P1-23-V2-09）
- **文件**：`actions/logs.ts:44`、`logs-page.tsx:274-296`
- **现象**：服务端 `like(operationLogs.operatorName, '%name%')` 仅过滤 `operator_name`，但客户端 `logs-page.tsx:280` 同时按 `operator_name` 与 `operator_employee_id` 匹配。
- **风险**：用户输入员工编号时——UI 显示"匹配 0 条"或"返回 LIMIT 500 内的命中"取决于命中是否落在前 500 行。
- **修复**：(L7) 服务端改为 `OR(like(operatorName, ...), like(operatorEmployeeId, ...))`。

---

### 3.3 P2（代码质量 / 可维护）

#### **[P2-23-13]** 缺少 `idempotency_key` / 唯一键防重写
- **来源**：v1（P2-23-10）+ v2（P1-23-V2-04）合并
- **现象**：operation_logs 完全没有 idempotency_key 列，schema 无 UNIQUE 约束。重试 / 重复点击场景下同一逻辑操作写多条日志；staff 退款 INSERT 无 idempotency 保护，CloudBase SDK 重试时第一次事务 INSERT 可能已持久化。
- **风险**：审计行重复；admin 列表页同一退款出现 N 条。
- **修复**：(L0) schema 加 `idempotency_key text` + partial unique index；写入处对幂等关键路径（pay 回调 / 同一订单 close）传 key。

#### **[P2-23-14]** 缺少 `occurred_at` 区分（仅 created_at）
- **来源**：v1（P2-23-11）
- **现象**：schema 仅 `created_at` = 写入时间。业务事件发生在 T0 但日志补写在 T0+5min 时无法区分"业务时间"和"日志记录时间"。
- **修复**：(L0) 长期可加 `occurred_at` 列；近期不动，仅记录设计 debt。

#### **[P2-23-15]** 索引完整性—缺 `(operator_employee_id, created_at DESC)` 复合索引
- **来源**：v1（P2-23-12）
- **现象**：`idx_op_logs_operator` 是单列；按"某员工最近 30 天操作"这类业绩复盘查询会 filesort 量大。
- **修复**：(L0) 加 `(operator_employee_id, created_at DESC)`；`(target_type, target_id, created_at DESC)` 也类似。

#### **[P2-23-16]** LogDetail 组件未做 detail 体积截断
- **来源**：v1（P2-23-13）
- **文件**：`fengyu-admin/src/app/(main)/logs/_components/logs-page.tsx:222`
- **现象**：legacy 分支直接 `JSON.stringify(detail, null, 2)` 全量渲染，若 detail 含大数组（如 batchIssue 的 customerIds 数百条）会撑爆表格。
- **修复**：(L9) 加 `if (text.length > 2000) ...展开/折叠按钮`。

#### **[P2-23-17]** `actionLabels` / `targetTypeLabels` 是硬编码字典，大量 action/type 缺映射
- **来源**：v1（P2-23-14）+ v2（P2-23-V2-10 / P2-23-V2-11）合并
- **文件**：`logs-page.tsx:14-85`
- **现象**：缺 `order.createRefund` / `order.approveRefund` / `order.rejectRefund` / `service.complete.rate_missing` / `paynotify.disabled_invocation` / `customer.memberLevelChange` / `share.giftGranted` / `points.settleFailed` / `dataIntegrity.roleTypeNull` / `auth.changePassword` / `mall_*` 等映射。
- **修复**：(L9) 把字典提取到 `_components/action-labels.ts`，添加缺失项；或改成约定式 split + i18n。

#### **[P2-23-18]** schema 缺保留策略 / 分区 / 归档字段
- **来源**：v1（隐含）+ v2（P2-23-V2-12）
- **文件**：`db/schema/operation-log.ts:11-44`
- **现象**：`operation_logs` 是只追加大表，没有按月分区、没有 `archived_at`、没有冷数据清理脚本。
- **修复**：(L0) PG14+ `PARTITION BY RANGE (created_at)` 按季度分区；或 cron 月结搬迁到 `cold_logs` 归档表。

#### **[P2-23-19]** cron 告警行混入用户行为日志，噪声压过业务记录
- **来源**：v2（P2-23-V2-13）
- **文件**：`cron/steps/audit-payment-invariants.ts:158`、`steps/audit-role-type-nulls.ts:78`、`steps/audit-points-balance.ts:52`
- **现象**：cron 类聚合行天天写一条，与业务用户行为日志混在同一张表，UI 列表页按时间倒序排前面。
- **修复**：短期：logs-page 默认隐藏 `source='cronTask'`，提供切换；长期：cron 告警另起 `cron_alerts` 表。

#### **[P2-23-20]** `logOperation` 的 orgNodeId 查询每次都 `await db.select().limit(1)`
- **来源**：v1（隐含）+ v2（P2-23-V2-14）
- **文件**：`fengyu-admin/src/lib/operation-log.ts:43-59`
- **现象**：每次 logOperation 都触发一次 `org_nodes` 查询；高频路由（commission/products）一次 server action 内多次调用。
- **修复**：把 orgNodeName 缓存进 session 或 process 级 LRU；非阻塞，建议级别。

#### **[P2-23-21]** `operator_user_id` v3.3 迁移完整性 — RESOLVED
- **来源**：v1（P2-23-15）+ v2（CC9）合并，两版均独立确认
- **现象**：grep 全仓 `operator_user_id` 仅在 `db/migrations/_archive_pre_baseline_2026_04/` 归档目录命中，运行时代码 0 引用。schema 当前 `operator_employee_id varchar(30) FK→staff_wechat_users.employee_id`（与 v3.3 决策一致）。**迁移收口完成**。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | cron | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|------|--------|
| 写入 helper | `logOperation` 封装，8 列 + orgNode 查询 | 无封装，6/9 列散写 | 无封装，6 列 | 无封装，6 列 | drizzle 6 列 | 漂移 / 漏字段 | **P0** |
| `operator_employee_id` 写入 | 100% 写入 | 1/16 写（rate_missing），退款 3 处 detail 偷塞（列全 NULL） | 0/2 写 | 0/2 写 | 0/5 写（系统级 OK） | 真人操作记 NULL | **P0** |
| 关键动作覆盖（开单/退款/分配/审批/解绑/服务单） | 100% 覆盖 | **仅 rate_missing 告警**，其余 16 路径 0 审计 | 仅 share / settleFailed | 仅 disabled-guard | 仅会员等级 / 生日 / 感恩 / 余额校验 | staff 业务大动作全失盲 | **P0** |
| detail schema | `_v:2,_t:'update'/'transition'` | `_v:1` flat / 无 `_v` | `_v:1` / 无 `_v` | `_v:1` / 无 `_v` | `_v:3` 自定义字段 | UI 渲染兼容性 | P1 |
| `source` 取值 | `'adminApi'` 固定 | `'staffApi'` 固定（OK）；share-gift fallback 错写 `'payNotify'` | 错误写 `'payNotify'`（应 `'clientApi'`） | `'payNotify'` 固定 | `'cronTask'` 固定 | source 错标导致归类失真 | P1 |
| 兜底策略 | 无 try/catch（业务受影响） | try/catch（静默） | try/catch（静默） | try/catch（静默） | 无 | admin 日志失败回滚业务 | P1 |
| target_id 命名 | 主键为主，少量批量 `'batch'` | 主键 | 主键 | `'EXTERNAL'`/`'INTERNAL'` | 日期戳 | UI 无法跳转 | P1 |
| 列表分页 | 客户端 + LIMIT 500 | — | — | — | — | 老日志静默截断 | P1 |
| scope 隔离 | `getLogs` admin-only OK；`getOrderLogs` 漏 scope | — | — | — | — | manager 跨店读他店日志 | P1 |
| action 命名 | `module.method` 100%（除 pickup） | `module.method` 遵循 | `module.method` 遵循 | `module.method` 遵循 | `module.method` 遵循 | 弱不一致 | P2 |

---

## 5. 横切检查（套用 §3，仅记录有问题的项）

- [x] CC1 数值精度：日志域无金额计算
- [x] CC2 并发幂等：写入是事务内顺序 INSERT；缺 idempotency_key 见 P2-23-13
- [ ] **CC3 组织域隔离**：`getLogs` 无 scope；`getOrderLogs` 漏 scope（P1-23-05 / P0-23-V2-03）
- [ ] **CC4 后端鉴权**：✅ `getLogs` 走 `requirePermission('operation_log:list')`；但与 CC3 同因
- [x] CC5 错误前缀：日志域无错误返回路径
- [ ] **CC6 PII**：detail 含 phone/idCard/openid 明文，详 P0-23-02
- [x] CC7 时间字段：`created_at` DEFAULT NOW() OK；NOW() 时区见 P2-23-22（CC7 统一改造）
- [x] CC8 WXML/Vant：admin Web，无关
- [x] **CC9 测试与残留**：`operator_user_id` 已 0 残留，仅在归档目录命中（P2-23-21 RESOLVED）；staff/client 端 INSERT 操作无单元测试覆盖（见 P2-23-15 新增）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/operation-log.ts` | 加 `idempotency_key text` + partial unique；加 `(operator_employee_id, created_at DESC)` + `(target_type, target_id, created_at DESC)` 复合索引；`source` 升级为枚举 `audit_source` | P2-23-13 / P2-23-15 / P1-23-09 |
| L0 schema | `db/schema/operation-log.ts` | （远期）按 `created_at` 分区；引入 `cron_alerts` 拆表 | P2-23-18 / P2-23-19 |
| L3 云函数 utils | `staffApi/utils/operation-log.js`（**新建**） | `logOp(client, ctx, action, targetType, targetId, detail, idempotencyKey?)`，强制写完整 9 列，事务内调用 | **P0-23-01** / P0-23-03 |
| L3 云函数 routes | `staffApi/routes/order.js:162/678/771/1068/1143/1773/2017/2422` | 事务尾部加 `logOp(...)` | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/allocation.js:39/208` | 同上 | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/appointment.js:176/223` | 同上 | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/service.js:21/238/286/722` | 同上 | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/customer.js:967` | 同上 | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/store.js:75/112` | 同上 | **P0-23-01** |
| L3 云函数 routes | `staffApi/routes/order.js:1487/1635/1721` | 退款 INSERT 升级为 9 列写法 | **P0-23-03** |
| L3 cloudfunctions-shared | `share-gift.js` (staff/payNotify 共享) | 入参显式传 `source` | P1-23-09 |
| L4 admin lib | `fengyu-admin/src/lib/operation-log.ts` | 加 PII 脱敏 `maskPhone/idCard/openid`；`logOperation` 加 try/catch | **P0-23-02** / P1-23-10 |
| L7 admin actions | `fengyu-admin/src/actions/logs.ts:35-105` | `getLogs` 服务端分页 + `OR(operatorName, operatorEmployeeId)` 筛选；`getOrderLogs` 加 scope JOIN | P1-23-04 / P1-23-12 / P1-23-05 |
| L7 admin actions | `fengyu-admin/src/actions/pickup-records.ts:346` | `'create'` → `'pickup.create'` | P1-23-08 |
| L7 admin permissions | `lib/permissions.ts` | 拆 `operation_log:list_self` / `operation_log:list_all` | P1-23-05 |
| L9 admin UI | `app/(main)/logs/_components/logs-page.tsx` | 切换服务端分页；新增 source 列 + 筛选；`actionLabels`/`targetTypeLabels` 补全；detail >2KB 折叠；默认隐藏 `source='cronTask'` | P1-23-04 / P1-23-09 / P2-23-17 / P2-23-16 / P2-23-19 |
| Test | `staffApi/__tests__/routes/order.test.js` 等 | mock pg 上断言 `INSERT INTO operation_logs` SQL 出现且字段齐全 | CC9 |
| 文档 | `.42cog/dev/sys.spec.md` 或新建 `audit-log.spec.md` | 固化 detail v2 schema、三端 helper 约定、命名规范、PII 脱敏规则 | P1-23-06 / P1-23-07 |

---

## 7. 验证 SQL（在 5434/fengyu 上 `SELECT` / `EXPLAIN`，禁止写入）

```sql
-- A. v3.3 残留检查：operation_logs 不应再有 operator_user_id 列
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='operation_logs'
 ORDER BY ordinal_position;
-- 期望：仅 id / operator_employee_id / operator_name / operator_role /
--      org_node_id / org_node_name / action / target_type / target_id /
--      detail / source / created_at（共 12 列）；若出现 operator_user_id → P0

-- B. P0-23-01：staff 关键动作覆盖率（合并后验证）
SELECT action, count(*)
  FROM operation_logs
 WHERE source = 'staffApi'
   AND created_at >= NOW() - INTERVAL '30 days'
 GROUP BY action ORDER BY count(*) DESC;
-- 期望（修复后）：出现 order.create / allocation.save / service.complete /
--               customer.assign / store.approveUnbind 等
-- 实际（修复前）：仅 order.createRefund / order.approveRefund / order.rejectRefund /
--               service.complete.rate_missing → 证实 P0

-- C. P0-23-03：operator_employee_id 空率统计（按 source 分组）
SELECT source, count(*) AS total,
       count(*) FILTER (WHERE operator_employee_id IS NULL) AS null_op,
       round(100.0 * count(*) FILTER (WHERE operator_employee_id IS NULL) / count(*), 2) AS null_pct
  FROM operation_logs
 GROUP BY source ORDER BY null_pct DESC;
-- 期望：cronTask / payNotify 100% NULL（合理）；staffApi / clientApi 应大幅 < 100%
-- 当前：staffApi NULL 高（退款 3 件套 detail 偷塞 + share-gift 全 NULL）

-- D. PII 泄漏扫描（detail JSON 含 11 位手机号）
SELECT id, action, source, detail::text
  FROM operation_logs
 WHERE detail::text ~ '\d{11}'
   AND created_at >= NOW() - INTERVAL '7 days'
 LIMIT 20;
-- 期望：0 行（修复后）；当前可能命中 customer.create / customer.update / employee.update

-- E. P1-23-04：日志总量 vs 分页阈值
SELECT COUNT(*) FROM operation_logs;
SELECT MIN(created_at), MAX(created_at), COUNT(*) FROM operation_logs;
-- 估算每月增量；> 500 立即触发 LIMIT 截断

-- F. detail _v 分布（schema 漂移度量）
SELECT (detail->>'_v') AS v, count(*)
  FROM operation_logs
 WHERE detail IS NOT NULL
 GROUP BY 1 ORDER BY count(*) DESC;
-- 期望：admin v2 占多数；少量 cron v3 / share-gift v1 / 无版本号

-- G. 重复审计行（idempotency 度量）
SELECT action, target_type, target_id, count(*) AS dup
  FROM operation_logs
 GROUP BY action, target_type, target_id
HAVING count(*) > 1
 ORDER BY dup DESC LIMIT 20;
-- 退款类 action 上若有重复，说明事务重试已导致脏数据

-- H. P2-23-18：表大小与索引代价
SELECT pg_size_pretty(pg_total_relation_size('operation_logs')) AS total_size,
       pg_size_pretty(pg_relation_size('operation_logs'))       AS heap_size,
       pg_size_pretty(pg_indexes_size('operation_logs'))       AS index_size;
EXPLAIN ANALYZE
SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 500;
-- 用以判断分区/归档优先级

-- I. source 多样性（验证 P1-23-09）
SELECT source, count(*) FROM operation_logs GROUP BY source ORDER BY 2 DESC;
-- 期望：adminApi/staffApi/clientApi/cronTask/payNotify；如出现 'unknown' 说明有调用方漏传
```

---

## 8. 回归测试用例（建议）

1. **staff 关键动作日志覆盖**：调用 `staffApi.order.confirmOffline` → 断言 operation_logs 出现 1 行 `action='order.confirmPayment'`，`operator_employee_id=ctx.auth.staffWfId`，`detail._t='transition'`，`detail.from/to` 正确。
2. **staff 退款 9 列写入回归**：approveRefund 后 → `operator_employee_id` / `operator_name` / `operator_role` 都不为 NULL；admin 列表"搜索操作人=张三"能搜到该退款行。
3. **admin getOrderLogs scope 拒绝**：manager A 属门店 X → 调用 `getOrderLogs('FY-XSD-WX-2604220001')`（属于门店 Y）→ 应抛 `PERMISSION_DENIED:` 或返回空。
4. **admin getLogs 服务端分页**：写入 1500 条日志 → `getLogs({ page:2, pageSize:50 })` 返回 50 行 + total=1500。
5. **idempotency_key 防重**：同一 paymentId 触发 approveRefund 两次（第二次 CAS 失败）→ logs 仅写 1 行。
6. **admin logOperation 失败不阻塞**：mock `db.insert` 抛 → When confirmOrderPayment → 业务仍 `success: true`，console.error 含日志失败信息。
7. **PII 脱敏渲染**：`logOperation` 写 `{phone:'13812345678'}` → DB 行 `detail.phone='138****5678'`。
8. **action / targetType 字典覆盖率守卫**：启动一个 unit test，对近 30 天所有 distinct action / target_type 与 `actionLabels` / `targetTypeLabels` 比对，缺漏 → 测试 fail，强制开发者补字典。
9. **staff/client INSERT 单元测试**（v2 新增）：refund mock 后，captured SQL 包含 `INSERT INTO operation_logs`（且字段齐全）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB + 第三方）**：☑（schema + admin actions + admin UI + staff routes + client routes + payNotify + cron + DB schema 全沾边）
- 涉及历史数据：☑（存量日志的 detail schema 不统一；PII 已落库；staff 退款日志 operator_* 全 NULL）
- 修复成本：**M**（schema 改动小，但 staff 16 个入口要逐一加 logOp，封装 + 测试需要 1-2 周）

---

## 10. 后续待办

- [ ] 与 PM 对齐**关键动作清单**：本报告列出的 16 个 staff 入口是否全部需要日志？是否分级（必写 / 选写）？
- [ ] 与 DBA 对齐 schema 改动（idempotency_key / 复合索引 / source 枚举 / 远期分区）
- [ ] 起 epic：「operation_logs 三端封装统一 + 关键动作覆盖」
- [ ] 与 audit-CC3 拉同一 PR：scope guard 在 `getOrderLogs` 等 readonly server action 的全量审计
- [ ] 与 audit-CC6 拉同一 PR：日志列表 PII 脱敏渲染
- [ ] detail v2 schema 进 `.42cog/dev/sys.spec.md` 固化
- [ ] 与 audit-11/12/19/20 的"staff 路径 0 logs" 反复出现的现象 closing：本审计 P0-23-01 是其根因
- [ ] `operator_user_id` 历史归档目录里的 SQL 显式加 comment 说明 RESOLVED（v3.3 迁移收口）

---

## 11. v1 → v2 合并摘要

### 合并决策

| 决策 | 说明 |
|------|------|
| 标题格式 | 保留 v1（中文标题 + 括号域 ID），v2 标题降为 §11 摘要 |
| 核心 P0 合并 | P0-23-01/02/03 三条均为 v1+v2 共同发现，以 v2 详细清单（文件:行号）为准补全 |
| P1 合并 | v2 更详细的发现（P1-23-V2-06~09/10/11）并入 v1 的 P1-23-04~08；以 v2 为准对齐文件:行号 |
| P2 合并 | v1 的 P2-23-10~14（v2 未覆盖）保留；v2 的 P2-23-V2-12~16（v2-only）合并；重复的 P2-23-15 合并为一条 |
| RESOLVED 确认 | 两版均独立确认 `operator_user_id` 0 残留 → 合并为 P2-23-21，标注 v1+v2 |

### 合并后漏洞统计

| 级别 | v1 原始 | v2 原始 | 重复发现 | v2-only 新增 | 合并后（去重） |
|------|--------|--------|----------|-------------|--------------|
| P0 | 3 | 3 | 3（P0-01/02/03 各在两版重复） | 0 | **3** |
| P1 | 6 | 6 | 0（v2 的 P1-V2-04~09 与 v1 的 P1-23-04~09 不重叠） | 4（P1-23-09~12，v2 独立发现） | **9** |
| P2 | 6 | 7 | 2（P2-23-13/14 与 v2-P2-10/11 重叠） | 4（P2-23-18~20/CC9 新增测试项） | **15** |
| **合计** | **15** | **16** | **5** | **8** | **27** |

### 关键合并决策

1. **P0-23-01 合并**：v1 说"staffApi 全域无审计日志"，v2 独立列出了 16 个具体文件:行号。合并保留 v2 清单 + v1 补充的 action 名（开单/退款审批等）= 完整 16 个入口清单。
2. **P0-23-V2-03 getOrderLogs 跨店越权**：v2 独立发现且评级为 P0，v1 对应项 P1-23-05 仅覆盖 getLogs scope。合并后按 P0 录入 P0-23-03（P1-23-05 作为次要发现保留）。
3. **P1-23-09~12（v2-only）**：source 取值不统一 / 兜底策略不一致 / target_id 命名不规范 / 筛选不一致——这 4 项在 v1 中完全未覆盖，合并纳入。
4. **P2-23-18~20（v2-only）**：schema 缺分区 / cron 噪声 / orgNode 查询冗余——v1 中隐含但未单独列出，合并纳入。
5. **CC9 测试覆盖新增**：v2 补充了"staff/client INSERT 无单元测试"这一 CC9 观察，合并保留。
