# 审计报告：预约 + 签到 → 服务单流转 (06)

**审计时间**：2026-04-25
**域 ID**：06
**审计员**：claude-opus-4-7（opus-4-7-1m）
**审计时长**：~25 min
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/appointment.ts:16-47` + `db/schema/service.ts:31-32`（`service_orders.appointment_id` FK） | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:70` `appointmentStatusEnum`：`待确认 / 已确认 / 已完成 / 已取消 / 已关闭`（5 值） | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/appointments.ts:37-283`（list / paginated / confirm / checkin / cancel） | `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:1-273`（list / detail / confirm / checkin） | `fengyu-client/cloudfunctions/clientApi/routes/appointment.js:1-246`（create / list / cancel） |
| 前端 | `fengyu-admin/src/app/(main)/appointments/page.tsx:1-39` + `_components/appointments-page.tsx:1-232` | `fengyu-staff/miniprogram/pages/appointment/*` | `fengyu-client/miniprogram/pages/appointment/*` |
| 服务单创建 | `fengyu-admin/src/actions/services.ts:444-561 createServiceOrder`（携带 `appointmentId`） | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:21-233 create`（携带 `appointmentId`） | — |
| 关联反推 | — | `staffApi/routes/service.js:462-466 complete` 完成时把关联 appointment 置 `已完成`，`375-385` 扣到 `remaining_sessions=0` 时把对应 sale_item 上待 / 已确认预约置 `已关闭` | — |
| 测试 | `fengyu-admin/src/actions/appointments.test.ts` | — | — |
| 入口路由 | `appointments/page.tsx` server-side 调 `getAppointmentsPaginated()` | `staffApi/index.js` action `appointment.{list,detail,confirm,checkin}` | `clientApi/index.js:46-48` action `appointment.{create,list,cancel}` |

## 2. 数据流图

```
client.create
  ├─ requirePhone() ✔
  ├─ 校验 saleItem 归属 + remaining_sessions > 0
  ├─ 校验该 saleItemId 不存在 ('待确认','已确认') 预约（事务外 SELECT，无 partial unique 兜底）
  └─ INSERT appointments status='待确认' （无事务、无 advisory lock）

staff.confirm   待确认 → 已确认 (CAS) + 写 confirmed_at
staff.checkin   仅写 checkin_at（appointment.status 不变）✔ 与 spec AC-16 一致
admin.confirm   待确认 → 已确认 (CAS, scopeCondition)
admin.checkin   仅写 checkin_at（CAS WHERE status='已确认'）
admin.cancel    (待确认|已确认) → 已取消 (CAS) ★ 但用 'appointment:confirm' 权限
client.cancel   (待确认|已确认) → 已取消（无 CAS、无 requirePhone）

staff.service.create(appointmentId)
  ├─ 事务外 SELECT 校验 appointment.status='已确认' + 同店
  ├─ 事务外 SELECT 校验 service_orders.appointment_id 未占用（无 partial unique 兜底）
  └─ pg.transaction：INSERT service_orders + service_items
        — 不更新 appointment.status

staff.service.complete  服务中 → 已完成
  ├─ 原子扣 remaining_sessions
  ├─ 若扣到 0：UPDATE appointments SET status='已关闭' WHERE sale_item_id=$ AND status IN ('待确认','已确认')
  ├─ UPDATE service_orders status='已完成'（CAS）
  └─ 若 so.appointment_id：UPDATE appointments SET status='已完成' WHERE appointment_id=$ AND status='已确认'

cron / 过期关闭机制：缺失 — 无任何 STEP 会将"过期未到店"appointment 置 '已关闭'
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-06-01] client.appointment.list / client.appointment.cancel 缺 requirePhone()，userId 可为 null
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:131-179, 185-221`
- 现象：`list`、`cancel` 直接 `const { userId } = ctx.auth`，但 auth 中间件在未注册用户时 `userId: null`（`middleware/auth.js:53-61`）。`appointment.create` 上方有 `await requirePhone()(ctx, ...)`，list/cancel 完全没有。
- 风险：未绑定手机号的用户调 `appointment.list` 会带 `WHERE client_user_id = NULL` → PG 中等价 `NULL = NULL` 返空。但 `appointment.cancel` 一旦攻击者构造 `appointmentId` 任意值，`SELECT * FROM appointments WHERE appointment_id=$1 AND client_user_id=$2` 因 `$2=NULL` 返空，正常无害；**但若用户曾 unbind phone（`client_wechat_users.phone` 置空）→ `userId` 仍非 null → 仍可越权操作历史预约**。同时与 P0-06-02 叠加：`list` 未带 status 过滤时把"已关闭"系统单暴露给端点。
- 复现：1) 让一个绑定过 phone 的客户端"解绑"phone 后；2) 调 `appointment.cancel` 仍可用；3) `requirePhone()` 防线缺失。
- 修复：(L3) 三个 handler 顶部全部加 `await requirePhone()(ctx, async () => {})`，对齐 `create`。
- 命中：CC4 后端鉴权 / real.md #5 后端统一鉴权

#### [P0-06-02] client.appointment.cancel 状态 UPDATE 缺 CAS 守卫
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:208-214`
- 现象：
  ```js
  await pg.query(
    `UPDATE appointments SET status='已取消', cancelled_reason=$1, updated_at=$2
     WHERE appointment_id=$3`,
    [cancelledReason||'', now, appointmentId]
  )
  ```
  WHERE 仅按 appointmentId，应用层先 SELECT 校验 `status IN ('待确认','已确认')`（line 204），但属事务外 TOCTOU 模式。并发下：员工已 confirm 完成（A 事务后），客户取消（B 事务）仍可把 '已确认' / 甚至 '已完成' 强行覆盖为 '已取消'。
- 风险：实际已结束服务的预约被回退为已取消；service.complete 时（line 463-466）`UPDATE appointments SET status='已完成' WHERE status='已确认'` 已有 CAS，但 client.cancel 的非 CAS UPDATE 可能在该事务前后插入；联动 `service.complete` 闭环判断会失效。状态机崩坏。
- 复现：1) 客户在 staff.confirm 之后、staff.complete 之前发起 cancel；2) 服务已经在做，complete 失败（`已确认` 已被覆盖）；3) 顾客侧记录"已取消"但 service_orders 仍 `已完成`，预约/服务两表语义反向。
- 修复：(L3) `UPDATE ... WHERE appointment_id=$3 AND client_user_id=$? AND status IN ('待确认','已确认')`，并校验 `result.rowCount===1`。
- 命中：real.md #4 状态单向推进 / CC2 并发幂等 / CROSS-CUTTING.md "状态机 UPDATE 缺 CAS 守卫" 后续命中

#### [P0-06-03] service_orders.appointment_id 缺 partial UNIQUE，TOCTOU 重复绑定
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:55-69`
- 现象：staff.service.create 在 `pg.transaction` **外部** 用 `pg.query` 校验 `SELECT service_order_id FROM service_orders WHERE appointment_id = $1`（line 63-66），没有匹配的 partial unique 索引。两个并发 create 同一 appointmentId 会都通过校验、各自 INSERT 一条 service_orders 关联同一预约。`db/migrations/0000_baseline.sql:547` 仅有 FK 无唯一索引。
- 风险：一预约关联 N 条服务单（违反 spec.staff §3.7 "一预约一服务单"），`staffApi/routes/appointment.js:138-142` 详情页 LEFT JOIN service_orders ON appointment_id 会拿到第一条；`staff.service.complete` 触发 `UPDATE appointments WHERE appointment_id=$ AND status='已确认'` 在第二个 service.complete 时报"状态已变更"。次数被双扣（spec real.md #1 次数防超卖隐患）。
- 复现：审计 SQL 见 §7 #1。
- 修复：(L0) 加 `CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;`（与 audit-05 S05-2 同款，本域复用）；(L3) staff.create 把"appointmentId 已占用"校验移入事务内并 ON CONFLICT 兜底。
- 命中：real.md #1 次数防超卖 / CC2 并发幂等 / 与 audit-05 P0-05-03 同源

#### [P0-06-04] 过期预约关闭机制完全缺失（spec 5.3 状态机未实现）
- 文件：cron/`fengyu-admin/src/cron/steps/*.ts`（共 5 STEP，无 appointment-close 任何 STEP）
- 现象：
  - `db/schema/appointment.ts:14` 与 `.42cog/pm/backend.pr.spec.md:709-710` 都规定 `待确认/已确认 → 已关闭（超过预约时间一天未到店）`。
  - 全仓 grep `已关闭` + `appointments`：唯一一处写入是 `staffApi/routes/service.js:380` 在次数归零时把同 sale_item 的预约置 `已关闭`。无任何定时任务、SQL 触发器、应用层兜底为"过期未到店"做关闭。
- 风险：
  1. 过期的"待确认/已确认"预约**永远占用** `(saleItemId, status IN ('待确认','已确认'))` 锁位，client.create 重试同 saleItemId 永远报 "INVALID_PARAMS: 该订单明细已有待确认或已确认的预约"（line 89-91），用户陷入死锁。
  2. staff 端 list 包含已过期预约，前端"今日"Tab + 美容师视图被脏数据淹没。
  3. dashboard 当天预约数膨胀。
- 复现：1) 客户预约一个明天 10:00；2) 第二天 23:59 仍未到店、未被店员手动取消；3) 数据库观察该预约直到 `service.complete` 把次数扣完之前永远是"已确认"。
- 修复：(L3) 在 `fengyu-admin/src/cron/steps/` 加 `close-expired-appointments.ts`：`UPDATE appointments SET status='已关闭', updated_at=NOW() WHERE status IN ('待确认','已确认') AND appointment_time < NOW() - INTERVAL '1 day'`；写 operation_logs。可选 (L0) 对 `appointment_time` 加 `(status, appointment_time)` 复合索引。
- 命中：real.md #4 状态单向推进 / CC9 测试与迁移残留（spec 与实现差异）

#### [P0-06-05] admin.cancelAppointment 用 'appointment:confirm' 权限而非独立 cancel 权限
- 文件：`fengyu-admin/src/actions/appointments.ts:248-250`、`fengyu-admin/src/lib/permissions.ts:48`
- 现象：cancelAppointment 顶部 `requirePermission(session, 'appointment:confirm')`。permissions.ts 仅声明 `'appointment:list', 'appointment:confirm', 'appointment:checkin'` 三个 action。**admin 端没有 appointment:cancel 权限项**。
- 风险：
  - 任何被授予 `appointment:confirm` 的角色（manager 默认含此 action，line 48）自动能取消任意预约。语义错位：拥有"确认权"的人不一定有"取消权"。
  - 权限矩阵即文档，此处隐式合约破坏（与 audit-02 P0-02-05 同模式）。
- 修复：(L0) `permissions.ts` PERMISSION_MATRIX 增加 `'appointment:cancel'` 并按角色精细化授予；(L7) cancelAppointment 改用 `requirePermission(session, 'appointment:cancel')`。
- 命中：real.md #5 后端统一鉴权 / CC4

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-06-06] 同员工同时段冲突检查完全缺失
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:108-118`、`staffApi/routes/appointment.js:204-217`
- 现象：client.create 既不校验 `(employeeId, appointment_time)` 时段冲突，也不校验同顾客已有"待确认"预约的时间冲突。`db/schema/appointment.ts:45` 有索引 `idx_appts_employee_time` 但只是为查询服务，无 EXCLUDE / unique。staff.confirm 也不校验"已有同员工同时段已确认预约"。
- 风险：5 个客户在同一员工的同一 09:00-11:00 时段全部预约成功，`spec` 隐含的"美容师工作日历"完全无效。前端 `appointableItems` 不返回时段（依赖前端自维 5 时段，无后端兜底）。
- 修复：(L0) 加 `EXCLUDE USING gist (employee_id WITH =, tsrange(appointment_time, appointment_time + interval '2 hour') WITH &&) WHERE status IN ('待确认','已确认')`（需要 btree_gist），或简化 partial unique `(employee_id, appointment_time) WHERE status IN ('待确认','已确认')`；(L3) staff.confirm 在 CAS UPDATE 前校验同员工同时段 `status='已确认'` 数量 ≤ 0。
- 命中：CC2 并发幂等

#### [P1-06-07] 三端时区不一致命中（dateStr 用 UTC vs PG NOW）
- 文件：`staffApi/routes/appointment.js:60`、`clientApi/routes/appointment.js:231`、`admin/actions/appointments.ts:105`
- 现象：
  - staff.list todayOnly：`new Date().toISOString().slice(0,10)` UTC 0 时为分界
  - client.create parseAppointmentTime：`new Date(\`${match[1]}T${match[2]}:00+08:00\`)` 显式 +8（OK）
  - admin getAppointmentsPaginated today tab：`appointment_time >= CURRENT_DATE`（PG 服务器时区，如未设 Asia/Shanghai 则 UTC）
- 风险：北京时间 00:00–08:00 期间 staff "今日" Tab 与 admin "今日" Tab 显示集合不重叠；同样命中 audit-02 P0-02-02 / CC7 已记录条目。
- 修复：(L0) 集群级 `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'`（SCHEMA-CHANGES S02-3 已记录）；(L3) staff `today` 改用 PG `CURRENT_DATE` 派发。
- 命中：CC7 / CROSS-CUTTING.md "三端时区不一致"

#### [P1-06-08] admin.confirm/checkin/cancel 三端 UPDATE rowCount 类型断言不严
- 文件：`fengyu-admin/src/actions/appointments.ts:184-198, 222-237, 261-275`
- 现象：三处都用 `(result as any).count === 0` 兜底；Drizzle pg-core 的 `.update()` 返回值类型实际是 `{ rowCount: number }` 而非 `count`。仅靠 any 断言判定；当 driver 升级时静默退化。
- 风险：CAS 守卫看似生效，实际可能永远 truthy → confirm/checkin/cancel 全成功提示但底层 0 行更新被吞掉，前端 `router.refresh()` 后值不变形成"幽灵 success"。
- 修复：(L7) 抽 `assertOneRow(result)` helper，断言 `result.rowCount === 1`；与 services / orders 等 actions 同款（参考 audit-05 §3.2）。
- 命中：CC9 测试与迁移残留

#### [P1-06-09] staff.appointment.list 美容师过滤缺管理层模式分支
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:50, 66-69`
- 现象：line 50 直接用 `ctx.auth.effectiveStoreId` 作为唯一门店过滤值。`staffApi/CLAUDE.md` 明确："业务 SQL 必须使用此字段；管理层模式 = null"。`buildStoreScopeCondition` 有专用 helper 但本路由没用。当总部 / 市场 staffLevel 用户以 `loginLevel='management'` 登录时 `effectiveStoreId=null` → SQL `WHERE a.store_id = NULL` 永远空集。
- 风险：与 audit-05 P1-05-10 同源。管理层无法看任意预约，必须降级为门店模式才有数据。
- 修复：(L3) 改用 `buildStoreScopeCondition(ctx.auth, 'a.store_id', $n)`。
- 命中：CC3 / CROSS-CUTTING.md "Staff 路由 scope 过滤非全覆盖" 后续命中

#### [P1-06-10] client.appointment.cancel 无取消窗口 / 无 lead time 限制
- 文件：`clientApi/routes/appointment.js:185-221`
- 现象：spec.client.pr.spec.md:200 "取消后可重新发起（系统关闭的不可）"，仅约束重发不约束何时可取消。但常识业务规则（提前 N 小时不可取消，避免店员空挡）在三端均缺失；无 `appointment_time - now > X minutes` 校验。
- 风险：客户在到店前 1 分钟取消，员工已备料 / 占工位但无补偿。
- 修复：(L7 业务策略) 在 system_configs 加 `appointment.cancel_lead_minutes`（如 120 分），client.cancel 校验 `parsedTime - now >= lead`。
- 命中：CC2 / CC9（与业务规范补全相关）

#### [P1-06-11] admin.checkin 强校验 status='已确认' 但 staff.checkin 接受 '待确认'+'已确认'
- 文件：`admin/actions/appointments.ts:225-230` vs `staffApi/routes/appointment.js:246`
- 现象：admin checkin CAS `WHERE status='已确认'`；staff checkin 允许 `['待确认','已确认']`（line 246），实际未要求"已确认"前置。
- 风险：staff 直接跳过 confirm 给客户签到，状态机逻辑分裂；spec.staff `5.3 预约状态机` 隐含 confirm 是 checkin 前置。后端管理日志 `logTransition('appointment.checkin', ..., '已确认', '已签到')`（admin/actions/appointments.ts:239）写死 from='已确认'，与 staff 行为不一致 → admin 看 logs 还原不出真实状态轨迹。
- 修复：(L3) staff.checkin 收敛到仅 '已确认'，对齐 admin。
- 命中：CC5 / 跨端一致性

#### [P1-06-12] admin.checkinAppointment 没有 idempotency 分支（重复签到覆盖时间）
- 文件：`admin/actions/appointments.ts:222-230`
- 现象：admin UPDATE 直接 `set({ checkinAt: new Date() })` 不像 staff 那样在 line 251-258 检查 `if (appt.checkin_at)` 幂等返回。
- 风险：admin 多次点击 / 误操作 → checkin_at 被反复覆盖为最新时刻，签到时间审计失真。
- 修复：(L7) admin checkin CAS 加 `AND checkin_at IS NULL`，rowCount=0 时返"已签到（幂等）"。
- 命中：CC2 / CC7

#### [P1-06-13] client.appointment.list 包含"已取消 / 已关闭"无过滤
- 文件：`clientApi/routes/appointment.js:131-179`
- 现象：默认无 status 过滤，"已取消 / 已关闭"也返回。前端 UI 列表对客户端是否能在合适页面分 Tab 隐藏未知。
- 风险：终态预约和活跃预约混在一起，C 端体验差，下拉重新发起 UI 难以辨识。
- 修复：(L3) 默认 `status NOT IN ('已取消','已关闭')`，或保留但在 ORDER BY 中按状态分组（活跃在前）。
- 命中：CC8 / 跨端一致性

#### [P1-06-14] confirmedAt 仅 staff.confirm 写入，admin.confirmAppointment 不写
- 文件：`admin/actions/appointments.ts:184-194` vs `staffApi/routes/appointment.js:204-207`
- 现象：staff confirm 写 `confirmed_at = $1`（line 205）；admin `db.update().set({ status: '已确认' })` 不带 confirmedAt。schema `appointments.confirmedAt`（appointment.ts:35）注释"员工确认预约时记录"。
- 风险：admin 操作的预约 confirmed_at 永远 NULL；统计"确认到签到时长"分布漏掉 admin 路径数据。
- 修复：(L7) admin.confirmAppointment `set({ status: '已确认', confirmedAt: new Date() })`。
- 命中：CC7 时间字段责任

### 3.3 P2（代码质量 / 可维护）

#### [P2-06-15] client.appointment.create 不在事务内、无 advisory lock
- 文件：`clientApi/routes/appointment.js:108-118`
- 现象：3 个 SELECT（user / orderItem / existingAppointments）+ INSERT 全在 pool 散查，无事务包裹；并发同一 saleItemId 双 create 仍依赖 P0-06-03 的同款 partial unique 兜底。
- 修复：(L3) `pg.transaction(async (client) => { ... })`，配合 P0-06-03 的 partial unique 索引可彻底解决重复预约。
- 命中：CC2

#### [P2-06-16] generateAppointmentId 用 Math.random，碰撞不可控
- 文件：`clientApi/routes/appointment.js:238-240`
- 现象：`'apt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)`；与销售单 / 服务单格式 `FY-XSD-WX-` / `FY-FW-` 不一致；`Math.random` 概率冲突极低但不为 0，且 PG 主键依赖 INSERT 失败兜底重试机制全无。
- 修复：(L3) 改用 `gen_random_uuid()` 或与服务单同款 advisory lock + day-序号 `APT-{YYMMDD}NNNN`；(L0) 暂不动 schema text 主键约束。
- 命中：CC2 / CC9

#### [P2-06-17] 错误前缀使用 INVALID_PARAMS 滥用
- 文件：staff `appointment.js:147,189,200,210,236,247`、client `appointment.js:69,75,79,90,97,190,199,205`
- 现象：`'INVALID_PARAMS: 预约不存在或不属于本门店'`、`'INVALID_PARAMS: 预约状态已变更，请刷新后重试'`、`'INVALID_PARAMS: 该订单明细已有待确认或已确认的预约'` 等。第一类应是 NOT_FOUND，第二类应是 CONFLICT，第三类应是 CONFLICT。前端按错误前缀做 UI 文案映射时全部撞到 "参数错误"。
- 修复：(L3) 使用 `NOT_FOUND:` / 新增 `CONFLICT:` 前缀；与 audit-01 P2-ERROR-12、audit-02 P2-02-17 保持一致改造方向。
- 命中：CC5 / CROSS-CUTTING.md

#### [P2-06-18] staff.appointment.confirm/checkin 不写 operation_logs
- 文件：`staffApi/routes/appointment.js:204-218, 260-271`
- 现象：staff confirm / checkin 仅 UPDATE，未 INSERT `operation_logs`。admin 三端均通过 `logTransition` 写日志（appointments.ts:200, 239, 277），spec.backend §3.10 line 379 "记录时机：…预约确认/签到/…必写"。
- 风险：审计盲区，店长 / 美容师无法溯源 confirm/checkin 操作轨迹（与 audit-23 操作日志专题相关）。
- 修复：(L3) staff.confirm / staff.checkin 末尾 INSERT operation_logs，`source='staffApi'`，`operator_employee_id=ctx.auth.staffWfId`。
- 命中：CC9 / 跨端一致性

#### [P2-06-19] formatDateTime 在 staff routes 重复定义且语义不清
- 文件：`staffApi/routes/appointment.js:15-26`
- 现象：手动 +8 hour 转 Beijing 字符串，返给前端 `'M月D日 HH:mm'`。同时 `checkinAt` 字段又传原始 timestamp（line 108）→ 同一 payload 既有"已格式化字符串"又有"原始 ISO timestamp"，前端混淆。
- 修复：(L3) 后端只返 ISO timestamp，前端统一 dayjs.tz('Asia/Shanghai').format(...)。
- 命中：CC8

#### [P2-06-20] employeeId 入参 staff.create 之后名称仍用前端传参 staffName
- 文件：`clientApi/routes/appointment.js:24, 116`
- 现象：appointment.create 接受 `inputStaffName`（前端传），不去 staff_wechat_users 反查，直接落 employee_name。如前端传 "张三" 但 staffWfId 实际指向 "李四"，DB 上 employee_id=李四 但 employee_name=张三 永久错配。
- 风险：员工业绩归属正确，但 UI 展示永远错；spec.staff.pr.spec.md:108 "默认美容师" 路径下风险尤甚。
- 修复：(L3) 后端从 staff_wechat_users 拉 name，忽略 inputStaffName。
- 命中：CC9 / 跨端一致性

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 状态机 cancel 范围 | 待确认/已确认 → 已取消 | 无 cancel handler | 待确认/已确认 → 已取消 | staff 端无原生 cancel handler，店长只能走 admin 或不能取消？ | P1 |
| status="已确认" → "已完成" 触发 | 无（admin completeServiceOrder 不更新 appointment）| service.complete 时 ✔ | — | admin 完成服务单时 appointment 状态卡在 "已确认" 永远不变 "已完成" | P1 |
| confirmed_at 写入 | ✗ admin.confirm 不写 | ✓ staff.confirm 写 | — | admin 路径下 confirmed_at 永远 null（P1-06-14） | P1 |
| checkin 状态前置 | status='已确认' 严格 | status IN ('待确认','已确认') 宽松 | — | staff 跳过 confirm 直签 | P1 |
| checkin 幂等 | 无（覆盖时间） | 有（return early） | — | admin 覆写时间审计失真（P1-06-12） | P1 |
| 状态过滤（list） | tab 'all'/'pending'/'confirmed'/'today' | 接受任意 status，默认全部 | 默认全部（含已取消/已关闭） | client 列表脏 | P1 |
| operation_logs 写入 | ✓ logTransition 全覆盖 | ✗ confirm/checkin 不写 | ✗ create/cancel 不写 | 审计盲区 | P2 |
| 错误前缀 | 无前缀（throw new Error('xxx')） | INVALID_PARAMS / PERMISSION_DENIED | INVALID_PARAMS / PERMISSION_DENIED | admin 与 staff/client 不对齐 | P2 |
| 时区分界 | PG CURRENT_DATE | UTC slice(0,10) | +08:00 | 跨午夜 8h 三端"今日"视图差异（P1-06-07） | P1 |
| 时段冲突 | 不校验 | 不校验 | 不校验 | 美容师可重叠预约 | P1 |
| 已确认→已完成自动反推 | service.complete 不写 | service.complete 写 ✔ | — | admin 完单后预约状态僵尸 | P1 |

## 5. 横切检查（套用 §3 模板）

- [x] CC1 数值精度：本域无金额计算 → OK
- [ ] CC2 并发幂等：
  - [P0-06-03] service_orders.appointment_id 缺 partial unique
  - [P0-06-02] client.cancel 无 CAS
  - [P1-06-12] admin.checkin 无幂等
  - [P2-06-15] client.create 无事务
- [ ] CC3 组织域数据隔离：
  - [P1-06-09] staff list 直接拼 effectiveStoreId，缺管理层分支
- [ ] CC4 后端鉴权：
  - [P0-06-01] client list/cancel 缺 requirePhone
  - [P0-06-05] admin cancel 错权限项
- [ ] CC5 错误码：
  - [P2-06-17] INVALID_PARAMS 滥用（NOT_FOUND/CONFLICT 缺失）
- [x] CC6 PII：本域 SELECT 含 phone（staff list/detail JOIN client_wechat_users），但仅店内员工查询，无明显泄露；不升级。
- [ ] CC7 时间字段：
  - [P1-06-07] dateStr 时区不一致
  - [P1-06-12] checkin_at 覆写
  - [P1-06-14] confirmedAt admin 不写
- [ ] CC8 WXML/Vant：
  - [P1-06-13] client list 终态混排
  - [P2-06-19] staff list 既返格式化字符串又返 timestamp
- [ ] CC9 测试与迁移残留：
  - [P0-06-04] 过期关闭机制 spec 与实现脱节（5 STEP 无该任务）
  - [P1-06-08] result.count 类型断言不严
  - [P2-06-18] operation_logs 缺写
  - [P2-06-20] employee_name 前端传参不可信

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/migration | 新 migration | `CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;` | P0-06-03 |
| L0 schema/migration | 新 migration | 加 `(employee_id, appointment_time) WHERE status IN ('待确认','已确认')` partial unique 或 EXCLUDE | P1-06-06 |
| L0 schema/migration | 新 migration | 加 `(sale_item_id, status) WHERE status IN ('待确认','已确认')` partial unique（彻底解 client.create TOCTOU） | P0-06-03 / P2-06-15 |
| L0 permissions | `fengyu-admin/src/lib/permissions.ts:48` | PERMISSION_MATRIX.manager 增加 `'appointment:cancel'` | P0-06-05 |
| L3 cron | 新 `fengyu-admin/src/cron/steps/close-expired-appointments.ts` | `UPDATE appointments SET status='已关闭' WHERE status IN ('待确认','已确认') AND appointment_time < NOW() - INTERVAL '1 day'` + 写日志 | P0-06-04 |
| L3 client routes | `clientApi/routes/appointment.js:131,185` | 顶部加 `await requirePhone()(ctx, async()=>{})`；cancel UPDATE 加 `AND client_user_id=$ AND status IN ('待确认','已确认')` CAS | P0-06-01 / P0-06-02 |
| L3 client routes | `clientApi/routes/appointment.js:108-118` | 用 pg.transaction 包裹 create | P2-06-15 |
| L3 staff routes | `staffApi/routes/appointment.js:50` | 用 `buildStoreScopeCondition` 替换硬拼 effectiveStoreId | P1-06-09 |
| L3 staff routes | `staffApi/routes/appointment.js:246` | checkin 收敛到仅 '已确认' | P1-06-11 |
| L3 staff routes | `staffApi/routes/appointment.js:204,260` | confirm/checkin 末尾 INSERT operation_logs | P2-06-18 |
| L3 staff service | `staffApi/routes/service.js:55-69` | appointmentId 校验移入事务，INSERT 后 catch 23505（partial unique 触发）→ "该预约已关联服务单" | P0-06-03 |
| L7 admin actions | `admin/actions/appointments.ts:184-194` | confirm 写 confirmedAt | P1-06-14 |
| L7 admin actions | `admin/actions/appointments.ts:222-237` | checkin 加 `AND checkin_at IS NULL` 幂等 | P1-06-12 |
| L7 admin actions | `admin/actions/appointments.ts:248` | cancel 改用 `'appointment:cancel'` 权限 | P0-06-05 |
| L7 admin services | `admin/actions/services.ts completeServiceOrder` | 完成时同步 `UPDATE appointments SET status='已完成' WHERE appointment_id=$ AND status='已确认'` | 跨端一致性 |
| L7 admin actions | `admin/actions/appointments.ts:196,235,273` | 抽 `assertOneRow(result)` helper（统一断言 `rowCount===1`） | P1-06-08 |
| L9 client UI | client appointment list 页 | 默认隐藏 '已取消'/'已关闭'，加切换 | P1-06-13 |
| L9 staff UI | staff appointment list 页 | 统一前端 dayjs.tz 格式化 | P2-06-19 |

## 7. 验证 SQL（在 5434 EXPLAIN 或 SELECT，禁止写入）

```sql
-- #1 验证 service_orders.appointment_id 是否存在多对一（P0-06-03）
SELECT appointment_id, count(*) AS cnt
FROM service_orders
WHERE appointment_id IS NOT NULL
GROUP BY appointment_id
HAVING count(*) > 1;

-- #2 验证同 sale_item_id 是否存在多个活跃预约（P0-06-03 / P2-06-15）
SELECT sale_item_id, count(*) AS cnt
FROM appointments
WHERE sale_item_id IS NOT NULL AND status IN ('待确认','已确认')
GROUP BY sale_item_id
HAVING count(*) > 1;

-- #3 P0-06-04 过期未关闭预约存量
SELECT count(*) AS overdue_open,
       min(appointment_time) AS oldest
FROM appointments
WHERE status IN ('待确认','已确认')
  AND appointment_time < NOW() - INTERVAL '1 day';

-- #4 P1-06-06 同员工同时段重叠预约
SELECT employee_id, appointment_time, count(*) AS cnt
FROM appointments
WHERE status IN ('待确认','已确认')
GROUP BY employee_id, appointment_time
HAVING count(*) > 1
LIMIT 50;

-- #5 P1-06-14 admin 路径 confirmed_at 缺失（status='已确认' 但 confirmed_at IS NULL 比例）
SELECT count(*) FILTER (WHERE confirmed_at IS NULL) AS null_count,
       count(*) AS total,
       round(100.0 * count(*) FILTER (WHERE confirmed_at IS NULL) / NULLIF(count(*),0), 2) AS null_pct
FROM appointments
WHERE status IN ('已确认','已完成');

-- #6 P1-06-13 客户端列表中"已取消/已关闭"占比
SELECT status, count(*) AS cnt
FROM appointments
GROUP BY status
ORDER BY 2 DESC;

-- #7 跨端"已确认 → 已完成"反推一致性（service_order.status='已完成' 但关联 appointment 仍 '已确认'）
SELECT a.appointment_id, a.status AS appt_status, so.service_order_id, so.status AS so_status
FROM appointments a
JOIN service_orders so ON so.appointment_id = a.appointment_id
WHERE so.status = '已完成' AND a.status = '已确认'
LIMIT 50;

-- #8 EXPLAIN：staff.list 'today' 路径（评估 idx_appts_employee_time / idx_appts_store_id 命中）
EXPLAIN
SELECT a.*
FROM appointments a
WHERE a.store_id = 'store-nc01'
  AND DATE(a.appointment_time) = CURRENT_DATE
  AND a.employee_id = 'FY-260101-0002'
ORDER BY a.appointment_time ASC
LIMIT 50;
```

## 8. 回归测试用例（建议）

1. **P0-06-01 鉴权**：mock `ctx.auth = {userId:null,phone:null}` 调 `appointment.cancel` → 期望 PHONE_REQUIRED -403。
2. **P0-06-02 CAS**：构造 status='已完成' 行 → client.cancel → 期望 INVALID_PARAMS（rowCount=0）。
3. **P0-06-03 partial unique**：手工尝试两次 staff.service.create 同一 appointmentId → 期望第二次报"该预约已关联服务单"或 23505 唯一约束。
4. **P0-06-04 cron 过期关闭**：插入 appointment_time = now - 2 day, status='已确认' → 跑 cron `--once` → 期望 status='已关闭', updated_at 更新。
5. **P0-06-05 权限**：finance 角色（无 appointment:cancel）调 admin.cancelAppointment → 期望 PERMISSION_DENIED。
6. **P1-06-06 时段冲突**：连续 2 次 client.create 同员工 09:00-11:00 → 期望第二次报冲突。
7. **P1-06-07 时区**：mock now = UTC 2026-04-25 16:30（北京 00:30 次日）→ admin/staff/client "今日" Tab 应一致返第二日数据。
8. **P1-06-11 跳过 confirm 直 checkin**：staff.checkin status='待确认' → 修复后期望报错"请先确认预约"。
9. **P1-06-12 admin.checkin 幂等**：admin 连点 2 次 → 第二次返 "已签到（幂等）"，checkin_at 不变。
10. **P1-06-14 confirmedAt**：admin.confirm → 期望 confirmedAt 写入。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（appointment_status 5 值 + service_orders.appointment_id FK + cron + 操作日志）
- 涉及历史数据：☑（验证 SQL #2 / #3 / #5 / #7 揭示历史脏数据需清洗）
- 修复成本：M（partial unique + cron STEP + 三端 CAS 重写 + 权限 matrix 调整）

## 10. 后续待办

- [ ] 与 PM 确认"超期关闭"是否仅 24h 阈值（spec 用"一天"），是否区分 待确认 vs 已确认 的关闭策略
- [ ] 与 PM 确认 admin.cancelAppointment 是否需要独立权限项（P0-06-05）
- [ ] 与 PM 对齐"取消窗口"业务策略（P1-06-10）— 至少给一个 system_configs 钩子
- [ ] 写补丁迁移：`uq_so_appointment` + `(sale_item_id) WHERE status IN ('待确认','已确认')` partial unique（前置先跑 §7 #1/#2 验证）
- [ ] cron close-expired-appointments STEP 设计（建议 STEP 6，03:00 早于其他业务 STEP 也可独立时段）
- [ ] 与 audit-05（服务单）整合：admin.completeServiceOrder 的 appointment 反推，与 service_orders.appointment_id partial unique 同批落地
- [ ] 与 audit-23（操作日志）协调：staff confirm/checkin 写 operation_logs

---

**新增 / 命中横切问题**：
- CROSS-CUTTING.md "状态机 UPDATE 缺 CAS 守卫" 后续命中（P0-06-02 client.cancel）
- CROSS-CUTTING.md "Staff 路由 scope 过滤非全覆盖" 后续命中（P1-06-09）
- CROSS-CUTTING.md "三端时区不一致" 后续命中（P1-06-07）
- CROSS-CUTTING.md "TOCTOU 校验：事务外读 → 事务内 INSERT" 后续命中（P0-06-03 / P2-06-15）
- 新增条目 CC4 "Client 路由忘记 requirePhone()"（P0-06-01）
- 新增条目 CC9 "Spec 状态机过期关闭未实现"（P0-06-04）
