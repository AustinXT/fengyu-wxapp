# 审计报告：CC7 时间字段责任 / 时区一致性（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC7（横切检查域，跨 25 业务域归集）
**审计员**：claude-opus-4-7
**审计时长**：约 15 分钟
**关联 PR/Ticket**：—

> 本报告是 25 业务域审计完成后对 CC7 横切域的**收官归集**。范围横跨：
> 1. DB schema 层 22 模块的 timestamp 列写入责任
> 2. admin / staff / client / payNotify / cron-worker 五端的 `new Date()` / `NOW()` / `to_char` / `toISOString` / `dayjs` 时间生成方式
> 3. 业务域报告 §5 CC7 节的命中（02 / 05 / 06 / 17 / 18 已重灾，10 / 14 间接命中）
> 4. CROSS-CUTTING.md `## CC7 时间字段责任` 既有归集

---

## 1. 三端入口对照（关键时间字段责任）

| 类别 | DB schema 字段 | admin 写入 | staff 写入 | client 写入 | payNotify 写入 | cron-worker 写入 |
|------|----------------|------------|------------|-------------|----------------|------------------|
| `created_at` (22 表) | `defaultNow()` | DB | DB | DB | DB | DB |
| `updated_at` (≈19 表) | `defaultNow().$onUpdate(() => new Date())` | Drizzle hook（JS 容器时区）| 显式 `now` 参数（JS）| 显式 `now`（JS） | 显式 `now`（JS） | Drizzle hook（JS）|
| `paid_at` (sale_orders) | nullable timestamp（无默认） | `new Date()` × 6 处 | `now`（JS） | `NOW()`（PG）+ JS `now` 混用 | `now`（JS） | — |
| `paid_at` (sale_order_payments) | nullable timestamp | `new Date()` | `now`（JS） | `now`（JS） | `now`（JS） | — |
| `started_at` (service_orders) | nullable | `new Date()` (Drizzle) | `now`（JS）通过 `$1` | — | — | — |
| `completed_at` (service_orders) | nullable | `NOW()` (admin 用裸 SQL) | `now`（JS） | — | — | — |
| `checkin_at` (appointments) | nullable | `new Date()` | `now`（JS） | — | — | — |
| `confirmed_at` (appointments) | nullable | **未写入**（仅置 status） | **未写入** | — | — | — |
| `voided_at` (sale_allocations) | nullable | `NOW()` (admin) | **不用**（staff 硬 DELETE） | — | — | — |
| `voided_at` (service_commissions) | **schema 缺该列** | — | — | — | — | — |
| `approved_at` (sale_orders) | nullable | `now` (refunds.ts) | `$1` (`now`) | — | — | — |
| `member_level_upgraded_at` (user, **TZ-aware**) | `withTimezone:true` | — | — | — | — | `NOW()` |
| `became_member_at` (user, **TZ-aware**) | `withTimezone:true` | — | `NOW()` (staff/order.js, payNotify) | — | `NOW()` | `NOW()` |
| `points_updated_at` (user) | nullable, **无 TZ** | — | `NOW()` | — | `NOW()` | `NOW()` |
| `last_login_at` | nullable | `new Date()` | `new Date()` (auth.js:143) | (无更新) | — | — |

**口径分裂总览**：
- `withTimezone:true` 仅用于 `user.ts` 的会员等级 / 入会时间共 3 列，其余 ≥ 60 列 timestamp **均为无时区** `timestamp without time zone`。
- 三端"时刻型"写入（`paid_at`, `started_at`, `completed_at`, `checkin_at`）admin/staff/client/payNotify 都用 `new Date()` 注入 PG，PG 把 JS Date 当作 UTC 写进无 TZ 列 → 显示时间如何解释完全取决于读取端。
- "日期型"写入（`service_date`, `valid_start`, `expire_date`）是 PG `date` 类型，三端写入时风格不一（staff 用 `new Date().toISOString().slice(0,10)` UTC 切片；admin 用 `CURRENT_DATE`；client 业务参数）。

---

## 2. 数据流图

```
                 [写入层]                                           [读取层]
                                                                      
admin Server Action   ──new Date()──────┐                       admin getX
  (orders.paidAt: new Date(), ×6 处)    │                          ↓ paid_at::date = CURRENT_DATE
                                         │                         (PG 服务器时区，假设容器 TZ=Asia/Shanghai)
staff routes/order.js ──let now=...────  │
  (paid_at = $1, $1=now JS Date)         │   ─→ PG 无 TZ 列 ←─    staff dashboard / mgmtDashboard
                                         │     (储 UTC 字面量)     ↓ NOW()::date / new Date()  (JS 容器 TZ)
client routes/order.js  ──now────────── │                         ↓ + to_char(NOW(),'YYMMDD')
  ──但 confirmPrepaidFull SQL=NOW()─────┘                         ↓ 部分 + AT TIME ZONE 'Asia/Shanghai'
                                                                  
payNotify ──now=new Date()─────────────  ─→  跨午夜窗口：北京 00:00–08:00 三端读出"今日"互不相交
                                                                  
cron-worker (admin/cron) ──Drizzle.set()──  ─→  显式 timezone:'Asia/Shanghai' 调度器 OK，但底层 SQL 仍混用
   (timezone:'Asia/Shanghai') 
```

**时区责任栈分歧**（写入 → 读取）：
- 写入：JS `new Date()` 产生 UTC 时刻 → PG 接收为无 TZ 字面量（assume client TZ）
- 读取：admin Tailwind UI 走 `CURRENT_DATE` (PG 服务器时区) / staff 走 `new Date().toISOString().slice(0,10)` (强制 UTC) / staff 部分 SQL 走 `AT TIME ZONE 'Asia/Shanghai'` / client 走 JS `getFullYear/Month/Date()` (容器 TZ)
- 跨午夜窗口（北京 00:00–08:00）三端展示的"今日 / 本月 / 订单号 dateStr" 集合不一致

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### **[P0-CC7-01]** 跨午夜订单号 / 服务单号 / 退款单号 dateStr 跨端可重号（财务对账核心标识失真）
- **首发**：[audit-02 P0-02-02](./audit-02-order-creation.md)，[audit-05 P1-05-14](./audit-05-service-order.md) 升 P0
- **文件**：
  - admin: `actions/orders.ts:883/889/1282/1288/1623/1629`、`actions/services.ts:503/509`、`actions/refunds.ts:624/630`、`actions/employees.ts:304/310`：全部 `to_char(NOW(),'YYMMDD')` ← PG 服务器时区
  - staff: `routes/order.js:510/1396/2186/2455`、`routes/service.js:770`、`routes/card.js:196/209`：`new Date().toISOString().slice(2,10).replace(/-/g,'')` ← UTC 强制
  - client: `routes/order.js:419/434/1618`、`routes/card.js:253/267`：`new Date().toISOString().slice(2,10)` ← UTC 强制
- **现象**：北京时间 00:00–08:00，admin（PG，假设 PGTZ=Asia/Shanghai 来自 docker-compose.yml `PGTZ: Asia/Shanghai`）的 dateStr=今日（如 260426）；staff/client（UTC）的 dateStr=昨日（260425）。两端 advisory lock key 用同一 hash 但 dateStr 不同 → 锁桶错位（双端 0001 序号同时分配并落库），实际 sale_order_id 字符串不同所以 PK 不冲突，但**业务对账以"日期段+序号"作为核心定位标识，跨端重号且日期段错位**。
- **风险**：财务月报 / 日报按订单号前缀切片时，admin 端归档到 4-26 而 staff 端归档到 4-25；客服查 26 号订单，admin 输入"260426"返回 admin 单 + 漏掉 staff/client 同时刻的"260425"批；`uq_sop_txn` 不影响（按 wx 流水号） → 收银 / 退款 / 排单全链路对账偏离。
- **复现**：mock 北京 00:30 同时触发三端开单 → admin: `FY-XSD-WX-2604260001`，staff: `FY-XSD-WX-2604250098`，client: `FY-XSD-WX-2604250099`；同样的 customer 跨端混单时账目漂移。
- **修复**：(L0) `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'`（确认 PG 实例当前 timezone 见 §7 SQL）；(L3) 三端统一 `to_char(NOW(),'YYMMDD')` 或 `to_char(NOW() AT TIME ZONE 'Asia/Shanghai','YYMMDD')`；删除所有 `Date#toISOString().slice(2,10)` 模式；(L9) 前端不可生成订单号
- **关联**：CC2 advisory-lock 跨端 hash + 见 [audit-CC2 §A4 lock-key-mismatch](./audit-CC2-concurrency-idempotency.md)

#### **[P0-CC7-02]** performanceDetail 同函数内销售/服务双时间区间语义跨日漂移（员工绩效资损）
- **首发**：[audit-18 P0-18-03](./audit-18-employee-performance.md)
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:248-273`（performanceDetail）
- **现象**：销售分支：`new Date(startDate.replace(/-/g,'/'))`（容器时区 00:00）→ `paid_at >= $start AND paid_at < $end+1d`（半开区间，JS Date 容器时区基线）；服务分支：`service_date BETWEEN $start::date AND $end::date`（PG date 类型闭区间）。容器时区若是 UTC（云函数容器默认），`new Date('2026-04-25')` = `2026-04-25T00:00Z` = 北京 4-25 08:00 → 北京 4-25 0-8 点已支付订单的 paid_at 落在 JS UTC date 4-24 段被销售分支漏算，但 service_date='2026-04-25'（业务日字符串）仍命中服务分支 → 同员工同日两口径不可对账。
- **风险**：员工绩效结算金额错误（销售业绩 / 服务提成不可加和）、月度切换时双计或漏计；管理后台与员工端工作台展示同一员工同期金额不同。
- **复现**：见 [audit-18 §6 复现 (a)/(c)](./audit-18-employee-performance.md)
- **修复**：(L3) 销售/服务双分支统一改为 `paid_at::date BETWEEN $start::date AND $end::date` + `service_date BETWEEN $start::date AND $end::date`，所有"日期"参数走字符串而非 JS Date；底层 PG 时区固定为 Asia/Shanghai。

#### **[P0-CC7-03]** monthlyCalendar 三层时区漂移（JS 容器 TZ + UTC ISO + PG DATE() 同 SQL 内）
- **首发**：[audit-18 P1-18-07](./audit-18-employee-performance.md)，CC7 横切层升 P0
- **文件**：`staff.js:248-273`（monthlyCalendar）
- **现象**：
  ```
  monthStart = new Date(y, m-1, 1)               // ① JS 容器时区 00:00
  monthStartStr = monthStart.toISOString().slice(0,10)   // ② 强转 UTC 字符串
  WHERE o.paid_at >= $2 AND o.paid_at < $3       // ③ PG 接收字符串当本地时区
  GROUP BY DATE(o.paid_at)                        // ④ PG session 时区分桶
  // 前端再 .slice(0,10) 取展示日期                // ⑤ 前端 ISO 截取
  ```
- **风险**：月度日历每个 cell 对应的"业务日"在跨月窗口（4-30 23:30 → 5-1 00:30 北京时间）可能漂移到另一桶，导致月切换时整月业绩/客流误统计；与 P0-CC7-02 叠加放大资损。
- **修复**：(L3) `WHERE o.paid_at >= $1::date AND o.paid_at < ($2::date + INTERVAL '1 month') GROUP BY (paid_at AT TIME ZONE 'Asia/Shanghai')::date`，云函数侧不再构造 `new Date(y,m-1,1)`，全部走字符串。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-CC7-04]** 三端 "今日 Tab" 集合在跨午夜窗口不重叠（顾客 / 员工的"今日"视图不一致）
- **首发**：[audit-06 P1-06-07](./audit-06-appointment-checkin.md)，[audit-17 P1-17-08](./audit-17-dashboard.md)
- **文件**：
  - admin appointments.ts:81/105-106：`appointment_time >= CURRENT_DATE` (PG 服务器 TZ)
  - admin dashboard.ts:58/63/79/84：`DATE(paid_at) = CURRENT_DATE` / `CURRENT_DATE - 1`
  - staff appointment.js:60：`new Date().toISOString().slice(0,10)` (UTC)
  - staff staff.js dashboard：`new Date(now.getFullYear(), now.getMonth(), now.getDate())` (JS 容器 TZ)
  - staff mgmt-dashboard.js:647-665：`NOW()::date` / `date_trunc('month', NOW()::date)` (PG)
  - client appointment.js:231：`new Date(\`${match[1]}T${match[2]}:00+08:00\`)` 显式 +0800（OK）
- **现象**：北京 0:00–8:00 期间，UTC 切片端仍读昨日；PG `CURRENT_DATE` 端读今日；JS 容器时区端取决于云函数容器 `TZ` env（CloudBase 默认 UTC，与 docker-compose.yml `TZ=Asia/Shanghai` 仅作用于 admin cron-worker）。
- **风险**：员工端"今日预约" Tab 在凌晨可能漏掉刚到点的预约；管理端显示已确认而员工端看不见 → 投诉、漏服务。
- **修复**：(L3) 全部改为 PG `CURRENT_DATE`/`NOW()::date` + `AT TIME ZONE 'Asia/Shanghai'`（如未在 DB 默认时区）。

#### **[P1-CC7-05]** admin.checkinAppointment 不幂等，重复点击覆盖 checkin_at（审计失真）
- **首发**：[audit-06 P1-06-12](./audit-06-appointment-checkin.md)
- **文件**：`fengyu-admin/src/actions/appointments.ts:225` `set({ checkinAt: new Date() })`
- **现象**：staff 路径有 line 251-258 `if (appt.checkin_at) return early`，admin 路径无幂等守卫，每次点击都覆写 `checkin_at = new Date()`。
- **风险**：审计场景"顾客几点签到"在 admin 路径下不可信；与 staff 路径行为分裂。
- **修复**：(L7) admin checkin SQL 加 `WHERE status='已确认' AND checkin_at IS NULL`，rowCount=0 时返回幂等。

#### **[P1-CC7-06]** admin.confirmAppointment 仅置 status，不写 confirmed_at（schema 列存在但永远 NULL）
- **首发**：[audit-06](./audit-06-appointment-checkin.md) 关联点
- **文件**：`db/schema/appointment.ts:35` 声明 `confirmedAt: timestamp('confirmed_at')`，`fengyu-admin/src/actions/appointments.ts` confirmAppointment / staff `routes/appointment.js` confirm 均不写该列。
- **风险**：审计"店长何时确认预约"无数据来源；schema 列处于"声明无写入"漂移状态。
- **修复**：(L7/L3) admin/staff confirm 路径同事务写 `confirmed_at = NOW()`。

#### **[P1-CC7-07]** appointment 过期关闭 cron 完全缺失（spec 与代码脱节）
- **首发**：[audit-06 P0-06-04](./audit-06-appointment-checkin.md)
- **文件**：`db/schema/appointment.ts:14` + `.42cog/pm/backend.pr.spec.md:709-710` 规定 `待确认/已确认 → 已关闭（超过预约时间一天未到店）`，但 `fengyu-admin/src/cron/steps/` 5 STEP 无该任务。
- **风险**：appointment 表"已确认"状态无穷长存活；预约转服务单时机错乱（与 audit-CC2 partial unique 缺失叠加）。
- **修复**：(L3) 新增 `cron/steps/close-expired-appointments.ts`：`UPDATE appointments SET status='已关闭', updated_at=NOW() WHERE status IN ('待确认','已确认') AND appointment_time < NOW() - INTERVAL '1 day'`。

#### **[P1-CC7-08]** sale_allocations.voided_at vs service_commissions 缺 voided_at（软删时间审计断裂）
- **首发**：[audit-08 P1-08-?](./audit-08-service-commission.md)
- **文件**：`db/schema/order.ts:214` 有 `voidedAt`；`db/schema/service-commission.ts` 仅 `is_void` 无 `voided_at`。admin batchSaveAllocations 用 `voided_at=NOW()` 软删 sa，但 service_commissions 软删时无时间戳。
- **风险**：金融级流水审计中"何时作废"无据可查；sa 与 sc 双轨设计不对称。
- **修复**：(L0) service_commissions 加 `voided_at` 列；admin/staff 批量软删时同步写入。

#### **[P1-CC7-09]** PG 实例时区未在迁移中显式 SET，依赖 docker env `PGTZ=Asia/Shanghai`（运维风险）
- **文件**：`docker/docker-compose.yml:14 PGTZ: Asia/Shanghai`、line 13 `TZ: Asia/Shanghai`；db/migrations 无 `ALTER DATABASE ... SET timezone` 记录。
- **现象**：PG 实例时区由容器 env 决定；如线上重新部署或迁移到另一台机器（remote-deploy 流程），PGTZ 可能丢失，所有 `CURRENT_DATE` / `NOW()::date` / `to_char(NOW(),...)` 会切回 UTC，触发 P0-CC7-01 全栈生效。
- **风险**：单点配置漂移，全集群时区一夜失稳。
- **修复**：(L0) 新增迁移 SQL：`ALTER DATABASE fengyu SET timezone='Asia/Shanghai';`（baseline reset 后任意 migration 末尾追加），保证 schema-as-code。

#### **[P1-CC7-10]** TZ-aware vs naive timestamp 列混用（user.ts 3 列特殊）
- **文件**：`db/schema/user.ts:38/40/53` 用 `withTimezone:true`，其余 60+ 列全 naive。
- **风险**：`memberLevelUpgradedAt`/`becameMemberAt` 与 `lastLoginAt`/`pointsUpdatedAt` 同表语义不一致；JOIN 查询时 PG 自动隐式转换可能在 timezone='UTC' 与 'Asia/Shanghai' 跨 session 切换时给出不同结果。
- **修复**：(L0) 二选一统一：要么全部 `withTimezone:true`（推荐，配合 P1-CC7-09），要么全部 naive 但 DB 实例 timezone 固定 Asia/Shanghai。

#### **[P1-CC7-11]** auth.bindPhone / login 的 last_login_at 用 JS new Date() 而非 NOW()
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/auth.js:143` `[new Date(), user.employee_id]`
- **现象**：`UPDATE staff_wechat_users SET last_login_at = $1` 注入 JS Date；与 PG 端 timezone 处理同 P0-CC7-01 同源。
- **修复**：(L3) 直接 SQL `SET last_login_at = NOW()`，避免 JS Date round-trip。

### 3.3 P2（代码质量 / 可维护）

#### **[P2-CC7-12]** dateStr / yearStart 等"导出字符串"在三端散落 ≥ 18 处副本
- **现象**：staff customer.js:513/583 / 588、staff staff.js:160/211/255-256/300、staff appointment.js:60、client order.js:419/434、client card.js:253/267 等共 18 处独立调用 `new Date().toISOString().slice(...)`，无 helper 收敛。
- **修复**：(L3) 抽 `helpers/datetime.js` 提供 `todayDateStr()` / `yearStartStr()` / `orderNoDateStr()` 等单一实现，全 staff/client/admin 引用。

#### **[P2-CC7-13]** computedAt 字段直传 `new Date().toISOString()` 给前端 (staff mgmt 端 5 处)
- **文件**：mgmt-product.js:216/393、mgmt-traffic.js:617、mgmt-dashboard.js:626/932/1222
- **现象**：前端展示 `computedAt` 时 `new Date(computedAt).toLocaleString()` 默认按设备本地时区，与"业务日"无关；属"展示型"用法本身 OK，但 ISO 字符串无 +08:00 后缀，IE/某些 webview 解析为本地时区造成偏差。
- **修复**：(L3) 改为 `new Date().toISOString()` → `dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss')` 显式格式化。

#### **[P2-CC7-14]** 客户端 formatters / format.ts 用 `new Date(str.replace(/-/g,'/'))` iOS 兼容兼当时区翻译
- **文件**：`fengyu-staff/miniprogram/utils/formatters.ts:26-29`、`fengyu-client/miniprogram/utils/format.ts:83/92` `formatDateTime` 等
- **现象**：iOS Safari 不解析 `2026-04-25 12:00`，故全端用 `replace(/-/g,'/')` 兼容；但同时把 PG 返回的 naive timestamp 当本地时区解释（设备时区，绝大多数=Asia/Shanghai），与 PG 实际时区耦合。
- **风险**：海外用户 / 调测时设备 TZ=UTC 时显示偏差 8 小时。
- **修复**：(L9) 后端统一返回带时区后缀的 ISO 字符串（`YYYY-MM-DDTHH:mm:ss+08:00`），前端 dayjs.tz 解析。

#### **[P2-CC7-15]** cron-worker 调度器显式 timezone='Asia/Shanghai' 但底层 STEP 仍用 `CURRENT_DATE`（PG 时区耦合）
- **文件**：`fengyu-admin/src/cron/index.ts:42`、`steps/grant-thanksgiving-benefits.ts:41/59/67`、`steps/refresh-customer-status.ts:33/43-44`
- **现象**：调度时刻准确（每日 03:00 北京时间），但 STEP 内部 `WHERE so.service_date = CURRENT_DATE` 依赖 PG TZ；P1-CC7-09 漂移时所有 STEP 计算口径同步偏移 8 小时。
- **修复**：(L3) STEP 内部 SQL 用 `(NOW() AT TIME ZONE 'Asia/Shanghai')::date` 替代 `CURRENT_DATE`，与调度器同步显式声明。

---

## 4. 跨端不一致（CC7 维度归集）

| 维度 | admin | staff | client | payNotify | cron-worker | 风险 | 优先级 |
|------|-------|-------|--------|-----------|-------------|------|--------|
| 订单号 dateStr | `to_char(NOW(),'YYMMDD')` PG | `new Date().toISOString().slice(2,10)` UTC | `now.toISOString().slice(2,10)` UTC | — | — | 跨午夜重号 | P0 |
| 服务单号 dateStr | `to_char(NOW(),'YYMMDD')` | `Date#toISOString().slice(2,10)` UTC | — | — | — | 跨午夜重号 | P0 |
| paid_at 写入 | `new Date()` JS | `now` JS Date | `NOW()` PG（client）+ JS（部分） | `now` JS | — | 同列不同值源 | P1 |
| started_at | `new Date()` (Drizzle) | `now` JS via `$1` | — | — | — | OK 一致 | — |
| completed_at | `NOW()` PG（admin 裸 SQL） | `now` JS via `$1` | — | — | — | 写入端漂移 | P2 |
| checkin_at | `new Date()` 不幂等 | `now` 幂等 | — | — | — | admin 覆盖审计失真 | P1 |
| confirmed_at | 不写 | 不写 | — | — | — | 列声明无写入 | P1 |
| voided_at | sa: `NOW()`；sc: 缺列 | sa: 硬 DELETE；sc: — | — | — | — | 软删时间 / 硬删双轨 | P1 |
| "今日"判定（dashboard） | `CURRENT_DATE` PG | `new Date(...).slice(0,10)` UTC | — | — | — | 跨午夜不一致 | P1 |
| "本月"判定（dashboard） | `date_trunc('month', CURRENT_DATE)` | mgmt: `date_trunc('month', NOW()::date)`；staff: `monthStart.toISOString().slice(0,10)` | — | — | — | 跨月双桶 | P1 |
| service_date 写入 | 业务参数 | `serviceDate \|\| new Date().toISOString().slice(0,10)` UTC | — | — | — | 默认值跨午夜偏移 | P1 |
| dayjs / moment 使用 | 0 处 | 0 处 | 0 处 | 0 处 | 0 处 | 全栈无统一时区库 | P2 |
| `withTimezone:true` 列 | 仅 user.ts × 3 | 同 admin | 同 admin | — | — | 同表语义混用 | P1 |

---

## 5. 横切检查（套用 §3 模板）

- [ ] **CC1 数值**：N/A（CC7 收官，自身不评 CC1）
- [ ] **CC2 并发**：CC7 与 CC2 强耦合 — advisory lock dateStr 跨端不一致放大跨午夜重号风险（见 [audit-CC2 §A4](./audit-CC2-concurrency-idempotency.md)）→ P0-CC7-01 同时归 CC2
- [ ] **CC3 隔离**：N/A
- [ ] **CC4 鉴权**：N/A
- [ ] **CC5 错误码**：N/A
- [ ] **CC6 PII**：N/A
- [x] **CC7 时间字段**：本身就是 CC7 收官报告，所有发现归 CC7
- [ ] **CC8 WXML/Vant**：前端 formatDateTime 可能展示误差（P2-CC7-14）
- [ ] **CC9 测试**：dashboard.consistency.test.ts 缺失（CROSS-CUTTING.md 已记），同样可挖掘"时区 fixture 跨端 assertion"

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 / 范围 | 修改 | 关联问题 |
|----|------------|------|----------|
| L0 schema | 新建 migration `00NN_set_db_timezone.sql` | `ALTER DATABASE fengyu SET timezone='Asia/Shanghai';` 保证 schema-as-code | P0-CC7-01 / P1-CC7-09 |
| L0 schema | `db/schema/service-commission.ts` | 新增 `voidedAt: timestamp('voided_at')` | P1-CC7-08 |
| L0 schema | `db/schema/user.ts` 与其他表 | 决策：全部 `withTimezone:true` 或全部 naive；统一后跑迁移 | P1-CC7-10 |
| L0 schema | `db/schema/appointment.ts` | confirmAppointment / appointment cron 用 `confirmed_at` 列；列定义已存在 | P1-CC7-06 / P1-CC7-07 |
| L3 staff routes | `staffApi/routes/order.js:510/1396/2186/2455`、`service.js:770`、`card.js:196/209` | 统一 `to_char(NOW(),'YYMMDD')` 由 PG 生成 dateStr，删除 JS toISOString slice | P0-CC7-01 |
| L3 client routes | `clientApi/routes/order.js:419/434/1618`、`card.js:253/267` | 同上 | P0-CC7-01 |
| L3 staff staff.js | `routes/staff.js:160/211/248-273` | performanceDetail 销售/服务双分支统一 `paid_at::date BETWEEN`；monthlyCalendar 用 `(paid_at AT TIME ZONE 'Asia/Shanghai')::date` 分桶 | P0-CC7-02 / P0-CC7-03 |
| L3 staff appointment | `routes/appointment.js:60` | `today` 改 PG `(NOW() AT TIME ZONE 'Asia/Shanghai')::date` | P1-CC7-04 |
| L3 staff service | `routes/service.js:42` | `serviceDate` 缺省值改 PG `CURRENT_DATE` | P1-CC7-04 |
| L3 staff auth | `routes/auth.js:143` | `last_login_at = NOW()` 直接 SQL | P1-CC7-11 |
| L3 cron | `fengyu-admin/src/cron/steps/close-expired-appointments.ts`（新增） | UPDATE appointments → 已关闭 | P1-CC7-07 |
| L3 cron | 既有 STEP `*.ts` | `CURRENT_DATE` → `(NOW() AT TIME ZONE 'Asia/Shanghai')::date` | P2-CC7-15 |
| L3 helper | 新建 `cloudfunctions/*/helpers/datetime.js` | 统一 dateStr / yearStart / monthStart 助手函数 | P2-CC7-12 |
| L7 admin actions | `actions/appointments.ts:225` | checkin SQL 加 `AND checkin_at IS NULL` 幂等 | P1-CC7-05 |
| L7 admin actions | `actions/appointments.ts` confirmAppointment | 写 `confirmed_at = NOW()` | P1-CC7-06 |
| L7 admin actions | `actions/orders.ts:444/936/958/1327/1688/1705/1719` | `paidAt: new Date()` → 直接 SQL `paid_at = NOW()` 减少 round-trip | P1（一致性）|
| L9 frontend | `fengyu-*/miniprogram/utils/format*.ts` | dayjs.tz('Asia/Shanghai') 解析 ISO+offset 字符串 | P2-CC7-14 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. PG 实例当前时区（关键基础事实）
SHOW timezone;
SELECT current_setting('TIMEZONE'), NOW(), NOW() AT TIME ZONE 'Asia/Shanghai', CURRENT_DATE;

-- 2. 全部 timestamp 列的 with/without TZ 分布
SELECT table_name, column_name, data_type, datetime_precision
FROM information_schema.columns
WHERE data_type LIKE '%timestamp%'
  AND table_schema = 'public'
ORDER BY data_type, table_name, column_name;

-- 3. 跨午夜窗口订单号实际重叠情况（事后验证 P0-CC7-01）
SELECT substring(sale_order_id from '\d{6}') AS date_part,
       count(*) AS cnt,
       min(created_at), max(created_at)
FROM sale_orders
WHERE created_at::time BETWEEN '00:00' AND '08:00'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY date_part
ORDER BY date_part DESC
LIMIT 30;

-- 4. paid_at 与 created_at 时区差校验
SELECT sale_order_id, status,
       created_at, paid_at,
       EXTRACT(EPOCH FROM (paid_at - created_at)) AS lag_seconds,
       (paid_at - created_at) AS lag
FROM sale_orders
WHERE status = '已支付'
  AND paid_at IS NOT NULL
  AND created_at >= NOW() - INTERVAL '7 days'
  AND ABS(EXTRACT(EPOCH FROM (paid_at - created_at))) > 86400 * 7  -- 7 天异常
ORDER BY created_at DESC LIMIT 20;

-- 5. checkin_at 被覆盖的迹象（updated_at >> checkin_at + 短间隔重写）
SELECT appointment_id, checkin_at, updated_at,
       EXTRACT(EPOCH FROM (updated_at - checkin_at)) AS delta_sec
FROM appointments
WHERE checkin_at IS NOT NULL
  AND updated_at > checkin_at + INTERVAL '1 minute'
ORDER BY checkin_at DESC LIMIT 20;

-- 6. confirmed_at 列实际写入率（应该 ≈ 0%，证实 P1-CC7-06）
SELECT count(*) FILTER (WHERE confirmed_at IS NOT NULL) AS with_confirmed_at,
       count(*) FILTER (WHERE status IN ('已确认','已签到','已完成')) AS confirmed_or_later,
       count(*) AS total
FROM appointments;

-- 7. service_date 跨午夜被写为 UTC 切片的痕迹
SELECT service_date, count(*),
       count(*) FILTER (WHERE created_at::time BETWEEN '00:00' AND '08:00') AS night_created,
       count(*) FILTER (WHERE service_date != created_at::date) AS date_mismatch
FROM service_orders
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY service_date
HAVING count(*) FILTER (WHERE service_date != created_at::date) > 0
ORDER BY service_date DESC LIMIT 20;

-- 8. 验证三端 dateStr 实际重号风险（P0-CC7-01）
SELECT
  to_char(NOW(),'YYMMDD') AS pg_dateStr,
  to_char(NOW() AT TIME ZONE 'UTC','YYMMDD') AS utc_dateStr,
  to_char(NOW() AT TIME ZONE 'Asia/Shanghai','YYMMDD') AS shanghai_dateStr;
```

---

## 8. 回归测试用例（建议）

1. **跨午夜订单号 fixture**（P0-CC7-01）：mock 系统时间到北京 00:30，三端各开一单 + payNotify 回调，断言三个 sale_order_id 的 6 位 dateStr **完全一致**。
2. **performanceDetail 双分支跨日漂移**（P0-CC7-02）：mock 容器 TZ=UTC，员工 4-25 北京 0:30 完成服务且 paid_at=4-24T16:30Z，调用 performanceDetail(start='2026-04-25', end='2026-04-25')，断言销售分支金额 + 服务分支金额加总等于"业务日 4-25"实际产生的总额。
3. **monthlyCalendar 跨月**（P0-CC7-03）：mock 4-30 23:30 北京 + 5-1 00:30 北京两单，调用 monthlyCalendar(2026,4) 与 monthlyCalendar(2026,5)，断言 4 月份桶含 4-30 23:30 单 + 5 月份桶含 5-1 00:30 单，不重复不遗漏。
4. **admin checkin 幂等**（P1-CC7-05）：admin 连点 2 次 → 第二次返回 `已签到（幂等）`，checkin_at 不变。
5. **confirm_at 写入**（P1-CC7-06）：调用 admin/staff confirmAppointment 后，断言 `confirmed_at IS NOT NULL`。
6. **过期关闭 cron**（P1-CC7-07）：插入 appointment_time = now-2day, status='已确认'，跑 cron `--once`，断言 status='已关闭'，updated_at 更新。
7. **PG TZ 切换 fault test**（P1-CC7-09）：临时 docker PG 不设 PGTZ，跑全套 dashboard / orderCreate 用例 → 断言"应该全失败或显式 fallback"，避免静默漂移。
8. **dashboard 三端口径一致性**（CC9 横切重复）：固定 fixture 在 5434 跑，断言 admin getDashboardStats / mgmtDashboard.summary / staff.dashboard 三端业绩、客流、新会员核心数字相等（已记于 [CROSS-CUTTING.md CC9](./CROSS-CUTTING.md)）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（5 端 + DB）：☑（admin / staff / client / payNotify / cron-worker 全部命中）
- 涉及历史数据：☑（已生成的订单号若 PGTZ 历史漂移过则历史数据带瑕，需要审计 8 号 SQL）
- 修复成本：**M-L**
  - L0 一行 ALTER DATABASE + 一列 `voided_at` ≈ S
  - L3 三端 dateStr / 时间窗口收敛 ≈ M（需穷举 18 处副本）
  - L7 admin checkin / confirm 幂等 ≈ S
  - L9 前端 dayjs 改造 ≈ S
  - 综合 M-L

---

## 10. 后续待办

- [ ] 在 P0-CC7-01 修复迁移合入前，检查现有数据库 `SHOW timezone` 实际值（验证 SQL #1）；若已是 Asia/Shanghai，本修复退化为"显式声明" + L3 代码统一；若是 UTC，需先评估历史订单号 dateStr 影响面
- [ ] 与 `[audit-CC2 §A4 lock-key-mismatch](./audit-CC2-concurrency-idempotency.md)` 协调修复顺序：先 L0 ALTER DATABASE → 再 L3 dateStr 统一 → 再 advisory lock hash 统一
- [ ] 评估 `withTimezone:true` 全表迁移 vs naive timestamp + 实例 TZ 锁定 两条路线的工程成本；建议工程团队选 naive + 实例 TZ 锁定（迁移侵入小、与现有云函数 `new Date()` 默认行为兼容度高）
- [ ] 把 P2-CC7-12 helper 收敛纳入 staffApi / clientApi 共享 helper 重构 ticket
- [ ] cron-worker 既有 STEP（5 个）SQL 内 `CURRENT_DATE` 全替换为 `(NOW() AT TIME ZONE 'Asia/Shanghai')::date` 作为防 PGTZ 漂移的纵深防御
- [ ] 建议合入 `dashboard.consistency.test.ts`（CC9 既有遗留），断言三端"今日"口径 fixture 一致

---

## 11. 量化总览（CC7 收官指标）

### 11.1 时间字段写入责任分布（DB schema 22 模块）

| 字段类型 | 列数 | DB DEFAULT/$onUpdate 写入 | action 显式写入 | 不写入（孤儿列） |
|----------|------|---------------------------|-----------------|-----------------|
| `created_at` | 22 | 22（`defaultNow()`）| 0 | 0 |
| `updated_at` | 19 | 19（Drizzle `$onUpdate`，但 staff/client/payNotify 走原生 SQL 时**显式 `updated_at = $X`** ≈ 30+ 处）| 30+ | 0 |
| `paid_at` (sale_orders) | 1 | 0 | 5 端写入：admin × 6, staff × 4, client × 2, payNotify × 多 | 偶现 NULL（挂账场景） |
| `paid_at` (sale_order_payments) | 1 | 0 | 同上 | 类似 |
| `started_at` / `completed_at` (service_orders) | 2 | 0 | admin × 2, staff × 2 | — |
| `checkin_at` (appointments) | 1 | 0 | admin × 1（**不幂等**），staff × 1 | — |
| `confirmed_at` (appointments) | 1 | 0 | **0**（孤儿列）| **100%** |
| `voided_at` (sale_allocations) | 1 | 0 | admin × 1 (`NOW()`) | staff 用硬 DELETE |
| `voided_at` (service_commissions) | **0** | — | — | **schema 缺列** |
| `withTimezone:true` 列 | 3（user.ts）| user × 3（`NOW()`）| — | 同表其他 timestamp 列均 naive |

### 11.2 三端时区使用分布（按 grep 文件次数计）

| 端 | `new Date()` | `Date#toISOString().slice` | `to_char(NOW(),'YYMMDD')` | `CURRENT_DATE` / `NOW()::date` | `AT TIME ZONE 'Asia/Shanghai'` | dayjs / moment |
|----|--------------|----------------------------|---------------------------|--------------------------------|--------------------------------|----------------|
| admin (Server Actions) | 35 | 0 | 6 处订单号生成 | 30+ | 0 | 0 |
| staff cloudfunction | 30+ | 18 | 0 | mgmt-dashboard 11 | mgmt-customer 3 + customer 3 | 0 |
| client cloudfunction | 11 | 6 | 0 | 2 | 0 | 0 |
| payNotify | ~5 | 0 | 0 | 1 (`NOW()`) | 0 | 0 |
| cron-worker | 0 (走 Drizzle hook) | 0 | 0 | 多次 | 0 | 0 |

### 11.3 跨午夜（北京 00:00–08:00）潜在漂移面

| 受影响功能 | 漂移机制 | 预估影响概率 | 严重度 |
|------------|----------|--------------|--------|
| 订单号 dateStr | UTC vs PG 时区 | 100%（每天 0-8 点窗口）| **P0** 财务对账 |
| 服务单号 dateStr | UTC vs PG 时区 | 100% | **P0** 服务追溯 |
| 退款单号 dateStr | admin 只走 PG 路径 → 单端不漂 但与 staff 端混用时同窗口内仍会与 staff 服务单号产生命名空间错位 | 中 | P0 |
| dashboard "今日"集合 | 三端三套 | 100% | P1 业务展示 |
| performanceDetail 销售/服务 | 同函数双时区 | 100% | **P0** 员工绩效结算 |
| monthlyCalendar 跨月切换 | 三层时区 | 仅月末 23:30–次月 00:30 期间触发 | P0 月度对账 |
| client appointment.create | 显式 +08:00 → OK | 0% | — |

---

## 12. 关联资源

- 业务域报告 §5 CC7 节直接命中：02 / 05 / 06 / 17 / 18（5 域）
- 间接命中（schema 列声明无写入 / 软删时间漂移）：08 / 10 / 14 / 23
- CROSS-CUTTING.md `## CC7 时间字段责任` 已记录的 2 个共性条目：「三端时区不一致」「三端今日/本月边界漂移」
- 关联横切：CC2 advisory lock dateStr key 一致性 / CC9 dashboard 三端口径一致性测试
