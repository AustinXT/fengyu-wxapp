// pagesOrder/scan-pay/scan-pay.logic.ts
// 扫码付页面纯逻辑（便于单测，不依赖小程序运行时）

export type PayMethod = '微信' | '支付宝' | '线下';

export interface ScanPayAmounts {
  totalAmount: number;
  couponDiscount: number;
  cardBalance: number;
  useCard: boolean;
}

export interface RecomputeResult {
  /** 应抵扣部分（券后金额，为分配给储值卡 + 实付通道的总额） */
  payable: number;
  /** 储值卡抵扣金额 */
  prepaidCardAmount: number;
  /** 实付通道金额 */
  paidAmount: number;
}

/** 货币 round 到 2 位小数（避免 0.1 + 0.2 浮点误差） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 重算抵扣方案
 * 应抵部分 = totalAmount - couponDiscount
 * prepaid = useCard ? min(balance, payable) : 0
 * paid = payable - prepaid
 */
export function recomputeAmounts(input: ScanPayAmounts): RecomputeResult {
  const total = Number(input.totalAmount) || 0;
  const coupon = Number(input.couponDiscount) || 0;
  const balance = Number(input.cardBalance) || 0;

  const payable = round2(Math.max(0, total - coupon));

  let prepaid = 0;
  if (input.useCard && balance > 0) {
    prepaid = round2(Math.min(balance, payable));
  }
  const paid = round2(Math.max(0, payable - prepaid));
  return { payable, prepaidCardAmount: prepaid, paidAmount: paid };
}

export type ConfirmRoute = 'confirmPrepaidFull' | 'wechatPay' | 'offlinePay';

/**
 * 决策"确认支付"按钮的下游路径
 * paid=0  → confirmPrepaidFull（同事务扣卡 + 置已支付）
 * paid>0 + 微信 → wechatPay
 * paid>0 + 线下 → offlinePay
 */
export function decideConfirmRoute(paidAmount: number, method: PayMethod): ConfirmRoute {
  if (paidAmount <= 0) return 'confirmPrepaidFull';
  if (method === '线下') return 'offlinePay';
  return 'wechatPay';
}
