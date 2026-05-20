/**
 * 充值卡档位类型 + matchTier 纯计算（无 DB 依赖，可在客户端组件导入）
 *
 * 2026-05-21 充值入口收敛到开单页：开单页 RechargePicker（'use client'）需要 matchTier，
 * 而 @/lib/recharge.ts 顶层 import { db } 会把 postgres 驱动拖进客户端 bundle，故把纯逻辑
 * 拆到本模块。server 侧的 loadRechargeConfig 仍在 @/lib/recharge.ts，并从这里 re-export 类型/matchTier。
 */

export interface RechargeTier {
  faceValue: number
  payAmount: number
}

export interface RechargeConfig {
  tiers: RechargeTier[]
  minAmount: number
  maxAmount: number
}

/**
 * 按面值匹配档位实付（精确命中或按最大 ≤ amount 的档位折扣比换算）
 *
 * @throws Error 前缀 INVALID_PARAMS
 */
export function matchTier(amount: number, cfg: RechargeConfig): { discount: number; payAmount: number } {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  // 浮点容差：39.8 * 100 在 JS 里不是精确的 3980，严格 !== 会误判
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数')
  }
  if (amount < cfg.minAmount) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${cfg.minAmount}`)
  }
  if (amount > cfg.maxAmount) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${cfg.maxAmount}`)
  }
  const hit = cfg.tiers.find(t => t.faceValue === amount)
  if (hit) {
    const discount = amount > 0 ? Math.round((hit.payAmount / amount) * 100) / 100 : 1
    return { discount, payAmount: hit.payAmount }
  }
  let baseTier = cfg.tiers[0]
  for (const t of cfg.tiers) {
    if (amount >= t.faceValue) baseTier = t
  }
  const ratio = baseTier.payAmount / baseTier.faceValue
  const payAmount = Math.round(amount * ratio * 100) / 100
  const discount = Math.round(ratio * 100) / 100
  return { discount, payAmount }
}
