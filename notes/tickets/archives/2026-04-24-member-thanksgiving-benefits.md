# Ticket: 会员感恩日权益自动发放（cronTask 消费 thanksgiving_benefits）

> 生成日期：2026-04-24
> 严重级别：P1（运营承诺已写入 admin 配置页，但 cron 不消费 → 配置了也不发）
> 端：fengyu-client/cloudfunctions/cronTask（核心改造）+ fengyu-client/cloudbaserc.json（复用现有触发器）
> 影响面：
>   - `fengyu-client/cloudfunctions/cronTask/index.js`（新增 STEP 4 `grantThanksgivingBenefits`；**无需**新触发器）
>   - admin 侧**无改动**（`member-benefits-page.tsx:106-124` 文案已完整、准确）
> 前置依赖：**强依赖** `2026-04-24-member-level-150d-lock-and-upgrade-benefits.md` PR-1（必须先落地 `messages.idempotency_key` 和 `point_transactions.external_ref` 两个字段 + 部分唯一索引；本 ticket 与生日 ticket 共用该 schema）
> 并行：与 `2026-04-24-member-birthday-benefits.md` **90% 同构**，可作为姊妹 PR 并行推进；main 函数内 STEP 3（生日）与 STEP 4（感恩日）的插入点需协调（见 §4.5）
>
> **一句话目标**：让 cronTask 每月仅在 20 号执行感恩日扫描——查询 `service_orders.service_date = CURRENT_DATE AND status IN ('已完成','服务中')` 且顾客 `member_level IS NOT NULL`，按 `system_configs.thanksgiving_benefits[memberLevel]` 发消息 / 送积分 / 发**固定 10 天有效期**的优惠券；以 `thx-*-{YYYY-MM}-{userId}` 作幂等键实现"一月一次 + cron 重跑不重发"。

---

## 0 一句话背景

需求原文：
> admin 会员权益，感恩日需要在每月 20 号统计有护理单的会员，按照会员等级发放对应的权益。

调研发现仓库现状：**admin 配置端与 UI 文案已完整、cron 执行端完全缺失**。

| 模块 | 现状 | 关键位置 |
|---|---|---|
| admin 感恩日配置 Tab（含业务规则文案）| ✅ 完整 | `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:106-124` |
| 配置 Server Action（读/写 `system_configs.thanksgiving_benefits`）| ✅ 完整 | `fengyu-admin/src/actions/settings.ts:256-346`（`getMemberBenefits` / `saveMemberBenefits` 的第三个 key）|
| 五档 × 三件套表单组件 | ✅ 复用 | `_components/member-level-benefits-form.tsx`（与 upgrade / birthday 共用）|
| `service_orders` 表（含 `service_date` / `status` / `client_user_id`）| ✅ 存在 | `db/schema/service.ts:15-47` |
| cronTask 触发器 | ✅ 配置 | `fengyu-client/cloudbaserc.json:45`（`0 0 3 * * * *`，每日 3:00 AM；本 ticket **复用**）|
| cronTask STEP 4：thanksgiving 发放 | ❌ **不存在** | `cronTask/index.js` 目前仅 STEP 1（customer_status）+ STEP 2（member_level + upgrade 权益）|
| `messages.idempotency_key` / `point_transactions.external_ref` | ❌ 待建 | 由 150d-lock ticket PR-1 落地（本 ticket 与生日 ticket 共用，不重复迁移）|

**这不是一个改造，而是一个新增功能**：admin UI 与文案 100% 就绪（§1.3 原文引用）、schema 依赖由姊妹 ticket 提供、本 ticket 只在 cronTask 里增加一段消费逻辑。

---

## 1 问题定位

### 1.1 缺口一：STEP 4 缺失 → 配置了感恩日权益的运营视角"配了但没发"

admin 权益页已面向运营开放 thanksgiving Tab（五档 × 消息 + 积分 + 优惠券），数据写入 `system_configs.thanksgiving_benefits`。**cronTask 目前完全不读这一 key**，因此配置无效。运营的"感恩回馈"功能现状为零。

### 1.2 缺口二：扫描 SQL 的两个过滤维度

"每月 20 号**下护理单**的顾客"对应两个必要条件的合取：

| 维度 | 条件 | SQL |
|---|---|---|
| 时间（20 号 + 今日）| cron 每日跑，但只有 20 号才命中；service_date 与 CURRENT_DATE 严格相等 | `EXTRACT(DAY FROM CURRENT_DATE) = 20 AND service_date = CURRENT_DATE` |
| 服务单状态 | 已实际产生服务价值（按 admin UI 原文：已完成或进行中）| `status IN ('已完成', '服务中')` |

**不纳入**：`'待服务'`（尚未开始，运营语义未满足）、`'已取消'`（无服务价值）。

**同日多单去重**：一位顾客 20 号当天可能有多张服务单 → `DISTINCT client_user_id`，一位顾客当月只发一份。

### 1.3 缺口三：admin UI 文案已固化的三条硬约束

`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:112-113` 原文：

> 每月 **20 号** 下护理单的顾客（即**当日存在已完成或进行中服务单**），按当前会员等级自动发放**消息 + 积分 + 优惠券**。
> 本次发放的优惠券**有效期为 10 天**。同一顾客同一月仅发放一次。

由此得三条**不可协商**的规则：

| # | 约束 | 对应实现 |
|---|---|---|
| A | "即当日存在已完成或进行中服务单" | §4.1 扫描 SQL（月日 + service_date + status 三重过滤）|
| B | "本次发放的优惠券**有效期为 10 天**" | §4.3 `expireAt = NOW() + INTERVAL '10 days'`，**不读** `coupon_templates.validity_mode` |
| C | "同一顾客同一月仅发放一次" | §4.3 幂等键前缀含 `{YYYY-MM}` |

**约束 B 是本 ticket 与生日 ticket 最大的差异点**：生日 ticket §2 决策 #7 沿用 `coupon_templates.validity_mode`；本 ticket 强制统一 10 天（运营诉求：感恩回馈就是一个 10 天窗口，模板各自定制会破坏语义）。

### 1.4 缺口四：幂等键设计

生日是**年度**重复事件 → 键含 `{YYYY}`；感恩日是**月度**重复事件 → 键必须含 `{YYYY-MM}`。

```
消息：thx-msg-{YYYY-MM}-{userId}          e.g. thx-msg-2026-04-FYGK-20250120-0001
积分：thx-pts-{YYYY-MM}-{userId}          e.g. thx-pts-2026-04-FYGK-20250120-0001
优惠券：thx-{YYYY-MM}-{userId}-{templateId}  e.g. thx-2026-04-FYGK-20250120-0001-tpl-xxxxx
```

**为什么 prefix 区分** (`thx-msg-` / `thx-pts-` / `thx-`)：复用 `messages.idempotency_key` / `point_transactions.external_ref` / `user_coupons.coupon_id` 三张表的**统一部分唯一索引**，不同前缀避免和 upgrade / birthday 场景混淆。

**跨月 5 月 20 日**：cron 运行前一刻的"今天"定义为数据库 `CURRENT_DATE`；键里的 `YYYY-MM` 同样从 DB 端取 `TO_CHAR(CURRENT_DATE, 'YYYY-MM')`。两者一致。

### 1.5 缺口五：scope 与 member_level = NULL 的处理

admin 表单是五档 × 三件套（五档 = 初钻/星钻/粉钻/金钻/黑钻），**无"null 等级"配置位**。因此：

- 顾客 `member_level` 为 NULL（未达初钻阈值）→ 无配置可查 → 跳过
- 顾客 `customer_type != '会员客'`（流量/体验/小美客）→ 一般情况 `member_level` 也为 NULL → 跳过
- 服务单的 `client_user_id` 为 NULL（外部客工/测试单等无关联顾客）→ 跳过

换言之：**本 ticket 只给"当月 20 号有服务单 + 已有等级"的顾客发放**。运营若要给流量客发感恩回馈，需另建 UI 支持 null 等级档，不在本 ticket。

---

## 2 用户确认的规则（决策基准线）

| # | 规则 | 决策 | 理由 |
|---|---|---|---|
| 1 | 发放时间 | **复用 3:00 AM 触发器**；admin 文案无需调整（未写具体时点）| 与生日 ticket §2 #1 同构；避免触发器翻倍 I/O；20 号凌晨 3 点的"今日"语义对顾客可接受 |
| 2 | 扫描范围 | **仅 service_date = CURRENT_DATE 当日，不跨月累计** | 严格按 admin UI 文案"当日存在已完成或进行中服务单"；不按"本月累计" |
| 3 | 服务单状态过滤 | `status IN ('已完成', '服务中')`；排除 `'待服务'` 与 `'已取消'` | admin UI 文案原文"已完成或进行中" |
| 4 | 发放对象 | `client_user_id IS NOT NULL AND member_level IS NOT NULL` 的会员 | admin 配置只有五档，无 null 档；外部客工单不触发 |
| 5 | 幂等键年月 | 键含 `{YYYY-MM}`，取 `TO_CHAR(CURRENT_DATE, 'YYYY-MM')` | 月度重复事件的必要性；跨月 cron 重跑自然幂等 |
| 6 | 优惠券有效期 | **固定 10 天**（`NOW() + INTERVAL '10 days'`），**忽略** `coupon_templates.validity_mode` | admin UI 文案硬约束；与生日 ticket §2 #7 的关键差异 |
| 7 | 缺服务单补发 | **不补发**：21 号及之后再跑不会补发 20 号的感恩日（次日 cron 的 `EXTRACT(DAY)=20` 条件失败）| 语义严格；若运营要补发可手动 `tcb fn invoke` 传 `event.forceThanksgiving=true`（本 ticket **不**实现，另开 ops ticket）|
| 8 | 20 号遇周末/节假日 | **不顺延**；20 号就是 20 号 | 语义最严；admin 文案无顺延说明；顾客当月 20 号若无服务单则当月跳过 |
| 9 | 当天同时命中升级 + 生日 + 感恩日（运营极端场景）| STEP 2 先跑（升级 → upgrade 三件套）→ STEP 3 次跑（birthday 三件套）→ STEP 4 最后（thanksgiving 三件套）| 三者幂等键不同，各自一份；与生日 ticket §2 #6 一致；顾客当日"三喜临门" |
| 10 | 配置缺失容错 | `thanksgiving_benefits` 不存在 / 解析失败 → console.warn 后跳过 STEP 4；不影响 STEP 1/2/3 | 运营未配置时"不做"比"报错中断"好 |
| 11 | 多店顾客 / 分店权益差异 | 不做。一个等级 → 一份权益；不按门店分 | admin UI 不支持，无差异配置 |

---

## 3 Schema 变更

**本 ticket 不做 schema 变更**。

与生日 ticket 一样，复用 `2026-04-24-member-level-150d-lock-and-upgrade-benefits.md` PR-1 落地的两列：

| 表 | 列 | 用途 |
|---|---|---|
| `messages` | `idempotency_key TEXT` + `uq_messages_idempotency_key` 部分唯一索引 | 感恩日消息幂等（`thx-msg-{YYYY-MM}-{userId}`）|
| `point_transactions` | `external_ref TEXT` + `uq_point_txns_external_ref` 部分唯一索引 | 感恩日积分幂等（`thx-pts-{YYYY-MM}-{userId}`）|

`user_coupons.coupon_id` 本身即 PK，继续作为幂等键。

**合并顺序强制约束**：
150d-lock ticket **PR-1 merge + 两库 db:migrate 完成** → 才能 merge 本 ticket 任何 PR。提 PR 时在描述里显式写 `blocked-by: #<150d-lock PR-1>`。若生日 ticket 先于本 ticket 合并，两者共享同一 schema 无冲突。

---

## 4 cronTask 改造

### 4.1 新增"今日（20 号）有护理单的会员"扫描 SQL

加到生日 ticket 的 `refreshBirthdayBenefits` 之后，作为 `refreshThanksgivingBenefits(client)` 函数。

采用 **同日 + 状态 + 等级** 三重过滤，`DISTINCT client_user_id` 去重：

```sql
SELECT DISTINCT cwu.user_id, cwu.member_level
FROM service_orders so
JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
WHERE EXTRACT(DAY FROM CURRENT_DATE) = 20
  AND so.service_date = CURRENT_DATE
  AND so.status IN ('已完成', '服务中')
  AND so.client_user_id IS NOT NULL
  AND cwu.member_level IS NOT NULL
```

说明：
- **日期语义**：`service_date` 是 `date` 类型（无时分秒），与 `CURRENT_DATE` 严格相等即可；无需 `EXTRACT(MONTH)` 比对（`service_date = CURRENT_DATE` 已蕴含"同年同月同日"）
- **双日期守门**：`EXTRACT(DAY FROM CURRENT_DATE) = 20` 作为"仅 20 号才扫"的提前短路，避免其他日期 cron 做全表扫描
- **JOIN 而非 EXISTS**：需要同时取出 `member_level` 做权益查找，JOIN 方便一次性拿到

### 4.2 `loadThanksgivingBenefitsConfig(client)`

复用 `loadBenefitsConfig` 模板，换 key 即可：

```js
async function loadThanksgivingBenefitsConfig(client) {
  const result = await client.query(
    "SELECT value FROM system_configs WHERE key = 'thanksgiving_benefits'"
  )
  if (!result.rows[0]?.value) {
    console.warn('[cronTask] thanksgiving_benefits 配置不存在，跳过 STEP 4')
    return null
  }
  try {
    return JSON.parse(result.rows[0].value)
  } catch (err) {
    console.error('[cronTask] thanksgiving_benefits 解析失败:', err.message)
    return null
  }
}
```

### 4.3 `grantThanksgivingBenefits(client, userId, yearMonth, level, config)`

与 `grantBirthdayBenefits` 的区别有两处：
1. 幂等键前缀：`thx-msg-` / `thx-pts-` / `thx-`（年月 `{YYYY-MM}`）
2. **优惠券有效期强制 10 天**（不读 `coupon_templates.validity_mode`）

```js
async function grantThanksgivingBenefits(client, userId, yearMonth, level, config) {
  // 1) 消息
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, config.messageTitle, config.messageBody || null, `thx-msg-${yearMonth}-${userId}`]
    )
  }

  // 2) 积分
  if (config.points && config.points > 0) {
    const ref = `thx-pts-${yearMonth}-${userId}`
    const inserted = await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '感恩回馈', $2, NULL, $3, NOW())
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

  // 3) 优惠券（固定 10 天有效期，不读 validity_mode）
  if (Array.isArray(config.couponTemplateIds) && config.couponTemplateIds.length > 0) {
    for (const templateId of config.couponTemplateIds) {
      const tplResult = await client.query(
        'SELECT is_active FROM coupon_templates WHERE template_id = $1',
        [templateId]
      )
      const tpl = tplResult.rows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cronTask/thanksgiving] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }
      // admin UI 硬约束：感恩日券固定 10 天有效期
      const expireAt = new Date(Date.now() + 10 * 86400000)
      const couponId = `thx-${yearMonth}-${userId}-${templateId}`
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

### 4.4 主流程 `refreshThanksgivingBenefits(client)`

```js
async function refreshThanksgivingBenefits(client) {
  // 非 20 号直接短路返回（避免无谓扫表日志噪音）
  const dayRow = (await client.query('SELECT EXTRACT(DAY FROM CURRENT_DATE)::int AS d')).rows[0]
  if (dayRow.d !== 20) return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0, skippedNotDay20: true }

  const benefitsConfig = await loadThanksgivingBenefitsConfig(client)
  if (!benefitsConfig) return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }

  // 年月从 DB 取，规避 CloudBase Node.js UTC 时区漂移
  const ymRow = (await client.query("SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS ym")).rows[0]
  const yearMonth = ymRow.ym  // 形如 '2026-04'

  const rows = (await client.query(
    `SELECT DISTINCT cwu.user_id, cwu.member_level
     FROM service_orders so
     JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
     WHERE so.service_date = CURRENT_DATE
       AND so.status IN ('已完成', '服务中')
       AND so.client_user_id IS NOT NULL
       AND cwu.member_level IS NOT NULL`
  )).rows

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig?.[row.member_level]
    if (!cfg) { skippedNoConfig++; continue }

    await client.query('BEGIN')
    try {
      await grantThanksgivingBenefits(client, row.user_id, yearMonth, row.member_level, cfg)

      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('customer.thanksgivingBenefits', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
        [row.user_id, JSON.stringify({
          _v: 1, _t: 'thanksgiving',
          yearMonth, memberLevel: row.member_level,
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
      console.error(`[cronTask/thanksgiving] failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }
  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}
```

### 4.5 入口 `main` 追加 STEP 4

在 `cronTask/index.js` 的 STEP 3（生日 ticket 规划位置）日志之后：

```js
const thxResult = await refreshThanksgivingBenefits(client)
if (thxResult.skippedNotDay20) {
  // 非 20 号的常见分支：单行日志即可
  console.log('[cronTask] STEP 4: thanksgiving skipped (not day 20)')
} else {
  console.log(
    `[cronTask] STEP 4: thanksgiving total=${thxResult.total} ` +
    `sent=${thxResult.sentCount} skipped=${thxResult.skippedNoConfig} error=${thxResult.errorCount}`
  )
}

// 返回值新增 thanksgiving 字段
return {
  code: 0,
  message: 'success',
  data: {
    updatedCount, resetCount, stats,
    memberLevel: levelResult,
    birthday: bdayResult,       // 生日 ticket 落地后已有
    thanksgiving: thxResult,    // ← 本 ticket 新增
  },
}
```

**STEP 顺序**：STEP 1 → STEP 2 → STEP 3（birthday）→ STEP 4（thanksgiving）。若生日 ticket 晚于本 ticket 合并，先插入 STEP 4 紧接 STEP 2，生日 ticket 合并时 STEP 3 插在二者之间即可（return 合并无冲突）。

---

## 5 admin 侧改动

**无改动**。

`member-benefits-page.tsx:112-113` 的 thanksgiving Tab 文案已准确描述业务规则：
- 20 号发放 ✓
- 当日存在已完成或进行中服务单 ✓
- 按会员等级发放三件套 ✓
- 优惠券有效期 10 天 ✓
- 同月一次 ✓

cron 时点（凌晨 3:00 而非 0:00）在现有文案中没有承诺，运营看到的是"20 号发放"→ 实际当日 3:00 送达，符合语义。**不新增文案**。

---

## 6 实施计划（按 PR 拆分）

### PR-1：cronTask STEP 4 实现

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | 新增 `loadThanksgivingBenefitsConfig` | `fengyu-client/cloudfunctions/cronTask/index.js`（`loadBenefitsConfig` 下方，或与生日 ticket 的 `loadBirthdayBenefitsConfig` 相邻）|
| 1.2 | 新增 `grantThanksgivingBenefits`（含 10 天有效期写死）| 同文件（`grantUpgradeBenefits` / `grantBirthdayBenefits` 下方）|
| 1.3 | 新增 `refreshThanksgivingBenefits`（含非 20 号短路）| 同文件（`refreshMemberLevels` / `refreshBirthdayBenefits` 下方）|
| 1.4 | `main` 追加 STEP 4 调用 + 日志 + 返回值字段 | 同文件 L295-320 附近 |
| 1.5 | 部署（按 cloudbase-deploy skill，**禁止** `--force`）：`tcb fn code update cronTask` | — |
| 1.6 | 部署后 `tcb fn invoke cronTask`（无触发器参数即 dry-run）一次 → 日志含 `STEP 4: thanksgiving`（非 20 号日期会看到 `skipped (not day 20)`；跑在 20 号当天应看到 `total=...`）即视为部署验证通过 | — |

**前置**：150d-lock ticket PR-1 必须已 merge 且两库已跑 migrate。生日 ticket PR-1 可先/后/并行合并，无强制顺序（共享 schema）。

### PR-2：cronTask 单测 + 集成测试

| # | 任务 | 文件 |
|---|------|------|
| 2.1 | vitest 扩展 | `fengyu-client/cloudfunctions/cronTask/__tests__/` |
| 2.2 | 场景 A：mock `CURRENT_DATE = 2026-04-20`，顾客有 `status='已完成'` 服务单 + 有等级 → 消息 1 条 / 积分 1 条 / 券 N 条；`customer_points.balance` 正确累加；`operation_logs` 1 条 `customer.thanksgivingBenefits` | — |
| 2.3 | 场景 B：mock `CURRENT_DATE = 2026-04-21` → `skippedNotDay20=true`；无任何扫描 | — |
| 2.4 | 场景 C：20 号当天顾客有 `status='服务中'` 服务单 → 命中，正常发放 | — |
| 2.5 | 场景 D：20 号当天顾客有 `status='待服务'` / `status='已取消'` 服务单 → 不命中；无发放 | — |
| 2.6 | 场景 E：20 号当天顾客有 2 张 `status='已完成'` 服务单（同一 `client_user_id`）→ `DISTINCT` 去重，仅发一份 | — |
| 2.7 | 场景 F：20 号当天顾客有服务单 + `member_level=NULL` → 不发放；无日志 | — |
| 2.8 | 场景 G：cron 20 号当日重跑 2 次 → 消息/积分/券各仍 1 条（幂等键生效） | — |
| 2.9 | 场景 H：cron 跨月 4/20 跑一次 → 键 `thx-*-2026-04-*`；5/20 跑一次 → 键 `thx-*-2026-05-*` 新键，正常发放 | — |
| 2.10 | 场景 I：优惠券 `expire_at` 断言 = 发放当日 + 10 天（不取 `coupon_templates.validity_mode`）| — |
| 2.11 | 场景 J：`thanksgiving_benefits` 未配置 → `skippedNoConfig` 等于 `total`；无消息/积分/券 | — |
| 2.12 | 场景 K：同一用户同日 STEP 2 升级 + STEP 4 感恩日都命中 → `messages` 2 条（upgrade + thanksgiving）、`point_transactions` 2 条、`operation_logs` 2 条；STEP 4 读到的是升级后的新等级 | — |

### PR-3（可选）：admin 文案微调

仅在实施中发现 UI 需补充"cron 当日凌晨 3 点发放"时新增，否则并入 PR-1。默认 §5 结论是**不改**。

---

## 7 验收标准

1. ✅ 2026-04-20 凌晨 3:00 cron 跑完：顾客 A（黑钻、4/20 有 `status='已完成'` 服务单）→ `messages`/`point_transactions`/`user_coupons` 各含 1 条（或 N 条，取决于优惠券模板数），`idempotency_key='thx-msg-2026-04-{A.userId}'`、`external_ref='thx-pts-2026-04-{A.userId}'`、`coupon_id='thx-2026-04-{A.userId}-{templateId}'`
2. ✅ 同日 cron 重跑 2 次 → 三张表行数均保持不变（幂等）
3. ✅ 顾客 B（4/20 有 `status='服务中'` 服务单）→ 命中，发放
4. ✅ 顾客 C（4/20 有 `status='已取消'` 服务单，无其他）→ 不发放；`operation_logs` 无 `thanksgivingBenefits`
5. ✅ 顾客 D（4/20 有 `status='待服务'` 服务单）→ 不发放
6. ✅ 顾客 E（4/20 两张 `status='已完成'` 服务单）→ 仅发一份
7. ✅ 顾客 F（4/20 有服务单但 `member_level=NULL`）→ 不发放；`skippedNoConfig` 中不计入（因为 SQL WHERE 已过滤）
8. ✅ 4/21 凌晨 3:00 cron 跑完：日志 `STEP 4: thanksgiving skipped (not day 20)`，无任何扫描
9. ✅ 5/20 凌晨 3:00 cron 跑完：顾客 A（若 5/20 仍有服务单）发放新一份感恩日权益；键 `thx-*-2026-05-*` 是新键；4 月的那份不受影响
10. ✅ 优惠券发放后 `expire_at = 发放时刻 + 10 天`（误差 ≤ 秒级），与 `coupon_templates.validity_mode` 无关
11. ✅ `system_configs.thanksgiving_benefits` 被 admin 删除/置 NULL → cronTask 20 号日志 `STEP 4: thanksgiving total=0 sent=0 skipped=0 error=0` 且 console.warn 一条；其余步骤不受影响
12. ✅ 顾客 G 同日既升级到星钻（STEP 2）又有 20 号服务单（STEP 4）→ `messages` 有 2 条（1 条 upgrade + 1 条 thanksgiving）、`point_transactions` 有 2 条（type=`'等级升级奖励'` + `'感恩回馈'`）、`operation_logs` 有 2 条（`memberLevelChange` + `thanksgivingBenefits`）；STEP 4 读到的是升级后的星钻等级
13. ✅ `tcb fn invoke cronTask` dry-run 日志包含 `STEP 4` 且结构符合预期
14. ✅ vitest 11 个新增场景（A–K）全部 green

---

## 8 风险与决策点

| # | 风险/决策 | 处理方案 |
|---|---|---|
| 8.1 | 20 号周末/节假日运营希望顺延 | §2 决策 #8：不顺延。若运营反馈 21/22 日要补发，另开 ops ticket，通过 `tcb fn invoke cronTask --param '{"forceThanksgiving":true,"overrideYearMonth":"2026-04"}'` 手动触发 |
| 8.2 | 性能：`service_orders.service_date = CURRENT_DATE` 可命中 `idx_svc_orders_store_date` 部分 | 该索引前缀是 `store_id`；若 WHERE 未带 store 过滤走不到。首轮观察实际执行时间，超过 30s 再考虑加 `CREATE INDEX ON service_orders (service_date) WHERE status IN ('已完成','服务中')` 部分索引；本 ticket **不做**预优化 |
| 8.3 | 20 号零点到 3 点之间新增的服务单 | 被当日 3:00 AM 的 cron 命中（`service_date = CURRENT_DATE` 为 2026-04-20）；符合预期 |
| 8.4 | 时区漂移 | 月份键从 DB `TO_CHAR(CURRENT_DATE, 'YYYY-MM')` 取（§4.4 已采用），与 SELECT 里的 `CURRENT_DATE` 同源；彻底消除 CloudBase Node.js UTC 问题 |
| 8.5 | 优惠券 10 天有效期是否允许 admin 后续可配 | 本 ticket 硬编码 10；若未来运营诉求可变，扩展方式：在 `thanksgiving_benefits` JSON 中增加顶层 `couponValidityDays` 字段，cron 读取并 fallback 为 10。当前不做 |
| 8.6 | 服务单后来被改为 `'已取消'` 但当日 3:00 已发放 | 本 ticket **不回收**。admin 若需撤回，沿用生日 ticket §9 同款方案：手动从三张表删除 + 扣减 balance；另开 ops ticket |
| 8.7 | 优惠券模板被删除/停用 | 沿用 `grantBirthdayBenefits` 的 `is_active` 检查，console.warn 后跳过；不影响其他模板/顾客的发放 |
| 8.8 | `client_user_id` 未来做账户合并 | 本 ticket 不处理合并；合并脚本需把 `idempotency_key` / `external_ref` / `user_coupons.coupon_id` 里的旧 userId 迁移，避免新账户同月重复发放 |
| 8.9 | cron 当日 03:00 失败且无告警 | 本 ticket **不**加告警机制；沿用现状。`errorCount > 0` 时在 console 打印（运维凭日志排查）。告警另开 ops ticket |
| 8.10 | 与生日 ticket PR-1 的合并顺序 | 共享 schema（150d-lock PR-1 提供），**无强依赖**。若生日 ticket 先合并，本 ticket 的 STEP 4 在 STEP 3 之后插入；若本 ticket 先合并，生日 ticket 的 STEP 3 可在 STEP 2 和 STEP 4 之间插入 |

---

## 9 不在本 ticket 范围

- null 等级感恩日礼（面向流量/体验/小美客）—— admin UI 需扩展第六档配置，本 ticket 不做
- 感恩日"提前 N 天"或"当月"（1 号–20 号累计）类宽松扫描 —— 需求未提，不做
- 感恩日当天触发微信订阅消息推送 —— 当前 `messages` 仅写站内，推送链路独立
- 感恩日礼的门店差异化（不同门店配不同权益）—— admin UI 不支持，运营未提
- 20 号遇节假日顺延 —— §2 决策 #8
- 补发机制（21 号及之后回溯发放）—— §2 决策 #7；可通过 `tcb fn invoke` 手动参数另开 ops ticket
- cron 失败告警 / 失败重试机制 —— 沿用现状
- 顾客侧 UI 展示"下次感恩日还有 X 天 / 已领感恩日礼" —— 纯展示需求，另开
- 员工感恩日礼 —— 业务上无此概念
- 感恩日礼的撤回 / 冲正能力 —— §8.6；另开 ops ticket
- 感恩日发放的可观测性（admin 页面看当月谁领到了）—— `operation_logs` 已有 `customer.thanksgivingBenefits` 记录，运维 SQL 可查；admin UI 展示另开
- "当月累计有服务单"扫描 —— 本 ticket 严格按 admin UI "当日"语义；若运营变更改为累计，修改 `§4.1` 扫描 SQL 的 `service_date = CURRENT_DATE` 为 `service_date >= date_trunc('month', CURRENT_DATE) AND service_date <= CURRENT_DATE` 即可；当前不做
- 优惠券 10 天有效期可配化 —— §8.5；当前硬编码

---

## 10 相关引用

### 现有代码
- cronTask 主入口：`fengyu-client/cloudfunctions/cronTask/index.js:272-320`
- cronTask STEP 2（升级权益）：`fengyu-client/cloudfunctions/cronTask/index.js:71-268`
- cronTask 触发器：`fengyu-client/cloudbaserc.json:41-47`
- admin 感恩日 Tab UI：`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:106-124`
- admin 权益 Server Action：`fengyu-admin/src/actions/settings.ts:14-39,256-346`（三场景共用）
- 服务单 schema：`db/schema/service.ts:15-47`
- 服务单状态枚举：`db/schema/enums.ts:66`（`["待服务","服务中","已完成","已取消"]`）
- 会员等级枚举：`db/schema/enums.ts:93`
- 消息表：`db/schema/message.ts`
- 积分流水表：`db/schema/points.ts`
- 优惠券模板/用户券：`db/schema/coupon.ts`
- 操作日志表：`db/schema/operation-log.ts`
- 系统配置表：`db/schema/system-config.ts`

### 关联 ticket
- 本 ticket：`notes/tickets/2026-04-24-member-thanksgiving-benefits.md`
- **前置（必须先 merge）**：`notes/tickets/2026-04-24-member-level-150d-lock-and-upgrade-benefits.md` PR-1（提供 `messages.idempotency_key` + `point_transactions.external_ref` schema）
- **姊妹**（90% 同构）：`notes/tickets/2026-04-24-member-birthday-benefits.md`（生日权益；主流程 / 幂等键格式 / 权益发放三件套结构相同，差异：扫描 SQL、幂等键年月粒度、优惠券有效期）
- 无关并行：`2026-04-24-multi-repayment-three-ends.md` / `2026-04-24-refund-admin-parity-and-rules.md`

### 规范与记忆
- `.42cog/cog.md` — 会员 / 等级 / 权益认知模型
- `.42cog/real.md` — 幂等硬规则
- `.42cog/pm/admin.pr.spec.md` — 管理后台产品规范
- MEMORY 项目记忆：
  - `project_member_level_rules.md` — 五档等级
  - `project_cloudbase_envvar_risk.md` — `tcb fn deploy --force` 禁用
  - `project_db_dual_env.md` — 5433/5434 双库
