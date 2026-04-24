/**
 * utils/scope 纯函数测试
 * 覆盖 ticket AC-02：staffLevel 归并 + availableLoginLevels 派生 +
 * expandScopeStoreIds SQL 逻辑 + buildStoreScopeCondition
 */

const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  expandScopeStoreIds,
  buildStoreScopeCondition,
} = require('../../utils/scope')

describe('deriveStaffLevel', () => {
  test('(admin, 总部) → headquarters', () => {
    expect(deriveStaffLevel([{ role: 'admin', scopeType: '总部' }])).toBe('headquarters')
  })

  test('(manager, 门店) → store_manager', () => {
    expect(deriveStaffLevel([{ role: 'manager', scopeType: '门店' }])).toBe('store_manager')
  })

  test('(hr, 市场) → market', () => {
    expect(deriveStaffLevel([{ role: 'hr', scopeType: '市场' }])).toBe('market')
  })

  test('(customer_mgr, 门店) → store_staff', () => {
    expect(
      deriveStaffLevel([{ role: 'customer_mgr', scopeType: '门店' }])
    ).toBe('store_staff')
  })

  test('(admin, 总部) + (manager, 门店) → headquarters（取高）', () => {
    expect(
      deriveStaffLevel([
        { role: 'admin', scopeType: '总部' },
        { role: 'manager', scopeType: '门店' },
      ])
    ).toBe('headquarters')
  })

  test('(hr, 市场) + (manager, 门店) → market（取高）', () => {
    expect(
      deriveStaffLevel([
        { role: 'hr', scopeType: '市场' },
        { role: 'manager', scopeType: '门店' },
      ])
    ).toBe('market')
  })

  test('(hr, 部门) → null（部门不参与）', () => {
    expect(deriveStaffLevel([{ role: 'hr', scopeType: '部门' }])).toBeNull()
  })

  test('[] → null', () => {
    expect(deriveStaffLevel([])).toBeNull()
  })

  test('非法输入 → null', () => {
    expect(deriveStaffLevel(null)).toBeNull()
    expect(deriveStaffLevel(undefined)).toBeNull()
  })

  test('多 (manager, 门店) → store_manager（多店店长）', () => {
    expect(
      deriveStaffLevel([
        { role: 'manager', scopeType: '门店' },
        { role: 'manager', scopeType: '门店' },
      ])
    ).toBe('store_manager')
  })

  test('(finance, 门店) → store_staff（门店非 manager 角色归 store_staff）', () => {
    expect(
      deriveStaffLevel([{ role: 'finance', scopeType: '门店' }])
    ).toBe('store_staff')
  })
})

describe('deriveAvailableLoginLevels', () => {
  test('store_manager → [store]', () => {
    expect(deriveAvailableLoginLevels('store_manager', ['s1'])).toEqual(['store'])
  })

  test('store_staff → [store]', () => {
    expect(deriveAvailableLoginLevels('store_staff', ['s1'])).toEqual(['store'])
  })

  test('headquarters 有 store → [store, management]', () => {
    expect(deriveAvailableLoginLevels('headquarters', ['s1', 's2'])).toEqual([
      'store',
      'management',
    ])
  })

  test('headquarters 无 store → [management]', () => {
    expect(deriveAvailableLoginLevels('headquarters', [])).toEqual(['management'])
  })

  test('market 无 store → [management]', () => {
    expect(deriveAvailableLoginLevels('market', [])).toEqual(['management'])
  })

  test('market 有 store → [store, management]', () => {
    expect(deriveAvailableLoginLevels('market', ['s1'])).toEqual(['store', 'management'])
  })

  test('null → []', () => {
    expect(deriveAvailableLoginLevels(null, [])).toEqual([])
  })
})

describe('expandScopeStoreIds', () => {
  test('空 roleBindings → []', async () => {
    const pg = { query: vi.fn() }
    expect(await expandScopeStoreIds([], pg)).toEqual([])
    expect(pg.query).not.toHaveBeenCalled()
  })

  test('总部 scope → 全量门店', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([
        { store_id: 'S1' },
        { store_id: 'S2' },
        { store_id: 'S3' },
      ]),
    }
    const result = await expandScopeStoreIds(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      pg
    )
    expect(result.sort()).toEqual(['S1', 'S2', 'S3'])
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).toMatch(/FROM stores/i)
  })

  test('市场 scope → 该市场下所有门店', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }]),
    }
    const result = await expandScopeStoreIds(
      [{ role: 'hr', scopeId: 'market-1', scopeType: '市场' }],
      pg
    )
    expect(result.sort()).toEqual(['S1', 'S2'])
    expect(pg.query.mock.calls[0][1]).toEqual([['market-1']])
  })

  test('门店 scope → 通过 org_node_id 反查', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([{ store_id: 'S1' }]),
    }
    const result = await expandScopeStoreIds(
      [{ role: 'manager', scopeId: 'org-node-store-1', scopeType: '门店' }],
      pg
    )
    expect(result).toEqual(['S1'])
    expect(pg.query.mock.calls[0][1]).toEqual([['org-node-store-1']])
  })

  test('总部 + 门店 组合 → 总部一次拉全（跳过门店查询）', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }]),
    }
    const result = await expandScopeStoreIds(
      [
        { role: 'admin', scopeId: 'hq', scopeType: '总部' },
        { role: 'manager', scopeId: 'store-node-1', scopeType: '门店' },
      ],
      pg
    )
    expect(result.sort()).toEqual(['S1', 'S2'])
    expect(pg.query).toHaveBeenCalledTimes(1) // 总部短路
  })

  test('市场 + 门店 组合 → 并集去重', async () => {
    const pg = {
      query: vi
        .fn()
        .mockResolvedValueOnce([{ store_id: 'S1' }, { store_id: 'S2' }]) // 市场
        .mockResolvedValueOnce([{ store_id: 'S2' }, { store_id: 'S3' }]), // 门店（含重复）
    }
    const result = await expandScopeStoreIds(
      [
        { role: 'hr', scopeId: 'm1', scopeType: '市场' },
        { role: 'manager', scopeId: 'sn3', scopeType: '门店' },
      ],
      pg
    )
    expect(result.sort()).toEqual(['S1', 'S2', 'S3'])
    expect(pg.query).toHaveBeenCalledTimes(2)
  })

  test('部门 scope 忽略，不触发查询', async () => {
    const pg = { query: vi.fn() }
    const result = await expandScopeStoreIds(
      [{ role: 'hr', scopeId: 'dept-1', scopeType: '部门' }],
      pg
    )
    expect(result).toEqual([])
    expect(pg.query).not.toHaveBeenCalled()
  })
})

describe('buildStoreScopeCondition', () => {
  test('门店模式：生成单值 where', () => {
    const c = buildStoreScopeCondition(
      { loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: ['S1'] },
      'o.store_id',
      1
    )
    expect(c).toEqual({ sql: 'o.store_id = $1', params: ['S1'] })
  })

  test('管理层模式：生成 ANY(array) where', () => {
    const c = buildStoreScopeCondition(
      { loginLevel: 'management', effectiveStoreId: null, scopeStoreIds: ['S1', 'S2'] },
      'store_id',
      3
    )
    expect(c).toEqual({ sql: 'store_id = ANY($3::text[])', params: [['S1', 'S2']] })
  })

  test('管理层 + 空 scope → FALSE 恒假', () => {
    const c = buildStoreScopeCondition(
      { loginLevel: 'management', effectiveStoreId: null, scopeStoreIds: [] },
      'store_id',
      1
    )
    expect(c.sql).toBe('FALSE')
  })

  test('门店模式 + 缺 effectiveStoreId → FALSE 恒假', () => {
    const c = buildStoreScopeCondition(
      { loginLevel: 'store', effectiveStoreId: null, scopeStoreIds: ['S1'] },
      'store_id',
      1
    )
    expect(c.sql).toBe('FALSE')
  })

  test('startIndex 参数正确传递', () => {
    const c = buildStoreScopeCondition(
      { loginLevel: 'store', effectiveStoreId: 'S5', scopeStoreIds: ['S5'] },
      'store_id',
      7
    )
    expect(c.sql).toBe('store_id = $7')
  })
})
