/**
 * 充值卡档位匹配 — 与 cloudfunctions/clientApi/routes/card.js 同源逻辑
 *
 * 后端是权威方：本前端函数仅用于实时展示（折扣、实付预览），
 * 实际生效的实付金额以 card.recharge 接口返回的 payAmount 为准。
 *
 * 2026-05-21 三端统一：档位/边界从 system_configs 经 API 注入，前端不再硬编码 RECHARGE_TIERS。
 * 算法与 staff/admin/backend `matchTier` 字节同义。
 */

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

/**
 * 按充值面值匹配折扣并算出实付金额
 *
 * 精确命中 → 取 tier.payAmount；非命中 → 找最大 faceValue ≤ amount 的档位，按 payAmount/faceValue 比例算
 *
 * @throws Error('INVALID_PARAMS: ...') 校验失败时抛错
 */
export function matchTier(amount: number, cfg: RechargeConfig): MatchTierResult {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误');
  }
  // 浮点容差：39.8 * 100 在 JS 里不是精确的 3980，严格 !== 会误判
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

/** 格式化金额为 2 位小数字符串（去尾零） */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return r % 1 === 0 ? String(r) : r.toFixed(2);
}
