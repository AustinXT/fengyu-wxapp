/**
 * auth 中间件 staffLevel / loginLevel 集成测试
 * 覆盖 ticket AC-02、AC-03
 */

const cloud = globalThis.__mocks__.cloud
const pg = globalThis.__mocks__.pg
const {
  auth,
  requireManager,
  requireManagementLevel,
  invalidateAuthCache,
  _resolveRuntimeAuth,
} = require('../../middleware/auth')
const { invalidatePermissionMatrixCache } = require('../../utils/permission-matrix')

function clearAllCaches() {
  for (const k of [
    'openid-hq',
    'openid-hq-no-store',
    'openid-market',
    'openid-store-manager',
    'openid-store-staff',
    'openid-hq-plus-store',
    'openid-multi-store',
    'openid-unauth',
  ]) {
    invalidateAuthCache(k)
  }
  invalidatePermissionMatrixCache()
}

describe('auth 注入 staffLevel / scopeStoreIds / roleBindings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearAllCaches()
  })

  test('总部 admin + 有门店 → staffLevel=headquarters, scopeStoreIds=全量', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-hq' })
    pg.query
      // 员工信息
      .mockResolvedValueOnce([{
        employee_id: 'emp-hq',
        phone: '13800001111',
        name: 'HQ',
        position_name: '总部员工',
        store_id: null,
        is_resigned: false,
        skills: null,
        store_name: null,
        market_name: null,
        department: null,
      }])
      // 角色 JOIN 结果
      .mockResolvedValueOnce([
        { role: 'admin', scope_id: 'hq-node', scope_type: '总部' },
      ])
      // expandScopeStoreIds - 总部全量
      .mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('headquarters')
    expect(ctx.auth.scopeStoreIds.sort()).toEqual(['S1', 'S2'])
    expect(ctx.auth.roleBindings).toEqual([
      { role: 'admin', roleName: 'admin', isStoreManager: false, scopeId: 'hq-node', scopeType: '总部', scopeName: undefined },
    ])
    expect(ctx.auth.roles).toEqual(['admin'])
    // 无指定 loginLevel → fallback 'store'（因为有 scope）
    expect(ctx.auth.loginLevel).toBe('store')
  })

  test('市场 hr 无可见门店 → 不开放空的管理层视图', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-market' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-mk',
        phone: '13800002222',
        name: 'MK',
        position_name: '市场员',
        store_id: null,
        is_resigned: false,
        skills: null,
        store_name: null,
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'hr', scope_id: 'm1', scope_type: '市场' },
      ])
      // 市场 scope 展开 - 返回空（市场下无门店）
      .mockResolvedValueOnce([])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('market')
    expect(ctx.auth.scopeStoreIds).toEqual([])
    expect(ctx.auth.loginLevel).toBeNull()
    expect(ctx.auth.effectiveStoreId).toBeNull()
  })

  test('门店 manager → loginLevel=store, effectiveStoreId=scopeStoreIds[0]', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-store-manager' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-mgr',
        phone: '13800003333',
        name: 'MGR',
        position_name: '门店经理',
        store_id: 'S1',
        is_resigned: false,
        skills: null,
        store_name: 'S1',
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'manager', scope_id: 'node-s1', scope_type: '门店' },
      ])
      .mockResolvedValueOnce([{ store_id: 'S1' }])

    const ctx = { event: {}, context: {}, auth: {}, result: null }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('store_manager')
    expect(ctx.auth.scopeStoreIds).toEqual(['S1'])
    expect(ctx.auth.loginLevel).toBe('store')
    expect(ctx.auth.effectiveStoreId).toBe('S1')
  })

  test('显式传入 _loginLevel=management → effectiveStoreId=null', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-hq-plus-store' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-hq2',
        phone: '13800004444',
        name: 'HQ2',
        position_name: '总部经理',
        store_id: 'S1',
        is_resigned: false,
        skills: null,
        store_name: 'S1',
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'admin', scope_id: 'hq', scope_type: '总部' },
        { role: 'manager', scope_id: 'node-s1', scope_type: '门店' },
      ])
      // 总部展开全量
      .mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }])

    const ctx = {
      event: { payload: { _loginLevel: 'management' } },
      context: {},
      auth: {},
      result: null,
    }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('headquarters')
    expect(ctx.auth.loginLevel).toBe('management')
    expect(ctx.auth.effectiveStoreId).toBeNull()
    expect(ctx.auth.currentStoreId).toBeNull()
  })

  test('_loginLevel=management 且 manager 拥有 dashboard 权限 → 通过', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-store-manager' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-mgr',
        phone: '13800003333',
        name: 'MGR',
        position_name: '门店经理',
        store_id: 'S1',
        is_resigned: false,
        skills: null,
        store_name: 'S1',
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'manager', scope_id: 'node-s1', scope_type: '门店' },
      ])
      .mockResolvedValueOnce([{ store_id: 'S1' }])
      .mockResolvedValueOnce([{ store_id: 'S1' }])

    const ctx = {
      event: { payload: { _loginLevel: 'management' } },
      context: {},
      auth: {},
      result: null,
    }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('store_manager')
    expect(ctx.auth.loginLevel).toBe('management')
    expect(ctx.auth.hasDataCenterDashboard).toBe(true)
    expect(ctx.auth.effectiveStoreId).toBeNull()
  })

  test('门店级非 manager 角色拥有 dashboard 权限也可进入管理层', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-store-staff' })
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM\s+staff_wechat_users\s+u/.test(sql)) {
        return [{
          employee_id: 'emp-finance',
          phone: '13800006666',
          name: '财务',
          position_name: '门店财务',
          store_id: 'S1',
          is_resigned: false,
          skills: null,
          store_name: 'S1',
          market_name: null,
          department: null,
        }]
      }
      if (/FROM\s+permission_roles\s+pr/.test(sql)) {
        return [{ role: 'finance', scope_id: 'node-s1', scope_type: '门店' }]
      }
      if (/SELECT DISTINCT\s+s\.store_id/.test(sql)) return [{ store_id: 'S1' }]
      if (/SELECT DISTINCT id FROM descendants/.test(sql)) return [{ id: 'node-s1' }]
      if (/permission_matrix/.test(sql)) {
        return [{ value: JSON.stringify({ finance: ['data_center:dashboard'] }) }]
      }
      return []
    })

    const ctx = {
      event: { payload: { _loginLevel: 'management' } },
      context: {},
      auth: {},
      result: null,
    }
    await auth(ctx, async () => {})

    expect(ctx.auth.staffLevel).toBe('store_staff')
    expect(ctx.auth.hasDataCenterDashboard).toBe(true)
    expect(ctx.auth.loginLevel).toBe('management')
    expect(ctx.auth.scopeStoreIds).toEqual(['S1'])
    expect(ctx.auth.effectiveStoreId).toBeNull()
  })

  test('_currentStoreId 不在 scopeStoreIds 内 → 拒绝', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-multi-store' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-multi',
        phone: '13800005555',
        name: 'Multi',
        position_name: '区域经理',
        store_id: 'S1',
        is_resigned: false,
        skills: null,
        store_name: 'S1',
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'manager', scope_id: 'node-s1', scope_type: '门店' },
        { role: 'manager', scope_id: 'node-s2', scope_type: '门店' },
      ])
      .mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }])

    const ctx = {
      event: { payload: { _currentStoreId: 'S999' } },
      context: {},
      auth: {},
      result: null,
    }
    await expect(auth(ctx, async () => {})).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('多店 store_manager 切换 currentStoreId 合法 → 通过', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: 'openid-multi-store' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-multi',
        phone: '13800005555',
        name: 'Multi',
        position_name: '区域经理',
        store_id: 'S1',
        is_resigned: false,
        skills: null,
        store_name: 'S1',
        market_name: null,
        department: null,
      }])
      .mockResolvedValueOnce([
        { role: 'manager', scope_id: 'node-s1', scope_type: '门店' },
        { role: 'manager', scope_id: 'node-s2', scope_type: '门店' },
      ])
      .mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }])

    const ctx = {
      event: { payload: { _currentStoreId: 'S2' } },
      context: {},
      auth: {},
      result: null,
    }
    await auth(ctx, async () => {})

    expect(ctx.auth.effectiveStoreId).toBe('S2')
    expect(ctx.auth.staffLevel).toBe('store_manager')
  })
})

describe('_resolveRuntimeAuth 纯函数边界', () => {
  const base = {
    staffLevel: 'headquarters',
    scopeStoreIds: ['S1', 'S2'],
    fallbackStoreId: 'S1',
  }

  test('loginLevel 不在 available 中 → 抛出', () => {
    expect(() =>
      _resolveRuntimeAuth(
        { staffLevel: 'store_staff', scopeStoreIds: ['S1'], fallbackStoreId: 'S1' },
        'management',
        null
      )
    ).toThrow(/PERMISSION_DENIED/)
  })

  test('非管理职级拥有 dashboard 权限时可显式选择 management', () => {
    const r = _resolveRuntimeAuth(
      { staffLevel: 'store_staff', scopeStoreIds: ['S1'], fallbackStoreId: 'S1' },
      'management',
      null,
      true,
    )
    expect(r).toEqual({ loginLevel: 'management', currentStoreId: null, effectiveStoreId: null })
  })

  test('fallback fallbackStoreId 命中 scope → 用该值', () => {
    const r = _resolveRuntimeAuth(base, 'store', null)
    expect(r.effectiveStoreId).toBe('S1')
  })

  test('fallback fallbackStoreId 不在 scope → 用 scope[0]', () => {
    const r = _resolveRuntimeAuth(
      { staffLevel: 'headquarters', scopeStoreIds: ['S2', 'S3'], fallbackStoreId: 'S1' },
      'store',
      null
    )
    expect(r.effectiveStoreId).toBe('S2')
  })

  test('无 staffLevel 返回全 null', () => {
    const r = _resolveRuntimeAuth(
      { staffLevel: null, scopeStoreIds: [], fallbackStoreId: null },
      null,
      null
    )
    expect(r).toEqual({ loginLevel: null, currentStoreId: null, effectiveStoreId: null })
  })
})

describe('requireManagementLevel', () => {
  test('拥有 dashboard 权限且 management 登录 → 通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'headquarters',
        hasDataCenterDashboard: true,
        loginLevel: 'management',
      },
    }
    let called = false
    await requireManagementLevel()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('market + dashboard + management → 通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'market',
        hasDataCenterDashboard: true,
        loginLevel: 'management',
      },
    }
    await requireManagementLevel()(ctx, async () => {})
  })

  test('store_staff + dashboard + management → 通过（不按职级白名单）', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'store_staff',
        hasDataCenterDashboard: true,
        loginLevel: 'management',
      },
    }
    let called = false
    await requireManagementLevel()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('store_manager + loginLevel=store → 拒绝（loginLevel 闸保留）', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'store_manager',
        hasDataCenterDashboard: true,
        loginLevel: 'store',
      },
    }
    await expect(requireManagementLevel()(ctx, async () => {})).rejects.toThrow(
      /管理层身份登录/
    )
  })

  test('缺 dashboard 权限 → 拒绝（职级不构成旁路）', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'headquarters',
        hasDataCenterDashboard: false,
        loginLevel: 'management',
      },
    }
    await expect(requireManagementLevel()(ctx, async () => {})).rejects.toThrow(
      /PERMISSION_DENIED/
    )
  })

  test('headquarters + loginLevel=store → 拒绝', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        staffLevel: 'headquarters',
        hasDataCenterDashboard: true,
        loginLevel: 'store',
      },
    }
    await expect(requireManagementLevel()(ctx, async () => {})).rejects.toThrow(
      /管理层身份登录/
    )
  })

  test('无 staffWfId → UNAUTHORIZED', async () => {
    const ctx = {
      auth: { staffWfId: null, staffLevel: null, loginLevel: null },
    }
    await expect(requireManagementLevel()(ctx, async () => {})).rejects.toThrow(
      /UNAUTHORIZED/
    )
  })
})

describe('requireManager 基于 roleBindings', () => {
  test('自定义店长能力角色可通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'emp-custom-manager',
        roles: ['role_custom_manager'],
        roleBindings: [{ role: 'role_custom_manager', isStoreManager: true, scopeType: '门店' }],
        loginLevel: 'store',
        effectiveStoreId: 'S1',
        managerStoreIds: ['S1'],
      },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('(manager, 门店) 通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        roleBindings: [{ role: 'manager', scopeId: 'n1', scopeType: '门店' }],
      },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('(manager, 市场) 通过（无选定门店 → 仅校验角色）', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        roleBindings: [{ role: 'manager', scopeId: 'm1', scopeType: '市场' }],
        roles: [],
      },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('(manager, 总部) 通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        roleBindings: [{ role: 'manager', scopeId: 'hq1', scopeType: '总部' }],
        roles: [],
      },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('门店模式：effectiveStoreId 不在 managerStoreIds → 拒绝（精确版越权防护）', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        loginLevel: 'store',
        roleBindings: [{ role: 'manager', scopeId: 'nA', scopeType: '门店' }],
        managerStoreIds: ['A'],
        effectiveStoreId: 'B',
      },
    }
    await expect(requireManager()(ctx, async () => {})).rejects.toThrow(
      /PERMISSION_DENIED.*管辖范围/
    )
  })

  test('门店模式：effectiveStoreId 在 managerStoreIds → 通过', async () => {
    const ctx = {
      auth: {
        staffWfId: 'e1',
        loginLevel: 'store',
        roleBindings: [{ role: 'manager', scopeId: 'nA', scopeType: '门店' }],
        managerStoreIds: ['A', 'B'],
        effectiveStoreId: 'B',
      },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('旧缓存兼容：无 roleBindings + roles 含 manager → 通过', async () => {
    const ctx = {
      auth: { staffWfId: 'e1', roles: ['manager'] },
    }
    let called = false
    await requireManager()(ctx, async () => { called = true })
    expect(called).toBe(true)
  })

  test('空 roleBindings + 无 manager 角色 → 拒绝', async () => {
    const ctx = {
      auth: { staffWfId: 'e1', roleBindings: [], roles: [] },
    }
    await expect(requireManager()(ctx, async () => {})).rejects.toThrow(
      /PERMISSION_DENIED/
    )
  })
})
