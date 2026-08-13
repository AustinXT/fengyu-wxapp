import { describe, expect, it } from 'vitest'
import { createExportContent } from './registry'

describe('服务单导出列', () => {
  it('消耗数量仅输出数值，不拼接单位', async () => {
    const content = await createExportContent('services', {})
    const column = content.columns.find((item) => item.header === '消耗数量')

    expect(column?.value({ sessionUsed: 2, unit: '次' })).toBe(2)
    expect(column?.value({ sessionUsed: '3.5', unit: '疗程' })).toBe(3.5)
    expect(column?.value({ sessionUsed: null, unit: '次' })).toBe('')
  })
})

describe('疗程卡导出列', () => {
  it('剩余、已付、总量与剩余零头均独立输出数值', async () => {
    const content = await createExportContent('cards', {})
    const remaining = content.columns.find((item) => item.header === '剩余')
    const paid = content.columns.find((item) => item.header === '已付')
    const total = content.columns.find((item) => item.header === '总量')
    const remainder = content.columns.find((item) => item.header === '剩余零头')

    expect(remaining?.value({ remaining: 2, unit: '次' })).toBe(2)
    expect(paid?.value({ paidSessions: 3, unit: '次' })).toBe(3)
    expect(total?.value({ totalSessions: 5, unit: '次' })).toBe(5)
    expect(remainder?.value({ remainingRemainder: 214, unit: '次' })).toBe(214)
    expect(remaining?.value({ remaining: null, unit: '疗程' })).toBe('')
  })
})

describe('商城商品导出列', () => {
  it('输出商城分类、商品类型、价格和展示状态', async () => {
    const content = await createExportContent('mall-products', {})
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))
    const row = {
      categoryGroup: '居家护理',
      categoryName: '面膜',
      isBundle: true,
      price: '299.00',
      specialPrice: null,
      isVisible: false,
      skuCount: 3,
    }

    expect(content.sheetName).toBe('商城商品')
    expect(columns['商城分类']?.value(row)).toBe('居家护理 / 面膜')
    expect(columns['商品类型']?.value(row)).toBe('套餐')
    expect(columns['标价']?.value(row)).toBe(299)
    expect(columns['会员价']?.value(row)).toBe('')
    expect(columns['展示状态']?.value(row)).toBe('未展示')
    expect(columns['规格数']?.value(row)).toBe(3)
  })
})
