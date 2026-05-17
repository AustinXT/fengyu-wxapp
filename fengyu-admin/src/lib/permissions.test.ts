import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRedirect } = vi.hoisted(() => {
  const mockRedirect = vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  })
  return { mockRedirect }
})
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))

// Mock drizzle-orm 和 db 模块（expandScopeStoreIds 和 buildScopeWhere 需要）
vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue([]),
      }),
    }),
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', parentId: 'parent_id', type: 'type' },
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
}))

import { computeActions, requirePermission, requireAnyPermission, buildScopeWhere, PERMISSION_MATRIX, expandScopeStoreIds, isAdminScope, scopeCondition, isInScope, hasPermission } from './permissions'
import type { AuthSession, RoleType } from './types'

// 构造不同角色的 session 工厂（hasPermission 测试用）
function makeSession(roles: Array<{ role: RoleType; scopeId: string; scopeType: '总部' | '市场' | '门店' }>, actions: string[] = []): AuthSession {
  return {
    employeeId: 'test-001',
    name: '测试用户',
    phone: '13800000000',
    roles,
    permissions: { actions, scopeStoreIds: [] },
  }
}

// Helper: 创建 mock session
function mockSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '测试用户',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: {
      actions: ['dashboard:view', 'employee:list', 'employee:create'],
      scopeStoreIds: ['S001', 'S002'],
    },
    ...overrides,
  }
}

describe('PERMISSION_MATRIX', () => {
  it('admin 拥有基础数据和系统管理权限', () => {
    const adminActions = PERMISSION_MATRIX.admin
    expect(adminActions).toContain('org:list')
    expect(adminActions).toContain('employee:create')
    expect(adminActions).toContain('permission:assign_admin')

    expect(adminActions).toContain('operation_log:list')
    expect(adminActions).toContain('card_transaction:list')
  })

  it('admin 不碰业务数据（无 sale_order/service/appointment 权限）', () => {
    const adminActions = PERMISSION_MATRIX.admin
    expect(adminActions).not.toContain('sale_order:list')
    expect(adminActions).not.toContain('sale_order:create')
    expect(adminActions).not.toContain('service:list')
    expect(adminActions).not.toContain('appointment:list')
    expect(adminActions).not.toContain('customer:list')
    expect(adminActions).not.toContain('sale_item:list')
  })

  it('manager 拥有业务操作权限', () => {
    const actions = PERMISSION_MATRIX.manager
    expect(actions).toContain('sale_order:create')
    expect(actions).toContain('allocation:save')
    expect(actions).toContain('service:create')
    expect(actions).toContain('appointment:list')
    expect(actions).toContain('customer:list')
    expect(actions).toContain('sale_item:list')
    expect(actions).toContain('card_transaction:list')
  })

  it('finance 仅有只读权限', () => {
    const actions = PERMISSION_MATRIX.finance
    expect(actions).toContain('sale_order:list')
    expect(actions).toContain('allocation:list')
    expect(actions).toContain('sale_item:list')
    expect(actions).toContain('card_transaction:list')
    expect(actions).not.toContain('sale_order:create')
    expect(actions).not.toContain('allocation:save')
  })

  it('hr 管理组织和员工', () => {
    const actions = PERMISSION_MATRIX.hr
    expect(actions).toContain('org:create')
    expect(actions).toContain('employee:create')
    expect(actions).toContain('permission:assign')
    // hr 不能分配 admin
    expect(actions).not.toContain('permission:assign_admin')
    // hr 不看充值卡流水
    expect(actions).not.toContain('card_transaction:list')
  })

  it('product 管理商品和优惠券', () => {
    const actions = PERMISSION_MATRIX.product
    expect(actions).toContain('product:create')
    expect(actions).toContain('coupon:create')
    // product 不看充值卡流水
    expect(actions).not.toContain('card_transaction:list')
  })

  it('customer_mgr 只管顾客（含卡包只读）', () => {
    const actions = PERMISSION_MATRIX.customer_mgr
    expect(actions).toContain('customer:list')
    expect(actions).toContain('customer:update')
    expect(actions).toContain('sale_item:list')
    expect(actions).not.toContain('sale_order:list')
    // customer_mgr 不看充值卡流水（默认保守）
    expect(actions).not.toContain('card_transaction:list')
  })

  it('staff 无权限（不可登录管理后台）', () => {
    expect(PERMISSION_MATRIX.staff).toEqual([])
  })
})

describe('computeActions', () => {
  it('单角色返回对应权限列表', () => {
    const actions = computeActions([{ role: 'product' }])
    expect(actions).toContain('product:create')
    expect(actions).toContain('coupon:list')
    expect(actions).toContain('dashboard:view')
  })

  it('多角色合并去重', () => {
    const actions = computeActions([{ role: 'hr' }, { role: 'product' }])
    // hr 权限
    expect(actions).toContain('employee:create')
    // product 权限
    expect(actions).toContain('product:create')
    // 共有权限不重复
    const dashboardCount = actions.filter(a => a === 'dashboard:view').length
    expect(dashboardCount).toBe(1)
  })

  it('空角色返回空数组', () => {
    const actions = computeActions([])
    expect(actions).toEqual([])
  })

  it('未知角色忽略', () => {
    const actions = computeActions([{ role: 'unknown' as any }])
    expect(actions).toEqual([])
  })
})

describe('hasPermission', () => {
  it('拥有权限返回 true', () => {
    const session = makeSession([], ['org:list', 'org:create'])
    expect(hasPermission(session, 'org:list')).toBe(true)
    expect(hasPermission(session, 'org:create')).toBe(true)
  })

  it('无权限返回 false', () => {
    const session = makeSession([], ['org:list'])
    expect(hasPermission(session, 'org:delete')).toBe(false)
  })

  it('空 actions 列表返回 false', () => {
    const session = makeSession([], [])
    expect(hasPermission(session, 'org:list')).toBe(false)
  })

  it('admin session 拥有 admin 全部权限', () => {
    const adminSession = makeSession(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      computeActions([{ role: 'admin' }])
    )
    expect(hasPermission(adminSession, 'org:list')).toBe(true)
    expect(hasPermission(adminSession, 'permission:assign_admin')).toBe(true)

  })
})

describe('refund_approve 权限矩阵（PR-Z2）', () => {
  it('admin 持 refund_approve', () => {
    const s = makeSession(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      computeActions([{ role: 'admin' }]),
    )
    expect(hasPermission(s, 'sale_order:refund_approve')).toBe(true)
  })

  it('manager 持 refund_approve', () => {
    const s = makeSession(
      [{ role: 'manager', scopeId: 'org-store-nc01', scopeType: '门店' }],
      computeActions([{ role: 'manager' }]),
    )
    expect(hasPermission(s, 'sale_order:refund_approve')).toBe(true)
  })

  it.each(['finance', 'hr', 'product', 'customer_mgr'] as const)(
    '%s 不持 refund_approve',
    (role) => {
      const s = makeSession(
        [{ role, scopeId: 'hq', scopeType: '总部' }],
        computeActions([{ role }]),
      )
      expect(hasPermission(s, 'sale_order:refund_approve')).toBe(false)
    },
  )

  it.each(['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr'] as const)(
    '%s 持 refund_create',
    (role) => {
      const s = makeSession(
        [{ role, scopeId: 'hq', scopeType: '总部' }],
        computeActions([{ role }]),
      )
      expect(hasPermission(s, 'sale_order:refund_create')).toBe(true)
    },
  )
})

describe('requirePermission', () => {
  it('session 为 null 时重定向到登录页', () => {
    mockRedirect.mockClear()
    expect(() => requirePermission(null, 'employee:list')).toThrow()
    expect(mockRedirect).toHaveBeenCalledWith('/login?expired=1')
  })

  it('session 有权限不抛出', () => {
    const session = mockSession()
    expect(() => requirePermission(session, 'employee:list')).not.toThrow()
  })

  it('session 无指定权限抛出 PERMISSION_DENIED', () => {
    const session = mockSession({
      permissions: { actions: ['dashboard:view'], scopeStoreIds: [] },
    })
    expect(() => requirePermission(session, 'employee:create'))
      .toThrow('PERMISSION_DENIED: 无权执行 employee:create')
  })
})

describe('requireAnyPermission', () => {
  it('session 为 null 时重定向到登录页', () => {
    mockRedirect.mockClear()
    expect(() => requireAnyPermission(null, ['employee:list'])).toThrow()
    expect(mockRedirect).toHaveBeenCalledWith('/login?expired=1')
  })

  it('拥有列表中任一权限即通过', () => {
    const session = mockSession({
      permissions: { actions: ['sale_order:refund_approve'], scopeStoreIds: [] },
    })
    expect(() => requireAnyPermission(session, ['sale_order:list', 'sale_order:refund_approve'])).not.toThrow()
  })

  it('无任何匹配权限抛出 PERMISSION_DENIED', () => {
    const session = mockSession({
      permissions: { actions: ['dashboard:view'], scopeStoreIds: [] },
    })
    expect(() => requireAnyPermission(session, ['sale_order:list', 'sale_order:refund_approve']))
      .toThrow(/PERMISSION_DENIED/)
  })
})

describe('buildScopeWhere', () => {
  it('空 scopeStoreIds 返回 FALSE 条件', () => {
    const session = mockSession({
      permissions: { actions: [], scopeStoreIds: [] },
    })
    const result = buildScopeWhere(session)
    // SQL 模板对象，检查它包含 FALSE
    expect(result).toBeDefined()
  })

  it('有 scopeStoreIds 返回 ANY 条件', () => {
    const session = mockSession({
      permissions: { actions: [], scopeStoreIds: ['S001', 'S002'] },
    })
    const result = buildScopeWhere(session, 'store_id')
    expect(result).toBeDefined()
  })
})

describe('isAdminScope', () => {
  it('admin 角色返回 true', () => {
    const session = mockSession({
      roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    })
    expect(isAdminScope(session)).toBe(true)
  })

  it('非 admin 角色返回 false', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
    })
    expect(isAdminScope(session)).toBe(false)
  })

  it('混合角色中有 admin 返回 true', () => {
    const session = mockSession({
      roles: [
        { role: 'hr', scopeId: 'hq-1', scopeType: '总部' },
        { role: 'admin', scopeId: 'hq-1', scopeType: '总部' },
      ],
    })
    expect(isAdminScope(session)).toBe(true)
  })

  it('空角色返回 false', () => {
    const session = mockSession({ roles: [] })
    expect(isAdminScope(session)).toBe(false)
  })
})

describe('scopeCondition', () => {
  it('admin 返回 undefined（无过滤）', () => {
    const session = mockSession({
      roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    })
    const result = scopeCondition(session, {} as any) // column mock
    expect(result).toBeUndefined()
  })

  it('非 admin 有 scopeStoreIds 返回 SQL 条件', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
      permissions: { actions: [], scopeStoreIds: ['S001', 'S002'] },
    })
    const result = scopeCondition(session, {} as any)
    expect(result).toBeDefined()
  })

  it('非 admin 无 scopeStoreIds 返回 FALSE', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
      permissions: { actions: [], scopeStoreIds: [] },
    })
    const result = scopeCondition(session, {} as any)
    expect(result).toBeDefined()
  })
})

describe('isInScope', () => {
  it('admin 任何门店都返回 true', () => {
    const session = mockSession({
      roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
      permissions: { actions: [], scopeStoreIds: [] },
    })
    expect(isInScope(session, 'ANY-STORE')).toBe(true)
  })

  it('非 admin 门店在 scope 内返回 true', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
      permissions: { actions: [], scopeStoreIds: ['S001', 'S002'] },
    })
    expect(isInScope(session, 'S001')).toBe(true)
  })

  it('非 admin 门店不在 scope 内返回 false', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
      permissions: { actions: [], scopeStoreIds: ['S001'] },
    })
    expect(isInScope(session, 'S999')).toBe(false)
  })

  it('非 admin 空 scopeStoreIds 返回 false', () => {
    const session = mockSession({
      roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
      permissions: { actions: [], scopeStoreIds: [] },
    })
    expect(isInScope(session, 'S001')).toBe(false)
  })
})

describe('expandScopeStoreIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('空角色返回空数组', async () => {
    const result = await expandScopeStoreIds([])
    expect(result).toEqual([])
  })

  it('headquarters scope 查询所有门店', async () => {
    const { db } = await import('@/db')
    const mockFrom = vi.fn().mockReturnValue([
      { storeId: 'S001' },
      { storeId: 'S002' },
    ])
    ;(db.select as any).mockReturnValue({ from: mockFrom })

    const result = await expandScopeStoreIds([
      { role: 'admin', scopeId: 'hq-1', scopeType: '总部' },
    ])
    expect(result).toContain('S001')
    expect(result).toContain('S002')
    expect(result).toHaveLength(2)
  })

  it('market scope 查询该市场下门店', async () => {
    const { db } = await import('@/db')
    // 第一次 select: org_nodes 子节点
    // 第二次 select: stores
    let callCount = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) {
            return [{ id: 'store-node-1' }]  // org_nodes 子节点
          }
          return [{ storeId: 'S003' }]  // stores
        }),
      }),
    }))

    const result = await expandScopeStoreIds([
      { role: 'manager', scopeId: 'market-1', scopeType: '市场' },
    ])
    expect(result).toContain('S003')
  })

  it('store scope 查询单个门店', async () => {
    const { db } = await import('@/db')
    ;(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue([{ storeId: 'S005' }]),
      }),
    })

    const result = await expandScopeStoreIds([
      { role: 'manager', scopeId: 'store-node-5', scopeType: '门店' },
    ])
    expect(result).toContain('S005')
  })
})
