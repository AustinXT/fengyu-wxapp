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
const {
  createCtx: createBaseCtx,
  createManagerCtx: createBaseManagerCtx,
  createManagementCtx: createBaseManagementCtx,
} = require('../helpers')
const { summary, scopeOptions, storeRanking, staffRanking, salesData } = require('../../routes/mgmt-dashboard')

// 本文件覆盖的全部路由都要求 data_center:dashboard；默认夹具显式带上该权限，
// 各用例仍可覆盖为 false 来验证权限拦截。
function createCtx(overrides = {}) {
  return createBaseCtx({
    ...overrides,
    auth: { hasDataCenterDashboard: true, ...(overrides.auth || {}) },
  })
}

function createManagerCtx(payload = {}, authOverrides = {}) {
  return createBaseManagerCtx(payload, { hasDataCenterDashboard: true, ...authOverrides })
}

function createManagementCtx(payload = {}, authOverrides = {}) {
  return createBaseManagementCtx(payload, { hasDataCenterDashboard: true, ...authOverrides })
}

// ---- ctx 构造 ----
function makeHqCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'headquarters',
      loginLevel: 'management',
      hasDataCenterDashboard: true,
      roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      scopeStoreIds: ['store-001', 'store-002'],
      // 认证层对总部会展开全部组织节点；本文件的市场用例覆盖 mkt-A/mkt-empty。
      scopeOrgNodeIds: ['org-hq', 'mkt-A', 'mkt-B', 'mkt-C', 'mkt-empty'],
    },
  })
}

function makeMarketCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'market',
      loginLevel: 'management',
      hasDataCenterDashboard: true,
      roleBindings: [{ role: 'manager', scopeId: 'mkt-A', scopeType: '市场' }],
      scopeOrgNodeIds: ['mkt-A'],
      scopeStoreIds: ['store-001'],
    },
  })
}

function isStoreCountSql(sql) {
  return (
    /COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) &&
    /FROM stores s\b/.test(sql) &&
    (/JOIN org_nodes o\b/.test(sql) || /WITH RECURSIVE descendants\(id, path\) AS/.test(sql))
  )
}

function expectRecursiveDescendantScope(sql, rootParamIndex) {
  expect(sql).toMatch(/WITH RECURSIVE descendants\(id, path\) AS/)
  expect(sql).toMatch(new RegExp(`SELECT \\$${rootParamIndex}::text, ARRAY\\[\\$${rootParamIndex}::text\\]`))
  expect(sql).toMatch(/JOIN descendants ON child\.parent_id = descendants\.id/)
  expect(sql).toMatch(/WHERE NOT child\.id = ANY\(descendants\.path\)/)
  expect(sql).toMatch(/JOIN descendants ON s\.org_node_id = descendants\.id/)
}

// ---- 默认 mock：根据 SQL 形态返回对应 shape ----
function setupDefaultMocks({
  metricValue = 100,
  storeCount = 5,
  marketName = '华东市场',
  storeName = '凤御A店',
} = {}) {
  pg.query.mockReset().mockImplementation(async (sql) => {
    // all 走直属门店查询，market 走递归后代组织树；两者均带历史化日期守卫。
    if (isStoreCountSql(sql)) {
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
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*日期/)
  })

  test('日期格式错误抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026/04/25', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*YYYY-MM-DD/)
  })

  test('未知 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'foo' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围 ID/)
  })

  test('store_manager + loginLevel=store → 被 loginLevel 闸拦截（须以管理层身份登录）', async () => {
    const ctx = createManagerCtx({ date: '2026-04-25', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('store_manager + management 选 all → PERMISSION_DENIED（店长禁看全量）', async () => {
    const ctx = createManagementCtx(
      { date: '2026-04-25', scopeType: 'all' },
      { staffLevel: 'store_manager' }
    )
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('store_manager + management 选 market → PERMISSION_DENIED（店长禁按市场查）', async () => {
    const ctx = createManagementCtx(
      { date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' },
      { staffLevel: 'store_manager' }
    )
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
  test('SQL 统一叠加启用门店过滤，metric 不带 URL 单店参数；storeCount 来自 stores JOIN org_nodes', async () => {
    setupDefaultMocks({ metricValue: 100, storeCount: 5 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const metricSqls = sqlList.filter((s) =>
      /sale_orders|sale_order_performance_events|sale_item_performance_events|service_orders|client_wechat_users|staff_wechat_users/.test(s),
    )
    // 10 个时间相关指标 × 2（today + month）= 20；
    // + 截面：member(1)/retained(1)/employeeDay(1)/employeeMonth(1) = 4
    // = 24
    expect(metricSqls.length).toBe(24)
    for (const s of metricSqls) {
      expect(s).toMatch(/WHERE\s+\(TRUE\)\s+AND/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
    }

    // T4 历史化：storeCount SQL 走 FROM stores ... JOIN org_nodes，加 opening_date/closed_at 守卫
    // T6 起 storeCount 被调用 2 次（day + month），SQL 形态相同
    const storeCountSqls = sqlList.filter(
      (s) =>
        /COUNT\(\*\)::int\s+AS\s+cnt/.test(s) &&
        /FROM stores s\b/.test(s) &&
        /JOIN org_nodes o\b/.test(s),
    )
    expect(storeCountSqls.length).toBe(2)
    for (const storeCountSql of storeCountSqls) {
      expect(storeCountSql).not.toMatch(/parent_id/)
      // 历史化守卫
      expect(storeCountSql).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
      expect(storeCountSql).toMatch(/s\.closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>\s*\$1::date/)
      expect(storeCountSql).toMatch(/o\.type\s*=\s*'门店'/)
      expect(storeCountSql).toMatch(/o\.is_active\s*=\s*TRUE/)
    }

    // T6：storeCount 双口径 { day, month }
    expect(ctx.result.storeCount).toEqual({ day: 5, month: 5 })
    expect(ctx.result.scope).toEqual({ type: 'all', id: null, name: '全部市场' })
  })
})

describe('mgmtDashboard.summary scopeType=market', () => {
  test('SQL 通过递归组织树覆盖市场下任意层级门店', async () => {
    setupDefaultMocks({ metricValue: 50, storeCount: 3, marketName: '华东市场' })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // sale/service 表过滤：so.store_id IN (递归 descendants ...)
    // 排除 retainedMemberCount（FROM service_orders + JOIN client_wechat_users，scope 走 c.bound_store_id）
    const saleServiceSqls = sqlList.filter(
      (s) => /sale_orders|sale_order_performance_events|sale_item_performance_events|service_orders/.test(s) && !/became_member_at/.test(s),
    )
    expect(saleServiceSqls.length).toBeGreaterThanOrEqual(12)
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/(?:so|o|spe)\.store_id\s+IN\s*\(/)
      expectRecursiveDescendantScope(s, 2)
    }

    // client 表过滤：newMembers(2) + memberCount(1) + retainedMemberCount(1, JOIN) = 4
    const clientSqls = sqlList.filter((s) => /client_wechat_users/.test(s))
    expect(clientSqls.length).toBe(4)
    for (const s of clientSqls) {
      expect(s).toMatch(/bound_store_id\s+IN\s*\(/)
      // T2 起 memberCount 也用 $1=date，所有 4 条 client SQL 的根节点参数都在 $2。
      expectRecursiveDescendantScope(s, 2)
    }

    // staff 表过滤：T6 起 employeeCount 调用 2 次（day + month）
    // T3 起 employeeCount 用 $1=date + $2=scopeId（参数顺序：[date, ...scopeParams]）
    const staffSqls = sqlList.filter((s) => /staff_wechat_users/.test(s))
    expect(staffSqls.length).toBe(2)
    for (const s of staffSqls) {
      expect(s).toMatch(/s\.store_id\s+IN\s*\(/)
      expectRecursiveDescendantScope(s, 2)
    }

    // storeCount 同样走递归后代组织树，并带 opening_date/closed_at 守卫。
    // T6 起 storeCount 调用 2 次（day + month）
    const storeCountSqls = sqlList.filter(isStoreCountSql)
    expect(storeCountSqls.length).toBe(2)
    for (const s of storeCountSqls) {
      expectRecursiveDescendantScope(s, 2)
      expect(s).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
      expect(s).toMatch(/s\.closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>\s*\$1::date/)
      expect(s).toMatch(/o\.is_active\s*=\s*TRUE/)
    }

    expect(ctx.result.storeCount).toEqual({ day: 3, month: 3 })
    expect(ctx.result.scope).toEqual({ type: 'market', id: 'mkt-A', name: '华东市场' })
  })
})

describe('mgmtDashboard.summary scopeType=store', () => {
  test('SQL 含 store_id = $2，storeCount 真实查询启用节点；停用门店返回 0', async () => {
    setupDefaultMocks({ metricValue: 30, storeCount: 0, storeName: '凤御B店' })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // 排除 retainedMemberCount（FROM service_orders + JOIN client_wechat_users，scope 走 c.bound_store_id）
    const saleServiceSqls = sqlList.filter(
      (s) => /sale_orders|sale_order_performance_events|sale_item_performance_events|service_orders/.test(s) && !/became_member_at/.test(s),
    )
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/(?:so|spe)\.store_id = \$2/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    }

    const clientSqls = sqlList.filter((s) => /client_wechat_users/.test(s))
    expect(clientSqls.length).toBe(4)
    for (const s of clientSqls) {
      // T2 起 memberCount 也用 $1=date，所有 client 截面/带日期 SQL 都用 c.bound_store_id = $2
      expect(s).toContain('c.bound_store_id = $2')
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    }

    // staff 表过滤：T6 起 employeeCount 调用 2 次（day + month），都走 store 单值
    // T3 起 employeeCount 用 $1=date + $2=scopeId
    const staffSqls = sqlList.filter((s) => /staff_wechat_users/.test(s))
    expect(staffSqls.length).toBe(2)
    for (const s of staffSqls) {
      expect(s).toContain('s.store_id = $2')
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    }

    // 单店同样真实查询两次（日 / 月末），不能把停用门店固定算作 1 家。
    const storeCountSqls = sqlList.filter(isStoreCountSql)
    expect(storeCountSqls).toHaveLength(2)
    for (const s of storeCountSqls) {
      expect(s).toContain('s.store_id = $2')
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(s).toMatch(/o\.is_active\s*=\s*TRUE/)
      expect(s).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
    }

    expect(ctx.result.storeCount).toEqual({ day: 0, month: 0 })
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(0)
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
      .filter((s) => /sale_orders|sale_order_performance_events|sale_item_performance_events|service_orders|client_wechat_users/.test(s))
      // 排除 retainedMemberCount：方案 B 实时计算用 90 天 BETWEEN 窗口，不属于 day/month 二选一
      .filter((s) => !/INTERVAL\s+'90 days'/.test(s))
      // 排除 memberCount（截面历史化：became_member_at::date <= $1::date，无 date_trunc，但属于"截面"非"day/month"）
      .filter((s) => !/c\.became_member_at::date\s*<=\s*\$1::date/.test(s))

    const daySqls = metricSqls.filter((s) => /\$1::date/.test(s) && !/date_trunc/.test(s))
    const monthSqls = metricSqls.filter((s) => /date_trunc\('month',/.test(s))

    expect(daySqls.length).toBe(10)
    expect(monthSqls.length).toBe(10)
  })
})

describe('mgmtDashboard.summary 月店均与防除零', () => {
  test('storeCount=4 + month=400 → monthlyAvgPerStore=100', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      // T4 storeCount 历史化：FROM stores ... JOIN org_nodes
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) return [{ cnt: 4 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      const isMonth = /date_trunc\('month',/.test(sql)
      return [{ v: isMonth ? 400 : 200 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.storeRevenue.today).toBe(200)
    expect(ctx.result.storeRevenue.month).toBe(400)
    // T6：avg 用 storeCount.month=4 → 400/4=100
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.storeConsume.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiConsume.monthlyAvgPerStore).toBe(100)
  })

  test('storeCount=0 → monthlyAvgPerStore 返回 0 而非 NaN', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (isStoreCountSql(sql)) return [{ cnt: 0 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      return [{ v: 999 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-empty' })
    await summary(ctx)

    // T6：双口径都为 0
    expect(ctx.result.storeCount).toEqual({ day: 0, month: 0 })
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(0)
    expect(Number.isNaN(ctx.result.storeRevenue.monthlyAvgPerStore)).toBe(false)
  })

  test('T6：monthlyAvgPerStore 用 storeCount.month（day=5, month=4, monthRev=400 → avg=100）', async () => {
    // mock 区分 day vs month 调用：storeCount SQL 第一次（params[0]=date）返 5，第二次（params[0]=monthEnd）返 4
    // employeeCount 类似处理，但本用例仅断言月店均
    let storeCountCallIdx = 0
    pg.query.mockReset().mockImplementation(async (sql, params) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) {
        storeCountCallIdx += 1
        // 调用顺序由 Promise.all 数组决定：先 day（params[0]='2026-04-15'），再 month（params[0]='2026-04-30'）
        const isMonthEnd = params[0] === '2026-04-30'
        return [{ cnt: isMonthEnd ? 4 : 5 }]
      }
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      const isMonth = /date_trunc\('month',/.test(sql)
      return [{ v: isMonth ? 400 : 200 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-15', scopeType: 'all' })
    await summary(ctx)

    expect(storeCountCallIdx).toBe(2) // 调用了 day + month 两次
    expect(ctx.result.storeCount).toEqual({ day: 5, month: 4 })
    // 用 storeCount.month=4 而非 day=5：400/4=100（若用 day=5 则会得到 80，明显区分）
    expect(ctx.result.storeRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiRevenue.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.storeConsume.monthlyAvgPerStore).toBe(100)
    expect(ctx.result.shengmeiConsume.monthlyAvgPerStore).toBe(100)
  })

  test('T6：summary 月维度分母用 monthEnd（employeeCount/storeCount 都按 day/month 双值返回）', async () => {
    pg.query.mockReset().mockImplementation(async (sql, params) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) {
        const isMonthEnd = params[0] === '2026-04-30'
        return [{ cnt: isMonthEnd ? 6 : 8 }]
      }
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM staff_wechat_users\b/.test(sql)) {
        const isMonthEnd = params[0] === '2026-04-30'
        return [{ v: isMonthEnd ? 12 : 15 }]
      }
      return [{ v: 0 }]
    })

    const ctx = makeHqCtx({ date: '2026-04-15', scopeType: 'all' })
    await summary(ctx)

    // 双口径：storeCount.day=8（当日），storeCount.month=6（月末）
    expect(ctx.result.storeCount).toEqual({ day: 8, month: 6 })
    // employeeCount.day=15（当日），employeeCount.month=12（月末）
    expect(ctx.result.employeeCount).toEqual({ day: 15, month: 12 })
  })
})

describe('lastDayOfMonth helper（边界）', () => {
  // 通过 summary 间接验证 lastDayOfMonth 选取的月末日期是否传给 queryEmployeeCount/queryStoreCount
  function setupCaptureMocks() {
    const captured = { storeCountParams: [], staffParams: [] }
    pg.query.mockReset().mockImplementation(async (sql, params) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) {
        captured.storeCountParams.push(params)
        return [{ cnt: 1 }]
      }
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM staff_wechat_users\b/.test(sql)) {
        captured.staffParams.push(params)
        return [{ v: 1 }]
      }
      return [{ v: 0 }]
    })
    return captured
  }

  test('跨年 12 月：date=2026-12-15 → monthEnd=2026-12-31', async () => {
    const captured = setupCaptureMocks()
    const ctx = makeHqCtx({ date: '2026-12-15', scopeType: 'all' })
    await summary(ctx)

    // 第一个 storeCount 调用 day=date，第二个 month=monthEnd
    expect(captured.storeCountParams.length).toBe(2)
    expect(captured.storeCountParams[0][0]).toBe('2026-12-15')
    expect(captured.storeCountParams[1][0]).toBe('2026-12-31')

    expect(captured.staffParams.length).toBe(2)
    expect(captured.staffParams[0][0]).toBe('2026-12-15')
    expect(captured.staffParams[1][0]).toBe('2026-12-31')
  })

  test('二月平年：date=2026-02-15 → monthEnd=2026-02-28', async () => {
    const captured = setupCaptureMocks()
    const ctx = makeHqCtx({ date: '2026-02-15', scopeType: 'all' })
    await summary(ctx)

    expect(captured.storeCountParams[1][0]).toBe('2026-02-28')
    expect(captured.staffParams[1][0]).toBe('2026-02-28')
  })

  test('一月：date=2026-01-01 → monthEnd=2026-01-31', async () => {
    const captured = setupCaptureMocks()
    const ctx = makeHqCtx({ date: '2026-01-01', scopeType: 'all' })
    await summary(ctx)

    expect(captured.storeCountParams[1][0]).toBe('2026-01-31')
  })

  test('月末输入：date=2026-04-30 → monthEnd=2026-04-30（同日）', async () => {
    const captured = setupCaptureMocks()
    const ctx = makeHqCtx({ date: '2026-04-30', scopeType: 'all' })
    await summary(ctx)

    expect(captured.storeCountParams[0][0]).toBe('2026-04-30')
    expect(captured.storeCountParams[1][0]).toBe('2026-04-30')
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
      (s) => /FROM sale_order_performance_events spe\b/.test(s) && /SUM\(spe\.amount::numeric/.test(s),
    )
    expect(storeRevSqls.length).toBe(2)
    for (const s of storeRevSqls) {
      expect(s).not.toMatch(/is_shengmei/)
      expect(s).not.toMatch(/JOIN sale_items/)
      expect(s).toMatch(/spe\.status\s*=\s*'已支付'/)
      expect(s).toMatch(/spe\.change_type\s+IN\s*\('首次支付',\s*'回款',\s*'退款'\)/)
      expect(s).toMatch(/sale_order_type\s+IN\s*\('销售单',\s*'转换单',\s*'充值单'\)/)
      expect(s).toMatch(/spe\.performance_date/)
      expect(s).not.toMatch(/so\.status\s*=/)
    }

    const shengmeiConsSqls = sqlList.filter(
      (s) => /JOIN service_items/.test(s) && /sit\.is_shengmei = TRUE/.test(s),
    )
    expect(shengmeiConsSqls.length).toBe(2)
  })
})

describe('mgmtDashboard.summary 新会员', () => {
  test('SQL 用 became_member_at 判定（不再使用 old_member_level / member_level_upgraded_at）', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // 新会员 SQL：FROM client_wechat_users + became_member_at 命中条件
    // 排除 memberCount（用 became_member_at::date <= $date 闭区间，非 day/month 二选一）
    // 排除 retainedMemberCount（JOIN service_orders）
    // newMembers.day 形态：c.became_member_at::date = $1::date；newMembers.month 形态：date_trunc('month', c.became_member_at)
    const newMemSqls = sqlList.filter(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        /c\.became_member_at IS NOT NULL/.test(s) &&
        !/c\.became_member_at::date\s*<=\s*\$1::date/.test(s) &&
        !/FROM service_orders/.test(s),
    )

    expect(newMemSqls.length).toBe(2)  // newMembers.today + .month
    for (const s of newMemSqls) {
      expect(s).toContain('c.became_member_at IS NOT NULL')
      expect(s).not.toMatch(/c\.old_member_level/)
      expect(s).not.toMatch(/c\.member_level_upgraded_at/)
      expect(s).not.toMatch(/c\.member_level\s+IS\s+NOT\s+NULL/)
    }
  })
})

describe('mgmtDashboard.summary 提成（销售/服务）', () => {
  test('销售提成 SQL 命中 sale_payment_item_allocations + 已支付销售/转换单 + performance_date；值映射正确（M4：不再按 role_type 过滤）', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) return [{ cnt: 5 }]
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/FROM sale_payment_item_allocations\b/.test(sql)) {
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
      .filter((s) => /FROM sale_payment_item_allocations\b/.test(s))
    expect(salesSqls.length).toBe(2) // today + month
    for (const s of salesSqls) {
      // 2026-05-26 §3.15：销售提成改用真实提成 commission_amount（≠ staffRankingRevenue 的 total_amount 营业额份额）
      // M4（2026-07-14）：管理层收入 KPI/排行不再按 role_type 过滤（向 performanceDetail 看齐，含全部角色提成）
      expect(s).toMatch(/SUM\(spia\.commission_amount/)
      expect(s).toContain('spia.is_void = FALSE')
      expect(s).not.toMatch(/spia\.role_type\s+IN/)
      expect(s).toContain('销售单')
      expect(s).toContain('转换单')
      expect(s).toContain("spe.status = '已支付'")
      expect(s).toMatch(/spe\.performance_date/)
      expect(s).toMatch(/JOIN sale_payment_item_receipts spir/)
      expect(s).toMatch(/JOIN sale_order_performance_events spe/)
      expect(s).toMatch(/JOIN sale_items si/)
      expect(s).toMatch(/JOIN sale_orders so/)
    }
  })

  test('服务提成 SQL 命中 service_commissions + 已完成 + service_date；值映射正确（M4：不再按 role_type 过滤）', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) return [{ cnt: 5 }]
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
      // M4（2026-07-14）：管理层服务提成收入 KPI 不再按 role_type 过滤
      expect(s).not.toMatch(/sc2\.role_type\s+IN/)
      expect(s).toContain("so.status = '已完成'")
      expect(s).toMatch(/so\.service_date/)
      expect(s).toMatch(/JOIN service_items sit/)
      expect(s).toMatch(/JOIN service_orders so/)
    }
  })

  test('scopeType=market：两类提成 SQL 都走递归后代组织树并占位 $2', async () => {
    setupDefaultMocks({ metricValue: 0 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const salesSqls = sqlList.filter((s) => /FROM sale_payment_item_allocations\b/.test(s))
    const svcSqls = sqlList.filter((s) => /FROM service_commissions\b/.test(s))
    expect(salesSqls.length).toBe(2)
    expect(svcSqls.length).toBe(2)
    for (const s of [...salesSqls, ...svcSqls]) {
      expect(s).toMatch(/so\.store_id\s+IN\s*\(/)
      expectRecursiveDescendantScope(s, 2)
    }
  })
})

describe('mgmtDashboard.summary 项目数真实出数 + 返回结构', () => {
  test('projectCount 走 SUM(session_used) WHERE sales_category IN (...)，分别返回 today/month', async () => {
    // 自定义 mock：projectCount day=7, month=42；其他指标兜底返回 12
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/COUNT\(\*\)::int\s+AS\s+cnt/.test(sql) && /FROM stores s\b/.test(sql) && /JOIN org_nodes o\b/.test(sql)) return [{ cnt: 5 }]
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
    // T6：employeeCount 双口径（mock 不区分 date，day=month=12）
    expect(ctx.result.employeeCount).toEqual({ day: 12, month: 12 })

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
      // all 与 market 的门店数查询都应返回配置的快照值。
      if (isStoreCountSql(sql)) {
        return [{ cnt: storeCount }]
      }
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      // T2（2026-04-25）：会员数 SQL 历史化，FROM client_wechat_users + became_member_at::date <= $1::date
      // 注意需要在 retainedMemberCount 分支之前匹配（retained 用 FROM service_orders）
      // 用 `<=` 形态区分 memberCount（截面累计）vs newMembers（区间命中，用 = 或 date_trunc）
      if (
        /FROM client_wechat_users\b/.test(sql) &&
        /became_member_at::date\s*<=\s*\$1::date/.test(sql)
      ) {
        return [{ v: memberCount }]
      }
      // 新会员（2026-04-25 起按 became_member_at 区间命中）：date_trunc(...) = date_trunc(...) 或 ::date = $1
      if (
        /FROM client_wechat_users\b/.test(sql) &&
        /became_member_at/.test(sql) &&
        /date_trunc\('(month|day)',\s*c\.became_member_at\)|c\.became_member_at::date\s*=\s*\$/.test(sql)
      ) {
        return [{ v: metricValue }]
      }
      // T5：保有会员改方案 B 实时计算（FROM service_orders + JOIN client_wechat_users + became_member_at 守卫）
      if (/FROM service_orders\b/.test(sql) && /became_member_at/.test(sql)) {
        return [{ v: retainedCount }]
      }
      if (/FROM staff_wechat_users\b/.test(sql)) return [{ v: employeeCount }]
      return [{ v: metricValue }]
    })
  }

  test('memberCount SQL 形态：became_member_at IS NOT NULL ∩ became_member_at::date <= $1::date（T2 历史化口径，2026-04-25）', async () => {
    setupCensusMocks({ memberCount: 10, retainedCount: 5, employeeCount: 8 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    // memberCount 用闭区间 `<=` 与 newMembers 区分（newMembers 用 `=` 或 `date_trunc`）
    const memberSql = pg.query.mock.calls
      .map((c) => c[0])
      .find(
        (s) =>
          /FROM client_wechat_users/.test(s) &&
          /c\.became_member_at::date\s*<=\s*\$1::date/.test(s) &&
          !/FROM service_orders/.test(s),
      )
    expect(memberSql).toBeDefined()
    // T2 新口径：用 became_member_at 时间戳，不再依赖 customer_type 实时快照
    expect(memberSql).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
    expect(memberSql).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    // 旧口径：customer_type='会员客'/customer_status 都不应出现
    expect(memberSql).not.toMatch(/customer_type\s*=\s*'会员客'/)
    expect(memberSql).not.toMatch(/customer_status/)
    expect(memberSql).not.toMatch(/old_member_level/)
    expect(ctx.result.memberCount).toBe(10)
  })

  test('memberCount 历史日期：date=2025-01-15 时 SQL 仍是 became_member_at::date <= $1::date 形态，参数透传 date', async () => {
    setupCensusMocks({ memberCount: 7 })
    const ctx = makeHqCtx({ date: '2025-01-15', scopeType: 'all' })
    await summary(ctx)

    const memberCall = pg.query.mock.calls.find(
      (c) =>
        /FROM client_wechat_users/.test(c[0]) &&
        /c\.became_member_at::date\s*<=\s*\$1::date/.test(c[0]) &&
        !/FROM service_orders/.test(c[0]),
    )
    expect(memberCall).toBeDefined()
    expect(memberCall[0]).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    expect(memberCall[1]).toEqual(['2025-01-15'])
    expect(ctx.result.memberCount).toBe(7)
  })

  test('memberCount 边界 SQL 形态：使用 <= 闭区间（became_member_at = $date 当天即命中），且 IS NOT NULL 守卫排除空值', async () => {
    setupCensusMocks({ memberCount: 3 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const memberSql = pg.query.mock.calls
      .map((c) => c[0])
      .find(
        (s) =>
          /FROM client_wechat_users/.test(s) &&
          /c\.became_member_at::date\s*<=\s*\$1::date/.test(s) &&
          !/FROM service_orders/.test(s),
      )
    expect(memberSql).toBeDefined()
    // 闭区间：became_member_at = $date 命中、became_member_at = $date+1 不命中
    expect(memberSql).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    // 严格小于会漏掉当天，断言不出现
    expect(memberSql).not.toMatch(/c\.became_member_at::date\s*<\s*\$1::date/)
    // IS NOT NULL 守卫确保 null 顾客不命中
    expect(memberSql).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
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

  test('retainedMemberCount scopeType=market：scope 走 c.bound_store_id 的递归后代组织树', async () => {
    setupCensusMocks({ retainedCount: 7 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(retainedSql, 2)
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
    expect(retainedSql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    expect(retainedSql).toMatch(/c\.became_member_at::date\s*<=\s*\$1::date/)
    expect(ctx.result.retainedMemberCount).toBe(3)
  })

  test('employeeCount SQL 形态：hired_at IS NOT NULL ∩ hired_at::date <= $1::date ∩ (resigned_at IS NULL OR resigned_at::date > $1::date) ∩ skills && ARRAY[美容师,养生师]（T3 历史化口径，2026-04-25）', async () => {
    setupCensusMocks({ employeeCount: 8 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const empSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toBeDefined()
    // T3 新口径：用 hired_at + resigned_at 时间戳，不再依赖 is_resigned 实时快照
    expect(empSql).toMatch(/s\.hired_at\s+IS\s+NOT\s+NULL/)
    expect(empSql).toMatch(/s\.hired_at::date\s*<=\s*\$1::date/)
    expect(empSql).toMatch(/s\.resigned_at\s+IS\s+NULL\s+OR\s+s\.resigned_at::date\s*>\s*\$1::date/)
    expect(empSql).toMatch(/s\.skills\s*&&\s*ARRAY\['美容师','养生师'\]::text\[\]/)
    // 旧口径：is_resigned = FALSE 不应再出现
    expect(empSql).not.toMatch(/is_resigned\s*=\s*FALSE/)
    // T6：employeeCount 双口径（mock 不区分 date，day=month=8）
    expect(ctx.result.employeeCount).toEqual({ day: 8, month: 8 })
  })

  test('employeeCount 历史日期：date=2025-01-15 时 SQL 仍是 hired_at/resigned_at 守卫形态，参数透传 date', async () => {
    setupCensusMocks({ employeeCount: 6 })
    const ctx = makeHqCtx({ date: '2025-01-15', scopeType: 'all' })
    await summary(ctx)

    // T6：employeeCount 调用 2 次（day + month），.find 取第一条 = day 调用，params=[date]
    const empCall = pg.query.mock.calls.find((c) => /FROM staff_wechat_users/.test(c[0]))
    expect(empCall).toBeDefined()
    expect(empCall[0]).toMatch(/s\.hired_at::date\s*<=\s*\$1::date/)
    expect(empCall[0]).toMatch(/s\.resigned_at\s+IS\s+NULL\s+OR\s+s\.resigned_at::date\s*>\s*\$1::date/)
    expect(empCall[1]).toEqual(['2025-01-15'])
    // T6：双口径
    expect(ctx.result.employeeCount).toEqual({ day: 6, month: 6 })
  })

  test('storeCount SQL 形态：仅启用节点 ∩ opening_date::date <= $date ∩ (closed_at IS NULL OR closed_at::date > $date)', async () => {
    setupCensusMocks({ storeCount: 12 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const storeSql = pg.query.mock.calls
      .map((c) => c[0])
      .find(
        (s) =>
          /FROM stores s\b/.test(s) &&
          /JOIN org_nodes o\b/.test(s) &&
          /COUNT\(\*\)/.test(s),
      )
    expect(storeSql).toBeDefined()
    expect(storeSql).toContain("o.type = '门店'")
    expect(storeSql).toMatch(/o\.is_active\s*=\s*TRUE/)
    expect(storeSql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    expect(storeSql).toMatch(/s\.opening_date\s+IS\s+NOT\s+NULL/)
    expect(storeSql).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
    expect(storeSql).toMatch(/s\.closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>\s*\$1::date/)
    // 旧口径：裸 FROM org_nodes 不应再出现
    expect(storeSql).not.toMatch(/FROM org_nodes WHERE type = '门店'/)
    // T6：双口径
    expect(ctx.result.storeCount).toEqual({ day: 12, month: 12 })
  })

  test('storeCount 历史日期：date=2025-01-15 时 SQL 含 $1::date 守卫，参数透传 date', async () => {
    setupCensusMocks({ storeCount: 8 })
    const ctx = makeHqCtx({ date: '2025-01-15', scopeType: 'all' })
    await summary(ctx)

    const storeCall = pg.query.mock.calls.find(
      (c) =>
        /COUNT\(\*\)::int\s+AS\s+cnt/.test(c[0]) &&
        /FROM stores s\b/.test(c[0]) &&
        /JOIN org_nodes o\b/.test(c[0]),
    )
    expect(storeCall).toBeDefined()
    expect(storeCall[0]).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
    expect(storeCall[1]).toEqual(['2025-01-15'])
    // T6：双口径（mock 不区分调用次序，day=month=8）
    expect(ctx.result.storeCount).toEqual({ day: 8, month: 8 })
  })

  test('storeCount scopeType=market：递归后代组织树 ∩ 启用节点 ∩ opening_date/closed_at', async () => {
    setupCensusMocks({ storeCount: 3 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const storeCall = pg.query.mock.calls.find((c) => isStoreCountSql(c[0]))
    expect(storeCall).toBeDefined()
    expectRecursiveDescendantScope(storeCall[0], 2)
    expect(storeCall[0]).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    expect(storeCall[0]).toMatch(/s\.opening_date::date\s*<=\s*\$1::date/)
    expect(storeCall[0]).toMatch(/s\.closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>\s*\$1::date/)
    expect(storeCall[1]).toEqual(['2026-04-25', 'mkt-A'])
    // T6：双口径（market 模式 day=month=3，mock 未区分）
    expect(ctx.result.storeCount).toEqual({ day: 3, month: 3 })
  })

  // T2 起 memberCount SQL 形态识别：FROM client_wechat_users + became_member_at::date <= $1::date（用 `<=` 与 newMembers 的 `=` / `date_trunc` 区分；后者是首次升会员窗口聚合）
  const isMemberCountSql = (s) =>
    /FROM client_wechat_users/.test(s) &&
    /c\.became_member_at::date\s*<=\s*\$1::date/.test(s) &&
    !/FROM service_orders/.test(s)

  test('scopeType=market：staff/client 截面 SQL 走递归后代组织树', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const memberSql = sqlList.find(isMemberCountSql)
    expect(memberSql).toBeDefined()
    expect(memberSql).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    // T2 起 memberCount 用 $1=date + $2=scopeId
    expectRecursiveDescendantScope(memberSql, 2)

    // T3 起 employeeCount 用 $1=date + $2=scopeId（参数顺序：[date, ...scopeParams]）
    const empSql = sqlList.find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toMatch(/s\.store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(empSql, 2)
  })

  test('scopeType=store：staff/client 截面 SQL 走单值过滤', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const memberSql = sqlList.find(isMemberCountSql)
    expect(memberSql).toBeDefined()
    // T2 起 memberCount 用 $2=scopeId（$1=date）
    expect(memberSql).toContain('c.bound_store_id = $2')
    // 业务 scope 仍是单值；额外的 IN 子查询用于排除停用门店。
    expect(memberSql).toMatch(/active_node\.is_active\s*=\s*TRUE/)

    // T3 起 employeeCount 用 $1=date + $2=scopeId
    const empSql = sqlList.find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toContain('s.store_id = $2')
    expect(empSql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
  })

  test('T2/T3 后 memberCount 与 employeeCount 都依赖 date（$1::date 出现），且都不走 date_trunc 月份聚合', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const memberSql = pg.query.mock.calls.map((c) => c[0]).find(isMemberCountSql)
    expect(memberSql).toBeDefined()
    // T2 历史化：memberCount 内出现 $1::date（不再是无日期截面）
    expect(memberSql).toMatch(/\$1::date/)
    // 但仍不应出现 date_trunc（不是按月份窗口聚合）
    expect(memberSql).not.toMatch(/date_trunc/)

    // T3 历史化：employeeCount 内也出现 $1::date 守卫（hired_at/resigned_at）
    const empSql = pg.query.mock.calls.map((c) => c[0]).find((s) => /FROM staff_wechat_users/.test(s))
    expect(empSql).toBeDefined()
    expect(empSql).toMatch(/\$1::date/)
    expect(empSql).not.toMatch(/date_trunc/)
  })

  test('scopeType=all 时 memberCount + employeeCount 保留启用门店过滤，无 URL scope 参数', async () => {
    setupCensusMocks()
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    // T6 起：employeeCount 调用 2 次（day + month），所以 censusSqls = memberCount(1) + employeeCount(2) = 3
    const censusSqls = sqlList.filter((s) => isMemberCountSql(s) || /FROM staff_wechat_users/.test(s))
    expect(censusSqls.length).toBe(3)
    for (const s of censusSqls) {
      expect(s).toMatch(/WHERE\s+\(TRUE\)\s+AND/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(s).not.toMatch(/parent_id/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
    }
  })

  test('scopeType=all 时 retainedMemberCount 仅限启用门店，仍带 90 天窗口 + became_member_at 守卫', async () => {
    setupCensusMocks({ retainedCount: 12 })
    const ctx = makeHqCtx({ date: '2026-04-25', scopeType: 'all' })
    await summary(ctx)

    const retainedSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((s) => /FROM service_orders/.test(s) && /became_member_at/.test(s))
    expect(retainedSql).toBeDefined()
    expect(retainedSql).toMatch(/WHERE\s+\(TRUE\)\s+AND/)
    expect(retainedSql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
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

  test('HQ 账号返回全部市场及其启用门店', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx = createCtx({
      auth: {
        staffLevel: 'headquarters',
        loginLevel: 'management',
        roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      },
    })

    await scopeOptions(ctx)

    const scopeSql = pg.query.mock.calls[0][0]
    expect(scopeSql).toMatch(/o_store\.is_active\s*=\s*TRUE/)
    expect(ctx.result.staffLevel).toBe('headquarters')
    expect(ctx.result.allowAll).toBe(true)
    expect(ctx.result.allowedMarketIds).toEqual(['mkt-A', 'mkt-B', 'mkt-C'])
    expect(ctx.result.markets).toHaveLength(3)
    expect(ctx.result.markets.map((m) => m.id).sort()).toEqual(['mkt-A', 'mkt-B', 'mkt-C'])
    for (const m of ctx.result.markets) {
      expect(m.stores).toHaveLength(2)
      expect(m.stores[0]).toHaveProperty('storeId')
      expect(m.stores[0]).toHaveProperty('storeName')
    }
  })

  test('market 账号仅返回自己市场及其完整启用门店', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx = createCtx({
      auth: {
        staffLevel: 'market',
        loginLevel: 'management',
        roleBindings: [{ role: 'manager', scopeId: 'mkt-A', scopeType: '市场' }],
        scopeOrgNodeIds: ['mkt-A', 'org-A1', 'org-A2'],
        scopeStoreIds: ['store-A1', 'store-A2'],
      },
    })

    await scopeOptions(ctx)

    expect(ctx.result.staffLevel).toBe('market')
    expect(ctx.result.allowAll).toBe(false)
    expect(ctx.result.allowedMarketIds).toEqual(['mkt-A'])
    expect(ctx.result.markets).toHaveLength(1)
    expect(ctx.result.markets[0].id).toBe('mkt-A')
    expect(ctx.result.markets[0].name).toBe('华东市场')
    expect(ctx.result.markets[0].stores).toHaveLength(2)
  })

  test('store_manager + loginLevel=store → 被 loginLevel 闸拦截（须以管理层身份登录）', async () => {
    const ctx = createManagerCtx({})
    await expect(scopeOptions(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
    // 未走到 pg 查询（中间件在 handler 入口就抛）
    expect(pg.query).not.toHaveBeenCalled()
  })

  test('store_manager + management → 返回全部 scopeStoreIds 覆盖的门店（跨市场各自保留）', async () => {
    pg.query.mockReset().mockResolvedValueOnce(THREE_MARKETS_ROWS)

    const ctx = createCtx({
      auth: {
        staffLevel: 'store_manager',
        loginLevel: 'management',
        effectiveStoreId: null,
        currentStoreId: null,
        // 管理层读数据使用所有角色 scope：manager@A + customer_mgr@B。
        managerStoreIds: ['store-A1'],
        scopeStoreIds: ['store-A1', 'store-B1'],
        roleBindings: [
          { role: 'manager', scopeId: 'org-A1', scopeType: '门店' },
          { role: 'customer_mgr', scopeId: 'org-B1', scopeType: '门店' },
        ],
      },
    })

    await scopeOptions(ctx)

    expect(ctx.result.staffLevel).toBe('store_manager')
    // mkt-A / mkt-B 各保留 1 家授权门店；mkt-C 无授权门店被丢弃
    expect(ctx.result.markets).toHaveLength(2)
    const a = ctx.result.markets.find((m) => m.id === 'mkt-A')
    const b = ctx.result.markets.find((m) => m.id === 'mkt-B')
    expect(a.stores.map((s) => s.storeId)).toEqual(['store-A1'])
    expect(b.stores.map((s) => s.storeId)).toEqual(['store-B1'])
    expect(ctx.result.markets.find((m) => m.id === 'mkt-C')).toBeUndefined()
  })

  test('连续两次调用均重新查询，组织变更立即反映在范围下拉', async () => {
    pg.query.mockReset()
      .mockResolvedValueOnce(THREE_MARKETS_ROWS)
      .mockResolvedValueOnce(THREE_MARKETS_ROWS.filter((row) => row.store_id !== 'store-A2'))

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

    expect(pg.query).toHaveBeenCalledTimes(2)
    expect(ctx1.result.markets).toHaveLength(3)
    expect(ctx2.result.markets).toHaveLength(3)
    expect(ctx1.result.markets.find((market) => market.id === 'mkt-A').stores)
      .toHaveLength(2)
    expect(ctx2.result.markets.find((market) => market.id === 'mkt-A').stores)
      .toHaveLength(1)
  })
})

// =============================================================================
// storeRanking —— 门店排行榜（mgmt-dashboard ranking tab）
// =============================================================================

describe('mgmtDashboard.storeRanking', () => {
  // 默认 mock：返回 3 行（业绩 200/100/50）
  function setupDefaultRankingMocks(rows) {
    pg.query.mockReset().mockImplementation(async () => rows || [
      { store_id: 'store-A1', store_name: '上海A店', market_name: '华东市场', value: 200 },
      { store_id: 'store-A2', store_name: '上海B店', market_name: '华东市场', value: 100 },
      { store_id: 'store-B1', store_name: '广州A店', market_name: '华南市场', value: 50 },
    ])
  }

  // ---- 参数校验 ----

  describe('参数校验', () => {
    test('缺 period 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ metric: 'revenue' })
      await expect(storeRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
    })

    test('非法 period 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'today', metric: 'revenue' })
      await expect(storeRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
    })

    test('缺 metric 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'month' })
      await expect(storeRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*指标/)
    })

    test('非法 metric 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'month', metric: 'foo' })
      await expect(storeRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*指标/)
    })
  })

  // ---- 权限 ----

  describe('权限', () => {
    test('store_manager + loginLevel=store → 被 loginLevel 闸拦截（须以管理层身份登录）', async () => {
      const ctx = createManagerCtx({ period: 'month', metric: 'revenue' })
      await expect(storeRanking(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
    })

    test('headquarters：SQL 不带权限门店参数，但统一排除停用门店', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/WHERE\s+\(TRUE\)\s+AND\s+s\.store_id\s+IN/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(sql).not.toMatch(/store_id\s*=\s*ANY/)
      expect(pg.query.mock.calls[0][1]).toEqual([])
    })

    test('market：SQL 含 s.store_id = ANY($1::text[])，参数为 scopeStoreIds', async () => {
      setupDefaultRankingMocks([
        { store_id: 'store-001', store_name: '上海A店', market_name: '华东市场', value: 100 },
      ])
      const ctx = makeMarketCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      const params = pg.query.mock.calls[0][1]
      expect(sql).toMatch(/s\.store_id\s*=\s*ANY\(\$1::text\[\]\)/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(params).toEqual([['store-001']])
    })

    test('store_manager + management：ANY 参数 = 全部 scopeStoreIds（所有角色授权门店）', async () => {
      // 管理层数据中心按全部角色 scope 查询；managerStoreIds 仅用于门店模式下的写操作。
      setupDefaultRankingMocks()
      const ctx = createCtx({
        payload: { period: 'month', metric: 'revenue' },
        auth: {
          staffLevel: 'store_manager',
          loginLevel: 'management',
          effectiveStoreId: null,
          currentStoreId: null,
          // manager@门店A + customer_mgr@门店B：管理层排行榜可见 A+B。
          managerStoreIds: ['store-001'],
          scopeStoreIds: ['store-001', 'store-002'],
          roleBindings: [
            { role: 'manager', scopeId: 'org-node-store-001', scopeType: '门店' },
            { role: 'customer_mgr', scopeId: 'org-node-store-002', scopeType: '门店' },
          ],
          roles: ['manager', 'customer_mgr'],
        },
      })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      const params = pg.query.mock.calls[0][1]
      expect(sql).toMatch(/s\.store_id\s*=\s*ANY\(\$1::text\[\]\)/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(params).toEqual([['store-001', 'store-002']])
    })

    test('market 且 scopeStoreIds 为空：SQL 走 FALSE，rows=[]', async () => {
      // mock 返空（FALSE 条件下 stores JOIN 也会被过滤掉）
      pg.query.mockReset().mockImplementation(async () => [])
      const ctx = createCtx({
        payload: { period: 'month', metric: 'revenue' },
        auth: {
          staffLevel: 'market',
          loginLevel: 'management',
          roleBindings: [{ role: 'manager', scopeId: 'mkt-empty', scopeType: '市场' }],
          scopeStoreIds: [],
        },
      })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/WHERE\s+FALSE/)
      expect(pg.query.mock.calls[0][1]).toEqual([])
      expect(ctx.result.rows).toEqual([])
    })
  })

  // ---- SQL 形态断言（按 metric） ----

  describe('SQL 形态断言：revenue', () => {
    test('period=month → date_trunc(\'month\', spe.performance_date) = date_trunc(\'month\', NOW()::date)；条件含销售单/转换单/充值单/付款状态', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM stores s/)
      expect(sql).toMatch(/LEFT JOIN sale_order_performance_events spe\b/)
      expect(sql).toMatch(/spe\.performance_date/)
      expect(sql).toMatch(/date_trunc\('month',\s*spe\.performance_date\)\s*=\s*date_trunc\('month',\s*NOW\(\)::date\)/)
      expect(sql).toContain('销售单')
      expect(sql).toContain('转换单')
      expect(sql).toContain('充值单')
      expect(sql).toContain("spe.status = '已支付'")
      expect(sql).toContain("spe.change_type IN ('首次支付', '回款', '退款')")
      expect(sql).toMatch(/SUM\(spe\.amount::numeric\)/)
      expect(sql).toMatch(/ORDER BY value DESC, s\.store_name ASC/)
    })

    test('period=lastMonth → 用 NOW()::date - INTERVAL \'1 month\'', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'lastMonth', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/date_trunc\('month',\s*NOW\(\)::date\s*-\s*INTERVAL\s+'1 month'\)/)
    })

    test('period=year → date_trunc(\'year\', spe.performance_date) = date_trunc(\'year\', NOW()::date)', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'year', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/date_trunc\('year',\s*spe\.performance_date\)\s*=\s*date_trunc\('year',\s*NOW\(\)::date\)/)
    })
  })

  describe('SQL 形态断言：consume', () => {
    test('FROM stores LEFT JOIN service_orders so2 + service_items sit；status=已完成 + service_date period', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'consume' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/LEFT JOIN service_orders so2/)
      expect(sql).toMatch(/LEFT JOIN service_items sit/)
      expect(sql).toMatch(/LEFT JOIN sale_items si/)
      expect(sql).toContain("so2.status = '已完成'")
      expect(sql).toMatch(/so2\.service_date/)
      // consume 公式（2026-06 简化）：unit_real_price（已是单次价）× session_used，
      // 已去 quantity / session_count 中间项（unit_real_price 存储口径改为单次价）
      expect(sql).toMatch(/SUM\(sit\.unit_real_price::numeric \* sit\.session_used\)/)
    })
  })

  describe('SQL 形态断言：projectCount', () => {
    test('SUM(sit.session_used) WHERE sales_category IN (\'自销自耗\',\'他销自耗\') ∩ status=已完成 ∩ service_date', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'projectCount' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/LEFT JOIN service_orders so2/)
      expect(sql).toMatch(/LEFT JOIN service_items sit/)
      expect(sql).toMatch(/SUM\(sit\.session_used\)/)
      expect(sql).toMatch(/sit\.sales_category\s+IN/)
      expect(sql).toContain('自销自耗')
      expect(sql).toContain('他销自耗')
      expect(sql).toContain("so2.status = '已完成'")
      expect(sql).toMatch(/so2\.service_date/)
    })
  })

  describe('SQL 形态断言：retainedMember', () => {
    test('period=month → refDate = NOW()::date；含 became_member_at 守卫 + 90 天 EXISTS 子查询', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'retainedMember' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/LEFT JOIN client_wechat_users c/)
      expect(sql).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
      expect(sql).toMatch(/c\.became_member_at::date\s*<=\s*NOW\(\)::date/)
      expect(sql).toMatch(/EXISTS\s*\(/)
      expect(sql).toMatch(/FROM service_orders so/)
      expect(sql).toContain("so.status = '已完成'")
      expect(sql).toMatch(/INTERVAL\s+'90 days'/)
      expect(sql).toMatch(/COUNT\(DISTINCT c\.user_id\)/)
    })

    test('period=lastMonth → refDate 用 (date_trunc(\'month\', NOW()::date) - INTERVAL \'1 day\')::date', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'lastMonth', metric: 'retainedMember' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(
        /\(date_trunc\('month',\s*NOW\(\)::date\)\s*-\s*INTERVAL\s+'1 day'\)::date/,
      )
      // 不应再出现 NOW()::date 直接作为 refDate（除了上面那个 date_trunc 内部的 NOW 之外）
      // 防回归：所有 c.became_member_at::date 比较都用 lastMonth 的 refDate
      expect(sql).toMatch(
        /c\.became_member_at::date\s*<=\s*\(date_trunc\('month',\s*NOW\(\)::date\)\s*-\s*INTERVAL\s+'1 day'\)::date/,
      )
    })

    test('period=year → refDate = NOW()::date（与 month 一致）', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'year', metric: 'retainedMember' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/c\.became_member_at::date\s*<=\s*NOW\(\)::date/)
    })
  })

  describe('SQL 形态断言：newMember', () => {
    test('LEFT JOIN client_wechat_users + became_member_at IS NOT NULL ∩ became_member_at period（2026-04-25 起，旧 old_member_level/member_level_upgraded_at 已废弃）', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'newMember' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/LEFT JOIN client_wechat_users c/)
      expect(sql).toContain('c.became_member_at IS NOT NULL')
      expect(sql).toMatch(/date_trunc\('month',\s*c\.became_member_at\)/)
      // 旧口径不应再出现
      expect(sql).not.toMatch(/c\.old_member_level/)
      expect(sql).not.toMatch(/c\.member_level_upgraded_at/)
      expect(sql).not.toMatch(/c\.member_level\s+IS\s+NOT\s+NULL/)
      // COUNT 表达式：用 c.user_id（PK）而非已纠正的旧 client_user_id（该列不存在）
      expect(sql).toMatch(/COUNT\(c\.user_id\)/)
    })
  })

  describe('SQL 形态断言：footfall', () => {
    test('COUNT(DISTINCT so2.client_user_id) + status=已完成 ∩ client_user_id IS NOT NULL ∩ service_date', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'footfall' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/LEFT JOIN service_orders so2/)
      expect(sql).toMatch(/COUNT\(DISTINCT so2\.client_user_id\)/)
      expect(sql).toContain("so2.status = '已完成'")
      expect(sql).toMatch(/so2\.client_user_id\s+IS\s+NOT\s+NULL/)
      expect(sql).toMatch(/so2\.service_date/)
    })
  })

  // ---- 排名分配 ----

  describe('排名分配（assignRanks）', () => {
    test('[200, 100, 50] → rank 1/2/3', async () => {
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: 200 },
        { store_id: 'B', store_name: '上海B店', market_name: '华东市场', value: 100 },
        { store_id: 'C', store_name: '上海C店', market_name: '华东市场', value: 50 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 2, 3])
      expect(ctx.result.rows.map((r) => r.value)).toEqual([200, 100, 50])
    })

    test('[100, 100, 50] → rank 1/1/3 (RANK 跳号语义)', async () => {
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: 100 },
        { store_id: 'B', store_name: '上海B店', market_name: '华东市场', value: 100 },
        { store_id: 'C', store_name: '上海C店', market_name: '华东市场', value: 50 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 1, 3])
    })

    test('[100, 100, 100] → rank 1/1/1 (全部并列)', async () => {
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: 100 },
        { store_id: 'B', store_name: '上海B店', market_name: '华东市场', value: 100 },
        { store_id: 'C', store_name: '上海C店', market_name: '华东市场', value: 100 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 1, 1])
    })
  })

  // ---- value=0 仍返回 ----

  describe('value=0 也要返回（垫底展示）', () => {
    test('mock 返一行 value=0 → 仍出现在 rows 中，rank=1', async () => {
      setupDefaultRankingMocks([
        { store_id: 'X', store_name: '空数据店', market_name: '华东市场', value: 0 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows).toHaveLength(1)
      expect(ctx.result.rows[0]).toEqual({
        rank: 1,
        storeId: 'X',
        storeName: '空数据店',
        marketName: '华东市场',
        value: 0,
      })
    })

    test('混合：[200, 0, 0] → rank 1/2/2', async () => {
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: 200 },
        { store_id: 'B', store_name: '上海B店', market_name: '华东市场', value: 0 },
        { store_id: 'C', store_name: '上海C店', market_name: '华东市场', value: 0 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 2, 2])
      expect(ctx.result.rows.map((r) => r.value)).toEqual([200, 0, 0])
    })
  })

  // ---- 二级排序 ----

  describe('二级排序', () => {
    test('SQL 含 ORDER BY value DESC, s.store_name ASC', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/ORDER BY\s+value\s+DESC,\s*s\.store_name\s+ASC/)
    })

    // 全 6 个 metric 都应有同样的 ORDER BY
    test.each(['revenue', 'consume', 'retainedMember', 'newMember', 'projectCount', 'footfall'])(
      'metric=%s SQL 含 ORDER BY value DESC, s.store_name ASC',
      async (metric) => {
        setupDefaultRankingMocks()
        const ctx = makeHqCtx({ period: 'month', metric })
        await storeRanking(ctx)

        const sql = pg.query.mock.calls[0][0]
        expect(sql).toMatch(/ORDER BY\s+value\s+DESC,\s*s\.store_name\s+ASC/)
      },
    )
  })

  // ---- unit 派生 ----

  describe('unit 派生', () => {
    test.each([
      ['revenue', 'amount'],
      ['consume', 'amount'],
      ['retainedMember', 'count'],
      ['newMember', 'count'],
      ['projectCount', 'count'],
      ['footfall', 'count'],
    ])('metric=%s → unit=%s', async (metric, expectedUnit) => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric })
      await storeRanking(ctx)
      expect(ctx.result.unit).toBe(expectedUnit)
    })
  })

  // ---- 返回结构完整性 ----

  describe('返回结构', () => {
    test('返回字段：period, metric, unit, rows, computedAt', async () => {
      setupDefaultRankingMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.period).toBe('month')
      expect(ctx.result.metric).toBe('revenue')
      expect(ctx.result.unit).toBe('amount')
      expect(Array.isArray(ctx.result.rows)).toBe(true)
      expect(typeof ctx.result.computedAt).toBe('string')
    })

    test('rows 元素结构：{rank, storeId, storeName, marketName, value}', async () => {
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: 200 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(ctx.result.rows[0]).toEqual({
        rank: 1,
        storeId: 'A',
        storeName: '上海A店',
        marketName: '华东市场',
        value: 200,
      })
    })

    test('value 类型：从 PG 返回的 string/numeric 自动转 Number', async () => {
      // 模拟 PG numeric 列返回字符串
      setupDefaultRankingMocks([
        { store_id: 'A', store_name: '上海A店', market_name: '华东市场', value: '12345.67' },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await storeRanking(ctx)

      expect(typeof ctx.result.rows[0].value).toBe('number')
      expect(ctx.result.rows[0].value).toBe(12345.67)
    })
  })
})

// =============================================================================
// staffRanking —— 员工排行榜（mgmt-dashboard ranking tab 「员工」子视图）
// =============================================================================

describe('mgmtDashboard.staffRanking', () => {
  // 默认 mock：3 个产能员工 [200, 100, 50]
  function setupDefaultStaffMocks(rows) {
    pg.query.mockReset().mockImplementation(async () => rows || [
      { employee_id: 'EMP-A', employee_name: '胡蕾',     store_id: 'store-001', store_name: '上海A店', value: 200 },
      { employee_id: 'EMP-B', employee_name: '王陶蕊子', store_id: 'store-001', store_name: '上海A店', value: 100 },
      { employee_id: 'EMP-C', employee_name: '杨钰珊',   store_id: 'store-002', store_name: '上海B店', value: 50 },
    ])
  }

  // ---- 参数校验 ----

  describe('参数校验', () => {
    test('缺 period 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ metric: 'revenue' })
      await expect(staffRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
    })

    test('非法 period 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'today', metric: 'revenue' })
      await expect(staffRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
    })

    test('缺 metric 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'month' })
      await expect(staffRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*指标/)
    })

    test('非法 metric 抛 INVALID_PARAMS', async () => {
      const ctx = makeHqCtx({ period: 'month', metric: 'foo' })
      await expect(staffRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*指标/)
    })

    test('门店独有 metric=retainedMember 在员工排行榜被拒', async () => {
      const ctx = makeHqCtx({ period: 'month', metric: 'retainedMember' })
      await expect(staffRanking(ctx)).rejects.toThrow(/INVALID_PARAMS.*指标/)
    })
  })

  // ---- 权限 ----

  describe('权限', () => {
    test('store_manager + loginLevel=store → 被 loginLevel 闸拦截（须以管理层身份登录）', async () => {
      const ctx = createManagerCtx({ period: 'month', metric: 'revenue' })
      await expect(staffRanking(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
    })

    test('headquarters：SQL 不带权限门店参数，但统一排除停用门店', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      // 产能员工 CTE 保留启用门店条件。
      // 2026-05-20 P0-4 修复：去掉 sw.skills 过滤（漏算 33% 业绩），由 metric SQL 自然过滤
      expect(sql).toMatch(/resigned_at::date\s*>\s*NOW\(\)::date\)?[\s\S]*?AND\s+\(TRUE\)\s+AND\s+sw\.store_id\s+IN/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(sql).not.toMatch(/sw\.skills\s*&&\s*ARRAY/)
      expect(sql).not.toMatch(/sw\.store_id\s*=\s*ANY/)
      expect(pg.query.mock.calls[0][1]).toEqual([])
    })

    test('market：SQL 含 sw.store_id = ANY($1::text[])，参数为 scopeStoreIds', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'EMP-A', employee_name: '胡蕾', store_id: 'store-001', store_name: '上海A店', value: 100 },
      ])
      const ctx = makeMarketCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      const params = pg.query.mock.calls[0][1]
      expect(sql).toMatch(/sw\.store_id\s*=\s*ANY\(\$1::text\[\]\)/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(params).toEqual([['store-001']])
    })

    test('store_manager + management：ANY 参数 = 全部 scopeStoreIds（所有角色授权门店）', async () => {
      // 与 storeRanking 同口径：管理层数据按全部角色 scope 查询。
      setupDefaultStaffMocks()
      const ctx = createCtx({
        payload: { period: 'month', metric: 'revenue' },
        auth: {
          staffLevel: 'store_manager',
          loginLevel: 'management',
          effectiveStoreId: null,
          currentStoreId: null,
          managerStoreIds: ['store-001'],
          scopeStoreIds: ['store-001', 'store-002'],
          roleBindings: [
            { role: 'manager', scopeId: 'org-node-store-001', scopeType: '门店' },
            { role: 'customer_mgr', scopeId: 'org-node-store-002', scopeType: '门店' },
          ],
          roles: ['manager', 'customer_mgr'],
        },
      })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      const params = pg.query.mock.calls[0][1]
      expect(sql).toMatch(/sw\.store_id\s*=\s*ANY\(\$1::text\[\]\)/)
      expect(sql).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(params).toEqual([['store-001', 'store-002']])
    })

    test('market 且 scopeStoreIds 为空：SQL 走 FALSE，rows=[]', async () => {
      pg.query.mockReset().mockImplementation(async () => [])
      const ctx = createCtx({
        payload: { period: 'month', metric: 'revenue' },
        auth: {
          staffLevel: 'market',
          loginLevel: 'management',
          roleBindings: [{ role: 'manager', scopeId: 'mkt-empty', scopeType: '市场' }],
          scopeStoreIds: [],
        },
      })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      // 2026-05-20 P0-4 修复：CTE 不再含 sw.skills && filter
      expect(sql).toMatch(/resigned_at::date\s*>\s*NOW\(\)::date\)?[\s\S]*?AND\s+FALSE/)
      expect(sql).not.toMatch(/sw\.skills\s*&&\s*ARRAY/)
      expect(pg.query.mock.calls[0][1]).toEqual([])
      expect(ctx.result.rows).toEqual([])
    })
  })

  // ---- 产能员工 CTE 共有片段 ----

  describe('producer_employees CTE', () => {
    test.each(['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income'])(
      'metric=%s 含 producer_employees CTE + hired_at/resigned_at 历史口径（2026-05-20 P0-4: 去 skills 过滤 + 末尾 WHERE COALESCE > 0）',
      async (metric) => {
        setupDefaultStaffMocks()
        const ctx = makeHqCtx({ period: 'month', metric })
        await staffRanking(ctx)

        const sql = pg.query.mock.calls[0][0]
        expect(sql).toMatch(/WITH producer_employees AS/)
        expect(sql).toMatch(/FROM staff_wechat_users sw/)
        expect(sql).toMatch(/LEFT JOIN stores s ON s\.store_id = sw\.store_id/)
        expect(sql).toMatch(/sw\.hired_at\s+IS\s+NOT\s+NULL/)
        expect(sql).toMatch(/sw\.hired_at::date\s*<=\s*NOW\(\)::date/)
        expect(sql).toMatch(/sw\.resigned_at\s+IS\s+NULL\s+OR\s+sw\.resigned_at::date\s*>\s*NOW\(\)::date/)
        // 已去除 skills 过滤
        expect(sql).not.toMatch(/sw\.skills\s*&&\s*ARRAY/)
        // 末尾零值过滤（income 是 COALESCE(sc1.v,0)+COALESCE(sc2.v,0) > 0，其它是单一 COALESCE(x.v,0) > 0）
        expect(sql).toMatch(/WHERE\s+COALESCE\(\w+\.v,\s*0\)[\s\S]*?>\s*0/)
      },
    )

    test.each(['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income'])(
      'metric=%s 最终 SELECT 走 FROM producer_employees pe LEFT JOIN ...',
      async (metric) => {
        setupDefaultStaffMocks()
        const ctx = makeHqCtx({ period: 'month', metric })
        await staffRanking(ctx)

        const sql = pg.query.mock.calls[0][0]
        expect(sql).toMatch(/FROM producer_employees pe/)
        expect(sql).toMatch(/LEFT JOIN [a-z_]+ \w+ ON \w+\.employee_id = pe\.employee_id/)
      },
    )
  })

  // ---- SQL 形态断言（按 metric） ----

  describe('SQL 形态断言：revenue（业绩）', () => {
    test('LEFT JOIN sale_payment_item_allocations + receipts + sale_items + sale_orders；过滤 is_void=FALSE + 销售单/转换单 + 已支付，不按 role_type 白名单截断', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM sale_payment_item_allocations spia/)
      expect(sql).toMatch(/JOIN sale_payment_item_receipts spir/)
      expect(sql).toMatch(/JOIN sale_items si/)
      expect(sql).toMatch(/JOIN sale_orders so/)
      expect(sql).toMatch(/spia\.is_void\s*=\s*FALSE/)
      expect(sql).not.toMatch(/spia\.role_type\s+IN\s*\('美容师','养生师'\)/)
      expect(sql).toContain('销售单')
      expect(sql).toContain('转换单')
      expect(sql).toContain("spe.status = '已支付'")
      expect(sql).toMatch(/SUM\(spia\.allocated_amount/)
      expect(sql).toMatch(/date_trunc\('month',\s*spe\.performance_date\)\s*=\s*date_trunc\('month',\s*NOW\(\)::date\)/)
    })

    test('period=lastMonth → NOW()::date - INTERVAL \'1 month\'', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'lastMonth', metric: 'revenue' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/date_trunc\('month',\s*NOW\(\)::date\s*-\s*INTERVAL\s+'1 month'\)/)
    })

    test('period=year → date_trunc(\'year\', spe.performance_date)', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'year', metric: 'revenue' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/date_trunc\('year',\s*spe\.performance_date\)/)
    })
  })

  describe('SQL 形态断言：consume（实耗）', () => {
    test('FROM service_items sit JOIN service_orders so2 + sale_items si；status=已完成 + service_date period', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'consume' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM service_items sit/)
      expect(sql).toMatch(/JOIN service_orders so2/)
      expect(sql).toMatch(/JOIN sale_items si/)
      expect(sql).toContain("so2.status = '已完成'")
      // consume 公式（2026-06 简化）：unit_real_price（已是单次价）× session_used
      expect(sql).toMatch(/SUM\(sit\.unit_real_price::numeric \* sit\.session_used\)/)
      expect(sql).toMatch(/so2\.service_date/)
    })
  })

  describe('SQL 形态断言：newMember（新会员）', () => {
    test('FROM client_wechat_users WHERE bound_employee_id IS NOT NULL ∩ became_member_at period（旧 old_member_level/member_level_upgraded_at 已废弃）', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'newMember' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM client_wechat_users c/)
      expect(sql).toMatch(/c\.bound_employee_id\s+IS\s+NOT\s+NULL/)
      expect(sql).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
      expect(sql).toMatch(/date_trunc\('month',\s*c\.became_member_at\)/)
      expect(sql).toMatch(/GROUP BY c\.bound_employee_id/)
      expect(sql).not.toMatch(/old_member_level/)
      expect(sql).not.toMatch(/member_level_upgraded_at/)
    })
  })

  describe('SQL 形态断言：footfall（客流）', () => {
    test('COUNT(DISTINCT so2.client_user_id) ∩ status=已完成 ∩ client_user_id IS NOT NULL', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'footfall' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM service_items sit/)
      expect(sql).toMatch(/JOIN service_orders so2/)
      expect(sql).toMatch(/COUNT\(DISTINCT so2\.client_user_id\)/)
      expect(sql).toContain("so2.status = '已完成'")
      expect(sql).toMatch(/so2\.client_user_id\s+IS\s+NOT\s+NULL/)
      // 按员工分组（service_items.employee_id）
      expect(sql).toMatch(/GROUP BY sit\.employee_id/)
    })
  })

  describe('SQL 形态断言：projectCount（项目数）', () => {
    test('SUM(sit.session_used) ∩ sales_category IN (\'自销自耗\',\'他销自耗\') ∩ status=已完成', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'projectCount' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      expect(sql).toMatch(/FROM service_items sit/)
      expect(sql).toMatch(/JOIN service_orders so2/)
      expect(sql).toMatch(/SUM\(sit\.session_used\)/)
      expect(sql).toMatch(/sit\.sales_category\s+IN/)
      expect(sql).toContain('自销自耗')
      expect(sql).toContain('他销自耗')
      expect(sql).toContain("so2.status = '已完成'")
      expect(sql).toMatch(/GROUP BY sit\.employee_id/)
    })
  })

  describe('SQL 形态断言：income（收入 = 销售提成 + 服务提成）', () => {
    test('含 sales_comm + service_comm 两个 CTE，最终 SELECT 求和两个 LEFT JOIN', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'income' })
      await staffRanking(ctx)

      const sql = pg.query.mock.calls[0][0]
      // sales_comm CTE：与 revenue 公式同构（M4：收入维度不再按 role_type 过滤，区别于 revenue 业绩维度仍过滤）
      expect(sql).toMatch(/sales_comm AS/)
      expect(sql).toMatch(/FROM sale_payment_item_allocations spia/)
      expect(sql).not.toMatch(/spia\.role_type\s+IN/)
      expect(sql).toContain("spe.status = '已支付'")
      // service_comm CTE：service_commissions
      expect(sql).toMatch(/service_comm AS/)
      expect(sql).toMatch(/FROM service_commissions sc/)
      expect(sql).toMatch(/sc\.is_void\s*=\s*FALSE/)
      expect(sql).not.toMatch(/sc\.role_type\s+IN/)
      expect(sql).toContain("so2.status = '已完成'")
      // 最终求和
      expect(sql).toMatch(/COALESCE\(sc1\.v,\s*0\)\s*\+\s*COALESCE\(sc2\.v,\s*0\)/)
      expect(sql).toMatch(/LEFT JOIN sales_comm\s+sc1\s+ON sc1\.employee_id = pe\.employee_id/)
      expect(sql).toMatch(/LEFT JOIN service_comm\s+sc2\s+ON sc2\.employee_id = pe\.employee_id/)
    })
  })

  // ---- 排序 ----

  describe('排序', () => {
    test.each(['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income'])(
      'metric=%s SQL 含 ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC',
      async (metric) => {
        setupDefaultStaffMocks()
        const ctx = makeHqCtx({ period: 'month', metric })
        await staffRanking(ctx)

        const sql = pg.query.mock.calls[0][0]
        expect(sql).toMatch(
          /ORDER BY\s+value\s+DESC,\s*pe\.employee_name\s+ASC,\s*pe\.employee_id\s+ASC/,
        )
      },
    )
  })

  // ---- 排名分配 ----

  describe('排名分配（assignRanks）', () => {
    test('[200, 100, 50] → rank 1/2/3', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 2, 3])
      expect(ctx.result.rows.map((r) => r.value)).toEqual([200, 100, 50])
    })

    test('[100, 100, 50] → rank 1/1/3 (RANK 跳号)', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'A', employee_name: '甲', store_id: 'store-001', store_name: '上海A店', value: 100 },
        { employee_id: 'B', employee_name: '乙', store_id: 'store-001', store_name: '上海A店', value: 100 },
        { employee_id: 'C', employee_name: '丙', store_id: 'store-002', store_name: '上海B店', value: 50 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 1, 3])
    })

    test('value=0 仍返回（垫底展示），混合 [200, 0, 0] → rank 1/2/2', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'A', employee_name: '甲', store_id: 'store-001', store_name: '上海A店', value: 200 },
        { employee_id: 'B', employee_name: '乙', store_id: 'store-001', store_name: '上海A店', value: 0 },
        { employee_id: 'C', employee_name: '丙', store_id: 'store-002', store_name: '上海B店', value: 0 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows.map((r) => r.rank)).toEqual([1, 2, 2])
      expect(ctx.result.rows.map((r) => r.value)).toEqual([200, 0, 0])
    })
  })

  // ---- unit 派生 ----

  describe('unit 派生', () => {
    test.each([
      ['revenue', 'amount'],
      ['consume', 'amount'],
      ['income',  'amount'],
      ['newMember',    'count'],
      ['footfall',     'count'],
      ['projectCount', 'count'],
    ])('metric=%s → unit=%s', async (metric, expectedUnit) => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric })
      await staffRanking(ctx)
      expect(ctx.result.unit).toBe(expectedUnit)
    })
  })

  // ---- 返回结构 ----

  describe('返回结构', () => {
    test('返回字段：period, metric, unit, rows, computedAt', async () => {
      setupDefaultStaffMocks()
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.period).toBe('month')
      expect(ctx.result.metric).toBe('revenue')
      expect(ctx.result.unit).toBe('amount')
      expect(Array.isArray(ctx.result.rows)).toBe(true)
      expect(typeof ctx.result.computedAt).toBe('string')
    })

    test('rows 元素结构：{rank, employeeId, employeeName, storeId, storeName, value}', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'EMP-A', employee_name: '胡蕾', store_id: 'store-001', store_name: '上海A店', value: 200 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows[0]).toEqual({
        rank: 1,
        employeeId: 'EMP-A',
        employeeName: '胡蕾',
        storeId: 'store-001',
        storeName: '上海A店',
        value: 200,
      })
    })

    test('value 类型：从 PG numeric 字符串自动转 Number', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'A', employee_name: '甲', store_id: 'store-001', store_name: '上海A店', value: '12345.67' },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(typeof ctx.result.rows[0].value).toBe('number')
      expect(ctx.result.rows[0].value).toBe(12345.67)
    })

    test('store_id IS NULL → storeId=null，storeName=空串（前端兜底"—"）', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'A', employee_name: '甲', store_id: null, store_name: null, value: 100 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows[0].storeId).toBeNull()
      expect(ctx.result.rows[0].storeName).toBe('')
    })

    test('employee_name IS NULL → employeeName=空串（前端兜底"未命名员工"）', async () => {
      setupDefaultStaffMocks([
        { employee_id: 'A', employee_name: null, store_id: 'store-001', store_name: '上海A店', value: 100 },
      ])
      const ctx = makeHqCtx({ period: 'month', metric: 'revenue' })
      await staffRanking(ctx)

      expect(ctx.result.rows[0].employeeName).toBe('')
    })
  })
})

// =====================================================================
// mgmtDashboard.salesData
// =====================================================================

describe('mgmtDashboard.salesData 参数与权限校验', () => {
  test('缺 period 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scope: { type: 'all' } })
    await expect(salesData(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
  })

  test('period 非法值抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'week', scope: { type: 'all' } })
    await expect(salesData(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
  })

  test('scope.type 缺失抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scope: {} })
    await expect(salesData(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('scope.type=store 缺 scope.id 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'store' } })
    await expect(salesData(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('门店模式调用管理层接口被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({ period: 'month', scope: { type: 'all' } })
    await expect(salesData(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scope: { type: 'all' } })
    await expect(salesData(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })
})

describe('mgmtDashboard.salesData 时间区间口径', () => {
  function setupSalesDataMocks(overrides = {}) {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/GROUP BY\s+si\.sales_category/.test(sql)) return overrides.cat || []
      if (/GROUP BY\s+pc\.product_kind\b(?!.*pc\.category_name)/.test(sql)) return overrides.kind || []
      if (/GROUP BY\s+pc\.product_kind,\s*pc\.category_name/.test(sql)) return overrides.name || []
      if (/FROM product_categories\b/.test(sql)) return overrides.skeleton || []
      if (/si\.product_type\s*=\s*'家居产品'/.test(sql)) return [{ xiaomei: 0, new_member: 0, old_member: 0 }]
      if (/FROM service_items sit/.test(sql) && /JOIN client_wechat_users/.test(sql)) return [{ xiaomei: 0, new_member: 0, old_member: 0 }]
      if (/FROM service_items sit/.test(sql)) return [{ v: overrides.consValue || 0 }]
      if (/FROM sale_order_performance_events spe/.test(sql) && /JOIN client_wechat_users/.test(sql)) {
        return [{ xiaomei: 0, new_member: 0, old_member: 0 }]
      }
      if (/FROM sale_items si/.test(sql) && /JOIN client_wechat_users/.test(sql)) return [{ xiaomei: 0, new_member: 0, old_member: 0 }]
      if (/FROM sale_order_performance_events spe/.test(sql) && /SUM\(spe\.amount::numeric/.test(sql)) {
        return [{ v: overrides.revValue || 0 }]
      }
      return [{ v: 0 }]
    })
  }

  test('period=month：SQL 参数 $1 为当月 01 日', async () => {
    setupSalesDataMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const allCalls = pg.query.mock.calls
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const expectedStart = `${y}-${m}-01`

    const totalRevCall = allCalls.find(([sql]) => /FROM sale_order_performance_events spe/.test(sql) && /AS v/.test(sql))
    expect(totalRevCall).toBeDefined()
    expect(totalRevCall[1][0]).toBe(expectedStart)
  })

  test('period=lastMonth：endDate 为上月最后一天（非今天）', async () => {
    setupSalesDataMocks()
    const ctx = makeHqCtx({ period: 'lastMonth', scope: { type: 'all' } })
    await salesData(ctx)

    const allCalls = pg.query.mock.calls
    const now = new Date()
    const lmY = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    const lmM = now.getMonth() === 0 ? 12 : now.getMonth()
    const lastDay = new Date(Date.UTC(lmY, lmM, 0)).getUTCDate()
    const expectedEnd = `${lmY}-${String(lmM).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`

    const totalRevCall = allCalls.find(([sql]) => /FROM sale_order_performance_events spe/.test(sql) && /AS v/.test(sql))
    expect(totalRevCall[1][1]).toBe(expectedEnd)
    // endDate 不是 today
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
    expect(totalRevCall[1][1]).not.toBe(todayStr)
  })

  test('period=year：startDate 为当年 01-01', async () => {
    setupSalesDataMocks()
    const ctx = makeHqCtx({ period: 'year', scope: { type: 'all' } })
    await salesData(ctx)

    const allCalls = pg.query.mock.calls
    const expectedStart = `${new Date().getFullYear()}-01-01`
    const totalRevCall = allCalls.find(([sql]) => /FROM sale_order_performance_events spe/.test(sql) && /AS v/.test(sql))
    expect(totalRevCall[1][0]).toBe(expectedStart)
  })
})

describe('mgmtDashboard.salesData 空数据返回全零与骨架', () => {
  test('无订单时金额全 "0.00"；bySalesCategory 4 行硬骨架；byProductKind 由 product_categories 骨架决定', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      // SQL 9：product_categories 骨架（2 个 kind，3 个 leaf）
      if (/FROM product_categories\b/.test(sql)) {
        return [
          { product_kind: '护理项目', category_name: '中华神灸' },
          { product_kind: '护理项目', category_name: '面部护理' },
          { product_kind: '家居产品', category_name: '安吉丽美颜之爱' },
        ]
      }
      // 其余分组 SQL 全空
      if (/GROUP BY/.test(sql)) return []
      return [{ v: 0, xiaomei: 0, new_member: 0, old_member: 0 }]
    })
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const r = ctx.result
    expect(r.totalRevenue).toBe('0.00')
    expect(r.xiaomeiRevenue).toBe('0.00')
    expect(r.newMemberRevenue).toBe('0.00')
    expect(r.oldMemberRevenue).toBe('0.00')
    expect(r.totalConsume).toBe('0.00')
    expect(r.xiaomeiProjectConsume).toBe('0.00')
    expect(r.newMemberProjectConsume).toBe('0.00')
    expect(r.oldMemberProjectConsume).toBe('0.00')
    expect(r.xiaomeiProductOut).toBe('0.00')
    expect(r.newMemberProductOut).toBe('0.00')
    expect(r.oldMemberProductOut).toBe('0.00')
    // 经营类型 4 行硬骨架（pgEnum 4 值）
    expect(r.bySalesCategory).toHaveLength(4)
    expect(r.bySalesCategory.map((x) => x.label)).toEqual(['自销自耗', '他销自耗', '他销他耗', '生态合作'])
    expect(r.bySalesCategory.every((x) => x.value === '0.00')).toBe(true)
    // 经营类型分母为 0 时 ratio 全为 '—'
    expect(r.bySalesCategory.every((x) => x.ratio === '—')).toBe(true)
    // 一级品项骨架（来自 SQL 9）
    expect(r.byProductKind).toHaveLength(2)
    const kinds = r.byProductKind.map((g) => g.label).sort()
    expect(kinds).toEqual(['家居产品', '护理项目'].sort())
    // 一级品项分母为 0 时 ratio 全为 '—'
    expect(r.byProductKind.every((g) => g.ratio === '—')).toBe(true)
    // 每个一级 value 为 0.00，且 children 完整列出该 kind 下所有 category_name
    const careGroup = r.byProductKind.find((g) => g.label === '护理项目')
    expect(careGroup.value).toBe('0.00')
    expect(careGroup.children).toHaveLength(2)
    expect(careGroup.children.every((c) => c.value === '0.00')).toBe(true)
    // 二级品项分母为 0 时 ratio 全为 '—'
    expect(careGroup.children.every((c) => c.ratio === '—')).toBe(true)
    expect(careGroup.children.map((c) => c.label).sort()).toEqual(['中华神灸', '面部护理'].sort())
    const homeGroup = r.byProductKind.find((g) => g.label === '家居产品')
    expect(homeGroup.children).toHaveLength(1)
    expect(homeGroup.children[0]).toEqual({ label: '安吉丽美颜之爱', value: '0.00', ratio: '—' })
    // 不再返回 byCategoryName 字段
    expect(r.byCategoryName).toBeUndefined()
  })

  test('product_categories 全空时 byProductKind = []', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM product_categories\b/.test(sql)) return []
      if (/GROUP BY/.test(sql)) return []
      return [{ v: 0, xiaomei: 0, new_member: 0, old_member: 0 }]
    })
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)
    expect(ctx.result.byProductKind).toEqual([])
    // 经营类型骨架仍硬展示
    expect(ctx.result.bySalesCategory).toHaveLength(4)
  })
})

describe('mgmtDashboard.salesData SQL 形态断言', () => {
  function setupFullMocks() {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/GROUP BY\s+si\.sales_category/.test(sql)) return [{ label: '自销自耗', value: 1000 }]
      // SQL 8 (嵌套二级) — 必须放在 SQL 7 之前，否则会被 SQL 7 的 product_kind 正则吞掉
      if (/GROUP BY\s+pc\.product_kind,\s*pc\.category_name/.test(sql)) {
        return [{ kind: '护理项目', label: '面部护理', value: 300 }]
      }
      if (/GROUP BY\s+pc\.product_kind\b/.test(sql)) return [{ label: '护理项目', value: 500 }]
      if (/FROM product_categories\b/.test(sql)) {
        return [
          { product_kind: '护理项目', category_name: '面部护理' },
          { product_kind: '护理项目', category_name: '中华神灸' },
          { product_kind: '家居产品', category_name: '安吉丽' },
        ]
      }
      if (/si\.product_type\s*=\s*'家居产品'/.test(sql)) return [{ xiaomei: 100, new_member: 200, old_member: 300 }]
      if (/FROM service_items sit/.test(sql) && /JOIN client_wechat_users/.test(sql)) return [{ xiaomei: 50, new_member: 100, old_member: 150 }]
      if (/FROM service_items sit/.test(sql)) return [{ v: 5000 }]
      if (/FROM sale_order_performance_events spe/.test(sql) && /JOIN client_wechat_users/.test(sql)) {
        return [{ xiaomei: 200, new_member: 400, old_member: 600 }]
      }
      if (/FROM sale_items si/.test(sql) && /JOIN client_wechat_users/.test(sql)) return [{ xiaomei: 200, new_member: 400, old_member: 600 }]
      if (/FROM sale_order_performance_events spe/.test(sql) && /SUM\(spe\.amount::numeric/.test(sql)) return [{ v: 10000 }]
      return [{ v: 0 }]
    })
  }

  test('scope=all：主业务 SQL 无 URL scope 参数，但统一排除停用门店', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls.map(([s]) => s)
    const mainSqls = sqls.filter((s) =>
      /sale_orders|service_orders|sale_items/.test(s) && !/GROUP BY/.test(s)
    )
    for (const s of mainSqls) {
      expect(s).toMatch(/WHERE\s+\(TRUE\)\s+AND/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
    }
  })

  test('scope=store：sale SQL 含 o.store_id = $3；service SQL 含 so.store_id = $3', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'store', id: 'store-001' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls.map(([s]) => s)
    const saleSqls = sqls.filter((s) => /FROM sale_orders o\b/.test(s) || /FROM sale_order_performance_events spe\b/.test(s) || /FROM sale_item_performance_events sipe\b/.test(s))
    const svcSqls = sqls.filter((s) => /FROM service_orders so\b/.test(s) || /FROM service_items sit/.test(s))

    for (const s of saleSqls) {
      expect(s).toMatch(/o\.store_id\s*=\s*\$3/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    }
    for (const s of svcSqls) {
      expect(s).toMatch(/so\.store_id\s*=\s*\$3/)
      expect(s).toMatch(/active_node\.is_active\s*=\s*TRUE/)
    }
  })

  test('分客型业绩 SQL 含 FILTER WHERE + customer_type + became_member_at 判定（2026-05-20 P0-2/P0-3 修复：订单层 + NULL 兜底）', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls.map(([s]) => s)
    // SQL 2 与 SQL 1 共用付款流水，充值单也能进入客群分桶
    const custRevSql = sqls.find((s) =>
      /FROM sale_order_performance_events spe/.test(s) &&
      /JOIN client_wechat_users c/.test(s) &&
      /FILTER/.test(s) &&
      !/product_type/.test(s)
    )
    expect(custRevSql).toBeDefined()
    expect(custRevSql).toContain("customer_type = '小美客'")
    expect(custRevSql).toContain("customer_type = '会员客'")
    // NULL 兜底：COALESCE(c.became_member_at, '1970-01-01'::timestamptz)
    expect(custRevSql).toMatch(/COALESCE\(c\.became_member_at,\s*'1970-01-01'::timestamptz\)::date\s*>=/)
    expect(custRevSql).toMatch(/COALESCE\(c\.became_member_at,\s*'1970-01-01'::timestamptz\)::date\s*</)
    // 守恒：使用 spe.amount，与 SQL 1 总额同口径
    expect(custRevSql).toMatch(/SUM\(spe\.amount::numeric\)/)
    expect(custRevSql).toMatch(/spe\.change_type IN \('首次支付',\s*'回款',\s*'退款'\)/)
    expect(custRevSql).toContain('充值单')
    expect(custRevSql).not.toMatch(/o\.status\s*=/)
  })

  test('产品出库 SQL 含 product_type = 家居产品', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls.map(([s]) => s)
    const prodSql = sqls.find((s) => /si\.product_type\s*=\s*'家居产品'/.test(s))
    expect(prodSql).toBeDefined()
    expect(prodSql).toContain('JOIN client_wechat_users c')
    expect(prodSql).toMatch(/FILTER/)
  })

  test('经营类型 4 行硬骨架 — SQL 缺失值补 "0.00"，pgEnum 顺序固定', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/GROUP BY\s+si\.sales_category/.test(sql)) return [
        { label: '自销自耗', value: 1000 },
        // 他销自耗 / 他销他耗 / 生态合作 都缺失，骨架应补 0.00
      ]
      if (/FROM product_categories\b/.test(sql)) return []
      if (/GROUP BY/.test(sql)) return []
      return [{ v: 0, xiaomei: 0, new_member: 0, old_member: 0 }]
    })
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    expect(ctx.result.bySalesCategory).toHaveLength(4)
    expect(ctx.result.bySalesCategory).toEqual([
      { label: '自销自耗', value: '1000.00', ratio: '100.00%' },
      { label: '他销自耗', value: '0.00', ratio: '0.00%' },
      { label: '他销他耗', value: '0.00', ratio: '0.00%' },
      { label: '生态合作', value: '0.00', ratio: '0.00%' },
    ])
  })

  test('一级品项嵌套：byProductKind[i].children 来自 product_categories 骨架；有数据的二级排前，零值下沉', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/GROUP BY\s+si\.sales_category/.test(sql)) return []
      if (/GROUP BY\s+pc\.product_kind,\s*pc\.category_name/.test(sql)) {
        return [
          { kind: '护理项目', label: '中华神灸', value: 500 },
          { kind: '护理项目', label: '面部护理', value: 200 },
        ]
      }
      if (/GROUP BY\s+pc\.product_kind\b/.test(sql)) return [
        { label: '护理项目', value: 700 },
      ]
      if (/FROM product_categories\b/.test(sql)) {
        return [
          { product_kind: '护理项目', category_name: '中华神灸' },
          { product_kind: '护理项目', category_name: '面部护理' },
          { product_kind: '护理项目', category_name: '其他' },
          { product_kind: '家居产品', category_name: '安吉丽' },
        ]
      }
      return [{ v: 0, xiaomei: 0, new_member: 0, old_member: 0 }]
    })
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const r = ctx.result
    // 一级按 value DESC：护理项目(700) > 家居产品(0)
    expect(r.byProductKind.map((g) => g.label)).toEqual(['护理项目', '家居产品'])
    expect(r.byProductKind[0].value).toBe('700.00')
    expect(r.byProductKind[1].value).toBe('0.00')
    // 一级 ratio：分母=品项总额(700)；护理项目 700/700=100%，家居产品 0/700=0%
    expect(r.byProductKind[0].ratio).toBe('100.00%')
    expect(r.byProductKind[1].ratio).toBe('0.00%')
    // 护理项目 children：中华神灸(500) > 面部护理(200) > 其他(0)；二级 ratio 分母=品项总额(700)
    expect(r.byProductKind[0].children).toEqual([
      { label: '中华神灸', value: '500.00', ratio: '71.43%' },
      { label: '面部护理', value: '200.00', ratio: '28.57%' },
      { label: '其他', value: '0.00', ratio: '0.00%' },
    ])
    // 家居产品下骨架 1 项，全 0
    expect(r.byProductKind[1].children).toEqual([
      { label: '安吉丽', value: '0.00', ratio: '0.00%' },
    ])
    // 不再返回扁平 byCategoryName
    expect(r.byCategoryName).toBeUndefined()
  })

  test('SQL 9 骨架查询无 scope 参数（与时间窗 / 门店无关）', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'store', id: 'store-001' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls
    const skeletonCall = sqls.find(([s]) => /FROM product_categories\b/.test(s))
    expect(skeletonCall).toBeDefined()
    expect(skeletonCall[1]).toEqual([])
    expect(skeletonCall[0]).toMatch(/product_kind IS NOT NULL/)
    expect(skeletonCall[0]).toMatch(/category_name IS NOT NULL/)
  })

  test('SQL 8 已带 product_kind/category_name NULL 过滤 + 返回 kind 列', async () => {
    setupFullMocks()
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    const sqls = pg.query.mock.calls.map(([s]) => s)
    const sql8 = sqls.find((s) => /GROUP BY\s+pc\.product_kind,\s*pc\.category_name/.test(s))
    expect(sql8).toBeDefined()
    expect(sql8).toMatch(/pc\.product_kind\s+AS\s+kind/)
    expect(sql8).toMatch(/pc\.category_name\s+AS\s+label/)
    expect(sql8).toMatch(/pc\.product_kind IS NOT NULL/)
    expect(sql8).toMatch(/pc\.category_name IS NOT NULL/)
  })

  test('totalRevenue 从 v 映射，金额为字符串格式 "0.00"', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM sale_order_performance_events spe/.test(sql) && /SUM\(spe\.amount::numeric/.test(sql)) {
        return [{ v: '12345.678' }]
      }
      if (/GROUP BY/.test(sql)) return []
      return [{ v: 0, xiaomei: 0, new_member: 0, old_member: 0 }]
    })
    const ctx = makeHqCtx({ period: 'month', scope: { type: 'all' } })
    await salesData(ctx)

    expect(ctx.result.totalRevenue).toBe('12345.68')
    expect(typeof ctx.result.totalRevenue).toBe('string')
  })
})
