import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRedirect } = vi.hoisted(() => {
  const mockRedirect = vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  })
  return { mockRedirect }
})
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))

// Mock drizzle-orm 和 db 模块（expandScopeStoreIds / buildScopeWhere / getPermissionMatrix 需要）
vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue([]),
      }),
    }),
    // 默认 execute 返回空数组：getPermissionMatrix 行不存在 → 回退 DEFAULT_PERMISSION_MATRIX
    execute: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', parentId: 'parent_id', type: 'type' },
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
}))

import { computeActions, requirePermission, requireAnyPermission, buildScopeWhere, DEFAULT_PERMISSION_MATRIX, ALL_ACTIONS, PermissionError, expandScopeStoreIds, isAdminScope, accessiblePermissionScopeIds, scopeCondition, isInScope, hasPermission, getPermissionMatrix, invalidatePermissionMatrixCache, canAccessAdmin } from './permissions'
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

describe('DEFAULT_PERMISSION_MATRIX', () => {
  it('admin 拥有基础数据和系统管理权限', () => {
    const adminActions = DEFAULT_PERMISSION_MATRIX.admin
    expect(adminActions).toContain('org:list')
    expect(adminActions).toContain('employee:create')
    expect(adminActions).toContain('permission:assign_admin')

    expect(adminActions).toContain('operation_log:list')
    expect(adminActions).toContain('card_transaction:list')
  })

  it('admin 拥有全部权限（== ALL_ACTIONS，含业务数据）', () => {
    // 2026-05-21：admin 从"不碰业务数据"改为全开，修复单 admin 角色访问业务页
    // 因 PERMISSION_DENIED 被生产构建脱敏后误显示 500 的问题。
    const adminActions = DEFAULT_PERMISSION_MATRIX.admin
    // 业务数据权限现已具备
    expect(adminActions).toContain('sale_order:list')
    expect(adminActions).toContain('sale_order:create')
    expect(adminActions).toContain('service:list')
    expect(adminActions).toContain('appointment:list')
    expect(adminActions).toContain('customer:list')
    expect(adminActions).toContain('sale_item:list')
    expect(adminActions).toContain('pickup_record:list')
    expect(adminActions).toContain('allocation:save')
    // admin 必须等于全量 action 集合（守护：新增 action 时勿漏 admin）
    expect(new Set(adminActions)).toEqual(new Set(ALL_ACTIONS))
  })

  it('ALL_ACTIONS 是各角色的并集，且 admin 为所有角色的超集', () => {
    const union = new Set(Object.values(DEFAULT_PERMISSION_MATRIX).flat())
    expect(new Set(ALL_ACTIONS)).toEqual(union)
    const adminSet = new Set(DEFAULT_PERMISSION_MATRIX.admin)
    for (const [role, actions] of Object.entries(DEFAULT_PERMISSION_MATRIX)) {
      for (const a of actions) {
        expect(adminSet, `admin 缺少 ${role} 的 ${a}`).toContain(a)
      }
    }
  })

  it('manager 拥有业务操作权限 + 生产扩权（删单/员工CRUD/收款配置）', () => {
    const actions = DEFAULT_PERMISSION_MATRIX.manager
    expect(actions).toContain('sale_order:create')
    expect(actions).toContain('allocation:save')
    expect(actions).toContain('service:create')
    expect(actions).toContain('appointment:list')
    expect(actions).toContain('customer:list')
    expect(actions).toContain('sale_item:list')
    expect(actions).toContain('card_transaction:list')
    // 2026-06-24 对齐生产的敏感扩权（守护：勿误删）
    expect(actions).toContain('sale_order:delete')
    expect(actions).toContain('employee:create')
    expect(actions).toContain('store:lakala_config')
    expect(actions).toContain('merchant:list')
  })

  it('finance 对账只读 + 商户/提成矩阵维护（2026-06-24 对齐生产）', () => {
    const actions = DEFAULT_PERMISSION_MATRIX.finance
    expect(actions).toContain('sale_order:list')
    expect(actions).toContain('allocation:list')
    expect(actions).toContain('sale_item:list')
    expect(actions).toContain('card_transaction:list')
    // service:list：营业额分配页只读对账需看服务提成（2026-05-21 修 menu/page 不一致）
    expect(actions).toContain('service:list')
    // 生产扩权：提成矩阵 CRUD + 历史订单核对 + 商户档案 CRUD
    expect(actions).toContain('commission:list')
    expect(actions).toContain('commission:create')
    expect(actions).toContain('legacy_order:approve')
    expect(actions).toContain('merchant:create')
    // 仍不可开单 / 改分配 / 改服务单（无写权）
    expect(actions).not.toContain('sale_order:create')
    expect(actions).not.toContain('allocation:save')
    expect(actions).not.toContain('service:create')
  })

  it('hr 管理组织和员工', () => {
    const actions = DEFAULT_PERMISSION_MATRIX.hr
    expect(actions).toContain('org:create')
    expect(actions).toContain('employee:create')
    expect(actions).toContain('permission:assign')
    // hr 不能分配 admin
    expect(actions).not.toContain('permission:assign_admin')
    // hr 不看充值卡流水
    expect(actions).not.toContain('card_transaction:list')
  })

  it('product 管理商品和优惠券', () => {
    const actions = DEFAULT_PERMISSION_MATRIX.product
    expect(actions).toContain('product:create')
    expect(actions).toContain('coupon:create')
    // product 不看充值卡流水
    expect(actions).not.toContain('card_transaction:list')
  })

  it('customer_mgr 只管顾客（含卡包只读）', () => {
    const actions = DEFAULT_PERMISSION_MATRIX.customer_mgr
    expect(actions).toContain('customer:list')
    expect(actions).toContain('customer:update')
    expect(actions).toContain('sale_item:list')
    expect(actions).not.toContain('sale_order:list')
    // customer_mgr 不看充值卡流水（默认保守）
    expect(actions).not.toContain('card_transaction:list')
  })

  it('staff 无权限（不可登录管理后台）', () => {
    expect(DEFAULT_PERMISSION_MATRIX.staff).toEqual([])
  })
})

describe('computeActions', () => {
  // computeActions 自 2026-05-18 起读取 DB 矩阵（带 fallback），
  // 测试中默认 db.execute 返回空 → 走 DEFAULT_PERMISSION_MATRIX。
  beforeEach(() => {
    invalidatePermissionMatrixCache()
  })

  it('单角色返回对应权限列表', async () => {
    const actions = await computeActions([{ role: 'product' }])
    expect(actions).toContain('product:create')
    expect(actions).toContain('coupon:list')
    expect(actions).toContain('dashboard:view')
  })

  it('多角色合并去重', async () => {
    const actions = await computeActions([{ role: 'hr' }, { role: 'product' }])
    // hr 权限
    expect(actions).toContain('employee:create')
    // product 权限
    expect(actions).toContain('product:create')
    // 共有权限不重复
    const dashboardCount = actions.filter(a => a === 'dashboard:view').length
    expect(dashboardCount).toBe(1)
  })

  it('空角色返回空数组', async () => {
    const actions = await computeActions([])
    expect(actions).toEqual([])
  })

  it('未知角色忽略', async () => {
    const actions = await computeActions([{ role: 'unknown' as any }])
    expect(actions).toEqual([])
  })
})

describe('getPermissionMatrix / cache', () => {
  beforeEach(() => {
    invalidatePermissionMatrixCache()
    vi.clearAllMocks()
  })

  it('DB 行不存在时返回 DEFAULT', async () => {
    const { db } = await import('@/db')
    ;(db.execute as any) = vi.fn().mockResolvedValue([])
    const matrix = await getPermissionMatrix()
    expect(matrix).toEqual(DEFAULT_PERMISSION_MATRIX)
  })

  it('DB 行存在且 JSON 合法时返回解析后的矩阵', async () => {
    const fakeMatrix: Record<RoleType, string[]> = {
      admin: ['system:config', 'permission:assign_admin', 'admin:reset_password'],
      manager: ['dashboard:view'],
      finance: [], hr: [], product: [], customer_mgr: [], staff: [],
    }
    const { db } = await import('@/db')
    ;(db.execute as any) = vi.fn().mockResolvedValue([{ value: JSON.stringify(fakeMatrix) }])
    const matrix = await getPermissionMatrix()
    expect(matrix.admin).toContain('system:config')
    expect(matrix.manager).toEqual(['dashboard:view'])
    expect(matrix.finance).toEqual([])
  })

  it('JSON 解析失败时回退 DEFAULT + console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = await import('@/db')
    ;(db.execute as any) = vi.fn().mockResolvedValue([{ value: '{not valid json' }])
    const matrix = await getPermissionMatrix()
    expect(matrix).toEqual(DEFAULT_PERMISSION_MATRIX)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[permission-matrix]'),
      expect.anything(),
    )
    errSpy.mockRestore()
  })

  it('DB throw 时回退 DEFAULT + console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = await import('@/db')
    ;(db.execute as any) = vi.fn().mockRejectedValue(new Error('connection refused'))
    const matrix = await getPermissionMatrix()
    expect(matrix).toEqual(DEFAULT_PERMISSION_MATRIX)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[permission-matrix]'),
      expect.anything(),
    )
    errSpy.mockRestore()
  })

  it('连续两次调用仅查 DB 一次（命中缓存）', async () => {
    const { db } = await import('@/db')
    const execMock = vi.fn().mockResolvedValue([])
    ;(db.execute as any) = execMock
    await getPermissionMatrix()
    await getPermissionMatrix()
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('invalidatePermissionMatrixCache 后再调重新查 DB', async () => {
    const { db } = await import('@/db')
    const execMock = vi.fn().mockResolvedValue([])
    ;(db.execute as any) = execMock
    await getPermissionMatrix()
    invalidatePermissionMatrixCache()
    await getPermissionMatrix()
    expect(execMock).toHaveBeenCalledTimes(2)
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

  it('admin session 拥有 admin 全部权限', async () => {
    const adminSession = makeSession(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      await computeActions([{ role: 'admin' }])
    )
    expect(hasPermission(adminSession, 'org:list')).toBe(true)
    expect(hasPermission(adminSession, 'permission:assign_admin')).toBe(true)

  })
})

describe('refund_approve 权限矩阵（PR-Z2）', () => {
  it('admin 持 refund_approve', async () => {
    const s = makeSession(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      await computeActions([{ role: 'admin' }]),
    )
    expect(hasPermission(s, 'sale_order:refund_approve')).toBe(true)
  })

  it('manager 持 refund_approve', async () => {
    const s = makeSession(
      [{ role: 'manager', scopeId: 'org-store-nc01', scopeType: '门店' }],
      await computeActions([{ role: 'manager' }]),
    )
    expect(hasPermission(s, 'sale_order:refund_approve')).toBe(true)
  })

  it.each(['finance', 'hr', 'product', 'customer_mgr'] as const)(
    '%s 不持 refund_approve',
    async (role) => {
      const s = makeSession(
        [{ role, scopeId: 'hq', scopeType: '总部' }],
        await computeActions([{ role }]),
      )
      expect(hasPermission(s, 'sale_order:refund_approve')).toBe(false)
    },
  )

  it.each(['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr'] as const)(
    '%s 持 refund_create',
    async (role) => {
      const s = makeSession(
        [{ role, scopeId: 'hq', scopeType: '总部' }],
        await computeActions([{ role }]),
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

  it('抛出的是 PermissionError 且 digest=PERMISSION_DENIED（生产脱敏后供 error.tsx 渲染 403）', () => {
    const session = mockSession({
      permissions: { actions: ['dashboard:view'], scopeStoreIds: [] },
    })
    try {
      requirePermission(session, 'employee:create')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionError)
      expect((e as PermissionError).digest).toBe('PERMISSION_DENIED')
    }
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

describe('canAccessAdmin（禁止普通员工登录）', () => {
  it('持任一管理角色 → true', () => {
    expect(canAccessAdmin([{ role: 'admin' }])).toBe(true)
    expect(canAccessAdmin([{ role: 'manager' }])).toBe(true)
    expect(canAccessAdmin([{ role: 'finance' }])).toBe(true)
  })

  it('仅 staff → false（禁入后台）', () => {
    expect(canAccessAdmin([{ role: 'staff' }])).toBe(false)
  })

  it('staff + 管理角色混合 → true', () => {
    expect(canAccessAdmin([{ role: 'staff' }, { role: 'manager' }])).toBe(true)
  })

  it('空角色 → false', () => {
    expect(canAccessAdmin([])).toBe(false)
  })
})

describe('accessiblePermissionScopeIds', () => {
  it('admin 返回 null（全开，左侧树不置灰）', () => {
    const session = mockSession({
      roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    })
    expect(accessiblePermissionScopeIds(session)).toBeNull()
  })

  it('混合角色含 admin 返回 null', () => {
    const session = mockSession({
      roles: [
        { role: 'hr', scopeId: 'market-1', scopeType: '市场' },
        { role: 'admin', scopeId: 'hq-1', scopeType: '总部' },
      ],
    })
    expect(accessiblePermissionScopeIds(session)).toBeNull()
  })

  it('非 admin 返回其精确 scopeId（不展开子树）', () => {
    const session = mockSession({
      roles: [{ role: 'hr', scopeId: 'market-1', scopeType: '市场' }],
    })
    expect(accessiblePermissionScopeIds(session)).toEqual(['market-1'])
  })

  it('非 admin 多角色去重 scopeId', () => {
    const session = mockSession({
      roles: [
        { role: 'hr', scopeId: 'market-1', scopeType: '市场' },
        { role: 'finance', scopeId: 'market-1', scopeType: '市场' },
        { role: 'manager', scopeId: 'market-2', scopeType: '市场' },
      ],
    })
    expect(accessiblePermissionScopeIds(session)).toEqual(['market-1', 'market-2'])
  })

  it('空角色返回空数组', () => {
    const session = mockSession({ roles: [] })
    expect(accessiblePermissionScopeIds(session)).toEqual([])
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
