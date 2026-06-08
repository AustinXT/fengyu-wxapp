// SERVER ONLY — never import from client component, never expose via server action result.
//
// 拉卡拉入网费率配置加载（admin 侧）
//
// 设计约束（plan §0★ 费率全 admin 不可见）：
//   - admin 任何 UI / 表单 / Server Component 返回值 / Server Action 结果 / 日志 / diff
//     都不得出现费率字段；
//   - 录入与维护通过 PG `system_configs` 表（key 前缀 `lakala.rate.`）由用户本人 SQL 直连进行；
//   - 本文件仅暴露 `loadRateConfig()` 给 server action 内部使用（如 submitMerchant /
//     updateLakalaMerchantInfo 内部调用，注入到拉卡拉 client 的 payload 后立刻丢弃）；
//   - **禁止**任何 server action 把 `RateConfig` 类型作为返回值的一部分；
//   - **禁止**任何 client component 直接 import 本文件（client/server boundary 强约束）。
//
// 数据 schema（PG system_configs，key 列表）：
//   lakala.rate.entries        — JSON 数组 [{ feeRateTypeCode, feeRateTypeName, feeRatePct,
//                                            feeUpperAmtPcnt?, feeLowerAmtPcnt?, feeRateStDt? }, ...]
//
// 失败语义：行不存在 / JSON 不合法 / 数组为空 → throw 'INVALID_STATE: RATE_CONFIG_MISSING'。

import { db } from '@/db'
import { systemConfigs } from '@db/system-config'
import { inArray } from 'drizzle-orm'

/**
 * 单个费率条目（与拉卡拉 feeData 元素同义）
 */
export interface RateEntry {
  feeRateTypeCode: string
  feeRateTypeName: string
  feeRatePct: string // 字符串数字，e.g. '0.6'
  feeUpperAmtPcnt?: string // 单笔封顶，元
  feeLowerAmtPcnt?: string // 单笔保底，元
  feeRateStDt?: string // 生效日期 yyyy-MM-dd
}

/**
 * 拉卡拉入网费率配置（server-only 内部类型，禁止暴露到 client）
 */
export interface RateConfig {
  entries: RateEntry[]
}

const RATE_KEY = 'lakala.rate.entries'

/**
 * 从 PG `system_configs` 读取拉卡拉入网费率配置。
 *
 * **仅限 server-side 调用**，调用方必须确保返回值不流入任何 client component
 * 或 Server Action 的返回路径。返回的对象生命周期应尽量短（提交给 lakala client
 * 后立刻丢弃）。
 *
 * @throws 'INVALID_STATE: RATE_CONFIG_MISSING' — 配置不存在或格式错误
 */
export async function loadRateConfig(): Promise<RateConfig> {
  const rows = await db
    .select({ key: systemConfigs.key, value: systemConfigs.value })
    .from(systemConfigs)
    .where(inArray(systemConfigs.key, [RATE_KEY]))

  const raw = rows.find((r) => r.key === RATE_KEY)?.value
  if (!raw) {
    throw new Error('INVALID_STATE: RATE_CONFIG_MISSING')
  }

  let entries: RateEntry[]
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_STATE: RATE_CONFIG_MISSING')
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('INVALID_STATE: RATE_CONFIG_MISSING')
  }

  for (const e of entries) {
    if (
      typeof e.feeRateTypeCode !== 'string' ||
      typeof e.feeRateTypeName !== 'string' ||
      typeof e.feeRatePct !== 'string'
    ) {
      throw new Error('INVALID_STATE: RATE_CONFIG_MISSING')
    }
  }

  return { entries }
}
