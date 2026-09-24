import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InventoryDocType } from './types'
import {
  STOCKTAKE_DOC_TYPES,
  isStocktakeDocType,
  stocktakeDiff,
  stocktakeSummary,
  tallyStocktake,
} from './stocktake'

describe('盘点差异派生（#131 Q2：前端算、不落库）', () => {
  it('差异 = 实盘 − 账面', () => {
    expect(stocktakeDiff({ quantity: 9, stockSnapshot: 12 })).toBe(-3)
    expect(stocktakeDiff({ quantity: 15, stockSnapshot: 12 })).toBe(3)
    expect(stocktakeDiff({ quantity: 12, stockSnapshot: 12 })).toBe(0)
  })

  it('账面为 0 是真实账面数，不是「没记」—— 差异按盘盈算', () => {
    // COALESCE(SUM(...),0) 保证一个批次都没有时写 0 而不是 NULL。
    // 若这里把 0 当缺失，「账上没有、货架上有 5 件」这种最典型的盘盈会被吞成「—」。
    expect(stocktakeDiff({ quantity: 5, stockSnapshot: 0 })).toBe(5)
  })

  it('账面为 null（修复前的历史盘点单）返回 null，不当 0 算', () => {
    // 当 0 算的话整张历史单会显示成「全额盘盈」，比留空更误导。
    expect(stocktakeDiff({ quantity: 9, stockSnapshot: null })).toBeNull()
  })

  it('两位小数相减不外泄浮点毛刺', () => {
    // ⚠️ 取值要挑**会暴露问题**的：7.5 − 2.5 = 5 恰好干净，测不出这一类。
    // 下面三组不收口的话页面会直接渲染 +3.0999999999999996 / +0.19999999999999998 /
    // +0.009999999999999953。numeric(12,2) 的两位小数相减在 IEEE754 下必然出长尾。
    expect(stocktakeDiff({ quantity: 4.6, stockSnapshot: 1.5 })).toBe(3.1)
    expect(stocktakeDiff({ quantity: 0.3, stockSnapshot: 0.1 })).toBe(0.2)
    expect(stocktakeDiff({ quantity: 0.29, stockSnapshot: 0.28 })).toBe(0.01)
    expect(stocktakeDiff({ quantity: 1.1, stockSnapshot: 1 })).toBe(0.1)
  })

  it('相等的小数判为相符，不因浮点误判成盘盈/盘亏', () => {
    expect(stocktakeDiff({ quantity: 12.34, stockSnapshot: 12.34 })).toBe(0)
    expect(tallyStocktake([{ quantity: 12.34, stockSnapshot: 12.34 }]).matched).toBe(1)
  })
})

describe('盘点单头结论', () => {
  it('分别统计盘盈 / 盘亏 / 相符', () => {
    expect(tallyStocktake([
      { quantity: 15, stockSnapshot: 12 },
      { quantity: 9, stockSnapshot: 12 },
      { quantity: 12, stockSnapshot: 12 },
      { quantity: 1, stockSnapshot: 12 },
    ])).toEqual({ surplus: 1, shortage: 2, matched: 1, unknown: 0 })
  })

  it('全部相符时也给出结论，而不是空字符串', () => {
    expect(stocktakeSummary([{ quantity: 12, stockSnapshot: 12 }]))
      .toBe('盘盈 0 项 / 盘亏 0 项 / 相符 1 项')
  })

  it('没有明细时不炸，给出全零结论', () => {
    expect(stocktakeSummary([])).toBe('盘盈 0 项 / 盘亏 0 项 / 相符 0 项')
  })

  it('历史单的「未记账面」单列，否则三项之和与行数对不上', () => {
    expect(stocktakeSummary([
      { quantity: 15, stockSnapshot: 12 },
      { quantity: 9, stockSnapshot: null },
      { quantity: 9, stockSnapshot: null },
    ])).toBe('盘盈 1 项 / 盘亏 0 项 / 相符 0 项 / 未记账面 2 项')
  })

  it('没有历史行时不显示「未记账面」，避免多一项噪音', () => {
    expect(stocktakeSummary([{ quantity: 9, stockSnapshot: 12 }]))
      .not.toContain('未记账面')
  })
})

describe('盘点类型清单是 engine 与详情页的单源', () => {
  it('只含两种盘点单', () => {
    expect([...STOCKTAKE_DOC_TYPES]).toEqual(['市场库存盘点', '分院库存盘点'])
    expect(isStocktakeDocType('市场库存盘点')).toBe(true)
    expect(isStocktakeDocType('分院库存盘点')).toBe(true)
  })

  it('不把「报损 / 盘溢」这类真动库存的单据算进来', () => {
    // 它们在 engine 里是 OUTBOUND / INBOUND，会产生 inventory_movements。
    // 一旦被误判成盘点，详情页会给它们渲染账面/差异三列（全空），
    // 建单侧还会多跑一次在手量聚合。
    const others: InventoryDocType[] = [
      '市场产品报损', '院产品报损', '市场产品盘溢', '期初库存', '内部领用',
    ]
    for (const t of others) {
      expect(isStocktakeDocType(t), `${t} 不是盘点单`).toBe(false)
    }
  })

  it('详情页确实用的是这份清单，没有自己再写一遍字面量', () => {
    const page = readFileSync(
      resolve(process.cwd(), 'src/app/(main)/(inventory)/inventory/docs/[id]/page.tsx'),
      'utf8',
    )
    expect(page).toMatch(/isStocktakeDocType\(doc\.docType\)/)
    expect(page).not.toMatch(/doc\.docType === '市场库存盘点'/)
  })
})
