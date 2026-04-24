# Ticket: 会员生日权益自动发放（cronTask 消费 birthday_benefits）

> 生成日期：2026-04-24
> 严重级别：P1（运营承诺已写入 admin 配置页，但 cron 不消费 → 配置了也不发）
> 端：fengyu-client/cloudfunctions/cronTask（核心改造）+ fengyu-client/cloudbaserc.json（可选新增触发器）
> 影响面：
>   - `fengyu-client/cloudfunctions/cronTask/index.js`（新增 STEP 3 `grantBirthdayBenefits`）
>   - `fengyu-client/cloudbaserc.json`（可选：新增 0:00 触发器，或复用 3:00）
>   - `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx`（文案微调，明确发放时间 + 闰年规则 + 去重规则）
> 前置依赖：**强依赖** `2026-04-24-member-level-150d-lock-and-upgrade-benefits.md` PR-1（必须先落地 `messages.idempotency_key` 和 `point_transactions.external_ref` 两个字段 + 部分唯一索引；本 ticket 完全复用相同机制，不再重复迁移）
> 并行：与 `2026-04-24-multi-repayment-three-ends.md` / `2026-04-24-refund-admin-parity-and-rules.md` / `2026-04-24-order-partial-payment-foundation.md` 无冲突
>
> **一句话目标**：让 cronTask 每日扫描 `client_wechat_users.birthday` 命中今日的会员，按 `system_configs.birthday_benefits[memberLevel]` 发消息、送积分、发优惠券；以 `birthday-{YYYY}-{userId}` 作幂等键实现"一年只发一次 + cron 重跑不重发"。

---

## 0 一句话背景

需求原文：
> admin 的生日礼，如果会员有生日信息，需要在会员的生日所在当天 0 点发送对应的权益。

调研发现仓库现状：**admin 配置端已完整、cron 执行端完全缺失**。

| 模块 | 现状 | 关键位置 |
|---|---|---|
| admin 生日权益配置 Tab | ✅ 完整 | `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:87-104` |
| 配置 Server Action（读/写 `system_configs.birthday_benefits`）| ✅ 完整 | `fengyu-admin/src/actions/settings.ts:72,262,268-274,318` |
| 五档 × 三件套表单组件 | ✅ 复用 | `_components/member-level-benefits-form.tsx`（upgrade/birthday/thanksgiving 共用）|
| `client_wechat_users.birthday` 字段 | ✅ 存在 | `db/schema/user.ts:51`（date 类型，含年月日）|
| cronTask 触发器 | ✅ 配置 | `fengyu-client/cloudbaserc.json:45`（`0 0 3 * * * *`，每日 3:00 AM）|
| cronTask STEP 3：birthday 发放 | ❌ **不存在** | `cronTask/index.js` 目前仅 STEP 1（customer_status）+ STEP 2（member_level + upgrade 权益）|
| `messages.idempotency_key` / `point_transactions.external_ref` | ❌ 待建 | 由 150d-lock ticket PR-1 落地（本 ticket 依赖）|

**这不是一个改造，而是一个新增功能**：admin 已提供配置、前置 schema 工具（幂等键）由姊妹 ticket 提供、本 ticket 只在 cronTask 里增加一段消费逻辑。

---

## 1 问题定位

### 1.1 缺口一：STEP 3 缺失 → 配置了生日权益的运营视角"配了但没发"

admin 权益页已面向运营开放 birthday Tab（五档 × 消息 + 积分 + 优惠券），数据写入 `system_configs.birthday_benefits`。**cronTask 目前完全不读这一 key**，因此配置无效。运营的"生日权益"功能现状为零。

### 1.2 缺口二：发放时间语义需明确

用户原文："会员的生日所在当天 0 点发送"。

当前 cron：`0 0 3 * * * *` — 每日凌晨 3:00 AM。  
严格语义下，"当天 0 点"意味着 `CURRENT_DATE` 切换的瞬间（00:00），需要再加一条 `0 0 0 * * * *` 触发器。

两种方案对比：

| 方案 | 延迟 | 成本 | 风险 |
|---|---|---|---|
| A. 复用 3:00 AM 触发器 | 生日当天 3:00 送达（iOS "今日"视角仍在当天）| 0（代码仅新增一个 step）| 运营若坚持 0:00 则语义不符 |
| B. 新增 0:00 专用触发器 | 生日当天 00:00~00:01 送达 | cloudbaserc.json +一条触发器配置 + 云函数需支持 `event.step` 分支（或分函数）| 两触发器都会全量扫 `client_wechat_users`，I/O 翻倍；且可能与 3:00 的 STEP 2 有时序耦合（升级后当日生日命中怎么办）|
| C. 复用 3:00 AM + admin 配置页文案明确"次日凌晨 3 点之后发放" | 生日当天 3:00 送达 | 仅文案调整 | 运营仍期待真正 0:00 |

**本 ticket 默认方案 A**（复用 3:00），理由见 §2 决策 #1。

### 1.3 缺口三：生日比对的精度与闰年

`client_wechat_users.birthday` 是 `date` 类型（含年月日）。比对"今天是否为该顾客生日"的正确 SQL：

```sql
EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
AND EXTRACT(DAY   FROM birthday) = EXTRACT(DAY   FROM CURRENT_DATE)
```

**闰年边缘**：顾客生日 `2000-02-29`，非闰年 cron 在 2/28 和 3/1 都不会命中 → 永不发放。三种可选：

| 选项 | 语义 | 实现 |
|---|---|---|
| **B1. 跳过（当年无 2/29 → 不发）** | 严格（本 ticket 选择） | 默认 SQL 行为，无额外分支 |
| B2. 2/28 发放 | 宽松 | 增加 `OR` 分支 |
| B3. 3/1 发放 | 运营习惯更近 | 增加 `OR` 分支 |

见 §2 决策 #3，本 ticket 采用 **B1**：非闰年的 2/29 出生者当年跳过，次年闰年正常发放。理由：语义最严格、SQL 最简、不引入闰年判断逻辑；影响面极小（2/29 出生概率 1/1461 ≈ 0.07%）。若运营反馈需要补发，再单开扩展 ticket。

### 1.4 缺口四：幂等键设计

upgrade 场景幂等键为 `member-upgrade-{userId}-{toLevel}`（一次性，同等级终身一次）。  
birthday 是**年度重复事件**，必须在键里包含年份：

```
消息：birthday-msg-{YYYY}-{userId}         e.g. birthday-msg-2026-FYGK-20250120-0001
积分：birthday-pts-{YYYY}-{userId}         e.g. birthday-pts-2026-FYGK-20250120-0001
优惠券：bday-{YYYY}-{userId}-{templateId}  e.g. bday-2026-FYGK-20250120-0001-tpl-xxxxx
```

**为什么 prefix 区分** (`birthday-msg-` / `birthday-pts-` / `bday-`)：复用 `messages.idempotency_key` / `point_transactions.external_ref` / `user_coupons.coupon_id` 三张表的**统一部分唯一索引**，不同前缀避免和 upgrade/thanksgiving 等场景混淆。

**1/1 跨年**：cron 运行前一刻的"今天"定义为数据库 `CURRENT_DATE`；键里的 `YYYY` 同样取 `EXTRACT(YEAR FROM CURRENT_DATE)`。两者一致。

### 1.5 缺口五：scope 与 member_level=NULL 的处理

admin 表单是五档 × 三件套（五档 = 初钻/星钻/粉钻/金钻/黑钻），**无"null 等级"配置位**。因此：

- 顾客 `birthday` 为 NULL → 跳过（admin 文案已说明）
- 顾客 `member_level` 为 NULL（未达初钻阈值）→ 无配置可查 → 跳过
- 顾客 `customer_type != '会员客'`（流量/体验/小美客）→ 一般情况 `member_level` 也为 NULL → 跳过

换言之：**本 ticket 只给"有生日 + 已有等级"的顾客发放**。运营若要给流量客发生日礼，需另建 UI 支持 null 等级档，不在本 ticket。

---

## 2 用户确认的规则（决策基准线）

| # | 规则 | 决策 | 理由 |
|---|---|---|---|
| 1 | 发放时间 | **方案 A：复用 3:00 AM 触发器**；admin 文案改为"生日当天凌晨发放"。若运营坚持 0:00，单开 ops ticket 加第二个触发器 | 3 小时内的延迟对"生日祝福"不构成业务差异；避免触发器重复、降低云函数调用成本；简化时序（避免 STEP 2 升级与 STEP 3 生日并发处理同一用户的冲突） |
| 2 | 幂等年份 | 键含 `YYYY`，取 `EXTRACT(YEAR FROM CURRENT_DATE)` | 年度重复事件的必要性；跨年 cron 重跑自然幂等 |
| 3 | 闰年 2/29 | **B1 方案：非闰年跳过**（当年无 2/29 → 不发放，等次年闰年）| 语义严格、SQL 最简、影响样本极小（0.07%）；运营若反馈再扩展 |
| 4 | 发放范围 | 根据 `clientWechatUsers.memberLevel` 发放对应档位权益：`birthday IS NOT NULL AND member_level IS NOT NULL` 的顾客，按其当前 `member_level` 读取配置 | admin 配置只有五档，无 null 档；严格按等级发放（读取 `benefitsConfig[memberLevel]`）|
| 5 | 缺生日补发 | **不补发**：错过当日的生日（例如顾客当日之后才补录生日）不回溯 | "生日快乐"跨日送达尴尬；补发机制复杂，另开 ops ticket |
| 6 | 当天同时命中升级 + 生日 | STEP 2 先跑（升级 → 发 upgrade 三件套），STEP 3 后跑（再发 birthday 三件套）| 两者幂等键不同，各自一份；运营角度认可（顾客当日既升级又生日 → 两份惊喜） |
| 7 | 优惠券有效期 | 沿用 `coupon_templates.validity_mode` + `valid_days` / `valid_to`（同 upgrade 逻辑），不引入"生日券定制 30 天"之类特殊规则 | 保持 scenario 间一致性；运营通过模板自身有效期控制 |
| 8 | 配置缺失容错 | `system_configs.birthday_benefits` 不存在 / 解析失败 → console.warn 后跳过 STEP 3；不影响 STEP 1/2 | 运营未配置时"不做"比"报错中断"好 |
| 9 | 多店顾客 / 分店权益差异 | 不做。一个等级 → 一份权益；不按门店分 | admin UI 不支持，无差异配置 |

---

## 3 Schema 变更

**本 ticket 不做 schema 变更**。

复用 `2026-04-24-member-level-150d-lock-and-upgrade-benefits.md` PR-1 落地的两列：

| 表 | 列 | 用途 |
|---|---|---|
| `messages` | `idempotency_key TEXT` + `uq_messages_idempotency_key` 部分唯一索引 | 生日消息幂等（`birthday-msg-{YYYY}-{userId}`）|
| `point_transactions` | `external_ref TEXT` + `uq_point_txns_external_ref` 部分唯一索引 | 生日积分幂等（`birthday-pts-{YYYY}-{userId}`）|

`user_coupons.coupon_id` 本身即 PK，继续作为幂等键。

**合并顺序强制约束**：  
150d-lock ticket **PR-1 merge + 两库 db:migrate 完成** → 才能 merge 本 ticket 任何 PR。提 PR 时在描述里显式写 `blocked-by: #<150d-lock PR-1>`。

---

## 4 cronTask 改造

### 4.1 新增"今日生日会员"扫描 SQL

加到 `refreshMemberLevels` 之后，作为 `refreshBirthdayBenefits(client)` 函数。

采用 **B1 闰年策略**：月日完全匹配即命中，非闰年 2/29 自然跳过。SQL 无闰年分支：

```sql
SELECT user_id, member_level
FROM client_wechat_users
WHERE birthday IS NOT NULL
  AND member_level IS NOT NULL
  AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
  AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)
```

效果：
- 非闰年：2/28 命中 2/28 生日者；3/1 命中 3/1 生日者；2/29 生日者全年不命中（跳过）
- 闰年：2/29 命中 2/29 生日者正常发放

无需 JS 端闰年判断，无需 `CASE` / `generate_series` 展开。

### 4.2 `loadBirthdayBenefitsConfig(client)`

复用 `loadBenefitsConfig` 的模板，换 key 即可：

```js
async function loadBirthdayBenefitsConfig(client) {
  const result = await client.query(
    "SELECT value FROM system_configs WHERE key = 'birthday_benefits'"
  )
  if (!result.rows[0]?.value) {
    console.warn('[cronTask] birthday_benefits 配置不存在，跳过 STEP 3')
    return null
  }
  try {
    return JSON.parse(result.rows[0].value)
  } catch (err) {
    console.error('[cronTask] birthday_benefits 解析失败:', err.message)
    return null
  }
}
```

### 4.3 `grantBirthdayBenefits(client, userId, year, level, config)`

与 `grantUpgradeBenefits` 的区别仅在幂等键前缀与 `point_transactions.type`：

```js
async function grantBirthdayBenefits(client, userId, year, level, config) {
  // 1) 消息
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, config.messageTitle, config.messageBody || null, `birthday-msg-${year}-${userId}`]
    )
  }

  // 2) 积分
  if (config.points && config.points > 0) {
    const ref = `birthday-pts-${year}-${userId}`
    const inserted = await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '生日积分', $2, NULL, $3, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, config.points, ref]
    )
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

  // 3) 优惠券
  if (Array.isArray(config.couponTemplateIds) && config.couponTemplateIds.length > 0) {
    for (const templateId of config.couponTemplateIds) {
      const tplResult = await client.query(
        'SELECT validity_mode, valid_days, valid_to, is_active FROM coupon_templates WHERE template_id = $1',
        [templateId]
      )
      const tpl = tplResult.rows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cronTask/birthday] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }
      let expireAt
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(Date.now() + 365 * 86400000)
      }
      const couponId = `bday-${year}-${userId}-${templateId}`
      await client.query(
        `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, created_at)
         VALUES ($1, $2, $3, '未使用', $4, NOW())
         ON CONFLICT (coupon_id) DO NOTHING`,
        [couponId, templateId, userId, expireAt]
      )
    }
  }
}
```

### 4.4 主流程 `refreshBirthdayBenefits(client)`

```js
async function refreshBirthdayBenefits(client) {
  const benefitsConfig = await loadBirthdayBenefitsConfig(client)
  if (!benefitsConfig) return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }

  // 使用 DB 当前年份以避免 JS / DB 时区偏差导致的键年份漂移
  const yearRow = (await client.query('SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS year')).rows[0]
  const year = yearRow.year

  const rows = (await client.query(
    `SELECT user_id, member_level
     FROM client_wechat_users
     WHERE birthday IS NOT NULL
       AND member_level IS NOT NULL
       AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)`
  )).rows

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig?.[row.member_level]
    if (!cfg) { skippedNoConfig++; continue }

    await client.query('BEGIN')
    try {
      await grantBirthdayBenefits(client, row.user_id, year, row.member_level, cfg)

      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('customer.birthdayBenefits', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
        [row.user_id, JSON.stringify({
          _v: 1, _t: 'birthday',
          year, memberLevel: row.member_level,
          config: {
            points: cfg.points || 0,
            couponTemplateCount: (cfg.couponTemplateIds || []).length,
            messageTitle: cfg.messageTitle || null,
          },
        })]
      )
      await client.query('COMMIT')
      sentCount++
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`[cronTask/birthday] failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }
  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}
```

### 4.5 入口 `main` 增加 STEP 3

在 `cronTask/index.js:296` 之后（STEP 2 日志之后）：

```js
const bdayResult = await refreshBirthdayBenefits(client)
console.log(
  `[cronTask] STEP 3: birthday total=${bdayResult.total} ` +
  `sent=${bdayResult.sentCount} skipped=${bdayResult.skippedNoConfig} error=${bdayResult.errorCount}`
)

// 返回值新增 birthday 字段
return {
  code: 0,
  message: 'success',
  data: {
    updatedCount, resetCount, stats,
    memberLevel: levelResult,
    birthday: bdayResult,  // ← 新增
  },
}
```

---

## 5 admin 文案微调

**位置**：`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:92-95`

当前文案：
```
顾客生日当天，根据其当前会员等级自动发放对应的消息 + 积分 + 优惠券。
没有生日字段的顾客不发放；一年仅发放一次。
```

**改为**：
```
生日当天凌晨 3:00 由每日定时任务按顾客当前会员等级发放。一年仅发送一次，cron 重跑不会重复。
没有生日的顾客、没有会员等级的顾客（流量/体验/小美客）不发放。
2/29 出生的顾客仅在闰年当日发放，非闰年跳过。
```

此改动无逻辑变更、不影响 E2E、不影响 schema；可以和 PR-2 合并或独立一个小 PR。

---

## 6 实施计划（按 PR 拆分）

### PR-1：cronTask STEP 3 实现

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | 新增 `loadBirthdayBenefitsConfig` | `fengyu-client/cloudfunctions/cronTask/index.js`（`loadBenefitsConfig` 下方）|
| 1.2 | 新增 `grantBirthdayBenefits` | 同文件（`grantUpgradeBenefits` 下方）|
| 1.3 | 新增 `refreshBirthdayBenefits` | 同文件（`refreshMemberLevels` 下方）|
| 1.4 | `main` 追加 STEP 3 调用 + 日志 + 返回值字段 | 同文件 L295-310 附近 |
| 1.5 | 部署（按 cloudbase-deploy skill，**禁止** `--force`）：`tcb fn code update cronTask` | — |
| 1.6 | 部署后 `tcb fn invoke cronTask`（无触发器参数即 dry-run）一次 → 日志含 `STEP 3: birthday` 即视为部署验证通过 | — |

**前置**：150d-lock ticket PR-1 必须已 merge 且两库已跑 migrate。

### PR-2：cronTask 单测 + 集成测试

| # | 任务 | 文件 |
|---|------|------|
| 2.1 | vitest 扩展 | `fengyu-client/cloudfunctions/cronTask/__tests__/` |
| 2.2 | 场景 A：顾客生日=今日 + 有等级 → 消息 1 条 / 积分 1 条 / 券 N 条；`customer_points.balance` 正确累加；`operation_logs` 1 条 `birthdayBenefits` | — |
| 2.3 | 场景 B：顾客生日=今日 + 等级=NULL → 不发放；无日志 | — |
| 2.4 | 场景 C：顾客生日=NULL → 不在扫描集 | — |
| 2.5 | 场景 D：cron 重跑当日 2 次 → 消息/积分/券各仍 1 条（幂等键生效）| — |
| 2.6 | 场景 E：mock DB `CURRENT_DATE` 为 2028-02-29（闰年）→ 2/29 出生者命中；mock 为 2027-02-28 → 2/29 出生者不命中；mock 为 2027-03-01 → 2/29 出生者不命中（B1 跳过策略验证）| — |
| 2.7 | 场景 F：`birthday_benefits` 未配置 → `skippedNoConfig` 等于 `total`；无消息/积分/券 | — |
| 2.8 | 场景 G：同一用户同日同时命中 upgrade + birthday → STEP 2 发 upgrade 三件套，STEP 3 发 birthday 三件套，彼此独立；`messages` 2 条、`point_transactions` 2 条 | — |
| 2.9 | 场景 H：跨年 1/1 生日 → 键 `birthday-*-{YYYY=当年}-*`；次年 1/1 重跑 → 键 `{YYYY+1}` 是新键，正常发放 | — |

### PR-3：admin 文案微调

| # | 任务 | 文件 |
|---|------|------|
| 3.1 | 修正生日 Tab 描述文案 | `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:92-95` |
| 3.2 | 现有 Playwright E2E 覆盖 Tab 切换即可；无新增断言 | — |

---

## 7 验收标准

1. ✅ 顾客 A（黑钻、生日=2026-04-24）当日 cron 执行 → `messages`/`point_transactions`/`user_coupons` 各含 1 条（或 N 条，取决于优惠券模板数），`idempotency_key='birthday-msg-2026-{A.userId}'`、`external_ref='birthday-pts-2026-{A.userId}'`、`coupon_id='bday-2026-{A.userId}-{templateId}'`
2. ✅ 同日 cron 重跑 2 次 → 三张表行数均保持不变（幂等）
3. ✅ 顾客 B（黑钻、生日=2028-02-29）：2028 为闰年时 2/29 当日命中；2027 非闰年时 2/28 / 3/1 均不命中（B1 跳过）
4. ✅ 顾客 C（member_level=NULL、生日=今日）→ 不产生任何消息/积分/券；`operation_logs` 无 `birthdayBenefits` 记录
5. ✅ 顾客 D（生日=NULL）→ 不在 SELECT 集；扫描日志 `total` 不计入
6. ✅ `system_configs.birthday_benefits` 被 admin 删除/置 NULL → cronTask 日志 `STEP 3: birthday total=0 sent=0 skipped=0 error=0` 且 console.warn 一条；其余步骤不受影响
7. ✅ 顾客 E 同日既升级到星钻（升级条件已满足）又是生日 → `messages` 有 2 条（1 条 upgrade + 1 条 birthday）、`point_transactions` 有 2 条（type=`'等级升级奖励'` + `'生日积分'`）、`operation_logs` 有 2 条（`memberLevelChange` + `birthdayBenefits`）
8. ✅ admin 生日 Tab 文案更新到 "凌晨 3:00 按会员等级发放 + 非闰年 2/29 跳过" 说明
9. ✅ `tcb fn invoke cronTask` dry-run 日志包含 `STEP 3: birthday` 且结构符合预期
10. ✅ vitest 8 个新增场景全部 green

---

## 8 风险与决策点

| # | 风险/决策 | 处理方案 |
|---|---|---|
| 8.1 | 用户原文是"0 点"，方案 A 采用 3:00 AM | §2 决策 #1 已明确理由；文案同步调整；若运营不接受，PR-3 之前可以把 cloudbaserc.json 加一条 `0 0 0 * * * *` 并在 cronTask 里按 `event.step` 分支。但两个触发器都会走全量扫表，I/O 翻倍 |
| 8.2 | STEP 3 首跑会把"今日所有会员生日者"全发；若 STEP 3 之前某顾客恰好升级导致等级变化 | §2 决策 #6 明确：STEP 2 先跑（升级写新 `member_level`），STEP 3 再跑（读已写入的新等级），因此"升级后立即按新等级发生日礼"的语义自然成立 |
| 8.3 | 顾客生日在系统上线日之前（如 1990-06-18），2026-06-18 会发；但 cron 在上线当日的前一段生日都错过了 | §2 决策 #5：不补发。可通过 admin 手动运营（如补券）处理 |
| 8.4 | 顾客多个 openid / 合并账户时，userId 与 birthday 的归属关系 | 本 ticket 不处理合并；现状 `userId` 是 PK，birthday 是其字段，一对一关系；若未来做账户合并，迁移脚本需把 `idempotency_key` 中的旧 userId 也迁移，避免新账户当年重复发放 |
| 8.5 | 大会员基数（> 10 万）下 3:00 扫描性能 | SELECT 的 WHERE 用 `EXTRACT(MONTH/DAY)`，无法命中 `birthday` 的 btree 索引。若性能不足，可加部分索引或生成列 `birthday_md`；本 ticket **不做**，首轮观察实际执行时间，超过 30s 再开 ops ticket |
| 8.6 | 时区漂移 | cronTask 在 CloudBase 东八区触发 3:00 AM（= UTC 19:00 前一日）。若用 `new Date().getFullYear()` 取年份，函数运行时区若非东八区（CloudBase Node.js 默认 UTC）会跨年漂移。**决策**：年份直接取 DB `EXTRACT(YEAR FROM CURRENT_DATE)`（§4.4 已采用），与 SELECT 里的 `CURRENT_DATE` 同源，完全消除时区问题 |
| 8.7 | 优惠券模板被删除/停用 | 沿用 `grantUpgradeBenefits` 的 `is_active` 检查，console.warn 后跳过；不影响其他模板/顾客的发放 |
| 8.8 | 同日 2 次升级（由 STEP 2 内部事务保证）+ 生日 → STEP 3 的 SELECT 命中的 `member_level` 是 STEP 2 后的最终值；若 STEP 3 执行中 STEP 2 还未 COMMIT → 读到旧值 | `main` 函数内 STEP 2 完整运行（含所有子事务 COMMIT）后才进入 STEP 3，顺序串行；不存在跨 step 并发读 |
| 8.9 | `paid_at` 为 null 或未来时间的边缘订单 | 本 ticket 不触及订单；无关 |
| 8.10 | 文案决策（积分发放类型名 `'生日积分'`）| 与 upgrade 的 `'等级升级奖励'`、`customer_points` 的类型字段保持短语风格；未来如果 admin 有"积分流水"展示页，可单独映射 |

---

## 9 不在本 ticket 范围

- `thanksgiving_benefits`（每月 20 号回馈）场景的 cronTask 实现 —— 另开 ticket（与本 ticket 90% 同构，差异仅在扫描 SQL：`EXTRACT(DAY FROM CURRENT_DATE) = 20 AND 当日存在服务单`、幂等键 `thx-{YYYY-MM}-{userId}`）
- null 等级生日礼（面向流量/体验客）—— admin UI 需扩展第六档配置，本 ticket 不做
- 生日"提前 N 天"或"当月"类预热发放 —— 业务需求若出现另开
- 生日当天触发模板消息推送（微信订阅消息）—— 当前 `messages` 仅写站内，推送链路独立
- 生日礼的门店差异化（不同门店配不同权益）—— admin UI 不支持，运营未提
- cron 失败告警 / 失败重试机制 —— 沿用姊妹 ticket 的决策，不在本 ticket
- 顾客侧 UI 展示"下次生日还有 X 天 / 已领生日礼" —— 纯展示需求，另开
- 员工生日礼 —— `staff_wechat_users.birthday` 存在但无运营诉求，不在本 ticket
- 生日礼的撤回 / 冲正能力 —— 若运营误配置发错，目前需手动从 `messages` / `point_transactions` / `user_coupons` 删除并扣减 `customer_points.balance`；另开 ops ticket
- 生日发放的可观测性（admin 页面看谁今天收到了）—— `operation_logs` 已有 `birthdayBenefits` 记录，运维 SQL 可查；admin UI 展示另开

---

## 10 相关引用

### 现有代码
- cronTask 主入口：`fengyu-client/cloudfunctions/cronTask/index.js:272-320`
- cronTask STEP 2：`fengyu-client/cloudfunctions/cronTask/index.js:71-268`
- cronTask 触发器：`fengyu-client/cloudbaserc.json:41-47`
- admin 权益 Tab UI：`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:87-104`
- admin 权益 Server Action：`fengyu-admin/src/actions/settings.ts:14-39,70-74,256-346`
- birthday 字段定义：`db/schema/user.ts:51`
- 会员等级枚举：`db/schema/enums.ts:93`
- 消息表：`db/schema/message.ts`
- 积分流水表：`db/schema/points.ts`
- 优惠券模板/用户券：`db/schema/coupon.ts`
- 操作日志表：`db/schema/operation-log.ts`
- 系统配置表：`db/schema/system-config.ts`

### 关联 ticket
- 本 ticket：`notes/tickets/2026-04-24-member-birthday-benefits.md`
- **前置（必须先 merge）**：`notes/tickets/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md`（提供 `messages.idempotency_key` + `point_transactions.external_ref` schema）
- 姊妹（未来）：`notes/tickets/YYYY-MM-DD-member-thanksgiving-benefits.md`（感恩日权益，结构同构）
- 无关并行：`2026-04-24-multi-repayment-three-ends.md` / `2026-04-24-refund-admin-parity-and-rules.md` / `2026-04-24-order-partial-payment-foundation.md`

### 规范与记忆
- `.42cog/cog.md` — 会员/等级/权益认知模型
- `.42cog/real.md` — 幂等硬规则
- `.42cog/pm/admin.pr.spec.md` — 管理后台产品规范
- MEMORY 项目记忆：
  - `project_member_level_rules.md` — 五档等级
  - `project_cloudbase_envvar_risk.md` — `tcb fn deploy --force` 禁用
  - `project_db_dual_env.md` — 5433/5434 双库
