# 06 — `appointment` 模块

**Schema 文件**：`db/schema/appointment.ts`
**涉及 PG 表**：`appointments`（单表）
**WorkFine 源表**：⚠️ **无独立预约表**。WorkFine 端只有售前护理单 `UDT_S_762.UDF_S_843`（"预约/到店时间"，售前独有字段）作为附加日期列，没有"待确认/已确认/已取消"等状态机概念。
**主要写入入口**（运行时，无迁移脚本）：
- `fengyu-client/cloudfunctions/clientApi/routes/appointment.js:L108-118` — 顾客端 `appointment.create` INSERT
- `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js` — 员工端 `confirm`（写 status='已确认'）/ `checkin`（写 checkin_at）UPDATE
- `fengyu-admin/src/actions/appointments.ts:L185/L224/L262` — admin 端 confirm / checkin / cancel UPDATE
- `fengyu-admin/src/db/seed.ts:L253-257, L381` — demo seed（5 行 `appt-001..005`，**当前 PG 全部是这批 mock**）

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | WorkFine 来源 | 备注 |
|----|-------|---------------|------|
| appointments | **5** | 0 | 全部由 admin/seed.ts demo 行（appt-001..005，all `created_at = 2026-03-13T15:48:03.041Z`，appointment_id 像 `appt-001` 而非 prod 格式） |

**WorkFine 现状**（MSSQL 探查）：
- `UDT_S_762`（售前护理单主表）：109,390 行，`UDF_S_843` 100% 非空
- `UDF_S_843` vs `UDF_S_822`（服务日期）：71,396 行同日（65%）+ 37,994 行不同日（35%）→ "预约时间"与实际服务日期有 35% 偏差，确实承载了真实"预约语义"
- `UDT_S_259`（售后护理单）：630,819 行，但 schema 已确认**无 UDF_S_843 字段**（售前独有）
- 名称匹配 `appt/appoint/booking/reserve` 的 WorkFine 表：**0 张**

> **结论**：`appointments` 是 100% **新系统独立**表。0 行来自 WorkFine 迁移；运行时由 client/staff/admin 端三方共写。schema 设计的预约状态机（待确认 → 已确认 → 已完成 / 已关闭 / 已取消）在 WorkFine 中**不存在概念对应物**。

---

## 表 1：`appointments`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| appointment_id | text (PK) | 新系统独立 | `generateAppointmentId()`（运行时生成）/ seed `'appt-00X'` | clientApi/routes/appointment.js:L105 + admin/seed.ts:L253-257 | seed 5 行用 `appt-001..005` 简记格式，运行时格式参考 generateAppointmentId 实现 |
| status | appointment_status enum | 默认值/NULL | INSERT 时硬编码 `'待确认'`；员工/admin confirm → `'已确认'`；checkin 不改 status；cancel → `'已取消'`；服务完成 → `'已完成'`；超时 → `'已关闭'`（schema 注释；具体超时 cron 待确认） | clientApi:L113 + staffApi 路由 + admin/actions/appointments.ts | enum 5 值；PG 现状：已确认 2 / 已完成 2 / 已取消 1 |
| store_id | text (FK → stores.store_id) | 新系统独立 | clientApi: `orderItem?.store_id \|\| userStoreId`（优先从绑定的 sale_items 取，否则用顾客 boundStoreId） | clientApi/routes/appointment.js:L95-98, L115 | 必填；NOT NULL FK |
| client_user_id | text (FK → client_wechat_users.user_id) | 新系统独立 | clientApi: 当前登录顾客 `ctx.auth.userId` | clientApi:L116 | NOT NULL FK |
| client_name | varchar(50) | 新系统独立 | clientApi: `users[0]?.name \|\| users[0]?.phone`（取顾客档案，无 name 退化用 phone） | clientApi/routes/appointment.js:L101-102, L116 | NOT NULL；快照字段 |
| employee_id | varchar(30) (FK → staff_wechat_users.employee_id) | 新系统独立 | clientApi: 顾客手选的 `staffWfId`（前端 `pagesAppointment/appointment-create` 传入），可为 NULL | clientApi:L116 | schema 标 NOT NULL（INSERT 写 `staffWfId \|\| null` 与 schema 矛盾，运行时若 null 会触发约束失败 — 业务上前端强制选择美容师可避免） |
| employee_name | varchar(50) | 新系统独立 | clientApi: `inputStaffName`（前端传入的姓名快照） | clientApi:L116 | NOT NULL；快照字段 |
| sale_item_id | varchar(30) (FK → sale_items.sale_item_id) | 新系统独立 | clientApi: 用户从可预约 sale_items 列表里选的具体卡号（`order.appointableItems` 提供候选） | clientApi:L117 | 可空；表示该次预约消耗的卡 / 项目 |
| appointment_time | timestamp | 新系统独立 | clientApi: `parseAppointmentTime(appointmentTime)`（前端传入字符串解析为 Date） | clientApi/routes/appointment.js:L33, L117 | NOT NULL；不来自 WorkFine UDF_S_843 |
| confirmed_at | timestamp | 默认值/NULL | NULL（schema 注释"员工确认预约时记录"，但 admin/staff confirm action 仅 SET status='已确认' **未写 confirmed_at**） | schema:L35 + admin/actions/appointments.ts:L186 | ⚠️ **运行时 bug 嫌疑**：schema 设计了该列但所有 confirm 路径都没写它；PG 现状 0/5 行非空（seed 也没写） |
| checkin_at | timestamp | 默认值/NULL | admin checkin: `new Date()`；clientApi 无该路径；staffApi `appointment.checkin` 也写此列 | admin/actions/appointments.ts:L225 + staffApi/routes/appointment.js | PG 现状 4/5 行非空（seed 给 appt-001/002 写了；003/004/005 一为 null） |
| notes | text | 新系统独立 | clientApi: `notes \|\| ''`（顾客备注） | clientApi:L117 | PG 现状 5/5 行（seed 全写） |
| cancelled_reason | text | 默认值/NULL | clientApi cancel 时写 `cancelledReason \|\| ''` | clientApi/routes/appointment.js:L213 | PG 现状 0/5 行非空（seed 给 appt-005 已取消但未写理由） |
| created_at | timestamp | 新系统独立 | `defaultNow()` / clientApi 显式传 `now` | schema:L39 + clientApi:L113 | NOT NULL |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate / clientApi INSERT 显式传 `now` | schema:L40 + clientApi:L113 | NOT NULL |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**不适用** — 本模块零迁移脚本读 WorkFine。下表列出 **WorkFine 端理论上可承载预约语义但本模块未利用**的字段：

| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| `UDT_S_762.UDF_S_843` | 售前护理单"预约/到店时间"（109,390 行 100% 填充，与服务日期 35% 不同日） | ⚠️ **未对接**：service 模块（05）也未读取该列。如果业务侧希望在迁移后能查到"历史预约时点"，应当：① 在 service_orders 加一列 `legacy_appt_time` 抽 UDF_S_843；② 或为每行 UDT_S_762 派生一行 appointments(status='已完成')，把 UDF_S_843 写入 appointment_time、UDF_S_822 写入 checkin_at |
| `UDT_S_762.UDF_S_822` | 服务日期（已经在 05/service_orders.service_date 落地） | 该列**仅作为 service_date 用**，未建立"appointment → service_order"派生 |

---

## 关键决策摘要

1. **零 WorkFine 来源**：本模块不需要任何迁移脚本对接。PG 现状 5 行全部是 admin/seed.ts demo，2026-03-13 一秒内 INSERT。
2. **WorkFine 端无对应实体**：搜遍 sysobjects 无 appoint/booking/reserve 表名；唯一与"预约"语义相关的是 `UDT_S_762.UDF_S_843`（售前护理单的预约/到店时间字段，109,390 行 100% 填充）。状态机（待确认 → 已确认 → 已完成）在 WorkFine 中**根本不存在**。
3. **`confirmed_at` 设计与实现不一致**：schema 定义了该列且注释"员工确认预约时记录"，但 admin / staffApi / clientApi 三处 confirm 路径都只 SET status='已确认' 未写 confirmed_at。建议下次迭代要么删字段，要么在 confirm 时补写。
4. **`employee_id` schema NOT NULL 与运行时 nullable 冲突**：clientApi INSERT 用 `staffWfId \|\| null`，但 schema 标记 notNull。前端必须强制选美容师才能通过约束 — 业务路径上确实如此（appointment-create 页强制选）。
5. **如果未来需要把售前护理单的预约时间迁过来**：参考"已被脚本读但未对接"小节的方案 ②（每行 UDT_S_762 派生一行 appointments(status='已完成', appointment_time=UDF_S_843, checkin_at=UDF_S_822, sale_item_id=NULL/对应 TKKLS-)）。但 WorkFine 端没有"取消/超时关闭"语义，全部只能落入 '已完成'。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- `appointments.confirmed_at` 设计漏写：3 个 confirm 入口（client/staff/admin）均未写该列，PG 现状 0/5 行非空
- `UDT_S_762.UDF_S_843` 售前预约/到店时间（109,390 行 100% 填充）未对接：若业务需保留历史预约语义，需在最终迁移补齐
- `appointments.employee_id` schema notNull 与 clientApi `\|\| null` 写法的运行时矛盾（前端强制选择兜底，但理论上仍是隐患）
- `appointments` 整表无 WorkFine 迁移路径：不是漏迁，是 WorkFine 没这个实体

---

## Review 报告（2026-04-26）

**复核口径**：先独立调研 schema/写入入口/MSSQL/PG，再对比文档。复核者：fresh agent。

### 概览

- 一致项：~11
- 不一致项：5（缺漏 2 / 错配 2 / 过时事实 1 / 数据不一致 0）
- verdict: **minor-fix**

### 偏差明细

#### 缺漏（写入入口未列出）

1. **`fengyu-staff/cloudfunctions/staffApi/routes/service.js:L379-385, L464-466`** — `service.complete` 包含两条 UPDATE appointments：
   - 关联预约 `appointment_id` 时：`SET status='已完成'`（service 完成后联动）
   - 当 `sale_items.remaining_sessions = 0` 时：`SET status='已关闭'`（次数耗尽自动关闭未来预约）
   这两条是 **schema 状态机注释里"已完成"/"已关闭"路径的实际实现**，文档"主要写入入口"小节完全没列。
2. **`fengyu-admin/src/actions/appointments.ts:L262-268` `cancelAppointment`** 仅 `SET status='已取消'`，**未写 `cancelled_reason`**；文档 cancelled_reason 行只描述了 clientApi 写法，没指出 admin cancel 漏写。

#### 错配（归责错误）

3. **L43 `confirmed_at` 行 + L65 决策摘要 #3 + L73 _gaps 条目**：均把锅扣给 "admin / staffApi / clientApi 三处 confirm 路径"。**实际**：
   - clientApi 没有 confirm 路径（顾客无确认权）
   - **staffApi confirm 实际写了** `confirmed_at`（见 `routes/appointment.js:L205` `UPDATE ... SET status='已确认', confirmed_at=$1, updated_at=$1`）
   - 仅 **admin `confirmAppointment`** 漏写（`appointments.ts:L186` 只 `set({ status: '已确认' })`）
   所以 PG 现状 0/5 行非空的真因是 seed 没写 + 该 5 行没经过 staffApi confirm 路径。结论应改为"admin 单一入口漏写 confirmed_at；staff 已正确写入；client 无此路径"。
4. **L44 checkin_at 行注释 "seed 给 appt-001/002 写了；003/004/005 一为 null"** — PG 实际：003/004 的 `checkin_at = 2026-03-24 03:46:46.572 / 03:46:47.703`，比 `created_at = 2026-03-13 23:48:03` 晚 11 天，**不是 seed 写的**而是后来通过 staffApi.checkin 或 admin checkin 路径补打。仅 005 行始终为 null。

#### 过时事实

5. **L35 status 行 / L24 状态机注释 / 决策摘要 #5** 暗示存在"超时 → 已关闭"的 cron。**实际** `fengyu-admin/src/cron/` 下没有任何 appointment 相关 step；`grep "appointment\|已关闭" src/cron/` 结果为空。"已关闭"目前**唯一触发路径**是 service.complete 在剩余次数归零时联动关闭未来预约。schema 注释"超过预约时间一天未到店 → 已关闭"是**未实现的设计意图**。

#### 数据不一致

无新增（PG 5 行 / MSSQL 0 行的判断与文档一致）。

### 一致项（节选）

- WorkFine 端无 appointment 实体（probe 复测 0 张表名匹配 `appoint/reserv/booking`）
- PG 实际 5 行全部 `appt-NNN` seed 格式、`created_at` 全在 2026-03-13 同一秒
- 状态分布：已确认 2 / 已完成 2 / 已取消 1（文档与实际一致）
- 列清单 15 列与 schema 完全对齐
- FK 反向被引用：`service_orders.appointment_id` 单一反向 FK
- 100% PG 原生、零 MSSQL 同步路径

---

## Edge Case 报告 R2（2026-04-26）

**verdict**：**minor-issues**（PG 仅 5 行 demo seed，运行时入口本身基本健壮，但暴露出 1 个状态机自动化缺失 + 1 个时序 bug + 1 个 schema/语义不一致）

### 8 维结论

| 维度 | 结论 | 证据 |
|------|------|------|
| 1. FK 孤立 | ✅ 干净 | 全 4 个 FK 反查（store/client/employee/sale_item）零孤立。无 ON DELETE 设置（默认 NO ACTION），但 5 行规模无业务级联风险。|
| 2. NULL/空串/极值 | ⚠️ 小问题 | (a) `appointment_time < '2000'`/`>'2100'` = 0；(b) **4/5 行 `appointment_time < created_at`**（seed 给出过去时间，最远早 61.8h），admin/seed.ts 对 demo 数据按"已经发生过"造行可理解，但生产路径上 clientApi 已校验"不能为过去（5min 容差）"，所以这 4 行只可能来源是 seed 而非真实接口；(c) `cancelled_reason`：1 行已取消但理由空（admin/cancelAppointment 未写 + seed 未写）；(d) `confirmed_at`：4 行 status∈{已确认,已完成} 全 NULL（admin confirmAppointment 漏写已在 R1 列；seed 也漏写）。|
| 3. enum 漂移 | ✅ 干净 | schema 5 值 `[待确认,已确认,已完成,已取消,已关闭]` 与 staffApi `STATUS_CN_TO_EN` 映射、admin `serializeAppointment` Tab 筛选、clientApi cancel 校验完全一致。**实际 PG 仅 3 个值在用** — 缺 `待确认`/`已关闭`；`已关闭` 路径仅在 `service.complete` 触发，不存在"超过预约时间未到店 → 已关闭"的 cron。|
| 4. unique 守住与否 | ✅ 干净 | (a) `appointment_id` 0 重复；(b) sale_item_id 同时存在 ≥2 条 待确认/已确认 的：0 行（保护由 clientApi/routes/appointment.js:L82-91 业务级 SELECT 实现，**不是 DB 约束**——并发 INSERT 仍可能突破，详见维度 8）。|
| 5. 跨模块一致性 | ⚠️ 小问题 | `service_orders.appointment_id` 反查 dangling=0；status='已完成' 但无对应 service_order 也=0（seed 故意配齐）。**`stale appointment` = 2**：2 行 status∈{待确认,已确认} 但其挂的 sale_item.remaining_sessions=0，按 schema L14 注释"次数耗尽自动关闭"应该被 service.complete 联动到 '已关闭'，但 seed 写了 0 次数却没把状态推到 '已关闭'（seed bug）。|
| 6. 死代码 / 永不命中 | ⚠️ 小问题 | (a) **`confirmed_at` 在 admin 路径上是死字段**（admin/actions/appointments.ts:L186 `confirmAppointment` 仅 set status，PG 5 行 0/5 非空）；staffApi confirm 路径会写但 demo 5 行未走过 staff 路径；(b) **schema L14 "超过预约时间一天未到店 → 已关闭"** 这条状态机注释**至今无任何 cron / scheduled job 实现** — 设计意图未落地，应在 cron-worker 加 STEP 6 或注释删除；(c) `appointmentStatusEnum` 的 `已关闭` 值历史命中率：PG 5 行 0 次出现；运行时唯一触发点是 `staffApi/routes/service.js:L379-385`（次数归零联动）。|
| 7. dump-restore 残留 / drift | ✅ 干净 | (a) baseline reset 后 5433/follow-up-5433-drift.txt 中提到的 idx_appts_employee_time 的 opclass mismatch（`text_ops` vs `timestamp_ops` 在 5433 端），但仅冷备库 — 5434 生产库未受影响；(b) 表无 archive 痕迹，无 dropped column 残留（可对比 01-order 的 `pg.dropped.13`）。|
| 8. 运行时安全 | ⚠️ 小问题 | (a) 全部 SQL 走 `pg.query(text, params)` 参数化，零拼接；(b) clientApi `appointment.create` 在"check existing pending"和 INSERT 之间**未加事务/行锁**——L82-91 SELECT 后 L108 INSERT 是两步独立操作，并发同顾客对同 sale_item_id 双击可绕过"已有待确认/已确认"守卫造成同 sale_item 双预约（数据库无 partial unique index 兜底）；(c) `parseAppointmentTime` 对 `'2026-13-45 14:00-15:00'` 这类无效日期会被 `new Date()` 解析为 NaN 然后 throw，已正确防御；(d) `generateAppointmentId` = `'apt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,9)` — `substr` 已废弃但仍工作；高并发同毫秒 + Math.random 9 位 base36 ≈ 36⁹ 空间足够（无 PK 冲突风险）；但**没有 `ON CONFLICT DO NOTHING` / 重试**，理论上有极低概率撞 PK。|

### 高危发现汇总

| 编号 | 维度 | 严重度 | 描述 |
|------|------|--------|------|
| E1 | 维度 8 | **P1** | clientApi `appointment.create` 的"已有待确认/已确认"守卫只走业务 SELECT 不走 DB 唯一约束，并发双击可破。建议加 `CREATE UNIQUE INDEX uq_appt_active_per_sale_item ON appointments (sale_item_id) WHERE status IN ('待确认','已确认') AND sale_item_id IS NOT NULL;` partial unique index。|
| E2 | 维度 6 | **P2** | schema L14 注释承诺的"超过预约时间一天未到店 → 已关闭"无 cron 实现。要么在 `fengyu-admin/src/cron/steps/` 加 `close-overdue-appointments.ts`，要么从 schema 注释去掉该承诺。|
| E3 | 维度 5 | **P2** | 2 行 stale appointment（已确认/待确认 + sale_item.remaining_sessions=0）。运行时 service.complete 路径会自动关，但 seed bug 写出了不一致状态；admin UI 和 staffApi list 此时仍把它们视为"可服务"会引发误操作。|
| E4 | 维度 6 + 2 | **P2** | `confirmed_at` 在 admin 入口长期失写（已在 R1 列出，重申）；改 admin/actions/appointments.ts:L186 一行：`set({ status: '已确认', confirmedAt: new Date() })`。|
| E5 | 维度 2 | **P3** | admin `cancelAppointment` 未接收 `cancelledReason` 参数也未写 cancelled_reason 列。如果业务上需保留取消原因，admin UI 应加 reason 文本框 + 透传。|

---

## 字段扩展建议 R2（2026-04-26）

**用户诉求**：在最终迁移时，让 PG `appointments` 表覆盖更多 WorkFine `UDT_S_762` 字段，把售前护理单上承载的"预约语义"挖出来。

**前提**：本模块当前是**零 WorkFine 迁移**。要"扩字段"等于**新增一条迁移路径**：把 `UDT_S_762` 每行（109,429 条）派生为 `appointments` 一行（status='已完成'，因为 WF 没有"待确认/取消"概念）。这需要：① schema 加列；② 写 `db/scripts/migrate-appointments-from-presale.js`（新脚本）；③ 决定是否回填还是 forward-only。

### 重新理解 UDF_S_843 语义

R1 文档把 UDF_S_843 描述为"售前护理单的预约/到店时间"。R2 探针发现：
- 109,429 行 100% 非空，min=2023-02-09，max=2026-04-26
- 71,396 行（65%）与 UDF_S_822（服务日期）同日 → 这部分是"今日到店"
- **37,696 行（34.4%）UDF_S_843 > UDF_S_822** → "服务发生在更早，预约时间在更晚" → **UDF_S_843 实际语义更接近"下次预约时间"或"复诊预约时间"，而非本次到店**
- 仅 337 行（0.3%）UDF_S_843 < UDF_S_822 → 真正"先预约后到店"
- 平均 `DATEDIFF(hour, UDF_S_843, UDF_S_822) = -11h` → 服务比"843 时间"平均早 11 小时

**结论**：UDF_S_843 应理解为**"下次到店预约时间"快照**，迁移到 PG 时**不应**与本次服务的 service_date 混为一谈，应作为**派生 appointments(status='已完成')** 的 `appointment_time` 候选；或作为 `service_orders` 表的"下次预约"快照列。

### 候选字段表（按优先级排序）

| # | 优先级 | WorkFine 源 | PG 应新增列 | 业务理由 | 抽取式 / 转换 | 行数 / 回填 | 依赖 |
|---|--------|-------------|------------|----------|---------------|-------------|------|
| 1 | **P0** | `UDT_S_762.UDF_S_843`（预约/到店时间，timestamp/datetime） | `appointments.appointment_time`（已存在）+ 派生新行 | 109,429 行历史预约语义不丢，未来"顾客上次预约"功能可查 | 每行 UDT_S_762 派生 1 行 appointments，appointment_time = UDF_S_843；当 UDF_S_843 ≥ UDF_S_822 时 status='已完成' & checkin_at=UDF_S_822；当 UDF_S_843 < UDF_S_822 时 status='已完成' & checkin_at=UDF_S_843（先预约后到店）| 109,429 行（109k 行批量回填，单事务分批 5000） | 需先确认派生 appointment_id 规则（建议 `apt-mig-{HLD-编号}`）+ admin UI 是否要在顾客详情展示该批历史 |
| 2 | **P0** | `UDT_S_762.UDF_S_826`（服务时长，分钟） | `appointments.duration_minutes` `integer` (nullable) | 当前 PG schema 无服务时长字段；客户预约页/员工档期排期都需要"这场预约要占多久"。Top4：45min(56%) / 60min(11%) / 50min(10%) / 90min(9%) | `parseInt(RTRIM(UDF_S_826))`，非数字落 NULL | 109,429 行回填 + 运行时 INSERT 路径补传（clientApi appointment.create 现仅传 sale_item，不传 duration） | schema 加列 + clientApi appointment.create 加 duration 入参 + admin/staff UI 补显示 |
| 3 | **P1** | `UDT_S_762.UDF_S_982`（备注，长文本，max_len=37） | `appointments.notes`（已存在） | 现有 notes 列只承接 client 端 INSERT 入参。WorkFine 65,851 行（60%）UDF_S_982 为空，43,578 行有内容（37 字符上限） | 直接 INSERT INTO appointments(notes, ...) | 43,578 行写入历史 notes | 仅取决于派生迁移脚本是否包含此列 |
| 4 | **P1** | `UDT_S_762.UDF_M_842`（顾客满意度，UDT_M_763 子表，最频"满意" 109,074） | `appointments.satisfaction_rating` `varchar(10)` (nullable) | 现 PG 无满意度列；admin 顾客详情/员工绩效都缺这一维度。枚举：满意/一般/未评价/不满意 | 取该 HLD 单的子表第一行 UDF_M_842 | 109,074 行回填 | schema 加列 + 运行时 staff 端"完成预约"步骤补打 + admin 报表组件 |
| 5 | **P1** | `UDT_S_762.UDF_S_819`（顾客类型，5 值：售前一次/售后/售前二次/线上美团首次/老带新） | `appointments.customer_type_at_visit` `varchar(20)` (nullable) | 历史预约的"当时顾客身份"快照，与 client_wechat_users.customer_type（动态）不同。售前一次 92,636 / 售后 12,516 等 | RTRIM(UDF_S_819) 直存，新增枚举 OR 直接 varchar | 109,429 行 | 仅迁移路径 |
| 6 | **P2** | `UDT_S_762.UDF_S_830`（拓客类型，体验/38卡初次） + `UDT_S_762.UDF_S_831`（推广员，21,362/109,429=20% 填充） | `appointments.acquisition_type` `varchar(20)` + `appointments.promoter_name` `varchar(50)` | 跟着 03-user 拓客来源链路打通；推广员姓名做后续业绩归属。类似 client_wechat_users.promoter_employee_id 但是预约层面 | 直接 RTRIM | 14,248+6,179=20,427 行 acq_type / 21,362 行 promoter | 与 03-user 拓客来源路径一起迁，避免双记 |
| 7 | **P2** | `UDT_S_762.UDF_S_2126`（顾客电话） | （不必新增，已有 `client_user_id` FK 关联到 client_wechat_users.phone） | 历史预约的电话快照可作 fallback：当 client_user_id 关联失败时仍能找到顾客 | 仅在迁移脚本里，client_user_id IS NULL 时把 UDF_S_2126 写到 client_name 兜底 | 用作迁移 fallback，不新增列 | — |
| 8 | **P2** | `UDT_S_762.UDF_S_2599`（员工编号）+ `UDT_S_762.UDF_S_2601`（职位） | （不必新增，已有 `employee_id` + 关联到 staff_wechat_users.position） | 与 #7 同理，做迁移期 fallback，不新增列 | — | — | — |
| 9 | **P3** | `UDT_S_762.UDF_S_1417`（分类，护理分类） | `appointments.service_category` `varchar(50)` (nullable) | 与 sale_item 关联的 product_category 是"购买时分类"；该列是"本次服务时分类"，可有微小差异 | RTRIM 直存 | 109,429 行 | 与 04-product 一致性比对（如果两值始终一致可不存） |

### 优先级判断

- **P0（迁移必加 / 业务依赖）**：`appointment_time` 派生 + `duration_minutes` — 不加这两个，"扩 WF 字段"诉求不成立
- **P1（信息流失，强烈推荐）**：notes / satisfaction_rating / customer_type_at_visit
- **P2/P3（nice-to-have）**：拓客类型、推广员、服务分类

### 建议落地顺序

1. **先做 schema 变更 PR**：仅加 `duration_minutes` + `satisfaction_rating` + `customer_type_at_visit`（3 列），其它复用现有列；运行时入口（clientApi appointment.create / staffApi appointment.confirm）配套补字段
2. **再做 migration 脚本**：`db/scripts/migrate-appointments-from-presale.js`，目标抽 109,429 行 → appointments，全部置 status='已完成'，派生 ID 规则 `apt-mig-{UDF_S_821}`（与 service_orders.service_order_id=UDF_S_821 形成 1:1 映射方便回查）
3. **关联打通**：脚本里同时 `UPDATE service_orders SET appointment_id = 'apt-mig-' || service_order_id WHERE ...` 把 service_orders 反向关联到 appointments
4. **admin UI 配套**：客户详情页"预约记录" Tab 应补展示历史 109k 行；满意度列加到员工绩效报表

### 风险提示

- 109,429 行批量回填会让 PG 当前 5 行 → 109,434 行；需评估 admin appointments 列表分页 + 索引（已有 idx_appts_store_id / idx_appts_client_user_id / idx_appts_employee_time，但**没有 (status, appointment_time desc) 复合索引**，"今日待确认"等高频查询走全表扫成本会上升）
- 派生路径 status 全置"已完成"，意味着**WorkFine 历史无法承载"取消"语义** — admin UI 取消统计将永远只反映 PG 原生新增行的取消量，统计口径需更新文档说明
- `appointment_time` 历史最早 2023-02-09，最晚 2026-04-26 — 跨度 3.2 年；admin "近 30 天预约" 默认筛选不会受影响；但顾客详情 Tab 一开就 109,074 满意度行需要分页保护

