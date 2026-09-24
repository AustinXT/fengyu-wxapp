import { describe, expect, it } from 'vitest'
import { completeExportMeta } from './export-meta'

describe('completeExportMeta', () => {
  it('旧导出类型没有 meta → 不生成元信息', () => {
    expect(completeExportMeta(undefined, { requestedAt: new Date(), exporterName: '张三' })).toBeUndefined()
  })

  it('追加导出时间（北京时间，带秒）与导出人，业务元信息顺序不变', () => {
    const meta = completeExportMeta(
      [
        { label: '时间区间', value: '2026-09-01 ~ 2026-09-30' },
        { label: '范围', value: '市场 · 南昌凤御' },
      ],
      { requestedAt: new Date('2026-09-24T16:05:09Z'), exporterName: ' 张三 ' },
    )
    expect(meta).toEqual([
      { label: '时间区间', value: '2026-09-01 ~ 2026-09-30' },
      { label: '范围', value: '市场 · 南昌凤御' },
      { label: '导出时间', value: '2026-09-25 00:05:09' },
      { label: '导出人', value: '张三' },
    ])
  })

  it('会话快照缺姓名时导出人写占位而不是空', () => {
    expect(completeExportMeta([], { requestedAt: new Date(0), exporterName: '' })?.at(-1)).toEqual({ label: '导出人', value: '—' })
  })
})
