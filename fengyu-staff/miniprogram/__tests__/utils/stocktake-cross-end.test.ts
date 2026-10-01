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

describe('盘点类型集合与可建类型（#352）', () => {
  const STAFF_API_PATH = path.resolve(__dirname, '../../../cloudfunctions/staffApi/routes/inventory.js')
  const FORM_PATH = path.resolve(__dirname, '../../packageMy/inventory/form.ts')

  function setItems(src: string, name: string): string[] {
    const m = src.match(new RegExp(`const ${name} = new Set(?:<[^>]+>)?\\(\\[([\\s\\S]*?)\\]\\)`))
    if (!m) throw new Error(`没找到 ${name}`)
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  }

  test('小程序 STOCKTAKE_DOC_TYPES 与 staffApi、admin 逐项一致', () => {
    const staffSrc = fs.readFileSync(STAFF_PATH, 'utf8')
    const m = staffSrc.match(/const STOCKTAKE_DOC_TYPES = new Set<string>\(\[([^\]]*)\]\)/)
    if (!m) throw new Error('没找到小程序 STOCKTAKE_DOC_TYPES')
    const mini = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    expect(mini).toEqual(setItems(fs.readFileSync(STAFF_API_PATH, 'utf8'), 'STOCKTAKE_DOC_TYPES'))
    expect(mini).toEqual(setItems(fs.readFileSync(ADMIN_PATH, 'utf8'), 'STOCKTAKE_DOC_TYPES'))
    expect(mini).toHaveLength(2)
  })

  test('isStocktakeDocType 函数体与 admin 逐字相同（签名类型不同，只比函数体）', () => {
    const body = (file: string) => {
      const m = fs.readFileSync(file, 'utf8').match(/export function isStocktakeDocType\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)
      if (!m) throw new Error(`没在 ${file} 里找到 isStocktakeDocType`)
      return m[1].replace(/\s+/g, ' ').trim()
    }
    expect(body(STAFF_PATH)).toBe(body(ADMIN_PATH))
    expect(body(ADMIN_PATH)).toBe('return STOCKTAKE_DOC_TYPES.has(docType)')
  })

  test('表单 FORM_CONFIG 的类型都是 staffApi 允许 staff 新建的类型', () => {
    const form = fs.readFileSync(FORM_PATH, 'utf8')
    const block = form.match(/const FORM_CONFIG[^=]*= \{([\s\S]*?)\n\}/)
    if (!block) throw new Error('没找到 FORM_CONFIG')
    const keys = [...block[1].matchAll(/^  '([^']+)': \{/gm)].map((x) => x[1])
    expect(keys).toContain('分院库存盘点')
    expect(keys.length).toBe(5)
    const creatable = setItems(fs.readFileSync(STAFF_API_PATH, 'utf8'), 'STAFF_CREATE_DOC_TYPES')
    for (const key of keys) expect(creatable).toContain(key)
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
  // 1e2 / 0x10 看着怪，但后端 isValidDocItemQuantity 同样放行（#351 口径）；前端单端收紧会与后端分叉
  test.each(['0', '0.00', '5', '1.25', '9999999999.99', '1e2', '0x10'])('%j 合法', (input) => {
    expect(isValidStocktakeQuantity(input)).toBe(true)
  })

  test.each(['', '   ', '-1', '1.234', 'abc', '10000000000', 'Infinity'])('%j 不合法', (input) => {
    expect(isValidStocktakeQuantity(input)).toBe(false)
  })
})

describe('差异展示与实盘校验的跨端一致（#352 评审补）', () => {
  const ADMIN_PAGE_PATH = path.resolve(__dirname, '../../../../fengyu-admin/src/app/(main)/(inventory)/inventory/docs/[id]/page.tsx')
  const STAFF_API_PATH = path.resolve(__dirname, '../../../cloudfunctions/staffApi/routes/inventory.js')

  test('差异文本表达式与 admin StocktakeDiffCell 逐字相同', () => {
    const expr = 'diff > 0 ? `+${diff}` : String(diff)'
    const adminCell = fs.readFileSync(ADMIN_PAGE_PATH, 'utf8').match(/function StocktakeDiffCell[\s\S]*?\n\}/)
    if (!adminCell) throw new Error('没找到 admin StocktakeDiffCell')
    expect(adminCell[0]).toContain(expr)
    expect(adminCell[0]).toMatch(/diff === null\) return <td[^>]*>—<\/td>/)
    expect(normalizedFunction(STAFF_PATH, 'stocktakeDiffDisplay')).toContain(expr)
  })

  test('isValidStocktakeQuantity 与 staffApi isValidDocItemQuantity 在盘点类型上逐值同判', () => {
    const src = fs.readFileSync(STAFF_API_PATH, 'utf8')
    const m = src.match(/function isValidDocItemQuantity\(docType, quantity\) \{([\s\S]*?)\n\}/)
    if (!m) throw new Error('没找到 staffApi isValidDocItemQuantity')
    // eslint-disable-next-line no-new-func
    const backend = new Function('STOCKTAKE_DOC_TYPES', 'docType', 'quantity', m[1]) as
      (types: Set<string>, docType: string, quantity: unknown) => boolean
    const types = new Set(['市场库存盘点', '分院库存盘点'])
    const inputs = ['', ' ', '0', '-0', '0.00', '1', '1.5', '1.25', '1.234', '-1', '1e2', '0x10', '.5', '+3',
      'abc', 'Infinity', 'NaN', '9999999999.99', '10000000000', ' 7 ', '1,5', '０']
    for (const input of inputs) {
      expect(isValidStocktakeQuantity(input), JSON.stringify(input)).toBe(backend(types, '分院库存盘点', input))
    }
  })
})
