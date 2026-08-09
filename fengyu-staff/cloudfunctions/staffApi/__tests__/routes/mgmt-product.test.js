/**
 * mgmtProduct 路由测试 — cardHolders + cycleStats（品项数据子页）
 *
 * 覆盖：
 *   - 入参/权限校验（INVALID_PARAMS / PERMISSION_DENIED）
 *   - cardHolders SQL 形态（持卡过滤、JOIN、scope 三档、memberCount 派生 rate）
 *   - cycleStats SQL 形态（CTE 链断言：daily_agg → qualifying_days → first_entry → period_agg → xinzeng/fugou/tiyan）
 *   - 出数与防除零（avgTicket=null when count=0）
 *   - threshold 注入（getMemberThreshold mock）
 */

const pg = globalThis.__mocks__.pg
const config = globalThis.__mocks__.config
const { createCtx, createManagerCtx } = require('../helpers')
const { cardHolders, cycleStats } = require('../../routes/mgmt-product')

// ---- ctx 构造 ----
function makeHqCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'headquarters',
      loginLevel: 'management',
      roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      scopeStoreIds: ['store-001', 'store-002'],
      scopeOrgNodeIds: ['org-hq', 'mkt-A', 'mkt-B'],
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
      scopeOrgNodeIds: ['mkt-A'],
    },
  })
}

function expectRecursiveDescendantScope(sql, rootParamIndex) {
  expect(sql).toMatch(/WITH RECURSIVE descendants\(id, path\) AS/)
  expect(sql).toMatch(new RegExp('SELECT \\$' + rootParamIndex + '::text, ARRAY\\[\\$' + rootParamIndex + '::text\\]'))
  expect(sql).toMatch(/JOIN descendants ON child\.parent_id = descendants\.id/)
  expect(sql).toMatch(/WHERE NOT child\.id = ANY\(descendants\.path\)/)
  expect(sql).toMatch(/JOIN descendants ON s\.org_node_id = descendants\.id/)
}

// ---- mock 工具 ----

/**
 * cardHolders 默认 mock：
 *   持卡 SQL → cardRows
 *   memberCount SQL → [{ cnt: memberCount }]
 *   resolveScopeName → [{ name: marketName }] / [{ store_name: storeName }]
 */
function setupCardMocks({
  cardRows = [],
  memberCount = 0,
  marketName = '华东市场',
  storeName = '凤御A店',
} = {}) {
  pg.query.mockReset().mockImplementation(async (sql) => {
    if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) {
      return [{ store_name: storeName }]
    }
    // memberCount SQL：FROM client_wechat_users + became_member_at IS NOT NULL
    if (/FROM\s+client_wechat_users\s+c/.test(sql) && /became_member_at\s+IS\s+NOT\s+NULL/.test(sql)) {
      return [{ cnt: memberCount }]
    }
    // 持卡 SQL：JOIN product_categories pc + product_kind 分组
    if (/JOIN\s+product_categories\s+pc/.test(sql) && /pc\.product_kind/.test(sql)) {
      return cardRows
    }
    return []
  })
}

/**
 * cycleStats 默认 mock：
 *   CTE 主 SQL → unionRows（含 group_kind）
 *   resolveScopeName → name 兜底
 */
function setupCycleMocks({
  unionRows = [],
  marketName = '华东市场',
  storeName = '凤御A店',
} = {}) {
  pg.query.mockReset().mockImplementation(async (sql) => {
    if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) {
      return [{ store_name: storeName }]
    }
    if (/WITH\s+daily_agg\s+AS/.test(sql)) {
      return unionRows
    }
    return []
  })
}

// ===================================================================
// cardHolders — 参数与权限校验
// ===================================================================

describe('mgmtProduct.cardHolders 参数与权限校验', () => {
  test('缺 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({})
    await expect(cardHolders(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('未知 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scopeType: 'foo' })
    await expect(cardHolders(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scopeType: 'market' })
    await expect(cardHolders(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeId/)
  })

  test('门店模式调用管理层接口被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({ scopeType: 'all' })
    await expect(cardHolders(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ scopeType: 'all' })
    await expect(cardHolders(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号选其他 market → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ scopeType: 'market', scopeId: 'mkt-B' })
    await expect(cardHolders(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
  })
})

// ===================================================================
// cardHolders — SQL 形态
// ===================================================================

describe('mgmtProduct.cardHolders SQL 形态', () => {
  test('SQL 含 paid_sessions > 0，不含 product_type/remaining_sessions 持卡过滤 + 双 JOIN', async () => {
    setupCardMocks({ cardRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const cardSql = sqlList.find(
      (s) => /JOIN\s+product_categories\s+pc/.test(s) && /pc\.product_kind/.test(s),
    )
    expect(cardSql).toBeTruthy()
    expect(cardSql).toMatch(/si\.paid_sessions\s*>\s*0/)
    expect(cardSql).not.toMatch(/si\.product_type\s*=\s*'疗程卡'/)
    expect(cardSql).not.toMatch(/si\.remaining_sessions\s*>\s*0/)
    expect(cardSql).toMatch(/JOIN\s+product_skus\s+sk/)
    expect(cardSql).toMatch(/JOIN\s+product_categories\s+pc/)
    expect(cardSql).toMatch(/COUNT\(DISTINCT\s+so\.client_user_id\)/)
    expect(cardSql).toMatch(/GROUP BY\s+pc\.product_kind/)
    // 2026-05-18 B5：寄存单（剩余次数初始化）按次数维度纳入持卡人数
    expect(cardSql).toMatch(/so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/)
    expect(cardSql).toMatch(/so\.status\s*=\s*'已支付'/)
  })

  test('memberCount SQL 形态：FROM client_wechat_users + became_member_at IS NOT NULL（与 metrics.md memberCount T2 历史化口径一致）', async () => {
    setupCardMocks({ cardRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const memberSql = sqlList.find(
      (s) => /FROM\s+client_wechat_users\s+c/.test(s) && /became_member_at\s+IS\s+NOT\s+NULL/.test(s),
    )
    expect(memberSql).toBeTruthy()
    expect(memberSql).toMatch(/COUNT\(\*\)::int\s+AS\s+cnt/)
  })

  test('scopeType=all：持卡与 memberCount SQL 都用 WHERE TRUE，无 store_id 参数', async () => {
    setupCardMocks({ cardRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const cardSql = sqlList.find((s) => /JOIN\s+product_categories\s+pc/.test(s))
    const memberSql = sqlList.find(
      (s) => /FROM\s+client_wechat_users\s+c/.test(s) && /became_member_at\s+IS\s+NOT\s+NULL/.test(s),
    )
    expect(cardSql).toMatch(/WHERE\s+TRUE/)
    expect(memberSql).toMatch(/WHERE\s+TRUE/)
    expect(cardSql).not.toMatch(/store_id\s*=\s*\$/)
    expect(memberSql).not.toMatch(/bound_store_id\s*=\s*\$/)
  })

  test('scopeType=market：持卡与会员数均走递归后代组织树', async () => {
    setupCardMocks({ cardRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'market', scopeId: 'mkt-A' })
    await cardHolders(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const cardSql = sqlList.find((s) => /JOIN\s+product_categories\s+pc/.test(s))
    const memberSql = sqlList.find(
      (s) => /FROM\s+client_wechat_users\s+c/.test(s) && /became_member_at\s+IS\s+NOT\s+NULL/.test(s),
    )

    expect(cardSql).toMatch(/so\.store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(cardSql, 1)

    expect(memberSql).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(memberSql, 1)
  })

  test('scopeType=store：持卡用 so.store_id = $1；memberCount 用 c.bound_store_id = $1', async () => {
    setupCardMocks({ cardRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'store', scopeId: 'store-001' })
    await cardHolders(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const cardSql = sqlList.find((s) => /JOIN\s+product_categories\s+pc/.test(s))
    const memberSql = sqlList.find(
      (s) => /FROM\s+client_wechat_users\s+c/.test(s) && /became_member_at\s+IS\s+NOT\s+NULL/.test(s),
    )

    expect(cardSql).toMatch(/so\.store_id\s*=\s*\$1/)
    expect(cardSql).not.toMatch(/store_id\s+IN\s*\(/)
    expect(memberSql).toMatch(/c\.bound_store_id\s*=\s*\$1/)
  })
})

// ===================================================================
// cardHolders — 出数
// ===================================================================

describe('mgmtProduct.cardHolders 出数', () => {
  test('memberCount=1000，护理项目 100 持卡 → rate=10.00（数值）', async () => {
    setupCardMocks({
      cardRows: [
        { product_kind: '护理项目', count: 100 },
        { product_kind: '家居产品', count: 250 },
      ],
      memberCount: 1000,
    })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    expect(ctx.result.memberCount).toBe(1000)
    expect(ctx.result.cardHolders).toEqual([
      { productKind: '护理项目', count: 100, rate: 10 },
      { productKind: '家居产品', count: 250, rate: 25 },
    ])
    // rate 是数值非字符串
    expect(typeof ctx.result.cardHolders[0].rate).toBe('number')
  })

  test('memberCount=0 → rate=null（防除零）', async () => {
    setupCardMocks({
      cardRows: [{ product_kind: '护理项目', count: 50 }],
      memberCount: 0,
    })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    expect(ctx.result.memberCount).toBe(0)
    expect(ctx.result.cardHolders).toEqual([
      { productKind: '护理项目', count: 50, rate: null },
    ])
  })

  test('cardRows 为空 → cardHolders=[]', async () => {
    setupCardMocks({ cardRows: [], memberCount: 100 })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    expect(ctx.result.cardHolders).toEqual([])
    expect(ctx.result.memberCount).toBe(100)
  })

  test('rate 保留 2 位小数（333/1000=33.30，1/3=0.3333 → 0.33）', async () => {
    setupCardMocks({
      cardRows: [
        { product_kind: '护理项目', count: 333 },
        { product_kind: '体验卡', count: 1 },
      ],
      memberCount: 1000,
    })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await cardHolders(ctx)

    expect(ctx.result.cardHolders[0].rate).toBe(33.3)
    expect(ctx.result.cardHolders[1].rate).toBe(0.1)
  })
})

// ===================================================================
// cycleStats — 参数与权限校验
// ===================================================================

describe('mgmtProduct.cycleStats 参数与权限校验', () => {
  test('缺 period 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(cycleStats(ctx)).rejects.toThrow(/INVALID_PARAMS.*period/)
  })

  test('未知 period 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'foo', scopeType: 'all' })
    await expect(cycleStats(ctx)).rejects.toThrow(/INVALID_PARAMS.*period/)
  })

  test('未知 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scopeType: 'foo' })
    await expect(cycleStats(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scopeType: 'market' })
    await expect(cycleStats(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeId/)
  })

  test('门店模式调用管理层接口被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({ period: 'month', scopeType: 'all' })
    await expect(cycleStats(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'all' })
    await expect(cycleStats(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号选其他 market → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'market', scopeId: 'mkt-B' })
    await expect(cycleStats(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
  })
})

// ===================================================================
// cycleStats — SQL 形态（CTE 链）
// ===================================================================

describe('mgmtProduct.cycleStats SQL 形态', () => {
  function getCycleSql() {
    return pg.query.mock.calls.map((c) => c[0]).find((s) => /WITH\s+daily_agg\s+AS/.test(s))
  }

  test('daily_agg GROUP BY 含 client_user_id、store_id、product_kind 与消费日期', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toBeTruthy()
    // GROUP BY 子句紧随 daily_agg
    expect(sql).toMatch(
      /GROUP BY\s+so\.client_user_id\s*,\s*so\.store_id\s*,\s*pc\.product_kind\s*,\s*COALESCE\(so\.sale_order_datetime,\s*so\.paid_at\)::date/,
    )
  })

  test('daily_agg 纳入有效订单净实收，并以消费日期截止 $2', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    expect(sql).toMatch(/so\.status\s+NOT\s+IN\s*\(\s*'已关闭'\s*,\s*'已作废'\s*,\s*'未审核'\s*,\s*'待审批'\s*,\s*'支付失败'\s*\)/)
    expect(sql).toMatch(/COALESCE\(so\.sale_order_datetime,\s*so\.paid_at\)::date\s*<=\s*\$2/)
  })

  test('qualifying_days WHERE 用 day_received >= $3 不等式（threshold 参数化）', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/qualifying_days\s+AS\s*\(/)
    // 不能用 = 等式
    expect(sql).toMatch(/day_received\s*>=\s*\$3/)
    expect(sql).not.toMatch(/day_received\s*=\s*\$3/)
  })

  test('first_entry SELECT 用 MIN(purchase_date)，GROUP BY 不含 store_id（跨店合并）', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/first_entry\s+AS\s*\(/)
    expect(sql).toMatch(/MIN\(purchase_date\)\s+AS\s+entry_date/)
    // 提取 first_entry CTE 段，断言 GROUP BY 仅 client_user_id, product_kind
    const m = sql.match(/first_entry\s+AS\s*\([\s\S]*?GROUP BY\s+([^\n)]+)/)
    expect(m).toBeTruthy()
    const groupCols = m[1].replace(/\s+/g, '')
    expect(groupCols).toMatch(/client_user_id,product_kind/)
    expect(groupCols).not.toMatch(/store_id/)
  })

  test('fugou 仅统计本期进入 cohort 在进入日后的再次达标', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/fugou\s+AS\s*\(/)
    expect(sql).toMatch(/fugou\s+AS\s*\(\s*SELECT\s+DISTINCT[\s\S]*?JOIN\s+xinzeng\s+x/)
    expect(sql).toMatch(/fugou\s+AS\s*\([\s\S]*?WHERE\s+q\.purchase_date\s+BETWEEN\s+\$1\s+AND\s+\$2/)
    expect(sql).toMatch(/q\.purchase_date\s*>\s*x\.entry_date/)
  })

  test('tiyan WHERE 用 NOT EXISTS (SELECT 1 FROM first_entry f ...)', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/tiyan\s+AS\s*\(/)
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+first_entry\s+f/)
  })

  test('period_agg WHERE 含 purchase_date BETWEEN $1 AND $2', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/period_agg\s+AS\s*\(/)
    expect(sql).toMatch(/purchase_date\s+BETWEEN\s+\$1\s+AND\s+\$2/)
  })

  test('UNION ALL 三段：trial / new / repurchase', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/'trial'\s+AS\s+group_kind/)
    expect(sql).toMatch(/'new'\s+AS\s+group_kind/)
    expect(sql).toMatch(/'repurchase'\s+AS\s+group_kind/)
    // 至少 2 个 UNION ALL
    const unionMatches = sql.match(/UNION\s+ALL/g) || []
    expect(unionMatches.length).toBe(2)
  })

  test('threshold 由 getMemberThreshold 注入，作为 $3 参数', async () => {
    config.getMemberThreshold.mockResolvedValueOnce(1990)
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    expect(config.getMemberThreshold).toHaveBeenCalledTimes(1)

    // 找 CTE SQL 的调用，第 2 参数（params）的 [2] 应是 threshold=1990
    const cycleCall = pg.query.mock.calls.find((c) => /WITH\s+daily_agg\s+AS/.test(c[0]))
    expect(cycleCall).toBeTruthy()
    expect(cycleCall[1][2]).toBe(1990)
  })
})

// ===================================================================
// cycleStats — scope 三档 SQL 形态
// ===================================================================

describe('mgmtProduct.cycleStats scope 三档 SQL 形态', () => {
  function getCycleSql() {
    return pg.query.mock.calls.map((c) => c[0]).find((s) => /WITH\s+daily_agg\s+AS/.test(s))
  }

  test('scopeType=all：daily_agg WHERE 含 TRUE，无 store 参数（params[3] 不存在）', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    // daily_agg 紧跟一段 WHERE，包含 TRUE
    expect(sql).toMatch(/daily_agg\s+AS\s*\(\s*SELECT[\s\S]*?WHERE\s+TRUE/)

    const cycleCall = pg.query.mock.calls.find((c) => /WITH\s+daily_agg\s+AS/.test(c[0]))
    // params: [startDate, endDate, threshold]
    expect(cycleCall[1].length).toBe(3)
  })

  test('scopeType=market：daily_agg 通过递归组织树过滤，参数 params[3]=scopeId', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'market', scopeId: 'mkt-A' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/so\.store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(sql, 4)

    const cycleCall = pg.query.mock.calls.find((c) => /WITH\s+daily_agg\s+AS/.test(c[0]))
    expect(cycleCall[1][3]).toBe('mkt-A')
  })

  test('scopeType=store：daily_agg WHERE 含 so.store_id = $4，params[3]=storeId', async () => {
    setupCycleMocks({})
    const ctx = makeHqCtx({ period: 'month', scopeType: 'store', scopeId: 'store-001' })
    await cycleStats(ctx)

    const sql = getCycleSql()
    expect(sql).toMatch(/so\.store_id\s*=\s*\$4/)
    expect(sql).not.toMatch(/store_id\s+IN\s*\(/)

    const cycleCall = pg.query.mock.calls.find((c) => /WITH\s+daily_agg\s+AS/.test(c[0]))
    expect(cycleCall[1][3]).toBe('store-001')
  })
})

// ===================================================================
// cycleStats — 出数 + 防除零
// ===================================================================

describe('mgmtProduct.cycleStats 出数与防除零', () => {
  test('UNION ALL 三组拆分到 trial / newEntry / repurchase', async () => {
    setupCycleMocks({
      unionRows: [
        { group_kind: 'trial', product_kind: '护理项目', count: 50, revenue: '18000.00' },
        { group_kind: 'trial', product_kind: '家居产品', count: 40, revenue: '30000.00' },
        { group_kind: 'new', product_kind: '护理项目', count: 9, revenue: '18000.00' },
        { group_kind: 'new', product_kind: '家居产品', count: 10, revenue: '30000.00' },
        { group_kind: 'repurchase', product_kind: '护理项目', count: 9, revenue: '18000.00' },
      ],
    })
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    expect(ctx.result.trial).toEqual([
      { productKind: '护理项目', count: 50, revenue: 18000, avgTicket: 360 },
      { productKind: '家居产品', count: 40, revenue: 30000, avgTicket: 750 },
    ])
    expect(ctx.result.newEntry).toEqual([
      { productKind: '护理项目', count: 9, revenue: 18000, avgTicket: 2000 },
      { productKind: '家居产品', count: 10, revenue: 30000, avgTicket: 3000 },
    ])
    expect(ctx.result.repurchase).toEqual([
      { productKind: '护理项目', count: 9, revenue: 18000, avgTicket: 2000, entryCount: 9, repurchaseRate: 1 },
    ])
  })

  test('count=0 → avgTicket=null（防除零）；count>0 → avgTicket 保留 2 位小数', async () => {
    setupCycleMocks({
      unionRows: [
        { group_kind: 'trial', product_kind: '护理项目', count: 0, revenue: '0' },
        { group_kind: 'new', product_kind: '体验卡', count: 3, revenue: '1000' },
      ],
    })
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    expect(ctx.result.trial[0].avgTicket).toBeNull()
    // 1000/3=333.333... → 333.33
    expect(ctx.result.newEntry[0].avgTicket).toBe(333.33)
  })

  test('空 unionRows → trial / newEntry / repurchase 都为 []', async () => {
    setupCycleMocks({ unionRows: [] })
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    expect(ctx.result.trial).toEqual([])
    expect(ctx.result.newEntry).toEqual([])
    expect(ctx.result.repurchase).toEqual([])
  })

  test('返回结构包含 period / scope / startDate / endDate', async () => {
    setupCycleMocks({ unionRows: [] })
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await cycleStats(ctx)

    expect(ctx.result.period).toBe('month')
    expect(ctx.result.scope).toEqual({ type: 'all', id: null, name: '全部市场' })
    expect(ctx.result.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
