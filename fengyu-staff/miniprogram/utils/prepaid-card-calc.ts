// utils/prepaid-card-calc.ts — 储值卡抵扣金额计算
// 与 ticket §2.2 + §2.1 一致：抵扣额 = min(余额, 应抵部分)；应抵部分 = 总额 - 优惠券折扣
// 与顾客端 checkout 的算法保持口径一致

export interface PrepaidComputeInput {
  /** 订单总额（已计入行级 discount/customPrice 的合计；元） */
  totalAmount: number
  /** 顾客优惠券折扣（元，0 表示无券） */
  couponDiscount: number
  /** 顾客储值卡余额（元，0 表示无卡或无余额） */
  customerCardBalance: number
  /** 用户/店长是否预选使用储值卡 */
  useCard: boolean
}

export interface PrepaidComputeResult {
  /** 储值卡抵扣额（不计入实付，元，2 位精度） */
  prepaidCardAmount: number
  /** 实付金额（走支付通道的钱，元，2 位精度） */
  paidAmount: number
  /** 是否需要展示支付方式按钮组（仅 paidAmount > 0 时展示） */
  showPayMethodGroup: boolean
}

/**
 * 与店长端 / 顾客端结算口径一致的金额计算
 * - useCard=false 或余额 <= 0 → prepaid=0、paid=total - coupon
 * - useCard=true → prepaid = min(balance, total - coupon)、paid = total - coupon - prepaid
 * - paid===0 时 showPayMethodGroup=false（界面隐藏支付方式按钮组）
 *
 * 浮点数防御：所有结果保留 2 位小数（与 numeric(10,2) 列对齐）
 */
export function computePrepaidDeduction(input: PrepaidComputeInput): PrepaidComputeResult {
  const total = Math.max(0, Number(input.totalAmount) || 0)
  const coupon = Math.max(0, Number(input.couponDiscount) || 0)
  const balance = Math.max(0, Number(input.customerCardBalance) || 0)

  const netBeforeCard = Math.max(0, round2(total - coupon))
  const prepaidRaw =
    input.useCard && balance > 0 ? Math.min(balance, netBeforeCard) : 0
  const prepaidCardAmount = round2(prepaidRaw)
  const paidAmount = round2(Math.max(0, netBeforeCard - prepaidCardAmount))

  return {
    prepaidCardAmount,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
