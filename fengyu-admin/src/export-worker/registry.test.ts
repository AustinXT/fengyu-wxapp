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
