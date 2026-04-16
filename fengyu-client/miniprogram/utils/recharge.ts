/**
 * 充值卡档位匹配 — 与 cloudfunctions/clientApi/routes/card.js 同源逻辑
 *
 * 后端是权威方：本前端函数仅用于实时展示（折扣、实付预览），
 * 实际生效的实付金额以 card.recharge 接口返回的 payAmount 为准。
 *
 * 档位（区间左闭右开）：
 *   500–999   → 9.9 折
 *   1000–4999 → 9.8 折
 *   ≥5000     → 9.5 折
 * 边界：min=500, max=100000, 小数位 ≤ 2
 */

export interface RechargeTier {
  faceValue: number;
  discount: number;
}

export const RECHARGE_TIERS: RechargeTier[] = [
  { faceValue: 500, discount: 0.99 },
  { faceValue: 1000, discount: 0.98 },
  { faceValue: 5000, discount: 0.95 },
];

export const RECHARGE_MIN_AMOUNT = 500;
export const RECHARGE_MAX_AMOUNT = 100000;

export interface MatchTierResult {
  discount: number;
  payAmount: number;
}

/**
 * 按充值面值匹配折扣并算出实付金额
 * @throws Error('INVALID_PARAMS: ...') 校验失败时抛错
 */
export function matchTier(amount: number): MatchTierResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误');
  }
  if (Math.round(amount * 100) !== amount * 100) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数');
  }
  if (amount < RECHARGE_MIN_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${RECHARGE_MIN_AMOUNT}`);
  }
  if (amount > RECHARGE_MAX_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${RECHARGE_MAX_AMOUNT}`);
  }

  let discount = RECHARGE_TIERS[0].discount;
  for (const tier of RECHARGE_TIERS) {
    if (amount >= tier.faceValue) discount = tier.discount;
  }

  const payAmount = Math.round(amount * discount * 100) / 100;
  return { discount, payAmount };
}

/** 格式化金额为 2 位小数字符串（去尾零） */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return r % 1 === 0 ? String(r) : r.toFixed(2);
}
