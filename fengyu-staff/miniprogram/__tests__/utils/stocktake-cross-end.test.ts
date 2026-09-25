/**
 * staff 前端盘点差异 ↔ admin `lib/inventory/stocktake.ts` 一致性守护（#352）
 *
 * 验收要求「小程序详情的差异与 admin 单据详情一致」。两端是独立副本（四端禁共享目录），
 * 这里两道守护：
 *   ① 三个函数**整段**函数体比对（归一化空白/注释后）—— 任一侧改了实现即红
 *   ② 同一组 fixture 的行为断言 —— 兜住正则抠错位置导致的假绿
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  isValidStocktakeQuantity,
  stocktakeDiff,
  stocktakeDiffDisplay,
  stocktakeSummary,
  tallyStocktake,
} from '../../utils/stocktake'

const ADMIN_PATH = path.resolve(__dirname, '../../../../fengyu-admin/src/lib/inventory/stocktake.ts')
const STAFF_PATH = path.resolve(__dirname, '../../utils/stocktake.ts')

/** 抠出 `export function <name>(...)` 到下一个顶格 `}` 的整段（含签名），去注释、压空白 */
function normalizedFunction(filePath: string, name: string): string {
  const src = fs.readFileSync(filePath, 'utf8')
  const m = src.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`))
  if (!m) throw new Error(`没在 ${filePath} 里找到 ${name}`)
  return m[0]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('staff 盘点差异与 admin 字面一致', () => {
  test.each(['stocktakeDiff', 'tallyStocktake', 'stocktakeSummary'])('%s 整段逐字一致', (name) => {
    const admin = normalizedFunction(ADMIN_PATH, name)
    expect(normalizedFunction(STAFF_PATH, name)).toBe(admin)
    // 防呆：抠到空壳会让上面的断言假绿
    expect(admin.length).toBeGreaterThan(100)
  })

  test('StocktakeItem / StocktakeTally 类型形状一致', () => {
    const shape = (file: string, typeName: string) => {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`export type ${typeName} = ([^\\n]*\\{[\\s\\S]*?\\})`))
      if (!m) throw new Error(`没在 ${file} 里找到 ${typeName}`)
      return m[1].replace(/\s+/g, ' ')
    }
    for (const typeName of ['StocktakeItem', 'StocktakeTally']) {
      expect(shape(STAFF_PATH, typeName)).toBe(shape(ADMIN_PATH, typeName))
    }
  })
})

describe('盘点差异派生', () => {
  test('差异 = 实盘 − 账面，浮点毛刺按两位小数收口', () => {
    expect(stocktakeDiff({ quantity: 0.3, stockSnapshot: 0.1 })).toBe(0.2)
    expect(stocktakeDiff({ quantity: 0, stockSnapshot: 5 })).toBe(-5)
    expect(stocktakeDiff({ quantity: 3, stockSnapshot: null })).toBeNull()
  })

  test('结论：盘盈 / 盘亏 / 相符，历史单无账面单列', () => {
    const items = [
      { quantity: 5, stockSnapshot: 5 },
      { quantity: 0, stockSnapshot: 2 },
      { quantity: 3, stockSnapshot: 1 },
    ]
    expect(tallyStocktake(items)).toEqual({ surplus: 1, shortage: 1, matched: 1, unknown: 0 })
    expect(stocktakeSummary(items)).toBe('盘盈 1 项 / 盘亏 1 项 / 相符 1 项')
    expect(stocktakeSummary([...items, { quantity: 1, stockSnapshot: null }]))
      .toBe('盘盈 1 项 / 盘亏 1 项 / 相符 1 项 / 未记账面 1 项')
  })

  test('展示文本：盘盈带 +，盘亏带 -，相符 0，无账面 —', () => {
    expect(stocktakeDiffDisplay({ quantity: 3, stockSnapshot: 1 })).toEqual({ diffText: '+2', diffKey: 'surplus' })
    expect(stocktakeDiffDisplay({ quantity: 0, stockSnapshot: 2.5 })).toEqual({ diffText: '-2.5', diffKey: 'shortage' })
    expect(stocktakeDiffDisplay({ quantity: 4, stockSnapshot: 4 })).toEqual({ diffText: '0', diffKey: 'matched' })
    expect(stocktakeDiffDisplay({ quantity: 4, stockSnapshot: null })).toEqual({ diffText: '—', diffKey: 'unknown' })
  })
})

describe('实盘数输入校验（与 staffApi isValidDocItemQuantity 盘点口径一致，#351）', () => {
  test.each(['0', '0.00', '5', '1.25', '9999999999.99'])('%j 合法', (input) => {
    expect(isValidStocktakeQuantity(input)).toBe(true)
  })

  test.each(['', '   ', '-1', '1.234', 'abc', '10000000000', 'Infinity'])('%j 不合法', (input) => {
    expect(isValidStocktakeQuantity(input)).toBe(false)
  })
})
