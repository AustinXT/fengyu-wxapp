/**
 * 充值卡档位配置加载 + matchTier 工具（admin 侧）
 *
 * 2026-05-20 充值卡剥离 SKU 化：档位与边界从 client/staff 代码硬编码同步迁到 system_configs。
 * 三端（admin / staff / client）行为通过同步读取相同的 system_configs 行保持一致。
 *
 * key:
 *   recharge.tiers     — JSON 数组 [{faceValue, payAmount}, ...]
 *   recharge.minAmount — 字符串数字，最低充值金额
 *   recharge.maxAmount — 字符串数字，单次上限
 */

import { db } from '@/db'
import { systemConfigs } from '@db/system-config'
import { inArray } from 'drizzle-orm'

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
 * 从 system_configs 读取充值档位配置
 *
 * @throws 'INVALID_STATE: ...' 配置缺失或格式错误
 */
export async function loadRechargeConfig(): Promise<RechargeConfig> {
  const rows = await db
    .select({ key: systemConfigs.key, value: systemConfigs.value })
    .from(systemConfigs)
    .where(inArray(systemConfigs.key, ['recharge.tiers', 'recharge.minAmount', 'recharge.maxAmount']))

  const cfg: Record<string, string> = {}
  for (const r of rows) cfg[r.key] = r.value
  if (!cfg['recharge.tiers'] || !cfg['recharge.minAmount'] || !cfg['recharge.maxAmount']) {
    throw new Error('INVALID_STATE: 系统未配置充值卡档位（system_configs.recharge.*）')
  }
  let tiers: RechargeTier[]
  try {
    tiers = JSON.parse(cfg['recharge.tiers'])
  } catch (e) {
    throw new Error('INVALID_STATE: recharge.tiers 配置格式错误（非合法 JSON）')
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('INVALID_STATE: recharge.tiers 必须为非空数组')
  }
  for (const t of tiers) {
    if (typeof t.faceValue !== 'number' || typeof t.payAmount !== 'number') {
      throw new Error('INVALID_STATE: recharge.tiers 条目缺少 faceValue/payAmount')
    }
  }
  tiers.sort((a, b) => a.faceValue - b.faceValue)
  const minAmount = Number(cfg['recharge.minAmount'])
  const maxAmount = Number(cfg['recharge.maxAmount'])
  if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount <= 0 || maxAmount < minAmount) {
    throw new Error('INVALID_STATE: recharge.minAmount/maxAmount 配置无效')
  }
  return { tiers, minAmount, maxAmount }
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
  if (Math.round(amount * 100) !== amount * 100) {
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
