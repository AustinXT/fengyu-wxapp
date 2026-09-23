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
 * ## rate 分支为什么零基期与负基期都不挡（#314 决策 2）
 *
 * `type === "rate"` 走的是百分点差值（减法），没有除法，**不需要非零分母，也不会符号翻转**。
 * 所以两道基期守卫（`previous === 0` / `previous < 0`）都排在 rate 分支**之后**——
 * 它们是除法分支的必需品，对减法纯属拖累。
 *
 * #307 阶段 `previous === 0` 曾排在 rate 之前，导致「到店率 0% → 30%」被吞成「无基数」，
 * 而「30% → 0%」照常出 `-30.0pct`，**只藏涨、不藏跌**。#314 把守卫挪到了 rate 之后，涨跌恢复对称。
 *
 * ⚠️ **已知代价：2027-01-01 之前，同比 rate 徽章显示的是割点伪影，不是经营变化。**
 * `service_orders`（已完成）最早只到 **2026-07-08**，而新客入口日期走首单（`sale_orders` 回溯到 2022-08），
 * 分子分母不同源 → 2022–2025 共 1,352 个新客的到店数**恒为 0**。
 * 于是任何落在割点前的同比基期都是 0，改动后**集团级到店率同比会渲染出约 `+86.7pct` 的绿色徽章**
 * （2026 年 3,156/3,639 = 86.7%）。量化依据见 issue #314 评论 `issuecomment-5788019145`。
 *
 * 这是**知情选择**：拍板人读过该数据后仍取本方案，理由是割点属全站问题、已由 #289 立案跟踪，
 * 不该由单个徽章承担。别再拿这份数据回头推翻本实现——那是已经否决过一次的建议。
 *
 * ⚠️ **第二类零基期与割点无关，不随 2027-01-01 失效**（#314 双谱系评审，两谱系独立命中）：
 * `safeRate(n, d) = d > 0 ? round4(n/d) : 0`（`new-customer-funnel-utils.ts`）把
 * **「分母为 0，算不出」** 与 **「真实 0%」** 压成同一个 `0`。于是
 *   - 去年同期**一个新客都没有**的门店 × 月窄切片（分母 0），
 *   - `memberConversionRate` 的分母是 `arrivedCount`，**有新客但零到店**时同样为 0，
 * 都会渲染成绿色的 `+X pct`。这类切片**长期存在**，割点过去后也不会消失。
 * 真正的治本方案（`safeRate` 返回 `number | null`，三态区分「真实 0%」「算不出」「数据缺失伪影」）
 * 登记为未来选项，不在本轮范围——在**那之前**，同比 rate 徽章的绿色不可直接当经营结论用。
 *
 * ## 伪持平：舍入到 0 的一律并入「持平」（#314 决策 3）
 *
 * `toFixed(1)` 会把极小的真实变化舍成 `0.0`，旧实现仍带符号前缀，渲染出 `+0.0%` / `-0.0%`
 * ——「涨了、涨幅是 0」自相矛盾，比直接说「持平」更费解（`-0.0%` 不来自 `-0`，
 * 来自 `(-0.0002).toFixed(1)`）。money 类完全可达：50 万的基数差几百块就舍成 `0.0`。
 *
 * ⚠️ 代价是精度损失：500,100 vs 500,000（真实 +0.02%）与 500,000 vs 500,000（真实 0）
 * **显示成同一个词**。取舍在拍板时已知：带符号的 0 比「持平」更容易误导。
 *
 * ## 文案与配色必须同源
 *
 * tone 不自己重算方向，而是读 `computeDeltaPart` 返回的 `rendered`——**实际印在徽章上的那个数**。
 * 否则会出现「持平 + 绿色」（伪持平走 tone 的除法方向）或「+30.0pct + 灰色」（rate 零基期
 * 撞上 tone 的 `prevYear === 0` 弃判）这类自相矛盾的组合。**唯一的例外是负基期**，见下一节。
 *
 * ## 与 admin `src/lib/data-center/comparison.ts` 的差异（有意分叉，不是漏改）
 *
 * admin 侧（#283 / PR #305）负基期返回 `null` → 渲染 `--` → 徽章**灰色，弃判方向**。
 * 这里负基期返回文案「无基数」但 **tone 仍按 `current > prevYear` 判方向**（绿/红）。
 * 两站点指标集不重叠（admin 是门店业绩等，这里是新客漏斗），不会对同一现象给出相反结论；
 * 保留方向是刻意的——由负回正是真实的向好信息，不该跟着倍数一起丢。
 * 别为了「统一口径」把这里也改成 default。
 *
 * ⚠️ **tone 不读 `rendered` 的只有 `rendered === null` 那一族**（文案是「无基数」，没数字可跟，
 * 方向只能靠比大小补）。该族含三种来路，处置**故意不一致**：
 *   - 零基期（`count`/`money`）→ 弃判方向，灰
 *   - 负基期 → **保留方向**（本节主题）
 *   - 溢出（`delta * 100` 非有限）→ 也走比大小，所以 `formatMetricDelta(MAX_VALUE, 1, 1, "money")`
 *     会产出「无基数 + 绿色」。**不可达**（`previous` 来自 `round2`，最小非零 0.01，
 *     要触发得有 1e17 量级的当期值），既有行为，登记在此免得下次 review 又发现一遍。
 *
 * ⚠️ #314 决策 1 定了一套全站负基期展示矩阵（`base < 0 && cur > 0` → 「由负转正」🟢，
 * 否则 →「未转正」🔴），admin 侧由 PR #321 落地。**analyst 侧尚未落，不在 #314 本轮范围**
 * （#314 五条验收标准均未涉及）。要接入时改的是这一节，不是上面 rate 那节。
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
 * 变化量渲染成 0 时的文案。**真持平与伪持平共用它**（#314 决策 3）——
 * 后者是 `toFixed(1)` 把 `+0.02%` 舍成 `0.0` 的情形，旧实现会输出自相矛盾的 `+0.0%`。
 */
export const FLAT_TEXT = "持平"

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
/**
 * 一次渲染的完整结果。`rendered` 是**实际印在徽章上的那个数**（已按 `toFixed(1)` 舍入），
 * `null` 表示这次根本没渲染出数字（文案是 `NO_BASE_TEXT`）。
 *
 * tone 必须读它而不是自己重算方向——见文件头「文案与配色必须同源」。
 */
type DeltaRender = { text: string; rendered: number | null }

/**
 * 定点化 + 取回舍入后的真实数值，一处实现供两个导出函数共用。
 *
 * ⚠️ 判零必须看 `Number(fixed)` 而不是 `scaled`：`scaled = 0.02` 非零，但印出来是 `0.0`。
 * `Number("-0.0")` 得到 `-0`，而 `-0 === 0` 为 true，所以 `+0.0` 与 `-0.0` 一次都接住。
 */
function fixDelta(scaled: number): { fixed: string; rendered: number } {
  const fixed = scaled.toFixed(1)
  return { fixed, rendered: Number(fixed) }
}

function renderScaledDelta(
  fn: string,
  delta: number,
  suffix: "%" | "pct",
  context: Record<string, number>,
): DeltaRender {
  const scaled = delta * 100
  if (!Number.isFinite(scaled)) {
    warnNonFinite(fn, { ...context, delta })
    return { text: NO_BASE_TEXT, rendered: null }
  }
  const { fixed, rendered } = fixDelta(scaled)
  // 真持平（delta === 0）与伪持平（舍入到 0.0）在这里合流，共用「持平」。
  if (rendered === 0) return { text: FLAT_TEXT, rendered: 0 }
  return { text: `${rendered > 0 ? "+" : ""}${fixed}${suffix}`, rendered }
}

/** `formatDeltaPart` 的内部形态：多带一个 `rendered` 供 `formatMetricDelta` 判 tone。 */
function computeDeltaPart(current: number, previous: number, type: MetricDeltaType): DeltaRender {
  // NaN / ±Infinity 自己挡掉：`=== 0` 接不住 NaN，漏过去会渲染出 "NaN%" / "+Infinity%"。
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    warnNonFinite("formatDeltaPart", { current, previous })
    return { text: NO_BASE_TEXT, rendered: null }
  }
  // rate 走减法，两道基期守卫都不适用，必须排在它们**之前**（#314 决策 2）。
  if (type === "rate") {
    return renderScaledDelta("formatDeltaPart(rate)", current - previous, "pct", { current, previous })
  }
  if (previous === 0) return { text: NO_BASE_TEXT, rendered: null }
  // 见文件头「基期为什么必须 > 0」。此处 previous 已排除 0，只剩负数要挡。
  if (previous < 0) return { text: NO_BASE_TEXT, rendered: null }
  return renderScaledDelta("formatDeltaPart", (current - previous) / previous, "%", { current, previous })
}

export function formatDeltaPart(current: number, previous: number, type: MetricDeltaType): string {
  return computeDeltaPart(current, previous, type).text
}

/**
 * 符号 → 配色。**`0` 必须归 default**：既接住真持平与伪持平（`rendered === 0`），
 * 也接住负基期原地不动（`−1000 → −1000` 的差值为 0）——后者若漏掉，
 * `current > prevYear` 会取 false 而把「没变化」渲染成红色「下降」。
 * `-0 === 0` 为 true，负零一并接住。
 */
function toneFromSign(value: number): MetricDeltaTone {
  if (value === 0) return "default"
  return value > 0 ? "positive" : "negative"
}

export function formatMetricDelta(
  current: number,
  prevYear: number,
  prevPeriod: number,
  type: MetricDeltaType = "count",
): { text: string; tone: MetricDeltaTone } {
  const yoy = computeDeltaPart(current, prevYear, type)
  // ⚠️ tone 刻意**只看同比**：它的定义就是同比方向，环比脏了不该影响它。
  //    这是全文件唯一一处「守卫覆盖面不一致」，有测试钉住，别顺手"补齐"。
  const text = `同比 ${yoy.text} / 环比 ${formatDeltaPart(current, prevPeriod, type)}`
  // 挡的只有非有限值：`current > NaN` 恒 false，不挡会把脏数据渲染成红色「下降」。
  if (!Number.isFinite(current) || !Number.isFinite(prevYear)) return { text, tone: "default" }
  // 渲染出数字时，配色必须跟那个数同号——包括舍入到 0 的伪持平并入灰（#314 决策 3），
  // 以及 rate 零基期出数时跟着出方向（#314 决策 2；旧实现在这里撞 `prevYear === 0` 变灰）。
  if (yoy.rendered !== null) return { text, tone: toneFromSign(yoy.rendered) }
  // 文案是「无基数」，没有数字可跟，方向只能从差值补：
  // 零基期弃判（增幅无意义），负基期与溢出**保留方向**（见文件头）。
  if (prevYear === 0) return { text, tone: "default" }
  return { text, tone: toneFromSign(current - prevYear) }
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
/**
 * `formatPointDelta` 的**无前缀内核**，返回 `null` 表示渲染不出数字
 * （入参为 `null` / 非有限 / 乘 100 溢出），由调用方决定填什么占位文案。
 *
 * 之所以要把内核单独导出：`assistant-answer.ts` 的 AI 回答里曾有一份逐字重写的
 * `formatSignedRate`，吃的是**同一个** `repurchase.ts` 的 `kpi.delta`，却各自判零
 * ——同一个数值在看板出「持平」、在助手出 `+0.0pct`（#314 双谱系评审 P1）。
 * 那边的三个调用点外层已经自带「同比变化 」「同比 」前缀，套不了带前缀的
 * `formatPointDelta`（会出「同比变化 同比 +1.0pct」），所以分层而不是复制。
 *
 * ⚠️ **再有第四个消费方，也 import 这里，别再抄第三份。**
 */
export function formatPointDeltaValue(
  value: number | null,
): { text: string; tone: MetricDeltaTone } | null {
  if (value === null) return null
  // 同样查最终渲染值而非入参：`value` 有限但 `value * 100` 可溢出（MAX_VALUE → Infinity）。
  // NaN 也走这条——`NaN * 100` 仍是 NaN，一次检查两种都接住。
  const scaled = value * 100
  if (!Number.isFinite(scaled)) {
    warnNonFinite("formatPointDeltaValue", { value, scaled })
    return null
  }
  const { fixed, rendered } = fixDelta(scaled)
  // 与 `renderScaledDelta` 同源判零（#314 决策 3）。这里的伪持平**可达**：上游
  // `repurchase.ts` 的 `round4` 最小非零值 0.0001 → scaled 0.01 → 印出来就是 `0.0`。
  // 真持平（value === 0）也在这条合流，所以不再需要单独的 `value === 0` 早退。
  if (rendered === 0) return { text: FLAT_TEXT, tone: "default" }
  return {
    text: `${rendered > 0 ? "+" : ""}${fixed}pct`,
    tone: rendered > 0 ? "positive" : "negative",
  }
}

export function formatPointDelta(value: number | null): { text: string; tone: MetricDeltaTone } {
  const core = formatPointDeltaValue(value)
  if (core === null) return { text: NO_LAST_YEAR_TEXT, tone: "default" }
  // 「同比持平」不带空格（既有字面量，读起来是一个词），「同比 +5.0pct」要分隔。
  const text = core.text === FLAT_TEXT ? `同比${core.text}` : `同比 ${core.text}`
  return { text, tone: core.tone }
}
