# 13 — `operation-log` 模块

**Schema 文件**：`db/schema/operation-log.ts`
**涉及 PG 表**：`operation_logs`
**WorkFine 源表**：**无**（运行时审计日志，与 WorkFine 无任何对应）
**主要写入入口**：
- `fengyu-admin/src/lib/operation-log.ts:L31-73` — `logOperation(session, action, targetType, targetId, detail?)` 通用包装；同文件 `logUpdate` / `logTransition` 复用
- `fengyu-admin/src/actions/*.ts` — 21 个 action 模块通过 `logOperation` / `logUpdate` / `logTransition` 共 ≥ 104 处调用（含 orders / employees / customers / coupons / settings / commission / org / permissions / allocations / appointments / services / stores / products / messages / store-unbind / refunds / pickup-records / positions / skill-tags / service-commissions / auth）
- `fengyu-admin/src/cron/steps/*.ts` — 5 个 STEP（refresh-member-levels × 3 段、grant-birthday-benefits、grant-thanksgiving-benefits、audit-points-balance、audit-role-type-nulls）原生 SQL `INSERT INTO operation_logs ... source='cronTask'`
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:L419` — `service.complete.rate_missing` 告警写入（提成矩阵缺失时不阻塞主事务）
- `fengyu-staff/cloudfunctions/staffApi/utils/points.js:L114` — `settlePointsSafe` 把 settle 失败隔离成 `points.settleFailed` 行
- `fengyu-staff/cloudfunctions/staffApi/share-gift.js:L141` — `share.giftGranted` 审计行
- `fengyu-client/cloudfunctions/clientApi/utils/points.js:L96` — clientApi 端 `points.settleFailed` 副本
- `fengyu-client/cloudfunctions/clientApi/share-gift.js:L141` — clientApi 端 `share.giftGranted` 副本
- `fengyu-client/cloudfunctions/payNotify/points.js:L84` — payNotify webhook 端 `points.settleFailed` 副本
- `fengyu-client/cloudfunctions/payNotify/share-gift.js:L141` — payNotify webhook 端 `share.giftGranted` 副本
- `fengyu-admin/src/db/seed.ts:L308-317, L405` — 7 行 demo 种子（含 1 行 source='adminApi' 但实际场景虚构）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0032_drop_member_levels_and_relax_oplog.sql:L9-10` — DROP NOT NULL 约束（非数据写入），让 cronTask / payNotify 系统级写入合法

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 维度 | 值 |
|------|---|
| 总行数 | **295** |
| 时间跨度 | 2025-02-01 → 2026-04-25（最早是 seed 虚构时间戳） |
| source 分布 | adminApi=290 / staffApi=4 / cronTask=1 |
| 列填充率 | operator_employee_id 294/295（仅 1 行 NULL，cronTask 系统级）；operator_name/role/org_node_id/org_node_name 同步 294/295；detail 266/295（29 行 detail=NULL）；source 295/295 |
| operator_role 分布 | manager=220 / admin=71 / staff=3 / NULL=1 |
| Top 5 action | mall_product_sku.create=35 / sku.update=27 / order.create=22 / order.confirmPayment=17 / permission.assign=15 |
| Top 5 target_type | mall_product_sku=54 / sale_order=50 / product_sku=33 / permission_role=22 / product=18 |

> **关键观察**：seed.ts 7 行（id=1..7）是 2025-04 / 2025-06 / 2026-03 demo 时间戳，其中 4 行打了 `source='staffApi'` 但**不是**真实 staffApi 调用产物——本应运行时由 staffApi 写入，目前只有 seed 这 4 行。`source='cronTask'` 仅 1 行（2026-04-25 由 refresh-member-levels.ts 真实写入）；其余 286 行全部由 admin actions 经 `logOperation()` 写入。

---

## 表 1：`operation_logs`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial | 新系统独立 | DB autoincrement | schema:L14 | |
| operator_employee_id | varchar(30) | 新系统独立 | `session.employeeId`（admin actions / staffApi `ctx.auth.staffWfId` / clientApi `ctx.auth.staffWfId` 或 NULL）；cronTask / payNotify webhook 行 NULL（migration 0032 放宽 NOT NULL 约束） | `lib/operation-log.ts:L62` + `service.js:L423` + cron steps 不带此列 | FK → `staff_wechat_users.employee_id`；PG 现状 294/295 非 NULL（仅 cronTask 1 行 NULL） |
| operator_name | text | 新系统独立 | `session.name` / `ctx.auth.name`；cronTask 行 NULL | `lib/operation-log.ts:L63` + `service.js:L424` | 295 行中 1 行 NULL（cronTask） |
| operator_role | text | 新系统独立 | `session.roles[0]?.role`（admin 优先级 hr/finance/manager/...）/ `ctx.auth.roles[0]`；cronTask NULL | `lib/operation-log.ts:L64` + `service.js:L425` | manager=220 / admin=71 / staff=3 / NULL=1 |
| org_node_id | text | 新系统独立 | admin：`logOperation` 内部 SELECT `orgNodes WHERE id = primaryRole.scopeId` 反查（找不到则 NULL）；cloudfunctions 全部场景**不写**此列（staffApi service / share-gift / points.settleFailed 写时只有 `operator_employee_id/role`，不含 org_node_id） | `lib/operation-log.ts:L40-58` | FK → `org_nodes.id`；PG 现状 294/295 非 NULL（来源全部是 admin 反查；cron / staffApi 直接 INSERT 路径全部 NULL，但 seed 把它写满了所以表面看不出） |
| org_node_name | text | 新系统独立 | 同 org_node_id：admin 反查得到的 `name`，cloudfunctions 不写 | `lib/operation-log.ts:L48-55` | 与 org_node_id 同步填入 |
| action | text NOT NULL | 新系统独立 | 调用方传入的字符串字面值，规则 `'<module>.<method>'` 与云函数路由对齐（如 `order.create`、`appointment.confirm`、`points.balanceMismatch`） | 全部入口 | 现状 30+ 不同 action 值，无统一枚举/常量定义 |
| target_type | text NOT NULL | 新系统独立 | 调用方字面值（`sale_order` / `customer` / `coupon_template` / `permission_role` / `service_order` / `mall_product_sku` / `product_sku` / `org_node` / `system_config` / `table` / ...） | 全部入口 | 命名风格不统一：snake_case 占多数，`table`（cron auditRoleTypeNulls 用表名作 target_type）属特例 |
| target_id | text NOT NULL | 新系统独立 | 业务主键的字符串化（如 `sale_order_id` / `service_order_id` / `user_id` / `id::text`） | 全部入口 | cron audit-role-type-nulls 用表名（如 `'sale_allocations'`）作 target_id，非主键 |
| detail | jsonb | 新系统独立 | 三种结构：① 简单对象 `{...}`；② `logUpdate` 派生 `{ _v: 2, _t: 'update', changes: { field: { from, to } } }`（`computeChanges`）；③ `logTransition` 派生 `{ _v: 2, _t: 'transition', from, to, context? }`；④ cron member-level 用 `_v: 3, _t: 'transition'`（注 V3 与 lib 默认 V2 不一致） | `lib/operation-log.ts:L78-118` + `refresh-member-levels.ts:L150` | PG 现状 266/295 非 NULL（29 行 NULL）；schema versioning 跨 V1/V2/V3 三套，无升级策略 |
| source | text | 新系统独立 | 字面值之一：`'adminApi'`（admin actions 默认）/ `'staffApi'`（staffApi 路由）/ `'clientApi'`（clientApi 路由）/ `'payNotify'`（payNotify webhook）/ `'cronTask'`（5 个 cron STEP） | `lib/operation-log.ts:L71` + 各运行时入口 | schema 注释说"staffApi / clientApi / adminApi"，但实际还有 cronTask / payNotify 两个值 |
| created_at | timestamp NOT NULL | 新系统独立 | `defaultNow()` / `NOW()` | schema:L36 | |

**全表零 WorkFine 直拷或派生**（5 选 1：100% **新系统独立**）。

### 已被脚本读但未对接到 PG 的 WorkFine 列

**不适用** — 本模块的设计前提就是"PG 运行时审计日志"，无任何 WorkFine 源表对应。

**WorkFine 端确实存在的"日志"实体**（仅供参考，**不要导入**）：
| WorkFine 表 | 行数 | 说明 |
|--------------|-----|------|
| `tb_sys_log` | 2,088,126 | WorkFine 平台层日志（创建/修改/删除表单、用户登入登出、IP），是 WorkFine 引擎自身的审计数据，与业务语义无关 |
| `tb_sys_workflow_task_log` | 11,079 | WorkFine 工作流任务流转日志（审批流程节点），凤御项目的业务流程未在 WorkFine 工作流中建模 |
| `tb_sys_qrtz_log` | — | Quartz 调度器日志 |
| `tb_sys_error_log` | — | 平台报错日志 |
| `tb_sys_dataspec_serial_log` | — | 数据规格序列号日志 |

> 这些都是 WorkFine 平台基础设施层日志，不是凤御业务方写过的"操作记录"。最终迁移**不应**把 `tb_sys_log` 导入 `operation_logs`：列语义完全不同（log_who 用 WorkFine 内部用户 int id，无法映射到 staff_wechat_users.employee_id；log_what 是"创建表单"等 WorkFine 控件级动作，与 PG `<module>.<method>` 业务 action 不同语义层）。

---

## 关键决策摘要

1. **100% 新系统独立**：`operation_logs` 是 PG 运行时审计表，不存在"WorkFine 历史日志迁移"。最终迁移脚本对本表**不写任何行**，留待运行时业务自然累积。
2. **三类 INSERT 入口**（共 12 个调用点 + 21 个 admin action 模块）：
   - **admin actions**（`logOperation` 包装，21 模块、≥ 104 处调用）— 占 290/295 行
   - **cron STEP**（refresh-member-levels × 3 段、生日/感恩节权益、积分/role-type 审计）— 仅 1 行实际产出（2026-04-25 起）
   - **小程序云函数（staffApi / clientApi / payNotify）副本** — share-gift 三副本、points.settleFailed 三副本、staffApi service.complete.rate_missing 一处 — **目前 0 行实际产出**（PG 5434 source='staffApi/clientApi/payNotify' 仅 4 行，全部是 seed.ts demo）
3. **detail JSON schema 版本不一致**：
   - V1：`{...}` 任意结构（早期 `logOperation` 直接传入；占多数）
   - V2：`{ _v: 2, _t: 'update' \| 'transition', changes/from/to/... }`（`logUpdate` / `logTransition` 包装）
   - V3：`{ _v: 3, _t: 'transition', from, to, context }`（仅 cron `customer.memberLevelChange` 一种 action）
   - 没有迁移工具或读取兜底，下游消费方需要 case-by-case 处理 `_v` 字段（admin `logs.ts` 读取时直接返回 jsonb 给前端，不解析）
4. **org_node_id / org_node_name 来源不对称**：
   - admin path：`lib/operation-log.ts` 主动 SELECT org_nodes 反查，正常填入
   - cloudfunctions path（staffApi service.js / share-gift / points / payNotify）：**直接 INSERT 不带这两列** → cron / share-gift / settleFailed 行 org_node_id/name 全部 NULL（架构性缺失，不是 bug）
   - 当前 PG 看似填充率 294/295 是因为 seed 把 org 字段写满了，**真实运行时累积起来填充率会显著下降**
5. **operator_employee_id 是软引用**：FK → staff_wechat_users.employee_id，但 cronTask 系统级写入是 NULL。migration 0032 已 DROP NOT NULL；schema 注释也明确"系统级操作如 cronTask、payNotify 可为 null"。
6. **action / target_type 没有枚举常量**：全部是字符串字面值散落在调用点，命名规则纸面约定为 `<module>.<method>`，实际形成的命名空间已超过 50 种，admin actions/logs.ts 只能做模糊前缀匹配（`like ${module}.%`）。
7. **clientApi / staffApi / payNotify 三副本同步问题**：share-gift.js / points.js 在三处 cloudfunctions 各有一份完全相同的 INSERT 语句。任何字段调整需三处同步改。详见 ticket `notes/tickets/2026-04-25-crontask-data-integrity-monitor.md`。
8. **seed 演示数据混淆 source**：seed.ts 7 行中有 4 行 `source='staffApi'`、1 行 `source='manager' role / staffApi`，但都是 admin 端 seed 脚本写入。审计 SQL 用 source 区分入口时需排除 id ≤ 7 的 seed 行。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- 全表"无 WorkFine 源"——这是设计上的"未覆盖"而不是遗漏。最终迁移脚本**应跳过此表**。
- `org_node_id` / `org_node_name` 在 cloudfunctions（staffApi / clientApi / payNotify / cron）写入路径上**架构性缺失**：当前 7 行 seed + 1 行 cron 看似 294/295 填充率，但运行时累积后大量 cron / share-gift / settleFailed 行会是 NULL；如果 admin 后台日志页对 org 列做硬过滤（如 `WHERE org_node_id = $1`），cron 写入的告警类日志会被遗漏。
- `detail._v` schema versioning 不统一（V1 / V2 / V3 共存且无 migration），下游展示需要 case-by-case 解析。
- `action` / `target_type` 没有枚举常量约束，新动作只靠 grep + 命名约定保证一致，新人 onboarding 风险点。
- `target_id` 类型不一致：业务表用主键字符串（订单号/sku id 等），cron `dataIntegrity.roleTypeNull` 把表名（`'sale_allocations'`）当 target_id，导致 admin 后台按 (target_type, target_id) 分组 SQL 会出现"伪同实体"聚类。
- staffApi / clientApi / payNotify 三副本：share-gift.js + points.js 同样代码三份维护，存在长期 drift 风险（已记录在跨模块审计 ticket）。

---

## Review 报告（2026-04-26）

**复核者**：fresh agent（独立调研后比对）
**Verdict**: **accept**

### 一致性概览
- **一致项**：PG 现状量化指标全部精准命中（行数 295 / source 290/4/1 / operator_role 220/71/3/1 / 列填充率 / Top-5 action / Top-5 target_type / 时间跨度）；7 个 cloudfunctions INSERT 行号全部精确（service.js:419 / staffApi-points.js:114 / staffApi-share-gift.js:141 / clientApi-points.js:96 / clientApi-share-gift.js:141 / payNotify-points.js:84 / payNotify-share-gift.js:141）；21 个 admin action 模块 + ≥104 处 logger 调用与 grep 计数一致；seed.ts 7 行 id=1..7 + 其中 4 行 source='staffApi' 但实为 seed 这一架构性提示完全正确；cron 5 STEP 拆分正确（refresh-member-levels 3 段 + birthday + thanksgiving + audit-points-balance + audit-role-type-nulls）；100% "新系统独立、无 WorkFine 源" 设计前提成立；migration 0032 DROP NOT NULL 引用准确；audit-role-type-nulls 用 target_type='table'/target_id=表名的特殊命名约定捕捉到位。
- **不一致项**：3 处轻微偏差（详见下文「过时事实」+「数据低估」）。

### 偏差明细

#### 缺漏
- 无实质入口缺漏。主要写入入口列表 11 项全覆盖（admin lib / 21 admin actions / 5 cron STEP / 7 cloudfunc INSERT / seed.ts / migration 0032），与 grep 全仓结果一致。

#### 错配
- 「关键决策摘要 §2」写「**三类 INSERT 入口**（共 12 个调用点 + 21 个 admin action 模块）」中 "12 个调用点" 计数含糊：5 cron STEP + 7 cloudfunc INSERT = 12 这个加法成立，但 cron 5 STEP 实际对应 7 个 `INSERT INTO operation_logs` 语句（refresh-member-levels.ts L157/L190/L215 三个 + audit-points-balance L52 + grant-birthday L85 + grant-thanksgiving L101 + audit-role-type-nulls L78），按"语句数"应为 14 而非 12。语义不算错（STEP 数=5 + cloudfunc=7=12 也合理），但建议明确单位。

#### 数据不一致（量化偏差）
- **distinct action 数被低估**：doc 写「现状 30+ 不同 action 值」，实测 5434 现状 **distinct action = 55，distinct target_type = 23**。doc "30+" 在语义上不算错（55 > 30），但低估近一倍。
- **WorkFine `tb_sys_log` 行数过时**：doc 写 2,088,126，今日（2026-04-26）实测 **2,088,927**（差 +801，WorkFine 仍在线累积平台日志，是预期 drift）。

#### 过时事实
- doc 表 1 备注列「WorkFine 端确实存在的"日志"实体」中 3 张表行数写 "—"（未填），实测：
  - `tb_sys_qrtz_log` = 85,147（Quartz 调度器日志）
  - `tb_sys_error_log` = 163（平台报错日志）
  - `tb_sys_dataspec_serial_log` = 764（数据规格序列号日志）
- WorkFine 还有 1 张含 "log" 关键字的表 `tb_sys_login_provider`（登录方式配置，非日志表）doc 未提及——但这是登录配置不是日志，跳过合理。

### 高价值架构性观察（doc 已自陈，本次确认）
- **org_node_id / org_node_name 来源不对称**（决策摘要 §4）：admin path 主动 SELECT org_nodes 反查，cloudfunctions path 直接 INSERT 不写这两列。当前 PG 填充率 294/295 是因 seed.ts 7 行写满了 org，**真实运行时累积后填充率会显著下降**，admin 后台日志页若按 org_node_id 硬过滤会遗漏 cron / share-gift / settleFailed 行。✅ 已捕捉，无需补充。
- **detail JSON schema V1/V2/V3 无 migration 共存**（决策摘要 §3）：cron customer.memberLevelChange 用 `_v: 3`，admin lib logUpdate/logTransition 用 `_v: 2`，早期 logOperation 直接传任意对象 `_v` 缺失。已捕捉。
- **cloudfunctions 三副本 drift 风险**（决策摘要 §7 + 未覆盖字段汇总）：staffApi / clientApi / payNotify 各有一份 share-gift.js + points.js，INSERT 语句完全相同需三处同步。已捕捉，已挂在 ticket `2026-04-25-crontask-data-integrity-monitor.md`。

### P0 评估
- 无 P0：无业务永久失效 / 数据资损 / 越权。
- 架构性缺陷（org_* 不对称、三副本、target_id 命名不一致、_v 版本不一致）doc 全部主动披露，且已挂在 ticket / 未覆盖字段汇总。

---

## Edge Case 报告 R2（2026-04-26）

**复核者**：fresh agent（独立 8 维边缘挖掘 + MSSQL 反推）
**Verdict**: **minor-issues**

### 8 维度命中明细

| # | 维度 | 命中 | 关键发现 |
|---|------|------|---------|
| 1 | FK 孤立 | ✅ 干净 | `operator_employee_id` LEFT JOIN `staff_wechat_users` 0 孤儿；`org_node_id` LEFT JOIN `org_nodes` 0 孤儿；FK 物理约束守住 |
| 2 | NULL/空串/极值 | ✅ 干净 | 295 行：action/target_type/target_id/source/created_at NOT NULL 全部守住（0 空串）；created_at 跨度 2025-02-01 → 2026-04-25 无未来行无 < 2024 异常；`detail_null=29 / empty_obj=8 / non-object=0`（无数组/字符串误塞） |
| 3 | enum 漂移 | ⚠️ 命中 | `source` 实际取值 `adminApi=290 / staffApi=4 / cronTask=1`；schema 注释只列 `staffApi/clientApi/adminApi`，**实际还有 `cronTask` + 未来 `payNotify`，schema 注释 stale**；`action` 命名风格 100% 点风格（295/295）但 `mall_product_sku.create` / `bundle_group.create` / `product_kind.create` / `mall_category.delete` / `order.create_conversion` 79 行混用下划线 → 不一致；`target_type` 23 distinct，全部 snake_case 干净 |
| 4 | unique 守住 | ⚠️ 1 处 | `(operator_employee_id, action, target_id, sec)` GROUP BY 命中 3 组同秒重复（id 212/213, id 243/244, id 133/134），其中 **id 243/244 detail 完全相同**（mall_product_sku.update bundlePrice null→0 双写），是真实双击落两行；id 212/213 / id 133/134 detail 不同（不同 SKU / 不同 role），属合法连续操作非重复——**无 unique 约束兜底，admin UI 防抖未守住时长期会累积无意义重复** |
| 5 | 跨模块一致性 | ⚠️ 命中 | `target_type=sale_order` 50 行 100% 命中 sale_orders；`target_type=employee` 8 行 100% 命中；**但 `target_type=permission_role` 22 行中 14/22 是员工 employee_id（FY-xxx）+ 8/22 是数字 id**（permission.revoke 用 db row id, permission.assign 用 employeeId），同 target_type 下 target_id 异质化，admin 后台按 `(target_type, target_id)` 聚类时会把"角色行 id"和"员工 id"当成同实体；`org_node_id` cron 行 100% NULL（验证决策摘要 §4 架构性缺失） |
| 6 | 死代码 | 🔴 高发 | 4 个 cloudfunctions 副本入口 17+ 天 **0 行实际产出**：`share.giftGranted=0 / points.settleFailed=0 / service.complete.rate_missing=0 / dataIntegrity.roleTypeNull=0 / points.balanceMismatch=0 / customer.birthdayBenefit=0 / customer.thanksgivingBenefit=0`，**仅 customer.memberLevelChange=1 行**（2026-04-25 唯一真实 cron 产出）；source=staffApi 4 行全部是 seed.ts demo（id 3/4/5/6，时间 2026-03-10/11，确认非真实运行时产出）— **生产环境从 2026-03-11 至 2026-04-25 共 45 天 staffApi 入口 0 真实写入**：分享礼/积分/服务提成 3 类告警通道实际不工作 |
| 7 | dump-restore drift | ⚠️ 命中 | detail _v 三套版本共存：**V1=209 行（_v 缺失，2025-02 至 2026-04-23）/ V2 update=39 行 / V2 transition=17 行 / V3 transition=1 行**（cron customer.memberLevelChange 用 _v=3 with `direction/rolling12mSpend/trigger`，与 V2 不兼容字段集）；下游消费方需 case-by-case 解析；**migration archive 已正确归档（baseline reset 2026-04-10），无残留** |
| 8 | 运行时安全 | 🔴 命中 P1 | **(A) PII 泄露面**：detail 含 `phone` 关键字 17 行 + `idCard` 11 行（store.update / employee.create 把手机号原文写进 detail 明文），无哈希/掩码（如 138****8008）；**(B) admin 路径事务隔离**：`lib/operation-log.ts:L61` `db.insert(operationLogs)` 用 **全局 db** 而非传入的事务 client → 主事务 ROLLBACK 时 audit 行**已独立提交**，可能形成"日志说做了但业务表没改"的反向 drift（P2，争议设计：好处是日志写入失败不破坏业务事务，坏处是失败回滚后留下"幻影日志"）；**(C) cloudfunctions 路径反之**：`service.js:419` / `share-gift.js:141` / `points.js:114` 全用 `client.query`（事务内 INSERT），与 admin 不一致 — settlePointsSafe 内 catch 已用 try/catch 包裹但仍共享主事务 client（已记录在 10-points 报告）；**(D) detail 体积**：max=1881 字节（system.saveMemberBenefits），无 >10KB 行，jsonb 体积健康；**(E) 索引完整**：4 个二级索引 (operator/target/action/createdAt) 全部存在 |

### 高危发现汇总

🔴 **EDGE-13-A（高发但低 severity，记 P2）**：cloudfunctions 端 4 个副本入口（share-gift × 3 / settlePointsSafe × 3 / service.complete.rate_missing × 1 / dataIntegrity 三 STEP / payNotify points × 1）总计 11 个 INSERT 点位 **生产 45 天 0 行产出**。结合 10-points 报告"49,072 销售单 0 条 `'消费赠送'` 流水"（消费链路径未接通）+ 12-message 报告"6/7 生产入口 17 天 0 写"+ 09-coupon 报告"4 写入路径 cron+share-gift 0 产出"，可断定：**非 operation-log 模块缺陷，而是上游业务链路全面未接通的下游征兆**。operation-log 自身是正常的，但作为审计监控通道时**完全沉默**——任何依靠 `WHERE action='points.balanceMismatch'` 等 SQL 做"系统健康巡检"的报表都会假阴。

🟡 **EDGE-13-B（P2，跨模块语义污染）**：`target_type='permission_role'` 同字段下 target_id 异质化（14 行 employeeId、8 行 db row id 数字），admin 后台按 (target_type, target_id) 聚类时会把"角色行 id"和"员工 id"当同实体。建议 permission.revoke 也用 `targetId = employeeId`（携带 detail.permissionRoleId）保持一致。

🟡 **EDGE-13-C（P2，PII 明文泄露）**：detail 含手机号原文 17 行 + 身份证关键字 11 行，admin 后台日志查看页对操作员开放，**不脱敏即裸奔**。建议 logUpdate / logOperation 增加敏感字段白名单或自动脱敏（138****8008）。

🟡 **EDGE-13-D（P3，admin 事务隔离争议）**：`lib/operation-log.ts:L61` 用全局 `db` 而非事务 client，admin 业务事务 ROLLBACK 时审计行已独立 COMMIT。短期不修（保留"业务失败不留痕"反而是问题）；长期建议改成传入 tx client 让审计随业务事务一起 COMMIT/ROLLBACK，业务做得更彻底的反审计追踪。

🟢 **EDGE-13-E（P3，已知约定）**：detail._v V1/V2/V3 共存（209/56/1 行），与决策摘要 §3 一致；admin logs.ts 不解析 _v 直接返回 jsonb 给前端，未来 V4 升级需要前端兜底。

🟢 **EDGE-13-F（P3，schema 注释 stale）**：`source` 注释只列 `staffApi/clientApi/adminApi`，实际还有 `cronTask`（1 行）和未来 `payNotify`（0 行但代码已写）；建议同步注释。

### Verdict 依据

- 无 P0：无业务永久失效 / 数据资损 / 越权 — operation_logs 是审计表，业务不依赖它读路径运行
- 4 个 P2 / 2 个 P3 — 全部为"功能正常但隐含问题"
- 最显著问题（cloudfunctions 入口 0 产出）**根因不在本模块**，已在 10/12/09 模块各自报告中追踪
- 8 维度中 **5 维明确命中**（enum / unique / 跨模块 / 死代码 / 运行时安全），3 维干净（FK / NULL / drift）

---

## 字段扩展建议 R2（2026-04-26）

**评估前提**：MSSQL 反推 R1 已确认 `tb_sys_log`（2,089,146 行）/ `tb_sys_workflow_task_log`（11,079 行）的 schema：

- `tb_sys_log`：log_who(int) / log_who_name / log_when / log_where(IP) / log_what / log_why / ref_type(int) / ref_id(int) / ref_name — **本轮 WF7 用业务关键字 LIKE 查询`审批/流转/订单/收款/开单/服务/退款` 仅命中 22 行（"修改链接服务器"等管理动作），WF8 Top-30 全部为 `创建表单/修改表单/用户登录/用户退出/删除表单` 等平台级动作 — R1 结论正确：tb_sys_log 100% 平台日志，无业务可映射部分**
- `tb_sys_workflow_task_log`：审批流任务流转日志（task_id/instance_id/activity_id/deal_user/opinion_note/template_id），凤御项目业务流程未在 WF 工作流建模 — 不可映射

**WF 反推结论**：**0 字段**可从 WF 端补齐（重判后维持 R1 结论）。

**候选字段**（全部新系统独立扩展，参考 admin/cloudfunctions 实际痛点）：

| # | 字段 / 列 | 类型 | 优先级 | 业务理由 | 抽取式 / 默认值 | 数据量 | 依赖 |
|---|----------|------|-------|---------|----------------|--------|------|
| 1 | `request_id` | varchar(36) | **P0** | 跨表事务追踪：admin 一次 confirmPayment 涉及 sale_orders + sale_allocations + sale_items + 可能 messages 多表 UPDATE，但 audit 只能看到一行 `order.confirmPayment`，无法关联同事务下的"下游连带变更"；接入 request_id 后可一次性串联同请求所有变更（含 cron 同 STEP 同事务多 customer 升级） | UUID v4 / Next.js middleware 注入 / cron 每次 STEP 启动生成 | 与 operation_logs 同量级 | 中（admin middleware + cron run.ts 注入） |
| 2 | `client_ip` | varchar(45) | **P0** | 安全审计基线：当前 0 IP 信息，发生越权或敏感变更（permission.assign / order.close / coupon.batchIssue）无法溯源外网入口；inetType 兼容 IPv4/IPv6 | `request.headers['x-forwarded-for']` / `req.ip` / cron NULL | 与 admin 操作行同量级（约 290+/月） | 低（lib/operation-log.ts 增 1 参数） |
| 3 | `user_agent` | text | **P1** | 配合 client_ip 区分多端访问（admin web / 移动浏览器）；未来 admin 移动端上线后必须 | request headers User-Agent | 同 client_ip | 低 |
| 4 | `result_status` | varchar(20) | **P1** | 当前 audit 行只在"成功"路径写入；失败路径（permission denied / unauthorized / validation_failed）无任何 audit 痕迹（throw 了就没机会 log）。引入 `success/failed/denied` 让"试图越权但被拒"也留痕 | enum(`success`/`failed`/`denied`) / 默认 `success` | 增量 ~10-20% | 中（admin requireFields 抛错前需先记 audit） |
| 5 | `error_code` | varchar(50) | **P1** | 配合 result_status='failed' 落 `UNAUTHORIZED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:` 等错误前缀（CLAUDE.md §1 已约定） | catch 块捕获 err.message 前缀 / NULL | 仅失败行 | 同 #4 |
| 6 | `pii_masked` | boolean | **P1** | EDGE-13-C：当前 detail 明文存手机号/身份证；引入 mask 标记后扫描脚本可一键判断是否需要脱敏，配合 logOperation 增加自动脱敏白名单 | logOperation 写入时若命中敏感 key 自动 mask 并置 true | 全量更新 | 中（lib/operation-log.ts 加 maskPII helper） |
| 7 | `entity_version` | int | **P1** | logUpdate 已 diff before/after，但 audit 行未保留 expectedUpdatedAt 乐观锁版本号；接入后可定位"乐观锁失败 → 重试 → 成功"链路 | 主事务 SELECT updated_at 时回写 | 主要更新动作 | 中 |
| 8 | `request_id` 索引 | btree | **P0** | 配合 #1，按 request_id 跨行检索同事务变更 | CREATE INDEX | — | 低 |
| 9 | `(detail->>'_v')` 表达式索引 | btree | **P2** | EDGE-13-E：未来 V3/V4 升级后按 _v 过滤需要全表扫；当前 295 行不必，但累积到 10w+ 后必需 | CREATE INDEX ... ((detail->>'_v')) | — | 低 |
| 10 | `target_org_node_id` | text | **P2** | EDGE-13-B 互补：当前 org_node_id 是**操作人** org，但若操作人是 HQ admin 跨店操作某门店订单，无法一眼知道"被操作实体属于哪个 org"；增加 target_org_node_id 让 admin 后台日志页支持"按被操作门店筛选" | 业务 SQL 写入时 JOIN 业务表反查 | 增量更新 | 高（21 个 admin action 模块逐一改） |
| 11 | `idempotency_key` | varchar(64) | **P2** | EDGE-13-A 同源：cloudfunctions 副本端写入幂等性，避免同一 settlePointsSafe 失败被重试时落多行（虽然当前 0 行未暴露） | 调用方传入 / `share-gift-{order_id}` | 仅副本端 | 低 |
| 12 | `prev_state_hash` | varchar(64) | **P3** | logUpdate 当前用 computeChanges 算 diff，但若两个并发改同字段、第二个 UPDATE 把第一个的 to 当 from 写，会丢中间状态；接入 hash 链保证可审计 | sha256(detail._v + before) | 仅 update 类 | 高 |

### P0 字段汇总（3 个）

- **#1 + #8 `request_id` + 索引**：跨表事务追踪基础设施 → 落入 _gaps.md 🔧 EXTEND
- **#2 `client_ip`**：安全审计基线 → 落入 _gaps.md 🔧 EXTEND

### P1 字段汇总（5 个）

- **#3 user_agent / #4 result_status / #5 error_code / #6 pii_masked / #7 entity_version**

### P2/P3 字段汇总（4 个）

- **#9 _v 表达式索引 / #10 target_org_node_id / #11 idempotency_key / #12 prev_state_hash**

### 字段扩展数 / WF 反推结论

- **总候选 12 个**（P0×3 / P1×5 / P2×3 / P3×1）
- **WF 反推 0 个**（tb_sys_log 100% 平台日志、tb_sys_workflow_task_log 100% WF 工作流，与凤御业务流不交集 — R1 结论 R2 重判维持）

