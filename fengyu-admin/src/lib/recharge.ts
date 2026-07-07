

import { db } from '@/db'
import { systemConfigs } from '@db/system-config'
import { inArray } from 'drizzle-orm'
import { matchTier, type RechargeTier, type RechargeConfig } from './recharge-tier'



export { matchTier }
export type { RechargeTier, RechargeConfig }


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
