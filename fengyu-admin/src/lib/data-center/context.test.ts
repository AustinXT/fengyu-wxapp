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

  it('多店账号可查看授权汇总，无授权门店时拒绝', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const multiStore = makeSession([{ role: 'manager', scopeType: '门店' }], ['S1', 'S2'])
    await expect(validateScope(multiStore, { type: 'authorized' })).resolves.toBeUndefined()

    const noStore = makeSession([{ role: 'manager', scopeType: '门店' }], [])
    await expect(validateScope(noStore, { type: 'authorized' })).rejects.toThrow(
      /PERMISSION_DENIED/,
    )
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
  it('authorized → 全部授权门店', async () => {
    expect(await resolveScopeName({ type: 'authorized' })).toBe('全部授权门店')
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

  it('授权汇总的 meta 不携带单一 scope id', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const ctx = await prepareBoardContext(
      makeSession([{ role: 'manager', scopeType: '门店' }], ['S1', 'S2']),
      {
        scope: { type: 'authorized' },
        timeRange: { preset: 'month' },
      },
    )
    expect(ctx.meta.scope).toEqual({
      type: 'authorized',
      id: null,
      name: '全部授权门店',
    })
  })
})

describe('prepareBoardContext · 时间参数服务端复检（#308）', () => {
  it.each([
    ['2 月 30 日', { preset: 'custom', start: '2026-02-30', end: '2026-03-01' }],
    ['0001 年', { preset: 'custom', start: '0001-01-01', end: '0001-01-02' }],
    ['倒挂', { preset: 'custom', start: '2026-02-01', end: '2026-01-01' }],
    ['缺 end', { preset: 'custom', start: '2026-01-01' }],
    ['预设不在白名单', { preset: 'decade' }],
    ['缺 timeRange', undefined],
  ])('%s → INVALID_PARAMS（不回落本月）', async (_, timeRange) => {
    mockIsAdminScope.mockReturnValue(true)
    await expect(
      prepareBoardContext(makeSession([]), { scope: { type: 'all' }, timeRange: timeRange as never }),
    ).rejects.toThrow(/^INVALID_PARAMS: /)
  })

  it('越权优先于时间校验：无权范围 + 非法时间 → PERMISSION_DENIED', async () => {
    mockIsAdminScope.mockReturnValue(false)
    await expect(
      prepareBoardContext(makeSession([{ role: 'manager', scopeType: '门店' }], ['S1']), {
        scope: { type: 'all' },
        timeRange: { preset: 'custom', start: '2026-02-30', end: '2026-03-01' },
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('合法 custom（年份上下界）照常构建 meta，区间无 NaN 且不倒挂', async () => {
    mockIsAdminScope.mockReturnValue(true)
    for (const [start, end] of [['1900-01-01', '1900-03-31'], ['2100-12-01', '2100-12-31'], ['1900-01-01', '2100-12-31']]) {
      const ctx = await prepareBoardContext(makeSession([]), {
        scope: { type: 'all' },
        timeRange: { preset: 'custom', start, end },
      })
      expect(ctx.meta.timeRange).toMatchObject({ start, end })
      for (const r of [ctx.meta.timeRange, ctx.meta.timeRange.previous!, ctx.meta.timeRange.lastYear!]) {
        expect(r.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(r.end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(r.start <= r.end).toBe(true)
      }
    }
  })
})

describe('validateScope · 多店（#376）', () => {
  it('所选门店全部在授权门店内 → 放行', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const s = makeSession([{ role: 'manager', scopeType: '门店' }], ['S1', 'S2', 'S3'])
    await expect(validateScope(s, { type: 'stores', ids: ['S1', 'S3'] })).resolves.toBeUndefined()
  })

  it('任一门店越权 → PERMISSION_DENIED（整单拒绝，不静默剔除）', async () => {
    mockIsAdminScope.mockReturnValue(false)
    const s = makeSession([{ role: 'manager', scopeType: '市场' }], ['S1', 'S2'])
    await expect(validateScope(s, { type: 'stores', ids: ['S1', 'S9'] })).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('admin / 总部放行', async () => {
    mockIsAdminScope.mockReturnValue(true)
    await expect(validateScope(makeSession([]), { type: 'stores', ids: ['S1', 'S9'] })).resolves.toBeUndefined()
    mockIsAdminScope.mockReturnValue(false)
    await expect(validateScope(makeSession([{ role: 'manager', scopeType: '总部' }]), { type: 'stores', ids: ['S1', 'S9'] })).resolves.toBeUndefined()
  })
})

describe('resolveScopeName · 多店（#376）', () => {
  it('按所选顺序列店名，查不到的记「未知门店」', async () => {
    dbRows.value = [{ id: 'S2', name: '绿湖店' }, { id: 'S1', name: '蓝莱店' }] as unknown as Array<{ name: string }>
    await expect(resolveScopeName({ type: 'stores', ids: ['S1', 'S2', 'S9'] })).resolves.toBe('蓝莱店、绿湖店、未知门店')
  })
})

describe('validateScope · 多店形状（#376，server action 直收客户端对象）', () => {
  it.each([
    ['空列表', []],
    ['只有 1 家', ['S1']],
    ['重复 id', ['S1', 'S1']],
    ['非法字符', ['S1', 'S2;x']],
    ['非字符串', ['S1', 2]],
    ['超上限', Array.from({ length: 201 }, (_, i) => `S${i}`)],
  ])('%s → INVALID_PARAMS（admin 也不放行）', async (_label, ids) => {
    mockIsAdminScope.mockReturnValue(true)
    await expect(validateScope(makeSession([]), { type: 'stores', ids: ids as string[] })).rejects.toThrow(/^INVALID_PARAMS/)
  })

  it('非数组 → INVALID_PARAMS', async () => {
    mockIsAdminScope.mockReturnValue(true)
    await expect(validateScope(makeSession([]), { type: 'stores', ids: 'S1,S2' as unknown as string[] })).rejects.toThrow(/^INVALID_PARAMS/)
  })
})
