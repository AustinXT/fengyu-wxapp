


export type PayMethod = '微信' | '支付宝' | '线下';

export interface ScanPayAmounts {
  totalAmount: number;
  couponDiscount: number;
  cardBalance: number;
  useCard: boolean;
  
  payableBase?: number;
}

export interface RecomputeResult {
  
  payable: number;
  
  prepaidCardAmount: number;
  
  paidAmount: number;
}


function round2(n: number): number {
  return Math.round(n * 100) / 100;
}


export function recomputeAmounts(input: ScanPayAmounts): RecomputeResult {
  const total = Number(input.totalAmount) || 0;
  const coupon = Number(input.couponDiscount) || 0;
  const balance = Number(input.cardBalance) || 0;

  
  const payable = input.payableBase != null
    ? round2(Math.max(0, Number(input.payableBase) || 0))
    : round2(Math.max(0, total - coupon));

  let prepaid = 0;
  if (input.useCard && balance > 0) {
    prepaid = round2(Math.min(balance, payable));
  }
  const paid = round2(Math.max(0, payable - prepaid));
  return { payable, prepaidCardAmount: prepaid, paidAmount: paid };
}

export type ConfirmRoute = 'confirmPrepaidFull' | 'wechatPay' | 'alipayPay' | 'offlinePay';


export function decideConfirmRoute(paidAmount: number, method: PayMethod): ConfirmRoute {
  if (paidAmount <= 0) return 'confirmPrepaidFull';
  if (method === '线下') return 'offlinePay';
  if (method === '支付宝') return 'alipayPay';
  return 'wechatPay';
}
