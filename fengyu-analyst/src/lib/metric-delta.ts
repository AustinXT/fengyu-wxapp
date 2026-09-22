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
 * ⚠️ 本站当前数据通路上 `previous < 0` **暂时不可达**，靠三道互不知情的护栏：
 *   ① 生产 `sale_orders` 无负净额行（数据事实，会变）；
 *   ② `new-customer-funnel.ts` 的 SQL 逐行 `GREATEST(received - refunded_amount, 0)` 夹底；
 *   ③ `normalizeNumber` 把非有限值归 0、`safeRate`/`safeAverage` 分母 ≤ 0 时返 0。
 * 护栏 ② 的口径可议（它把退款藏进 0 里），一旦有人认为那是 bug 而移除，符号翻转当场出现。
 * 所以这里的守卫是承重的，不是冗余——别因为「跑不出负数」把它删掉。
 *
 * ## rate 分支为什么不挡负基期
 *
 * `type === "rate"` 走的是百分点差值（减法），没有除法，不存在符号翻转。
 * 到店率/会员转化率这类指标本身也可能为 0，`0 pct → x pct` 是有意义的表述。
 * 但 `previous === 0` 仍统一返回「无基数」——那是改动前就有的行为，此次不动（#307 AC3）。
 */

export type MetricDeltaType = "count" | "rate" | "money"

export type MetricDeltaTone = "default" | "positive" | "negative"

/** 基期不可用时的统一文案。负基期复用它，不新增文案串（#307 AC1 已预授权）。 */
export const NO_BASE_TEXT = "无基数"

export function formatDeltaPart(current: number, previous: number, type: MetricDeltaType): string {
  // NaN / ±Infinity 自己挡掉：`=== 0` 接不住 NaN，漏过去会渲染出 "NaN%" / "+Infinity%"。
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return NO_BASE_TEXT
  if (previous === 0) return NO_BASE_TEXT
  if (type === "rate") {
    const delta = current - previous
    if (delta === 0) return "持平"
    return `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}pct`
  }
  // 见文件头「基期为什么必须 > 0」。此处 previous 已排除 0，只剩负数要挡。
  if (previous < 0) return NO_BASE_TEXT
  const delta = (current - previous) / previous
  if (delta === 0) return "持平"
  return `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`
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
  // 挡的只有非有限值：`current > NaN` 恒 false，不挡会把脏数据渲染成红色「下降」。
  if (!Number.isFinite(current) || !Number.isFinite(prevYear)) return { text, tone: "default" }
  if (prevYear === 0 || current === prevYear) return { text, tone: "default" }
  return { text, tone: current > prevYear ? "positive" : "negative" }
}
