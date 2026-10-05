/** 门店报货数量：numeric(12,2) 可存的非负整数，前后端共用。 */
export const STORE_REQUEST_QUANTITY_MAX = 9999999999
export const STORE_REQUEST_QUANTITY_ERROR = '报货数量须为 0 至 9999999999 的非负整数'
export const STORE_REQUEST_EMPTY_ERROR = '门店报货至少需要一条数量大于 0 的明细'

export function validNonnegativeStoreRequestQuantity(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  if (typeof value === 'string' && value.trim() === '') return false
  const quantity = Number(value)
  return Number.isInteger(quantity) && quantity >= 0 && quantity <= STORE_REQUEST_QUANTITY_MAX
}
