import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_WORKER_BATCH_SIZE,
  iterateExportPages,
  offsetPageResult,
} from './export-pagination'

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const row of rows) result.push(row)
  return result
}

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
