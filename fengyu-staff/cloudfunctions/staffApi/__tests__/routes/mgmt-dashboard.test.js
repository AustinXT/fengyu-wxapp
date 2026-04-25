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
 *   - 项目数占位返回 0/0
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createManagerCtx } = require('../helpers')
const { summary } = require('../../routes/mgmt-dashboard')

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
    // 7 个时间相关指标 × 2（today + month）= 14；+ 3 个截面（member/retained/employee）= 17
    expect(metricSqls.length).toBe(17)
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
    const saleServiceSqls = sqlList.filter((s) => /sale_orders|service_orders/.test(s))
    expect(saleServiceSqls.length).toBeGreaterThanOrEqual(12)
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
      expect(s).toContain("o.parent_id = $2")
      expect(s).toContain("o.type = '门店'")
    }

    // client 表过滤：newMembers(2) + memberCount(1) + retainedMemberCount(1) = 4
    const clientSqls = sqlList.filter((s) => /client_wechat_users/.test(s))
    expect(clientSqls.length).toBe(4)
    for (const s of clientSqls) {
      expect(s).toMatch(/bound_store_id\s+IN\s*\(/)
      // newMembers SQL 用 $2（$1=date），截面 SQL 用 $1（无 date）
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

    const saleServiceSqls = sqlList.filter((s) => /sale_orders|service_orders/.test(s))
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

    const daySqls = metricSqls.filter((s) => /\$1::date/.test(s) && !/date_trunc/.test(s))
    const monthSqls = metricSqls.filter((s) => /date_trunc\('month',/.test(s))

    expect(daySqls.length).toBe(7)
    expect(monthSqls.length).toBe(7)
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

describe('mgmtDashboard.summary 项目数占位 + 返回结构', () => {
  test('projectCount 占位返回 { today: 0, month: 0 }', async () => {
    setupDefaultMocks({ metricValue: 12 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.projectCount).toEqual({ today: 0, month: 0 })
    expect(ctx.result.date).toBe('2026-04-25')
    expect(typeof ctx.result.computedAt).toBe('string')
    expect(ctx.result.footfall).toEqual({ today: 12, month: 12 })
    expect(ctx.result.headcount).toEqual({ today: 12, month: 12 })
    expect(ctx.result.newMembers).toEqual({ today: 12, month: 12 })
    // 截面 3 字段（默认 mock 落入兜底，全部返回 metricValue=12）
    expect(ctx.result.memberCount).toBe(12)
    expect(ctx.result.retainedMemberCount).toBe(12)
    expect(ctx.result.employeeCount).toBe(12)
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
      if (/FROM client_wechat_users\b/.test(sql) && /customer_status\s+IN/.test(sql)) {
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

  test('retainedMemberCount SQL 命中 customer_status IN（保有会员-稳定/有效）', async () => {
    setupCensusMocks({ memberCount: 10, retainedCount: 5 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM client_wechat_users/.test(s) && /customer_status\s+IN/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/'保有会员-稳定'/)
    expect(retainedSql).toMatch(/'保有会员-有效'/)
    expect(ctx.result.retainedMemberCount).toBe(5)
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

  test('截面 3 字段不依赖 date 参数（SQL 内不出现 ::date / date_trunc）', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const censusSqls = pg.query.mock.calls
      .map((c) => c[0])
      .filter(
        (s) =>
          (/FROM client_wechat_users/.test(s) &&
            (/customer_type\s*=\s*'会员客'/.test(s) || /customer_status\s+IN/.test(s))) ||
          /FROM staff_wechat_users/.test(s),
      )
    expect(censusSqls.length).toBe(3)
    for (const s of censusSqls) {
      expect(s).not.toMatch(/::date/)
      expect(s).not.toMatch(/date_trunc/)
    }
  })

  test('scopeType=all 时 3 个截面 SQL 形态：WHERE TRUE，无 store/parent_id 过滤', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const censusSqls = sqlList.filter(
      (s) =>
        (/FROM client_wechat_users/.test(s) &&
          (/customer_type\s*=\s*'会员客'/.test(s) || /customer_status\s+IN/.test(s))) ||
        /FROM staff_wechat_users/.test(s),
    )
    for (const s of censusSqls) {
      expect(s).toMatch(/WHERE\s+TRUE/)
      expect(s).not.toMatch(/parent_id/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
    }
  })
})
