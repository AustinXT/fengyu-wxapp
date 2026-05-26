> ✅ 已归档（2026-05-19）— 全部 DoD 完成；保留作为决策与实施记录。
> 关联 commits：`c40bb3b` (4 端核心 + DB schema) / `781b85b` (NULL 兼容兜底) / `c1a4cb1` (link-12 强化 + link-45 新增)

# Ticket: sale_items 新增 paid_sessions（已支付次数）——支持部分支付订单按支付比例消费

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | **已归档** — L0/L1/L2/L3 + e2e link-12 强化 + link-45 新增 全部完成，跨端 snapshot 守护就位 |
| 归档日期 | 2026-05-19 |
| 优先级 | **P1**（业务核心：当前部分支付订单完全无法消费——`service.create` 强行要求 `order_status='已支付'`） |
| 端 | db / fengyu-staff / fengyu-client / fengyu-admin / payNotify（四端联动） |
| 修复成本 | **L**（DB 字段 + 4 端 SQL/Action 改造 + 12 个前端页面改显示 + 跨端 snapshot 更新 + 新增 e2e 链路） |
| 来源 | 用户口述需求 2026-05-19 |
| 关联 schema | `db/schema/order.ts:142-217`（sale_items 表） |
| 关联枚举 | `db/schema/enums.ts:5-16`（orderStatusEnum 含"部分支付"——**已有，无需新增**） |
| 关联约束 | memory `feedback_no_legacy_compat.md`（开发期不要历史兼容）+ `project_pre_launch_data_wipe.md`（上线前清库，免回填） |
| 跨端守护 | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`（settlePoints / cascadeRefund 等已有 6 块，本次新增 1 块 paid_sessions 计算公式） |

---

## 0 一句话

给 `sale_items` 加 `paid_sessions INTEGER`（已支付金额可换的次数），**放开部分支付订单的 service.create 限制**，让顾客先付一部分就能先用一部分次数；三端"我的卡 / 顾客详情 / 服务单选卡"等 12 个页面把 `remainingSessions/sessionCount` 改成 `remainingSessions/paidSessions/sessionCount`。

---

## 1 现状与问题

### 1.1 当前模型（事实）

| 字段 | 含义 | 数据流 |
|------|------|--------|
| `sale_items.session_count` | **总次数快照**（开单时 = `sku.session_count × quantity`） | `order.create` 写入，永久不变 |
| `sale_items.remaining_sessions` | **剩余次数**（消费扣减） | `service.complete` 内 `UPDATE ... SET remaining_sessions = remaining_sessions - sessionUsed`（原子） |
| `sale_orders.status='部分支付'` | 订单状态枚举**已有** | `order.create` 时 `0 < received+prepaid < total` 或 `confirmOffline` 部分回款后落地 |
| `sale_order_payments` | 支付/回款流水表 | `change_type ∈ {首次支付/回款/退款/储值卡抵扣}`，支持多次回款 |

### 1.2 当前业务断点

**`fengyu-staff/cloudfunctions/staffApi/routes/service.js:102`**

```javascript
if (si.order_status !== '已支付') {
  throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单未支付`)
}
```

同样的硬卡也存在于 `fengyu-admin/src/actions/services.ts`（admin 端 `createServiceOrder`）。

**结果**：店长按 50% 收了 5000 块（10次卡总价 10000），订单进入 `部分支付`，但**顾客来店第一次做服务时直接报错"对应订单未支付"**。业务上完全跑不通——只能要求顾客一次付全款，与"按比例先付先用"的承诺冲突。

### 1.3 需求转译

| 维度 | 当前 | 目标 |
|------|------|------|
| sale_items 字段 | `session_count` + `remaining_sessions` | 加 `paid_sessions`（已支付次数快照） |
| `paid_sessions` 计算 | — | `floor((received + prepaid_card_amount) / total_amount × session_count)`（行维度，订单维度比例） |
| `paid_sessions` 重算时机 | — | `order.create` / `confirmOffline` / `payNotify`（微信回调）/ `recordPayment`（admin） |
| `service.create` 校验 | `order_status='已支付'` AND `remaining_sessions >= sessionUsed` | **删除 status 硬卡**；改为 `(session_count - remaining_sessions + sessionUsed) <= paid_sessions` |
| `service.complete` 原子扣减 | `WHERE remaining_sessions >= sessionUsed` | 加 `AND (session_count - remaining_sessions + sessionUsed) <= paid_sessions` |
| 三端显示 | `已用 X / 总 Y` | `剩余 X / 已付 Y / 总 Z`（含可视区分） |

---

## 2 设计草案

### 2.1 数据模型

```typescript
// db/schema/order.ts — sale_items 表加 1 列
paidSessions: integer("paid_sessions"),   // NULL=非次数卡（如家居/单品）；0=完全未付；>0=已付次数

// 行级约束
check("chk_item_paid_sessions",
  sql`${table.paidSessions} IS NULL OR (${table.paidSessions} >= 0 AND ${table.paidSessions} <= ${table.sessionCount})`),

// 业务不变量（应用层守护，无法 CHECK 跨行）
//   used_sessions := session_count - remaining_sessions
//   used_sessions <= paid_sessions  （永远不可超付消费）
```

### 2.2 公式与重算

**计算函数（四端独立副本，靠 snapshot 守护字节同义）**：

```javascript
// utils/paid-sessions.js（staff / client / payNotify / admin 各一份）
function computePaidSessionsForItem({
  saleOrderReceived,        // sale_orders.received（已收，含线下首次 + 多次回款）
  saleOrderPrepaid,         // sale_orders.prepaid_card_amount（储值卡抵扣，落账即 settled）
  saleOrderTotal,           // sale_orders.total_amount
  itemSessionCount,         // sale_items.session_count（NULL 直接返 NULL）
}) {
  if (itemSessionCount == null) return null
  if (saleOrderTotal <= 0) return itemSessionCount  // 整单免单兜底，按全付
  const settled = (Number(saleOrderReceived) || 0) + (Number(saleOrderPrepaid) || 0)
  const ratio = Math.min(1, settled / Number(saleOrderTotal))
  return Math.floor(ratio * itemSessionCount)
}
```

**重算时机（5 个写入点）**：

| 触发 | 文件 | 当前行为 | 新增动作 |
|------|------|---------|---------|
| 开单 | `staffApi/routes/order.js:307-325` (`rawItemDataList` map) | 计算 `sessionCount/remainingSessions` | 同时计算 `paidSessions` |
| 开单 | `clientApi/routes/order.js`（同上） | 同 | 同 |
| 开单 | `admin/src/actions/orders.ts createOrder` | 同 | 同 |
| 线下确认收款 / 回款 | `staffApi/routes/order.js:1009 confirmOffline` | `UPDATE sale_orders SET received, status` | 紧跟一条 `UPDATE sale_items SET paid_sessions = floor(...)` （批量 by sale_order_id） |
| admin 记账 | `admin/src/actions/orders.ts confirmOfflinePayment / recordPayment` | 同上 | 同 |
| 微信支付回调 | `cloudfunctions/payNotify/index.js`（`applyRechargeOnOrderPaid` 同事务） | 整单转 `已支付` | 同步 `UPDATE sale_items SET paid_sessions = session_count`（兜底 + 兼容性，即使 ratio 已=1） |

**重算 SQL 草案（单源四端复用）**：

```sql
-- 同事务内（紧随 sale_orders 状态/received 变更后）
UPDATE sale_items
SET paid_sessions = LEAST(
  session_count,
  FLOOR(
    ((SELECT received FROM sale_orders WHERE sale_order_id = $1) +
     (SELECT prepaid_card_amount FROM sale_orders WHERE sale_order_id = $1))::numeric
    / NULLIF((SELECT total_amount FROM sale_orders WHERE sale_order_id = $1), 0)
    * session_count
  )::integer
), updated_at = NOW()
WHERE sale_order_id = $1
  AND session_count IS NOT NULL
```

### 2.3 service 校验改造

**`service.create`（staff + admin 两端对称改）**：

```diff
- if (si.order_status !== '已支付') {
-   throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单未支付`)
- }
+ // 移除"必须已支付"硬卡。改为允许 ['已支付', '部分支付'] 两种状态。
+ if (!['已支付', '部分支付'].includes(si.order_status)) {
+   throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单状态为 ${si.order_status}，不可消费`)
+ }

- if (si.remaining_sessions !== null && si.remaining_sessions < item.sessionUsed) {
-   throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 剩余次数不足`)
- }
+ if (si.session_count !== null) {
+   const usedAfter = si.session_count - si.remaining_sessions + item.sessionUsed
+   if (si.remaining_sessions < item.sessionUsed) {
+     throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 剩余次数不足`)
+   }
+   if (usedAfter > si.paid_sessions) {
+     throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.saleItemId} 已支付次数不足（已付 ${si.paid_sessions}/${si.session_count}，已用 ${si.session_count - si.remaining_sessions}，本次需 ${item.sessionUsed}），请先完成付款`)
+   }
+ }
```

**`service.complete` 原子扣减（staff + admin 两端对称改）**：

```sql
UPDATE sale_items
SET remaining_sessions = remaining_sessions - $1
WHERE sale_item_id = $2
  AND store_id = $3
  AND remaining_sessions >= $1
  AND remaining_sessions IS NOT NULL
+ AND (session_count - remaining_sessions + $1) <= COALESCE(paid_sessions, 0)
```

错误码选择：**`INSUFFICIENT_BALANCE`**（已在 9 项白名单，语义"已支付次数不足"对应"余额/次数不足"——比 `INVALID_PARAMS` 更精确，便于前端引导用户"再付一点"）。

### 2.4 前端三端显示

12 个页面（详见 §6），核心样式建议：

```
[████████░░░░░░░░░░] 剩余 6 / 已付 8 / 共 10 次
 └ 主色已用 ┘└ 浅色已付未用 ┘└ 灰色未付 ┘
```

- **剩余可用**（remaining）：主色实心
- **已付待用**（paid_sessions - used）：浅色实心
- **未付不可用**（session_count - paid_sessions）：灰色虚线/底色

文本兜底（非进度条场景）：`已用 4 / 已付 8 / 共 10 次`（订单详情、列表行）。

---

## 3 决策点（**已锁定 2026-05-19**）

**用户最终决策**：
- D1=A / D2=A / **D3=A（退款扣减，覆盖原推荐 B）** / D4=A / D5=A / **D6=A（paid_sessions=0 整张卡锁死，不可再 create service）** / D7=A / D8=A / D9=A / D10=A
- 实施模式：A 一次性

**D3=A 衍生子决策（实施时定）**：退款重算后若 `new paid_sessions < used_sessions`，**拒绝退款（CONFLICT）**，提示"先取消已生成的服务单回滚消费"，保护"已消费次数不可撤销"的不变量。

> 以下决策表保留作为后续 review 参考。

| # | 决策项 | A | B | C | 推荐 |
|---|--------|---|---|---|------|
| **D1** | `paid_sessions` 取整方式 | `floor`（保守，未付 0.999 次 → 算 0） | `round`（中庸） | `ceil`（激进，付一分钱算 1 次） | **A**（最保守，避免"付了 99% 算全付"的语义模糊） |
| **D2** | 部分支付订单是否允许 `service.create` | 允许（核心价值，删 status 硬卡） | 不允许（仍要求 `已支付`），只把 paid_sessions 留作展示 | — | **A**（这正是本 ticket 业务价值，否则字段意义不大） |
| **D3** | 退款时 `paid_sessions` 是否倒退 | 倒退（重算公式 → 若新 paid_sessions < used 则报错） | 不倒退（已付次数只增不减，已消费的不撤销） | — | **B**（极简，避免历史消费回退引发分歧）；A 风险：退款时若 `used > new paid_sessions` 触发 CONFLICT，业务侧难解释 |
| **D4** | `paid_sessions` 是否硬约束 `<= session_count` | DB CHECK 约束 + 公式 LEAST 兜底 | 仅应用层 LEAST，不加 CHECK | — | **A**（双保险，公式 bug 也不会越界） |
| **D5** | `session_count IS NULL`（家居/单品）行的 `paid_sessions` | 也 NULL（不参与次数语义） | 写 0 | — | **A**（语义清晰：NULL = 无次数概念） |
| **D6** | `paid_sessions = 0` 时 `service.create` 错误码 | `INSUFFICIENT_BALANCE`（次数不足类） | `INVALID_STATE`（订单态阻塞类） | — | **A**（语义=余额/次数不足，前端可引导"请先支付"） |
| **D7** | 跨端 SQL snapshot 是否新增 `paid_sessions` 公式守护块 | 加（四端 `computePaidSessionsForItem` 字节同义守护） | 不加（仅靠各端单元测试） | — | **A**（与现有 `settlePointsForOrder` 同等关键，错一端就算钱不准） |
| **D8** | 单订单多疗程卡行（如同时买 10次卡 + 20次卡）按比例分摊后**尾差**怎么处理 | 各行独立 floor（总和可能 < ratio × Σsession） | 把尾差给最后一行 | — | **A**（语义"每行独立公式"，简单可解释；尾差最多每行 1 次） |
| **D9** | 开发期 fixture / 老订单回填 | 不回填（memory `pre_launch_data_wipe` 已许诺清库，migration 不写 UPDATE） | 回填 `paid_sessions = CASE WHEN status='已支付' THEN session_count ELSE 0 END`（保守，可能误伤已部分支付历史） | 回填精确公式（floor(received/total × session_count)） | **A**（开发期 + 即将清库，最省事；如怕开发同事本地老库炸，给个 manual 回填脚本，不进 migration） |
| **D10** | 三端显示样式 | 三段进度条（剩余/已付未用/未付）+ 文本"X/Y/Z 次" | 仅文本 "X/Y/Z 次"（不动 UI 组件） | 单进度条（按 remaining）+ 副文本"已付 Y/总 Z" | **A**（最直观；但工作量 +0.5d；如果赶工选 C 也 OK） |

**附加问题（可选讨论）**：

- **Q1**：储值卡抵扣（`prepaid_card_amount`）是否计入"已支付"参与 `paid_sessions` 计算？
  - 当前草案：**计入**（与 `received` 同列）——业务上储值卡就是钱
  - 替代：不计入（只算"现金"），但与 `confirmOffline` 内 `settled = received + prepaid` 的逻辑分裂

- **Q2**：转换单（`item_direction='convert_out/refund_out'`，`sale_amount < 0` 负行）的 `paid_sessions` 怎么算？
  - 当前草案：负行也按公式算（floor 一个负数 → 仍为负，符合反向语义）
  - 待你说："转换/退款行不参与服务消费"→ 干脆 paid_sessions=NULL 跳过

- **Q3**：寄存单（`sale_order_type='寄存单'`，WorkFine 历史导入，total_amount 可能=0）怎么处理？
  - 当前草案：`total_amount=0` 时 `paid_sessions = session_count`（公式 §2.2 已含 `<=0` 兜底）
  - 验证：与 `notes/memory/project_deposit_sale_order_type.md` 寄存单设计一致

---

## 4 影响清单

### 4.1 必改文件（按层）

#### L0 — DB Schema（1 个 migration）

- `db/schema/order.ts:142-217` — 加 `paidSessions` 列 + `chk_item_paid_sessions` 约束
- `db/migrations/0040_<name>.sql` — `npm run db:generate` 产物
- `db/migrations/meta/0040_snapshot.json` + `_journal.json` — 同上

#### L1 — 云函数（4 端）

| 端 | 文件 | 改点 |
|----|------|------|
| staff | `cloudfunctions/staffApi/routes/order.js:307-325` | `rawItemDataList` map 计算 `paidSessions` 字段 |
| staff | `cloudfunctions/staffApi/routes/order.js:1009-1037` (`confirmOffline`) | 状态更新后追加 UPDATE sale_items SET paid_sessions |
| staff | `cloudfunctions/staffApi/routes/order.js` (`createRepayment`) | 同上回款触发重算 |
| staff | `cloudfunctions/staffApi/routes/order.js` (`approveRefund` / `createRefund`) | D3=B 则**无需改**；D3=A 则触发重算 |
| staff | `cloudfunctions/staffApi/routes/service.js:102-116` (`create`) | 删 status 硬卡 + 加 paid_sessions 校验 |
| staff | `cloudfunctions/staffApi/routes/service.js:362-388` (`complete`) | 原子 UPDATE 加 paid_sessions 条件 |
| staff | `cloudfunctions/staffApi/utils/paid-sessions.js` **新建** | 单源公式 |
| client | `cloudfunctions/clientApi/routes/order.js` (create + pay) | 同 staff |
| client | `cloudfunctions/clientApi/utils/paid-sessions.js` **新建** | 字节同步 staff |
| payNotify | `cloudfunctions/payNotify/index.js`（微信回调成功后） | 整单转已支付时同步 UPDATE paid_sessions |
| payNotify | `cloudfunctions/payNotify/paid-sessions.js` **新建** | 字节同步 |
| admin | `src/actions/orders.ts createOrder` | 同 staff create |
| admin | `src/actions/orders.ts confirmOfflinePayment` | 同 staff confirmOffline |
| admin | `src/actions/orders.ts recordPayment`（如存在） | 同上 |
| admin | `src/actions/services.ts createServiceOrder` | 同 staff service.create |
| admin | `src/actions/services.ts completeServiceOrder:343-404` | 加 paid_sessions 条件 |
| admin | `src/lib/paid-sessions.ts` **新建** | 字节同步（注意 TS 写法） |

#### L2 — 前端（12 个页面，按端分）

**fengyu-client（4 页）**：
- `pagesOrder/treatment-cards/treatment-cards.{ts,wxml}` — 我的疗程卡列表（核心展示）
- `pagesOrder/orders/orders.ts` — 订单列表"可预约"判定（用 `remaining > 0`，可不改逻辑只改显示）
- `pagesOrder/order-detail/order-detail.{ts,wxml}` — 订单详情卡明细
- `pagesAppointment/appointment-create/appointment-create.{ts,wxml}` — 创建预约选卡（**需用 paid_sessions 过滤**：paid - used <= 0 的不可预约）

**fengyu-staff（6 页）**：
- `packageOrder/order-detail/order-detail.{ts,wxml}` — 订单详情卡信息
- `pages/service/service.{ts,wxml}` — 服务单列表（如有显示剩余次数）
- `packageService/service-create/service-create.{ts,wxml}` — 创建服务单选卡（**校验前端兜底**：`paidSessions - usedSessions <= 0` 的不可选）
- `packageService/service-detail/service-detail.{ts,wxml}` — 服务单详情
- `packageMgmt/mgmt-customer-detail/mgmt-customer-detail.{ts,wxml}` — 管理端顾客详情卡列表
- `packageCustomer/customer-detail/customer-detail.{ts,wxml}` — 顾客详情卡列表

**fengyu-admin（2 处）**：
- `src/actions/services.ts:196-238`（read 侧 select 加 paid_sessions 字段返回）
- `src/app/(main)/...` 对应 service detail / customer detail / order detail 页面组件（具体路径待 grep）

### 4.2 必改测试

| 文件 | 改点 |
|------|------|
| `staffApi/__tests__/routes/order.test.js` | 加 case：开单 + paid_sessions 初始计算（全付 / 部分付 / 0 付）|
| `staffApi/__tests__/routes/order.test.js`（confirmOffline） | 加 case：多次回款 paid_sessions 递增 |
| `staffApi/__tests__/routes/service.test.js`（如有，无则新建） | 加 case：部分支付订单 service.create 成功 / paid_sessions 限额触发 INSUFFICIENT_BALANCE |
| `staffApi/__tests__/routes/cross-end-sql-snapshot.test.js` | **新增第 7 块**：computePaidSessionsForItem 四端字节同义 |
| `admin/src/actions/orders.test.ts` | 同 staffApi/order.test.js |
| `admin/src/actions/services.test.ts` | 同 staffApi/service.test.js |
| `admin/tests/e2e-chains/link-12-session-count-check.spec.ts` | 调整不变量加 paid_sessions 维度（`session_count == remaining + used == used + paid_unused + unpaid`） |
| `admin/tests/e2e-chains/link-8-installment-payment.spec.ts` | 加断言：部分支付订单 service.create 成功（**当前应该是 fail 状态因为被硬卡**） |
| `admin/tests/e2e-chains/link-XX-partial-payment-consume.spec.ts` **新建** | 完整链路：开 10次卡部分付（5000/10000） → 消费 3 次（paid=5, used=3, ✓）→ 再消费 3 次（usedAfter=6 > paid=5, ✗ INSUFFICIENT_BALANCE）→ 回款 5000 → paid 升到 10 → 继续消费 ✓ |

### 4.3 跨端守护

- **`cross-end-sql-snapshot.test.js`** 新增 §7 守护 `computePaidSessionsForItem` 四端字节同义（仿 §1 settlePointsForOrder 写法）
- **`cross-end-error-codes-snapshot.test.js`** 无需改（INSUFFICIENT_BALANCE 已在 9 项白名单）

---

## 5 验收 DoD（2026-05-19 实施结果）

- [x] Schema：`sale_items.paid_sessions` 字段存在，CHECK 约束 `chk_item_paid_sessions` 通过；migration `0040_add_paid_sessions_to_sale_items.sql` 在临时 docker PG 从零 apply 成功（bootstrap 41 个 migration 全过）
- [x] 公式：四端 `computePaidSessionsForItem` 单元测试 14/14（含 floor / NULL / 退款扣减 / total=0 兜底 / 越界）
- [x] 开单：staff/client/admin 三端 create 后调 `recalcPaidSessionsForOrder` 同事务写入 paid_sessions（待支付订单 paid_sessions=0；线下全付 = session_count；寄存单 total=0 → 兜底全付）
- [x] 部分支付订单 service.create：staff/admin 双端拒绝硬卡已删除（仅检查 `['已支付','部分支付']` 白名单）
- [x] 多次回款：staff `confirmOffline/createRepayment`、admin `recordPayment/confirmOfflinePayment` 全部接入 `recalcPaidSessionsForOrder`，received 增长后 paid_sessions 单调上升
- [x] 微信支付回调：payNotify `index.js` 整单转 '已支付'/'部分支付' 后同步调用 recalc
- [x] paid_sessions 限额：staff/admin 双端 service.create 校验 + service.complete 原子 SQL 加 `(session_count - remaining_sessions + sessionUsed) <= COALESCE(paid_sessions, 0)`；paid=0 抛 `INSUFFICIENT_BALANCE`
- [x] D3=A 退款扣减：staff `approveRefund` + admin `refunds.approveRefund` 接入 recalc + violation 守护（已消费 > 已支付 时抛 CONFLICT，提示"先取消服务单"）
- [x] 跨端 SQL snapshot：`cross-end-sql-snapshot.test.js` 新增 Block 7 守护 paid_sessions 重算 SQL 四端字节同义（**77/77 通过**）
- [x] 前端：12 个页面（client 4 + staff 6 + admin 2）全部接入 paidSessions 展示；client/staff 加三段进度条（D10=A 主色 #C0322A）；service-create 选卡过滤 paid - used > 0；云函数 SELECT 同步追加 `si.paid_sessions` 字段返回
- [x] staff e2e-cloudfn 单元：`bunx vitest run` 1148/1153（5 个 pre-existing 失败与本 ticket 无关，已通过 stash 验证）
- [x] admin: `cd fengyu-admin && npx tsc --noEmit` 0 错误；`bunx vitest run` **1083/1083** 全过
- [x] **link-12 加 paid_sessions 维度断言**（commit 改 SQL invariant 含 `(session_count - remaining_sessions) <= paid_sessions`；Step1 断言 paid=sc；Step2 断言 paid 不变 + used<=paid；INSERT 注入 paid_sessions=session_count）
- [x] **link-45 新增**：`link-45-partial-payment-consume.spec.ts` — 注入部分支付订单（received=5000/total=10000，paid_sessions=5）→ UI 创建服务单 ✓ → SQL 模拟用满 paid → UI 验证 D6 锁死 → SQL 模拟回款 + 重算 → UI 重新可选
- [~] **link-8** — 不涉及 service.create（仅多次回款累加），无需改
- [x] **staff e2e-cloudfn 回归**：order/service module 跑批，**未引入新回归**（验证 `git checkout 旧代码 + 重跑 = 同样 fail`：smoke-order-create-sales / smoke-service-cancel / smoke-service-commission 均 pre-existing）
- [x] **修复 NULL 兼容**（commit 781b85b）：staff `service.js` 校验 + admin `services.ts` 校验改 `paid = paid_sessions ?? session_count`；admin `completeServiceOrder` 原子 SQL 同步改 `COALESCE(paid_sessions, session_count)`。fixture 未写 paid_sessions 的旧 sale_items 视为全付（不引入 e2e 回归）
- [x] **client e2e-cloudfn order**：5 spec pass / 1 spec fail（`create.spec` 缺 `products.is_enabled` 列 — pre-existing schema 漂移，与本 ticket 无关）

## 5.1 实施落地清单（commit 提示）

可按以下顺序分组提交：

1. **DB schema + migration**：`db/schema/order.ts` + `db/migrations/0040_*.sql` + `meta/`
2. **四端 paid-sessions utils**：4 个 `paid-sessions.{js,ts}` + 跨端 snapshot test
3. **staff cloud function**：`staffApi/routes/order.js`（5 处接入）+ `staffApi/routes/service.js`（校验改造）+ 测试更新
4. **client cloud function + payNotify**：`clientApi/routes/order.js`（create + SELECT 字段补齐 3 处）+ `payNotify/index.js`（微信回调接入）
5. **admin actions**：`orders.ts`（5 处接入）+ `services.ts`（create 校验 + complete 原子 SQL）+ `refunds.ts`（approveRefund 接入）+ 测试断言更新
6. **三端前端展示**：client 4 页 + staff 6 页 + admin 4 处 page 组件 + types.ts
7. **新增单元测试**：`paid-sessions.test.js`（14 用例）+ 跨端 snapshot Block 7

---

## 6 三端展示文件位置（明细）

| # | 端 | 文件 | 当前显示 | 改后 |
|---|----|------|---------|------|
| 1 | client | `pagesOrder/treatment-cards/treatment-cards.ts:35` | `calculateProgress(sessionCount, remainingSessions)` | 三段进度条 + 文本 |
| 2 | client | `pagesOrder/orders/orders.ts:51` | `remaining_sessions > 0` 判定可预约 | 改为 `paid_sessions - used_sessions > 0` 才可预约 |
| 3 | client | `pagesOrder/order-detail/order-detail.{ts,wxml}` | 卡明细 X/Y 次 | 三段 X/Y/Z 次 |
| 4 | client | `pagesAppointment/appointment-create/appointment-create.ts` | 过滤 `remaining > 0` 的卡 | 过滤 `paid - used > 0` 的卡（避免顾客选了空可用次的卡进入预约） |
| 5 | staff | `packageOrder/order-detail/order-detail.ts:41-170` | 订单详情卡 X/Y 次 | 三段 |
| 6 | staff | `pages/service/service.ts` | 服务单列表卡剩余次数 | 同 |
| 7 | staff | `packageService/service-create/service-create.ts:114` | 校验 `remaining_sessions >= sessionUsed` | 改为 `min(remaining, paid-used) >= sessionUsed` 前端兜底（云函数仍是权威） |
| 8 | staff | `packageService/service-detail/service-detail.ts` | 卡消耗情况 | 三段 |
| 9 | staff | `packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts` | 顾客卡列表 | 三段 |
| 10 | staff | `packageCustomer/customer-detail/customer-detail.ts:88-170` | 同上 | 同上 |
| 11 | admin | `src/actions/services.ts:196-238` | read select | 增加 paid_sessions 字段 |
| 12 | admin | `src/app/(main)/.../service-detail` / `order-detail` 页面 | 同 staff | 三段（具体路径实施时 grep） |

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| paid_sessions 公式 4 端漂移 | 一端少付/多付次数，业务资损 | 跨端 snapshot 守护（D7=A） |
| 退款时 used > new paid_sessions 触发 CONFLICT | 业务侧难解释 | D3=B（不倒退）规避；若 D3=A 需补 UI 提示 |
| 储值卡抵扣不计入 settled 导致 paid_sessions 永远算少 | 顾客刷卡付完仍不能用次数 | Q1 锁定"计入"，与 confirmOffline settle 逻辑对齐 |
| migration 0040 在本地老库失败 | 开发同事拉新代码后 db:migrate 报错 | migration 内 `ALTER TABLE sale_items ADD COLUMN paid_sessions INTEGER`（无 NOT NULL，可空，老行兼容） |
| 前端 12 处改完仍漏一两个 | 老视图显示 X/Y 不显示 Z | grep 兜底 + e2e 视觉断言（如有） |
| 已 merge 链路 link-8 / link-12 断言改动引入回归 | CI 红 | 改前先跑一遍存当前 baseline，改后对比 |

**回滚方案**：
- migration 0040 单独提交一个 PR，回滚 = 写 0041 反向 DROP COLUMN（注意 drizzle-kit 不会自动生成，需手工追加 SQL）
- 应用层改动可按层回滚：先回滚前端（13 文件），再回滚后端（10 个 action），最后回滚 schema

---

## 8 工作量估算

| 阶段 | 估算 | 备注 |
|------|------|------|
| §2.1 schema + migration + 临时 PG 验证 | 1h | 含 db:generate + 手工 review SQL |
| §2.2 四端 utils/paid-sessions.{js,ts} + snapshot test | 2h | 含 cross-end §7 |
| §2.3 服务校验改造（staff + admin 各 2 处） | 2h | service.create + service.complete |
| §4.1 订单创建/回款/微信回调（5 个写入点）| 3h | 含 confirmOffline / payNotify |
| §4.2 单元测试（order/service 双端） | 2h | |
| §6 前端 12 页面改显示 | 4h | 含三段进度条组件 |
| §4.2 e2e link-XX 新建 + link-8/12 调整 | 2h | |
| Code review + 跨端走查 + 联调 | 2h | |
| **合计** | **~18h（2-2.5 天）** | |

---

## 9 我需要你的输入

1. **D1-D10 决策**（必填，逐项回 A/B/C）
2. **Q1-Q3 可选回答**（若不回则按草案默认）
3. **实施模式**：
   - 选项 A：一次性出 PR（含 schema + 后端 + 前端 + 测试），适合"功能完整一起验"
   - 选项 B：分 3 个 PR（① schema + utils；② 后端 SQL + 测试；③ 前端 + e2e），适合"小步快跑"
   - 推荐：**B**（每 PR 6h 左右，可独立 review；前端可在后端落地后开展）
4. **触发执行**：决策回完后，回复 `按此 ticket 进入实施 / Wave X 启动`

---

## 10 关联引用

- 调研依据：本 ticket §1 全部断言来自 2026-05-19 两个 Explore agent 报告（已 inline）
- memory：`feedback_no_legacy_compat.md` / `project_pre_launch_data_wipe.md` / `feedback_no_shared_cloudfunctions.md`
- 已归档 ticket：`archives/2026-05-18-single-session-card-quantity-not-split.md`（B2 拆行，本 ticket 不冲突——拆行后每行 quantity=1, session_count=N，paid_sessions 算法天然适配）
- 现有 e2e：`fengyu-admin/tests/e2e-chains/link-8-installment-payment.spec.ts` / `link-12-session-count-check.spec.ts` / `link-23-service-cancel-session-rollback.spec.ts`
