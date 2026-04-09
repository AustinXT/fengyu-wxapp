# Bug: 会员门槛 1980/1990 硬编码 + 跨端数字不一致

> 生成日期：2026-04-10
> 关联适配计划：`notes/adapt-plans/02-customer-classification.md` §1.10 / §3.3.3，`notes/adapt-plans/05-service-presale-cycle.md` §B3 / §B4
> 严重级别：中（跨端计数漂移 + 配置不生效）
> 修复归属：单独 fix `fix(member-threshold): 统一走 system_configs + 缓存`
> 决策记录：
> - spending_tier CASE 采用 **B1 方案**（枚举标签保留 `'1990-1W'`，但 SQL 数字边界从 config 读取；标签名与真实边界解耦）
> - 缓存失效：**主动清缓存**（admin saveSettings 直接广播各云函数 invalidate） + `system_configs.updated_at` 戳作为兜底 lazy 核对
> - 权威默认值统一为 **1980**（与 `admin/actions/settings.ts:54` DEFAULT_SETTINGS 对齐）

---

## 1 问题本质

两类数字在代码中混淆存在，必须先分清：

### 类型 A — `new_member_threshold`（动态门槛）
判定"会员客"身份、dashboard 新会员统计、`documentType` 售前/售后、`member_level` 初钻下限。
→ 权威源：`system_configs.new_member_threshold`，**必须全部改为 config 读取 + 缓存**。

### 类型 B — `spending_tier` 枚举字面量 `'1990-1W'`
`db/schema/enums.ts:68`：
```ts
pgEnum("spending_tier", ["10W+", "6-10W", "3-6W", "1-3W", "1990-1W", "<1990"])
```
枚举值字符串本身写死 `1990`，PG 枚举不可动态生成标签名。这是历史分桶标签，与门槛语义独立。

---

## 2 12 处硬编码完整清单（代码级事实核对）

| # | 位置 | 数字 | 类型 | 当前写法 | 修复动作 |
|---|------|------|------|---------|---------|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:38` | 1990 | **B** | SQL CASE 裸字面量 | B1：CASE 数字 `>= ${threshold}`，标签保留 `'1990-1W'` |
| 2 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:72` | 1990 | A | 已读 config，fallback `|| 1990` | 改用 `getMemberThreshold()` helper |
| 3 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:377` | 1990 | A | 已读 config，fallback `|| 1990` | 改用 `getMemberThreshold()` helper |
| 4 | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:676` | **1980** | A | **完全裸字面量，不读 config** | 改用 helper + 参数化 `>= $N` |
| 5 | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:659` | 1980 | — | 注释 "1980 元" | 改为"配置阈值" |
| 6 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:333` | 1990 | A | 已读 config，fallback `|| 1990` | 改用 `getMemberThreshold()` helper |
| 7 | `fengyu-client/cloudfunctions/payNotify/index.js:123` | 1990 | **B** | SQL CASE 裸字面量 | B1：CASE 数字 `>= ${threshold}`，标签保留 `'1990-1W'` |
| 8 | `fengyu-client/cloudfunctions/payNotify/index.js:146` | 1990 | A | 已读 config，fallback `|| 1990` | 改用 helper（helper 内联到同文件或新建 utils） |
| 9 | `fengyu-client/cloudfunctions/cronTask/index.js:77` | 1990 | — | 注释 "初钻 ≥1990" | 改为"初钻 ≥ 阈值" |
| 10 | `fengyu-client/cloudfunctions/cronTask/index.js:84` | 1990 | A | `determineMemberLevel(spend)` 内裸字面量 | 新增参数 `determineMemberLevel(spend, threshold)`，`refreshMemberLevels` 开头取一次 |
| 11 | `fengyu-admin/src/actions/orders.ts:534` | 1990 | A | 已读 config，fallback `|| 1990` | 抽成 `getMemberThreshold()` 工具 + `unstable_cache()` 包装 |
| 12 | `fengyu-admin/src/actions/settings.ts:54` | **'1980'** | — | `DEFAULT_SETTINGS.newMemberThreshold` | **保留，作为权威默认值** |

**UI 侧（保留不动）**：
- `fengyu-admin/src/app/(main)/settings/_components/settings-page.tsx:117` `placeholder="1980"` — UX 提示，保留
- `db/migrations/0023_document_type.sql:11` — 已执行历史 migration，不回改

### 2.1 数字冲突的真实形态
- admin 权威默认 `1980`（#12）
- staff dashboard 裸字面量 `1980`（#4，巧合一致但不读 config）
- 其余 A 类 fallback 全部 `1990`（#2/#3/#6/#8/#11）
- 跨端错位：**admin 配置默认 1980 → 5 处云函数 fallback 1990 → 若 DB 未写入 system_configs 行，则 dashboard 用 1980 计数、开单判定用 1990，同一顾客两套结论**

---

## 3 修复方案

### 3.1 Helper 设计（共 4 份，各云函数独立一份）

由于 CloudBase 不便跨函数共享代码，需要在 4 个云函数里各复制一份：

| 路径 | 说明 |
|------|------|
| `fengyu-staff/cloudfunctions/staffApi/utils/config.js` | 新建，与现有 `utils/wxacode.js` 同级 |
| `fengyu-client/cloudfunctions/clientApi/utils/config.js` | 新建，与现有 `utils/` 同级 |
| `fengyu-client/cloudfunctions/payNotify/config.js` | 新建（payNotify 扁平结构，放根目录） |
| `fengyu-client/cloudfunctions/cronTask/config.js` | 新建（cronTask 扁平结构，放根目录） |

**统一实现模板**：

```js
// utils/config.js（云函数内每份副本内容一致）
const pg = require('../db/pg')  // payNotify/cronTask 若无 db/pg 子模块，需内联 Pool 或引入 pg 库
const FALLBACK_THRESHOLD = 1980  // 与 admin DEFAULT_SETTINGS 对齐
const CACHE_TTL_MS = 5 * 60 * 1000   // 5 分钟内存 TTL（双保险）
const STALE_CHECK_INTERVAL_MS = 30 * 1000  // 30 秒最多核对一次 updated_at 戳

let _cachedValue = null
let _cachedUpdatedAt = null  // system_configs.updated_at 的毫秒戳
let _lastCheckAt = 0

/**
 * 获取会员门槛（单位：元）。
 *
 * 失效策略（双层）：
 * 1. 主动：admin saveSettings → 调用 config.invalidateConfig action → 清空本函数缓存
 * 2. 被动：每 30 秒最多核对一次 system_configs.updated_at 戳，变化则重读
 *
 * 失败兜底：DB 报错 → 返回 FALLBACK_THRESHOLD（1980）
 */
async function getMemberThreshold() {
  const now = Date.now()

  // Fast path：内存缓存有效且 30s 内已核对过
  if (_cachedValue !== null && (now - _lastCheckAt) < STALE_CHECK_INTERVAL_MS) {
    return _cachedValue
  }

  try {
    const rows = await pg.query(
      "SELECT value, updated_at FROM system_configs WHERE key = 'new_member_threshold'"
    )
    const row = rows[0]
    if (row) {
      const ts = new Date(row.updated_at).getTime()
      // updated_at 戳变化 → 重读 value
      if (ts !== _cachedUpdatedAt || _cachedValue === null) {
        const v = Number(row.value)
        if (Number.isFinite(v) && v > 0) {
          _cachedValue = v
          _cachedUpdatedAt = ts
        }
      }
      _lastCheckAt = now
      if (_cachedValue !== null) return _cachedValue
    }
  } catch (err) {
    console.warn('[config] getMemberThreshold fallback:', err.message)
  }

  // 查询失败或 DB 无该 key → 兜底但不写缓存（下次重试）
  return FALLBACK_THRESHOLD
}

/** 主动清缓存（供 config.invalidateConfig action 调用） */
function invalidateCache() {
  _cachedValue = null
  _cachedUpdatedAt = null
  _lastCheckAt = 0
}

/** TTL 双保险：模块加载时起每 5 分钟强制过期一次（处理 warm 实例长期存活场景） */
setInterval(() => {
  if (_cachedValue !== null && (Date.now() - _lastCheckAt) > CACHE_TTL_MS) {
    invalidateCache()
  }
}, CACHE_TTL_MS).unref?.()

module.exports = { getMemberThreshold, invalidateCache }
```

**admin 侧（Next.js）不同**：多实例部署 + Server Actions 无进程保证，采用 `unstable_cache` + revalidate tag：

```ts
// fengyu-admin/src/lib/member-threshold.ts（新建）
import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/db'
import { sql } from 'drizzle-orm'

const FALLBACK = 1980
const TAG = 'new_member_threshold'

export const getMemberThreshold = unstable_cache(
  async (): Promise<number> => {
    try {
      const rows = await db.execute<{ value: string }>(sql`
        SELECT value FROM system_configs WHERE key = 'new_member_threshold'
      `)
      const v = Number((rows as any[])[0]?.value)
      return Number.isFinite(v) && v > 0 ? v : FALLBACK
    } catch {
      return FALLBACK
    }
  },
  ['new_member_threshold'],
  { tags: [TAG], revalidate: 300 }  // 5 分钟兜底
)

export function invalidateMemberThreshold() {
  revalidateTag(TAG)
}
```

### 3.2 主动清缓存广播（admin saveSettings 改造）

`fengyu-admin/src/actions/settings.ts` 的 `saveSettings()` 在写入完成后，**仅当 `newMemberThreshold` 发生变化**时广播：

```ts
// settings.ts saveSettings() 末尾新增
if (oldSettings.newMemberThreshold !== settings.newMemberThreshold) {
  invalidateMemberThreshold()  // admin 自身

  // 广播到云函数（异步，失败容错）
  await Promise.allSettled([
    broadcastInvalidate('clientApi', 'config.invalidateConfig'),
    broadcastInvalidate('payNotify', 'config.invalidateConfig'),  // 若 payNotify 支持 action 路由
    broadcastInvalidate('staffApi', 'config.invalidateConfig'),   // 需补 staff envId 配置
  ])
}
```

**跨 envId 限制**：admin 当前 `CLOUDBASE_ENV_ID` 指向 client envId（`cloud1-3gpht4b01ff88838`），无法直接调 staffApi（`cloud1-9g3ydpg512eecc99`）。

两种落地路径：

**路径 A（务实）**：admin 仅广播 client envId 的云函数（clientApi / cronTask），staffApi 依赖被动 `updated_at` 戳（最长 30 秒生效）。
- 改动：`lib/cloudbase.ts` 新增 `callFunction(name, data)` 薄封装
- 新增 action：`clientApi/routes/config.js` 的 `invalidateConfig`（内部权限：校验 `CLIENT_SECRET`）、`cronTask` 无 action 路由结构，改为仅依赖被动失效

**路径 B（完整）**：admin 补 `STAFF_CLOUDBASE_ENV_ID` + 第二个 `tcb.init()` 实例，同时广播两个 envId。
- 改动：`lib/cloudbase.ts` 新增 `getStaffApp()`，`.env.example` 补说明
- 新增 action：`staffApi/routes/config.js` 的 `invalidateConfig`（内部权限：校验 `CLIENT_SECRET`）

**推荐路径 A**，原因：
- payNotify 和 staffApi 即使晚 30 秒生效也无业务损失（门槛从 1980 改 2000 不是紧急运维）
- 被动 `updated_at` 戳已经满足"主动失效"的语义（admin 写入即变戳，30 秒内必读到）
- 路径 B 的跨 envId 配置增加部署复杂度，收益小

### 3.3 B1 方案 — spending_tier CASE 数字参数化

`staffApi/routes/order.js:29-51` 的 `refreshSpendingTier` 改写：

```js
async function refreshSpendingTier(client, clientUserId) {
  if (!clientUserId) return
  const memberThreshold = await getMemberThreshold()
  await client.query(
    `UPDATE client_wechat_users
     SET spending_tier = CASE
       WHEN t.total >= 100000 THEN '10W+'
       WHEN t.total >= 60000  THEN '6-10W'
       WHEN t.total >= 30000  THEN '3-6W'
       WHEN t.total >= 10000  THEN '1-3W'
       WHEN t.total >= $2     THEN '1990-1W'   -- 注：标签名为历史遗留 bucket id，数字边界随 config
       ELSE '<1990'
     END::spending_tier,
     updated_at = NOW()
     FROM (
       SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM sale_orders
       WHERE client_user_id = $1
         AND status IN ('已支付', '已完成')
     ) t
     WHERE user_id = $1`,
    [clientUserId, memberThreshold]
  )
}
```

`payNotify/index.js:114-135` 做相同改动。

**关键约束**：CASE 中只有 `1990-1W` 一档的下界参数化，其余四档（10W/6W/3W/1W）保持固定 — 因为枚举标签 `'10W+' / '6-10W' / '3-6W' / '1-3W'` 都是万元级固定 bucket，与会员门槛无关。

**UI 说明文案**（配套）：`admin/settings-page.tsx` 的 newMemberThreshold 输入框下方补一行说明：
> ⚠️ 调整后，顾客消费档位的最低档（显示为"1990-1W"）边界会随之变化，但档位标签名保留为 `1990-1W`（历史分桶 ID）。如需改标签名需做 migration。

### 3.4 cronTask `determineMemberLevel` 参数化

```js
// cronTask/index.js
function determineMemberLevel(spend, threshold) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000)  return '金钻'
  if (spend >= 30000)  return '粉钻'
  if (spend >= 10000)  return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

// 调用方（refreshMemberLevels 主流程开头）
async function refreshMemberLevels(client, now) {
  const threshold = await getMemberThreshold()
  // ... 原逻辑，所有 determineMemberLevel(spend) 调用点改为 determineMemberLevel(spend, threshold)
}
```

### 3.5 staffApi dashboard 参数化

```js
// staffApi/routes/staff.js:669-691 新会员统计
const memberThreshold = await getMemberThreshold()

const newMemberRows = await pg.query(`
  SELECT COUNT(DISTINCT o.client_user_id) AS new_members
  FROM sale_orders o
  WHERE ${newMemberFilter}
    AND o.status = '已支付'
    AND o.paid_at >= $${newMemberParams.length + 1}::date
    AND o.paid_at < ($${newMemberParams.length + 2}::date + INTERVAL '1 day')
    AND o.total_amount >= $${newMemberParams.length + 3}
    AND o.client_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM sale_orders o2
      WHERE o2.client_user_id = o.client_user_id
        AND o2.status = '已支付'
        AND o2.paid_at < $${newMemberParams.length + 1}::date
    )
`, [...newMemberParams, start, end, memberThreshold])
```

注释 659 行同步改为"新会员：首次消费达配置阈值（system_configs.new_member_threshold）"。

---

## 4 验证清单

### 4.1 单元测试
- [ ] 新增 `fengyu-staff/cloudfunctions/staffApi/__tests__/utils/config.test.js`
  - [ ] 首次调用查 DB 并缓存
  - [ ] 30 秒内重复调用不再查 DB
  - [ ] `updated_at` 戳变化时重读 value
  - [ ] DB 报错时返回 1980 兜底且不写缓存
  - [ ] `invalidateCache()` 强制下次重读
  - [ ] 无效 value（0/负数/NaN/空）走兜底
- [ ] 对应 clientApi / payNotify / cronTask 各一份 config.test.js（结构镜像）
- [ ] `fengyu-admin/src/lib/member-threshold.test.ts`
  - [ ] `unstable_cache` 命中
  - [ ] `invalidateMemberThreshold()` 触发 revalidateTag
- [ ] `fengyu-admin/src/actions/settings.test.ts` 补 case
  - [ ] `newMemberThreshold` 未变 → 不广播
  - [ ] `newMemberThreshold` 变化 → 广播调用
- [ ] `fengyu-admin/src/actions/orders.test.ts`
  - [ ] documentType 判定使用 helper 返回值（mock helper）
- [ ] `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js`
  - [ ] `refreshSpendingTier` 接受参数化边界
  - [ ] `recalcCustomerType` 使用 helper
- [ ] `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/staff.test.js` dashboard 新会员计数使用 helper

### 4.2 手工回归
- [ ] admin 设置页改 `new_member_threshold`：1980 → 2000 → 保存
  - [ ] clientApi（开单/payNotify）立即生效（主动广播）
  - [ ] staffApi（dashboard/开单）30 秒内生效（被动核对）
  - [ ] cronTask 下次执行时生效
- [ ] 开单金额 1985 元的顾客：门槛 1980 时判 会员客、门槛 2000 时判 小美客（旧枚举）/流量客（新枚举）
- [ ] `spending_tier` 档位：顾客历史累计 1985 元，门槛 1980 时档位为 `'1990-1W'`；门槛 2000 时档位为 `'<1990'`
  - 注意：即使命中 `'1990-1W'` 档，标签名不随门槛变（UI 仍显示 "1990-1W"）

### 4.3 生产数据校验
```sql
-- 修复前执行
SELECT value, updated_at FROM system_configs WHERE key = 'new_member_threshold';
-- 若返回空 → admin 保存一次（写入默认 1980）后再部署云函数
-- 若返回 1990 → 与业务方确认是否需要改 1980
```

---

## 5 Commit 组织建议

按字段/特性维度拆 2 个独立 commit（遵循 `feedback_commit_grouping.md`）：

**Commit 1 — helper 基础设施**
```
fix(member-threshold): 提取 getMemberThreshold helper 并统一 fallback 1980

- 新增 4 个云函数的 utils/config.js（staffApi/clientApi/payNotify/cronTask）
- 实现双层失效：主动 invalidateCache + updated_at 戳 lazy 核对 + 5 分钟 TTL 兜底
- 新增 admin/src/lib/member-threshold.ts（unstable_cache + revalidateTag）
- fallback 值统一从 1990 改为 1980，与 DEFAULT_SETTINGS 对齐
- 覆盖 #2/#3/#6/#8/#11 五处 fallback + #4 dashboard 裸字面量
```

**Commit 2 — spending_tier B1 + cronTask 参数化 + 广播**
```
fix(member-threshold): spending_tier CASE 数字参数化 + admin 广播 invalidate

- refreshSpendingTier / payNotify 的 spending_tier CASE 数字 >= 从 config 读取
- 枚举标签 '1990-1W' 保留作为历史 bucket id（B1 方案）
- cronTask determineMemberLevel(spend, threshold) 参数化
- admin saveSettings 在 newMemberThreshold 变化时广播 invalidate 到 client envId
- staffApi 走被动 updated_at 戳失效（30 秒内生效），避免跨 envId 配置
- settings-page.tsx 补 UI 说明文案
```

---

## 6 风险与非目标

### 6.1 风险
- **枚举标签 vs 真实边界错位（B1 固有）**：admin 把门槛改成 2000 后，消费 2000 元的顾客会被贴 `'1990-1W'` 标签。属于 UI 文案问题，非数据损坏。若业务不能接受，升级到 B2（改枚举为 `T0~T5`）。
- **跨 envId 广播不覆盖 staffApi**：staffApi 依赖被动 30 秒 lazy 核对，非零延迟。若业务要求即时一致，补 `STAFF_CLOUDBASE_ENV_ID` 配置（路径 B）。
- **warm 实例长期存活**：CloudBase 同一实例可能存活数十分钟，内存缓存与 DB 脱同步窗口由 `STALE_CHECK_INTERVAL_MS=30s` + `CACHE_TTL_MS=5min` 双保险控制。

### 6.2 非目标
- 不重构 `spending_tier` 枚举（B2 方案）
- 不引入 Redis 或其他外部缓存层
- 不修改 `migrations/0023_document_type.sql` 的历史 fallback
- 不覆盖 `spending_tier` 中 `'10W+' / '6-10W' / '3-6W' / '1-3W'` 四档的参数化（固定万元级 bucket，与门槛无关）

---

## 7 影响范围矩阵

| 端 | 文件数 | 新增 | 修改 | 测试 |
|---|---|---|---|---|
| admin | 1 新 + 2 改 | `lib/member-threshold.ts` | `actions/settings.ts`、`actions/orders.ts` | `member-threshold.test.ts`、补 settings/orders 测试 |
| staffApi | 1 新 + 2 改 | `utils/config.js` | `routes/order.js`、`routes/staff.js` | `__tests__/utils/config.test.js`、补 order/staff 测试 |
| clientApi | 1 新 + 1 改 | `utils/config.js` | `routes/order.js` | `__tests__/utils/config.test.js`、补 order 测试 |
| payNotify | 1 新 + 1 改 | `config.js` | `index.js` | `__tests__/config.test.js` |
| cronTask | 1 新 + 1 改 | `config.js` | `index.js` | `__tests__/config.test.js`（若有测试框架） |
| 规范文档 | 2 改 | — | `.42cog/pm/staff.pr.spec.md`、`notes/adapt-plans/05-service-presale-cycle.md` §B3/B4 替换结论 | — |

---

## 8 遗留 / 后续工作

- 若业务确认需要标签名动态化 → 发起 B2 ticket：重构 `spending_tier` 为无语义 tier id
- `notes/adapt-plans/05-service-presale-cycle.md` §B4 的旧结论（"保留 1990 不动"）需在合并本 fix 后改写为 B1 方案
- `.42cog/pm/staff.pr.spec.md:312` 新会员门槛描述需要同步更新为"由 system_configs.new_member_threshold 配置，默认 1980"
