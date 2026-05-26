/**
 * checkout 页面 — 储值卡抵扣相关纯函数
 *
 * 后端 (clientApi.order.create / scanAdjust) 是权威方：
 * 此处仅做前端预览/UI 联动用。最终生效以接口返回的 paid_amount / prepaid_card_amount 为准。
 *
 * 规则参见 ticket §2.1：
 *  - 余额 = 0 → 开关禁用，prepaid = 0
 *  - 余额 ≥ 应抵扣部分 (totalAmount - couponDiscount) → 默认开，prepaid = 应抵扣，paid = 0
 *  - 余额 < 应抵扣部分 → 默认开，prepaid = 余额，paid = diff
 *  - 用户手动关闭 useCard → prepaid = 0, paid = 应抵扣
 */

export interface RecomputeInput {
  totalAmount: number;     // 商品合计（未扣券）
  couponDiscount: number;  // 优惠券抵扣
  cardBalance: number;     // 储值卡余额
  useCard: boolean;        // 用户开关
}

export interface RecomputeResult {
  prepaidCardAmount: number;   // 储值卡抵扣金额（不计入实付）
  paidAmount: number;          // 实付金额（走支付通道）
  showPayMethodGroup: boolean; // 是否显示支付方式按钮组
  netBeforeCard: number;       // 应抵扣部分 = totalAmount - couponDiscount，便于 UI 复用
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 根据订单总额、优惠券、储值卡余额和开关状态计算抵扣明细
 */
export function recomputeAmounts(input: RecomputeInput): RecomputeResult {
  const total = Number(input.totalAmount) || 0;
  const coupon = Number(input.couponDiscount) || 0;
  const balance = Math.max(0, Number(input.cardBalance) || 0);

  // 应抵扣部分（券后金额，最低 0，避免负数）
  const netBeforeCard = round2(Math.max(0, total - coupon));

  // 余额 = 0 → useCard 被强制视为 false
  const effectiveUseCard = input.useCard && balance > 0 && netBeforeCard > 0;

  const prepaidCardAmount = effectiveUseCard
    ? round2(Math.min(balance, netBeforeCard))
    : 0;
  const paidAmount = round2(netBeforeCard - prepaidCardAmount);

  return {
    prepaidCardAmount,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
    netBeforeCard,
  };
}
