import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute } }))

import { loadStoreDataStarts, resetStoreDataStartsCache } from './data-start-query'

beforeEach(() => {
  execute.mockReset()
  resetStoreDataStartsCache()
})

describe('loadStoreDataStarts', () => {
  it('两条轴按门店合并；空起点不落键', async () => {
    execute
      .mockResolvedValueOnce([{ store_id: 'S1', start: '2026-07-08' }, { store_id: 'S2', start: null }])
      .mockResolvedValueOnce([{ store_id: 'S1', start: '2026-07-09' }, { store_id: 'S3', start: '2026-07-28' }])

    await expect(loadStoreDataStarts(0)).resolves.toEqual({
      S1: { performance: '2026-07-08', service: '2026-07-09' },
      S3: { service: '2026-07-28' },
    })
  })

  it('10 分钟内命中进程缓存，过期后重查', async () => {
    execute.mockResolvedValue([])
    await loadStoreDataStarts(0)
    await loadStoreDataStarts(9 * 60 * 1000)
    expect(execute).toHaveBeenCalledTimes(2)
    await loadStoreDataStarts(10 * 60 * 1000 + 1)
    expect(execute).toHaveBeenCalledTimes(4)
  })
})
