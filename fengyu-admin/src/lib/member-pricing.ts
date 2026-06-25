/** 会员价分流 helper —— 与 client/staff cloudfunctions/utils/member-pricing.js 同口径。仅会员享会员价（体验卡同口径，#6=B 不再豁免）。 */
export function isMember(customerType?: string | null, memberLevel?: string | null): boolean {
  return customerType === '会员客' || (memberLevel != null && memberLevel !== '')
}
export function resolveUnitPrice(
  sku: { price: number | string; specialPrice?: number | string | null; isExperience?: boolean | null },
  member: boolean,
): { listUnit: number; realUnit: number } {
  const listUnit = Number(sku.price) || 0
  const special = sku.specialPrice == null || sku.specialPrice === '' ? null : Number(sku.specialPrice)
  // 会员价分流（#6=B：体验卡不再豁免，与普通单品同口径）
  const eligible = member === true
  const realUnit = eligible && special !== null && special < listUnit ? special : listUnit
  return { listUnit, realUnit }
}
