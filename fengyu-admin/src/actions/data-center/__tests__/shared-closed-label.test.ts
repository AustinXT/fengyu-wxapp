import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

/**
 * 范围下拉「（已关店）」标记（#422）：只关店、组织节点仍启用的门店照常进下拉（有关店前的历史数据），
 * 数据源给它打 closed 标。判定在 lib/store-closed-label（#401 闭集守护不许数据中心消费方碰 is_closed），
 * 纯展示：只查下拉里的在营门店，查失败不打标、不拖垮筛选器。
 */
const { mockGetSession, db, expandMarketVisibility, loadClosedStoreIds } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  db: { select: vi.fn() },
  expandMarketVisibility: vi.fn(),
  loadClosedStoreIds: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db }))
vi.mock('@/lib/data-center/data-start-query', () => ({ loadStoreDataStarts: vi.fn() }))
vi.mock('@/lib/store-closed-label', () => ({ loadClosedStoreIds }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandMarketVisibility,
}))

import { getDataCenterScopeOptions } from '../shared'

function rowsOf(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'innerJoin', 'orderBy']) chain[method] = () => chain
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject)
  return chain
}

const stores = ['S1', 'S2', 'S3']
const marketSession = {
  employeeId: 'E', name: 'n', phone: 'p',
  roles: [{ role: 'manager', scopeId: 'M1', scopeType: '市场', actions: ['data_center:dashboard'], scopeStoreIds: stores, scopeOrgNodeIds: ['M1'] }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: stores, scopeOrgNodeIds: ['M1'] },
} as AuthSession

function mockRows() {
  db.select
    .mockImplementationOnce(() => rowsOf([{ id: 'M1', name: '南昌' }]) as never)
    .mockImplementationOnce(() => rowsOf([
      { storeId: 'S1', storeName: '蓝莱店', marketId: 'M1', isActive: true },
      { storeId: 'S2', storeName: '八一店', marketId: 'M1', isActive: true },
      { storeId: 'S3', storeName: '红谷店', marketId: 'M1', isActive: false },
    ]) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSession.mockResolvedValue(marketSession)
  expandMarketVisibility.mockResolvedValue({ visible: ['M1'], granted: ['M1'] })
})

describe('范围下拉已关店标记（#422）', () => {
  it('已关店门店带 closed: true，其余不带；只查下拉里的在营门店（停用门店不查）', async () => {
    mockRows()
    loadClosedStoreIds.mockResolvedValue(new Set(['S2']))
    const options = await getDataCenterScopeOptions()
    expect(options.markets[0].stores).toEqual([
      { storeId: 'S1', storeName: '蓝莱店' },
      { storeId: 'S2', storeName: '八一店', closed: true },
    ])
    expect(loadClosedStoreIds).toHaveBeenCalledWith(['S1', 'S2'])
    // 停用门店不受影响
    expect(options.inactiveStores).toEqual([{ storeId: 'S3', storeName: '红谷店', marketId: 'M1' }])
  })

  it('关店查询失败 → 不打标、筛选器照常返回', async () => {
    mockRows()
    loadClosedStoreIds.mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const options = await getDataCenterScopeOptions()
    spy.mockRestore()
    expect(options.markets[0].stores).toEqual([
      { storeId: 'S1', storeName: '蓝莱店' },
      { storeId: 'S2', storeName: '八一店' },
    ])
  })
})
