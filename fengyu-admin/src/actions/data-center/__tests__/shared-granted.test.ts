import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

/**
 * 范围下拉数据源的 granted 标记（#399）：只有账号角色直接覆盖的市场为 true，门店级账号补进来的祖先市场为 false。
 * resolveDefaultDataCenterScope 据此只把「直接授权的无门店市场」当默认范围——祖先市场标成 true 会让
 * 唯一门店被停用的店长被默认带到整个市场、看到该市场锚定员工。
 */
const { mockGetSession, db, expandMarketVisibility } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  db: { select: vi.fn() },
  expandMarketVisibility: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', () => ({ db }))
vi.mock('@/lib/data-center/data-start-query', () => ({ loadStoreDataStarts: vi.fn() }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandMarketVisibility,
}))

import { getDataCenterScopeOptions } from '../shared'
import { resolveDefaultDataCenterScope } from '@/lib/data-center/scope-options'

function rowsOf(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'innerJoin', 'orderBy']) chain[method] = () => chain
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject)
  return chain
}

function session(scopeType: '市场' | '门店', scopeId: string, stores: string[]): AuthSession {
  const actions = ['data_center:dashboard']
  return {
    employeeId: 'E', name: 'n', phone: 'p',
    roles: [{ role: 'hr', scopeId, scopeType, actions, scopeStoreIds: stores, scopeOrgNodeIds: [scopeId] }],
    permissions: { actions, scopeStoreIds: stores, scopeOrgNodeIds: [scopeId] },
  } as AuthSession
}

beforeEach(() => vi.clearAllMocks())

describe('范围下拉 granted 标记（#399）', () => {
  it('hr@品项公司：市场 granted=true，默认落到该市场', async () => {
    mockGetSession.mockResolvedValue(session('市场', 'PX', []))
    expandMarketVisibility.mockResolvedValue({ visible: ['PX'], granted: ['PX'] })
    db.select
      .mockImplementationOnce(() => rowsOf([{ id: 'PX', name: '品项公司' }]) as never)
      .mockImplementationOnce(() => rowsOf([]) as never)
    const options = await getDataCenterScopeOptions()
    expect(options.markets).toEqual([{ id: 'PX', name: '品项公司', granted: true, stores: [] }])
    expect(resolveDefaultDataCenterScope(options)).toEqual({ type: 'market', id: 'PX' })
  })

  it('店长唯一门店已停用：所属市场是祖先市场 granted=false，没有默认范围（仍是空态）', async () => {
    mockGetSession.mockResolvedValue(session('门店', 'S1', ['S1']))
    expandMarketVisibility.mockResolvedValue({ visible: ['M1'], granted: [] })
    db.select
      .mockImplementationOnce(() => rowsOf([{ id: 'M1', name: '南昌' }]) as never)
      .mockImplementationOnce(() => rowsOf([{ storeId: 'S1', storeName: '蓝莱店', marketId: 'M1', isActive: false }]) as never)
    const options = await getDataCenterScopeOptions()
    expect(options.markets).toEqual([{ id: 'M1', name: '南昌', granted: false, stores: [] }])
    expect(resolveDefaultDataCenterScope(options)).toBeNull()
  })
})
