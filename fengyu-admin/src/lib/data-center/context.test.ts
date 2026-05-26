import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock 依赖 ──
const dbRows = { value: [] as Array<{ name: string }> }
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => dbRows.value }) }) }),
  },
}))
vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', parentId: 'parent_id', type: 'type' },
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
}))

const { mockIsAdminScope, mockExpandVisibleMarketIds, FakePermissionError } = vi.hoisted(() => {
  class FakePermissionError extends Error {
    digest = 'PERMISSION_DENIED'
  }
  return {
    mockIsAdminScope: vi.fn<(s: unknown) => boolean>(),
    mockExpandVisibleMarketIds: vi.fn<() => Promise<string[] | null>>(),
    FakePermissionError,
  }
})
vi.mock('@/lib/permissions', () => ({
  isAdminScope: (s: unknown) => mockIsAdminScope(s),
  expandVisibleMarketIds: () => mockExpandVisibleMarketIds(),
  PermissionError: FakePermissionError,
}))

import { getScopeTopLevel, validateScope, resolveScopeName, prepareBoardContext } from './context'
import type { AuthSession, RoleType } from '@/lib/types'

function makeSession(
  roles: Array<{ role: RoleType; scopeType: '总部' | '市场' | '门店' }>,
  scopeStoreIds: string[] = [],
): AuthSession {
  return {
    employeeId: 'e1',
    name: 'n',
    phone: '13800000000',
    roles: roles.map((r) => ({ role: r.role, scopeId: 'sc', scopeType: r.scopeType })),
    permissions: { actions: [], scopeStoreIds },
  }
}

beforeEach(() => {
  mockIsAdminScope.mockReset()
  mockExpandVisibleMarketIds.mockReset()
  dbRows.value = []
})

describe('getScopeTopLevel', () => {
  it('admin → all', () => {
    mockIsAdminScope.mockReturnValue(true)
    expect(getScopeTopLevel(makeSession([{ role: 'admin', scopeType: '门店' }]))).toBe('all')
  })
  it('总部角色 → all', () => {
    mockIsAdminScope.mockReturnValue(false)
    expect(getScopeTopLevel(makeSession([{ role: 'manager', scopeType: '总部' }]))).toBe('all')
  })
  it('市场角色 → market', () => {
    mockIsAdminScope.mockReturnValue(false)
    expect(getScopeTopLevel(makeSession([{ role: 'manager', scopeType: '市场' }]))).toBe('market')
  })
  it('仅门店角色 → store', () => {
    mockIsAdminScope.mockReturnValue(false)
    expect(getScopeTopLevel(makeSession([{ role: 'manager', scopeType: '门店' }]))).toBe('store')
  })
})

describe('validateScope', () => {
  it('admin 任意 scope 放行', async () => {
    mockIsAdminScope.mockReturnValue(true)
    await expect(validateScope(makeSession([]), { type: 'all' })).resolves.toBeUndefined()
  })

  it('总部角色任意 scope 放行', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const s = makeSession([{ role: 'manager', scopeType: '总部' }])
    await expect(validateScope(s, { type: 'all' })).resolves.toBeUndefined()
  })

  it('市场账号选 all → 抛 PERMISSION_DENIED', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const s = makeSession([{ role: 'manager', scopeType: '市场' }])
    await expect(validateScope(s, { type: 'all' })).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('市场账号选本市场放行、选他市场抛错', async () => {
    mockIsAdminScope.mockReturnValue(false)
    mockExpandVisibleMarketIds.mockResolvedValue(['MKT-OWN'])
    const s = makeSession([{ role: 'manager', scopeType: '市场' }])
    await expect(validateScope(s, { type: 'market', id: 'MKT-OWN' })).resolves.toBeUndefined()
    await expect(validateScope(s, { type: 'market', id: 'MKT-OTHER' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    )
  })

  it('门店账号选本店放行、选他店抛错', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const s = makeSession([{ role: 'manager', scopeType: '门店' }], ['S-OWN'])
    await expect(validateScope(s, { type: 'store', id: 'S-OWN' })).resolves.toBeUndefined()
    await expect(validateScope(s, { type: 'store', id: 'S-OTHER' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    )
  })
})

describe('resolveScopeName', () => {
  it('all → 全部', async () => {
    expect(await resolveScopeName({ type: 'all' })).toBe('全部')
  })
  it('market → org_nodes 名称', async () => {
    dbRows.value = [{ name: '自贡市场' }]
    expect(await resolveScopeName({ type: 'market', id: 'M1' })).toBe('自贡市场')
  })
  it('store → stores 名称；查不到回退', async () => {
    dbRows.value = []
    expect(await resolveScopeName({ type: 'store', id: 'S9' })).toBe('未知门店')
  })
})

describe('prepareBoardContext', () => {
  it('admin 构建 meta + comparison + enabled', async () => {
    mockIsAdminScope.mockReturnValue(true)
    dbRows.value = [{ name: '全部' }]
    const ctx = await prepareBoardContext(makeSession([]), {
      scope: { type: 'all' },
      timeRange: { preset: 'month' },
    })
    expect(ctx.meta.scope).toEqual({ type: 'all', id: null, name: '全部' })
    expect(ctx.meta.timeRange.presetLabel).toBe('本月')
    expect(ctx.comparison.current).toBeDefined()
    expect(ctx.enabled).toBe(true)
  })

  it('withComparison=false → enabled=false', async () => {
    mockIsAdminScope.mockReturnValue(true)
    const ctx = await prepareBoardContext(makeSession([]), {
      scope: { type: 'all' },
      timeRange: { preset: 'today' },
      withComparison: false,
    })
    expect(ctx.enabled).toBe(false)
  })
})
