import { describe, expect, it } from 'vitest'
import { completeExportMeta } from './export-meta'

describe('completeExportMeta', () => {
  it('旧导出类型没有 meta → 不生成元信息', () => {
    expect(completeExportMeta(undefined, { requestedAt: new Date(), exporterName: '张三' })).toBeUndefined()
  })

  it('时间区间 / 范围 / 基期 / 其它条件在前，导出时间（北京时间带秒）与导出人由 worker 追加', () => {
    const meta = completeExportMeta(
      {
        period: '2026-09-01 ~ 2026-09-30',
        scope: '市场 · 南昌凤御',
        basePeriod: '2026-08-01 ~ 2026-08-31',
        extra: [{ label: '搜索', value: '张' }],
      },
      { requestedAt: new Date('2026-09-24T16:05:09Z'), exporterName: ' 张三 ' },
    )
    expect(meta).toEqual([
      { label: '时间区间', value: '2026-09-01 ~ 2026-09-30' },
      { label: '范围', value: '市场 · 南昌凤御' },
      { label: '基期区间', value: '2026-08-01 ~ 2026-08-31' },
      { label: '搜索', value: '张' },
      { label: '导出时间（申请时刻）', value: '2026-09-25 00:05:09' },
      { label: '导出人', value: '张三' },
    ])
  })

  it('仅范围型页面 period=null 显式标注；无基期不写基期行', () => {
    const meta = completeExportMeta({ period: null, scope: '全部' }, { requestedAt: new Date(0), exporterName: 'a' })!
    expect(meta[0]).toEqual({ label: '时间区间', value: '不限（仅按范围）' })
    expect(meta.map((entry) => entry.label)).not.toContain('基期区间')
  })

  it('缺姓名 / 非法时间 / 空范围 写占位而不是空', () => {
    const meta = completeExportMeta({ period: 'x', scope: ' ' }, { requestedAt: new Date(Number.NaN), exporterName: '' })!
    expect(meta.find((entry) => entry.label === '范围')?.value).toBe('—')
    expect(meta.find((entry) => entry.label.startsWith('导出时间'))?.value).toBe('—')
    expect(meta.at(-1)).toEqual({ label: '导出人', value: '—' })
  })
})
