import { readFileSync } from 'node:fs'
import path from 'node:path'
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

  it('并发首请求共用同一次查询；结果冻结，调用方改不动共享缓存', async () => {
    execute.mockResolvedValue([{ store_id: 'S1', start: '2026-07-08' }])
    const [a, b] = await Promise.all([loadStoreDataStarts(0), loadStoreDataStarts(0)])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.S1)).toBe(true)
  })

  it('查询失败不写缓存，下次重试', async () => {
    execute.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([])
    await expect(loadStoreDataStarts(0)).rejects.toThrow('boom')
    await expect(loadStoreDataStarts(0)).resolves.toEqual({})
  })
})

describe('数据起点业绩轴与销售板门店业绩同口径（字面量守护）', () => {
  // 起点口径若比业绩口径宽（例如把储值卡抵扣、内部单也算进来），门店会被判定「更早上线」，
  // 其间的期间不再提示数据不完整——prod 实测南昌锦城店会早 4 天（08-08 vs 08-12）。
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8')
  const sets = (source: string, column: string) =>
    [...source.matchAll(new RegExp(`${column} IN \\(([^)]*)\\)`, 'g'))].map((m) => m[1].replace(/\s+/g, ' ').trim())

  it('change_type / sale_order_type 两组集合与 sales.ts runStoreRevenue 逐字相同', () => {
    const salesSource = read('../../actions/data-center/sales.ts')
    const block = salesSource.slice(salesSource.indexOf('const runStoreRevenue'), salesSource.indexOf('const runShengmeiRevenue'))
    const startSource = read('./data-start-query.ts')

    expect(sets(block, 'spe\\.change_type')).toHaveLength(1)
    expect(sets(startSource, 'p\\.change_type')).toEqual(sets(block, 'spe\\.change_type'))
    expect(sets(startSource, 'so\\.sale_order_type')).toEqual(sets(block, 'spe\\.sale_order_type'))
  })

  it('已支付状态与 WorkFine 历史单排除两条谓词两边都在', () => {
    const salesSource = read('../../actions/data-center/sales.ts')
    const block = salesSource.slice(salesSource.indexOf('const runStoreRevenue'), salesSource.indexOf('const runShengmeiRevenue'))
    const startSource = read('./data-start-query.ts')

    expect(block).toContain("spe.status = '已支付'")
    expect(startSource).toContain("p.status = '已支付'")
    expect(block).toContain("spe.legacy_source IS DISTINCT FROM 'workfine'")
    expect(startSource).toContain("so.legacy_source IS DISTINCT FROM 'workfine'")
  })
})
