// utils/prepaid-card-calc.ts — 充值卡抵扣金额计算（UI 文案统一为「充值卡」；DB 字段 prepaid_card_amount 保持不变）
// 与 ticket §2.2 + §2.1 一致：抵扣额 = min(余额, 应抵部分)
// 与顾客端 checkout 的算法保持口径一致

export interface PrepaidComputeInput {
  /** 订单应付合计（= Σ行应付金额 = Σ价格 - 优惠券折扣；元） */
  payableAmount: number
  /** 顾客充值卡余额（元，0 表示无卡或无余额） */
  customerCardBalance: number
  /** 用户/店长是否预选使用充值卡 */
  useCard: boolean
  /** 店长手填的充值卡抵扣金额；未传时按 0 处理 */
  prepaidCardAmount?: number | string
}

export interface PrepaidComputeResult {
  /** 当前场景最多可抵扣金额（= min(应付, 余额)，元，2 位精度） */
  maxPrepaidCardAmount: number
  /** 充值卡抵扣额（不计入实付，元，2 位精度） */
  prepaidCardAmount: number
  /** 走支付通道的金额（应付 - 充值卡抵扣，元，2 位精度；仅展示，最终实付以行 received 之和为准） */
  paidAmount: number
  /** 是否需要展示支付方式按钮组（仅 paidAmount > 0 时展示） */
  showPayMethodGroup: boolean
}

/**
 * 与店长端 / 顾客端结算口径一致的金额计算
 * - useCard=false 或余额 <= 0 → prepaid=0、paid=payable
 * - useCard=true → prepaid = min(手填金额, balance, payable)、paid = payable - prepaid
 * - 未填写手填金额时按 0 处理，不再自动抵满
 * - paid===0 时 showPayMethodGroup=false（界面隐藏支付方式按钮组）
 *
 * 浮点数防御：所有结果保留 2 位小数（与 numeric(10,2) 列对齐）
 */
export function computePrepaidDeduction(input: PrepaidComputeInput): PrepaidComputeResult {
  const payable = Math.max(0, Number(input.payableAmount) || 0)
  const balance = Math.max(0, Number(input.customerCardBalance) || 0)
  const maxPrepaidCardAmount = round2(Math.min(balance, payable))
  const requested = Number(input.prepaidCardAmount)
  const requestedAmount = Number.isFinite(requested) ? Math.max(0, requested) : 0

  const prepaidRaw =
    input.useCard ? Math.min(requestedAmount, maxPrepaidCardAmount) : 0
  const prepaidCardAmount = round2(prepaidRaw)
  const paidAmount = round2(Math.max(0, payable - prepaidCardAmount))

  return {
    maxPrepaidCardAmount,
    prepaidCardAmount,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
