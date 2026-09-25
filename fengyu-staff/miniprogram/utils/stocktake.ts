// utils/stocktake.ts — 门店盘点（#352）：实盘数校验 + 账面 / 实盘 / 差异派生
//
// 差异口径（#131 Q2）：差异 = 实盘 − 账面，纯派生、不落库。
// ⚠️ stocktakeDiff / tallyStocktake / stocktakeSummary 三个函数体与 admin
// `fengyu-admin/src/lib/inventory/stocktake.ts` 同名函数**逐字一致**（四端禁共享目录，各留副本），
// 由 `__tests__/utils/stocktake-cross-end.test.ts` 整段比对；改一端必须同步另一端。

/** 与 staffApi / admin 的 STOCKTAKE_DOC_TYPES 同集合；staff 端可见、可建的只有「分院库存盘点」 */
const STOCKTAKE_DOC_TYPES = ['市场库存盘点', '分院库存盘点']

export function isStocktakeDocType(docType: string): boolean {
  return STOCKTAKE_DOC_TYPES.indexOf(docType) >= 0
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

export type StocktakeDiffKey = 'surplus' | 'shortage' | 'matched' | 'unknown'

/** WXML 不能调函数：把差异预先格式化成展示文本 + 样式键（盘盈带「+」，历史单无账面显示「—」） */
export function stocktakeDiffDisplay(item: StocktakeItem): { diffText: string; diffKey: StocktakeDiffKey } {
  const diff = stocktakeDiff(item)
  if (diff === null) return { diffText: '—', diffKey: 'unknown' }
  if (diff > 0) return { diffText: `+${diff}`, diffKey: 'surplus' }
  if (diff < 0) return { diffText: String(diff), diffKey: 'shortage' }
  return { diffText: '0', diffKey: 'matched' }
}

/**
 * 实盘数输入校验，与 staffApi `isValidDocItemQuantity` 对盘点类型的判定同口径（#351）：
 * 必须填写（空串不是 0）、0 或正数、最多两位小数、不超过 numeric(12,2) 上限。
 * 前端先拦只为给出就地提示，服务端仍会再校验一次。
 */
export function isValidStocktakeQuantity(input: string): boolean {
  if (typeof input !== 'string' || input.trim() === '') return false
  const n = Number(input)
  if (!Number.isFinite(n) || n > 9999999999.99 || Number(n.toFixed(2)) !== n) return false
  return n >= 0
}
