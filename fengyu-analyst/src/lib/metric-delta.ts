/**
 * KPI 徽章的同比/环比文案与配色。
 *
 * 独立成模块而非留在 dashboard/page.tsx 里，有两个原因：
 * 1. page.tsx 是 server component，import 它会拖进 db/auth 整棵树，函数无法单测；
 * 2. #307 的成因正是「同一个增幅算法在新子项目里被重写一遍、又踩同一个坑」——
 *    下一个看板要算增幅时，应当 import 这里，而不是再抄一份。
 *
 * ## 基期为什么必须 > 0
 *
 * `(current - previous) / previous` 在 `previous < 0` 时**符号翻转**：
 * 净额由负回正本是向好，却算出负增长。admin 侧实测案例（#283，南昌梦祥店「本周」业绩，
 * 基期 −2,646.00、当期 +264.00）旧式算出 −109.98%，方向恰好反了。
 *
 * ⚠️ 本站当前数据通路上 `previous < 0` **暂时不可达**，但**挡住它的只有一道东西**：
 * `new-customer-funnel.ts` 的 SQL 逐行 `GREATEST(received - refunded_amount, 0)` 夹底
 * （`GREATEST` 在 `SUM` 的参数内，被加数恒 ≥ 0，聚合后不可能为负）。
 *
 * 别把 JS 侧那几个 helper 当成第二道护栏——**它们不挡负号**：
 *   - `normalizeNumber(-100)` 返回 `-100`（只排除非有限值，不管符号）
 *   - `safeAverage(-100, 2)` 返回 `-50`（只查分母 > 0，不管分子）
 *   - `aggregateFunnelKpi` 的金额聚合是直接 `reduce` 求和，不夹底
 * 加上「生产 `sale_orders.received - refunded_amount` 当前无负行（0/21329，实测）」这条
 * **数据事实**（会变，不是代码保证），总共就两层，其中只有一层是代码。
 *
 * 而负金额在库里**是真实存在的**，只是不在那一列上：`sale_items.received < 0` 有 2824 行，
 * 47 个已支付销售/转换单的 Σitem 为负（最差 −19,370）。漏斗 SQL 已纳入「转换单」，
 * 而转换单正是携带负数转出行的单型——`sale_orders.received` 一旦改成按 item 净额派生，
 * 这些单就会向基期注入负贡献（**是否足以把整段基期压成负数取决于切片粒度**，
 * 门店 × 单月这种窄切片下单笔 −19,370 就够了，但不是必然）。
 * **所以这里的守卫是承重的，不是冗余，别当死代码删掉。**
 *
 * ## rate 分支为什么不挡负基期
 *
 * `type === "rate"` 走的是百分点差值（减法），没有除法，不存在符号翻转。
 * 但 `previous === 0` 仍统一返回「无基数」——那是改动前就有的行为，此次不动（#307 AC3）。
 * ⚠️ 已知代价：「到店率 0% → 30%」会被吞成「无基数」，而「30% → 0%」照常出 `-30.0pct`，
 * 涨跌方向不对称。新店/新市场的同比基期必然全 0，命中不低。此项已另行登记，不在 #307 范围内。
 *
 * ## 与 admin `src/lib/data-center/comparison.ts` 的差异（有意分叉，不是漏改）
 *
 * admin 侧（#283 / PR #305）负基期返回 `null` → 渲染 `--` → 徽章**灰色，弃判方向**。
 * 这里负基期返回文案「无基数」但 **tone 仍按 `current > prevYear` 判方向**（绿/红）。
 * 两站点指标集不重叠（admin 是门店业绩等，这里是新客漏斗），不会对同一现象给出相反结论；
 * 保留方向是刻意的——由负回正是真实的向好信息，不该跟着倍数一起丢。
 * 别为了「统一口径」把这里也改成 default。
 *
 * ## `count` 与 `money` 行为完全相同
 *
 * 两者走同一条除法分支，输出逐字一致，真实语义只有布尔 `isRate`。
 * 保留三值是为了**在调用点标注指标性质**（`page.tsx` 八个调用点：3 省略 + 2 rate + 3 money）。
 * 别以为 `"money"` 会有千分位或货币符号——它没有；要加得先在这里实现。
 */

export type MetricDeltaType = "count" | "rate" | "money"

export type MetricDeltaTone = "default" | "positive" | "negative"

/** 基期不可用时的统一文案。负基期复用它，不新增文案串（#307 AC1 已预授权）。 */
export const NO_BASE_TEXT = "无基数"

/** `formatPointDelta` 专用：上一年区间根本不存在。与「基期不可用」语义不同，刻意不合并。 */
export const NO_LAST_YEAR_TEXT = "无上一年对比"

/**
 * 非有限值是**上游数据管道的 bug 信号**，不是正常的「没有基数」。
 *
 * 旧实现会把它渲染成 `"NaN%"` / `"+Infinity%"`——丑，但刺眼、会被发现。
 * 新实现统一吞成「无基数 + 灰色」，与「这个月确实没新客」长得一模一样，
 * 是一次可观测性回退。所以在吞掉之前先落一条服务端日志（这是 server component 渲染路径）。
 * 没有改成用户可见的区分文案，是因为该分支在当前数据通路不可达，
 * 为不可达分支新增产品文案得不偿失。
 */
function warnNonFinite(fn: string, values: Record<string, number>): void {
  console.warn(`[metric-delta] ${fn} 收到非有限值，上游数据管道可能有 bug`, values)
}

/**
 * 把差值渲染成带符号的百分比/百分点文案，并在最后一刻挡住溢出。
 *
 * ⚠️ 守卫必须落在**最终要渲染的那个数**（`delta * 100`）上，查中间量都会漏。三条真实的溢出路径：
 *   - 减法：`MAX_VALUE − (−MAX_VALUE)` → `delta` 直接是 `Infinity`
 *   - 除法：`1 / 1e-320` → 入参各自有限，商是 `Infinity`
 *   - 乘 100：`MAX_VALUE / 1` 的商**有限**（1.79e308），但 `× 100` 才溢出
 * 第三条是最阴的——只查 `delta` 会以为已经封死，实际仍渲染出 `"+Infinity%"`。
 */
function renderScaledDelta(
  fn: string,
  delta: number,
  suffix: "%" | "pct",
  context: Record<string, number>,
): string {
  if (delta === 0) return "持平"
  const scaled = delta * 100
  if (!Number.isFinite(scaled)) {
    warnNonFinite(fn, { ...context, delta })
    return NO_BASE_TEXT
  }
  return `${scaled > 0 ? "+" : ""}${scaled.toFixed(1)}${suffix}`
}

export function formatDeltaPart(current: number, previous: number, type: MetricDeltaType): string {
  // NaN / ±Infinity 自己挡掉：`=== 0` 接不住 NaN，漏过去会渲染出 "NaN%" / "+Infinity%"。
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    warnNonFinite("formatDeltaPart", { current, previous })
    return NO_BASE_TEXT
  }
  if (previous === 0) return NO_BASE_TEXT
  if (type === "rate") {
    return renderScaledDelta("formatDeltaPart(rate)", current - previous, "pct", { current, previous })
  }
  // 见文件头「基期为什么必须 > 0」。此处 previous 已排除 0，只剩负数要挡。
  if (previous < 0) return NO_BASE_TEXT
  return renderScaledDelta("formatDeltaPart", (current - previous) / previous, "%", { current, previous })
}

export function formatMetricDelta(
  current: number,
  prevYear: number,
  prevPeriod: number,
  type: MetricDeltaType = "count",
): { text: string; tone: MetricDeltaTone } {
  const text = `同比 ${formatDeltaPart(current, prevYear, type)} / 环比 ${formatDeltaPart(current, prevPeriod, type)}`
  // tone 只看同比，且走直接比大小而非除法——所以负基期下方向依然正确
  // （prevYear=−2646、current=264 → positive 绿），不需要跟着 formatDeltaPart 一起挡。
  // ⚠️ 刻意**不查 prevPeriod**：tone 的定义就是同比方向，环比脏了不该影响它。
  //    这是全文件唯一一处「守卫覆盖面不一致」，有测试钉住，别顺手"补齐"。
  // 挡的只有非有限值：`current > NaN` 恒 false，不挡会把脏数据渲染成红色「下降」。
  if (!Number.isFinite(current) || !Number.isFinite(prevYear)) return { text, tone: "default" }
  if (prevYear === 0 || current === prevYear) return { text, tone: "default" }
  return { text, tone: current > prevYear ? "positive" : "negative" }
}

/**
 * 百分点差值型同比徽章（复购率看板用）。入参是**上游已算好的差值**，不是两期原值。
 *
 * 与 `formatDeltaPart` 的区别：这里不做任何除法，所以没有符号翻转问题；
 * 但 `value > 0` 的三元在 `value = NaN` 时恒 false，会把脏数据渲染成红色「下降」——
 * 与 `formatMetricDelta` 挡非有限值的理由**完全相同**，必须一起挡（#307 PR 内 sibling audit P1）。
 *
 * 上游 `repurchase.ts:422` 的 `round4(repurchaseRate - prevYearRate)` 不挡 NaN，
 * 只靠更上游 `rate()` 的 `entryCount > 0` 守卫兜着——与主修复同属「上游有护栏、本函数没有」的类别。
 */
export function formatPointDelta(value: number | null): { text: string; tone: MetricDeltaTone } {
  if (value === null) return { text: NO_LAST_YEAR_TEXT, tone: "default" }
  if (value === 0) return { text: "同比持平", tone: "default" }
  // 同样查最终渲染值而非入参：`value` 有限但 `value * 100` 可溢出（MAX_VALUE → Infinity）。
  // NaN 也走这条——`NaN === 0` 为 false，`NaN * 100` 仍是 NaN，一次检查两种都接住。
  const scaled = value * 100
  if (!Number.isFinite(scaled)) {
    warnNonFinite("formatPointDelta", { value, scaled })
    return { text: NO_LAST_YEAR_TEXT, tone: "default" }
  }
  return {
    text: `同比 ${scaled > 0 ? "+" : ""}${scaled.toFixed(1)}pct`,
    tone: scaled > 0 ? "positive" : "negative",
  }
}
