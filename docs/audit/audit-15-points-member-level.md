# 审计报告：积分余额 + 流水 + 等级跳档触发 (15)

**审计时间**：2026-04-26
**域 ID**：15
**审计员**：claude-sonnet-4-6
**审计时长**：~30 分钟（独立重审，以代码为准）
**关联 PR/Ticket**：
- `notes/tickets/archives/2026-04-24-points-accrual-on-sale-order.md`
- `notes/tickets/archives/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`
- `db/migrations/0018_black_madrox.sql`（`paid_amount` DROP + `received`/`refunded_amount` ADD）

---

## 重审说明

本报告是对上一轮（claude-opus-4-7）审计报告的独立复核。所有发现均基于当前实际代码（2026-04-26 最新提交），不依赖上一轮结论。

**变更delta（相对上一轮）**：
- 确认 P0-15-01（admin 三触发点漏 settlePoints）：仍存在，未修复
- **发现新 P0（P0-15-01b）**：`staffApi/utils/points.js` 和 `payNotify/points.js` 引用已 DROP 的 `paid_amount` 列——上一轮漏报，本轮首次发现
- P0-15-04（cron 仅扫 '会员客'）：**代码已更新**，cron SQL 改用 `received - refunded_amount`，但 `WHERE customer_type = '会员客'` 限制**依然存在**（P0 维持）
- P0-15-03（`balance/history` 未 requirePhone）：确认，依然存在
- admin `recordPayment` 已新增 `recalcCustomerType` 调用，但仍无 `settlePoints`

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| 流水表 | `db/schema/points.ts:11`（`point_transactions`） | ↑ | ↑ |
| 余额缓存 | `db/schema/user.ts:72`（`points_balance INTEGER`） | ↑ | ↑ |
| 等级字段 | `db/schema/user.ts:36-42`（`member_level/locked_until/upgraded_at/old_member_level`） | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:101`（5 值：初钻/星钻/粉钻/金钻/黑钻）| ↑ | ↑ |
| 列表/流水 Action/Route | `fengyu-admin/src/actions/points.ts:98 getPointTransactionsPaginated` | — | `fengyu-client/cloudfunctions/clientApi/routes/points.js:14 balance / :37 history` |
| 列表前端 | `fengyu-admin/src/app/(main)/points/page.tsx` + `_components/points-page.tsx` | — | 未在本轮审计范围 |
| settle 工具（admin） | **缺**（P0-15-01）| `staffApi/utils/points.js`（**引用已 DROP 列 paid_amount，P0-15-01b**）| `clientApi/utils/points.js`（已更新，正确）|
| settle 工具（payNotify） | — | — | `payNotify/points.js`（**引用已 DROP 列 paid_amount，P0-15-01b**）|
| 支付回调写入 | — | — | `payNotify/index.js:537 settlePointsSafe` |
| 触发点（staff） | — | `routes/order.js:1024 confirmOffline` ✅ | — |
| 触发点（staff 退款） | — | `routes/order.js:1651 approveRefund`（注释：放弃旧路径，cascade 内已写）✅ | — |
| 触发点（client） | `actions/orders.ts:535 confirmOfflinePayment` ❌ / `orders.ts:1709 recordPayment` ❌ | — | `routes/order.js:1577 confirmPrepaidFull` ✅ / `:1768 repay` ✅ |
| 退款冲销（admin） | `lib/refund-cascade.ts:135 cascadeRefund 通道4` ✅ | `helpers/refund-cascade.js:92 通道4` ✅ | — |
| 跳档 cron | `cron/steps/refresh-member-levels.ts:44`（SQL 已更新，但 WHERE 限 '会员客'，P0-15-04 维持）| — | — |
| 余额对账 cron | `cron/steps/audit-points-balance.ts:24`（仅告警不修复）| — | — |
| 测试（client） | — | `__tests__/utils/points.test.js`（测试 mock 仍匹配 SUM(paid_amount)，P0-15-01b 镜像） | `__tests__/routes/points.test.js` + `__tests__/utils/points.test.js` |
| 测试（cron） | `cron/__tests__/refresh-member-levels.test.ts` ✅ | — | — |

---

## 2. 数据流图

```
[积分获取/冲销]
client.confirmPrepaidFull / client.repay
staff.confirmOffline
payNotify（微信回调）
   │ pg.transaction { ... settlePointsSafe(client, originalSaleOrderId, src) }
   │   ─── ⚠️ staffApi/utils/points.js 和 payNotify/points.js 在此用 paid_amount（已 DROP）
   ▼
settlePointsForOrder(originalSaleOrderId)
   1. SELECT client_user_id, sale_order_type FROM sale_orders FOR UPDATE
   2. SELECT SUM(paid_amount) ... [staffApi/payNotify 用已 DROP 列！]
      SELECT SUM(received - refunded_amount) ... [clientApi 已修正 ✅]
   3. expected = floor(max(0, netSettled) / 100)
   4. granted  = SUM(amount) FROM point_transactions WHERE ref_order_id=$1
   5. delta = expected - granted
      delta=0  → 天然幂等
      delta>0  → INSERT '消费赠送' + UPDATE points_balance += delta
      delta<0  → INSERT '消费冲销' + UPDATE points_balance += delta（负值）

[admin 两大资金触发点不调用 settlePoints —— P0-15-01，依然存在]
admin.confirmOfflinePayment(orders.ts:535) ❌（仅写状态+到期日+充值卡入账，无 settle）
admin.recordPayment(orders.ts:1709)        ❌（已新增 recalcCustomerType，但无 settle）

[admin 退款已通过 cascadeRefund 通道4 写积分冲销 —— 上一轮部分误判]
admin.approveRefund(refunds.ts:706) → cascadeRefund → 通道4 ✅
   （上一轮标记为 P0-15-01 的"admin approveRefund 漏 settlePoints"已经通过 cascadeRefund 修复）

[等级跳档（cron STEP 2，每日 03:00 Asia/Shanghai）]
SELECT user_id FROM client_wechat_users WHERE customer_type = '会员客'
   └─ 仍限 '会员客'（P0-15-04 未修复）
foreach user:
   spend = SUM(GREATEST(received - refunded_amount, 0)) 
           WHERE sale_order_type IN ('销售单','转换单')
           AND paid_at >= NOW() - INTERVAL '12 months'
   ← SQL 口径已更新（received - refunded_amount），不再用 paid_amount ✅
newLevel = determineMemberLevel(spend, threshold)
if upgrade → UPDATE + 150d locked_until + operation_logs + 三件套权益
if downgrade:
    if locked_until > now → 保级日志（不降）
    else                  → UPDATE level + 清 locked_until + operation_logs

[STEP 5 余额对账（仅告警不修复）]
WITH sums AS (SELECT user_id, SUM(amount) FROM point_transactions GROUP BY 1)
SELECT 不一致行 → INSERT operation_logs + notifyOps(企微 webhook)
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### P0-15-01 admin 两大资金触发点完全不调用 settlePoints —— 积分漏发（admin 端确认收款/录入回款路径）

> **⚠️ 重审修订**：上一轮将 admin `approveRefund` 列为第三个 P0 触发点，但实际已通过 `cascadeRefund` 通道4 写入积分冲销流水（`lib/refund-cascade.ts:135`），故退款积分冲销路径 **已正确处理**。P0 触发点由上一轮的 3 处缩减为 2 处。

- **文件**：
  - `fengyu-admin/src/actions/orders.ts:535 confirmOfflinePayment`
  - `fengyu-admin/src/actions/orders.ts:1709 recordPayment`
- **现象**：
  - `confirmOfflinePayment`（第 548-581 行）：事务内仅写 `status='已支付'` + `paidAt` + 单品到期日 + `applyRechargeOnOrderPaid`，**无任何积分结算调用**。
  - `recordPayment`（第 1769-1943 行）：事务内完整处理 payments 流水 + 重算 `received` + `recalcCustomerType`，但同样**无 settlePoints**。
- **对比**：staff/client/payNotify 同语义触发点全部调用：
  - `staffApi/routes/order.js:1024` confirmOffline → `settlePointsSafe` ✅
  - `clientApi/routes/order.js:1577` confirmPrepaidFull → `settlePointsSafe` ✅
  - `clientApi/routes/order.js:1768` repay → `settlePointsSafe` ✅
  - `payNotify/index.js:537` 微信回调 → `settlePointsSafe` ✅
- **风险**：
  1. **线下确认积分漏发**：admin 走 `confirmOfflinePayment`（`待确认收款` → `已支付`）不写积分。
  2. **回款积分漏发**：`recordPayment` 录入回款（线下/储值卡）后原单 `received` 累加，但积分不跟随增加。
  3. 若业务以 admin 路径为主（如 manager 用 admin 后台操作），积分长期漏发，STEP 5 对账会持续告警，且唯一兜底途径是 `settlePointsSafe` 逻辑，但 admin 端没有触发点。
- **复现**：
  1. 通过 admin 后台，将一笔 5000 元销售单点击"确认收款"（`待确认收款` → `已支付`）。
  2. 查 `point_transactions`：无新行。顾客本应得 50 积分丢失。
- **修复**（L7 admin actions）：
  - `confirmOfflinePayment` 事务内补：`await settlePointsSafe(tx, saleOrderId, 'admin.confirmOfflinePayment')`。
  - `recordPayment` 事务内补：当 `targetStatus === '已支付'` 时，`await settlePointsSafe(tx, saleOrderId, 'admin.recordPayment')`。
  - admin 需实现 Drizzle 风格 settlePoints（参考 `audit-points-balance.ts` 的 `db.execute(sql\`...\`)` 模式），或将 settle 逻辑抽为 `lib/points-settle.ts`。

---

#### P0-15-01b staffApi/utils/points.js 和 payNotify/points.js 引用已 DROP 的 paid_amount 列 —— 运行时必崩

> **⚠️ 新发现，上一轮漏报**

- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/utils/points.js:54`
  - `fengyu-client/cloudfunctions/payNotify/points.js:35`
- **现象**：
  - `staffApi/utils/points.js` 第 54 行：
    ```sql
    SELECT COALESCE(SUM(paid_amount), 0)::numeric AS net_settled
      FROM sale_orders
     WHERE sale_order_id = $1 OR ref_sale_order_id = $1
    ```
  - `payNotify/points.js` 第 35 行：同样的 SQL，同样引用 `paid_amount`。
  - `db/migrations/0018_black_madrox.sql:36` 明确：`ALTER TABLE "sale_orders" DROP COLUMN "paid_amount";`
  - 当前 `db/schema/order.ts:72` 注释：`原 paid_amount 列与 received 重复，已 DROP`
  - **对比**：`clientApi/utils/points.js:47-56` 已正确更新为：
    ```sql
    SELECT COALESCE(SUM(COALESCE(received,0) - COALESCE(refunded_amount,0)), 0)::numeric AS net_settled
      FROM sale_orders
     WHERE sale_order_id = $1 OR ref_sale_order_id = $1
    ```
  - `cron/steps/refresh-member-levels.ts:72` 也已正确使用 `received - refunded_amount`。
- **影响**：
  - 每次 staff 端 `confirmOffline` 或 payNotify 微信回调触发 `settlePointsSafe` → 执行 `settlePointsForOrder` → PG 报错 `column "paid_amount" does not exist` → `catch` 块写 `operation_logs(action='points.settleFailed')` → 积分**永远无法发放**。
  - 这意味着 staff 路径和微信回调路径的积分发放**自 migration 0018 上线后就已全部失效**，只有 clientApi 路径（用户扫码全额储值卡付款等）正常。
- **额外问题**：
  - `staffApi/__tests__/utils/points.test.js:48` mock 的 SQL 匹配条件仍是 `/SUM\(paid_amount\)/`，导致测试通过但实际 SQL 已经是错的——测试形成"假阳性"，掩盖了运行时问题。
- **风险量级**：所有 staff 端确认收款 + 所有微信支付回调积分发放自 0018 上线后全部失效，为**最高资损级别 P0**。
- **修复**（L3 staffApi + payNotify）：
  - `staffApi/utils/points.js:53-55`：将 `SUM(paid_amount)` 改为 `SUM(COALESCE(received,0) - COALESCE(refunded_amount,0))`，注释说明"回款/退款单迁出，通过原单 received/refunded_amount 表达链净额"。
  - `payNotify/points.js:33-37`：同上。
  - `staffApi/__tests__/utils/points.test.js:48`：更新 mock 匹配条件。

---

#### P0-15-03 client.points.balance / history 未前置 requirePhone —— 策略一致性违反 + 伪零余额

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/points.js:14-61`
- **现象**：`balance` 和 `history` 两个函数直接使用 `ctx.auth.userId`，不调用 `requirePhone()`。当用户未绑定手机号时，`auth` 中间件将 `userId` 设为 `null`（`middleware/auth.js:53-61`），`WHERE user_id = null` 返回 0 行 → `balance` 显示 0 / `history` 显示空数组。
- **对比**：同模块下 `card.js:85` 和 `coupon.js:15` 均有 `await requirePhone()(ctx, async () => {})` 守卫。
- **风险**：
  - 未绑定手机号的用户看到"积分 0"而非 `PHONE_REQUIRED:` 错误，UI 无法给出正确引导。
  - `history` 接口无分页上限窗口（`LIMIT $2 OFFSET $3` 可无限分页拉取全部历史积分流水，含 `ref_order_id` PII）。
- **修复**（L3）：
  - `balance` 函数开头加 `if (!ctx.auth.userId) throw new Error('PHONE_REQUIRED: 请先绑定手机号')`，或引入 `requirePhone()`。
  - `history` 同上，并在 SQL 加 `AND pt.created_at >= NOW() - INTERVAL '12 months'` 限制时间窗口；pageSize 入参加 `Math.min(pageSize, 100)` 上限。

---

#### P0-15-04 cron 跳档仅扫 customer_type='会员客'，其他类型顾客永远拿不到 member_level

- **文件**：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:48-56`
- **SQL**：
  ```sql
  SELECT user_id, member_level, member_level_locked_until
  FROM client_wechat_users
  WHERE customer_type = '会员客'
  ```
- **重审确认**：代码仍保持此限制，本轮未修复。
- **注意**：cron SQL 的消费额口径已修正为 `received - refunded_amount`（第 72 行 ✅），但扫描范围限制仍在。
- **风险**：
  - `customer_type ∈ {流量客, 体验客, 小美客}` 的顾客，即使滚动 12 月消费超过等级门槛，`member_level` 永远是 `null`。
  - 生日/感恩三件套入口 `grant-birthday-benefits.ts:51` 条件为 `member_level IS NOT NULL`，这些顾客无法享有。
- **修复选项**：
  - 选项 A：去掉 `WHERE customer_type = '会员客'`（全量顾客参与跳档）。
  - 选项 B：先确保"达消费门槛 → 自动跃迁会员客"完整运行，再依赖该 WHERE。
  - 选项 C：在规范文档中明确"等级仅限会员客"，接受此约束。

---

### 3.2 P1（数据一致 / 状态错乱）

#### P1-15-05 cron 跳档窗口（滚动 12 月）与 spending_tier 累计口径漂移

- **文件**：`refresh-member-levels.ts:71-77` vs `db/schema/enums.ts:120`（`spendingTierEnum`）
- **SQL**：
  - `member_level`：`paid_at >= (NOW() - INTERVAL '12 months')` 滚动 12 月
  - `spending_tier`：累计（`refreshSpendingTierTx` 无日期过滤，admin `refunds.ts:858`）
- **风险**：同一顾客消费 8 万后退款至 5 万，`spending_tier='6-10W'`（累计不变）但 `member_level` 可能降为初钻或更低，产生"高档位老客却是低等级会员"的矛盾展示。
- **修复**：与 audit-10 P0-10-06 合并讨论，统一时间窗口口径。

---

#### P1-15-06 grantUpgradeBenefits 积分写入仅有 external_ref partial unique 兜底，缺消费维度 UNIQUE

- **文件**：`db/schema/points.ts:29-32`（仅 `external_ref IS NOT NULL` partial unique）
- **现象**：`消费赠送`/`消费冲销` 类型的积分行（`external_ref` 为 null）没有 `(user_id, ref_order_id, type)` 联合 UNIQUE 约束。settle 算法依赖"差值法"幂等，任何外部手动 INSERT 重复行不会被 DB 拒绝。
- **修复**（L0）：
  ```sql
  CREATE UNIQUE INDEX uq_pt_consumption
    ON point_transactions(user_id, ref_order_id, type)
    WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销');
  ```

---

#### P1-15-07 admin points 列表 scopeCondition 按 bound_store_id 过滤，孤儿档案流水对非 admin 不可见

- **文件**：`fengyu-admin/src/actions/points.ts:52`
- **代码**：`const scope = scopeCondition(session!, clientWechatUsers.boundStoreId)`
- **风险**：`bound_store_id IS NULL` 的顾客（WorkFine 同步未补全或未绑门店）流水对 finance/manager 完全隐藏，对账时漏行。与 P0-15-01 修复后联动更严重：admin 录入回款的积分若 P0-15-01 修复，但这些顾客的流水仍不可见。
- **修复**（L7）：finance 角色不做 store scope 过滤，或将 NULL 视为"全员可见"。

---

#### P1-15-08 distinctTypes 受 scope 过滤，筛选下拉项与全局类型不一致

- **文件**：`actions/points.ts:163-167`
- **风险**：运营人员无法筛"当前 scope 下未出现的类型"做 negative 验证（如确认某个 store 的顾客是否有等级升级奖励）。
- **修复**（L7）：`distinctTypes` 不应用 scope，返回全局静态枚举集合。

---

#### P1-15-09 settle 跳过 anonymous-order 无 operation_logs 记录，匿名单积分永久丢失

- **文件**：`staffApi/utils/points.js:44-45`、`clientApi/utils/points.js:40-41`、`payNotify/points.js:29-31`
- **现象**：`client_user_id IS NULL`（顾客未注册但员工以手机号开单）→ 直接 `return {skipped: 'anonymous-order'}`，不写审计日志。日后顾客绑定手机号后无法追溯补发积分。
- **修复**（L3）：`skipped='anonymous-order'` 时写 `operation_logs(action='points.skippedAnonymous', target_id=saleOrderId)` 便于后续扫描补发。

---

#### P1-15-10 admin 无手动调整积分路径，运营客诉补偿必须直连 DB

- **文件**：`actions/points.ts`（仅 `getPointTransactionsPaginated`，无写入 action）
- **风险**：运营无法手动加扣分（如客诉补偿），只能通过直连 psql（违反 db/CLAUDE.md 规范）。
- **修复**（L7）：视产品需求，添加 `point_transaction:adjust` 权限 + 带强制 `operation_logs` + 必填理由的 admin action；或明确"积分仅由系统规则发放"。

---

#### P1-15-11 audit-points-balance 仅告警不修复 → 偏差无闭环

- **文件**：`cron/steps/audit-points-balance.ts`
- **现象**：偏差超过 5 条只 preview 前 5，剩余 95 条仅在 `operation_logs` jsonb 字段内，无结构化索引；无 SLA/工单路径。
- **修复**（L7）：
  - 偏差超过阈值升级为 P1 告警。
  - `operation_logs.detail` 加结构化字段（`expected/cached/delta`）。

---

#### P1-15-12 grantBirthdayBenefits 仅对 member_level IS NOT NULL 生效，与 P0-15-04 串联

- **文件**：`cron/steps/grant-birthday-benefits.ts:51-54`
- **风险**：流量客/体验客/小美客生日无法收到生日积分，与 P0-15-04 同根因。
- **修复**：与 P0-15-04 合并评估。

---

### 3.3 P2（代码质量 / 可维护）

#### P2-15-13 三端 settlePoints 副本注释/行为不一致，维护成本极高

- **文件**：
  - `staffApi/utils/points.js`（使用 `paid_amount`，已过时）
  - `clientApi/utils/points.js`（已更新 `received - refunded_amount`，有 2026-04-26 注释）
  - `payNotify/points.js`（使用 `paid_amount`，已过时）
- **现象**：三份代码本应"完全一致"，但 clientApi 版本已单独更新而另两份未同步——正是 P0-15-01b 的根本原因。
- **修复**（L0/L3）：
  - 短期：同步 staffApi/payNotify 两份副本。
  - 长期：抽 pg function 或公共 npm 包消除三副本。

---

#### P2-15-14 LEVEL_RANK 与 memberLevelEnum 顺序硬绑定

- **文件**：`cron/lib/member-level.ts` + `db/schema/enums.ts:101`
- **现象**：LEVEL_RANK 为 `{初钻:1, 星钻:2, ...}` 硬编码常量，未从枚举自动生成。
- **修复**（L0/L7）：改为从 `memberLevelEnum.enumValues` 自动推导。

---

#### P2-15-15 points_balance 类型为 INTEGER，溢出隐患

- **文件**：`db/schema/user.ts:72`（`pointsBalance: integer`）、`db/schema/points.ts:20`（`amount: integer`）
- **风险**：PG int4 范围 ±21 亿，大量错误回放/超大积分配置可触底。
- **修复**（L0）：切 `bigint` 或加 `CHECK (amount BETWEEN -10000000 AND 10000000)`。

---

#### P2-15-16 client points 测试未校验 requirePhone 缺失

- **文件**：`clientApi/__tests__/routes/points.test.js`
- **现象**：测试使用 `createBoundCtx`（已有 userId），未测试 `userId=null`（未绑定手机号）时的行为 → 即使加了 requirePhone 也不能回归验证。
- **修复**（L9）：补测 `userId=null` 时 balance/history 应返回 `PHONE_REQUIRED:`。

---

#### P2-15-17 staffApi points 测试 mock 匹配 SUM(paid_amount) —— 假阳性

- **文件**：`staffApi/__tests__/utils/points.test.js:48`
- **代码**：`if (/FROM\s+sale_orders/i.test(s) && /SUM\(paid_amount\)/i.test(s))`
- **风险**：当修复 P0-15-01b 后实际 SQL 改为 `SUM(received - refunded_amount)`，mock 不再匹配 → 测试需同步更新，否则 mock 返回 `{net_settled: 0}` 使测试逻辑偏离。
- **修复**（L9）：P0-15-01b 修复时一同更新 mock 条件为 `SUM(received)` / `SUM.*received.*refunded`.

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | cron | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|------|--------|
| 资金触发 settle | ❌ confirmOffline / recordPayment 缺 | ✅ confirmOffline（但 P0-15-01b 导致崩） | ✅ | ✅（但 P0-15-01b 导致崩） | — | 资损（P0-15-01/P0-15-01b） | P0 |
| settle 净额口径 | 缺 | `paid_amount`（已 DROP，错） | `received - refunded_amount`（正确） | `paid_amount`（已 DROP，错） | `received - refunded_amount`（正确） | staff/payNotify 运行时崩溃 | **P0** |
| 退款积分冲销 | `cascadeRefund` 通道4 ✅ | `cascadeRefund` 通道4 ✅ | — | — | — | 已对齐 | — |
| 跳档人群 | — | — | — | — | 仅 customer_type='会员客' | 流量/体验/小美 永远无 level | P0 |
| balance 鉴权 | requirePermission ✅ | — | **无 requirePhone** ❌ | — | — | 伪零余额 | P0 |
| 消费额口径 | — | — | — | — | received - refunded_amount（正确）| 与 spending_tier 累计漂移 | P1 |
| settle 副本一致性 | 缺 | 落后版本 | 最新正确版 | 落后版本 | 独立逻辑 | 修一端忘三端 | P0 |
| amount 类型 | INTEGER | INTEGER | INTEGER | INTEGER | INTEGER | 21 亿溢出 | P2 |
| ref_order_id UNIQUE | 仅 external_ref（partial） | 同 | 同 | 同 | 同 | 重复消费赠送塞入 | P1 |

---

## 5. 横切检查（CC1-CC9）

- [x] **CC1 数值精度**：settle 用 `Math.floor` + `Math.max(0, netSettled)` ✅；`amount integer`（P2-15-15）；无 NUMERIC，无 CHECK 约束。
- [ ] **CC2 并发幂等**：settle 差值法天然幂等 ✅；`paid_amount` 已 DROP 导致 staff/payNotify settle 崩溃（**P0-15-01b**）；ref_order_id 缺 UNIQUE（P1-15-06）；`points_balance += delta` PG read-committed 安全 ✅；cron 单线程 ✅；admin 两触发点缺 settle（P0-15-01）。
- [x] **CC3 组织隔离**：client 流水按 userId 严格隔离 ✅；admin scope 按 bound_store_id（孤儿档案不可见，P1-15-07）；staff 无 list 入口。
- [ ] **CC4 后端鉴权**：admin `requirePermission('point_transaction:list')` ✅；client `balance/history` **无 requirePhone**（P0-15-03）。
- [x] **CC5 错误码**：settle 失败包成 `skipped`/`error` 写 operation_logs，无直接 throw；无错误前缀问题。
- [ ] **CC6 PII**：`history` 含 `ref_order_id`（订单号）无时间窗口（P0-15-03/P2-15-16）；admin list 无操作日志（P2-15-10）。
- [x] **CC7 时间字段**：`point_transactions.created_at defaultNow()` ✅；`paid_at >= NOW() - INTERVAL '12 months'` 依赖 PG 时区配置（需确认 Asia/Shanghai）。
- [ ] **CC8 WXML/Vant**：client points 前端页面未在本轮审计范围。
- [ ] **CC9 测试与残留**：`staffApi/__tests__/utils/points.test.js:48` mock 匹配 `paid_amount`，假阳性（P2-15-17）；`clientApi/__tests__/routes/points.test.js` 未覆盖 userId=null 场景（P2-15-16）；cron `__tests__/refresh-member-levels.test.ts` ✅。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/points.ts` | 加 `(user_id, ref_order_id, type) WHERE ...` partial UNIQUE；amount 改 bigint | P1-15-06 / P2-15-15 |
| L0 schema | `db/schema/user.ts` | `points_balance: bigint` | P2-15-15 |
| **L3 云函数** | **`staffApi/utils/points.js:54`** | **`SUM(paid_amount)` → `SUM(COALESCE(received,0) - COALESCE(refunded_amount,0))`** | **P0-15-01b（最高优先）** |
| **L3 云函数** | **`payNotify/points.js:35`** | **同上** | **P0-15-01b（最高优先）** |
| L3 云函数 | `clientApi/routes/points.js:14` | 加 `requirePhone()`；history 加 12 月窗口 + pageSize 上限 | P0-15-03 |
| L3 云函数 | 三端 `utils/points.js` | `skipped='anonymous-order'` 写 operation_logs | P1-15-09 |
| L7 admin actions | `actions/orders.ts:578`（confirmOfflinePayment 事务尾） | 加 `await settlePointsSafe(tx, saleOrderId, 'admin.confirmOfflinePayment')` | P0-15-01 |
| L7 admin actions | `actions/orders.ts:1931`（recordPayment 事务内，`targetStatus==='已支付'` 分支后） | 加 `await settlePointsSafe(tx, saleOrderId, 'admin.recordPayment')` | P0-15-01 |
| L7 admin lib | `lib/points-settle.ts`（新建） | Drizzle 风格 settle 函数，供 admin actions 引用 | P0-15-01 |
| L7 admin cron | `cron/steps/refresh-member-levels.ts:51` | 评估是否去 `WHERE customer_type = '会员客'` | P0-15-04 |
| L7 admin actions | `actions/points.ts:163` | distinctTypes 改为静态枚举集合 | P1-15-08 |
| L9 测试 | `staffApi/__tests__/utils/points.test.js:48` | 更新 mock 匹配条件 | P2-15-17 |
| L9 测试 | `clientApi/__tests__/routes/points.test.js` | 补测 userId=null → PHONE_REQUIRED | P2-15-16 |

---

## 7. 验证 SQL（仅 SELECT / EXPLAIN，目标 5434/fengyu）

```sql
-- 7.1 确认 paid_amount 列是否已 DROP（P0-15-01b 依据）
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'sale_orders'
  AND column_name IN ('paid_amount', 'received', 'refunded_amount');
-- 预期：仅 received / refunded_amount，无 paid_amount

-- 7.2 量化 staff 路径积分失效（自 0018 上线后应有 settleFailed 日志）
SELECT COUNT(*), MAX(created_at)
FROM operation_logs
WHERE action = 'points.settleFailed'
  AND source IN ('staffApi', 'payNotify');
-- 若有大量记录，说明 P0-15-01b 已在生产触发

-- 7.3 量化 admin 路径积分漏发
SELECT so.sale_order_id, so.client_user_id, so.received, so.paid_at
FROM sale_orders so
LEFT JOIN point_transactions pt ON pt.ref_order_id = so.sale_order_id
WHERE so.sale_order_type = '销售单'
  AND so.received > 0
  AND so.client_user_id IS NOT NULL
  AND pt.id IS NULL
LIMIT 50;
-- 返回行 = admin 路径漏发的订单

-- 7.4 验证当前 points_balance 对账偏差
WITH sums AS (
  SELECT user_id, COALESCE(SUM(amount),0)::int AS total_from_txns
  FROM point_transactions GROUP BY user_id
)
SELECT u.user_id, u.points_balance AS cached, s.total_from_txns AS expected,
       (s.total_from_txns - u.points_balance) AS delta
FROM client_wechat_users u
LEFT JOIN sums s ON s.user_id = u.user_id
WHERE COALESCE(u.points_balance,0) <> COALESCE(s.total_from_txns,0)
LIMIT 20;

-- 7.5 检查 customer_type 非会员客但 12 月消费 >= 10000 的顾客（应升未升）
SELECT cwu.user_id, cwu.customer_type, cwu.member_level,
       COALESCE(SUM(GREATEST(so.received::numeric - so.refunded_amount::numeric, 0)), 0) AS spend12m
FROM client_wechat_users cwu
LEFT JOIN sale_orders so ON so.client_user_id = cwu.user_id
  AND so.sale_order_type IN ('销售单','转换单')
  AND so.paid_at >= NOW() - INTERVAL '12 months'
WHERE cwu.customer_type <> '会员客'
GROUP BY cwu.user_id, cwu.customer_type, cwu.member_level
HAVING COALESCE(SUM(GREATEST(so.received::numeric - so.refunded_amount::numeric, 0)), 0) >= 10000
ORDER BY spend12m DESC NULLS LAST
LIMIT 30;

-- 7.6 检查 ref_order_id 重复 INSERT（partial unique 缺失脏数据）
SELECT user_id, ref_order_id, type, COUNT(*) cnt
FROM point_transactions
WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
GROUP BY 1,2,3 HAVING COUNT(*) > 1
LIMIT 20;
```

---

## 8. 回归测试用例（建议）

1. **P0-15-01b 修复验证**：staff 端 `confirmOffline` 一笔 3000 元销售单 → 查 `point_transactions`：应有 `type='消费赠送', amount=30` 行；`points_balance` 加 30。
2. **P0-15-01b payNotify 修复验证**：微信支付回调 → 查 `point_transactions`：无 `action='points.settleFailed'` 日志。
3. **P0-15-01 修复验证（admin confirmOffline）**：admin 后台"确认收款"5000 元单 → `point_transactions` 有 `amount=50` 行。
4. **P0-15-01 修复验证（admin recordPayment）**：admin 后台"录入回款"2000 元（销售单变为已支付）→ `point_transactions` 有 `amount=20` 行。
5. **P0-15-03 修复验证**：未绑定手机号用户调 `points.balance` → 返回 `PHONE_REQUIRED:` 错误，不返回 0。
6. **P0-15-04 修复验证**：流量客消费 11000 元 → 跑 cron → `member_level` 升至星钻（当前：null，不升）。
7. **对账验证**：运行 7.4 SQL，P0-15-01/01b 修复前后对比偏差行数应减少。
8. **幂等验证**：同一 saleOrderId 多次调用 `settlePointsForOrder` → `point_transactions` 无重复行，`points_balance` 不重复加。
9. **退款冲销验证**：支付 8000 → 审批退款 8000 → `points_balance` 净变化为 0（获得 80 分后冲销 80 分）。
10. **150d 保级解锁降级**：`member_level_locked_until` 已过期 → cron 实际降级；未过期 → 保级日志（已有测试 ✅）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（P0-15-01b：自 migration 0018 上线后 staff/payNotify 积分全部失效，存量需补发；P0-15-01：admin 路径漏发订单积分需一次性补发）
- 修复成本：**M**（P0-15-01b 仅改 3 行 SQL + 更新测试 mock；P0-15-01 需新建 admin lib/points-settle.ts + 两处调用）

---

## 10. 后续待办

- [ ] **立即**：修复 `staffApi/utils/points.js:54` 和 `payNotify/points.js:35`，将 `paid_amount` 改为 `received - refunded_amount`（P0-15-01b）。
- [ ] **立即**：运行 7.2 SQL 量化生产损失（operation_logs settleFailed 记录数）；运行 7.3 SQL 量化 admin 漏发量。
- [ ] 修复 admin `confirmOfflinePayment` 和 `recordPayment` 补 settlePointsSafe（P0-15-01）。
- [ ] 写一次性补发脚本：扫 7.3 SQL 找漏发订单 → 跑 settlePointsForOrder 补发（注意去重幂等）。
- [ ] 评估 cron 跳档人群限制（P0-15-04）的产品语义，与 PM 确认后去掉或保留 `WHERE customer_type = '会员客'`。
- [ ] client `points.js` 加 `requirePhone()` 守卫 + `history` 12 月窗口（P0-15-03）。
- [ ] 写补丁迁移：partial UNIQUE on `point_transactions(user_id, ref_order_id, type)` + amount CHECK（P1-15-06 / P2-15-15）。
- [ ] 与 audit-10 P0-10-06 合并讨论 member_level / spending_tier / customer_type 三口径统一（P1-15-05）。
- [ ] 更新 `staffApi/__tests__/utils/points.test.js:48` mock 条件（P2-15-17）。
