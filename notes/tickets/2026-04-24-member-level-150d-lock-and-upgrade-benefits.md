# Ticket: 会员等级 150 天保级规则 + 升级权益发放可靠性完善

> 生成日期：2026-04-24
> 严重级别：P1（会员运营核心规则缺失 + 权益发放幂等性缺口）
> 端：db（schema + migration）+ fengyu-client/cloudfunctions/cronTask（核心改造）+ fengyu-admin（顾客详情页只读展示 + 退款表单权益扣除区块）
> 影响面：
>   - `db/schema/user.ts`（+2 列）
>   - `db/schema/message.ts`（+1 列 + 部分索引）
>   - `db/schema/points.ts`（+1 列 + 部分索引）
>   - `db/schema/system-config.ts`（+1 默认 key `points_to_yuan_rate`）
>   - `db/schema/order.ts`（`sale_orders` 退款单相关 +2 列 `overdraft_deduction` / `overdraft_deduction_detail`，与 Ticket 3 协同）
>   - `db/utils/member-level.ts`（新建：等级判定工具抽取到共享层）
>   - `fengyu-client/cloudfunctions/cronTask/index.js`（`refreshMemberLevels` 改造 + `grantUpgradeBenefits` 幂等化 + 消费额 SQL 修正）
>   - `fengyu-admin/src/actions/refunds.ts`（新增 `estimateRefundOverdraft` + 退款提交时应用扣除）
>   - `fengyu-admin/src/components/refunds/RefundForm.tsx`（新增会员权益调整区块）
>   - `fengyu-admin/src/app/(main)/customers/[id]/page.tsx`（只读展示保级日）
> 前置：可独立合并；与 `2026-04-24-order-partial-payment-foundation.md`（Ticket 1）合并后消费额精度自然提升
> 协同：**本 ticket §7 与 `2026-04-24-refund-admin-parity-and-rules.md`（Ticket 3 退款）强耦合**——`estimateRefundOverdraft` 由本 ticket 负责，而 `RefundForm` 与退款提交流程由 Ticket 3 提供。二者需同步 merge
> 并行：与 `2026-04-24-multi-repayment-three-ends.md`（多次回款）无冲突
>
> **一句话目标**：为 `client_wechat_users` 引入 `member_level_locked_until` 与 `member_level_upgraded_at` 两列，实现"升级后 150 天不降级"规则；把 `grantUpgradeBenefits()` 的消息和积分发放加上幂等键，保证 cron 重跑/失败重试不会重复发送；把滚动 12 个月消费额 SQL 从 `SUM(total_amount) WHERE status IN (…) AND sale_order_type != '内部单'` 改为 `SUM(paid_amount) WHERE sale_order_type = '销售单' AND paid_amount > 0`；并在退款时自动预判等级跌档，将"升级以来已享用的优惠券核销价值 + 已用升级奖励积分折现"从退款金额中扣除（顾客不降级或无跌档时不扣）。

---

## 0 一句话背景

需求原文：
> admin 会员权益页面的升级权益，需要在用户会员等级提升的情况下发送消息、发放积分和优惠券。会员等级字段来自 `clientWechatUsers.memberLevel`。会员等级可以保持 150 天不降级。如果这 150 天中没有升级，则过了 150 天需要重新计算。

调研发现仓库现状比预期完善——**会员权益配置页和升级发放链路已存在**：

| 模块 | 现状 | 关键位置 |
|---|---|---|
| admin 权益配置页（upgrade/birthday/thanksgiving 三场景）| ✅ 完整 | `fengyu-admin/src/app/(main)/member-benefits/page.tsx` + `_components/member-level-benefits-form.tsx` |
| 配置 Server Action | ✅ 完整 | `fengyu-admin/src/actions/settings.ts:14-39,256-346`（`MemberLevelBenefit` 接口 + `getMemberBenefits` / `saveMemberBenefits`）|
| `memberLevelEnum` 五档 | ✅ 定义 | `db/schema/enums.ts:93` |
| `clientWechatUsers.memberLevel` 字段 | ✅ 存在 | `db/schema/user.ts:36` |
| 每日 03:00 cron 触发器 | ✅ 配置 | `fengyu-client/cloudfunctions/cronTask/index.js`（`0 0 3 * * * *`）|
| 滚动 12 个月消费额重算 | ✅ 有但口径偏差 | `cronTask/index.js:202-211` |
| 升级发消息/积分/券 | ✅ 有但幂等不足 | `cronTask/index.js:122-181`（`grantUpgradeBenefits`）|

**真正缺口有五个**：150 天保级未实现、消费额口径不准、消息/积分无幂等键、缺乏可观测（admin 看不到某顾客的保级截止日）、退款导致降级时未扣回已享用的超额权益。

---

## 1 问题定位

### 1.1 缺口一：150 天保级规则未实现

`cronTask/index.js:90-92`：
```js
function isUpgrade(from, to) {
  return (LEVEL_RANK[to] || 0) > (LEVEL_RANK[from] || 0)
}
```

`cronTask/index.js:247-254`：
```js
if (isUpgrade(oldLevel, newLevel)) {
  if (benefitsConfig?.[newLevel]) {
    await grantUpgradeBenefits(client, row.user_id, oldLevel, newLevel, benefitsConfig[newLevel])
  }
  upgradeCount++
} else {
  downgradeCount++    // ← 现状：降级立即生效，无任何保护
}
```

**问题**：只要滚动 12 月消费额低于当前等级阈值，次日 cron 立即降档。用户期望升级后 150 天内不降级。

### 1.2 缺口二：消费额 SQL 口径偏差

`cronTask/index.js:202-211`：
```sql
SELECT COALESCE(SUM(total_amount::numeric), 0) AS spend
FROM sale_orders
WHERE client_user_id = $1
  AND status IN ('已支付', '已完成')
  AND sale_order_type != '内部单'
  AND paid_at >= (NOW() - INTERVAL '12 months')
```

**问题**（按严重性递减）：
1. 用 `total_amount` 而非 `paid_amount` — 下了单但未付完的订单按全额计入，高估消费
2. `sale_order_type != '内部单'` 会**包含**"回款单/转换单/退款单"。其中回款单是原销售单的分次到账凭证，原单已被计入一次，回款单再计入 → **双计**。退款单若为正数，成为负向业务却被当成正向消费
3. `status IN ('已支付','已完成')` 排除 `'部分支付'` — 部分付款订单的已付款部分被完全漏算
4. 用户明确要求的业务语义（"回款/退款的概念正在替换为 `sale_order_payments` 流水"）未体现

### 1.3 缺口三：消息和积分发放无幂等键

`cronTask/index.js:122-181` 的 `grantUpgradeBenefits()` 分三步：

| 步骤 | 行 | 幂等性 |
|---|---|---|
| INSERT `messages`（recipient_type='客户', message_type='system'）| 124-130 | ❌ 无 |
| INSERT `point_transactions` + UPSERT `customer_points.balance` | 133-147 | ❌ 无 |
| INSERT `user_coupons`（幂等 key `cpn-up-{userId}-{level}-{templateId}`）| 150-180 | ✅ 有 |

虽然外层 `refreshMemberLevels` 的单用户事务（`cronTask/index.js:222-256`）保证了"要么全成功要么全回滚"，但：
- cron 重跑（如运维手动重跑当日任务）→ 消息和积分会被**重复发放**
- 等级回升场景：A→B→A→B，第二次升 B 时 `user_coupons` 幂等键命中跳过，但消息和积分会再发一次，造成三件套不一致

### 1.4 缺口四：admin 缺可观测字段

顾客详情页 `/customers/[id]` 目前无法查看某顾客的保级截止日、最近升级时间。店长/管理员若需处理"为什么这个顾客没降级"或"他什么时候升的金钻"问题，只能查 `operation_logs`。

### 1.5 缺口五：退款引起降级时未回收已享超额权益

顾客升至星钻 → 已核销价值 ¥200 的优惠券 + 已用 300 分升级奖励积分（折 ¥3）→ 发生 ¥5000 退款 → 滚动 12 月消费跌至初钻档位 → 保级期已过 → 按新规则应降级为初钻。但当前系统**不会**从退款金额中扣回已享用的超额权益（星钻权益 vs 初钻权益之差），相当于顾客享受了星钻待遇又全额拿回退款。

**业务诉求**：退款时预判"若本次退款执行，等级会不会跌档"，若会跌且已享用的权益超过新等级应享权益 → 自动扣除差额（默认勾选，admin 可取消）。

---

## 2 用户确认的规则（决策基准线）

| # | 规则 | 决策 |
|---|---|---|
| 1 | 保级期计时起点 | **升级时间起算**，`locked_until = upgraded_at + 150 days`；后续消费**不**续期；保级期内若再升更高档则 `locked_until` 重置为新的 `NOW()+150d` |
| 2 | 消费额口径 | 按 `paid_amount` 累计；仅 `sale_order_type = '销售单'` 计入；退款通过 `sale_order_payments` 负流水减少原销售单 `paid_amount`，SQL 自然冲抵；**内部单/转换单/回款单/退款单** 均不参与聚合 |
| 3 | 降级通知 | **静默降级**；仅写 `operation_logs`；不推送消息、不扣积分、不回收券 |
| 4 | 本 ticket 范围 | 仅 `upgrade` 场景 + 150 天保级规则；`birthday` / `thanksgiving` 另开 ticket |
| 5 | 五档阈值 | 保持不变（1990/10000/30000/60000/100000）；初钻下限仍从 `system_configs.new_member_threshold` 读取 |
| 6 | 滚动窗口 | 保持 `NOW() - INTERVAL '12 months'` |
| 7 | 退款引起降级时的权益回收口径 | **仅已核销的优惠券** + **升级以来已使用的积分**（FIFO 近似）；未使用部分不回收 |
| 8 | 权益价值换算 | 优惠券按 `coupon_templates.discount_value` 计价；积分按 `system_configs.points_to_yuan_rate` 换算；顾客应退额封顶为本次 refundAmount（永不倒付） |
| 9 | 扣除生效方式 | admin 退款表单自动计算并展示建议值，默认勾选"应用此扣除"，管理员可取消或调整后提交 |

---

## 3 Schema 变更

### 3.1 `db/schema/user.ts` — `clientWechatUsers` 新增两列

在 `memberLevel` 字段附近（`db/schema/user.ts:36`）追加：

```ts
/** 会员等级保级截止时间；升级时设为 NOW()+150 天；保级期内跳过降级 */
memberLevelLockedUntil: timestamp('member_level_locked_until', { withTimezone: true }),

/** 最近一次升级时间戳（审计用；定位"什么时候升的金钻"之类问题）*/
memberLevelUpgradedAt: timestamp('member_level_upgraded_at', { withTimezone: true }),
```

### 3.2 `db/schema/message.ts` — `messages` 新增幂等键

```ts
/** 幂等键；cronTask/权益发放/系统触发类消息使用，业务消息可为 null */
idempotencyKey: text('idempotency_key'),
```

加部分唯一索引（仅对非 null 行生效，避免业务消息被约束）：
```ts
uniqueIndex('uq_messages_idempotency_key')
  .on(table.idempotencyKey)
  .where(sql`idempotency_key IS NOT NULL`),
```

### 3.3 `db/schema/points.ts` — `pointTransactions` 新增外部引用

```ts
/** 外部幂等引用；系统批量发放（升级/活动）使用，业务发放可为 null */
externalRef: text('external_ref'),
```

加部分唯一索引：
```ts
uniqueIndex('uq_point_txns_external_ref')
  .on(table.externalRef)
  .where(sql`external_ref IS NOT NULL`),
```

### 3.4 `db/schema/system-config.ts` — 新增默认配置 key

迁移中加入 seed 数据：

```sql
INSERT INTO system_configs(key, value) VALUES
  ('points_to_yuan_rate', '0.01')  -- 100 积分 = 1 元（运营可调）
ON CONFLICT (key) DO NOTHING;
```

admin `actions/settings.ts` 增加 `getPointsToYuanRate()` 读取函数（若 key 缺失回退 `0.01`），供 `estimateRefundOverdraft` 调用。

**若未来此比例需要在 admin 有 UI 可配置**，放在 `/member-benefits` 页面新增一个输入框；本 ticket 不做 UI，仅保证 DB 中有默认值。

### 3.5 `db/schema/order.ts` — `sale_orders` 退款单相关列（与 Ticket 3 协同）

在 `sale_orders` 表新增两列（退款单 `sale_order_type='退款单'` 使用；销售单行保留 NULL）：

```ts
/** 退款单专用：因会员等级跌档扣除的超额权益价值（元） */
overdraftDeduction: numeric('overdraft_deduction', { precision: 10, scale: 2 }).default('0'),

/** 退款单专用：超额权益扣除明细，审计用 */
overdraftDeductionDetail: jsonb('overdraft_deduction_detail'),
```

`overdraftDeductionDetail` JSON 结构：

```json
{
  "_v": 1,
  "fromLevel": "星钻",
  "toLevel": "初钻",
  "upgradedAt": "2026-02-10T08:12:00Z",
  "usedCouponValue": 200,
  "usedCoupons": [{ "couponId": "cpn-up-FYGK-...-星钻-spring", "discountValue": 200 }],
  "grantedPoints": 500,
  "usedUpgradePoints": 300,
  "pointsToYuanRate": 0.01,
  "usedPointsValue": 3,
  "currentBenefitsValue": 500,
  "newBenefitsValue": 210,
  "benefitValueDiff": 290,
  "refundAmount": 500,
  "suggestedDeduction": 203,
  "actualDeduction": 203,
  "adminOverride": false
}
```

**协同说明**：Ticket 3 负责在 `RefundForm` 提交流程中读取这两列并写入值；本 ticket 负责提供 `estimateRefundOverdraft` 计算函数。PR-5 同步处理。

### 3.6 迁移

按 `db/CLAUDE.md` 强制流程执行：
1. 改 `schema/*.ts`（`user.ts` + `message.ts` + `points.ts` + `order.ts` + `system-config.ts` 的 seed）
2. `npm run db:generate` 产出 `migrations/00NN_member_level_lock_idempotency_overdraft.sql`
3. 临时 docker PG（端口 54399）空库 apply 验证
4. 提交 PR 包含 schema + migration + `meta/` 三者
5. merge 后**对两库都跑** `db:migrate`（5434 + 5433）

**关键**：
- 新增列均为 NULL 可空或带默认值，无数据回填
- `system_configs` 的 `points_to_yuan_rate` seed 用 `ON CONFLICT DO NOTHING` 以兼容已有库
- 但需考虑 §11.1 的历史会员处理

---

## 4 消费额 SQL 修正

### 4.1 新 SQL（替换 `cronTask/index.js:202-211`）

```sql
SELECT COALESCE(SUM(paid_amount::numeric), 0) AS spend
FROM sale_orders
WHERE client_user_id = $1
  AND sale_order_type = '销售单'
  AND paid_amount > 0
  AND paid_at >= (NOW() - INTERVAL '12 months')
```

### 4.2 逐条变更理由

| 变更 | 理由 |
|---|---|
| `total_amount` → `paid_amount` | 以实付为准；部分付款订单的已付款部分能被计入；退款（payments 负流水减少 paid_amount）能自然冲抵 |
| `sale_order_type != '内部单'` → `sale_order_type = '销售单'` | 白名单更安全；排除回款单/转换单/退款单的双计/异常计入 |
| 去掉 `status IN ('已支付','已完成')` | 状态不再作为过滤条件；`paid_amount > 0` 已保证是"真实产生过资金流入"的订单 |
| 新增 `paid_amount > 0` | 过滤掉 `paid_amount = 0` 的订单（草稿/取消/全额退款后归零）|
| 保留 `paid_at >= NOW() - 12 months` | 滚动 12 个月窗口 |

### 4.3 关于 `paid_at` 的语义

`paid_at` 现状为**首次付清时间戳**。多次回款场景下，付清前每次 payments 追加不更新此列（Ticket 1 合并后由 `recalcSaleOrderPayment()` 在订单首次达到 `paid_amount >= payable_amount` 时设置）。

**副作用**：一个订单 `paid_at` 落在 12 月窗口外但最近发生了退款（payments 负流水） → 退款不会从消费额里扣除（因为原单已被窗口过滤掉）。**决策**：接受此副作用，不引入额外复杂度；本身也符合"12 月前消费不算数"的直觉。

---

## 5 `refreshMemberLevels` 三分支重写

### 5.1 新分支结构（替换 `cronTask/index.js:216-260`）

```
计算 newLevel
  ├─ newLevel === oldLevel        → processStable（unchangedCount++, continue）
  ├─ isUpgrade(oldLevel, newLevel) → processUpgrade（事务内）
  └─ isDowngrade                  → processDowngrade（事务内）
```

### 5.2 `processUpgrade`

单用户事务，与现状等价但显式维护保级字段：

```js
await client.query('BEGIN')
try {
  await client.query(
    `UPDATE client_wechat_users
       SET member_level = $1,
           member_level_upgraded_at = NOW(),
           member_level_locked_until = NOW() + INTERVAL '150 days',
           updated_at = NOW()
     WHERE user_id = $2`,
    [newLevel, userId]
  )

  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
    [userId, JSON.stringify({
      _v: 3, _t: 'transition',
      from: oldLevel, to: newLevel,
      context: { rolling12mSpend: spend, trigger: 'cronTask', lockedUntil: '+150d' },
    })]
  )

  if (benefitsConfig?.[newLevel]) {
    await grantUpgradeBenefits(client, userId, oldLevel, newLevel, benefitsConfig[newLevel])
  }

  await client.query('COMMIT')
  upgradeCount++
} catch (err) {
  await client.query('ROLLBACK')
  throw err
}
```

### 5.3 `processDowngrade`

关键：保级期内跳过降级；保级期过后降级并清空 `locked_until`。

```js
const lockedUntil = row.member_level_locked_until  // SELECT 时带出
if (lockedUntil && new Date(lockedUntil) > new Date()) {
  // 保级期内：不降级，仅日志
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('customer.memberLevelHeld', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
    [userId, JSON.stringify({
      _v: 3, _t: 'hold',
      currentLevel: oldLevel, recomputedLevel: newLevel,
      context: { rolling12mSpend: spend, lockedUntil, reason: '150d_lock' },
    })]
  )
  heldCount++
  return
}

// 保级期已过或从未升级过：静默降级
await client.query('BEGIN')
try {
  await client.query(
    `UPDATE client_wechat_users
       SET member_level = $1,
           member_level_locked_until = NULL,
           updated_at = NOW()
     WHERE user_id = $2`,
    [newLevel, userId]
  )
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
    [userId, JSON.stringify({
      _v: 3, _t: 'transition',
      from: oldLevel, to: newLevel,
      context: { rolling12mSpend: spend, trigger: 'cronTask', direction: 'downgrade' },
    })]
  )
  await client.query('COMMIT')
  downgradeCount++
} catch (err) {
  await client.query('ROLLBACK')
  throw err
}
```

### 5.4 需要扩展的 SELECT

`cronTask/index.js:191-193` 改为：
```sql
SELECT user_id, member_level, member_level_locked_until
FROM client_wechat_users
WHERE customer_type = '会员客'
```

### 5.5 返回值新增 `heldCount`

```js
return { upgradeCount, downgradeCount, heldCount, unchangedCount, errorCount, total: memberClients.length }
```

---

## 6 `grantUpgradeBenefits` 幂等化

### 6.1 幂等键格式

| 资源 | 字段 | 格式 | 说明 |
|---|---|---|---|
| messages | `idempotency_key` | `member-upgrade-{userId}-{toLevel}` | 同一用户升到同一等级只发一次消息 |
| point_transactions | `external_ref` | `member-upgrade-{userId}-{toLevel}` | 同一用户升到同一等级只发一次积分 |
| user_coupons | `coupon_id`（PK）| `cpn-up-{userId}-{toLevel}-{templateId}` | 已有，保持不变 |

**连升两档场景**（A 月升星钻 → B 月又升粉钻）：
- A 月：写 key `member-upgrade-U1-星钻` → 成功发放
- B 月：写 key `member-upgrade-U1-粉钻` → 新 key，成功发放
- 若 B 月因 bug 跑了两次 → key 冲突，第二次 ON CONFLICT DO NOTHING，不重发

**等级回升场景**（A 月升星钻 → B 月降星钻 → C 月又升星钻）：
- A 月：写 key `member-upgrade-U1-星钻`
- C 月：写 同 key → 冲突 → **不发**消息和积分（券也同样不发）
- **决策**：此行为符合用户心智（"已经给过你星钻权益了"）。若未来需要"回升再发"，可改 key 格式为 `{年月}-{userId}-{toLevel}`；现阶段**不加**这个复杂度。

### 6.2 改造后的 SQL（替换 `cronTask/index.js:124-147`）

```js
// 1) 消息（幂等）
if (config.messageTitle) {
  await client.query(
    `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
     VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [userId, config.messageTitle, config.messageBody || null, `member-upgrade-${userId}-${toLevel}`]
  )
}

// 2) 积分（幂等 + 余额条件更新）
if (config.points && config.points > 0) {
  const ref = `member-upgrade-${userId}-${toLevel}`
  const inserted = await client.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
     VALUES ($1, '等级升级奖励', $2, NULL, $3, NOW())
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, config.points, ref]
  )

  // 只有真正插入了新流水，才累加余额；否则跳过（避免重跑双加）
  if (inserted.rowCount > 0) {
    await client.query(
      `INSERT INTO customer_points (user_id, balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET balance = customer_points.balance + EXCLUDED.balance,
             updated_at = NOW()`,
      [userId, config.points]
    )
  }
}
```

### 6.3 `processUpgrade` 的事务与 `grantUpgradeBenefits` 的关系

`grantUpgradeBenefits` 仍在外层事务内执行（见 §5.2）。幂等键是**事务间**保护（两次事务间隔 cron 重跑），事务本身保证**事务内**原子性。

---

## 7 退款降级的超额权益回收

### 7.1 背景与触发条件

用户需求原文：
> 若中途有退款现象影响等级变化降级，期间已享受的权益超出新等级权益，将按项目价值从退款中扣除。

**场景**：顾客升星钻 → 获得星钻权益（发消息/积分/券）→ 期间用掉了部分权益 → 发生退款 → 滚动 12 月消费跌至初钻档 → 保级期已过 → 本应降级。此时顾客"已享用的星钻权益"超过"本应享用的初钻权益"的部分，从本次退款中扣除。

**触发条件**（四者全部满足才启动回收计算）：
1. admin 在 `RefundForm` 提交退款（Ticket 3 退款流程）
2. 该顾客当前 `member_level` 非 null
3. 模拟"退款生效后的 `paid_amount`"重算滚动 12 月消费 → 计算得到的新等级 `<` 当前等级
4. `member_level_locked_until IS NULL OR member_level_locked_until <= NOW()`（保级期已过 / 从未升级）

**若任一条件不满足**：退款正常执行，不扣除；admin 表单仍展示一行说明（如"顾客处于保级期至 2026-08-12，本次退款不影响等级"）以提示运营。

### 7.2 权益口径（用户已确认）

| 权益 | 计入 | 不计入 | 说明 |
|---|---|---|---|
| 优惠券 | `status='已使用'` 的券（即已核销）| `status='未使用'` / `'已过期'` 的券 | 按 `coupon_templates.discount_value` 计价 |
| 积分 | 已在订单中使用的（抵扣消费）| 未使用的 `customer_points.balance` 余额 | 按 `system_configs.points_to_yuan_rate` 换算 |
| 消息 | — | — | 消息无金额属性，不计 |

**已使用积分 FIFO 近似**：升级后发放的积分可能与"自然消费累计积分"混在一个余额池里，难以精确拆分。本 ticket 采用 FIFO 近似算法：认为"升级以来已扣除的积分"优先消耗升级奖励部分。

### 7.3 `estimateRefundOverdraft` Server Action

新增在 `fengyu-admin/src/actions/refunds.ts`（该文件由 Ticket 3 创建或扩展）：

```ts
export async function estimateRefundOverdraft(params: {
  userId: string
  refundAmount: number       // 本次拟退金额，单位：元
  originalSaleOrderId: string // 原销售单号，用于权益回收上下文
}): Promise<{
  currentLevel: MemberLevel | null
  recomputedLevel: MemberLevel | null      // 退款后应降到的等级
  willDowngrade: boolean                    // 是否触发降级
  lockedUntilStatus: 'none' | 'in_lock' | 'expired'
  upgradedAt: Date | null                   // member_level_upgraded_at
  usedCouponValue: number                   // 已核销券总面值（元）
  usedPointsValue: number                   // 已用积分折现（元）
  currentBenefitsValue: number              // 当前等级升级时应发权益总值（元）
  newBenefitsValue: number                  // 降级后应享权益总值（元）
  benefitValueDiff: number                  // max(0, currentBenefitsValue - newBenefitsValue)
  suggestedOverdraftDeduction: number       // = MIN(usedCouponValue + usedPointsValue, benefitValueDiff, refundAmount)
  detail: {
    usedCoupons: Array<{ couponId: string; templateId: string; discountValue: number; usedAt: Date }>
    usedPoints: number  // 升级以来已扣积分
    grantedPoints: number  // 升级时发放的积分
  }
}>
```

**关键 SQL**：

```sql
-- 7.3.a 查询升级时间戳
SELECT member_level, member_level_upgraded_at, member_level_locked_until
FROM client_wechat_users
WHERE user_id = $1;

-- 7.3.b 已核销升级奖励券总面值（幂等 key 前缀 cpn-up- 识别"升级发放"）
SELECT COALESCE(SUM(ct.discount_value::numeric), 0) AS used_coupon_value
FROM user_coupons uc
JOIN coupon_templates ct ON ct.template_id = uc.template_id
WHERE uc.user_id = $1
  AND uc.coupon_id LIKE 'cpn-up-' || $1 || '-' || $2 || '-%'  -- 当前等级发的
  AND uc.status = '已使用'
  AND uc.used_at >= $3;  -- upgraded_at

-- 7.3.c 升级时发放的积分总数（external_ref 识别）
SELECT COALESCE(SUM(amount), 0) AS granted_points
FROM point_transactions
WHERE user_id = $1
  AND external_ref = 'member-upgrade-' || $1 || '-' || $2;  -- 当前等级

-- 7.3.d 升级以来已扣积分总数（FIFO 近似的分子）
SELECT COALESCE(SUM(-amount), 0) AS used_points
FROM point_transactions
WHERE user_id = $1
  AND type = '扣除'         -- 注：现状 type 自由文本，需确认实际扣减的 type 值
  AND created_at >= $3;

-- 实际归属于升级奖励的已用积分 = MIN(granted_points, used_points)
```

**退款后等级预判**：

```ts
const currentSpend = await rolling12mSpend(userId)  // 复用 §4 新 SQL
const projectedSpend = currentSpend - refundAmount
const recomputedLevel = determineMemberLevel(projectedSpend, memberThreshold)
```

（注：`determineMemberLevel` 与 `memberThreshold` 当前只在 `cronTask/index.js` 本地存在；本 ticket 需要把这两个工具抽到共享位置 — 见 §7.5）

**权益总值计算**（基于 `system_configs.member_level_benefits`）：

```ts
// 读配置
const config = await getMemberBenefits()  // 复用 fengyu-admin/src/actions/settings.ts
const pointRate = await getPointsToYuanRate()  // 见 §3.5

function benefitsValue(levelConfig: MemberLevelBenefit, tplMap: CouponTemplateMap): number {
  const points = (levelConfig.points || 0) * pointRate
  const coupons = (levelConfig.couponTemplateIds || [])
    .reduce((sum, id) => sum + Number(tplMap[id]?.discountValue || 0), 0)
  return points + coupons
}

const currentBenefitsValue = benefitsValue(config.upgrade[currentLevel], tplMap)
const newBenefitsValue = recomputedLevel
  ? benefitsValue(config.upgrade[recomputedLevel], tplMap)
  : 0
const benefitValueDiff = Math.max(0, currentBenefitsValue - newBenefitsValue)

const suggestedOverdraftDeduction = Math.min(
  usedCouponValue + usedPointsValue,  // 顾客实际享用的
  benefitValueDiff,                     // 两档权益差（封顶）
  refundAmount                          // 不能让顾客倒付（封顶）
)
```

### 7.4 admin 退款表单 UI 区块

在 `fengyu-admin/src/components/refunds/RefundForm.tsx`（Ticket 3 组件）上追加一个"会员权益调整"折叠区块（默认展开若 `willDowngrade === true`）：

```
┌─ 会员权益调整 ──────────────────────────┐
│ 顾客当前等级：星钻                       │
│ 退款后应降级至：初钻                     │
│ 保级期状态：已到期 (2026-03-15)         │
│                                         │
│ 升级以来已享受：                         │
│ • 已核销优惠券 1 张，面值 ¥200          │
│ • 已用升级奖励积分 300 分（折 ¥3）       │
│ 小计：¥203                              │
│                                         │
│ 星钻 vs 初钻 权益配置差：¥290           │
│                                         │
│ 本次退款拟扣除超额权益：¥203            │
│ [ ] 应用此扣除                          │
│                                         │
│ 顾客应退金额：¥500 − ¥203 = ¥297        │
└─────────────────────────────────────────┘
```

若 `willDowngrade === false`，区块折叠并显示单行说明：
- 保级期内：`ℹ 顾客处于保级期至 2026-08-12，本次退款不影响等级，不扣除权益`
- 退款后不跌档：`ℹ 本次退款后等级仍为星钻，不扣除权益`

### 7.5 共享工具抽取

当前 `determineMemberLevel` / `memberThreshold` / `LEVEL_RANK` 仅在 `cronTask/index.js` 本地存在。本 ticket 需要抽取到可被 admin 和 cron 共享的位置：

- **方案 A**（推荐）：新建 `db/utils/member-level.ts`，导出 `determineMemberLevel(spend: number, threshold: number): MemberLevel | null`、`LEVEL_RANK`、`isUpgrade`、`isDowngrade`、`getMemberThreshold()`。admin (TS) 直接 import；cronTask (JS) 通过 build 步骤或 CommonJS 导入
- **方案 B**：在 admin 本地复制一份（`fengyu-admin/src/lib/member-level.ts`），接受双份实现的漂移风险
- **决策**：采用方案 A；在 PR-5 完成 JS/TS 双语言导出验证

### 7.6 幂等与审计

`estimateRefundOverdraft` 是**纯读**（无副作用），admin 刷新页面可多次调用。

实际"应用扣除"发生在 Ticket 3 的退款提交流程中。提交时：
1. 同事务内再次调用 `estimateRefundOverdraft` 核对值与 UI 展示一致（防止 admin 点击间隔 10 分钟内等级被 cron 改动）
2. 将 `suggestedOverdraftDeduction` 写入退款单（Ticket 3 新增列，见 §3.5）
3. 实际退款金额 = 原 refundAmount − adjustedOverdraftDeduction
4. 在 `operation_logs` 补一条 `action='refund.overdraftDeducted'` 的审计行

### 7.7 与降级流程的关系

本 ticket §5.3 的 `processDowngrade` **不变** — 退款本身不直接触发 `cronTask`；退款只改动 `sale_order_payments` / `paid_amount`，下一个凌晨 3 点的 cron 正常重算即可。权益回收的动作只发生在**退款时**，与 cron 的降级动作**互相独立**：

- 退款当时：admin 在表单上看到预判 + 扣除权益价值（§7.4）
- 次日凌晨：`processDowngrade` 按保级规则判定等级调整

若两者时序错开（退款在 23:50 → cron 在 03:00）→ 退款扣除的是"当前等级 vs 预判新等级"的权益差；凌晨 cron 真正把等级降下来。这之间几小时的等级仍显示为高等级，属可接受状态。

### 7.8 边界情况

| 情况 | 处理 |
|---|---|
| 本次退款金额 < 建议扣除额 | 扣除上限 = refundAmount（顾客实退 = 0，不会倒付） |
| 升级后发放的券已过期未使用 | 不计入"已享受"；按 §7.2 口径仅算 `'已使用'` |
| 升级奖励积分 100 分，退款前已用 150 分（含自然积分） | `used_points = MIN(100, 150) = 100`（FIFO 近似） |
| 部分退款多笔累计才跌档 | 每笔退款都独立预判；只在首次触发跌档的那笔做扣除；后续退款 `willDowngrade = false`（等级已降），不再扣 |
| `member_level_upgraded_at` 为 NULL（存量会员） | 无法界定"升级以来"；降级照常发生但不扣权益；`detail` 返回空 |
| 顾客当前等级 `null`（从未升级）| `willDowngrade = false`（无级可降），不扣 |

---

## 8 admin 顾客详情页展示

### 7.1 位置

`fengyu-admin/src/app/(main)/customers/[id]/page.tsx` 的会员信息卡片区。

### 7.2 显示

在"会员等级"旁增加两行只读信息：
- **最近升级**：`2026-03-15 14:32`（若 `memberLevelUpgradedAt` 非 null）
- **保级至**：`2026-08-12`（若 `memberLevelLockedUntil` 非 null 且 > NOW()）→ 徽章绿色"保级中"
- 若 `locked_until` 已过：显示"保级已到期" → 灰色

### 7.3 Server Action 改动

`fengyu-admin/src/actions/customers.ts` 的 `getCustomerDetail()` SELECT 时带出新字段。无需新增 action。

### 7.4 权限

跟当前顾客详情页一致（admin 角色可见），无新增权限点。

---

## 9 实施计划（按 PR 拆分）

### PR-1：schema + migration

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | `clientWechatUsers` 加两列 | `db/schema/user.ts:36` 附近 |
| 1.2 | `messages` 加 `idempotency_key` + 部分唯一索引 | `db/schema/message.ts` |
| 1.3 | `pointTransactions` 加 `external_ref` + 部分唯一索引 | `db/schema/points.ts` |
| 1.4 | `sale_orders` 加 `overdraft_deduction` / `overdraft_deduction_detail` | `db/schema/order.ts` |
| 1.5 | `system_configs` seed `points_to_yuan_rate`（migration SQL 末尾 `ON CONFLICT DO NOTHING`）| `db/migrations/00NN_*.sql` |
| 1.6 | `npm run db:generate` + 临时 docker PG 验证 | `db/migrations/00NN_member_level_lock_idempotency_overdraft.sql` |
| 1.7 | 两库 `db:migrate`（5434 + 5433）| 按 `db/CLAUDE.md` §「两库必须同步」 |

### PR-2：cronTask 改造

| # | 任务 | 文件（`fengyu-client/cloudfunctions/cronTask/index.js`） |
|---|------|------|
| 2.1 | 消费额 SQL 修正 | L202-211 |
| 2.2 | `refreshMemberLevels` SELECT 带出 `member_level_locked_until` | L191-193 |
| 2.3 | 三分支拆分（processUpgrade / processDowngrade / processStable）| L216-260 |
| 2.4 | `grantUpgradeBenefits` 幂等化 | L122-181 |
| 2.5 | 返回值加 `heldCount`；日志格式 `_v: 3` | L267 |
| 2.6 | 部署：`tcb fn code update cronTask`（**禁止** `--force`，按 `cloudbase-deploy` skill）| — |

### PR-3：admin 展示 + 单测

| # | 任务 | 文件 |
|---|------|------|
| 3.1 | `getCustomerDetail` SELECT 新字段 | `fengyu-admin/src/actions/customers.ts` |
| 3.2 | 详情页 UI（会员信息卡片）| `fengyu-admin/src/app/(main)/customers/[id]/page.tsx` |
| 3.3 | vitest 单测（`customers.test.ts` 补字段断言）| `fengyu-admin/src/actions/customers.test.ts` |
| 3.4 | Playwright E2E：升级后详情页显示保级日 | `fengyu-admin/tests/e2e/` |

### PR-4：cronTask 集成测试

| # | 任务 | 文件 |
|---|------|------|
| 4.1 | 测试框架：在 `fengyu-client/cloudfunctions/cronTask/__tests__/` 或根 `db/scripts/` 新建集成测试 | — |
| 4.2 | 场景 1：升级 → locked_until=NOW()+150d；消息/积分/券各 1 条 | — |
| 4.3 | 场景 2：保级期内消费下降 → `processDowngrade` 跳过；`operation_logs` 有 `memberLevelHeld` | — |
| 4.4 | 场景 3：保级期过 + 消费额跌档 → 降档；`locked_until` 清空 | — |
| 4.5 | 场景 4：连升两档（初 → 星 → 粉）→ 每档各发一次权益；总券数 = sum(模板) | — |
| 4.6 | 场景 5：cron 重跑 → 消息/积分/券各仍 1 条（幂等验证）| — |
| 4.7 | 场景 6：退款回冲（sale_order_payments 负流水 → paid_amount 减少）→ 下一轮 cron 按新额度重算 | — |
| 4.8 | 场景 7：内部单 10 万 + 销售单 0 → spend = 0 → null 等级不变 | — |

### PR-5：退款降级超额权益回收（与 Ticket 3 协同）

| # | 任务 | 文件 |
|---|------|------|
| 5.1 | 共享工具：`determineMemberLevel` / `LEVEL_RANK` / `isUpgrade` / `getMemberThreshold` 抽到 `db/utils/member-level.ts` | 新建 |
| 5.2 | `fengyu-admin/src/actions/settings.ts` 新增 `getPointsToYuanRate()` | — |
| 5.3 | `fengyu-admin/src/actions/refunds.ts` 新增 `estimateRefundOverdraft` Server Action | 与 Ticket 3 共同维护该文件 |
| 5.4 | `fengyu-client/cloudfunctions/cronTask/index.js` 改为从 `db/utils/member-level.ts` 导入（或维持本地 + 同步更新，验证无漂移）| — |
| 5.5 | 退款提交流程集成（写入 `overdraft_deduction` 两列 + `operation_logs` 审计行）| `fengyu-admin/src/actions/refunds.ts` 的 createRefund |
| 5.6 | `RefundForm.tsx` 新增"会员权益调整"区块 | 与 Ticket 3 共同维护 |
| 5.7 | vitest 单测 `estimateRefundOverdraft.test.ts`：7 个场景覆盖 §7.8 表格 | — |
| 5.8 | Playwright E2E：admin 录入退款 → 看到扣除建议 → 取消勾选 → 实退全额；重放勾选 → 实退减去扣除 | — |

**依赖**：Ticket 3 的 `refunds.ts` / `RefundForm.tsx` 必须先建立基础（PR-5 依赖 Ticket 3 PR-A 或同步推进）。若 Ticket 3 晚于本 ticket 合并，可先 merge PR-1~4，PR-5 在 Ticket 3 就绪后合入。

---

## 10 验收标准

1. ✅ 用户消费 2000（销售单 paid_amount=2000）→ 次日 cron 升初钻 → 发消息/积分/券 → `member_level_locked_until` = NOW()+150d
2. ✅ 一天后又消费 8000 累计达星钻阈值 → 升星钻 → 发星钻权益 → `locked_until` 重置为新的 NOW()+150d
3. ✅ 3 个月后未再消费，滚动 12 月仍保持星钻 → 等级不变、不写日志
4. ✅ 5 个月后滚动 12 月消费跌至初钻档位，`locked_until` 仍 > NOW() → 不降级 + `operation_logs.memberLevelHeld` 1 条
5. ✅ 6 个月后 `locked_until` < NOW() + 消费仍在初钻档 → 降级至初钻 + `locked_until = NULL` + `operation_logs.memberLevelChange` direction=downgrade
6. ✅ 订单 paid_amount=5000 后发生退款 3000（sale_order_payments 负流水 → paid_amount=2000）→ 次日 cron 按 2000 重算
7. ✅ cronTask 当日手动重跑 2 次 → `messages` / `point_transactions` / `user_coupons` 各字段唯一键下新增行数 = 0
8. ✅ 内部单 10 万 + 销售单 0 → spend = 0；等级 null 不变
9. ✅ admin 顾客详情页能看到"最近升级""保级至"两行；保级中显示绿色徽章，已到期显示灰色
10. ✅ `npx tsc --noEmit`（admin）+ `npm run db:generate` 空库 apply 验证 + 两库 `db:migrate` 成功
11. ✅ CloudBase 云函数部署后 `tcb fn invoke cronTask` 一次 dry-run 日志含 `heldCount`
12. ✅ **退款触发降级 + 权益扣除**：顾客 A 升星钻 → 核销 ¥200 券 + 用 300 升级积分 → `locked_until` 设为升级日 + 150d → 150 天后发生 ¥5000 退款 → admin 退款表单展示 `willDowngrade=true` / `suggestedOverdraftDeduction=203` → 勾选生效 → 退款单 `overdraft_deduction=203`、`overdraft_deduction_detail` 写入 JSON 明细、实退 ¥4797、`operation_logs` 有 `refund.overdraftDeducted`
13. ✅ **保级期内退款不扣权益**：同场景但发生在 150 天保级期内 → admin 表单展示"保级期内不扣"说明 → 实退 ¥5000，退款单 `overdraft_deduction=0`
14. ✅ **退款不跌档不扣权益**：顾客 A 升金钻后 ¥500 小额退款 → 计算后仍在金钻档 → admin 表单展示"本次退款不跌档" → 实退 ¥500，`overdraft_deduction=0`
15. ✅ **部分退款首笔扣除后后续不再扣**：¥5000 订单先退 ¥3000（触发跌档扣 ¥203）→ 再退 ¥2000 → 第二笔 `willDowngrade=false`（等级已跌），不再扣权益
16. ✅ **admin 取消扣除**：admin 在退款表单上取消"应用此扣除" → 退款单 `overdraft_deduction=0`，`overdraft_deduction_detail.adminOverride=true` + `suggestedDeduction` 仍保留作审计

---

## 11 风险与决策点

| # | 风险/决策 | 处理方案 |
|---|---|---|
| 10.1 | 存量会员 `locked_until` 为 NULL → 下次 cron 立即按新规则可能降级 | **不**补 one-shot 迁移给存量设 `NOW()+150d`。理由：当前库里的等级可能本就该降，人为续期 150 天会制造"假保级"。运营若强烈要求"平滑过渡"，单独发运营 ticket |
| 10.2 | cronTask 凌晨 3 点失败且无告警 | 本 ticket **不**加告警机制；沿用现状。`errorCount > 0` 时在 console 打印（运维凭日志排查）。告警机制另开 ops ticket |
| 10.3 | 同月连升两档幂等键的边界 | §6.1 已决策：key = `member-upgrade-{userId}-{toLevel}`，不含时间；接受"回升不重发"语义 |
| 10.4 | 消费额 SQL 改动后，当前等级可能整体重新计算（因为口径变严）→ 可能触发大量降级 | PR-2 部署前需在测试库（5434）跑一次 dry-run 统计：查询新 SQL 与旧 SQL 对每个会员客计算的等级差异。**若预估降级 > 总会员客 5%，必须在部署前先给所有当前 `member_level IS NOT NULL AND member_level_locked_until IS NULL` 的会员 UPDATE 设 `locked_until = NOW()+150d` 作为软着陆**（对应 10.1 的例外） |
| 10.5 | 与 Ticket 1 (partial-payment-foundation) 的合并顺序 | 本 ticket 不依赖 Ticket 1 的 schema；但 Ticket 1 合并后 `paid_amount` 精度提升（部分支付 + 退款回冲都正确反映）→ 消费额计算更准。**建议顺序**：Ticket 1 PR-1 schema → 本 ticket PR-1 schema → 本 ticket PR-2/3/4 → Ticket 1 PR-2/3/4 → Ticket 2/3 |
| 10.6 | `memberLevelLockedUntil` 时区 | 全链路 `WITH TIME ZONE`，数据库存 UTC，admin 展示按浏览器时区；与 `createdAt / updatedAt` 一致 |
| 10.7 | admin 权益页的 UI 文案需要提示"150 天保级"给运营 | `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx` 的 upgrade tab 描述文本由"等级升级时一次性发放"补充为"等级升级时一次性发放；升级后获 150 天保级"（文案细节在 PR-3 一并完成）|
| 10.8 | `customer_type = '会员客'` 与 `member_level` 的关系 | 现状：`memberLevel` 只对 `customerType='会员客'` 重算（cronTask L192）。保级逻辑同样只作用于会员客；**流量客/体验客/小美客**不受影响 |
| 10.9 | 退款时等级预判与次日 cron 重算的时差 | 几小时内等级字段仍为旧值但已扣权益。**接受**此漂移——扣除动作与实际降级动作解耦，扣的依据是"将来会降级"，不依赖 `member_level` 已经变化 |
| 10.10 | `estimateRefundOverdraft` 使用的权益配置 vs 升级时实际发放的配置 | 若运营在升级与退款之间改过 `member_level_benefits` 配置，"已享受价值"按当前 snapshot 算可能失真。**决策**：接受此漂移，因为权益已实际发放到用户账户；扣除按当前配置的"权益差"来算仍是合理近似 |
| 10.11 | `point_transactions.type` 自由文本 | §7.3 SQL 用 `type = '扣除'` 假设积分消费的 type 值为"扣除"。实施前需 grep `point_transactions` 的所有 INSERT 语句确认 type 枚举值；若发现多种扣减 type（如"订单抵扣"/"积分兑换"等）则改用 `amount < 0` 作为过滤条件 |
| 10.12 | `db/utils/member-level.ts` 的 JS/TS 双语言共享 | cronTask 是纯 JS（CloudBase 约束），admin 是 TS。**决策**：工具文件用 TS 写，打包时为 cronTask 编译一份 JS 副本（或直接写 JS 加 `.d.ts` 类型声明）。PR-5 第一步就验证这个打包/同步链路 |

---

## 12 不在本 ticket 范围

- birthday / thanksgiving 场景的 cronTask 执行逻辑（admin 已有配置页，但 cron 未消费）—— 另开 ticket
- 等级阈值从 hard-coded 改为 `system_configs` 可配置（目前 1990 来自 `new_member_threshold`，其余 4 档写死）
- 移除 `sale_order_type` 中的"回款单/退款单"枚举值（Ticket 2/3 的范畴）
- 客户端会员中心展示保级倒计时（可选，若运营要求可另开）
- cronTask 失败告警机制 / 重试机制
- 会员等级变动的微信模板消息推送（当前仅写站内 messages 表）
- 会员客/非会员客的 `customer_type` 跃迁规则（本 ticket 只改 `member_level`，不触及 `customer_type`）
- **未使用的升级奖励优惠券**在降级时是否回收/标记过期（本 ticket 仅回收"已享受"部分价值）
- **未使用的升级奖励积分**是否从 `customer_points.balance` 里扣回（本 ticket 用 FIFO 近似只算已消费部分，未消费部分保留）
- `points_to_yuan_rate` 的 admin 可配置化 UI（本 ticket 仅写入默认值 `0.01`，未做 UI）
- 退款金额大到让多档等级连续跌（如金钻直接跌回 null）的分级扣除：本 ticket 按"当前等级 vs 一次性跌到的新等级"两档权益差算；不做逐档累计

---

## 13 相关引用

### 现有代码
- 会员等级重算主循环：`fengyu-client/cloudfunctions/cronTask/index.js:71-268`
  - 等级常量与判定：L73-92
  - 权益配置加载：L98-112
  - 权益发放：L122-181
  - 重算主循环：L187-268
- 会员等级枚举：`db/schema/enums.ts:93`
- 顾客表：`db/schema/user.ts:12-75`（`memberLevel` @ L36）
- 订单表：`db/schema/order.ts`（`saleOrderType` / `paidAmount` / `paidAt`）
- 消息表：`db/schema/message.ts`
- 积分流水表：`db/schema/points.ts`
- 操作日志表：`db/schema/operation-log.ts`
- admin 权益页：
  - 路由：`fengyu-admin/src/app/(main)/member-benefits/page.tsx`
  - 表单：`fengyu-admin/src/app/(main)/member-benefits/_components/member-level-benefits-form.tsx`
  - Server Action：`fengyu-admin/src/actions/settings.ts:14-39,256-346`

### 关联 ticket
- 本 ticket：`notes/tickets/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`
- Ticket 1（订单分期支付 schema 基座）：`notes/tickets/2026-04-24-order-partial-payment-foundation.md`
- Ticket 2（多次回款三端打通）：`notes/tickets/2026-04-24-multi-repayment-three-ends.md`
- **Ticket 3（退款 admin 对齐）**：`notes/tickets/2026-04-24-refund-admin-parity-and-rules.md` — 本 ticket §7 / PR-5 与 Ticket 3 强耦合；`RefundForm.tsx` 与 `actions/refunds.ts` 由 Ticket 3 建立基础，本 ticket 在其之上增加 `estimateRefundOverdraft` 与权益扣除区块
- Ticket 4（admin 列表默认排序）：`notes/tickets/2026-04-24-admin-list-default-ordering.md`

### 规范与记忆
- `.42cog/cog.md` — 会员/等级认知模型
- `.42cog/real.md` — 状态流转与幂等硬规则
- `.42cog/pm/admin.pr.spec.md` — 管理后台产品规范
- `db/CLAUDE.md` — 两库同步 + 迁移流程强制要求
- MEMORY 项目记忆：
  - `project_member_level_rules.md` — 五档阈值与滚动 12 月规则
  - `project_dashboard_time_dimensions.md` — 数据看板时间维度
  - `project_db_dual_env.md` — 5433/5434 双库
  - `project_cloudbase_envvar_risk.md` — `tcb fn deploy --force` 禁用
