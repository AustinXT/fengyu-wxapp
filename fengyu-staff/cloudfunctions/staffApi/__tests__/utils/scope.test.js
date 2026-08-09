/**
 * utils/scope 纯函数测试
 * 覆盖 ticket AC-02：staffLevel 归并 + availableLoginLevels 派生 +
 * expandScopeStoreIds SQL 逻辑 + buildStoreScopeCondition
 */

const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
  validateManagementScope,
  expandScopeStoreIds,
  expandScopeOrgNodeIds,
  buildManagementStoreScope,
  buildStoreScopeCondition,
  isStoreInScope,
  assertCustomerInScope,
  assertOrderInScope,
  assertEmployeeInScope,
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

  test('(manager, 总部) + (manager, 市场) + (manager, 门店) → headquarters（三层全开取最高）', () => {
    expect(
      deriveStaffLevel([
        { role: 'manager', scopeType: '总部' },
        { role: 'manager', scopeType: '市场' },
        { role: 'manager', scopeType: '门店' },
      ])
    ).toBe('headquarters')
  })

  test('门店级 finance + customer_mgr + hr 同时 → store_staff（无 manager 门店则全归 store_staff）', () => {
    expect(
      deriveStaffLevel([
        { role: 'finance', scopeType: '门店' },
        { role: 'customer_mgr', scopeType: '门店' },
        { role: 'hr', scopeType: '门店' },
      ])
    ).toBe('store_staff')
  })

  test('(manager, 门店) + (finance, 门店) → store_manager（同人多角色，manager 门店优先于其他门店角色）', () => {
    expect(
      deriveStaffLevel([
        { role: 'manager', scopeType: '门店' },
        { role: 'finance', scopeType: '门店' },
      ])
    ).toBe('store_manager')
  })

  test('(staff, 门店) → store_staff', () => {
    expect(deriveStaffLevel([{ role: 'staff', scopeType: '门店' }])).toBe('store_staff')
  })

  test('(product, 总部) → headquarters', () => {
    expect(deriveStaffLevel([{ role: 'product', scopeType: '总部' }])).toBe('headquarters')
  })
})

describe('deriveAvailableLoginLevels', () => {
  test('任意有门店 scope 的层级 + dashboard 权限 → [store, management]', () => {
    expect(deriveAvailableLoginLevels('store_staff', ['s1'], true)).toEqual([
      'store',
      'management',
    ])
  })

  test('没有 dashboard 权限时，即使有 scope 也只有门店模式', () => {
    expect(deriveAvailableLoginLevels('store_manager', ['s1'], false)).toEqual(['store'])
    expect(deriveAvailableLoginLevels('headquarters', ['s1'], false)).toEqual(['store'])
  })

  test('store_manager + 空 scope → [store]（无门店不能开放管理层）', () => {
    expect(deriveAvailableLoginLevels('store_manager', [], true)).toEqual(['store'])
  })

  test('headquarters 有 store + dashboard → [store, management]', () => {
    expect(deriveAvailableLoginLevels('headquarters', ['s1', 's2'], true)).toEqual([
      'store',
      'management',
    ])
  })

  test('headquarters 无 store → []（即使有 dashboard 也不进入空管理视图）', () => {
    expect(deriveAvailableLoginLevels('headquarters', [], true)).toEqual([])
  })

  test('market 无 store → []', () => {
    expect(deriveAvailableLoginLevels('market', [], true)).toEqual([])
  })

  test('market 有 store + dashboard → [store, management]', () => {
    expect(deriveAvailableLoginLevels('market', ['s1'], true)).toEqual(['store', 'management'])
  })

  test('null → []', () => {
    expect(deriveAvailableLoginLevels(null, [], true)).toEqual([])
  })
})

describe('validateManagementScope', () => {
  const hqAuth = {
    staffLevel: 'headquarters',
    roleBindings: [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
    scopeStoreIds: ['s1', 'sX'],
    scopeOrgNodeIds: ['mX', 'mY'],
  }
  const marketAuth = {
    staffLevel: 'market',
    roleBindings: [{ role: 'manager', scopeId: 'm1', scopeType: '市场' }],
    scopeStoreIds: ['s1'],
    scopeOrgNodeIds: ['m1', 'm1-child'],
  }
  // 边缘：manager@门店A + customer_mgr@门店B → 管理层使用全部 scopeStoreIds。
  const storeManagerAuth = {
    staffLevel: 'store_manager',
    roleBindings: [
      { role: 'manager', scopeId: 'node-A', scopeType: '门店' },
      { role: 'customer_mgr', scopeId: 'node-B', scopeType: '门店' },
    ],
    scopeStoreIds: ['A', 'B'],
    scopeOrgNodeIds: ['node-A', 'node-B'],
    managerStoreIds: ['A'],
  }

  test('总部 scope 可查看全部，并按完整 scope 校验 market/store', () => {
    expect(() => validateManagementScope(hqAuth, 'all', null)).not.toThrow()
    expect(() => validateManagementScope(hqAuth, 'market', 'mX')).not.toThrow()
    expect(() => validateManagementScope(hqAuth, 'store', 'sX')).not.toThrow()
    expect(() => validateManagementScope(hqAuth, 'market', 'mOther')).toThrow(/PERMISSION_DENIED/)
  })

  test('market: all 拒绝', () => {
    expect(() => validateManagementScope(marketAuth, 'all', null)).toThrow(/PERMISSION_DENIED/)
  })
  test('market: 他人 market 拒绝', () => {
    expect(() => validateManagementScope(marketAuth, 'market', 'mOther')).toThrow(/PERMISSION_DENIED/)
  })
  test('market: 自己 market 通过', () => {
    expect(() => validateManagementScope(marketAuth, 'market', 'm1')).not.toThrow()
  })
  test('market: 下属 market 通过', () => {
    expect(() => validateManagementScope(marketAuth, 'market', 'm1-child')).not.toThrow()
  })
  test('market: 自己 store 通过', () => {
    expect(() => validateManagementScope(marketAuth, 'store', 's1')).not.toThrow()
  })
  test('market: 他人 store 拒绝', () => {
    expect(() => validateManagementScope(marketAuth, 'store', 'sOther')).toThrow(/PERMISSION_DENIED/)
  })

  test('门店店长管理层：使用全部角色的 scopeStoreIds，不受 managerStoreIds 收紧', () => {
    expect(() => validateManagementScope(storeManagerAuth, 'store', 'A')).not.toThrow()
    expect(() => validateManagementScope(storeManagerAuth, 'store', 'B')).not.toThrow()
  })
  test('无总部 scope 的门店级账号：all 拒绝', () => {
    expect(() => validateManagementScope(storeManagerAuth, 'all', null)).toThrow(/PERMISSION_DENIED/)
  })
  test('没有被授权的 market：拒绝', () => {
    expect(() => validateManagementScope(storeManagerAuth, 'market', 'm1')).toThrow(/PERMISSION_DENIED/)
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

  test('市场 scope → 递归包含嵌套市场下的门店', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([
        { store_id: 'S-direct' },
        { store_id: 'S-nested-market' },
      ]),
    }
    const result = await expandScopeStoreIds(
      [{ role: 'hr', scopeId: 'market-1', scopeType: '市场' }],
      pg
    )
    expect(result.sort()).toEqual(['S-direct', 'S-nested-market'])
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).toContain('WITH RECURSIVE descendants')
    expect(pg.query.mock.calls[0][0]).toContain('child.parent_id = descendants.id')
    expect(pg.query.mock.calls[0][0]).toContain('unnest($1::text[])')
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
    expect(pg.query.mock.calls[0][0]).toContain('WITH RECURSIVE descendants')
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

  test('市场 + 门店组合 → 单次递归查询并集去重', async () => {
    const pg = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          { store_id: 'S1' },
          { store_id: 'S2' },
          { store_id: 'S2' },
          { store_id: 'S3' },
        ]),
    }
    const result = await expandScopeStoreIds(
      [
        { role: 'hr', scopeId: 'm1', scopeType: '市场' },
        { role: 'manager', scopeId: 'sn3', scopeType: '门店' },
      ],
      pg
    )
    expect(result.sort()).toEqual(['S1', 'S2', 'S3'])
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).toContain('WITH RECURSIVE descendants')
    expect(pg.query.mock.calls[0][0]).toContain('unnest($1::text[])')
    expect(pg.query.mock.calls[0][0]).not.toContain('unnest($2::text[])')
    expect(pg.query.mock.calls[0][1]).toEqual([['m1', 'sn3']])
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

describe('expandScopeOrgNodeIds', () => {
  test('市场 scope 展开自身与任意层级下属节点', async () => {
    const pg = {
      query: vi.fn().mockResolvedValueOnce([
        { id: 'market-1' },
        { id: 'dept-1' },
        { id: 'store-1' },
      ]),
    }

    const result = await expandScopeOrgNodeIds(
      [{ role: 'hr', scopeId: 'market-1', scopeType: '市场' }],
      pg,
    )

    expect(result).toEqual(['market-1', 'dept-1', 'store-1'])
    expect(pg.query.mock.calls[0][0]).toContain('WITH RECURSIVE descendants')
    expect(pg.query.mock.calls[0][0]).toContain('child.parent_id = descendants.id')
    expect(pg.query.mock.calls[0][1]).toEqual([['market-1']])
  })

  test('总部 scope 返回全部组织节点', async () => {
    const pg = { query: vi.fn().mockResolvedValueOnce([{ id: 'hq' }, { id: 'market-1' }]) }

    await expect(expandScopeOrgNodeIds(
      [{ role: 'admin', scopeId: 'hq', scopeType: '总部' }],
      pg,
    )).resolves.toEqual(['hq', 'market-1'])
    expect(pg.query).toHaveBeenCalledWith('SELECT id FROM org_nodes')
  })
})

describe('buildManagementStoreScope', () => {
  test('market 使用递归子树门店条件', () => {
    const condition = buildManagementStoreScope('market', 'market-1', 'so.store_id', 4)

    expect(condition.params).toEqual(['market-1'])
    expect(condition.sql).toContain('so.store_id IN')
    expect(condition.sql).toContain('WITH RECURSIVE descendants')
    expect(condition.sql).toContain('SELECT $4::text')
    expect(condition.sql).toContain('child.parent_id = descendants.id')
  })

  test('all 和 store 保持原有条件与参数位置', () => {
    expect(buildManagementStoreScope('all', undefined, 'so.store_id', 2))
      .toEqual({ sql: 'TRUE', params: [] })
    expect(buildManagementStoreScope('store', 'S1', 'so.store_id', 2))
      .toEqual({ sql: 'so.store_id = $2', params: ['S1'] })
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

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY v3 §2 #13：scope assert helper 单元测试
// ticket: notes/tickets/2026-05-17-scope-helper-cross-end-audit.md
// ─────────────────────────────────────────────────────────────────────────────

describe('isStoreInScope（纯函数）', () => {
  test('门店模式：等于 effectiveStoreId → true', () => {
    expect(isStoreInScope({ loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: [] }, 'S1')).toBe(true)
  })
  test('门店模式：不等于 effectiveStoreId → false', () => {
    expect(isStoreInScope({ loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: ['S1', 'S2'] }, 'S2')).toBe(false)
  })
  test('管理层模式：在 scopeStoreIds 内 → true', () => {
    expect(isStoreInScope({ loginLevel: 'management', effectiveStoreId: null, scopeStoreIds: ['S1', 'S2'] }, 'S2')).toBe(true)
  })
  test('管理层模式：不在 scopeStoreIds 内 → false', () => {
    expect(isStoreInScope({ loginLevel: 'management', effectiveStoreId: null, scopeStoreIds: ['S1'] }, 'S2')).toBe(false)
  })
  test('storeId 为空 → false（防 null 越权）', () => {
    expect(isStoreInScope({ loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: [] }, null)).toBe(false)
    expect(isStoreInScope({ loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: [] }, undefined)).toBe(false)
    expect(isStoreInScope({ loginLevel: 'store', effectiveStoreId: 'S1', scopeStoreIds: [] }, '')).toBe(false)
  })
})

/**
 * 构造一个最小可用 pg client mock。
 * 每个测试用例传入自定义 row 序列即可。
 */
function makePgMock(rowQueue) {
  const queries = []
  return {
    queries,
    query: vi.fn(async (sql, params) => {
      queries.push({ sql, params })
      const next = rowQueue.shift()
      return next === undefined ? [] : next
    }),
  }
}

describe('assertCustomerInScope', () => {
  test('缺 clientUserId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertCustomerInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' })).rejects.toThrow(
      /INVALID_PARAMS:\s*缺少\s*clientUserId/,
    )
    expect(client.queries.length).toBe(0)
  })

  test('顾客不存在 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[]])
    await expect(
      assertCustomerInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'U_NOT_EXIST'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*顾客不存在/)
  })

  test('顾客绑店不在 scope → PERMISSION_DENIED', async () => {
    const client = makePgMock([[{ bound_store_id: 'S99' }]])
    await expect(
      assertCustomerInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'U1'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*顾客不在当前门店范围内/)
  })

  test('顾客在 scope → 返回 boundStoreId', async () => {
    const client = makePgMock([[{ bound_store_id: 'S1' }]])
    const result = await assertCustomerInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'U1')
    expect(result).toEqual({ boundStoreId: 'S1' })
  })

  test('管理层模式：顾客绑店 ∈ scopeStoreIds → 通过', async () => {
    const client = makePgMock([[{ bound_store_id: 'S2' }]])
    const result = await assertCustomerInScope(
      client,
      { loginLevel: 'management', effectiveStoreId: null, scopeStoreIds: ['S1', 'S2'] },
      'U1',
    )
    expect(result).toEqual({ boundStoreId: 'S2' })
  })
})

describe('assertOrderInScope', () => {
  test('缺 saleOrderId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertOrderInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' })).rejects.toThrow(
      /INVALID_PARAMS:\s*缺少\s*saleOrderId/,
    )
  })

  test('订单不存在 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[]])
    await expect(
      assertOrderInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'FY-XSD-WX-NOT'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*订单不存在/)
  })

  test('订单 store_id 不在 scope → PERMISSION_DENIED', async () => {
    const client = makePgMock([[{ store_id: 'S99' }]])
    await expect(
      assertOrderInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'FY-XSD-WX-001'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*订单不在当前门店范围内/)
  })

  test('订单 store_id 等于 effectiveStoreId → 返回 storeId', async () => {
    const client = makePgMock([[{ store_id: 'S1' }]])
    const result = await assertOrderInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1' }, 'FY-XSD-WX-001')
    expect(result).toEqual({ storeId: 'S1' })
  })
})

describe('assertEmployeeInScope', () => {
  test('缺 employeeId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertEmployeeInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1', staffWfId: 'E1' })).rejects.toThrow(
      /INVALID_PARAMS:\s*缺少\s*employeeId/,
    )
  })

  test('查询自己 → 无条件通过（不走 DB）', async () => {
    const client = makePgMock([])
    const result = await assertEmployeeInScope(
      client,
      { loginLevel: 'store', effectiveStoreId: 'S1', staffWfId: 'E1', storeId: 'S1' },
      'E1',
    )
    expect(result).toEqual({ storeId: 'S1' })
    expect(client.queries.length).toBe(0) // 自查无需 DB
  })

  test('员工不存在 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[]])
    await expect(
      assertEmployeeInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1', staffWfId: 'E0' }, 'E_NOT_EXIST'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*员工不存在/)
  })

  test('员工 store_id 不在 scope → PERMISSION_DENIED', async () => {
    const client = makePgMock([[{ store_id: 'S99' }]])
    await expect(
      assertEmployeeInScope(client, { loginLevel: 'store', effectiveStoreId: 'S1', staffWfId: 'E0' }, 'E1'),
    ).rejects.toThrow(/PERMISSION_DENIED:\s*员工不在当前门店范围内/)
  })

  test('员工在 scope → 返回 storeId', async () => {
    const client = makePgMock([[{ store_id: 'S1' }]])
    const result = await assertEmployeeInScope(
      client,
      { loginLevel: 'store', effectiveStoreId: 'S1', staffWfId: 'E0' },
      'E1',
    )
    expect(result).toEqual({ storeId: 'S1' })
  })
})
