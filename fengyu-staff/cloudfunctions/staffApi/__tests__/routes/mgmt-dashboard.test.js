/**
 * mgmtDashboard 路由测试 — summary action
 *
 * 覆盖：
 *   - 入参/权限校验（INVALID_PARAMS / PERMISSION_DENIED）
 *   - scopeType=all/market/store 三套 SQL 形态
 *   - "今日"/"本月" 时间窗口 SQL
 *   - 月店均计算 + storeCount=0 防除零
 *   - 生美 vs 全店 区分
 *   - 新会员 SQL 命中 old_member_level IS NULL
 *   - 项目数真实出数 + SQL 形态断言
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createManagerCtx } = require('../helpers')
const { summary, scopeOptions, __resetMarketsCache } = require('../../routes/mgmt-dashboard')

// ---- ctx 构造 ----
function makeHqCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'headquarters',
      loginLevel: 'management',
      roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      scopeStoreIds: ['store-001', 'store-002'],
    },
  })
}

function makeMarketCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'market',
      loginLevel: 'management',
      roleBindings: [{ role: 'manager', scopeId: 'mkt-A', scopeType: '市场' }],
      scopeStoreIds: ['store-001'],
    },
  })
}

// ---- 默认 mock：根据 SQL 形态返回对应 shape ----
function setupDefaultMocks({
  metricValue = 100,
  storeCount = 5,
  marketName = '华东市场',
  storeName = '凤御A店',
} = {}) {
  pg.query.mockReset().mockImplementation(async (sql) => {
    if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) {
      return [{ cnt: storeCount }]
    }
    if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) {
      return [{ store_name: storeName }]
    }
    return [{ v: metricValue }]
  })
}

describe('mgmtDashboard.summary 参数与权限校验', () => {
  test('缺 date 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*date/)
  })

  test('日期格式错误抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026/04/25', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*YYYY-MM-DD/)
  })

  test('未知 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'foo' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeId/)
  })

  test('store_manager 账号被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({ date: '2026-04-25', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ date: '2026-04-25', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号选其他 market → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({
      date: '2026-04-25',
      scopeType: 'market',
      scopeId: 'mkt-B',
    })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
  })

  test('market 账号选 scopeStoreIds 之外的 store → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({
      date: '2026-04-25',
      scopeType: 'store',
      scopeId: 'store-X',
    })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*门店/)
  })

  test('market 账号选自己市场 → 通过校验', async () => {
    setupDefaultMocks()
    const ctx = makeMarketCtx({
      date: '2026-04-25',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await summary(ctx)
    expect(ctx.result.scope).toEqual({ type: 'market', id: 'mkt-A', name: '华东市场' })
  })
})

describe('mgmtDashboard.summary scopeType=all', () => {
  test('SQL WHERE 含 TRUE，metric 不含 store_id 过滤；storeCount 来自 org_nodes 全表', async () => {
    setupDefaultMocks({ metricValue: 100, storeCount: 5 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const metricSqls = sqlList.filter((s) =>
      /sale_orders|service_orders|client_wechat_users|staff_wechat_users/.test(s),
    )
    // 10 个时间相关指标 × 2（today + month）= 20；+ 3 个截面（member/retained/employee）= 23
    expect(metricSqls.length).toBe(23)
    for (const s of metricSqls) {
      expect(s).toMatch(/WHERE\s+TRUE/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
      expect(s).not.toMatch(/store_id\s+IN\s*\(/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
    }

    const storeCountSql = sqlList.find(
      (s) => /FROM org_nodes WHERE type = '门店'/.test(s) && /COUNT\(\*\)/.test(s),
    )
    expect(storeCountSql).toBeDefined()
    expect(storeCountSql).not.toMatch(/parent_id/)

    expect(ctx.result.storeCount).toBe(5)
    expect(ctx.result.scope).toEqual({ type: 'all', id: null, name: '全部市场' })
  })
})

describe('mgmtDashboard.summary scopeType=market', () => {
  test('SQL 含 stores JOIN org_nodes 子查询；storeCount 走 parent_id', async () => {
    setupDefaultMocks({ metricValue: 50, storeCount: 3, marketName: '华东市场' })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // sale/service 表过滤：so.store_id IN (SELECT s.store_id FROM stores s JOIN org_nodes o ...)
    // 排除 retainedMemberCount（FROM service_orders + JOIN client_wechat_users，scope 走 c.bound_store_id）
    const saleServiceSqls = sqlList.filter(
      (s) => /sale_orders|service_orders/.test(s) && !/became_member_at/.test(s),
    )
    expect(saleServiceSqls.length).toBeGreaterThanOrEqual(12)
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
      expect(s).toContain("o.parent_id = $2")
      expect(s).toContain("o.type = '门店'")
    }

    // client 表过滤：newMembers(2) + memberCount(1) + retainedMemberCount(1, JOIN) = 4
    const clientSqls = sqlList.filter((s) => /client_wechat_users/.test(s))
    expect(clientSqls.length).toBe(4)
    for (const s of clientSqls) {
      expect(s).toMatch(/bound_store_id\s+IN\s*\(/)
      // newMembers/retained SQL 用 $2（$1=date），memberCount 截面 SQL 用 $1（无 date）
      expect(s).toMatch(/o\.parent_id = \$[12]/)
    }

    // staff 表过滤：employeeCount = 1 条
    const staffSqls = sqlList.filter((s) => /staff_wechat_users/.test(s))
    expect(staffSqls.length).toBe(1)
    expect(staffSqls[0]).toMatch(/store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
    expect(staffSqls[0]).toContain('o.parent_id = $1')

    // storeCount 走 parent_id 过滤
    const storeCountSql = sqlList.find(
      (s) => /FROM org_nodes WHERE type = '门店' AND parent_id/.test(s) && /COUNT/.test(s),
    )
    expect(storeCountSql).toBeDefined()

    expect(ctx.result.storeCount).toBe(3)
    expect(ctx.result.scope).toEqual({ type: 'market', id: 'mkt-A', name: '华东市场' })
  })
})

describe('mgmtDashboard.summary scopeType=store', () => {
  test('SQL 含 store_id = $2，storeCount 短路返回 1（不查 org_nodes COUNT）', async () => {
    setupDefaultMocks({ metricValue: 30, storeName: '凤御B店' })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // 排除 retainedMemberCount（FROM service_orders + JOIN client_wechat_users，scope 走 c.bound_store_id）
    const saleServiceSqls = sqlList.filter(
      (s) => /sale_orders|service_orders/.test(s) && !/became_member_at/.test(s),
    )
    for (const s of saleServiceSqls) {
      expect(s).toContain('so.store_id = $2')
      expect(s).not.toMatch(/store_id\s+IN\s*\(/)
    }

    const clientSqls = sqlList.filter((s) => /client_wechat_users/.test(s))
    expect(clientSqls.length).toBe(4)
    for (const s of clientSqls) {
      // newMembers 用 $2（$1=date），截面用 $1
      expect(s).toMatch(/c\.bound_store_id = \$[12]/)
    }

    // staff 表过滤：employeeCount 走 store 单值
    const staffSqls = sqlList.filter((s) => /staff_wechat_users/.test(s))
    expect(staffSqls.length).toBe(1)
    expect(staffSqls[0]).toContain('s.store_id = $1')

    // storeCount 不调用 pg
    const storeCountSql = sqlList.find(
      (s) => /FROM org_nodes WHERE type = '门店'/.test(s) && /COUNT\(\*\)/.test(s),
    )
    expect(storeCountSql).toBeUndefined()

    expect(ctx.result.storeCount).toBe(1)
    expect(ctx.result.scope).toEqual({ type: 'store', id: 'store-001', name: '凤御B店' })
  })
})

describe('mgmtDashboard.summary 时间窗口', () => {
  test('SQL 同时含「::date = $1::date」和「date_trunc(\'month\', col)」两套窗口', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const metricSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter((s) => /sale_orders|service_orders|client_wechat_users/.test(s))
      // 排除 retainedMemberCount：方案 B 实时计算用 90 天 BETWEEN 窗口，不属于 day/month 二选一
      .filter((s) => !/became_member_at/.test(s))

    const daySqls = metricSqls.filter((s) => /\$1::date/.test(s) && !/date_trunc/.test(s))
    const monthSqls = metricSqls.filter((s) => /date_trunc\('month',/.test(s))

    expect(daySqls.length).toBe(10)
    expect(monthSqls.length).toBe(10)
  })
})

describe('mgmtDashboard.summary 月店均与防除零', () => {
  test('storeCount=4 + month=400 → monthlyAvgPerStore=100', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: 4 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      const isMonth = /date_trunc\('month',/.test(sql)
      return [{ v: isMonth ? 400 : 200 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.storeRevenue.today).toBe(200)
    expect(ctx.result.storeRevenue.month).toBe(400)
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.storeConsume.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiConsume.monthlyAvgPerStore).toBe(100)
  })

  test('storeCount=0 → monthlyAvgPerStore 返回 0 而非 NaN', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: 0 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      return [{ v: 999 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-empty' })
    await summary(ctx)

    expect(ctx.result.storeCount).toBe(0)
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(0)
    expect(Number.isNaN(ctx.result.storeRevenue.monthlyAvgPerStore)).toBe(false)
  })
})

describe('mgmtDashboard.summary 生美区分', () => {
  test('生美业绩 SQL 含 si.is_shengmei=TRUE；门店业绩 SQL 不含 is_shengmei', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    const shengmeiRevSqls = sqlList.filter(
      (s) => /JOIN sale_items/.test(s) && /si\.is_shengmei = TRUE/.test(s),
    )
    expect(shengmeiRevSqls.length).toBe(2) // today + month

    const storeRevSqls = sqlList.filter(
      (s) => /FROM sale_orders so\b/.test(s) && /SUM\(so\.paid_amount/.test(s),
    )
    expect(storeRevSqls.length).toBe(2)
    for (const s of storeRevSqls) {
      expect(s).not.toMatch(/is_shengmei/)
      expect(s).not.toMatch(/JOIN sale_items/)
    }

    const shengmeiConsSqls = sqlList.filter(
      (s) => /JOIN service_items/.test(s) && /sit\.is_shengmei = TRUE/.test(s),
    )
    expect(shengmeiConsSqls.length).toBe(2)
  })
})

describe('mgmtDashboard.summary 新会员', () => {
  test('SQL 含 old_member_level IS NULL ∩ member_level IS NOT NULL', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const newMemSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter((s) => /client_wechat_users/.test(s) && /old_member_level/.test(s))

    expect(newMemSqls.length).toBe(2)
    for (const s of newMemSqls) {
      expect(s).toContain('c.old_member_level IS NULL')
      expect(s).toContain('c.member_level IS NOT NULL')
    }
  })
})

describe('mgmtDashboard.summary 提成（销售/服务）', () => {
  test('销售提成 SQL 命中 sale_allocations + role_type IN(美容师/养生师) + 已支付销售/转换单 + paid_at；值映射正确', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: 5 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM sale_allocations\b/.test(sql)) {
        const isMonth = /date_trunc\('month',/.test(sql)
        return [{ v: isMonth ? 12345.67 : 234.5 }]
      }
      return [{ v: 0 }]
    })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.salesCommissionIncome).toEqual({ today: 234.5, month: 12345.67 })

    const salesSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter((s) => /FROM sale_allocations\b/.test(s))
    expect(salesSqls.length).toBe(2) // today + month
    for (const s of salesSqls) {
      expect(s).toMatch(/SUM\(sa\.total_amount/)
      expect(s).toContain('sa.is_void = FALSE')
      expect(s).toMatch(/sa\.role_type\s+IN/)
      expect(s).toContain('美容师')
      expect(s).toContain('养生师')
      expect(s).toContain('销售单')
      expect(s).toContain('转换单')
      expect(s).toContain("so.status = '已支付'")
      expect(s).toMatch(/so\.paid_at/)
      expect(s).toMatch(/JOIN sale_items si/)
      expect(s).toMatch(/JOIN sale_orders so/)
    }
  })

  test('服务提成 SQL 命中 service_commissions + role_type IN(美容师/养生师) + 已完成 + service_date；值映射正确', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: 5 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM service_commissions\b/.test(sql)) {
        const isMonth = /date_trunc\('month',/.test(sql)
        return [{ v: isMonth ? 6789.12 : 89.0 }]
      }
      return [{ v: 0 }]
    })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.serviceCommissionIncome).toEqual({ today: 89, month: 6789.12 })

    const svcSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter((s) => /FROM service_commissions\b/.test(s))
    expect(svcSqls.length).toBe(2)
    for (const s of svcSqls) {
      expect(s).toMatch(/SUM\(sc2\.commission_amount/)
      expect(s).toContain('sc2.is_void = FALSE')
      expect(s).toMatch(/sc2\.role_type\s+IN/)
      expect(s).toContain('美容师')
      expect(s).toContain('养生师')
      expect(s).toContain("so.status = '已完成'")
      expect(s).toMatch(/so\.service_date/)
      expect(s).toMatch(/JOIN service_items sit/)
      expect(s).toMatch(/JOIN service_orders so/)
    }
  })

  test('scopeType=market：两类提成 SQL 都走 stores JOIN org_nodes 子查询并占位 $2', async () => {
    setupDefaultMocks({ metricValue: 0 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const salesSqls = sqlList.filter((s) => /FROM sale_allocations\b/.test(s))
    const svcSqls = sqlList.filter((s) => /FROM service_commissions\b/.test(s))
    expect(salesSqls.length).toBe(2)
    expect(svcSqls.length).toBe(2)
    for (const s of [...salesSqls, ...svcSqls]) {
      expect(s).toMatch(/so\.store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
      expect(s).toContain('o.parent_id = $2')
    }
  })
})

describe('mgmtDashboard.summary 项目数真实出数 + 返回结构', () => {
  test('projectCount 走 SUM(session_used) WHERE sales_category IN (...)，分别返回 today/month', async () => {
    // 自定义 mock：projectCount day=7, month=42；其他指标兜底返回 12
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: 5 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/JOIN service_items sit\b/.test(sql) && /sales_category\s+IN/.test(sql)) {
        const isMonth = /date_trunc\('month',/.test(sql)
        return [{ v: isMonth ? 42 : 7 }]
      }
      return [{ v: 12 }]
    })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.projectCount).toEqual({ today: 7, month: 42 })
    expect(ctx.result.date).toBe('2026-04-25')
    expect(typeof ctx.result.computedAt).toBe('string')
    expect(ctx.result.footfall).toEqual({ today: 12, month: 12 })
    expect(ctx.result.headcount).toEqual({ today: 12, month: 12 })
    expect(ctx.result.newMembers).toEqual({ today: 12, month: 12 })
    expect(ctx.result.memberCount).toBe(12)
    expect(ctx.result.retainedMemberCount).toBe(12)
    expect(ctx.result.employeeCount).toBe(12)

    // SQL 形态断言：projectCount SQL 同时含
    //   service_items + session_used + sales_category IN(...) + 已完成 + service_date
    const projectSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter((s) => /JOIN service_items sit\b/.test(s) && /sales_category\s+IN/.test(s))
    expect(projectSqls.length).toBe(2) // today + month
    for (const s of projectSqls) {
      expect(s).toMatch(/SUM\(sit\.session_used\)/)
      expect(s).toContain('自销自耗')
      expect(s).toContain('他销自耗')
      expect(s).toContain("so.status = '已完成'")
      expect(s).toMatch(/so\.service_date/)
    }
  })
})

describe('mgmtDashboard.summary 门店状况 + 人效（截面字段）', () => {
  // 共用 mock：根据 SQL 形态返回不同行数，验证字段映射正确
  function setupCensusMocks({
    memberCount = 10,
    retainedCount = 5,
    employeeCount = 8,
    storeCount = 4,
    metricValue = 0,
  } = {}) {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /COUNT\(\*\)/.test(sql)) return [{ cnt: storeCount }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM client_wechat_users\b/.test(sql) && /customer_type\s*=\s*'会员客'/.test(sql)) {
        return [{ v: memberCount }]
      }
      // T5：保有会员改方案 B 实时计算（FROM service_orders + JOIN client_wechat_users + became_member_at 守卫）
      if (/FROM service_orders\b/.test(sql) && /became_member_at/.test(sql)) {
        return [{ v: retainedCount }]
      }
      if (/FROM staff_wechat_users\b/.test(sql)) return [{ v: employeeCount }]
      return [{ v: metricValue }]
    })
  }

  test('memberCount SQL 命中 customer_type = 会员客；返回值映射正确', async () => {
    setupCensusMocks({ memberCount: 10, retainedCount: 5, employeeCount: 8 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const memberSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM client_wechat_users/.test(s) && /customer_type\s*=\s*'会员客'/.test(s))
    expect(memberSql).toBeDefined()
    expect(memberSql).not.toMatch(/old_member_level/)
    expect(memberSql).not.toMatch(/customer_status/)
    expect(ctx.result.memberCount).toBe(10)
  })

  test('retainedMemberCount SQL 形态：service_orders 90 天窗口 + JOIN client_wechat_users + became_member_at 守卫（T5 方案 B 实时计算）', async () => {
    setupCensusMocks({ memberCount: 10, retainedCount: 5 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/COUNT\(DISTINCT so\.client_user_id\)/)
    expect(retainedSql).toMatch(/JOIN client_wechat_users c\b/)
    expect(retainedSql).toMatch(/so\.status\s*=\s*'已完成'/)
    expect(retainedSql).toMatch(/so\.client_user_id\s+IS\s+NOT\s+NULL/)
    expect(retainedSql).toMatch(
      /so\.service_date\s+BETWEEN\s+\(\s*\$1::date\s*-\s*INTERVAL\s+'90 days'\s*\)\s+AND\s+\$1::date/,
    )
    expect(retainedSql).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
    expect(retainedSql).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    // 不再依赖快照列 customer_status
    expect(retainedSql).not.toMatch(/customer_status/)
    expect(ctx.result.retainedMemberCount).toBe(5)
  })

  test('retainedMemberCount scopeType=market：scope 走 c.bound_store_id IN (... parent_id = $2)', async () => {
    setupCensusMocks({ retainedCount: 7 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/c\.bound_store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
    expect(retainedSql).toContain('o.parent_id = $2')
    expect(ctx.result.retainedMemberCount).toBe(7)
  })

  test('retainedMemberCount scopeType=store：scope 走 c.bound_store_id = $2 单值过滤', async () => {
    setupCensusMocks({ retainedCount: 3 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toContain('c.bound_store_id = $2')
    expect(retainedSql).not.toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expect(retainedSql).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    expect(ctx.result.retainedMemberCount).toBe(3)
  })

  test('employeeCount SQL 命中 is_resigned=FALSE ∩ skills && ARRAY[美容师,养生师]', async () => {
    setupCensusMocks({ employeeCount: 8 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const empSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toBeDefined()
    expect(empSql).toContain('s.is_resigned = FALSE')
    expect(empSql).toMatch(/s\.skills\s*&&\s*ARRAY\['美容师','养生师'\]::text\[\]/)
    expect(ctx.result.employeeCount).toBe(8)
  })

  test('scopeType=market：staff/client 截面 SQL 走 stores JOIN org_nodes 子查询', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const memberSql = sqlList.find(
      (s) => /FROM client_wechat_users/.test(s) && /customer_type\s*=\s*'会员客'/.test(s),
    )
    expect(memberSql).toMatch(/c\.bound_store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
    expect(memberSql).toContain('o.parent_id = $1') // 截面 SQL 无 date 占位

    const empSql = sqlList.find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toMatch(/s\.store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
    expect(empSql).toContain('o.parent_id = $1')
  })

  test('scopeType=store：staff/client 截面 SQL 走单值过滤', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const memberSql = sqlList.find(
      (s) => /FROM client_wechat_users/.test(s) && /customer_type\s*=\s*'会员客'/.test(s),
    )
    expect(memberSql).toContain('c.bound_store_id = $1')
    expect(memberSql).not.toMatch(/IN\s*\(/)

    const empSql = sqlList.find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toContain('s.store_id = $1')
    expect(empSql).not.toMatch(/IN\s*\(/)
  })

  test('截面 2 字段不依赖 date 参数（memberCount + employeeCount，SQL 内不出现 ::date / date_trunc；retained 已切实时计算见单独测试）', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const censusSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter(
        (s) =>
          (/FROM client_wechat_users/.test(s) && /customer_type\s*=\s*'会员客'/.test(s)) ||
          /FROM staff_wechat_users/.test(s),
      )
    expect(censusSqls.length).toBe(2)
    for (const s of censusSqls) {
      expect(s).not.toMatch(/::date/)
      expect(s).not.toMatch(/date_trunc/)
    }
  })

  test('scopeType=all 时 memberCount + employeeCount 走 WHERE TRUE，无 store/parent_id 过滤', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const censusSqls = sqlList.filter(
      (s) =>
        (/FROM client_wechat_users/.test(s) && /customer_type\s*=\s*'会员客'/.test(s)) ||
        /FROM staff_wechat_users/.test(s),
    )
    for (const s of censusSqls) {
      expect(s).toMatch(/WHERE\s+TRUE/)
      expect(s).not.toMatch(/parent_id/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
    }
  })

  test('scopeType=all 时 retainedMemberCount SQL 走 WHERE TRUE，但仍带 90 天窗口 + became_member_at 守卫', async () => {
    setupCensusMocks({ retainedCount: 12 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/WHERE\s+TRUE/)
    expect(retainedSql).not.toMatch(/parent_id/)
    expect(retainedSql).not.toMatch(/bound_store_id\s*=\s*\$/)
    // 仍依赖 date（$1）做 90 天窗口与会员判定
    expect(retainedSql).toMatch(/\$1::date/)
    expect(ctx.result.retainedMemberCount).toBe(12)
  })
})

// =============================================================================
// scopeOptions —— 市场/门店二级筛选器数据源
// =============================================================================

describe('mgmtDashboard.scopeOptions', () => {
  // 3 市场 × 2 门店的 flat rows（loadAllMarkets 查询的返回形态）
  const THREE_MARKETS_ROWS = [
    { market_id: 'mkt-A', market_name: '华东市场', store_id: 'store-A1', store_name: '上海A店' },
    { market_id: 'mkt-A', market_name: '华东市场', store_id: 'store-A2', store_name: '上海B店' },
    { market_id: 'mkt-B', market_name: '华南市场', store_id: 'store-B1', store_name: '广州A店' },
    { market_id: 'mkt-B', market_name: '华南市场', store_id: 'store-B2', store_name: '深圳A店' },
    { market_id: 'mkt-C', market_name: '华北市场', store_id: 'store-C1', store_name: '北京A店' },
    { market_id: 'mkt-C', market_name: '华北市场', store_id: 'store-C2', store_name: '天津A店' },
  ]

  beforeEach(() => {
    // 清空模块级 markets 缓存，避免跨用例污染
    __resetMarketsCache()
  })

  test('HQ 账号返回全部市场及其门店', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx = createCtx({
      auth: {
        staffLevel: 'headquarters',
        loginLevel: 'management',
        roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      },
    })

    await scopeOptions(ctx)

    expect(ctx.result.staffLevel).toBe('headquarters')
    expect(ctx.result.markets).toHaveLength(3)
    expect(ctx.result.markets.map((m) => m.id).sort()).toEqual(['mkt-A', 'mkt-B', 'mkt-C'])
    for (const m of ctx.result.markets) {
      expect(m.stores).toHaveLength(2)
      expect(m.stores[0]).toHaveProperty('storeId')
      expect(m.stores[0]).toHaveProperty('storeName')
    }
  })

  test('market 账号仅返回自己市场（按 roleBindings.scopeType=市场 过滤）', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx = createCtx({
      auth: {
        staffLevel: 'market',
        loginLevel: 'management',
        roleBindings: [{ role: 'manager', scopeId: 'mkt-A', scopeType: '市场' }],
      },
    })

    await scopeOptions(ctx)

    expect(ctx.result.staffLevel).toBe('market')
    expect(ctx.result.markets).toHaveLength(1)
    expect(ctx.result.markets[0].id).toBe('mkt-A')
    expect(ctx.result.markets[0].name).toBe('华东市场')
    expect(ctx.result.markets[0].stores).toHaveLength(2)
  })

  test('store_manager 账号被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({})
    await expect(scopeOptions(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
    // 未走到 pg 查询（中间件在 handler 入口就抛）
    expect(pg.query).not.toHaveBeenCalled()
  })

  test('连续两次调用命中缓存，pg.query 仅被调用一次', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx1 = createCtx({
      auth: {
        staffLevel: 'headquarters',
        loginLevel: 'management',
        roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      },
    })
    const ctx2 = createCtx({
      auth: {
        staffLevel: 'headquarters',
        loginLevel: 'management',
        roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      },
    })

    await scopeOptions(ctx1)
    await scopeOptions(ctx2)

    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(ctx1.result.markets).toHaveLength(3)
    expect(ctx2.result.markets).toHaveLength(3)
  })
})
