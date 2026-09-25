import { ApiError } from '@/lib/api-error'

export interface PickupAmountSnapshot {
  /** 冻结的顾客实际单价（两位小数字符串，直接写 numeric 列） */
  unitPrice: string
  /** 出库金额 = 提货数 × 冻结单价 */
  amount: string
}

/**
 * #341：提货时冻结的出库金额 = 本次提货数 × 顾客实际单价（sale_items.unit_real_price）。
 *
 * - 口径（用户拍板）：部分支付也按 unit_real_price；寄存单 / 0 元赠品 / 转换转入一律同式，
 *   0 元行即记 0；套装只在销售明细级记一次（这里），不按库存组件拆。
 * - 调用方必须传**已加锁**的 sale_items 行上的单价，冻结的是提货那一刻的值。
 * - 按「分」算，避免浮点尾差；单价 0 是合法值，不能写成 `|| null`（会把 0 元行冻结成 NULL）。
 * - DB 有 chk_pickup_amount_frozen 兜底：金额 ≠ ROUND(单价 × 数量, 2) 的写入直接被拒。
 * - staffApi `routes/order.js` 有同名副本，cross-end-sql-snapshot 整段守护。
 */
export function pickupAmountSnapshot(unitRealPrice: unknown, pickupQuantity: number): PickupAmountSnapshot {
  const unitCents = Math.round(Number(unitRealPrice) * 100)
  const amountCents = unitCents * pickupQuantity
  if (unitRealPrice === null || unitRealPrice === undefined || unitRealPrice === '' || !Number.isFinite(unitCents) || !Number.isInteger(pickupQuantity) || pickupQuantity <= 0) {
    throw new ApiError('INVALID_STATE', '销售明细缺少顾客实际单价，无法计算出库金额')
  }
  return {
    unitPrice: (unitCents / 100).toFixed(2),
    amount: (amountCents / 100).toFixed(2),
  }
}
