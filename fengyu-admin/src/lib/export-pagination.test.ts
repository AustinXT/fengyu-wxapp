import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_WORKER_BATCH_SIZE,
  iterateExportPages,
  offsetPageResult,
  resolveExportKeysetPage,
} from './export-pagination'

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const row of rows) result.push(row)
  return result
}

describe('resolveExportKeysetPage', () => {
  const toCursor = (row: { id: string }) => row.id

  it('切掉探测行，游标取本页最后一行（不是探测行）', () => {
    expect(
      resolveExportKeysetPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, toCursor),
    ).toEqual({
      pageRows: [{ id: 'a' }, { id: 'b' }],
      hasMore: true,
      nextCursor: 'b',
    })
  })

  it('刚好取满不含探测行 → hasMore=false 且不给游标（否则 worker 会多跑一页空查询）', () => {
    expect(resolveExportKeysetPage([{ id: 'a' }, { id: 'b' }], 2, toCursor)).toEqual({
      pageRows: [{ id: 'a' }, { id: 'b' }],
      hasMore: false,
    })
  })

  it('limit=null（legacy 全量调用）→ 原样返回全部行，不分页', () => {
    expect(resolveExportKeysetPage([{ id: 'a' }, { id: 'b' }], null, toCursor)).toEqual({
      pageRows: [{ id: 'a' }, { id: 'b' }],
      hasMore: false,
    })
  })

  it('空结果 → 不给游标', () => {
    expect(resolveExportKeysetPage([], 2, toCursor)).toEqual({ pageRows: [], hasMore: false })
  })

  it('limit < 1 → 抛 INVALID_STATE，而不是在 toCursor 里抛语义不明的 TypeError', () => {
    expect(() => resolveExportKeysetPage([{ id: 'a' }], 0, toCursor)).toThrow('导出分页 limit 必须 ≥ 1')
  })

  it('游标可以是复合键对象（顾客导出的 name+userId 形态）', () => {
    const rows = [
      { name: '陈一', userId: 'u1' },
      { name: null, userId: 'u2' },
      { name: null, userId: 'u3' },
    ]
    const page = resolveExportKeysetPage(rows, 2, (r) => ({ name: r.name, userId: r.userId }))

    expect(page.hasMore).toBe(true)
    // name 为 null 也必须能当游标（NULLS LAST 区间的行），不能被当成「无游标」
    expect(page.nextCursor).toEqual({ name: null, userId: 'u2' })
  })

  it('hasMore 时游标必定存在，能接上 iterateExportPages 的守卫', async () => {
    const pages = [
      resolveExportKeysetPage([{ id: 'a' }, { id: 'b' }], 1, toCursor),
      resolveExportKeysetPage([{ id: 'b' }], 1, toCursor),
    ]
    let call = 0
    const fetch = vi.fn().mockImplementation(async () => {
      const page = pages[call++]
      return { rows: page.pageRows, truncated: false, hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    })

    await expect(collect(iterateExportPages(fetch))).resolves.toEqual([{ id: 'a' }, { id: 'b' }])
  })
})

describe('export pagination', () => {
  it('offset page only exposes the configured page and advances its cursor', () => {
    expect(offsetPageResult(['a', 'b', 'c'], { limit: 2, offset: 6 })).toEqual({
      rows: ['a', 'b'],
      truncated: false,
      hasMore: true,
      nextCursor: 8,
    })
  })

  it('iterates bounded pages without materializing all data first', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        rows: ['first', 'second'],
        truncated: false,
        hasMore: true,
        nextCursor: 2,
      })
      .mockResolvedValueOnce({
        rows: ['third'],
        truncated: false,
        hasMore: false,
      })

    await expect(collect(iterateExportPages(fetch))).resolves.toEqual(['first', 'second', 'third'])
    expect(fetch).toHaveBeenNthCalledWith(1, { limit: EXPORT_WORKER_BATCH_SIZE })
    expect(fetch).toHaveBeenNthCalledWith(2, { limit: EXPORT_WORKER_BATCH_SIZE, cursor: 2 })
  })

  it('fails malformed pages instead of looping forever', async () => {
    const fetch = vi.fn().mockResolvedValue({
      rows: [],
      truncated: false,
      hasMore: true,
      nextCursor: 1,
    })

    await expect(collect(iterateExportPages(fetch))).rejects.toThrow('导出分页未返回数据')
  })

  it('fails when a non-empty page repeats its cursor', async () => {
    const fetch = vi.fn().mockResolvedValue({
      rows: ['same-page'],
      truncated: false,
      hasMore: true,
      nextCursor: 0,
    })

    await expect(collect(iterateExportPages(fetch))).rejects.toThrow('导出分页游标未推进')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
