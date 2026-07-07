
export function isMember(customerType?: string | null, memberLevel?: string | null): boolean {
  return customerType === '会员客' || (memberLevel != null && memberLevel !== '')
}
export function resolveUnitPrice(
  sku: { price: number | string; specialPrice?: number | string | null; isExperience?: boolean | null },
  member: boolean,
): { listUnit: number; realUnit: number } {
  const listUnit = Number(sku.price) || 0
  const special = sku.specialPrice == null || sku.specialPrice === '' ? null : Number(sku.specialPrice)
  
  const eligible = member === true
  const realUnit = eligible && special !== null && special < listUnit ? special : listUnit
  return { listUnit, realUnit }
}
