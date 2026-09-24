/**
 * mgmtCustomer 路由测试 — 6 actions（顾客档案管理层视图）
 *
 * 覆盖：
 *   - 入参/权限校验（INVALID_PARAMS / PERMISSION_DENIED）
 *   - search SQL 形态（scope 三档：all / market / store）+ 50/页分页
 *   - detail 越权防护（顾客 bound_store_id 不在 scope）
 *   - detail 出数（消费 / 频率 / 常购按 scope 过滤）
 *   - calendar / paidOrders / giftHistory / refundHistory 的 sale_orders.store_id IN scope 子查询
 *   - 手机号脱敏策略（headquarters / market 不脱敏）
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createManagerCtx } = require('../helpers')
const { assertPaymentAttributionReady, __resetAttributionGuardCache } = require('../../utils/attribution-guard')

/**
 * #141：年度消费直读款项归属日期，跑 SQL 前会过 attribution-guard 探针。
 * guard **只缓存「已就绪」**，所以这里预热一次，之后整个文件的测试都不再发探针查询，
 * 既有 mock 的调用序列/索引全部不受影响。
 * （预热本身会占一次 pg.query，但它在 beforeAll 里、早于任何用例的 mock 设置。）
 * guard 本身的行为（未就绪时拦截）另有专门用例覆盖。
 */
beforeAll(async () => {
  pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: true }])
  await assertPaymentAttributionReady(pg)
})

const {
  search,
  detail,
  calendar,
  paidOrders,
  giftHistory,
  refundHistory,
  homeProducts,
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
  expect(sql).toMatch(new RegExp(`SELECT \\$${rootParamIndex}::text, ARRAY\\[\\$${rootParamIndex}::text\\]`))
  expect(sql).toMatch(/JOIN descendants ON child\.parent_id = descendants\.id/)
  expect(sql).toMatch(/WHERE NOT child\.id = ANY\(descendants\.path\)/)
  expect(sql).toMatch(/JOIN descendants ON s\.org_node_id = descendants\.id/)
}

// ---- mock 工具 ----

/**
 * 通用 mock：按 SQL 关键字匹配返回 rows
 *   resolveScopeName → name 兜底
 */
function setupCommonMocks(opts = {}) {
  const {
    searchRows = [],
    detailRows = null,
    detailVisitRows = [{ last_date: null, visit_count_90d: 0 }],
    detailTopProductRows = [],
    detailConsumptionRows = [{ total: 0, year_total: 0 }],
    spendRows = [],
    svcDateRows = [],
    lastPurchaseRows = [],
    customerInScope = true,
    resolveCustomerRow = [{ user_id: 'u1', bound_store_id: 'store-001' }], // 子 Tab resolveCustomerInScope 解析
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
    refundPaymentRows = [],   // 2026-04-26 sale_order_payments[change_type='退款'] JOIN spd 行
    refundConvOrderRows = [], // 2026-04-26 sale_orders[type='转换单'] 行
    refundConvItemRows = [],  // 2026-04-26 转换单的 sale_items 明细
    homeProductRows = [],     // 2026-09-13 家居产品资产（mgmtCustomer.homeProducts）
    marketName = '华东市场',
    storeName = '凤御A店',
    attributionReady = true,   // #141 迁移就绪探针（attribution-guard）
  } = opts

  pg.query.mockReset().mockImplementation(async (sql, params) => {
    // #141 attribution-guard 探针：按 SQL 内容分发（仍会进 mock.calls，
    // 但 beforeAll 预热后正常用例根本不触发它）
    if (/has_gap/.test(sql)) {
      return [{ has_gap: !attributionReady, trigger_ready: attributionReady }]
    }
    // resolveScopeName: org_nodes
    if (/FROM\s+org_nodes\s+WHERE\s+id\s*=\s*\$1/.test(sql) && /SELECT\s+name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    // resolveScopeName: stores
    if (/SELECT\s+store_name\s+FROM\s+stores\s+WHERE\s+store_id/.test(sql)) {
      return [{ store_name: storeName }]
    }
    // assertCustomerInScope：递归组织树内的门店。
    if (
      /FROM\s+stores\s+s/.test(sql) &&
      /s\.store_id\s*=\s*\$1/.test(sql) &&
      /WITH RECURSIVE descendants\(id, path\) AS/.test(sql) &&
      /SELECT \$2::text, ARRAY\[\$2::text\]/.test(sql)
    ) {
      return customerInScope ? [{ '?column?': 1 }] : []
    }

    // resolveCustomerInScope（子 Tab）：SELECT user_id, bound_store_id FROM client_wechat_users WHERE user_id|phone = $1
    if (/SELECT\s+user_id,\s+bound_store_id\s+FROM\s+client_wechat_users/.test(sql)) {
      return resolveCustomerRow
    }

    // homeProducts：家居产品资产 CTE 链
    if (/FROM\s+home_product_balances/.test(sql)) {
      return homeProductRows
    }

    // search 最近购买（仅 search 在用）
    if (
      /DISTINCT ON\s*\(\s*o\.client_user_id\s*\)/.test(sql) &&
      /si\.product_name\s+AS\s+last_product_name/.test(sql) &&
      /JOIN\s+sale_items\s+si/.test(sql)
    ) {
      return lastPurchaseRows
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
      /WITH\s+order_stats\s+AS/.test(sql) &&
      /year_total/.test(sql) &&
      /total_actual_consumption/.test(sql)
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

    // refundHistory 订单（旧）— 兼容尚未迁移的 callers
    if (
      /sale_order_type\s+IN\s*\(\s*'退款单'\s*,\s*'转换单'\s*\)/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    ) {
      return refundOrderRows
    }

    // 2026-04-26 refundHistory Q1: 退款流水（sale_order_payments JOIN spd JOIN sale_orders）
    if (
      /FROM\s+sale_order_payments\s+sop/.test(sql) &&
      /sop\.change_type\s*=\s*'退款'/.test(sql)
    ) {
      return refundPaymentRows
    }

    // 2026-04-26 refundHistory Q2: 转换单（sale_orders[type='转换单']）
    if (
      /FROM\s+sale_orders\s+o/.test(sql) &&
      /o\.sale_order_type\s*=\s*'转换单'/.test(sql)
    ) {
      return refundConvOrderRows
    }

    // 2026-04-26 refundHistory Q3: 转换单明细
    if (
      /si\.item_direction/.test(sql) &&
      /FROM\s+sale_items\s+si\s+WHERE\s+si\.sale_order_id\s*=\s*ANY/.test(sql)
    ) {
      // 兼容旧 callers 仍传 refundItemsRows
      if (refundConvItemRows.length > 0) return refundConvItemRows
      return refundItemsRows
    }

    return []
  })
}

// ===================================================================
// 参数与权限校验
// ===================================================================

describe('mgmtCustomer 参数与权限校验', () => {
  /**
   * #141 fail-closed：未迁库时首次支付行 100% 为 NULL（dev 实测 1523/1523，¥4,872,147.25），
   * 三值逻辑把正数主体全部吞掉、只剩退款负数——年度消费会显示 −425801.66。
   * 宁可报错也不给运营看负数。
   *
   * ⚠ 别用 pg.query.mockReset()：那会清掉 setupCommonMocks 装的 mockImplementation、
   * 波及后续用例。mockResolvedValueOnce 本就优先于 mockImplementation，够用。
   */
  const withUnreadyGuard = async (opts, run) => {
    __resetAttributionGuardCache()
    setupCommonMocks({ ...opts, attributionReady: false })
    try {
      await run()
    } finally {
      // 复原就绪态，后续用例继续零探针。
      // 包 try/catch：这里再抛会**替换掉**原始断言失败信息，让排查指向错误方向。
      try {
        __resetAttributionGuardCache()
        pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: true }])
        await assertPaymentAttributionReady(pg)
      } catch {
        /* 复原失败不掩盖原始失败；下个用例的 setupCommonMocks 会重建 mock */
      }
    }
  }

  test('detail 年度消费在未迁移库上拒绝出数（不显示负数）', async () => {
    await withUnreadyGuard({ detailRows: [{ user_id: 'u1', bound_store_id: 'store-001' }] }, async () => {
      const ctx = makeHqCtx({ scopeType: 'all', clientUserId: 'u1', customerId: 'c1', clientPhone: '13800000000' })
      await expect(detail(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    })
  })

  test('search 年消费同样过迁移守卫', async () => {
    await withUnreadyGuard({ searchRows: [{ user_id: 'u1', name: '张三', bound_store_id: 'store-001' }] }, async () => {
      const ctx = makeHqCtx({ scopeType: 'all', keyword: '张' })
      await expect(search(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    })
  })

  test('search 年消费按订单级业绩归属日期落年，不得回退 paid_at', async () => {
    // 必须给 searchRows，否则 allClientUserIds 为空、search 会跳过年消费查询
    setupCommonMocks({
      searchRows: [{ user_id: 'u1', name: '张三', bound_store_id: 'store-001' }],
      spendRows: [{ client_user_id: 'u1', annual_spend: '100.00' }],
    })
    const ctx = makeHqCtx({ scopeType: 'all', keyword: '张' })
    await search(ctx)
    const spendSql = pg.query.mock.calls
      .map((c) => c[0])
      .find((sql) => /COALESCE\(SUM\(o\.total_amount::numeric\),\s*0\)\s+AS\s+annual_spend/.test(sql))
    expect(spendSql, '未找到年消费 SQL').toBeTruthy()
    expect(spendSql, '年消费落年口径漂移').toContain('o.performance_attribution_date >= $2::date')
    expect(spendSql, '年消费不得回退到 paid_at').not.toContain('o.paid_at')
    // ⚠ 必须是半开区间：归属日期可被人工调到订单日 ±7 天，跨年那 7 天的订单
    // 没有上界就会被计进今年，而详情用半开区间会排除它 —— 两处落年再次分叉。
    // （改前按 paid_at 时无上界是无害的，实付日不可能落到未来。）
    expect(spendSql, '年消费缺上界，跨年改期的订单会多算')
      .toContain("o.performance_attribution_date < ($2::date + INTERVAL '1 year')")
  })

  /**
   * 列表与详情必须用**同一个**年份算法。`new Date().getFullYear()` 依赖进程时区，
   * 容器 TZ 丢失时上海 1/1 08:00 前会取到上一年，与详情的 shanghaiDateStr() 分叉；
   * 叠加上一条的上界问题，列表会把两年消费累加、徽章分档全错。
   */
  test('列表与详情的年份算法一致（都走 shanghaiDateStr，不依赖进程时区）', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../routes/mgmt-customer.js'),
      'utf8',
    )
    const yearStarts = src.match(/const yearStart = `\$\{[^}]+\}-01-01`/g) ?? []
    expect(yearStarts.length, '年份计算点数量变了，请同步本断言').toBe(2)
    for (const expr of yearStarts) {
      expect(expr, '年份计算不得依赖进程时区（用 shanghaiDateStr）')
        .toContain('shanghaiDateStr().slice(0, 4)')
    }
  })

  test('search 缺 scopeType 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({})
    await expect(search(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('search 未知 scopeType 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'foo' })
    await expect(search(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('search scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'market' })
    await expect(search(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围 ID/)
  })

  test('detail 缺三个 ID 抛 INVALID_PARAMS', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('没有 data_center:dashboard 的店长不能伪造管理层登录（search）', async () => {
    setupCommonMocks()
    const ctx = createManagerCtx(
      { scopeType: 'store', scopeId: 'store-001' },
      { loginLevel: 'management', hasDataCenterDashboard: false },
    )
    await expect(search(ctx)).rejects.toThrow(/PERMISSION_DENIED.*数据中心权限/)
  })

  test('门店级 finance 获得 data_center:dashboard 后可查看自己 scope 内的完整手机号', async () => {
    setupCommonMocks({
      searchRows: [{
        user_id: 'u-finance-scope',
        phone: '13800138000',
        name: '顾客甲',
        customer_id: 'C-finance-scope',
        member_level: '普通会员',
        bound_store_id: 'store-001',
        store_name: '凤御A店',
        birthday: null,
      }],
    })
    const ctx = createCtx({
      payload: { scopeType: 'store', scopeId: 'store-001' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'org-node-store-001', scopeType: '门店' }],
        staffLevel: 'store_staff',
        loginLevel: 'management',
        effectiveStoreId: null,
        currentStoreId: null,
        scopeStoreIds: ['store-001'],
        scopeOrgNodeIds: ['org-node-store-001'],
        hasDataCenterDashboard: true,
      },
    })

    await search(ctx)

    expect(ctx.result.customers).toHaveLength(1)
    expect(ctx.result.customers[0].phone).toBe('13800138000')
    const mainQuery = pg.query.mock.calls.find((call) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(call[0]) && /LIMIT/.test(call[0]),
    )
    expect(mainQuery[0]).toMatch(/c\.bound_store_id\s*=\s*\$1/)
    expect(mainQuery[1]).toEqual(['store-001', 50, 0])
  })

  test('market 账号选 all → PERMISSION_DENIED（search）', async () => {
    setupCommonMocks()
    const ctx = makeMarketCtx({ scopeType: 'all' })
    await expect(search(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号选其他 market → PERMISSION_DENIED（search）', async () => {
    setupCommonMocks()
    const ctx = makeMarketCtx({ scopeType: 'market', scopeId: 'mkt-B' })
    await expect(search(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
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
// search SQL 形态
// ===================================================================

describe('mgmtCustomer.search SQL 形态', () => {
  test('默认（无 keyword/phone）scope=all：WHERE TRUE + ORDER BY c.user_id ASC + LIMIT $1 OFFSET $2', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all' })
    await search(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const mainSql = sqls.find((s) => /SELECT\s+c\.user_id,\s+c\.phone/.test(s))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toMatch(/WHERE\s+TRUE/)
    expect(mainSql).toMatch(/ORDER BY\s+c\.user_id\s+ASC/)
    expect(mainSql).toMatch(/LIMIT\s+\$1\s+OFFSET\s+\$2/)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]),
    )
    expect(call[1]).toEqual([50, 0])
  })

  test('默认 scope=market：c.bound_store_id 通过递归后代组织树过滤，参数 [scopeId, 50, 0]', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'market', scopeId: 'mkt-A' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIMIT/.test(c[0]),
    )
    expect(call[0]).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(call[0], 1)
    expect(call[0]).toMatch(/ORDER BY\s+c\.user_id\s+ASC/)
    expect(call[0]).toMatch(/LIMIT\s+\$2\s+OFFSET\s+\$3/)
    expect(call[1]).toEqual(['mkt-A', 50, 0])
  })

  test('默认 scope=store：c.bound_store_id = $1，参数 [scopeId, 50, 0]', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'store', scopeId: 'store-001' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIMIT/.test(c[0]),
    )
    expect(call[0]).toMatch(/c\.bound_store_id\s*=\s*\$1/)
    expect(call[0]).toMatch(/ORDER BY\s+c\.user_id\s+ASC/)
    expect(call[0]).toMatch(/LIMIT\s+\$2\s+OFFSET\s+\$3/)
    expect(call[1]).toEqual(['store-001', 50, 0])
  })

  test('keyword=张 scope=market：LIKE $1 + 递归 c.bound_store_id 过滤 $2 + LIMIT $3 OFFSET $4', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ keyword: '张', scopeType: 'market', scopeId: 'mkt-A' })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /LIKE\s+\$1/.test(c[0]),
    )
    expect(call).toBeTruthy()
    expect(call[0]).toMatch(/\(c\.phone\s+LIKE\s+\$1\s+OR\s+c\.name\s+LIKE\s+\$1\)/)
    expect(call[0]).toMatch(/c\.bound_store_id\s+IN\s*\(/)
    expectRecursiveDescendantScope(call[0], 2)
    expect(call[0]).toMatch(/ORDER BY\s+c\.user_id\s+ASC/)
    expect(call[0]).toMatch(/LIMIT\s+\$3\s+OFFSET\s+\$4/)
    expect(call[1]).toEqual(['%张%', 'mkt-A', 50, 0])
  })

  test('phone=13800001111 scope=store：c.phone = $1 AND c.bound_store_id = $2（不分页）', async () => {
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
    expect(call[0]).not.toMatch(/LIMIT/)
    expect(call[0]).not.toMatch(/OFFSET/)
    expect(call[1]).toEqual(['13800001111', 'store-001'])
  })

  test('page=2 scope=all：OFFSET=50（pageSize 默认 50）', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all', page: 2 })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    expect(call[1]).toEqual([50, 50])
  })

  test('pageSize=999 → 截断为 100', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all', pageSize: 999 })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    expect(call[1]).toEqual([100, 0])
  })

  test('page=0 / 负数 → 兜底为 page=1', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all', page: -3 })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    expect(call[1]).toEqual([50, 0])
    expect(ctx.result.page).toBe(1)
  })

  // ---------- #240 分页取整（invariant D-search-pagination） ----------
  // 改前写法 `Math.min(100, Math.max(1, Number(pageSize) || 50))` 不取整：
  // 2.5 既 >1 又 <100，两个夹子双双失效 → 2.5 原样进 LIMIT，
  // PG 按 int8 解析抛 `invalid input syntax for type bigint: "2.5"`（500 级，非降级）。
  test('#240 小数 pageSize 被取整：LIMIT/OFFSET 参数必须是整数', async () => {
    setupCommonMocks({ searchRows: [] })
    const ctx = makeHqCtx({ scopeType: 'all', page: 2.7, pageSize: 2.5 })
    await search(ctx)

    const call = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    // page=2.7→2，pageSize=2.5→2，offset=(2-1)*2=2
    expect(call[1]).toEqual([2, 2])
    expect(Number.isInteger(call[1][0])).toBe(true)
    expect(Number.isInteger(call[1][1])).toBe(true)
    expect(ctx.result.page).toBe(2)
    expect(ctx.result.pageSize).toBe(2)
  })

  test("#240 非安全整数回落默认：'Infinity' / 1e21 不得进 LIMIT/OFFSET", async () => {
    // 'Infinity' 经 Math.trunc 仍是 Infinity，旧写法的 Math.max(1, Infinity) 也还是 Infinity。
    setupCommonMocks({ searchRows: [] })
    const ctxInf = makeHqCtx({ scopeType: 'all', page: 'Infinity', pageSize: 'Infinity' })
    await search(ctxInf)
    const infCall = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    expect(infCall[1]).toEqual([50, 0])
    expect(Number.isInteger(infCall[1][0])).toBe(true)
    expect(Number.isInteger(infCall[1][1])).toBe(true)

    // 1e21 超出安全整数范围（pg 会把它序列化成 "1e+21" 文本）→ 回落默认
    setupCommonMocks({ searchRows: [] })
    const ctxHuge = makeHqCtx({ scopeType: 'all', page: 1e21, pageSize: 1e21 })
    await search(ctxHuge)
    const hugeCall = pg.query.mock.calls.find((c) =>
      /SELECT\s+c\.user_id,\s+c\.phone/.test(c[0]) && /OFFSET/.test(c[0]),
    )
    expect(hugeCall[1]).toEqual([50, 0])
    expect(Number.isInteger(hugeCall[1][1])).toBe(true)
    expect(ctxHuge.result.page).toBe(1)
  })

  test('返回结构：customers + page + pageSize + hasMore', async () => {
    setupCommonMocks({
      searchRows: Array.from({ length: 50 }, (_, i) => ({
        user_id: `u${i}`,
        phone: '13800000000',
        name: `n${i}`,
        customer_id: null,
        member_level: null,
        bound_store_id: null,
        store_name: null,
        birthday: null,
      })),
    })
    const ctx = makeHqCtx({ scopeType: 'all', page: 1 })
    await search(ctx)

    expect(ctx.result.page).toBe(1)
    expect(ctx.result.pageSize).toBe(50)
    expect(ctx.result.hasMore).toBe(true)
    expect(ctx.result.customers.length).toBe(50)
  })

  test('返回行数 < pageSize → hasMore=false', async () => {
    setupCommonMocks({
      searchRows: [
        {
          user_id: 'u1',
          phone: '13800000000',
          name: 'n1',
          customer_id: null,
          member_level: null,
          bound_store_id: null,
          store_name: null,
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({ scopeType: 'all', page: 1 })
    await search(ctx)

    expect(ctx.result.hasMore).toBe(false)
    expect(ctx.result.customers.length).toBe(1)
  })

  test('phone 命中分支 → hasMore 恒为 false', async () => {
    setupCommonMocks({
      searchRows: [
        {
          user_id: 'u1',
          phone: '13800001111',
          name: 'n1',
          customer_id: null,
          member_level: null,
          bound_store_id: 'store-001',
          store_name: 'A 店',
          birthday: null,
        },
      ],
    })
    const ctx = makeHqCtx({
      phone: '13800001111',
      scopeType: 'store',
      scopeId: 'store-001',
    })
    await search(ctx)

    expect(ctx.result.hasMore).toBe(false)
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

  test('scope=all：headquarters 直接放行（不查递归组织树）', async () => {
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
    // 不应执行递归组织树校验
    const sqls = pg.query.mock.calls.map((c) => c[0])
    const scopeCheckSql = sqls.find(
      (s) =>
        /FROM\s+stores\s+s/.test(s) &&
        /s\.store_id\s*=\s*\$1/.test(s) &&
        /WITH RECURSIVE descendants\(id, path\) AS/.test(s),
    )
    expect(scopeCheckSql).toBeUndefined()
  })
})

// ===================================================================
// detail 出数（消费 / 频率 / 常购按 scope 过滤）
// ===================================================================

describe('mgmtCustomer.detail 出数', () => {
  test('累计/年消费和实耗按顾客聚合，不追加门店过滤', async () => {
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
      detailConsumptionRows: [{
        total: 12345.67,
        year_total: 5000,
        total_actual_consumption: 6789.12,
        year_actual_consumption: 2345.67,
      }],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await detail(ctx)

    expect(ctx.result.totalConsumption).toBe(12345.67)
    expect(ctx.result.yearConsumption).toBe(5000)
    expect(ctx.result.totalActualConsumption).toBe(6789.12)
    expect(ctx.result.yearActualConsumption).toBe(2345.67)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const consumptionSql = sqls.find(
      (s) =>
        /WITH\s+order_stats\s+AS/.test(s) &&
        /year_total/.test(s),
    )
    // 交易数据跟顾客走：详情统计不按门店过滤，顾客可见性由 assertCustomerInScope 守护。
    expect(consumptionSql).not.toMatch(/(?:o|so)\.store_id/)
    expect(consumptionSql).toContain('EXISTS (SELECT 1 FROM sale_items')
    expect(consumptionSql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(consumptionSql).toContain("o.sale_order_type IN ('销售单', '转换单')")
    expect(consumptionSql).toContain('FROM sale_order_payments sop')
    expect(consumptionSql).toContain("sop.status = '已支付'")
    expect(consumptionSql).toContain('SUM(\n         sop.amount::numeric')
    expect(consumptionSql).toContain("o.legacy_source IS DISTINCT FROM 'workfine'")
    expect(consumptionSql).toContain("o.legacy_source = 'workfine'")
    // #141 年度消费落年改按业绩归属日期：款项级走 sop、legacy(workfine) 走订单级 o。
    // 归属日期是 date，年区间用半开 [start, start+1year)，不再套北京时区半开区间。
    expect(consumptionSql).toContain('sop.performance_attribution_date >= $2::date')
    expect(consumptionSql).toContain("sop.performance_attribution_date < ($2::date + INTERVAL '1 year')")
    expect(consumptionSql).toContain('o.performance_attribution_date >= $2::date')
    expect(consumptionSql).toContain("o.performance_attribution_date < ($2::date + INTERVAL '1 year')")
    // 旧口径必须消失（含时区半开区间形态）
    expect(consumptionSql).not.toContain('sop.paid_at >=')
    expect(consumptionSql).not.toContain("AT TIME ZONE 'Asia/Shanghai')")
    expect(consumptionSql).not.toContain('WHEN o.paid_at >= $2')
    expect(consumptionSql).toContain('FROM service_orders so')
    expect(consumptionSql).toContain('JOIN service_items sit ON sit.service_order_id = so.service_order_id')
    expect(consumptionSql).toContain("so.status = '已完成'")
    expect(consumptionSql).toContain('so.service_date >= $2::date')
    expect(consumptionSql).toContain('so.remark IS DISTINCT FROM')
    const consumptionCall = pg.query.mock.calls.find((c) => c[0] === consumptionSql)
    expect(consumptionCall[1][1]).toMatch(/^\d{4}-01-01$/)
  })

  test('visitFrequency 与 topProductName 透传（消费统计不再按 scope 过滤，跟顾客走）', async () => {
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
    // 跟顾客走：到店统计不再按门店过滤
    expect(visitSql).not.toMatch(/so\.store_id/)

    const topSql = sqls.find(
      (s) =>
        /si\.product_name,\s+COUNT\(\*\)\s+AS\s+cnt/.test(s) &&
        /LIMIT\s+1/.test(s),
    )
    expect(topSql).not.toMatch(/o\.store_id/)
  })

  test('scope=all：消费 / 频率 / 常购 SQL 均不含门店过滤（跟顾客走）', async () => {
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
        /WITH\s+order_stats\s+AS/.test(s) &&
        /year_total/.test(s),
    )

    // 跟顾客走：3 条统计 SQL 均不含门店过滤（不再拼 buildSaleScope 的 AND TRUE / store_id）
    expect(visitSql).not.toMatch(/store_id/)
    expect(topSql).not.toMatch(/store_id/)
    expect(consumptionSql).not.toMatch(/store_id/)
  })
})

// ===================================================================
// calendar / paidOrders / giftHistory / refundHistory SQL 形态
// ===================================================================

describe('mgmtCustomer 细节 SQL：交易数据跟顾客走（不再按门店过滤）', () => {
  test('calendar scope=market：dailySummary / orders SQL 均不含 o.store_id 过滤、按 client_user_id 查', async () => {
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
    expect(dailySql).not.toMatch(/o\.store_id\s+IN/)
    expect(dailySql).toMatch(/o\.client_user_id\s*=\s*\$3/)
    expect(ordersSql).not.toMatch(/o\.store_id\s+IN/)
  })

  test('paidOrders scope=store：订单 SQL 不含 o.store_id 过滤、按 client_user_id 查', async () => {
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
          product_name: '深层补水',
          unit_real_price: '100.00',
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
    expect(ordersSql).not.toMatch(/o\.store_id\s*=\s*\$/)
    expect(ordersSql).toMatch(/o\.client_user_id\s*=\s*\$1/)
    expect(ctx.result.orders[0].items[0].itemName).toBe('深层补水')
  })

  test('paidOrders：部分支付订单的疗程卡也返回（按 paid_sessions 限额核销）', async () => {
    setupCommonMocks({
      paidOrderRows: [
        { sale_order_id: 'so-partial', status: '部分支付', paid_at: '2026-06-29', store_id: 'store-001', store_name: 'A 店' },
      ],
      paidOrderItems: [
        {
          sale_order_id: 'so-partial',
          sale_item_id: 'si-partial',
          store_id: 'store-001',
          session_count: 15,
          remaining_sessions: 15,
          paid_sessions: 10,
          sku_id: 'sku-1',
          product_type: '疗程卡',
          product_name: '温暖SPA·腰腹',
          unit_real_price: '80.00',
        },
      ],
    })
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'store',
      scopeId: 'store-001',
    })
    await paidOrders(ctx)
    const orderSql = pg.query.mock.calls.map((c) => c[0]).find((sql) =>
      /SELECT\s+o\.sale_order_id,\s+o\.status,\s+o\.paid_at,\s+o\.store_id/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    )
    expect(orderSql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].status).toBe('部分支付')
    expect(ctx.result.orders[0].items[0].totalSessions).toBe(15)
    expect(ctx.result.orders[0].items[0].paidSessions).toBe(10)
  })

  test('paidOrders：已完成销售单仍作为有效订单返回', async () => {
    setupCommonMocks({
      paidOrderRows: [
        { sale_order_id: 'so-completed', status: '已完成', paid_at: '2026-07-01', store_id: 'store-001', store_name: 'A 店' },
      ],
      paidOrderItems: [
        {
          sale_order_id: 'so-completed', sale_item_id: 'si-completed', store_id: 'store-001',
          session_count: 10, remaining_sessions: 6, paid_sessions: 10,
          product_type: '疗程卡', product_name: '历史疗程卡', unit_real_price: '100.00',
        },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })

    await paidOrders(ctx)

    const orderSql = pg.query.mock.calls.map((c) => c[0]).find((sql) =>
      /SELECT\s+o\.sale_order_id,\s+o\.status,\s+o\.paid_at,\s+o\.store_id/.test(sql) &&
      /FROM\s+sale_orders\s+o/.test(sql)
    )
    expect(orderSql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(ctx.result.orders).toMatchObject([{ saleOrderId: 'so-completed', status: '已完成' }])
  })

  test('paidOrders SQL 守卫：权益明细包含购买行和转换单转入行，排除转出行', async () => {
    setupCommonMocks({
      paidOrderRows: [
        { sale_order_id: 'so-conv', status: '已支付', paid_at: '2026-07-25', store_id: 'store-001', store_name: 'A 店' },
      ],
      paidOrderItems: [],
    })
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'store',
      scopeId: 'store-001',
    })

    await paidOrders(ctx)

    const itemSql = pg.query.mock.calls.map((c) => c[0]).find((sql) =>
      /FROM\s+sale_items\s+si/.test(sql) && /JOIN\s+sale_orders\s+o/.test(sql)
    )
    expect(itemSql).toContain("si.product_type = '疗程卡'")
    expect(itemSql).toContain("si.item_direction = '购买'")
    expect(itemSql).toContain("o.sale_order_type = '转换单'")
    expect(itemSql).toContain("si.item_direction = '转入'")
    expect(itemSql).not.toContain("si.item_direction = '转出'")
    expect(itemSql).toContain('si.paid_sessions IS NULL')
    // issue #122：改按物理剩余次数下发，可用次数 0 的卡不再整行隐藏。
    // 核销限额仍走 paid_sessions，但由 service.create/start/finalize 独立校验，不在此查询。
    expect(itemSql).toContain('si.remaining_sessions > 0')
    // ⚠ 退款不减 remaining_sessions：paid_sessions 是「已退卡从卡包消失」的唯一机制，
    // 放宽展示后这条守卫必须保留（已审批退款时回退到已付未用口径）。
    expect(itemSql).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    expect(itemSql).toContain('OR si.paid_sessions > (si.session_count - si.remaining_sessions)')
  })

  test('giftHistory scope=market：赠品 SQL 不含 o.store_id 过滤', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await giftHistory(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    const giftSql = sqls.find((s) => /si\.received::numeric\s*=\s*0/.test(s))
    expect(giftSql).not.toMatch(/o\.store_id\s+IN/)
  })

  // 2026-04-26 sale-order-domain-refactor: refundHistory 拆分为
  //   Q1: sale_order_payments[change_type='退款'] JOIN spd JOIN sale_orders（按 store_id ∈ scope 过滤）
  //   Q2: sale_orders[type='转换单']（同样 scope 过滤）
  test('refundHistory scope=market：退款流水 SQL 与转换单 SQL 均不含 o.store_id 过滤', async () => {
    setupCommonMocks({
      refundPaymentRows: [
        {
          payment_id: 101,
          sale_order_id: 'so-1',
          amount: '-100',
          status: '已支付',
          created_at: '2026-04-22T10:00:00Z',
          paid_at: '2026-04-22T11:00:00Z',
          payment_method: '线下',
          refund_reason: '不适合',
          audit_at: '2026-04-22T11:00:00Z',
          audit_remark: null,
          detail_note: null,
        },
      ],
      refundConvOrderRows: [],
    })
    const ctx = makeHqCtx({
      clientUserId: 'u1',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await refundHistory(ctx)

    const sqls = pg.query.mock.calls.map((c) => c[0])
    // Q1: 退款流水 SQL — 应含 store_id IN (...) 子查询（market scope）
    const refundSql = sqls.find((s) =>
      /FROM\s+sale_order_payments\s+sop/.test(s) &&
      /sop\.change_type\s*=\s*'退款'/.test(s),
    )
    expect(refundSql).toBeDefined()
    expect(refundSql).not.toMatch(/o\.store_id\s+IN/)
    expect(refundSql).toMatch(/o\.client_user_id\s*=\s*\$1/)

    // Q2: 转换单 SQL — 同样不含 store_id 过滤
    const convSql = sqls.find((s) =>
      /o\.sale_order_type\s*=\s*'转换单'/.test(s),
    )
    expect(convSql).toBeDefined()
    expect(convSql).not.toMatch(/o\.store_id\s+IN/)

    // 出数：退款流水正常映射
    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].type).toBe('退款')
    expect(ctx.result.orders[0].paymentId).toBe(101)
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
    const pgBirthday = '1990-03-15'
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
          birthday: pgBirthday,
          customer_source: '老带新',
          promoter_employee_name: '员工甲',
          inviter_name: '顾客乙',
          inviter_phone: '13600006666',
          invited_at: '2026-01-02T03:04:05Z',
          customer_type: '会员客',
          spending_tier: '5000-9999',
          monthly_activity: '活跃',
          customer_status: '正常到店',
          occupation: '教师',
          is_married: true,
          wechat_name: '小李',
          skin_issue: '干纹',
          wellness_preference: '经络',
          points_balance: '66',
        },
      ],
      nameRows: [{ customer_name: '回退姓名' }],
      staffRows: [{ name: '王美容师' }],
      detailVisitRows: [{ last_date: '2026-04-20', visit_count_90d: 8 }],
      detailTopProductRows: [{ product_name: '深层补水' }],
      detailConsumptionRows: [{
        total: 9999.5,
        year_total: 3000,
        total_actual_consumption: 5200,
        year_actual_consumption: 1800,
      }],
      customerInScope: true,
    })
    const ctx = makeMarketCtx({
      clientUserId: 'u-detail',
      scopeType: 'market',
      scopeId: 'mkt-A',
    })
    await detail(ctx)

    const detailSql = pg.query.mock.calls.find(([sql]) =>
      sql.includes('COALESCE(promoter.name, c.promoter_employee_name)'),
    )?.[0]
    expect(detailSql).toContain('promoter.employee_id = c.promoter_employee_id')

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
    expect(ctx.result.totalActualConsumption).toBe(5200)
    expect(ctx.result.yearActualConsumption).toBe(1800)
    expect(ctx.result.birthday).toBe('1990-03-15')
    expect(ctx.result).toMatchObject({
      customerSource: '老带新', promoterEmployeeName: '员工甲', inviterName: '顾客乙',
      inviterPhone: '13600006666', customerType: '会员客', occupation: '教师',
      isMarried: true, wechatName: '小李', skinIssue: '干纹', wellnessPreference: '经络',
      pointsBalance: 66,
    })
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
        { sale_order_id: 'so-1', sale_item_id: 'si-1', store_id: 'store-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', product_name: '深层补水', unit_real_price: '100.00', unit: '次', category_id: 'face-care', category_name: '面部护理', product_kind: '护理项目' },
        { sale_order_id: 'so-1', sale_item_id: 'si-2', store_id: 'store-001', session_count: 5, remaining_sessions: 5, sku_id: 'sku-2', product_type: '次卡', product_name: '基础护理', unit_real_price: '60.00' },
        { sale_order_id: 'so-2', sale_item_id: 'si-3', store_id: 'store-001', session_count: 1, remaining_sessions: 1, sku_id: 'sku-3', product_type: '单次', product_name: '面部清洁', unit_real_price: '30.00' },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'all' })
    await paidOrders(ctx)

    expect(ctx.result.scope.type).toBe('all')
    expect(ctx.result.orders).toHaveLength(2)
    const so1 = ctx.result.orders.find((o) => o.saleOrderId === 'so-1')
    expect(so1.items).toHaveLength(2)
    expect(so1.items[0].itemName).toBe('深层补水')
    expect(so1.items[0].unitRealPrice).toBe('100.00')
    expect(so1.items[0]).toMatchObject({
      unit: '次',
      productKind: '护理项目',
      categoryId: 'face-care',
      categoryName: '面部护理',
    })
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
        { sale_item_id: 'gi-1', sale_order_id: 'so-gift-1', product_name: '赠品面膜', quantity: 5, session_count: null, remaining_sessions: null, received: '0', created_at: '2026-04-16T10:00:00Z', paid_at: '2026-04-16T10:05:00Z' },
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
          { sale_order_id: 'so-promo-1', sale_item_id: 'pi-1', product_name: '套餐子项A', quantity: 1, session_count: 10, remaining_sessions: 9, received: '600.00' },
          { sale_order_id: 'so-promo-1', sale_item_id: 'pi-2', product_name: '套餐子项B', quantity: 1, session_count: 5, remaining_sessions: 5, received: '600.00' },
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

  // 2026-04-26 sale-order-domain-refactor: refundHistory 退款源已迁移至
  // sale_order_payments[change_type='退款']；转换单仍走 sale_orders[type='转换单']。
  test('refundHistory 出数：refunds (sale_order_payments) + conversions (sale_orders[转换单]) 完整 mapping', async () => {
    setupCommonMocks({
      refundPaymentRows: [
        {
          payment_id: 201,
          sale_order_id: 'so-orig-1',
          amount: '-500.00',
          status: '已支付',
          created_at: '2026-04-22T10:00:00Z',
          paid_at: '2026-04-22T12:00:00Z',
          payment_method: '线下',
          refund_reason: '过敏',
          audit_at: '2026-04-22T12:00:00Z',
          audit_remark: null,
          detail_note: JSON.stringify({
            _v: 1,
            handlingFee: 50,
            refundByCard: 0,
            refundByOrigin: 500,
            items: [{ refSaleItemId: 'sri-1', quantity: 1, refundAmount: 500, productType: '疗程卡' }],
          }),
        },
      ],
      refundConvOrderRows: [
        { sale_order_id: 'so-r2', status: '已转换', sale_order_type: '转换单', total_amount: '300.00', created_at: '2026-04-23T10:00:00Z', paid_at: '2026-04-23T12:00:00Z' },
      ],
      refundConvItemRows: [
        { sale_order_id: 'so-r2', sale_item_id: 'sri-2', item_direction: '转换', product_name: '换购套餐', quantity: 1, received: '300.00' },
      ],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await refundHistory(ctx)

    expect(ctx.result.scope.name).toBe('华东市场')
    expect(ctx.result.orders).toHaveLength(2)
    // 退款流水
    const r1 = ctx.result.orders.find((o) => o.paymentId === 201)
    expect(r1).toBeDefined()
    expect(r1.type).toBe('退款')
    expect(r1.saleOrderId).toBe('so-orig-1')
    expect(r1.totalAmount).toBe(-500)
    expect(r1.handlingFee).toBe(50)
    expect(r1.refundReason).toBe('过敏')
    expect(r1.items).toHaveLength(1)
    expect(r1.items[0].refSaleItemId).toBe('sri-1')
    expect(r1.approvedAt).toBe('2026-04-22T12:00:00Z')
    // 转换单
    const r2 = ctx.result.orders.find((o) => o.saleOrderId === 'so-r2')
    expect(r2).toBeDefined()
    expect(r2.type).toBe('转换单')
    expect(r2.totalAmount).toBe(300)
    expect(r2.items).toHaveLength(1)
    expect(r2.items[0].direction).toBe('转换')
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

// issue #121：管理层视图此前没有 homeProducts action，管理层模式下永远看不到家居产品。
// 口径必须与门店视图 customer.homeProducts 一致（含 #120 的未付清放行）。
describe('mgmtCustomer.homeProducts', () => {
  const unpaidRow = {
    sale_item_id: 'SI-UNPAID', sale_order_id: 'SO-UNPAID', product_name: '舒缓精华液',
    unit: '盒', purchased_quantity: 1, paid_quantity: 0, picked_quantity: 0,
    refunded_quantity: 0, remaining_quantity: 1, pending_pickup_quantity: 0,
    unpaid_amount: '380.00', store_id: 'store-002', store_name: '外店',
    purchased_at: '2026-09-13T10:00:00Z', refund_pending: false,
  }

  test('返回 {scope, homeProducts}，未付清行带待付清状态与欠款', async () => {
    setupCommonMocks({ homeProductRows: [unpaidRow] })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await homeProducts(ctx)

    expect(ctx.result.scope.name).toBe('凤御A店')
    expect(ctx.result.homeProducts).toEqual([
      expect.objectContaining({
        saleItemId: 'SI-UNPAID',
        purchasedQuantity: 1,
        paidQuantity: 0,
        pendingPickupQuantity: 0,
        unpaidAmount: 380,
        status: '待付清',
      }),
    ])
  })

  test('寄存单行不报欠款，状态为待提货', async () => {
    setupCommonMocks({
      homeProductRows: [{
        ...unpaidRow,
        sale_item_id: 'SI-DEPOSIT', purchased_quantity: 27, remaining_quantity: 27,
        unpaid_amount: null,
      }],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'all' })
    await homeProducts(ctx)

    expect(ctx.result.homeProducts[0]).toEqual(
      expect.objectContaining({ unpaidAmount: null, status: '待提货' }),
    )
  })

  test('交易数据跟顾客走：SQL 不按订单门店过滤，按 client_user_id 查', async () => {
    setupCommonMocks({ homeProductRows: [] })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await homeProducts(ctx)

    const sql = pg.query.mock.calls.map((c) => c[0]).find((s) => /FROM\s+home_product_balances/.test(s))
    expect(sql).toMatch(/o\.client_user_id\s*=\s*\$1/)
    expect(sql).not.toMatch(/o\.store_id\s+IN/)
    expect(sql).toContain("si.product_type = '家居产品'")
    expect(sql).toContain('WHERE picked_quantity > 0 OR remaining_quantity > 0')
    expect(sql).toContain("(o.sale_order_type = '寄存单') AS is_deposit")
    expect(ctx.result.homeProducts).toEqual([])
  })

  test('顾客 bound_store_id 不在 store scope 内时拒绝', async () => {
    setupCommonMocks({
      resolveCustomerRow: [{ user_id: 'u1', bound_store_id: 'store-999' }],
      homeProductRows: [unpaidRow],
    })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'store', scopeId: 'store-001' })
    await expect(homeProducts(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('顾客不在 market 组织树内时拒绝', async () => {
    setupCommonMocks({ customerInScope: false, homeProductRows: [unpaidRow] })
    const ctx = makeHqCtx({ clientUserId: 'u1', scopeType: 'market', scopeId: 'mkt-A' })
    await expect(homeProducts(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少顾客标识时拒绝', async () => {
    setupCommonMocks()
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(homeProducts(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('支持 clientPhone 入参', async () => {
    setupCommonMocks({ homeProductRows: [] })
    const ctx = makeHqCtx({ clientPhone: '13800001111', scopeType: 'all' })
    await homeProducts(ctx)
    expect(ctx.result.homeProducts).toEqual([])
  })
})
