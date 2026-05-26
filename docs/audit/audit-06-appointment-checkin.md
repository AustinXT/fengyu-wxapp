# 审计报告：预约 + 签到 → 服务单流转 (06) v3

**审计时间**：2026-04-25（v1）/ 2026-04-26（v2）→ 合并 2026-04-26
**域 ID**：06
**审计员**：claude-opus-4-7（v1）/ claude-sonnet-4-6（v2）→ claude-sonnet-4-6 合并
**审计时长**：v1 ~25 min，v2 ~30 min，合并 ~15 min
**版本历史**：v1 → v2（独立二轮）→ v3（合并统一）

## 元信息

| 字段 | 值 |
|------|----|
| 关联 PR/Ticket | — |
| 报告结构 | 元信息 → v1 vs v2 对账 → P0（含 CLOSED） → P1 → P2 → 跨端表格 → CC1-CC9 → 修复建议 → SQL → 影响半径 |
| v1 → v2 差异 | 见 §0 对账表 |
| 合并规则 | 同问题以 v2 为准；v1 P0-06-04 / P1-06-14 已修复 → CLOSED；spending_tier 从 P0 降 P1 |

---

## 0. v1 vs v2 对账摘要

| issue | v1 评级 | v2 状态 | 合并处理 |
|-------|---------|---------|---------|
| P0-06-01 client list/cancel 缺 requirePhone | P0 | P0 仍存在 | 保留 P0 |
| P0-06-02 client cancel 缺 CAS | P0 | P0 仍存在 | 保留 P0 |
| P0-06-03 service_orders 缺 partial UNIQUE | P0 | P0 仍存在 | 保留 P0 |
| P0-06-04 过期关闭机制缺失 | P0 | **已修复** | → `[CLOSED from v1]` |
| P0-06-05 admin cancel 权限 key 错 | P0 | P0 仍存在 | 保留 P0 |
| P1-06-06 同员工同时段冲突 | P1 | P1 仍存在 | 保留 P1 |
| P1-06-07 时区不一致 | P1 | P1 仍存在 | 保留 P1 |
| P1-06-08 result.count 类型断言 | P1 | P1 仍存在（v2 补充 mock 同款缺陷）| 保留 P1 |
| P1-06-09 staff list scope 缺管理层分支 | P1 | P1 仍存在 | 保留 P1 |
| P1-06-10 客户端取消窗口 | P1 | P1 待 PM 决策 | 保留 P1 |
| P1-06-11 checkin 状态前置不一致 | P1 | P1 仍存在（测试反向锁死）| 保留 P1 |
| P1-06-12 admin checkin 无幂等 | P1 | **升级为专项 NEW-P1-06-A** | → NEW-P1-06-A（P1）|
| P1-06-13 client list 含终态 | P1 | P1 仍存在 | 保留 P1 |
| P1-06-14 admin confirm 不写 confirmedAt | P1 | **已修复** | → `[CLOSED from v1]` |
| NEW-P1-06-B admin complete 不反推 appointment | — | P1 新发现 | 写入 P1 |
| NEW-P1-06-C staff checkin UPDATE 缺状态 CAS | — | P1 新发现 | 写入 P1 |
| P2-06-15 client.create 无事务 | P2 | P2 仍存在 | 保留 P2 |
| P2-06-16 appointmentId 用 Math.random | P2 | P2 仍存在 | 保留 P2 |
| P2-06-17 INVALID_PARAMS 滥用 | P2 | P2 仍存在 | 保留 P2 |
| P2-06-18 staff confirm/checkin 不写 operation_logs | P2 | P2 仍存在 | 保留 P2 |
| P2-06-19 staff list 混返格式字符串与 timestamp | P2 | P2 仍存在 | 保留 P2 |
| P2-06-20 inputStaffName 不从 DB 反查 | P2 | P2 仍存在 | 保留 P2 |
| NEW-P2-06-D admin test mock `count` vs `rowCount` | — | P2 新发现 | 写入 P2 |

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/appointment.ts:16-47` + `db/schema/service.ts:31`（`service_orders.appointment_id` FK） | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:78` `appointmentStatusEnum`（5 值：待确认/已确认/已完成/已取消/已关闭） | ↑ | ↑ |
| **注意** | **无"已签到"枚举值**：签到仅写 `checkin_at` 时间戳，状态不变 | ↑ | ↑ |
| Admin Action | `fengyu-admin/src/actions/appointments.ts`（list/confirm/checkin/cancel）| — | — |
| Admin Service Action | `fengyu-admin/src/actions/services.ts:334-397` `completeServiceOrder` | — | — |
| Staff Route | `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js`（list/detail/confirm/checkin）| — | — |
| Staff Service Route | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:286-475` `complete` | — | — |
| Client Route | `fengyu-client/cloudfunctions/clientApi/routes/appointment.js`（create/list/cancel）| — | — |
| Cron（新增，v2 确认）| `fengyu-admin/src/cron/steps/close-expired-appointments.ts:30-59`（STEP 1 in `run.ts`）| — | — |
| 测试 | `appointments.test.ts` + `close-expired-appointments.test.ts` | `appointment.test.js` | 无 |

---

## 2. 数据流图

```
client.create
  ├─ requirePhone() ✔（line 15）
  ├─ 校验 saleItem 归属 + remaining_sessions > 0
  ├─ SELECT existingAppointments WHERE sale_item_id AND status IN ('待确认','已确认')
  │    TOCTOU：事务外，无 partial unique 兜底
  └─ INSERT appointments status='待确认'
        — employee_name 用前端传 inputStaffName（P2-06-20）

staff.confirm   待确认 → 已确认（CAS: WHERE status='待确认'，rowCount=0 报错）✔
staff.checkin   仅写 checkin_at（应用层校验 IN ['待确认','已确认']）
                — UPDATE WHERE appointment_id 无 status 守卫（NEW-P1-06-C）
                — 有 appt.checkin_at 幂等返回 ✔
admin.confirm   待确认 → 已确认（CAS + scopeCondition）+ confirmedAt ✔（appointments.ts:186）
admin.checkin   仅写 checkin_at，CAS: WHERE status='已确认'，无 checkin_at IS NULL（NEW-P1-06-A）
admin.cancel    (待确认|已确认) → 已取消（CAS）
                — requirePermission 用 'appointment:confirm' 而非 'appointment:cancel'（P0-06-05）
client.list     无 requirePhone()（P0-06-01）
client.cancel   无 requirePhone()（P0-06-01）
                — UPDATE WHERE appointment_id=$3 无 status 守卫（P0-06-02）

staff.service.create(appointmentId)
  ├─ 事务外 SELECT 校验 appointment.status='已确认' + 同店
  ├─ 事务外 SELECT 校验 service_orders.appointment_id 未占用（TOCTOU，无 partial unique）
  └─ pg.transaction：INSERT service_orders + service_items
        — appointment.status 不变（仍 '已确认'）

admin.service.create(resolvedAppointmentId)
  ├─ 查找已签到未关联服务单的最近预约（notExists 子查询）✔
  └─ db.transaction：INSERT service_orders
        — appointment.status 不变

staff.service.complete
  ├─ CAS: UPDATE service_orders WHERE status='服务中' ✔
  ├─ 原子扣 remaining_sessions ✔
  ├─ 若扣到 0：UPDATE appointments SET status='已关闭' WHERE sale_item_id AND status IN ('待确认','已确认') ✔
  └─ 若 so.appointment_id：UPDATE appointments SET status='已完成' WHERE appointment_id AND status='已确认' ✔

admin.service.complete（completeServiceOrder）
  ├─ CAS: UPDATE service_orders WHERE status='服务中' ✔
  ├─ 原子扣 remaining_sessions（CTE deduct）✔
  └─ 无 appointment 状态更新（NEW-P1-06-B，appointment 永留 '已确认'）

cron.closeExpiredAppointments（STEP 1，03:00 Asia/Shanghai）✔ 已实现 [CLOSED from v1]
  └─ UPDATE appointments SET status='已关闭' WHERE status IN ('待确认','已确认') AND appointment_time < NOW()-1day
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-06-01] client.appointment.list / client.appointment.cancel 缺 requirePhone() 鉴权守卫
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:131,185`
- 现象：
  - `list` handler（line 131）直接 `const { userId } = ctx.auth`，无 `requirePhone()` 调用
  - `cancel` handler（line 185）同上
  - 仅 `create`（line 15）有 `await requirePhone()(ctx, async () => {})`
  - auth 中间件（`middleware/auth.js:53-61`）在 openid 未找到用户时 `userId: null, phone: null`
- 风险：
  1. `userId=null` 时 `list` 的 `WHERE client_user_id=$1` 等价 `WHERE client_user_id=NULL`（PG NULL 不等于 NULL），返空集，但泄露接口存在性
  2. `cancel` 的 `SELECT WHERE appointment_id=$1 AND client_user_id=$2` 若 `userId=null` 返空，当前无越权——但若攻击者曾绑过手机号，DB phone 被置空后重查 auth，openid 命中而 phone=null，`requirePhone` 防线完全缺失
  3. 与 `create` 形成语义不对称——"发起预约需绑手机但查看/取消不需要"
- 命中：real.md §5 后端统一鉴权 / CC4
- 修复：(L3) `list`/`cancel` handler 顶部各加 `await requirePhone()(ctx, async () => {})`，对齐 `create`

#### [P0-06-02] client.appointment.cancel UPDATE 缺 CAS 状态守卫（状态机可崩坏）
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:208-213`
- 现象：
  ```js
  await pg.query(
    `UPDATE appointments
     SET status = '已取消', cancelled_reason = $1, updated_at = $2
     WHERE appointment_id = $3`,      // ← 无 status IN ('待确认','已确认') 条件
    [cancelledReason || '', now, appointmentId]
  )
  ```
  应用层在 line 204 先 SELECT 校验 `status IN ('待确认','已确认')`，但属 TOCTOU：SELECT 与 UPDATE 之间另一事务可改变 status
- 风险：并发下，staff 已 complete 服务单（appointment→已完成），client 同时发起 cancel → UPDATE 无条件把 `已完成` 覆盖为 `已取消`，触发状态机崩坏（real.md §4 状态单向推进）；`service.complete` 的 `WHERE status='已确认'` 保护自己不被覆盖，但 client cancel 可在 complete 后到达并回退
- 命中：real.md §4 / CC2 并发幂等
- 修复：(L3) `UPDATE ... WHERE appointment_id=$3 AND client_user_id=$4 AND status IN ('待确认','已确认')`，并检查 `result.rowCount===1`，若 0 返 "预约状态已变更"

#### [P0-06-03] service_orders.appointment_id 缺 partial UNIQUE，TOCTOU 重复绑定
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:55-69`；DB：`db/schema/service.ts:31`；迁移：`db/migrations/0000_baseline.sql:547`（仅 FK，无 UNIQUE）
- 现象：staff.service.create 在 `pg.transaction` **外部**先查 `SELECT service_order_id FROM service_orders WHERE appointment_id=$1`，再进入事务 INSERT。两个并发 create 使用同一 appointmentId 都能通过外部检查，各自 INSERT 一条 service_orders 关联同一预约，产生多对一脏数据
- v2 独立确认：全仓所有迁移文件（0000-0020）grep `appointment_id.*UNIQUE|UNIQUE.*appointment_id|uq.*appointment` 均无命中
- 风险：一预约对应 N 条服务单：
  1. `service.complete` 两次均推进同一 appointment→已完成，第一次 CAS 成功，第二次 rowCount=0 但无 P0 资损
  2. **次数被双扣**（real.md §1 次数防超卖）——每个 service_orders 各自触发 complete 都扣 remaining_sessions
  3. 详情页 `LEFT JOIN service_orders ON appointment_id` 拿到首条，另一条永远影子数据
- 命中：real.md §1 次数防超卖 / CC2 / 与 audit-05 P0-05-03 同源
- 修复：(L0) 新增迁移：`CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;`；(L3) staff.service.create 把 "appointmentId 已占用" 检查移入事务，ON CONFLICT DO NOTHING 并检查 rowCount

#### [P0-06-05] admin.cancelAppointment 使用错误权限 key（`appointment:confirm`）
- 文件：`fengyu-admin/src/actions/appointments.ts:250`
  ```ts
  requirePermission(session, 'appointment:confirm')   // ← 应为 'appointment:cancel'
  ```
- 文件：`fengyu-admin/src/lib/permissions.ts:15-86`
  - `PERMISSION_MATRIX` 中 `manager` 含 `'appointment:confirm'`（line 48）但无 `'appointment:cancel'`
- 风险：语义错位——任何被授予"确认预约"权限的角色（包括 manager）自动获得"取消任意预约"权限；finance/hr/admin 等角色若按业务需要被临时授予 confirm 权限，会意外获得 cancel 权限
- 命中：real.md §5 后端统一鉴权 / CC4
- 修复：(L0) `permissions.ts` PERMISSION_MATRIX.manager 增加 `'appointment:cancel'`；(L7) `cancelAppointment` 改用 `requirePermission(session, 'appointment:cancel')`

---

### [CLOSED from v1] P0-06-04 — 过期预约关闭机制完全缺失

- **v1 状态**：P0，cron 目录下 5 个 STEP 无 appointment-close，spec §5.3 状态机未实现
- **v2 确认**：**已修复**。`close-expired-appointments.ts` STEP 1 已实现，集成进 `run.ts`，有独立测试覆盖 `close-expired-appointments.test.ts`
- **关闭结论**：`cron.closeExpiredAppointments（STEP 1，03:00 Asia/Shanghai）` 已落地，UPDATE `status='已关闭' WHERE status IN ('待确认','已确认') AND appointment_time < NOW()-1day` + operation_logs 记录，验证通过

---

### 3.2 P1（数据一致 / 状态错乱）

#### [NEW-P1-06-B] admin.completeServiceOrder 不回写 `appointment.status='已完成'`（跨端状态机断裂）
- 文件：`fengyu-admin/src/actions/services.ts:360-397`
  - SQL CTE 仅 `UPDATE service_orders ... WHERE status='服务中'` + `UPDATE sale_items SET remaining_sessions`，**无任何 appointment UPDATE**
- 对比 staff.service.complete（`routes/service.js:461-466`）：
  ```js
  if (so.appointment_id) {
    await client.query(
      "UPDATE appointments SET status='已完成', updated_at=$1 WHERE appointment_id=$2 AND status='已确认'",
      [now, so.appointment_id]
    )
  }
  ```
- 风险：admin 完成服务单后关联预约永留 `已确认`：
  1. dashboard 统计"已确认预约"数量虚高
  2. 顾客再次预约同一 sale_item，client.create 检查 `status IN ('待确认','已确认')` 命中该僵尸预约，报"该订单明细已有待确认或已确认的预约"——客户陷入死锁（除非 sale_item remaining_sessions 归零触发 service.complete 关闭路径）
- 命中：跨端一致性 / CC7 / real.md §4 状态单向推进
- 修复：(L7) `completeServiceOrder` CTE 增加 appointment UPDATE 分支：`WITH ..., appt_done AS (UPDATE appointments SET status='已完成', updated_at=NOW() WHERE appointment_id=(SELECT appointment_id FROM service_orders WHERE service_order_id=$serviceOrderId) AND status='已确认') SELECT ...`
- **v2 补充**：admin completeServiceOrder 路径无测试覆盖此场景（CC9 后续命中）

#### [NEW-P1-06-C] staff.checkin UPDATE 缺状态 CAS 守卫（并发可写入终态预约）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:260-264`
  ```js
  await pg.query(
    'UPDATE appointments SET checkin_at = $1, updated_at = $1 WHERE appointment_id = $2',
    [now, appointmentId]
  )
  ```
  应用层在 line 246-248 检查 `status IN ['待确认','已确认']`，但属 TOCTOU：另一请求在 SELECT 后改变 status，UPDATE 仍无条件执行
- 风险：并发下，staff.confirm 触发后 client.cancel 并发先完成，checkin 仍会写 checkin_at 到 status='已取消' 的行，破坏审计时间戳语义；若未来 `已取消` 行仍留在列表，显示 checkin_at 不为空误导员工
- 与 P0-06-02 叠加：若 P0-06-02 未修复，client.cancel 把 `已完成` 覆盖为 `已取消`，staff.checkin 的 CAS 缺失会进一步写脏 checkin_at
- 命中：CC2 / real.md §4 状态单向推进
- 修复：(L3) `UPDATE ... WHERE appointment_id=$2 AND status IN ('待确认','已确认') AND checkin_at IS NULL`，检查 rowCount=1；rowCount=0 时分支判断是状态已变更还是已签到

#### [NEW-P1-06-A] admin.checkinAppointment 缺 `checkin_at IS NULL` 幂等守卫
- 文件：`fengyu-admin/src/actions/appointments.ts:225-230`
  ```ts
  result = await db.update(appointments)
    .set({ checkinAt: new Date() })
    .where(and(
      eq(appointments.appointmentId, appointmentId),
      eq(appointments.status, '已确认'),
      scopeCondition(session, appointments.storeId),
    ))
  ```
  无 `AND checkin_at IS NULL`；重复调用每次都把 checkinAt 更新为当前时间
- 对比：staff.checkin（line 251-258）检查 `if (appt.checkin_at)` 提前返回幂等
- 测试缺口：`appointments.test.ts` 中 `checkinAppointment` 测试用例（rowCount=0 失败 / rowCount=1 成功）均不测试"重复签到覆盖时间"场景
- 命中：CC2 并发幂等 / CC7 时间字段责任
- 修复：(L7) admin checkin WHERE 加 `and(isNull(appointments.checkinAt))`；rowCount=0 时分支判断：若原行 checkin_at 非空返"已签到（幂等）"，否则返"状态已变更或无权"

#### [P1-06-06] 同员工同时段冲突检查完全缺失
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:108-118`、`staffApi/routes/appointment.js:204-217`
- 现象：client.create 既不校验 `(employeeId, appointment_time)` 时段冲突，也不校验同顾客已有"待确认"预约的时间冲突。`db/schema/appointment.ts:45` 有索引 `idx_appts_employee_time` 但只是为查询服务，无 EXCLUDE / unique。staff.confirm 也不校验"已有同员工同时段已确认预约"。
- 风险：5 个客户在同一员工的同一 09:00-11:00 时段全部预约成功；前端 `appointableItems` 不返回时段（依赖前端自维 5 时段，无后端兜底）
- 修复：(L0) 加 `EXCLUDE USING gist (employee_id WITH =, tsrange(appointment_time, appointment_time + interval '2 hour') WITH &&) WHERE status IN ('待确认','已确认')`（需要 btree_gist），或简化 partial unique `(employee_id, appointment_time) WHERE status IN ('待确认','已确认')`；(L3) staff.confirm 在 CAS UPDATE 前校验同员工同时段 `status='已确认'` 数量 ≤ 0
- 命中：CC2 并发幂等

#### [P1-06-07] staff.list todayOnly 用 UTC 分界，与 admin CURRENT_DATE 不一致
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:60`
  ```js
  const today = new Date().toISOString().slice(0, 10)  // UTC 00:00 分界
  ```
  对比 admin：`fengyu-admin/src/actions/appointments.ts:105-106` `CURRENT_DATE`（PG 服务器时区）
- 风险：北京时间 00:00-08:00 期间两端"今日"视图集合不重叠（staff 显示 UTC 昨日，admin 显示 PG 当日）
- 命中：CC7 时间字段 / CROSS-CUTTING.md "三端时区不一致"
- 修复：(L3) `staffApi` 改用 `AND DATE(a.appointment_time AT TIME ZONE 'Asia/Shanghai') = CURRENT_DATE`（需服务器时区已设或显式转换）

#### [P1-06-09] staff.appointment.list 管理层模式下 `effectiveStoreId=null` 导致空集
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:50`
  ```js
  const params = [ctx.auth.effectiveStoreId, ...]
  // WHERE a.store_id = $1  ← 当 effectiveStoreId=null，等于 WHERE a.store_id=NULL → 无结果
  ```
  `buildStoreScopeCondition` helper 存在于 `utils/scope.js` 但 appointment.js 未引用
- 风险：总部/市场级员工 `loginLevel='management'` 时无法看任何预约；改用 store 模式临时切换才有数据；与 audit-05 P1-05-10 同源
- 命中：CC3 组织域隔离
- 修复：(L3) 改用 `buildStoreScopeCondition(ctx.auth, 'a.store_id', 1)` 替代硬拼 `effectiveStoreId`

#### [P1-06-10] client.appointment.cancel 无取消窗口 / 无 lead time 限制
- 文件：`clientApi/routes/appointment.js:185-221`
- 现象：spec.client.pr.spec.md:200 "取消后可重新发起（系统关闭的不可）"，仅约束重发不约束何时可取消。但常识业务规则（提前 N 小时不可取消，避免店员空挡）在三端均缺失；无 `appointment_time - now > X minutes` 校验
- 风险：客户在到店前 1 分钟取消，员工已备料/占工位但无补偿
- 修复：(L7 业务策略) 在 system_configs 加 `appointment.cancel_lead_minutes`（如 120 分），client.cancel 校验 `parsedTime - now >= lead`
- 命中：CC2 / CC9（与业务规范补全相关）

#### [P1-06-11] staff.checkin 允许 `待确认` 状态签到，与 admin 严格校验不一致
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:246`
  ```js
  if (!['待确认', '已确认'].includes(appt.status)) { ... }
  ```
  对比 admin：`fengyu-admin/src/actions/appointments.ts:228` CAS `WHERE status='已确认'`（只允许已确认时签到）
- 风险：staff 可跳过 confirm 直接签到，业务流程异步（预约未经确认就触发签到通知/服务单创建流程）；admin 操作日志 `logTransition(...'已确认', '已签到')` 写死 from='已确认'，与 staff 实际 from 可能是待确认，日志审计失真
- **测试反向锁死**：`appointment.test.js:147-161` 测试用例名"待确认状态也可签到"**明确测试并断言通过**——此测试锁死了当前宽松行为，后续收敛需先更新测试
- 命中：CC5 跨端一致性；CC9 测试反向锁死（已命名 "待确认状态也可签到" 用例）
- 修复：(L3) staff.checkin 收敛为仅 `'已确认'`，对齐 admin；同步更新 `appointment.test.js` 该用例

#### [P1-06-13] client.appointment.list 包含"已取消 / 已关闭"无过滤
- 文件：`clientApi/routes/appointment.js:131-179`
- 现象：默认无 status 过滤，"已取消 / 已关闭"也返回。前端 UI 列表对客户端是否能在合适页面分 Tab 隐藏未知
- 风险：终态预约和活跃预约混在一起，C 端体验差，下拉重新发起 UI 难以辨识
- 修复：(L3) 默认 `status NOT IN ('已取消','已关闭')`，或保留但在 ORDER BY 中按状态分组（活跃在前）
- 命中：CC8 / 跨端一致性

#### [P1-06-14] admin.confirmAppointment 不写 confirmedAt — **[CLOSED from v1]**
- **v1 状态**：P1，admin `db.update().set({ status: '已确认' })` 不带 confirmedAt
- **v2 确认**：**已修复**。`appointments.ts:186` 已有 `confirmedAt: new Date()`，对齐 staff.confirm（`appointment.js:205` 写 `confirmed_at=$1`）
- **关闭结论**：admin confirm 已写 confirmedAt，v1 P1-06-14 关闭

---

### 3.3 P2（代码质量 / 可维护）

#### [P2-06-15] client.appointment.create 不在事务内、无 advisory lock
- 文件：`clientApi/routes/appointment.js:40-118`
- 现象：3 个 SELECT（user/orderItem/existingAppointments）+ INSERT 全是散查，无 `pg.transaction()`；并发同一 saleItemId 双 create 仍依赖 P0-06-03 的 partial unique 兜底
- 修复：(L3) `pg.transaction()` 包裹，配合 P0-06-03 partial unique 索引彻底解决重复预约
- 命中：CC2

#### [P2-06-16] generateAppointmentId 用 Math.random，碰撞不可控
- 文件：`clientApi/routes/appointment.js:238-240`
- 现象：`'apt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)`；与销售单/服务单格式 `FY-XSD-WX-` / `FY-FW-` 风格不一致；碰撞率极低但不为零，PG 主键依赖 INSERT 失败兜底重试机制全无
- 修复：(L3) 改用 `gen_random_uuid()` 或 advisory lock + `APT-{YYMMDD}NNNN` 格式；(L0) 暂不动 schema text 主键约束
- 命中：CC2 / CC9

#### [P2-06-17] 错误前缀 INVALID_PARAMS 滥用
- 文件：staff `appointment.js:147,189,200,247`；client `appointment.js:69,75,90,199,205`
- 现象：`'INVALID_PARAMS: 预约不存在或不属于本门店'`（应 NOT_FOUND），`'INVALID_PARAMS: 预约状态已变更，请刷新后重试'`（应 CONFLICT），`'INVALID_PARAMS: 该订单明细已有待确认或已确认的预约'`（应 CONFLICT）。前端按错误前缀做 UI 文案映射时全部撞到"参数错误"
- 修复：(L3) 使用 `NOT_FOUND:` / `CONFLICT:` 前缀；与 audit-01 P2-ERROR-12、audit-02 P2-02-17 保持一致
- 命中：CC5 / CROSS-CUTTING.md

#### [P2-06-18] staff.appointment.confirm/checkin 不写 operation_logs
- 文件：`staffApi/routes/appointment.js:203-217,260-270`
- 现象：两个 handler 执行 UPDATE 后无任何 `INSERT operation_logs`；admin 端通过 `logTransition` 全覆盖，staff 端全盲；spec.backend §3.10 line 379 "预约确认/签到/…必写"
- 风险：审计盲区，店长/美容师无法溯源 confirm/checkin 操作轨迹（与 audit-23 操作日志专题相关）
- 修复：(L3) staff.confirm / staff.checkin 末尾 INSERT `operation_logs`，`source='staffApi'`，`operator_employee_id=ctx.auth.staffWfId`
- 命中：CC9 / 跨端一致性

#### [P2-06-19] staff.list 既返格式化字符串（appointmentTime）又返原始 timestamp（checkinAt）
- 文件：`staffApi/routes/appointment.js:103,108`
  ```js
  appointmentTime: formatDateTime(a.appointment_time),  // 'M月D日 HH:mm' 字符串
  checkinAt: a.checkin_at,                              // 原始 timestamp
  ```
- 修复：(L3) 统一返 ISO timestamp，前端 dayjs.tz('Asia/Shanghai').format()
- 命中：CC8

#### [P2-06-20] client.create 使用前端传入的 employee_name，不从数据库反查
- 文件：`clientApi/routes/appointment.js:116`
  ```js
  staffWfId || null, inputStaffName || '',
  ```
  若前端传 "张三" 但 staffWfId 对应 "李四"，DB 上 employee_id=李四 但 employee_name=张三，永久错配
- 风险：员工业绩归属正确，但 UI 展示永远错；spec.staff.pr.spec.md:108 "默认美容师" 路径下风险尤甚
- 修复：(L3) 后端从 `staff_wechat_users` 拉 name，忽略 inputStaffName
- 命中：CC9 / 跨端一致性

#### [NEW-P2-06-D] admin test mock 用 `count` 而非 `rowCount`，测试质量缺陷
- 文件：`fengyu-admin/src/actions/appointments.test.ts:68-71`
  ```ts
  const setupUpdate = (count) => ({ count, rowCount: count })
  ```
- 现象：mock 返回 `{ count }`，生产代码 `appointments.ts:196,235,273` 也用 `(result as any).count === 0`。两端一致性靠意外绑定——Drizzle pg-core 实际返回 `{ rowCount: number }`（不是 `.count`）。测试和生产代码共同用 any 断言，互相掩护了类型漂移
- 风险：若 Drizzle 版本升级返回值结构改变，守卫静默失效：(result as any).count → undefined，`undefined === 0` 为 false，守卫永不触发，0 行更新也返 success
- 命中：CC9 测试与迁移残留 / CC2
- 修复：(L7) `setupUpdate` mock 改为 `({ rowCount: n })`；同时生产代码引入 `assertOneRow(result)` 断言 `result.rowCount === 1`

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| checkin 状态前置 | status='已确认' 严格 | status IN ('待确认','已确认') 宽松 | — | staff 跳过 confirm 直签；测试反向锁死 | P1 |
| checkin 幂等 | 无（覆盖时间，NEW-P1-06-A）| 有（return early）✔ | — | admin 覆写 checkin_at 审计失真 | P1 |
| checkin UPDATE CAS | WHERE status='已确认' | WHERE appointment_id 仅（NEW-P1-06-C）| — | 并发可写 checkin_at 到终态预约 | P1 |
| service.complete → appointment 反推 | 不更新（NEW-P1-06-B）| 写 '已完成' ✔ | — | admin 完单后 appointment 僵尸 '已确认'，阻断再次预约 | P1 |
| confirmed_at 写入 | ✔（appointments.ts:186，**已修**）| ✔ | — | v1 P1-06-14 已关闭 | ~~P1~~ |
| cancel 权限 key | appointment:confirm（错，P0-06-05）| 无 cancel handler | 可取消（无 CAS，P0-06-02）| 权限语义错 / 状态机崩坏 | P0/P0 |
| requirePhone | — | requireStaffBound ✔ | create ✔, list ✗, cancel ✗（P0-06-01）| 客户端认证防线不对称 | P0 |
| 今日视图时区 | CURRENT_DATE（PG 时区）| UTC slice(0,10)（P1-06-07）| +08:00 显式 ✔ | 北京 0-8 点三端不一致 | P1 |
| operation_logs 写入 | ✔ logTransition 全覆盖 | ✗ confirm/checkin 缺（P2-06-18）| ✗ create/cancel 缺 | 审计盲区 | P2 |
| 过期关闭 | cron STEP 1 ✔（**已修复 P0-06-04**）| service.complete 扣零时关闭 ✔ | — | 两路径已覆盖 | ~~P0~~ |
| 时段冲突 | 不校验 | 不校验 | 不校验 | 美容师可重叠预约 | P1 |
| client list 状态过滤 | tab all/pending/confirmed/today | 接受任意 status | 默认全部含已取消/已关闭 | 终态混排（P1-06-13）| P1 |
| 错误前缀 | throw new Error() | INVALID_PARAMS | INVALID_PARAMS | admin 与 staff/client 不对齐 | P2 |

---

## 5. 横切检查

- [x] **CC1 数值精度**：本域无金额计算，OK
- [ ] **CC2 并发幂等**：
  - [P0-06-02] client.cancel UPDATE 无 CAS
  - [P0-06-03] service_orders.appointment_id 无 partial UNIQUE（TOCTOU）
  - [NEW-P1-06-C] staff.checkin UPDATE 无 status CAS
  - [NEW-P1-06-A] admin.checkin 无 checkin_at IS NULL 幂等
  - [P2-06-15] client.create 无事务
  - [NEW-P2-06-D] test mock 与生产代码共用 any 类型，互相掩护
- [ ] **CC3 组织域隔离**：
  - [P1-06-09] staff list 硬拼 effectiveStoreId，管理层模式空集；detail/confirm/checkin 也用 effectiveStoreId 作为 AND 条件，管理层 null → 预约查不到（安全失败而非越权）
- [ ] **CC4 后端鉴权**：
  - [P0-06-01] client list/cancel 缺 requirePhone
  - [P0-06-05] admin cancel 错权限 key
- [ ] **CC5 错误码**：
  - [P2-06-17] INVALID_PARAMS 覆盖 NOT_FOUND/CONFLICT 语义
- [x] **CC6 PII**：staff detail JOIN client_wechat_users 含 phone，仅门店内员工可查，可接受
- [ ] **CC7 时间字段**：
  - [P1-06-07] staff todayOnly UTC vs admin CURRENT_DATE
  - [NEW-P1-06-A] admin checkin 覆写 checkin_at
  - [P2-06-19] staff list 混返格式化字符串与原始 timestamp
- [ ] **CC8 WXML/Vant**：
  - [P1-06-13] client list 终态混排
  - [P2-06-19] staff UI 既收到 formatted appointmentTime string 又收到 raw checkin_at
- [ ] **CC9 测试与迁移残留**：
  - `appointment.test.js:147` "待确认状态也可签到" 测试反向锁死宽松行为（P1-06-11）
  - `appointments.test.ts:68-71 setupUpdate` mock 返 `{ count }` 而非 `{ rowCount }`，与 Drizzle 规范不符（NEW-P2-06-D）
  - service_orders 无 appointment_id partial UNIQUE 迁移（P0-06-03）
  - admin completeServiceOrder 无 appointment 反推，无测试覆盖（NEW-P1-06-B）
  - [CLOSED] P0-06-04 过期关闭 spec 与实现脱节 → 已落地

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 migration | 新迁移 | `CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;` | P0-06-03 |
| L0 migration | 新迁移 | 加 `(sale_item_id) WHERE status IN ('待确认','已确认')` partial unique（彻底解 TOCTOU）| P0-06-03 / P2-06-15 |
| L0 migration | 新迁移 | 加 `(employee_id, appointment_time) WHERE status IN ('待确认','已确认')` partial unique 或 EXCLUDE gist | P1-06-06 |
| L0 permissions | `fengyu-admin/src/lib/permissions.ts` PERMISSION_MATRIX.manager | 增加 `'appointment:cancel'` | P0-06-05 |
| L3 client routes | `clientApi/routes/appointment.js:131,185` | 顶部各加 `await requirePhone()(ctx, async () => {})` | P0-06-01 |
| L3 client routes | `clientApi/routes/appointment.js:208-213` | UPDATE 加 `AND client_user_id=$4 AND status IN ('待确认','已确认')`，检查 rowCount | P0-06-02 |
| L3 client routes | `clientApi/routes/appointment.js:40-118` | pg.transaction 包裹 create | P2-06-15 |
| L3 staff routes | `staffApi/routes/appointment.js:246` | checkin 收敛为仅 `'已确认'`，对齐 admin | P1-06-11 |
| L3 staff routes | `staffApi/routes/appointment.js:260-264` | UPDATE 加 `AND status IN ('待确认','已确认') AND checkin_at IS NULL` | NEW-P1-06-C |
| L3 staff routes | `staffApi/routes/appointment.js:50` | 用 `buildStoreScopeCondition` 替换硬拼 effectiveStoreId | P1-06-09 |
| L3 staff routes | `staffApi/routes/appointment.js:203,260` | confirm/checkin 末尾 INSERT operation_logs | P2-06-18 |
| L3 staff service | `staffApi/routes/service.js:55-69` | appointmentId 重复检查移入事务，ON CONFLICT 兜底 | P0-06-03 |
| L3 staff service | `staffApi/routes/appointment.js:60` | today 查询用 PG `CURRENT_DATE` 或 AT TIME ZONE 'Asia/Shanghai' | P1-06-07 |
| L7 admin actions | `admin/actions/appointments.ts:225-230` | checkin WHERE 加 `and(isNull(appointments.checkinAt))`，rowCount=0 分支区分"已签到"vs"状态变更" | NEW-P1-06-A |
| L7 admin actions | `admin/actions/appointments.ts:250` | cancel 改 `requirePermission(session, 'appointment:cancel')` | P0-06-05 |
| L7 admin actions | `admin/actions/appointments.ts:196,235,273` | 抽 `assertOneRow(result)` 断言 `result.rowCount===1` | P1-06-08 / NEW-P2-06-D |
| L7 admin service | `admin/actions/services.ts:360-397` | completeServiceOrder CTE 增加 appointment status→'已完成' UPDATE | NEW-P1-06-B |
| L7 业务策略 | system_configs | 加 `appointment.cancel_lead_minutes` 配置项 | P1-06-10 |
| L9 staff test | `staffApi/__tests__/routes/appointment.test.js:147-161` | 更新"待确认状态也可签到"用例为"待确认状态不可签到"（收敛后）| P1-06-11 |
| L9 admin test | `admin/src/actions/appointments.test.ts:68-71` | setupUpdate mock 改为返回 `{ rowCount: n }` 对齐 Drizzle 规范 | P1-06-08 / NEW-P2-06-D |
| L9 client UI | `client appointment list 页` | 默认隐藏 '已取消'/'已关闭'，加切换 | P1-06-13 |
| L9 staff UI | `staff appointment list 页` | 统一前端 dayjs.tz 格式化 | P2-06-19 |

---

## 7. 验证 SQL（在 5434 EXPLAIN/SELECT，禁止写入）

```sql
-- #1 P0-06-03: 同一 appointment 关联多条 service_orders
SELECT appointment_id, COUNT(*) AS cnt
FROM service_orders
WHERE appointment_id IS NOT NULL
GROUP BY appointment_id
HAVING COUNT(*) > 1;

-- #2 P0-06-03: 同一 sale_item 存在多个活跃预约（partial unique 前置验证）
SELECT sale_item_id, COUNT(*) AS cnt
FROM appointments
WHERE sale_item_id IS NOT NULL
  AND status IN ('待确认', '已确认')
GROUP BY sale_item_id
HAVING COUNT(*) > 1;

-- #3 NEW-P1-06-B: service_order 已完成但关联 appointment 仍 '已确认'（admin 完单路径脏数据）
SELECT a.appointment_id,
       a.status AS appt_status,
       so.service_order_id,
       so.status AS so_status,
       so.completed_at
FROM appointments a
JOIN service_orders so ON so.appointment_id = a.appointment_id
WHERE so.status = '已完成'
  AND a.status = '已确认'
LIMIT 50;

-- #4 P0-06-05: 验证当前 permission_matrix 缺失 'appointment:cancel'（manager 仅有 confirm）
SELECT r.role, r.action, r.scope_type
FROM permission_roles r
WHERE r.role = 'manager'
  AND r.action LIKE 'appointment:%';

-- #5 NEW-P1-06-A: admin.checkin 历史覆写迹象（只读，无法区分历史覆写）
SELECT COUNT(*) AS total_checkins,
       COUNT(checkin_at) AS has_checkin_at
FROM appointments
WHERE checkin_at IS NOT NULL
  AND status IN ('已确认', '已完成');

-- #6 P1-06-11: 待确认状态但 checkin_at 非空（staff 跳过 confirm 直签的存量数据）
SELECT appointment_id, status, checkin_at, confirmed_at
FROM appointments
WHERE status = '待确认'
  AND checkin_at IS NOT NULL
LIMIT 20;

-- #7 P1-06-14: admin 路径 confirmed_at 缺失比例（v2 已修，验证历史数据）
SELECT count(*) FILTER (WHERE confirmed_at IS NULL) AS null_count,
       count(*) AS total,
       round(100.0 * count(*) FILTER (WHERE confirmed_at IS NULL) / NULLIF(count(*),0), 2) AS null_pct
FROM appointments
WHERE status IN ('已确认','已完成');

-- #8 EXPLAIN: staff.list effectiveStoreId=null 路径（确认 store_id=NULL 不命中索引）
EXPLAIN SELECT * FROM appointments a WHERE a.store_id = NULL LIMIT 10;

-- #9 P1-06-06: 同员工同时段重叠预约
SELECT employee_id, appointment_time, COUNT(*) AS cnt
FROM appointments
WHERE status IN ('待确认', '已确认')
GROUP BY employee_id, appointment_time
HAVING COUNT(*) > 1
LIMIT 50;
```

---

## 8. 回归测试用例

1. **P0-06-01 鉴权**：mock `ctx.auth = {userId:'u1', phone:null}` → `appointment.list` → 期望 PHONE_REQUIRED -403
2. **P0-06-02 CAS**：构造 status='已完成' 行 → client.cancel → 期望 rowCount=0 → "预约状态不允许取消"
3. **P0-06-03 partial unique**：两个并发 staff.service.create 同一 appointmentId → 期望第二个 catch 23505 → "该预约已关联服务单"
4. **P0-06-05 权限**：用只有 `appointment:confirm` 但无 `appointment:cancel` 的 session 调 admin.cancelAppointment → 修复后期望 PERMISSION_DENIED（当前因共用 key 测试会通过，是回归测试）
5. **P1-06-11 跳过 confirm**：staff.checkin status='待确认' → 修复后期望 INVALID_PARAMS "请先确认预约"；同步更新测试用例名
6. **NEW-P1-06-C 并发 checkin**：mock SELECT=已确认→UPDATE rowCount=0（模拟另一请求同时取消）→ 期望"预约状态已变更"
7. **NEW-P1-06-A 重复 checkin**：admin.checkinAppointment 调用 2 次 → 修复后 `checkin_at` 不变（第二次返"已签到"）
8. **NEW-P1-06-B admin complete → appointment**：admin.completeServiceOrder → 期望关联 appointment.status='已完成'（当前失败，无测试覆盖）
9. **P1-06-09 管理层**：mock `effectiveStoreId=null` → staff.appointment.list → 修复后应返全 scope 内预约而非空集
10. **cron 过期关闭**（v1 P0-06-04 已实现验收）：插入 appointment_time = now-2days, status='已确认' → 跑 cron `--once` → status='已关闭', operation_logs 有记录

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB）**：☑（appointmentStatus + service_orders.appointment_id FK + cron + admin/staff/client 三路径）
- 涉及历史数据：☑（验证 SQL #2/#3/#6/#7 可揭示已有脏数据）
- 修复成本：**M**
  - L0：2 条 partial unique 迁移（低风险，仅 WHERE NOT NULL 行）
  - L3：6 处 client/staff 路由调整（requirePhone + CAS + 幂等 + scope）
  - L7：3 处 admin action/service 调整（checkin 幂等、cancel 权限、completeServiceOrder 反推）
  - L9：2 处测试更新（取消/签到行为 + mock rowCount）

---

## 10. 后续待办

- [ ] 确认 `uq_so_appointment` partial unique 是否与线上数据冲突（先跑 §7 #1）
- [ ] 确认 `(sale_item_id) WHERE status IN ('待确认','已确认')` partial unique 是否影响历史数据（先跑 §7 #2）
- [ ] 与 PM 对齐 staff.checkin 是否允许"待确认"状态签到（P1-06-11 政策决策，当前测试锁死宽松行为）
- [ ] admin.completeServiceOrder 反推 appointment 时是否同步处理"扣到 0 → 已关闭"逻辑（staff 有，admin 无）（NEW-P1-06-B）
- [ ] 客户端预约取消"窗口时间"业务策略（P1-06-10）— 至少给一个 system_configs 钩子
- [ ] 与 audit-05（服务单）整合：service_orders.appointment_id partial unique 同批迁移落地
- [ ] 与 audit-23（操作日志）协调：staff confirm/checkin 写 operation_logs（P2-06-18）
- [ ] `appointments.test.ts` mock setupUpdate 改为 `{ rowCount }` 同步落地（NEW-P2-06-D）

---

## 附：跨端一致性新增条目

- CROSS-CUTTING.md "状态机 UPDATE 缺 CAS 守卫" 后续命中（P0-06-02 client.cancel / NEW-P1-06-C staff.checkin）
- CROSS-CUTTING.md "Staff 路由 scope 过滤非全覆盖" 后续命中（P1-06-09）
- CROSS-CUTTING.md "三端时区不一致" 后续命中（P1-06-07）
- CROSS-CUTTING.md "TOCTOU 校验：事务外读 → 事务内 INSERT" 后续命中（P0-06-03 / P2-06-15）
- CROSS-CUTTING.md "admin service complete 缺跨实体状态反推"（NEW-P1-06-B）
- 新增条目 CC4 "Client 路由 list/cancel 忘记 requirePhone()"（P0-06-01）
- 新增条目 CC9 "测试反向锁死：mock 用 count 而非 rowCount + 业务行为测试锁死宽松行为"（NEW-P2-06-D / P1-06-11）
