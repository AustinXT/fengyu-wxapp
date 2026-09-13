/**
 * 销售归属分类字面量守护测试（issue #123）
 *
 * 用户已 veto cloudfunctions-shared：`sales_category` 四值在 db/schema、staffApi、admin、
 * payNotify 各持独立副本，一致性只能靠 snapshot 守护（同 cross-end-sql-snapshot.test.js 思路）。
 *
 * 本测试锁死两件事：
 *   1. staffApi 的 utils/sales-categories.js 与 db/schema/enums.ts::salesCategoryEnum 逐字一致
 *      —— 漏同步时，performanceDetail 会先零填充出一个「幽灵旧分类」（永远 ¥0.00、点了筛不出东西），
 *         再把有数据的新分类追加到末尾；本期无新分类数据时新分类甚至完全不显示。
 *   2. 数组顺序固定 —— 顺序即绩效页 4 个格子的展示顺序。
 */

const fs = require('node:fs')
const path = require('node:path')

const { SALES_CATEGORIES, UNCATEGORIZED } = require('../../utils/sales-categories')

const ENUMS_TS = path.resolve(__dirname, '../../../../../db/schema/enums.ts')

describe('sales_category 跨端字面量一致性', () => {
  test('utils/sales-categories.js 与 db/schema/enums.ts::salesCategoryEnum 逐字一致', () => {
    const source = fs.readFileSync(ENUMS_TS, 'utf8')
    const match = source.match(/pgEnum\(\s*"sales_category"\s*,\s*\[([^\]]+)\]/)
    expect(match, `未能在 ${ENUMS_TS} 中定位 salesCategoryEnum，枚举定义可能已改写`).toBeTruthy()

    const fromSchema = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)

    expect(SALES_CATEGORIES).toEqual(fromSchema)
  })

  test('固定 4 值与顺序锁定（顺序 = 绩效页格子展示顺序）', () => {
    expect(SALES_CATEGORIES).toEqual(['自销自耗', '他销自耗', '他销他耗', '生态合作'])
  })

  test('常量被 freeze，防跨请求污染（模块作用域在云函数容器内跨请求复用）', () => {
    expect(Object.isFrozen(SALES_CATEGORIES)).toBe(true)
  })

  test('UNCATEGORIZED 字面量固定 —— 前端 chip 与后端归类靠它对齐', () => {
    expect(UNCATEGORIZED).toBe('未分类')
  })
})
