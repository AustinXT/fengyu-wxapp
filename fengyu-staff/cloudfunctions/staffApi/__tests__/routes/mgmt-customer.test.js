/**
 * mgmtCustomer 路由测试 — 8 actions（顾客档案管理层视图）
 *
 * 覆盖：
 *   - 入参/权限校验（INVALID_PARAMS / PERMISSION_DENIED）
 *   - stats / search / listByTag SQL 形态（scope 三档：all / market / store）
 *   - detail 越权防护（顾客 bound_store_id 不在 scope）
 *   - detail 出数（消费 / 频率 / 常购按 scope 过滤）
 *   - calendar / paidOrders / giftHistory / refundHistory 的 sale_orders.store_id IN scope 子查询
 *   - 手机号脱敏策略（headquarters / market 不脱敏）
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createManagerCtx } = require('../helpers')
const {
  stats,
  search,
  listByTag,
  detail,
  calendar,
  paidOrders,
  giftHistory,
  refundHistory,
} = require('../../routes/mgmt-customer')

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

// ---- mock 工具 ----

/**
 * 通用 mock：按 SQL 关键字匹配返回 rows
 *   stats 主 SQL（有 last_service_date 计算）→ statsRows
 *   memberCount SQL（customer_id IS NOT NULL）→ [{ cnt: memberCount }]
 *   resolveScopeName → name 兜底
 */
function setupCommonMocks(opts = {}) {
  const {
    statsRows = [],
    memberCount = 0,
    searchRows = [],
    listByTagRows = [],
    listByTagPurchaseRows = [],
    detailRows = null,
    detailVisitRows = [{ last_date: null, visit_count_90d: 0 }],
    detailTopProductRows = [],
    detailConsumptionRows = [{ total: 0, year_total: 0 }],
    spendRows = [],
    svcDateRows = [],
    lastPurchaseRows = [],
    customerInScope = true,
    nameRows = [],
    staffRows = [],
    calendarDailyRows = [],
    calendarOrderRows = [],
    paidOrderRows = [],
    paidOrderItems = [],
    giftPromoRows = [],
    giftItemsRows = [],
    refundOrderRows = [],
    refundItemsRows = [],
    marketName = '华东市场',
    storeName = '凤御A店',
  } = opts

  pg.query.mockReset().mockImplementation(async (sql, params) => {
    // resolveScopeName: org_nodes
    if (/FROM\s+org_nodes\s+WHERE\s+id\s*=\s*\$1/.test(sql) && /SELECT\s+name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    // resolveScopeName: stores
    if (/SELECT\s+store_name\s+FROM\s+stores\s+WHERE\s+store_id/.test(sql)) {
      return [{ store_name: storeName }]
    }
    // assertCustomerInScope: stores JOIN org_nodes WHERE store_id=$1 AND parent_id=$2
    if (
      /FROM\s+stores\s+s/.test(sql) &&
      /JOIN\s+org_nodes\s+o/.test(sql) &&
      /s\.store_id\s*=\s*\$1/.test(sql) &&
      /o\.parent_id\s*=\s*\$2/.test(sql)
    ) {
      return customerInScope ? [{ '?column?': 1 }] : []
    }

    // stats memberCount SQL
    if (
      /FROM\s+client_wechat_users\s+c/.test(sql) &&
      /COUNT\(\*\)\s+AS\s+cnt/.test(sql) &&
      /customer_id\s+IS\s+NOT\s+NULL/.test(sql)
    ) {
      return [{ cnt: memberCount }]
    }

    // stats 主 SQL：含 MAX(so.service_date) AS last_service_date 且 GROUP BY c.user_id, c.birthday
    if (
      /MAX\(so\.service_date\)\s+AS\s+last_service_date/.test(sql) &&
      /FROM\s+client_wechat_users\s+c/.test(sql) &&
      /GROUP BY\s+c\.user_id,\s*c\.birthday\b/.test(sql) &&
      !/year_consumption/.test(sql)
    ) {
      return statsRows
    }

    // listByTag 主 SQL：含 year_consumption + annual.year_total
    if (
      /annual\.year_total/.test(sql) &&
      /FROM\s+client_wechat_users\s+c/.test(sql)
    ) {
      return listByTagRows
    }

    // listByTag 最近购买
    if (
      /DISTINCT ON\s*\(\s*o\.client_user_id\s*\)/.test(sql) &&
      /si\.product_name\s+AS\s+last_product_name/.test(sql) &&
      /JOIN\s+sale_items\s+si/.test(sql)
    ) {
      // search.* 也共用
      // listByTag 用单参数 ANY；search 共用同 SQL
      return lastPurchaseRows.length ? lastPurchaseRows : listByTagPurchaseRows
    }

    // search 主 SQL：SELECT c.user_id ... LIMIT $X
    // 排除 detail 的 LIMIT 1（同样匹配 c.user_id + LEFT JOIN stores 但末尾是 LIMIT 1）
    if (
      /SELECT\s+c\.user_id,\s+c\.phone,\s+c\.name/.test(sql) &&
      /LEFT JOIN\s+stores\s+s/.test(sql) &&
      !/LIMIT\s+1\b/.test(sql)
    ) {
      return searchRows
    }

    // search 年消费 SQL
    if (
      /COALESCE\(SUM\(o\.total_amount::numeric\),\s*0\)\s+AS\s+annual_spend/.test(sql)
    ) {
      return spendRows
    }

    // search 最近服务日期
    if (
      /DISTINCT ON\s*\(\s*so\.client_user_id\s*\)/.test(sql) &&
      /so\.service_date/.test(sql) &&
      /FROM\s+service_orders\s+so/.test(sql)
    ) {
      return svcDateRows
    }

    // detail：SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level ... LIMIT 1
    if (
      /c\.user_id,\s+c\.phone,\s+c\.name,\s+c\.customer_id,\s+c\.member_level/.test(sql) &&
      /LIMIT\s+1/.test(sql) &&
      detailRows !== null
    ) {
      return detailRows
    }

    // detail name 回退
    if (/SELECT\s+customer_name\s+FROM\s+sale_orders/.test(sql)) {
      return nameRows
    }

    // detail 美容师
    if (/SELECT\s+name\s+FROM\s+staff_wechat_users/.test(sql)) {
      return staffRows
    }

    // detail 消费统计
    if (
      /COALESCE\(SUM\(si\.received::numeric\),\s*0\)\s+AS\s+total/.test(sql) &&
      /year_total/.test(sql) &&
      /JOIN\s+sale_items\s+si/.test(sql)
    ) {
      return detailConsumptionRows
    }

    // detail 到店信息
    if (
      /MAX\(so\.service_date\)\s+AS\s+last_date/.test(sql) &&
      /visit_count_90d/.test(sql)
    ) {
      return detailVisitRows
    }

    // detail 常购商品
    if (
      /SELECT\s+si\.product_name,\s+COUNT\(\*\)\s+AS\s+cnt/.test(sql) &&
      /ORDER BY\s+cnt\s+DESC/.test(sql) &&
      /LIMIT\s+1/.test(sql)
    ) {
      return detailTopProductRows
    }

    // calendar dailySummary
    if (
      /DATE\(o\.paid_at\s+AT\s+TIME\s+ZONE\s+'Asia\/Shanghai'\)\s+AS\s+pay_date/.test(sql) &&
      /COUNT\(DISTINCT\s+o\.sale_order_id\)\s+AS\s+order_count/.test(sql)
    ) {
      return calendarDailyRows
    }

    // calendar orders
    if (
      /o\.sale_order_id,\s+o\.sale_order_type,\s+o\.store_id,\s+o\.payment_method/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql) &&
      /ORDER BY\s+o\.paid_at\s+DESC/.test(sql)
    ) {
      return calendarOrderRows
    }

    // paidOrders 订单查询
    if (
      /SELECT\s+o\.sale_order_id,\s+o\.status,\s+o\.paid_at,\s+o\.store_id,\s+s\.store_name/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    ) {
      return paidOrderRows
    }

    // paidOrders 明细
    if (
      /si\.sale_order_id,\s+si\.sale_item_id,\s+si\.store_id/.test(sql) &&
      /si\.session_count,\s+si\.remaining_sessions/.test(sql) &&
      /FROM\s+sale_items\s+si/.test(sql)
    ) {
      return paidOrderItems
    }

    // giftHistory 组合套餐订单
    if (
      /AND\s+FALSE\b/.test(sql) &&
      /sale_order_type/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    ) {
      return giftPromoRows
    }

    // giftHistory 赠品明细
    if (
      /si\.received::numeric\s*=\s*0/.test(sql) &&
      /JOIN\s+sale_orders\s+o/.test(sql)
    ) {
      return giftItemsRows
    }

    // refundHistory 订单
    if (
      /sale_order_type\s+IN\s*\(\s*'退款单'\s*,\s*'转换单'\s*\)/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    ) {
      return refundOrderRows
    }

    // refundHistory 明细
    if (
      /si\.item_direction/.test(sql) &&
      /FROM\s+sale_items\s+si\s+WHERE\s+si\.sale_order_id\s*=\s*ANY/.test(sql)
    ) {
      return refundItemsRows
    }

    return []
  })
}

// ===================================================================
// 参数与权限校验
// ===================================================================

describe('mgmtCustomer 参数与权限校验', () => {
  test('stats 缺 scopeType 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({})
    await expect(stats(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('search 未知 scopeType 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'foo' })
    await expect(search(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeType/)
  })

  test('listByTag scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ tag: 'active', scopeType: 'market' })
    await expect(listByTag(ctx)).rejects.toThrow(/INVALID_PARAMS.*scopeId/)
  })

  test('listByTag 缺 tag 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(listByTag(ctx)).rejects.toThrow(/INVALID_PARAMS.*tag/)
  })

  test('detail 缺三个 ID 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('store_manager 账号被 requireManagementLevel 拦截（stats）', async () => {
    setupCommonMocks()
    const ctx = createManagerCtx({ scopeType: 'all' })
    await expect(stats(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED（search）', async () => {
    setupCommonMocks()
    const ctx = makeMarketCtx({ scopeType: 'all' })
    await expect(search(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号选其他 market → PERMISSION_DENIED（listByTag）', async () => {
    setupCommonMocks()
    const ctx = makeMarketCtx({ tag: 'active', scopeType: 'market', scopeId: 'mkt-B' })
    await expect(listByTag(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
  })

  test('market 账号越权 store → PERMISSION_DENIED（detail）', async () => {
    setupCommonMocks()
    const ctx = makeMarketCtx({
      clientUserId: 'cu-1',
      scopeType: 'store',
      scopeId: 'store-999',
    })
    await expect(detail(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*门店/)
  })
})

// ===================================================================
// stats SQL 形态
// ===================================================================

describe('mgmtCustomer.stats SQL 形态', () => {
  test('scope=all：主 SQL 与 memberCount SQL 都用 WHERE TRUE', async () => {
    setupCommonMocks({ statsRows: [], memberCount: 0 })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await stats(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const mainSql = sqls.find(
      (s) =>
        /MAX\(so\.service_date\)\s+AS\s+last_service_date/.test(s) &&
        /GROUP BY\s+c\.user_id/.test(s),
    )
    const memberSql = sqls.find(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        /customer_id\s+IS\s+NOT\s+NULL/.test(s),
    )

    expect(mainSql).toBeTruthy()
    expect(memberSql).toBeTruthy()
    // c.bound_store_id 与 so.store_id 都使用 TRUE
    expect(mainSql).toMatch(/WHERE\s+TRUE/)
    expect(memberSql).toMatch(/WHERE\s+TRUE/)
  })

  test('scope=market：c.bound_store_id 与 so.store_id 都走 stores JOIN org_nodes', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'market', scopeId: 'mkt-A' })
    await stats(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const mainSql = sqls.find(
      (s) =>
        /MAX\(so\.service_date\)\s+AS\s+last_service_date/.test(s) &&
        /GROUP BY\s+c\.user_id/.test(s),
    )
    const memberSql = sqls.find(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        /customer_id\s+IS\s+NOT\s+NULL/.test(s),
    )

    expect(mainSql).toMatch(
      /c\.bound_store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/,
    )
    expect(mainSql).toMatch(/so\.store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/)
    expect(mainSql).toMatch(/o\.type\s*=\s*'门店'/)

    expect(memberSql).toMatch(
      /c\.bound_store_id\s+IN\s*\(\s*SELECT\s+s\.store_id\s+FROM\s+stores\s+s/,
    )
  })

  test('scope=store：c.bound_store_id = $1, so.store_id = $2', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'store', scopeId: 'store-001' })
    await stats(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const mainSql = sqls.find(
      (s) =>
        /MAX\(so\.service_date\)\s+AS\s+last_service_date/.test(s) &&
        /GROUP BY\s+c\.user_id/.test(s),
    )
    const memberSql = sqls.find(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        /customer_id\s+IS\s+NOT\s+NULL/.test(s),
    )

    // c.bound_store_id = $1 (cs占$1), so.store_id = $2 (sc 紧随)
    expect(mainSql).toMatch(/c\.bound_store_id\s*=\s*\$1/)
    expect(mainSql).toMatch(/so\.store_id\s*=\s*\$2/)
    expect(memberSql).toMatch(/c\.bound_store_id\s*=\s*\$1/)
  })

  test('出数：active/atRisk/lost/sleeping/birthday 分类 + memberCount/flowCount', async () => {
    const today = new Date()
    const recentDate = new Date(today.getTime() - 10 * 86400000) // 10 天前
    const atRiskDate = new Date(today.getTime() - 45 * 86400000)
    const lostDate = new Date(today.getTime() - 75 * 86400000)
    const sleepingDate = new Date(today.getTime() - 200 * 86400000)
    const m = today.getMonth() + 1
    const birthdayThisMonth = `1990-${String(m).padStart(2, '0')}-15`

    setupCommonMocks({
      statsRows: [
        { user_id: 'u1', last_service_date: recentDate, birthday: birthdayThisMonth },
        { user_id: 'u2', last_service_date: atRiskDate, birthday: null },
        { user_id: 'u3', last_service_date: lostDate, birthday: null },
        { user_id: 'u4', last_service_date: sleepingDate, birthday: null },
        { user_id: 'u5', last_service_date: null, birthday: null },
      ],
      memberCount: 3,
    })

    const ctx = makeHqCtx({ scopeType: 'all' })
    await stats(ctx)

    expect(ctx.result.active).toBe(1)
    expect(ctx.result.atRisk).toBe(1)
    expect(ctx.result.lost).toBe(1)
    expect(ctx.result.sleeping).toBe(2) // sleepingDate + null
    expect(ctx.result.birthday).toBe(1)
    expect(ctx.result.total).toBe(5)
    expect(ctx.result.memberCount).toBe(3)
    expect(ctx.result.flowCount).toBe(2)
  })
})

// ===================================================================
// search SQL 形态
// ===================================================================

describe('mgmtCustomer.search SQL 形态', () => {
  test('默认（无 keyword/phone）scope=all：用 WHERE TRUE LIMIT $1', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await search(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const mainSql = sqls.find((s) => /SELECT\s+c\.user_id,\s+c\.phone/.test(s))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toMatch(/WHERE\s+TRUE/)
    expect(mainSql).toMatch(/LIMIT\s+\$1/)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]),
    )
    expect(call[1]).toEqual([20])
  })

  test('默认 scope=market：用 c.bound_store_id IN (...)，参数 [scopeId, 20]', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'market', scopeId: 'mkt-A' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIMIT/.test(c[0]),
    )
    expect(call[0]).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expect(call[0]).toMatch(/o\.parent_id\s*=\s*\$1/)
    expect(call[0]).toMatch(/LIMIT\s+\$2/)
    expect(call[1]).toEqual(['mkt-A', 20])
  })

  test('默认 scope=store：用 c.bound_store_id = $1，参数 [scopeId, 20]', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'store', scopeId: 'store-001' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIMIT/.test(c[0]),
    )
    expect(call[0]).toMatch(/c\.bound_store_id\s*=\s*\$1/)
    expect(call[0]).toMatch(/LIMIT\s+\$2/)
    expect(call[1]).toEqual(['store-001', 20])
  })

  test('keyword=张 scope=market：LIKE $1 + c.bound_store_id IN $2 + LIMIT $3', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ keyword: '张', scopeType: 'market', scopeId: 'mkt-A' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIKE\s+\$1/.test(c[0]),
    )
    expect(call).toBeTruthy()
    expect(call[0]).toMatch(/\(c\.phone\s+LIKE\s+\$1\s+OR\s+c\.name\s+LIKE\s+\$1\)/)
    expect(call[0]).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expect(call[0]).toMatch(/o\.parent_id\s*=\s*\$2/)
    expect(call[0]).toMatch(/LIMIT\s+\$3/)
    expect(call[1]).toEqual(['%张%', 'mkt-A', 20])
  })

  test('phone=13800001111 scope=store：c.phone = $1 AND c.bound_store_id = $2', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({
      phone: '13800001111',
      scopeType: 'store',
      scopeId: 'store-001',
    })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /c\.phone\s*=\s*\$1/.test(c[0]) && /c\.bound_store_id\s*=\s*\$2/.test(c[0]),
    )
    expect(call).toBeTruthy()
    expect(call[1]).toEqual(['13800001111', 'store-001'])
  })
})

// ===================================================================
// listByTag SQL 形态
// ===================================================================

describe('mgmtCustomer.listByTag SQL 形态', () => {
  test('scope=all：主 SQL c/so/o 全部 WHERE TRUE，参数仅 yearStart', async () => {
    setupCommonMocks({ listByTagRows: [] })
    const ctx = makeHqCtx({ tag: 'active', scopeType: 'all' })
    await listByTag(ctx)

    const call = pg.query.mock.calls.find((c) => /annual\.year_total/.test(c[0]))
    expect(call).toBeTruthy()
    // 三处 scope 都退化为 TRUE
    const trueCount = (call[0].match(/\bTRUE\b/g) || []).length
    expect(trueCount).toBeGreaterThanOrEqual(3)
    // 参数：[yearStart]（年初日期字符串，可能受时区影响显示为前一年 12-31）
    expect(call[1].length).toBe(1)
    expect(call[1][0]).toMatch(/^\d{4}-(?:01-01|12-31)$/)
  })

  test('scope=market：主 SQL 含 so.store_id IN + o.store_id IN + c.bound_store_id IN', async () => {
    setupCommonMocks({ listByTagRows: [] })
    const ctx = makeHqCtx({ tag: 'active', scopeType: 'market', scopeId: 'mkt-A' })
    await listByTag(ctx)

    const call = pg.query.mock.calls.find((c) => /annual\.year_total/.test(c[0]))
    expect(call[0]).toMatch(/so\.store_id\s+IN\s*\(/)
    expect(call[0]).toMatch(/o\.store_id\s+IN\s*\(/)
    expect(call[0]).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    // 参数：[yearStart, mkt-A(c), mkt-A(so), mkt-A(o)]
    expect(call[1].slice(1)).toEqual(['mkt-A', 'mkt-A', 'mkt-A'])
  })

  test('scope=store：主 SQL 含 so.store_id = $X + o.store_id = $Y + c.bound_store_id = $Z', async () => {
    setupCommonMocks({ listByTagRows: [] })
    const ctx = makeHqCtx({ tag: 'active', scopeType: 'store', scopeId: 'store-001' })
    await listByTag(ctx)

    const call = pg.query.mock.calls.find((c) => /annual\.year_total/.test(c[0]))
    expect(call[0]).toMatch(/so\.store_id\s*=\s*\$/)
    expect(call[0]).toMatch(/o\.store_id\s*=\s*\$/)
    expect(call[0]).toMatch(/c\.bound_store_id\s*=\s*\$/)
    expect(call[1]).toEqual([expect.any(String), 'store-001', 'store-001', 'store-001'])
  })

  test('tag=birthday 出数：仅返回当月生日；pageSize=20 默认', async () => {
    const m = new Date().getMonth() + 1
    const monthStr = String(m).padStart(2, '0')
    setupCommonMocks({
      listByTagRows: [
        {
          user_id: 'u1',
          name: '张三',
          phone: '13800000001',
          birthday: `1990-${monthStr}-10`,
          member_level: 'star',
          last_service_date: null,
          year_consumption: 8000,
        },
        {
          user_id: 'u2',
          name: '李四',
          phone: '13800000002',
          birthday: `1990-${m === 12 ? '01' : String(m + 1).padStart(2, '0')}-10`,
          member_level: null,
          last_service_date: null,
          year_consumption: 0,
        },
      ],
    })
    const ctx = makeHqCtx({ tag: 'birthday', scopeType: 'all' })
    await listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers.length).toBe(1)
    expect(ctx.result.customers[0].clientUserId).toBe('u1')
    // tier: 8000 → iron
    expect(ctx.result.customers[0].tier).toBe('iron')
  })
})

// ===================================================================
// detail 越权防护
// ===================================================================

describe('mgmtCustomer.detail 越权防护', () => {
  test('scope=market：顾客 bound_store_id 不在该市场 → 403', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '张三',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-out',
          store_name: 'X 店',
          birthday: null,
        },
      ],
      customerInScope: false,
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await expect(detail(ctx)).rejects.toThrow(/PERMISSION_DENIED.*顾客.*scope/)
  })

  test('scope=store：顾客 bound_store_id != scopeId → 403', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '张三',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-other',
          store_name: 'X 店',
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await expect(detail(ctx)).rejects.toThrow(/PERMISSION_DENIED.*顾客.*scope/)
  })

  test('scope=all：headquarters 直接放行（不查 stores JOIN org_nodes）', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '张三',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-X',
          store_name: 'X 店',
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'all' })
    await detail(ctx)
    expect(ctx.result).toBeTruthy()
    expect(ctx.result.clientUserId).toBe('u1')
    // 不应执行 stores JOIN org_nodes 校验
    const sqls = pg.query.mock.calls.map((c) => c[0])
    const scopeCheckSql = sqls.find(
      (s) =>
        /FROM\s+stores\s+s/.test(s) &&
        /JOIN\s+org_nodes\s+o/.test(s) &&
        /s\.store_id\s*=\s*\$1/.test(s) &&
        /o\.parent_id\s*=\s*\$2/.test(s),
    )
    expect(scopeCheckSql).toBeUndefined()
  })
})

// ===================================================================
// detail 出数（消费 / 频率 / 常购按 scope 过滤）
// ===================================================================

describe('mgmtCustomer.detail 出数', () => {
  test('累计/年消费按 scope 过滤；scope=store 时消费 SQL 含 o.store_id = $3', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '张三',
          customer_id: 'C001',
          member_level: 'star',
          bound_employee_id: null,
          skin_type: '油性',
          improvement_focus: null,
          gender: '女',
          notes: null,
          bound_store_id: 'store-001',
          store_name: '凤御A店',
          birthday: null,
        },
      ],
      detailConsumptionRows: [{ total: 12345.67, year_total: 5000 }],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await detail(ctx)

    expect(ctx.result.totalConsumption).toBe(12345.67)
    expect(ctx.result.yearConsumption).toBe(5000)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const consumptionSql = sqls.find(
      (s) =>
        /COALESCE\(SUM\(si\.received::numeric\),\s*0\)\s+AS\s+total/.test(s) &&
        /year_total/.test(s),
    )
    expect(consumptionSql).toMatch(/o\.store_id\s*=\s*\$3/)
  })

  test('visitFrequency 与 topProductName 透传（市场 scope 用 IN 子查询）', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '李四',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-001',
          store_name: 'A 店',
          birthday: null,
        },
      ],
      customerInScope: true,
      detailVisitRows: [{ last_date: '2026-04-20', visit_count_90d: 7 }],
      detailTopProductRows: [{ product_name: '深层补水疗程' }],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await detail(ctx)

    expect(ctx.result.lastServiceDate).toBe('2026-04-20')
    expect(ctx.result.visitFrequency).toBe('两周一次')
    expect(ctx.result.topProductName).toBe('深层补水疗程')

    // visitInfo SQL 含 service_orders so.store_id IN
    const sqls = pg.query.mock.calls.map((c) => c[0])
    const visitSql = sqls.find(
      (s) =>
        /MAX\(so\.service_date\)\s+AS\s+last_date/.test(s) &&
        /visit_count_90d/.test(s),
    )
    expect(visitSql).toMatch(/so\.store_id\s+IN\s*\(/)

    const topSql = sqls.find(
      (s) =>
        /si\.product_name,\s+COUNT\(\*\)\s+AS\s+cnt/.test(s) &&
        /LIMIT\s+1/.test(s),
    )
    expect(topSql).toMatch(/o\.store_id\s+IN\s*\(/)
  })

  test('scope=all：消费 / 频率 / 常购 SQL 全部用 WHERE ... AND TRUE', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: '张三',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-001',
          store_name: 'A 店',
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'all' })
    await detail(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const visitSql = sqls.find(
      (s) =>
        /MAX\(so\.service_date\)\s+AS\s+last_date/.test(s) &&
        /visit_count_90d/.test(s),
    )
    const topSql = sqls.find(
      (s) =>
        /si\.product_name,\s+COUNT\(\*\)\s+AS\s+cnt/.test(s) &&
        /LIMIT\s+1/.test(s),
    )
    const consumptionSql = sqls.find(
      (s) =>
        /COALESCE\(SUM\(si\.received::numeric\),\s*0\)\s+AS\s+total/.test(s) &&
        /year_total/.test(s),
    )

    expect(visitSql).toMatch(/AND\s+TRUE/)
    expect(topSql).toMatch(/AND\s+TRUE/)
    expect(consumptionSql).toMatch(/AND\s+TRUE/)
  })
})

// ===================================================================
// calendar / paidOrders / giftHistory / refundHistory SQL 形态
// ===================================================================

describe('mgmtCustomer 细节 SQL：sale_orders.store_id IN scope', () => {
  test('calendar scope=market：dailySummary SQL 与 orders SQL 都含 o.store_id IN', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      year: 2026,
      month: 4,
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await calendar(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const dailySql = sqls.find((s) =>
      /DATE\(o\.paid_at\s+AT\s+TIME\s+ZONE\s+'Asia\/Shanghai'\)/.test(s) &&
      /COUNT\(DISTINCT/.test(s),
    )
    const ordersSql = sqls.find(
      (s) =>
        /o\.sale_order_id,\s+o\.sale_order_type,\s+o\.store_id/.test(s) &&
        /ORDER BY\s+o\.paid_at\s+DESC/.test(s),
    )
    expect(dailySql).toMatch(/o\.store_id\s+IN\s*\(/)
    expect(ordersSql).toMatch(/o\.store_id\s+IN\s*\(/)
  })

  test('paidOrders scope=store：订单 SQL 含 o.store_id = $X', async () => {
    setupCommonMocks({
      paidOrderRows: [
        { sale_order_id: 'so-1', status: '已支付', paid_at: '2026-04-20', store_id: 'store-001', store_name: 'A 店' },
      ],
      paidOrderItems: [
        {
          sale_order_id: 'so-1',
          sale_item_id: 'si-1',
          store_id: 'store-001',
          session_count: 10,
          remaining_sessions: 8,
          sku_id: 'sku-1',
          product_type: '疗程卡',
          sku_spec_name: 'A 规格',
          product_name: '深层补水',
        },
      ],
    })
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'store',
      scopeId: 'store-001',
    })
    await paidOrders(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const ordersSql = sqls.find(
      (s) =>
        /SELECT\s+o\.sale_order_id,\s+o\.status,\s+o\.paid_at,\s+o\.store_id/.test(s) &&
        /FROM\s+sale_orders\s+o/.test(s),
    )
    expect(ordersSql).toMatch(/o\.store_id\s*=\s*\$/)
    expect(ctx.result.orders[0].items[0].itemName).toBe('深层补水')
  })

  test('giftHistory scope=market：赠品 SQL 含 o.store_id IN', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await giftHistory(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const giftSql = sqls.find((s) => /si\.received::numeric\s*=\s*0/.test(s))
    expect(giftSql).toMatch(/o\.store_id\s+IN\s*\(/)
  })

  test('refundHistory scope=market：退款单 SQL 含 o.store_id IN', async () => {
    setupCommonMocks({
      refundOrderRows: [
        {
          sale_order_id: 'so-r1',
          status: '已退款',
          sale_order_type: '退款单',
          total_amount: 100,
          refund_reason: '不适合',
          handling_fee: null,
          ref_sale_order_id: 'so-1',
          approved_by: null,
          approved_at: null,
          rejected_reason: null,
          created_at: '2026-04-22',
          paid_at: null,
        },
      ],
      refundItemsRows: [],
    })
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await refundHistory(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const refundSql = sqls.find((s) =>
      /sale_order_type\s+IN\s*\(\s*'退款单'\s*,\s*'转换单'\s*\)/.test(s),
    )
    expect(refundSql).toMatch(/o\.store_id\s+IN\s*\(/)
    expect(ctx.result.orders[0].type).toBe('退款单')
  })
})

// ===================================================================
// 手机号脱敏策略
// ===================================================================

describe('mgmtCustomer 手机号脱敏策略', () => {
  test('staffLevel=headquarters → search 返回原值 phone', async () => {
    setupCommonMocks({
      searchRows: [
        {
          user_id: 'u1',
          phone: '13800138000',
          name: '张三',
          customer_id: null,
          member_level: null,
          bound_store_id: 'store-001',
          store_name: 'A 店',
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await search(ctx)

    expect(ctx.result.customers[0].phone).toBe('13800138000')
    expect(ctx.result.customers[0].phoneMasked).toBe('138****8000')
  })

  test('staffLevel=market → detail 返回原值 phone', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u1',
          phone: '13900139000',
          name: '李四',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-001',
          store_name: 'A 店',
          birthday: null,
        },
      ],
      customerInScope: true,
    })
    const ctx = makeMarketCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await detail(ctx)

    expect(ctx.result.phone).toBe('13900139000')
    expect(ctx.result.phoneMasked).toBe('139****9000')
  })
})

// ===================================================================
// detail / paidOrders / calendar / giftHistory / refundHistory 出数完整路径
// ===================================================================

describe('mgmtCustomer 出数完整路径', () => {
  test('detail 支持 clientUserId 入参 + 姓名回退 + 美容师解析 + scope 名称', async () => {
    setupCommonMocks({
      detailRows: [
        {
          user_id: 'u-detail',
          phone: '13700137000',
          name: '', // 触发 nameRows 回退
          customer_id: 'cust-id-001',
          member_level: '金钻',
          bound_employee_id: 'emp-bound-1',
          skin_type: '混合性',
          improvement_focus: '抗衰',
          gender: '女',
          notes: '老顾客',
          bound_store_id: 'store-001',
          store_name: ' A 店 ',
          birthday: '1990-03-15',
        },
      ],
      nameRows: [{ customer_name: '回退姓名' }],
      staffRows: [{ name: '王美容师' }],
      detailVisitRows: [{ last_date: '2026-04-20', visit_count_90d: 8 }],
      detailTopProductRows: [{ product_name: '深层补水' }],
      detailConsumptionRows: [{ total: 9999.5, year_total: 3000 }],
      customerInScope: true,
    })
    const ctx = makeMarketCtx({
      clientUserId: 'u-detail',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await detail(ctx)

    expect(ctx.result.id).toBe('cust-id-001')
    expect(ctx.result.clientUserId).toBe('u-detail')
    expect(ctx.result.name).toBe('回退姓名')
    expect(ctx.result.preferredStaffName).toBe('王美容师')
    expect(ctx.result.gender).toBe('女')
    expect(ctx.result.memberLevel).toBe('金钻')
    expect(ctx.result.skinType).toBe('混合性')
    expect(ctx.result.focusAreas).toBe('抗衰')
    expect(ctx.result.notes).toBe('老顾客')
    expect(ctx.result.storeName).toBe('A 店') // trim
    expect(ctx.result.lastServiceDate).toBe('2026-04-20')
    expect(ctx.result.visitFrequency).toBe('两周一次') // count90d=8 落在 [6, 12)
    expect(ctx.result.topProductName).toBe('深层补水')
    expect(ctx.result.totalConsumption).toBe(9999.5)
    expect(ctx.result.yearConsumption).toBe(3000)
    expect(ctx.result.birthday).toBe('1990-03-15')
    expect(ctx.result.source).toBe('both') // customer_id 非空
    expect(ctx.result.phone).toBe('13700137000') // market 不脱敏
  })

  test('detail 支持 phone 入参（id/clientUserId 都未找到时回退）', async () => {
    let queryCount = 0
    pg.query.mockReset().mockImplementation(async (sql) => {
      queryCount++
      // assertCustomerInScope: scope 不需要校验（headquarters）
      if (/SELECT\s+1\s+FROM\s+stores/.test(sql) || /FROM\s+stores\s+s\s+JOIN\s+org_nodes/.test(sql)) {
        return [{ '?column?': 1 }]
      }
      if (/c\.user_id,\s+c\.phone,\s+c\.name,\s+c\.customer_id/.test(sql) && /WHERE\s+c\.customer_id\s*=\s*\$1/.test(sql)) {
        return [] // id 没找到
      }
      if (/c\.user_id,\s+c\.phone/.test(sql) && /WHERE\s+c\.user_id\s*=\s*\$1/.test(sql)) {
        return [] // clientUserId 没找到
      }
      if (/c\.user_id,\s+c\.phone/.test(sql) && /WHERE\s+c\.phone\s*=\s*\$1/.test(sql)) {
        return [{
          user_id: 'u-by-phone',
          phone: '13600136000',
          name: '李四',
          customer_id: null,
          member_level: null,
          bound_employee_id: null,
          skin_type: null,
          improvement_focus: null,
          gender: null,
          notes: null,
          bound_store_id: 'store-001',
          store_name: 'B 店',
          birthday: null,
        }]
      }
      if (/MAX\(so\.service_date\)\s+AS\s+last_date/.test(sql)) {
        return [{ last_date: null, visit_count_90d: 0 }]
      }
      if (/COALESCE\(SUM\(si\.received::numeric\),\s*0\)\s+AS\s+total/.test(sql)) {
        return [{ total: 0, year_total: 0 }]
      }
      return []
    })

    const ctx = makeHqCtx({
      id: 'not-found-id',
      clientUserId: 'not-found-uid',
      phone: '13600136000',
      scopeType: 'all',
    })
    await detail(ctx)

    expect(ctx.result.clientUserId).toBe('u-by-phone')
    expect(ctx.result.name).toBe('李四')
    expect(ctx.result.preferredStaffName).toBeNull() // bound_employee_id 为 null
    expect(ctx.result.source).toBe('miniprogram') // customer_id null
    // 至少经过了 id / clientUserId / phone 三次档案查询
    expect(queryCount).toBeGreaterThanOrEqual(3)
  })

  test('paidOrders 出数：orders + items 完整 mapping', async () => {
    setupCommonMocks({
      paidOrderRows: [
        { sale_order_id: 'so-1', status: '已支付', paid_at: '2026-04-20T10:00:00Z', store_id: 'store-001', store_name: 'A 店' },
        { sale_order_id: 'so-2', status: '已支付', paid_at: '2026-04-21T11:00:00Z', store_id: 'store-001', store_name: 'A 店' },
      ],
      paidOrderItems: [
        { sale_order_id: 'so-1', sale_item_id: 'si-1', store_id: 'store-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', sku_spec_name: 'A 规', product_name: '深层补水' },
        { sale_order_id: 'so-1', sale_item_id: 'si-2', store_id: 'store-001', session_count: 5, remaining_sessions: 5, sku_id: 'sku-2', product_type: '次卡', sku_spec_name: 'B 规', product_name: '基础护理' },
        { sale_order_id: 'so-2', sale_item_id: 'si-3', store_id: 'store-001', session_count: 1, remaining_sessions: 1, sku_id: 'sku-3', product_type: '单次', sku_spec_name: 'C 规', product_name: '面部清洁' },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'all' })
    await paidOrders(ctx)

    expect(ctx.result.scope.type).toBe('all')
    expect(ctx.result.orders).toHaveLength(2)
    const so1 = ctx.result.orders.find((o) => o.saleOrderId === 'so-1')
    expect(so1.items).toHaveLength(2)
    expect(so1.items[0].itemName).toBe('深层补水')
    const so2 = ctx.result.orders.find((o) => o.saleOrderId === 'so-2')
    expect(so2.items).toHaveLength(1)
    expect(so2.items[0].itemName).toBe('面部清洁')
  })

  test('paidOrders 空结果分支：返回 orders=[] 并解析 scope 名称', async () => {
    setupCommonMocks({ paidOrderRows: [] })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await paidOrders(ctx)

    expect(ctx.result.scope.type).toBe('store')
    expect(ctx.result.scope.id).toBe('store-001')
    expect(ctx.result.scope.name).toBe('凤御A店')
    expect(ctx.result.orders).toEqual([])
  })

  test('calendar 出数：dailySummary + orders mapping', async () => {
    setupCommonMocks({
      calendarDailyRows: [
        { pay_date: '2026-04-20', order_count: '2', total_received: '300.50' },
        { pay_date: '2026-04-21', order_count: '1', total_received: '88.00' },
      ],
      calendarOrderRows: [
        { sale_order_id: 'so-1', sale_order_type: '销售单', store_id: 'store-001', payment_method: '微信', paid_at: '2026-04-20T10:00:00Z', client_phone: '13800001111', customer_name: '张三', pay_date: '2026-04-20', total_received: '200.00' },
        { sale_order_id: 'so-2', sale_order_type: '销售单', store_id: 'store-001', payment_method: '现金', paid_at: '2026-04-20T15:00:00Z', client_phone: '13800001111', customer_name: '张三', pay_date: '2026-04-20', total_received: '100.50' },
        { sale_order_id: 'so-3', sale_order_type: '销售单', store_id: 'store-001', payment_method: '微信', paid_at: '2026-04-21T09:00:00Z', client_phone: '13800001111', customer_name: '张三', pay_date: '2026-04-21', total_received: '88.00' },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', year: 2026, month: 4, scopeType: 'all' })
    await calendar(ctx)

    expect(ctx.result.year).toBe(2026)
    expect(ctx.result.month).toBe(4)
    expect(ctx.result.dailySummary).toHaveLength(2)
    expect(ctx.result.dailySummary[0]).toEqual({ date: '2026-04-20', orderCount: 2, totalReceived: 300.5 })
    expect(ctx.result.orders).toHaveLength(3)
    expect(ctx.result.orders[0].saleOrderId).toBe('so-1')
    expect(ctx.result.orders[0].paymentMethod).toBe('微信')
    expect(ctx.result.orders[0].totalReceived).toBe(200)
  })

  test('calendar 支持 clientPhone 入参（替代 clientUserId）', async () => {
    setupCommonMocks({
      calendarDailyRows: [],
      calendarOrderRows: [],
    })
    const ctx = makeHqCtx({ clientPhone: '13800001111', year: 2026, month: 4, scopeType: 'all' })
    await calendar(ctx)
    expect(ctx.result.dailySummary).toEqual([])
    expect(ctx.result.orders).toEqual([])
  })

  test('giftHistory 出数：promoOrders + giftItems + scope 名称', async () => {
    setupCommonMocks({
      giftPromoRows: [
        { sale_order_id: 'so-promo-1', status: '已支付', sale_order_type: '销售单', total_amount: '1200.00', created_at: '2026-04-15T10:00:00Z', paid_at: '2026-04-15T10:05:00Z' },
      ],
      giftItemsRows: [
        { sale_item_id: 'gi-1', sale_order_id: 'so-gift-1', product_name: '赠品面膜', sku_spec_name: '单片', quantity: 5, session_count: null, remaining_sessions: null, received: '0', created_at: '2026-04-16T10:00:00Z', paid_at: '2026-04-16T10:05:00Z' },
      ],
    })
    // 给 promoItems 查询补 mock（按 sale_order_id ANY $1）
    const baseImpl = pg.query.getMockImplementation()
    pg.query.mockImplementation(async (sql, params) => {
      if (
        /SELECT\s+si\.sale_order_id,\s+si\.sale_item_id,\s+si\.product_name/.test(sql) &&
        /WHERE\s+si\.sale_order_id\s*=\s*ANY\(\$1\)/.test(sql) &&
        Array.isArray(params?.[0]) && params[0].includes('so-promo-1')
      ) {
        return [
          { sale_order_id: 'so-promo-1', sale_item_id: 'pi-1', product_name: '套餐子项A', sku_spec_name: 'X', quantity: 1, session_count: 10, remaining_sessions: 9, received: '600.00' },
          { sale_order_id: 'so-promo-1', sale_item_id: 'pi-2', product_name: '套餐子项B', sku_spec_name: 'Y', quantity: 1, session_count: 5, remaining_sessions: 5, received: '600.00' },
        ]
      }
      return baseImpl(sql, params)
    })

    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await giftHistory(ctx)

    expect(ctx.result.scope.name).toBe('华东市场')
    expect(ctx.result.promoOrders).toHaveLength(1)
    expect(ctx.result.promoOrders[0].saleOrderId).toBe('so-promo-1')
    expect(ctx.result.promoOrders[0].totalAmount).toBe(1200)
    expect(ctx.result.promoOrders[0].items).toHaveLength(2)
    expect(ctx.result.giftItems).toHaveLength(1)
    expect(ctx.result.giftItems[0].productName).toBe('赠品面膜')
    expect(ctx.result.giftItems[0].quantity).toBe(5)
  })

  test('giftHistory 支持 clientPhone 入参', async () => {
    setupCommonMocks({ giftPromoRows: [], giftItemsRows: [] })
    const ctx = makeHqCtx({ clientPhone: '13800001111', scopeType: 'all' })
    await giftHistory(ctx)
    expect(ctx.result.promoOrders).toEqual([])
    expect(ctx.result.giftItems).toEqual([])
  })

  test('refundHistory 出数：orders + items 完整 mapping', async () => {
    setupCommonMocks({
      refundOrderRows: [
        { sale_order_id: 'so-r1', status: '已退款', sale_order_type: '退款单', total_amount: '500.00', refund_reason: '过敏', handling_fee: '50.00', ref_sale_order_id: 'so-orig-1', approved_by: 'mgr-1', approved_at: '2026-04-22T12:00:00Z', rejected_reason: null, created_at: '2026-04-22T10:00:00Z', paid_at: null },
        { sale_order_id: 'so-r2', status: '已转换', sale_order_type: '转换单', total_amount: '300.00', refund_reason: null, handling_fee: null, ref_sale_order_id: 'so-orig-2', approved_by: 'mgr-1', approved_at: '2026-04-23T12:00:00Z', rejected_reason: null, created_at: '2026-04-23T10:00:00Z', paid_at: null },
      ],
      refundItemsRows: [
        { sale_order_id: 'so-r1', sale_item_id: 'sri-1', item_direction: '退款', product_name: '深层补水', sku_spec_name: 'A 规', quantity: 1, received: '-500.00' },
        { sale_order_id: 'so-r2', sale_item_id: 'sri-2', item_direction: '转换', product_name: '换购套餐', sku_spec_name: 'C 规', quantity: 1, received: '300.00' },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await refundHistory(ctx)

    expect(ctx.result.scope.name).toBe('华东市场')
    expect(ctx.result.orders).toHaveLength(2)
    const r1 = ctx.result.orders.find((o) => o.saleOrderId === 'so-r1')
    expect(r1.type).toBe('退款单')
    expect(r1.totalAmount).toBe(500)
    expect(r1.handlingFee).toBe(50)
    expect(r1.refundReason).toBe('过敏')
    expect(r1.items).toHaveLength(1)
    expect(r1.items[0].direction).toBe('退款')
    expect(r1.items[0].received).toBe(-500)
    const r2 = ctx.result.orders.find((o) => o.saleOrderId === 'so-r2')
    expect(r2.handlingFee).toBeNull()
    expect(r2.items).toHaveLength(1)
  })

  test('refundHistory 空结果分支：返回 orders=[] 并解析 scope', async () => {
    setupCommonMocks({ refundOrderRows: [], refundItemsRows: [] })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await refundHistory(ctx)
    expect(ctx.result.orders).toEqual([])
    expect(ctx.result.scope.name).toBe('凤御A店')
  })

  test('refundHistory 支持 clientPhone 入参', async () => {
    setupCommonMocks({ refundOrderRows: [], refundItemsRows: [] })
    const ctx = makeHqCtx({ clientPhone: '13800001111', scopeType: 'all' })
    await refundHistory(ctx)
    expect(ctx.result.orders).toEqual([])
  })
})
