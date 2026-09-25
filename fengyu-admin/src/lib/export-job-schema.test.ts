import { describe, expect, it } from 'vitest'
import { createExportJobSchema } from './export-job-schema'

describe('导出参数长度上限（#376 多店范围）', () => {
  const longScopeId = Array.from({ length: 200 }, (_, i) => `store-17798${String(i).padStart(8, '0')}`).join(',')

  it('数据中心导出：scopeId 可承载 200 家门店的逗号串', () => {
    expect(longScopeId.length).toBeGreaterThan(240)
    const r = createExportJobSchema.safeParse({ exportType: 'data-center', payload: { view: 'report-remaining-cards', params: { scope: 'stores', scopeId: longScopeId } } })
    expect(r.success).toBe(true)
  })

  it('数据中心导出：scopeId 以外的键仍按 240 截断', () => {
    const r = createExportJobSchema.safeParse({ exportType: 'data-center', payload: { view: 'report-remaining-cards', params: { q: 'x'.repeat(241) } } })
    expect(r.success).toBe(false)
  })

  it('非数据中心导出不随之放宽', () => {
    const r = createExportJobSchema.safeParse({ exportType: 'orders', payload: { scopeId: 'x'.repeat(241) } })
    expect(r.success).toBe(false)
  })
})
