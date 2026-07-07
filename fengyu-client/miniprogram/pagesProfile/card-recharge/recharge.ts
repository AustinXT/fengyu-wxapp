

export interface RechargeTier {
  faceValue: number;
  payAmount: number;
  discount: number;
}

export interface RechargeConfig {
  tiers: RechargeTier[];
  minAmount: number;
  maxAmount: number;
}

export interface MatchTierResult {
  discount: number;
  payAmount: number;
}


export function matchTier(amount: number, cfg: RechargeConfig): MatchTierResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误');
  }
  
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数');
  }
  if (amount < cfg.minAmount) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${cfg.minAmount}`);
  }
  if (amount > cfg.maxAmount) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${cfg.maxAmount}`);
  }
  const hit = cfg.tiers.find(t => t.faceValue === amount);
  if (hit) {
    const discount = amount > 0 ? Math.round((hit.payAmount / amount) * 100) / 100 : 1;
    return { discount, payAmount: hit.payAmount };
  }
  let baseTier = cfg.tiers[0];
  for (const t of cfg.tiers) {
    if (amount >= t.faceValue) baseTier = t;
  }
  const ratio = baseTier.payAmount / baseTier.faceValue;
  const payAmount = Math.round(amount * ratio * 100) / 100;
  const discount = Math.round(ratio * 100) / 100;
  return { discount, payAmount };
}


export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return r % 1 === 0 ? String(r) : r.toFixed(2);
}
