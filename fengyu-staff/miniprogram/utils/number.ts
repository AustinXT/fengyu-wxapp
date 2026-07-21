// utils/number.ts — 数字展示格式化
//
// 统一长格式千分位规则（管理层数据中心 ticket 5）：
//   - 金额：保留 2 位小数 + 千分位（不再折叠为"万"）
//   - 计数：整数 + 千分位（不再折叠为"万"）
//   - 占比：保留 2 位 + %
//   - 缺失（null/undefined/NaN/Infinity）：返回 '--'
//
// ⚠ 不使用 Number.toLocaleString：微信小程序 iOS(JavaScriptCore)/部分 Android(XWeb)
//   运行时 ICU 数据精简，toLocaleString 的 locale 与 options（minimumFractionDigits 等）
//   会被忽略、退化为 toString —— 表现为无千分位逗号、小数位不固定（实测管理层看板人效
//   数据暴露 44.98717948717949、月店均尾零丢失如 3937.4、大额金额无千分位）。改用
//   toFixed（纯数学不依赖 ICU，截图里占比 37.46% 正常即证明本机 toFixed 可靠）+ 正则
//   手动千分位，跨 iOS/Android/开发者工具结果一致。

function isInvalid(value: number | null | undefined): boolean {
  return value == null || !Number.isFinite(value)
}

/** 整数部分插千分位逗号；符号与小数部分原样保留 */
function withGrouping(raw: string): string {
  const negative = raw.startsWith('-')
  const sign = negative ? '-' : ''
  const body = negative ? raw.slice(1) : raw
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot)
  return sign + intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fracPart
}

/** 金额格式化：千分位 + 2 位小数 */
export function formatAmount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  // 先 Math.round(+EPSILON)*100/100 预舍入，规避 toFixed 的 IEEE754 边界（如 1.005→"1.00"）
  const rounded = Math.round(((value as number) + Number.EPSILON) * 100) / 100
  return withGrouping(rounded.toFixed(2))
}

/** 计数格式化：整数 + 千分位 */
export function formatCount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return withGrouping(String(Math.round(value as number)))
}

/** 占比格式化：保留 2 位 + %（输入为 0-1 小数） */
export function formatPercent(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return ((value as number) * 100).toFixed(2) + '%'
}
