/**
 * 增幅徽章的展示口径 —— **admin 全站单一真相源**（#310 / #315，2026-09-23 拍板）。
 *
 * 放在 `lib/` 根而不是 `lib/data-center/` 下，是因为消费方跨两个互不相干的路由段：
 * 数据中心 `(analytics)/data-center` 与首页看板 `(workspace)/dashboard`。
 * 让后者去 import 前者的模块会造出一条没有业务含义的依赖。
 *
 * ⚠️ **再写第三个看板要算增幅时，import 这里，别再抄一份。**
 * #307 的全部成本就来自「同一个符号翻转缺陷在第 5 个子项目里被重写了一遍」——
 * analyst 与 admin 无目录共享、无 snapshot 守护，于是各踩一次。admin 内部没有这个借口。
 *
 * ## 为什么返回判别联合而不是 `number | null`
 *
 * 决策 1 要区分 5 种情形，而「算不出」有**三种成因**：负基期已转正 / 负基期未转正 / 零基期。
 * 旧的 `deltaPct` 一律返回 `null`，信息在计算层就丢了，展示层再怎么改都补不回来
 * （analyst 的 `safeRate` 是同构缺陷，见 #314）。所以这里把成因显式编码进类型。
 *
 * 判别联合是纯对象，可安全跨 Server Component → Client Component 序列化。
 *
 * ## 决策 1 矩阵（硬约束：**不再输出任何基于负分母的百分比**）
 *
 * | 基期 | 当期 | kind | 文案 | 配色 |
 * |---|---|---|---|---|
 * | `base > 0` | 任意 | `pct` | 正常百分比 | 按 delta 正负 绿/红/灰 |
 * | `base < 0` | `cur > 0` | `turnedPositive` | 由负转正 | 🟢 绿 |
 * | `base < 0` | `cur <= 0` | `notTurned` | 未转正 | 🔴 红 |
 * | `base === 0` | 任意 | `na` | `--` | ⚪ 灰 |
 * | 空 / 非有限 | 任意 | `na` | `--` | ⚪ 灰 |
 *
 * `(cur-base)/base` 在 `base < 0` 时符号翻转（#283 实测：基期 −2,646、当期 +264
 * 算出 −109.98%，方向恰好反了），所以负基期下无论怎么包装都不出数。
 *
 * 两处刻意的取舍，都在拍板时标注过、可回退：
 * 1. **文案用「未转正」而非「仍为负」**——`base < 0 → cur === 0` 是从负数回到零，
 *    严格说不是「仍为负」；「未转正」同时涵盖 `cur < 0` 与 `cur === 0`，措辞不会说谎。
 * 2. **`base = −1000 → cur = −500`（亏损减半但仍亏）归入 `notTurned`（红）**。
 *    依据是 #310 正文「按**当期值本身**正负着色」——当期仍是负的就还是坏消息。
 *    已知代价：「亏损收窄」这个改善看不出来。若改为按 `cur - base` 方向着绿，
 *    会出现「绿色 + 未转正」的组合，当时判定更费解。
 */

/** 增幅徽章的展示态。`pct` 之外的三态都不带数值——因为它们**本来就算不出数**。 */
export type DeltaDisplay =
  | { kind: "pct"; value: number }
  | { kind: "turnedPositive" }
  | { kind: "notTurned" }
  | { kind: "na" }

export const TURNED_POSITIVE_TEXT = "由负转正"
export const NOT_TURNED_TEXT = "未转正"
/** 「算不出」的统一占位。沿用 `metrics.md` §数字格式化规则，不新增文案串。 */
export const NA_TEXT = "--"
/** 决策 3：舍入后为 0 的一律并入这个词，不再输出带符号的 `+0.00%` / `↑ 0%`。 */
export const FLAT_TEXT = "持平"

/**
 * 把（当期, 基期）解析成展示态。**这是决策 1 唯一的实现**。
 *
 * 注意 `cur` 只在 `base < 0` 时参与判定——`base > 0` 时方向由 `(cur-base)/base` 的符号决定，
 * 不需要看 `cur` 本身的正负（由正转负是 `-150%`，方向已经对了）。
 */
export function resolveDeltaDisplay(
  cur: number | null | undefined,
  base: number | null | undefined,
): DeltaDisplay {
  // NaN / ±Infinity 自己挡掉：`== null` 接不住 NaN（`NaN == null` 为 false），
  // 漏过去会让 `base > 0` 为 false 而误落进 `na` 之外的分支。
  if (cur == null || base == null) return { kind: "na" }
  if (!Number.isFinite(cur) || !Number.isFinite(base)) return { kind: "na" }

  if (base < 0) return cur > 0 ? { kind: "turnedPositive" } : { kind: "notTurned" }
  // base === 0：分母为零，增幅无定义。-0 也走这里（`-0 < 0` 为 false、`-0 > 0` 为 false）。
  if (base === 0) return { kind: "na" }

  const value = (cur - base) / base
  // 商可能溢出：入参各自有限不代表商有限（`1 / 1e-320` → Infinity）。
  // 守卫必须落在最终值上，这是 #307 闸门 2 codex 那条 P3 的教训。
  if (!Number.isFinite(value)) return { kind: "na" }
  return { kind: "pct", value }
}

/**
 * 徽章配色语义。展示层据此取自己的色值——本模块不写具体颜色，
 * 因为数据中心（`text-[#3D8A5A]`）与首页看板用的是同一套色号但不同的类名组合。
 *
 * `pct` 且舍入后为 0 → `neutral`（决策 3）。`digits` 传展示精度：
 * 数据中心 `toFixed(2)`、首页看板 `Math.round` 整数，**两处阈值不同，必须各自传**。
 */
export function deltaTone(
  display: DeltaDisplay,
  digits: number,
): "positive" | "negative" | "neutral" {
  switch (display.kind) {
    case "turnedPositive":
      return "positive"
    case "notTurned":
      return "negative"
    case "na":
      return "neutral"
    case "pct": {
      // 先按展示精度舍入再判方向，否则会出现「显示持平、颜色是绿」的错配。
      const shown = Number((display.value * 100).toFixed(digits))
      if (shown > 0) return "positive"
      if (shown < 0) return "negative"
      return "neutral"
    }
  }
}

/**
 * 判断一个 `pct` 是否应当显示为「持平」（决策 3）。
 *
 * ⚠️ 已知代价、拍板时已提示：真实值非 0 却显示「持平」，严格说不准确。
 * 500,100 vs 500,000（真实 +0.02%）与 500,000 vs 500,000（真实 0）会显示成同一个词。
 * 取舍是：`+0.00%` 那种「涨了、涨幅为 0」的自相矛盾展示，比「持平」的精度损失更容易误导。
 */
export function isFlatAfterRounding(value: number, digits: number): boolean {
  return Number((value * 100).toFixed(digits)) === 0
}
