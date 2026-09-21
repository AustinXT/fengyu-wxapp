/**
 * WorkFine 历史订单（legacy_source='workfine'）展示口径的单一事实源。
 *
 * 历史单复用 DB 枚举值「无」，但业务语义是支付通道未知、现付不可信：
 * 统一翻译为 支付方式『未知』+ 现付『0.00』。列表/详情/导出各调用点一律
 * 经由本 helper，禁止散落内联判断（业务排除类判断见各调用处注释指向此处）。
 * 纯函数、无 Node-only 依赖，server 与 client 组件均可 import。
 */

type LegacySource = string | null | undefined

export function isWorkfineLegacy(legacySource: LegacySource): boolean {
  return legacySource === 'workfine'
}

export function paymentMethodDisplay(
  legacySource: LegacySource,
  fallback: string | null,
): string | null {
  return isWorkfineLegacy(legacySource) ? '未知' : fallback
}

export function cashAmountDisplay(legacySource: LegacySource, fallback: string): string {
  return isWorkfineLegacy(legacySource) ? '0.00' : fallback
}
