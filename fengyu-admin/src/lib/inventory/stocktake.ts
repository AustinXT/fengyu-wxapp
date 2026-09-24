import type { InventoryDocType } from './types'

/**
 * 盘点单：只记录「账面 vs 实盘」，**不产生任何 `inventory_movements`、不改 `quantity_on_hand`**
 * （`movementPlan` 对它们返回 null —— 这两个类型刻意不出现在 INBOUND/OUTBOUND/NO_MOVEMENT/
 * RECEIVE_REQUIRED 任何一个集合里，靠兜底的 `return null` 落到「不产流水」）。
 *
 * 放在这里而不是 `engine.ts`，是因为**写账面数的地方（engine）和渲染三列的地方（详情页）
 * 必须用同一份类型清单**：任一侧漏改就会出现「写了账面数却不显示」或「显示了三列却全是空」。
 */
export const STOCKTAKE_DOC_TYPES = new Set<InventoryDocType>(['市场库存盘点', '分院库存盘点'])

export function isStocktakeDocType(docType: InventoryDocType): boolean {
  return STOCKTAKE_DOC_TYPES.has(docType)
}

export type StocktakeItem = { quantity: number; stockSnapshot: number | null }

/**
 * 盘点差异 = 实盘 − 账面。**纯派生值，不落库**——落库就多出第三个会漂的数（issue #131 Q2）。
 *
 * 账面数为 null（修复前建的历史盘点单：`stock_snapshot` 恒 NULL）时返回 null，展示为「—」。
 * 不要当成 0 去算差异，否则整张历史单会显示成「全额盘盈」。
 */
export function stocktakeDiff(item: StocktakeItem): number | null {
  if (item.stockSnapshot === null) return null
  // 两者都是 numeric(12,2)，但 JS 直减会出浮点毛刺（账面 0.1 / 实盘 0.3 → 0.19999999999999998
  // 会被原样渲染成 `+0.19999999999999998`）。仓内其余算术一律走 toFixed(2)，这里对齐。
  return Number((item.quantity - item.stockSnapshot).toFixed(2))
}

export type StocktakeTally = {
  surplus: number
  shortage: number
  matched: number
  unknown: number
}

export function tallyStocktake(items: readonly StocktakeItem[]): StocktakeTally {
  const tally: StocktakeTally = { surplus: 0, shortage: 0, matched: 0, unknown: 0 }
  for (const item of items) {
    const diff = stocktakeDiff(item)
    if (diff === null) tally.unknown += 1
    else if (diff > 0) tally.surplus += 1
    else if (diff < 0) tally.shortage += 1
    else tally.matched += 1
  }
  return tally
}

/**
 * 单头的盘点结论，免得逐行扫表才知道这张单盘出了什么。
 *
 * 「未记账面」只在 > 0 时出现——它专指历史盘点单；不单列的话
 * 盘盈 + 盘亏 + 相符 与明细行数对不上，看着像算错了。
 */
export function stocktakeSummary(items: readonly StocktakeItem[]): string {
  const { surplus, shortage, matched, unknown } = tallyStocktake(items)
  const parts = [`盘盈 ${surplus} 项`, `盘亏 ${shortage} 项`, `相符 ${matched} 项`]
  if (unknown > 0) parts.push(`未记账面 ${unknown} 项`)
  return parts.join(' / ')
}
