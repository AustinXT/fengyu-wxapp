# Ticket: 会员等级 150 天保级规则 + 升级权益发放可靠性完善

> 生成日期：2026-04-24
> 严重级别：P1（会员运营核心规则缺失 + 权益发放幂等性缺口）
> 端：db（schema + migration）+ fengyu-client/cloudfunctions/cronTask（核心改造）+ fengyu-admin（顾客详情页只读展示）
> 影响面：
>   - `db/schema/user.ts`（+2 列）
>   - `db/schema/message.ts`（+1 列 + 部分索引）
>   - `db/schema/points.ts`（+1 列 + 部分索引）
>   - `fengyu-client/cloudfunctions/cronTask/index.js`（`refreshMemberLevels` 改造 + `grantUpgradeBenefits` 幂等化 + 消费额 SQL 修正）
>   - `fengyu-admin/src/app/(main)/customers/[id]/page.tsx`（只读展示保级日）
> 前置：可独立合并；与 `2026-04-24-order-partial-payment-foundation.md`（Ticket 1）合并后消费额精度自然提升
> 并行：与 `2026-04-24-multi-repayment-three-ends.md`（多次回款）/ `2026-04-24-refund-admin-parity-and-rules.md`（退款）无冲突
>
> **一句话目标**：为 `client_wechat_users` 引入 `member_level_locked_until` 与 `member_level_upgraded_at` 两列，实现"升级后 150 天不降级"规则；把 `grantUpgradeBenefits()` 的消息和积分发放加上幂等键，保证 cron 重跑/失败重试不会重复发送；把滚动 12 个月消费额 SQL 从 `SUM(total_amount) WHERE status IN (…) AND sale_order_type != '内部单'` 改为 `SUM(paid_amount) WHERE sale_order_type = '销售单' AND paid_amount > 0`，使退款（未来走 payments 负流水）能自然冲抵消费额。

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

**真正缺口只有四个**：150 天保级未实现、消费额口径不准、消息/积分无幂等键、缺乏可观测（admin 看不到某顾客的保级截止日）。

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

### 3.4 迁移

按 `db/CLAUDE.md` 强制流程执行：
1. 改 `schema/*.ts`
2. `npm run db:generate` 产出 `migrations/00NN_member_level_lock_idempotency.sql`
3. 临时 docker PG（端口 54399）空库 apply 验证
4. 提交 PR 包含 schema + migration + `meta/` 三者
5. merge 后**对两库都跑** `db:migrate`（5434 + 5433）

**关键**：新增列均为 NULL 可空，无数据回填；但需考虑 §9.1 的历史会员处理。

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

## 7 admin 顾客详情页展示

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

## 8 实施计划（按 PR 拆分）

### PR-1：schema + migration

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | `clientWechatUsers` 加两列 | `db/schema/user.ts:36` 附近 |
| 1.2 | `messages` 加 `idempotency_key` + 部分唯一索引 | `db/schema/message.ts` |
| 1.3 | `pointTransactions` 加 `external_ref` + 部分唯一索引 | `db/schema/points.ts` |
| 1.4 | `npm run db:generate` + 临时 docker PG 验证 | `db/migrations/00NN_member_level_lock_idempotency.sql` |
| 1.5 | 两库 `db:migrate`（5434 + 5433）| 按 `db/CLAUDE.md` §「两库必须同步」 |

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

---

## 9 验收标准

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

---

## 10 风险与决策点

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

---

## 11 不在本 ticket 范围

- birthday / thanksgiving 场景的 cronTask 执行逻辑（admin 已有配置页，但 cron 未消费）—— 另开 ticket
- 等级阈值从 hard-coded 改为 `system_configs` 可配置（目前 1990 来自 `new_member_threshold`，其余 4 档写死）
- 移除 `sale_order_type` 中的"回款单/退款单"枚举值（Ticket 2/3 的范畴）
- 客户端会员中心展示保级倒计时（可选，若运营要求可另开）
- cronTask 失败告警机制 / 重试机制
- 会员等级变动的微信模板消息推送（当前仅写站内 messages 表）
- 会员客/非会员客的 `customer_type` 跃迁规则（本 ticket 只改 `member_level`，不触及 `customer_type`）

---

## 12 相关引用

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
- Ticket 3（退款 admin 对齐）：`notes/tickets/2026-04-24-refund-admin-parity-and-rules.md`
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
