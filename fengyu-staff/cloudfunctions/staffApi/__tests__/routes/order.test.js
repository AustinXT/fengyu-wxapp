/**
 * 订单路由测试
 * 覆盖：create / confirmOffline / close / resetFailed / list / detail
 * 核心约束：
 *   - 开单仅店长
 *   - 待支付订单唯一性
 *   - 订单状态单向推进
 *   - 美容师行级过滤
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const orderRoutes = require('../../routes/order')

/**
 * 共享 helper：assertOrderInScope 在路由内会先 SELECT store_id FROM sale_orders WHERE sale_order_id = $1。
 * 调用方在每个会触达 createRefund / close / approve / reject 的测试里先 mock 一行通过即可。
 */
function mockScopeAllow(storeId = 'store-001') {
  pg.query.mockResolvedValueOnce([{ store_id: storeId }])
}

/**
 * 2026-04-26 sale-order-domain-refactor: order.js 现在大量使用
 *   INSERT INTO sale_order_payments (...) RETURNING id
 *   INSERT INTO prepaid_cards (...) RETURNING card_id
 * 后续 client.query 链式访问 .rows[0].id / .card_id。
 * 默认 client.query mock 返回 `{ rows: [], rowCount: 1 }` 会让 .rows[0].id 为 undefined。
 * 此 helper 包一层：识别 RETURNING 的 INSERT 时返回 stub id 行，否则保持默认。
 */
/**
 * 默认 client.query 返回结果（识别 RETURNING / bool_and 等需要 rows[0] 的 SQL）。
 * 内联 vi.fn 中 fallthrough 也应使用此函数，否则 .rows[0].id 会 undefined。
 */
function defaultQueryResult(sql) {
  if (typeof sql === 'string' && /RETURNING\s+id/i.test(sql)) {
    return { rows: [{ id: 1 }], rowCount: 1 }
  }
  if (typeof sql === 'string' && /RETURNING\s+card_id/i.test(sql)) {
    return { rows: [{ card_id: 'card-stub-1' }], rowCount: 1 }
  }
  // mixed-recharge / mixed-experience 守卫（D4/D5）：order.create 写完明细后 SELECT bool_and(...)
  if (typeof sql === 'string' && /bool_and\s*\(\s*is_recharge_card/i.test(sql)) {
    return { rows: [{ all_recharge: false, all_normal: true }], rowCount: 1 }
  }
  if (typeof sql === 'string' && /bool_and\s*\(\s*is_experience/i.test(sql)) {
    return { rows: [{ all_experience: false, all_normal: true }], rowCount: 1 }
  }
  return { rows: [], rowCount: 1 }
}

function makeClientQueryMock(_defaultResult) {
  return vi.fn(async (sql, _params) => defaultQueryResult(sql))
}

describe('order.create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长开单成功 — 普通订单', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      orderType: 'normal',
    })

    // 查询顾客是否已注册
    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }]) // client_wechat_users: 已注册绑定本店
      .mockResolvedValueOnce([]) // 无待支付订单（按 phone+store）
      // SKU 查询
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: '基础款',
        price: '1000.00',
        session_count: 10,
        product_name: '面部护理',
        sales_category: '自销自耗',
      }])
      // generateOrderNo
      .mockResolvedValueOnce([])

    // transaction mock
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: makeClientQueryMock({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result).toBeDefined()
    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-\d{6}\d{4}$/)
    expect(ctx.result.totalAmount).toBe(1000)
    // PR-2：线下全额现场 → 订单 '待支付'（店长 confirmOffline 再转 '已支付'）；首次支付 payments 流水同事务写入
    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.message).toBe('开单成功')
  })

  test('非店长拒绝开单', async () => {
    const ctx = createBeauticianCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 clientPhone 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*手机号/)
  })

  test('缺少 clientName 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*姓名/)
  })

  test('空 items 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [],
      paymentMethod: '线下',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*商品明细/)
  })

  test('缺少 paymentMethod 时拒绝（line 60 TRUE 分支）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*paymentMethod/)
  })

  test('未绑定门店时拒绝开单（line 63 TRUE 分支）', async () => {
    const ctx = createManagerCtx(
      { clientPhone: '138', clientName: 'X', items: [{ skuId: 'sku-001', quantity: 1 }], paymentMethod: '线下' },
      { storeId: null }
    )

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*门店/)
  })

  test('已注册顾客有待支付订单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'client-001', bound_store_id: 'store-001' }])    // 已注册绑定本店
      .mockResolvedValueOnce([{ sale_order_id: 'FY-exist' }]) // 已有待支付

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有待支付订单/)
  })

  test('未注册顾客同店有待支付订单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }]) // 已注册绑定本店
      .mockResolvedValueOnce([{ sale_order_id: 'FY-exist' }]) // 同店已有待支付

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有待支付订单/)
  })

  test('无效 saleOrderType 拒绝', async () => {
    // 重构后入参用 saleOrderType（中文枚举：销售单/内部单），原 orderType 已废弃
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      saleOrderType: '非法类型',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单类型不合法/)
  })

  test('SKU 不存在时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-nonexist', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])  // 已注册绑定本店
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([])  // SKU 不存在

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*商品.*不存在/)
  })

  test('优惠金额超过 saleAmount 时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1, discount: 99999 }],
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: 'S',
        price: '100.00',
        session_count: 1,
        product_name: 'P',
        sales_category: null,
      }])

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*优惠金额/)
  })

  test('体验订单使用 customPrice', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1, customPrice: 1 }],
      paymentMethod: '线下',
      orderType: 'experience',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: 'S',
        price: '1000.00',
        session_count: 10,
        product_name: 'P',
        sales_category: null,
      }])
      .mockResolvedValueOnce([]) // generateOrderNo

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: makeClientQueryMock({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.totalAmount).toBe(1) // customPrice 而非原价
  })

  test('B2 拆行：3次卡 ×4 → 4 行 sale_items（每行 quantity=1, session_count=3）', async () => {
    // ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
    // 修写入侧前：1 行 quantity=4, session_count=12（× quantity）
    // 修写入侧后：4 行 quantity=1, session_count=3（每张独立卡）
    const ctx = createManagerCtx({
      clientPhone: '13800002222',
      clientName: '量乘次数顾客',
      items: [{ skuId: 'sku-001', quantity: 4 }],
      paymentMethod: '线下',
      orderType: 'normal',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: '基础款',
        price: '100.00',
        session_count: 3,
        product_name: '面部护理',
        sales_category: '自销自耗',
      }])
      .mockResolvedValueOnce([])

    const clientQuery = makeClientQueryMock({ rows: [], rowCount: 1 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await orderRoutes.create(ctx)

    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(4)  // 拆为 4 行
    for (const call of insertItemCalls) {
      // params: $1=saleItemId $2=saleOrderId $3=storeId $4=skuId $5=productName $6=skuSpecName
      //         $7=productType $8=session_count $9=remaining_sessions $10=unit_price $11=quantity ...
      expect(call[1][7]).toBe(3)   // session_count = sku.session_count（不再 × quantity）
      expect(call[1][8]).toBe(3)   // remaining_sessions = session_count
      expect(call[1][10]).toBe(1)  // quantity = 1（每张卡独立）
    }
  })

  test('B2 拆行：单次卡 ×10 → 10 行 sale_items（每行 quantity=1, session_count=1）', async () => {
    // 核心场景：单次卡 ×10（sku.session_count=1, quantity=10）
    // 期望：10 行独立卡，每行 quantity=1 / session_count=1 / remaining_sessions=1
    const ctx = createManagerCtx({
      clientPhone: '13800003333',
      clientName: '单次卡顾客',
      items: [{ skuId: 'sku-single', quantity: 10 }],
      paymentMethod: '线下',
      orderType: 'normal',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-single',
        product_id: 'prod-single',
        product_type: '疗程卡',
        spec_name: '单次身体护理',
        price: '200.00',
        session_count: 1,
        product_name: '身体护理',
        sales_category: '自销自耗',
      }])
      .mockResolvedValueOnce([])

    const clientQuery = makeClientQueryMock({ rows: [], rowCount: 1 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await orderRoutes.create(ctx)

    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(10)  // 单次卡 ×10 → 10 行
    let totalReceived = 0
    for (const call of insertItemCalls) {
      expect(call[1][7]).toBe(1)   // session_count = 1
      expect(call[1][8]).toBe(1)   // remaining_sessions = 1
      expect(call[1][10]).toBe(1)  // quantity = 1
      // params[13] = received（unit_price=$10 quantity=$11 unit_real_price=$12 sale_amount=$13 received=$14）
      totalReceived += Number(call[1][13])
    }
    // 守恒：sum(received) ≈ 200 × 10 = 2000
    expect(Math.round(totalReceived * 100)).toBe(200_000)
    expect(ctx.result.totalAmount).toBe(2000)
  })

  test('B2 不拆：家居产品 ×10 → 1 行 sale_items（quantity=10）', async () => {
    // 家居产品（productType='家居产品'）继续合行，不受 B2 拆行影响
    const ctx = createManagerCtx({
      clientPhone: '13800004444',
      clientName: '家居产品顾客',
      items: [{ skuId: 'sku-home', quantity: 10 }],
      paymentMethod: '线下',
      orderType: 'normal',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-home',
        product_id: 'prod-home',
        product_type: '家居产品',
        spec_name: '精华液',
        price: '300.00',
        session_count: null,
        product_name: '精华液',
        sales_category: '自销自耗',
        product_kind: '家居产品',
      }])
      .mockResolvedValueOnce([])

    const clientQuery = makeClientQueryMock({ rows: [], rowCount: 1 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await orderRoutes.create(ctx)

    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(1)  // 家居产品合行
    expect(insertItemCalls[0][1][10]).toBe(10)  // quantity = 10（合行）
    // 家居产品 session_count/remaining_sessions 强制 null（order.js L654 sc/rs 三元）
    expect(insertItemCalls[0][1][7]).toBeNull()
    expect(insertItemCalls[0][1][8]).toBeNull()
  })

  // ===== 优惠券路径覆盖 =====

  test('开单成功 + 现金券抵扣（全单适用，无分类限制）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      orderType: 'normal',
      couponId: 'coupon-001',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])       // 已注册顾客
      .mockResolvedValueOnce([])                             // 无待支付订单
      .mockResolvedValueOnce([{                              // SKU 数据
        sku_id: 'sku-001', product_id: 'prod-001',
        product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: '面部护理', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{                              // 优惠券查询 → 有效
        coupon_id: 'coupon-001', user_id: 'cu-001',
        coupon_type: '现金券', discount_value: '200', min_spend: '500',
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-001' }])  // SKU 分类

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // 1000 - 200 = 800（couponDiscount=200，满足 min_spend=500）
    expect(ctx.result.totalAmount).toBe(800)
    // PR-2：线下全额现场 → 订单 '待支付'
    expect(ctx.result.status).toBe('待支付')
  })

  test('J3 拒绝数组形式 couponId（一张订单仅支持 1 张券）', async () => {
    // B9 ticket follow-up：防绕过 schema 直接传 couponId: ['c1','c2']
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: ['c1', 'c2'],  // 数组形式应被拒绝
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*MULTIPLE_COUPON_NOT_SUPPORTED.*1 张优惠券/)
  })

  test('S2 拆行 + 优惠券分摊守恒：单次卡 ×10 + 满 500 减 50 券', async () => {
    // B2 拆行 + B9 优惠券分摊端到端验证：
    //   - 单次卡 ×10（单价 100）→ 拆 10 行 sale_items
    //   - 现金券满 500 减 50 → 分摊到每行 received
    //   - 守恒：sum(received) = 1000 - 50 = 950
    const ctx = createManagerCtx({
      clientPhone: '13800002222',
      clientName: 'S2 顾客',
      items: [{ skuId: 'sku-single', quantity: 10 }],
      paymentMethod: '线下',
      orderType: 'normal',
      couponId: 'coupon-s2',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-single',
        product_id: 'prod-single',
        product_type: '疗程卡',
        spec_name: '单次身体护理',
        price: '100.00',
        special_price: null,
        session_count: 1,
        product_name: '身体护理',
        sales_category: '自销自耗',
        product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-s2', user_id: 'cu-001',
        coupon_type: '现金券', discount_value: '50', min_spend: '500',
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-single', category_id: 'cat-001' }])

    const clientQuery = makeClientQueryMock({ rows: [], rowCount: 1 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await orderRoutes.create(ctx)

    // 验证拆 10 行 + 分摊守恒
    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(10)

    let totalReceived = 0
    let totalSaleAmount = 0
    for (const call of insertItemCalls) {
      expect(call[1][10]).toBe(1)  // quantity = 1
      expect(call[1][7]).toBe(1)   // session_count = 1
      totalReceived += Number(call[1][13])  // received
      totalSaleAmount += Number(call[1][12])  // sale_amount
    }

    // 守恒：sum(received) = 1000 - 50 = 950（券抵扣 50 元）
    expect(Math.round(totalReceived * 100)).toBe(95_000)
    // 守恒：sum(sale_amount) = 1000（原价不变，券作用在 received）
    expect(Math.round(totalSaleAmount * 100)).toBe(100_000)
    expect(ctx.result.totalAmount).toBe(950)
  })

  test('优惠券不存在或已过期时报错（couponRows.length === 0）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-bad',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '100.00', special_price: null, session_count: 0,
        product_name: 'P', sales_category: null, product_kind: '家居产品',
      }])
      .mockResolvedValueOnce([])   // 优惠券查询 → 空

    await expect(orderRoutes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*优惠券已失效/)
  })

  test('优惠券门店限制不匹配时报错（applicable_store_ids 不含当前门店）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-002',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '800.00', special_price: null, session_count: 0,
        product_name: 'P', sales_category: null, product_kind: '家居产品',
      }])
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-002', user_id: 'cu-001',
        coupon_type: '现金券', discount_value: '100', min_spend: '0',
        applicable_store_ids: ['store-other'],      // 不含 store-001
        applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])

    await expect(orderRoutes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于此门店/)
  })

  test('优惠券品项分类不匹配时报错（eligibleItems.length === 0）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-003',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '800.00', special_price: null, session_count: 0,
        product_name: 'P', sales_category: null, product_kind: '家居产品',
      }])
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-003', user_id: 'cu-001',
        coupon_type: '品项券', discount_value: '50', min_spend: '0',
        applicable_store_ids: null,
        applicable_category_ids: ['cat-护理'],  // 商品属于 cat-home，不匹配
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-home' }])  // SKU 分类

    await expect(orderRoutes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于当前商品/)
  })

  test('优惠券未满最低消费限制时报错（eligibleTotal < minSpend）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-004',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '300.00', special_price: null, session_count: 0,  // 实收 300
        product_name: 'P', sales_category: null, product_kind: '家居产品',
      }])
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-004', user_id: 'cu-001',
        coupon_type: '现金券', discount_value: '50', min_spend: '500',  // 要满 500
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-001' }])

    await expect(orderRoutes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*未满足使用条件/)
  })

  test('折扣券正确计算打折金额（含 max_discount 上限）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-disc',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])  // 已注册
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '1000.00', special_price: null, session_count: null,
        product_name: '精华液', sales_category: '自销自耗', product_kind: '家居产品',
      }])
      // 折扣券：8折(0.8)，最大优惠 150
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-disc', user_id: 'cu-001',
        coupon_type: '折扣券', discount_value: '0.8', min_spend: '0',
        max_discount: '150',
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-001' }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // 1000 × (1-0.8) = 200, 但 max_discount=150, 所以 discount=150
    // totalAmount = 1000 - 150 = 850
    expect(ctx.result.totalAmount).toBe(850)

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })

  test('折扣券无 max_discount 时全额打折', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-disc2',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'p1', product_type: '疗程卡',
        spec_name: 'S', price: '500.00', special_price: null, session_count: null,
        product_name: '面膜', sales_category: '自销自耗', product_kind: '家居产品',
      }])
      // 折扣券：9折(0.9)，无上限
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-disc2', user_id: 'cu-001',
        coupon_type: '折扣券', discount_value: '0.9', min_spend: '0',
        max_discount: null,
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-001' }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // 500 × (1-0.9) = 50, 无上限
    // totalAmount = 500 - 50 = 450
    expect(ctx.result.totalAmount).toBe(450)

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })

  test('事务内优惠券原子 claim 竞态（rowCount=0）时报错', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138', clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'coupon-001',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'prod-001', product_type: '疗程卡',
        spec_name: '基础款', price: '1000.00', special_price: null, session_count: 10,
        product_name: '面部护理', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{
        coupon_id: 'coupon-001', user_id: 'cu-001',
        coupon_type: '现金券', discount_value: '200', min_spend: '500',
        applicable_store_ids: null, applicable_category_ids: null,
        expire_at: new Date(Date.now() + 86400000),
      }])
      .mockResolvedValueOnce([{ sku_id: 'sku-001', category_id: 'cat-001' }])

    // generateOrderNo 事务：正常返回
    pg.transaction
      .mockImplementationOnce(async (cb) => {
        const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
        return await cb(client)
      })
      // 主事务：UPDATE user_coupons 返回 rowCount=0 → 竞态失败
      .mockImplementationOnce(async (cb) => {
        const client = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // advisory_xact_lock
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // SELECT sale_items
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }),  // UPDATE user_coupons → 0
        }
        return await cb(client)
      })

    await expect(orderRoutes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*优惠券已失效/)
  })

  test('内部单统一半价（saleOrderType=内部单）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '内部员工',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      saleOrderType: '内部单',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])    // 已注册绑定本店
      .mockResolvedValueOnce([])    // 无待支付订单（按 phone+store）
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_id: 'prod-001', product_type: '疗程卡',
        spec_name: '基础款', price: '1000.00', special_price: null, session_count: 5,
        product_name: '面部护理', sales_category: '自销自耗', product_kind: '护理项目',
      }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // 内部单半价：Math.round(1000 * 50) / 100 = 500
    expect(ctx.result.totalAmount).toBe(500)
    // PR-2：线下全额现场 → 订单 '待支付'
    expect(ctx.result.status).toBe('待支付')
  })

  // 已废弃：'promotion'/'组合套餐' 订单类型在 PR-C（commit 4966b67/fb618ea）重构中移除
  // 现在 saleOrderType 仅 销售单/内部单，bundle 信息由商品自身 is_bundle 字段表达，不在订单层校验

  test('已注册顾客成功开单（家居产品 SKU，session_count=null）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '注册顾客',
      items: [{ skuId: 'sku-single', quantity: 2 }],
      paymentMethod: '线下',
      orderType: 'normal',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])  // 已注册 → clientUserId = 'cu-001'
      .mockResolvedValueOnce([])                        // 无待支付订单（按 clientUserId）
      .mockResolvedValueOnce([{
        sku_id: 'sku-single', product_id: 'prod-002', product_type: '家居产品',
        spec_name: '标准', price: '200.00', special_price: null,
        session_count: null, // 家居产品无疗程次数 → sessionCount = null
        product_name: '精华液', sales_category: '自销自耗', product_kind: '家居产品',
      }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: makeClientQueryMock({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.totalAmount).toBe(400) // 200 × 2
  })

  test('special_price 优先于 price', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-sp', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])  // 已注册绑定本店
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([{
        sku_id: 'sku-sp', product_id: 'prod-003', product_type: '疗程卡',
        spec_name: '特惠款', price: '1000.00', special_price: '800.00',
        session_count: 5, product_name: '特价项目', sales_category: '自销自耗', product_kind: '护理项目',
      }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.totalAmount).toBe(800)  // 使用 special_price 而非 price
  })

  // ===== PR-2：paymentMethod 行为 =====

  test('销售单 + 线下支付（默认 receivedAmount=payable）→ status=已支付', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      saleOrderType: '销售单',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])  // 已注册绑定本店
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: '基础款',
        price: '1000.00',
        session_count: 10,
        product_name: '面部护理',
        sales_category: '自销自耗',
      }])
      .mockResolvedValueOnce([])  // generateOrderNo

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // PR-2: 线下全额现场 → '待支付'
    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-\d{6}\d{4}$/)
  })

  test('销售单 + 微信支付 → status=待支付', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      saleOrderType: '销售单',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: '基础款',
        price: '1000.00',
        session_count: 10,
        product_name: '面部护理',
        sales_category: '自销自耗',
      }])
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.status).toBe('待支付')
  })

  test('非法 paymentMethod=支付宝 被拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '支付宝',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*支付方式/)
  })

  test('非法 paymentMethod=wechat 被拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'wechat',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*支付方式/)
  })

  // ===== PR-2: receivedAmount + sale_order_payments =====

  // mock helper for PR-2 create 场景
  function mockCreateCtxOk(overrides = {}) {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '部分支付顾客',
      items: [{ skuId: 'sku-200', quantity: 1 }],
      paymentMethod: '线下',
      saleOrderType: '销售单',
      ...overrides,
    })
    return ctx
  }

  function mockPgForCreate(skuPrice = '200.00') {
    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-200', bound_store_id: 'store-001' }])  // client_wechat_users
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([{
        sku_id: 'sku-200', product_type: '疗程卡', spec_name: '基础款',
        price: skuPrice, special_price: null, session_count: 5,
        product_name: '护理项目', sales_category: '自销自耗', product_kind: '护理项目',
      }])
  }

  test('PR-2 create 全额现场（线下, receivedAmount=payable）→ 订单 待支付 + 1 行 首次支付/已支付', async () => {
    const ctx = mockCreateCtxOk({ receivedAmount: 200 })
    mockPgForCreate()

    const paymentInserts = []
    let orderInsertParams = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('INSERT INTO sale_orders')) orderInsertParams = params
          if (sql.includes('INSERT INTO sale_order_payments')) paymentInserts.push({ sql, params })
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.paidAmount).toBe(200)
    expect(ctx.result.payableAmount).toBe(200)
    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(paymentInserts.length).toBe(1)
    // INSERT 语句含 '首次支付' 字面量
    expect(paymentInserts[0].sql).toMatch(/'首次支付'/)
    // amount 参数（按顺序 saleOrderId, amount, paymentMethod, operator, note, now）
    expect(Number(paymentInserts[0].params[1])).toBe(200)
    expect(paymentInserts[0].params[2]).toBe('线下')
  })

  test('PR-2 create 首次部分（线下, 0<received<payable）→ 订单 部分支付 + 1 行 首次支付/已支付', async () => {
    const ctx = mockCreateCtxOk({ receivedAmount: 80 })
    mockPgForCreate()

    const paymentInserts = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('INSERT INTO sale_order_payments')) paymentInserts.push({ sql, params })
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.status).toBe('部分支付')
    expect(ctx.result.paidAmount).toBe(80)
    expect(ctx.result.payableAmount).toBe(200)
    expect(paymentInserts.length).toBe(1)
    expect(paymentInserts[0].sql).toMatch(/'首次支付'/)
    expect(Number(paymentInserts[0].params[1])).toBe(80)
  })

  test('PR-2 create 纯挂账（线下, receivedAmount=0）→ 订单 待支付，无 payments 行', async () => {
    const ctx = mockCreateCtxOk({ receivedAmount: 0 })
    mockPgForCreate()

    const paymentInserts = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('INSERT INTO sale_order_payments')) paymentInserts.push({ sql, params })
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.paidAmount).toBe(0)
    expect(paymentInserts.length).toBe(0)
  })

  test('PR-2 create 储值卡抵扣 + 部分现场 → 订单 部分支付 + 仅 1 行首次支付 payments（储值卡抵扣留到 confirmOffline）', async () => {
    const ctx = mockCreateCtxOk({
      useCard: true,
      prepaidCardAmount: 50,  // 显式传入
      receivedAmount: 40,
    })
    // 顾客 + 无待支付 + SKU + 储值卡余额
    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-200', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-200', product_type: '疗程卡', spec_name: '基础款',
        price: '200.00', special_price: null, session_count: 5,
        product_name: '护理项目', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '500.00' }])

    const paymentInserts = []
    const cardTxnInserts = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('INSERT INTO sale_order_payments')) {
            paymentInserts.push({ sql, params })
          }
          if (sql.includes('INSERT INTO card_transactions')) {
            cardTxnInserts.push({ sql, params })
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // total=200, prepaid=50, payable=150, received=40 → paid=40, settled=90 → 部分支付
    expect(ctx.result.totalAmount).toBe(200)
    expect(ctx.result.prepaidCardAmount).toBe(50)
    expect(ctx.result.payableAmount).toBe(150)
    expect(ctx.result.paidAmount).toBe(40)
    expect(ctx.result.status).toBe('部分支付')
    // create 时仅写 1 行 payments：首次支付（现金部分）。储值卡抵扣 payments 行 + 扣卡归 confirmOffline
    expect(paymentInserts.length).toBe(1)
    expect(paymentInserts[0].sql).toMatch(/'首次支付'/)
    expect(Number(paymentInserts[0].params[1])).toBe(40)
    // create 不扣卡（staff CLAUDE.md：唯一扣卡点在 confirmOffline）
    expect(cardTxnInserts.length).toBe(0)
  })

  test('PR-2 create 参数错误：receivedAmount > payable_amount → INVALID_PARAMS', async () => {
    const ctx = mockCreateCtxOk({ receivedAmount: 999 })
    mockPgForCreate()

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*实收金额/)
  })

  test('PR-2 create 参数错误：微信 + receivedAmount > 0 → MIXED_PAYMENT_NOT_SUPPORTED', async () => {
    const ctx = mockCreateCtxOk({ paymentMethod: '微信', receivedAmount: 100 })
    mockPgForCreate()

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/微信\/支付宝不支持部分线上支付/)
  })

  test('PR-2 create 不变量：create 阶段 sale_orders.paid_amount = Σ(payments.amount WHERE 已支付 AND change_type IN (首次支付,回款,退款))', async () => {
    // 场景：线下部分支付 received=50, prepaidCard=30（预选，create 不扣卡）
    //   sale_orders.paid_amount = 50
    //   Σ(payments.amount where 已支付 且 change_type∈{首次支付,回款,退款}) = 50（只有 1 行首次支付）
    //   储值卡抵扣 payments 行 + 扣卡在 confirmOffline 发生
    const ctx = mockCreateCtxOk({
      useCard: true,
      prepaidCardAmount: 30,
      receivedAmount: 50,
    })
    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-200', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-200', product_type: '疗程卡', spec_name: '基础款',
        price: '200.00', special_price: null, session_count: 5,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '500.00' }])

    const paymentInserts = []
    const cardTxnInserts = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('INSERT INTO sale_order_payments')) {
            let changeType = null
            if (sql.includes("'储值卡抵扣'")) changeType = '储值卡抵扣'
            else if (sql.includes("'首次支付'")) changeType = '首次支付'
            paymentInserts.push({ changeType, amount: Number(params[1]) })
          }
          if (sql.includes('INSERT INTO card_transactions')) {
            cardTxnInserts.push({ sql, params })
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.paidAmount).toBe(50)
    expect(ctx.result.prepaidCardAmount).toBe(30)

    // 不变量（create 阶段）：sale_orders.paid_amount = Σ(payments.amount WHERE 已支付 AND change_type ∈ {首次支付,回款,退款})
    const paidAmountFromPayments = paymentInserts
      .filter(p => ['首次支付', '回款', '退款'].includes(p.changeType))
      .reduce((s, p) => s + p.amount, 0)
    expect(paidAmountFromPayments).toBe(ctx.result.paidAmount)

    // create 阶段储值卡抵扣不写 payments 行，也不扣卡（归 confirmOffline）
    const prepaidFromPayments = paymentInserts
      .filter(p => p.changeType === '储值卡抵扣')
      .reduce((s, p) => s + p.amount, 0)
    expect(prepaidFromPayments).toBe(0)
    expect(cardTxnInserts.length).toBe(0)

    // 总共 1 行首次支付
    expect(paymentInserts.length).toBe(1)
  })
})

describe('order.confirmOffline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长确认线下收款成功（C4: UPDATE WHERE 含 status 条件）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-XSD-WX-2401010001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-XSD-WX-2401010001',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        total_amount: '500',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '500',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', sku_id: 'sku-001', received: '500', product_type: '疗程卡' },
      ])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments（无历史 payments → 首次支付）

    let capturedUpdateSql = ''
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql.includes('UPDATE sale_orders') && sql.includes('SET status')) capturedUpdateSql = sql
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.totalReceived).toBe(500)
    // 验证 C4 合规：UPDATE WHERE 含 status 条件
    expect(capturedUpdateSql).toContain('AND status = $')
  })

  test('并发竞态：confirmOffline UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        total_amount: '100',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '100',
      }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001', received: '100', product_type: '疗程卡' }])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('非店长拒绝确认', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非线下支付订单拒绝直接确认', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      payment_method: '微信',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*非线下支付/)
  })

  test('已支付订单拒绝重复确认', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      payment_method: '线下',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不可确认/)
  })

  test('待支付线下订单可直接确认收款（跳过 wechat 拦截，进入事务）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '待支付',
        payment_method: '线下',  // offline → 不触发非线下拦截
        store_id: 'store-001',
        total_amount: '300',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '300',
      }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001', received: '300', product_type: '疗程卡' }])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.totalReceived).toBe(300)
  })

  // ===== 充值卡入账识别（真实档位 SKU + 虚拟 SKU 两条路径）=====

  test('真实档位 SKU 充值卡：确认后 UPSERT prepaid_cards + INSERT card_transactions（面值从 product_skus.price）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-CZ-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-CZ-001',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-001',
        total_amount: '495',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '495',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-cz-1', sku_id: 'sku-cz-500', received: '495', product_type: '家居产品' },
      ])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    let upsertCalls = 0
    let txnInsertCalls = 0
    let txnInsertParams = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('si.is_recharge_card = true')) {
            return { rows: [{ sku_id: 'sku-cz-500', product_name: '充值 500 元', sku_price: '500.00' }] }
          }
          if (sql.includes('FROM card_transactions') && sql.includes('ref_order_id')) {
            return { rows: [] } // 无重复
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }  // 早退出 recalcCustomerType
          }
          if (sql.includes('INSERT INTO prepaid_cards')) {
            upsertCalls++
            return { rows: [{ card_id: 'FY-CARD-TEST-001' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO card_transactions')) {
            txnInsertCalls++
            txnInsertParams = params
            return { rows: [], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(upsertCalls).toBe(1)
    expect(txnInsertCalls).toBe(1)
    // card_transactions(cardId, amount=面值, ref_order_id)
    expect(txnInsertParams[0]).toBe('FY-CARD-TEST-001')
    expect(Number(txnInsertParams[1])).toBe(500)
    expect(txnInsertParams[2]).toBe('FY-CZ-001')
  })

  test('自定义金额虚拟 SKU：面值从 product_name 的 "¥{n}" 正则解析', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-CZ-002' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-CZ-002',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-002',
        total_amount: '2940',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '2940',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-cz-v', sku_id: 'sku-recharge-virtual', received: '2940', product_type: '家居产品' },
      ])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    let txnInsertParams = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('si.is_recharge_card = true')) {
            return {
              rows: [{
                sku_id: 'sku-recharge-virtual',
                product_name: '预付充值卡 ¥3000',
                sku_price: '0.00',   // 虚拟 SKU 的 price=0，被正则覆盖
              }],
            }
          }
          if (sql.includes('FROM card_transactions') && sql.includes('ref_order_id')) {
            return { rows: [] }
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO prepaid_cards')) {
            return { rows: [{ card_id: 'FY-CARD-TEST-V' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO card_transactions')) {
            txnInsertParams = params
            return { rows: [], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(Number(txnInsertParams[1])).toBe(3000)  // 从 product_name 解析
  })

  test('幂等：已有 card_transactions.ref_order_id 时跳过入账', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-CZ-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-CZ-003',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-003',
        total_amount: '495',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '495',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-cz-3', sku_id: 'sku-cz-500', received: '495', product_type: '家居产品' },
      ])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    let upsertCalls = 0
    let txnInsertCalls = 0
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql.includes('si.is_recharge_card = true')) {
            return { rows: [{ sku_id: 'sku-cz-500', product_name: '充值 500 元', sku_price: '500.00' }] }
          }
          if (sql.includes('FROM card_transactions') && sql.includes('ref_order_id')) {
            return { rows: [{ '?column?': 1 }] }  // 已有流水，触发幂等跳过
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO prepaid_cards')) { upsertCalls++; return { rows: [{ card_id: 'x' }] } }
          if (sql.includes('INSERT INTO card_transactions')) { txnInsertCalls++; return { rows: [] } }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(upsertCalls).toBe(0)
    expect(txnInsertCalls).toBe(0)
  })

  test('非充值卡订单：确认收款不触发 prepaid_cards UPSERT', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NORMAL' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-NORMAL',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-100',
        total_amount: '300',
        paid_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '300',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-norm', sku_id: 'sku-careitem', received: '300', product_type: '疗程卡' },
      ])
      .mockResolvedValueOnce([])  // SELECT sale_order_payments

    let upsertCalls = 0
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql.includes('si.is_recharge_card = true')) {
            return { rows: [] }  // 不含充值卡行
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO prepaid_cards')) { upsertCalls++; return { rows: [{ card_id: 'x' }] } }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(upsertCalls).toBe(0)
  })

  // ===== PR-2: sale_order_payments 流水 =====

  test('PR-2 confirmOffline 部分订单再次确认全额 → 订单转 已支付，新增"回款/已支付" payments 行', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-PS-001' })

    // 原订单：total=200，已付 80，剩 120
    // 2026-04-26 sale-order-domain-refactor: paid_amount → received（保留 paid_amount 兼容）
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-PS-001',
        status: '部分支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-ps',
        total_amount: '200',
        received: '80',
        refunded_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '200',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', sku_id: 'sku-1', received: '200', product_type: '疗程卡' },
      ])
      .mockResolvedValueOnce([{ '?column?': 1 }])  // SELECT sale_order_payments → 已存在 → 本次为"回款"

    const paymentInserts = []
    let updateParams = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('UPDATE sale_orders') && sql.includes('SET status')) {
            updateParams = params
            return { rows: [], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO sale_order_payments')) {
            paymentInserts.push({ sql, params })
            return { rows: [{ id: 1 }], rowCount: 1 }
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    // status 转 '已支付'
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.paidAmount).toBe(200)   // 80 + 120
    expect(ctx.result.confirmAmount).toBe(120)
    // UPDATE params：targetStatus, newPaidAmount
    expect(updateParams[0]).toBe('已支付')
    expect(Number(updateParams[1])).toBe(200)
    // 本次为"回款"流水
    expect(paymentInserts.length).toBe(1)
    expect(paymentInserts[0].params[1]).toBe('回款')
    expect(Number(paymentInserts[0].params[2])).toBe(120)
  })

  test('PR-2 confirmOffline 部分订单确认更小金额 → 订单仍 部分支付，paid_amount 累加', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-PS-002', confirmAmount: 30 })

    // 原订单：total=200，已付 80
    // 2026-04-26 sale-order-domain-refactor: paid_amount → received
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-PS-002',
        status: '部分支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'u-ps2',
        total_amount: '200',
        received: '80',
        refunded_amount: '0',
        prepaid_card_amount: '0',
        payable_amount: '200',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', sku_id: 'sku-1', received: '200', product_type: '疗程卡' },
      ])
      .mockResolvedValueOnce([{ '?column?': 1 }])  // 已有 payments → 本次为"回款"

    let updateParams = null
    const paymentInserts = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes('UPDATE sale_orders') && sql.includes('SET status')) {
            updateParams = params
            return { rows: [], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO sale_order_payments')) {
            paymentInserts.push({ sql, params })
            return { rows: [{ id: 1 }], rowCount: 1 }
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }  // 早退 recalcCustomerType
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    // status 仍 '部分支付'（80+30 = 110 < 200）
    expect(ctx.result.status).toBe('部分支付')
    expect(ctx.result.paidAmount).toBe(110)
    expect(ctx.result.confirmAmount).toBe(30)
    expect(ctx.result.remainingPayable).toBe(90)
    expect(updateParams[0]).toBe('部分支付')
    expect(Number(updateParams[1])).toBe(110)
    expect(paymentInserts.length).toBe(1)
    expect(paymentInserts[0].params[1]).toBe('回款')
    expect(Number(paymentInserts[0].params[2])).toBe(30)
  })
})

describe('order.close', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // assertOrderInScope helper 调用 SELECT store_id FROM sale_orders（在 SELECT * 之前）
  const mockScopeOk = (storeId = 'store-001') =>
    pg.query.mockResolvedValueOnce([{ store_id: storeId }])

  test('店长可关闭待支付订单（C4: UPDATE WHERE 含 status 条件）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    let capturedUpdateSql = ''
    let capturedUpdateParams = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql.includes("status = '已关闭'")) {
            capturedUpdateSql = sql
            capturedUpdateParams = params
          }
          if (sql.includes('sale_items')) return { rows: [{ sale_item_id: 'item-1' }], rowCount: 1 }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)

    expect(ctx.result.status).toBe('已关闭')
    // C4 合规验证
    expect(capturedUpdateSql).toContain('AND status = $')
    expect(capturedUpdateParams).toContain('待支付')
  })

  test('店长可关闭支付失败订单', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '支付失败',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sale_orders
          .mockResolvedValue({ rows: [], rowCount: 0 }),     // 其他查询
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)
    expect(ctx.result.status).toBe('已关闭')
  })

  test('店长不能关闭已支付订单', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许关闭/)
  })

  test('开单人可取消自己的待支付订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-beautician-001', // 与 beautician ctx.auth.staffWfId 匹配
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sale_orders
          .mockResolvedValue({ rows: [], rowCount: 0 }),     // 其他查询
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)
    expect(ctx.result.status).toBe('已关闭')
  })

  test('非开单人美容师不能关闭订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-other', // 不是当前用户
    }])

    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*无权/)
  })

  test('并发竞态：close UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-001',
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])  // assertOrderInScope 命中 0 行
    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*订单不存在/)
  })

  test('关闭订单时作废分配并释放优惠券', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-001',
    }])

    const clientQueryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sale_orders
      .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-1' }, { sale_item_id: 'item-2' }] }) // SELECT sale_items
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // UPDATE sale_allocations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE user_coupons

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await orderRoutes.close(ctx)

    // 验证 sale_allocations 被作废
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('sale_allocations'),
      expect.arrayContaining([['item-1', 'item-2']])
    )
    // 验证 user_coupons 被释放
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('user_coupons'),
      ['FY-001']
    )
  })
})

describe('order.resetFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长重置支付失败订单为待支付（C4: UPDATE WHERE 含 status 条件）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '支付失败',
      store_id: 'store-001',
    }])
    // UPDATE + 审计日志走事务 client
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await orderRoutes.resetFailed(ctx)

    expect(ctx.result.status).toBe('待支付')
    // C4 合规验证
    const updateSql = clientQuery.mock.calls[0][0]
    expect(updateSql).toContain("AND status = '支付失败'")
  })

  test('并发竞态：resetFailed UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '支付失败',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 并发：另一个请求先到

    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('非支付失败状态拒绝重置', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不是支付失败/)
  })

  test('非店长拒绝重置', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('order.list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长查看所有订单', async () => {
    const ctx = createManagerCtx({ page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '待支付' },
      { sale_order_id: 'FY-002', status: '已支付' },
    ])

    await orderRoutes.list(ctx)

    expect(ctx.result.orders).toHaveLength(2)
    // 不应有 preferred_employee_id WHERE 过滤（SELECT 列包含该字段是正常的）
    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('AND o.preferred_employee_id')
  })

  test('美容师只看指定自己的订单', async () => {
    const ctx = createBeauticianCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '待支付' },
    ])

    await orderRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('preferred_employee_id')
    // 参数中应包含 staffWfId
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('按状态过滤', async () => {
    const ctx = createManagerCtx({ status: '已支付', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await orderRoutes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('已支付')
  })

  test('分页参数正确传递（page=2，offset=20）', async () => {
    const ctx = createManagerCtx({ page: 2, pageSize: 20 })

    pg.query.mockResolvedValueOnce([])

    await orderRoutes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    // params = [storeId, pageSize, offset]
    expect(params[1]).toBe(20)  // pageSize
    expect(params[2]).toBe(20)  // offset = (2-1) * 20
    expect(ctx.result.page).toBe(2)
  })

  test('美容师 + 状态过滤组合查询', async () => {
    const ctx = createBeauticianCtx({ status: '待支付', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([])

    await orderRoutes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('AND o.status')
    expect(sql).toContain('AND o.preferred_employee_id')
    expect(params).toContain('待支付')
    expect(params).toContain('emp-beautician-001')
  })

  test('无 status 参数时不添加状态过滤', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([])

    await orderRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('AND o.status')
  })
})

describe('order.detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长查看订单详情', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        store_id: 'store-001',
        preferred_employee_id: 'emp-b1',
        client_phone: '138',
        customer_name: '顾客A',
        coupon_id: null,
      }])
      .mockResolvedValueOnce([{ name: '美容师A' }])   // preferred_staff_name
      .mockResolvedValueOnce([{ sale_item_id: 'item-1' }]) // items
      .mockResolvedValueOnce([])                       // allocations

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('美容师不能查看非指定自己的订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      store_id: 'store-001',
      preferred_employee_id: 'emp-other', // 不是当前美容师
    }])

    await expect(orderRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('client_phone 缺失时从 client_wechat_users 补全手机号和姓名', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D02' })

    pg.query
      // order: 无 client_phone, 有 client_user_id, 无 customer_name
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D02', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: null, client_user_id: 'cu-002',
        customer_name: null, coupon_id: null,
      }])
      // client_phone fallback → 找到手机号
      .mockResolvedValueOnce([{ phone: '13911112222' }])
      // customer_name fallback → 找到姓名
      .mockResolvedValueOnce([{ name: '顾客B' }])
      // items
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.client_phone).toBe('13911112222')
    expect(ctx.result.order.customer_name).toBe('顾客B')
  })

  test('client_phone fallback 未找到时 phone 保持 null，customer_name 跳过查询', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D03' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D03', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: null, client_user_id: 'cu-003',
        customer_name: null, coupon_id: null,
      }])
      // client_phone fallback → 未找到
      .mockResolvedValueOnce([])
      // items（customer_name fallback 因 phone 仍 null 被跳过）
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.client_phone).toBeNull()
    expect(ctx.result.order.customer_name).toBeNull()
  })

  test('preferred_employee_id 为空时跳过员工姓名查询', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D04' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D04', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: '138', customer_name: '顾客A',
        coupon_id: null,
      }])
      // items（跳过 staff query）
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    // 没有 preferred_staff_name 字段被设置
    expect(ctx.result.order.preferred_staff_name).toBeUndefined()
  })

  test('preferred_employee_id 有值但 staff 不存在时不设置姓名', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D05' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D05', status: '已支付', store_id: 'store-001',
        preferred_employee_id: 'emp-gone', client_phone: '138', customer_name: '顾客A',
        coupon_id: null,
      }])
      // staff query → 未找到
      .mockResolvedValueOnce([])
      // items
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.preferred_staff_name).toBeUndefined()
  })

  test('coupon_id 存在时查询优惠券名称', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D06' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D06', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: '138', customer_name: '顾客A',
        coupon_id: 'coupon-001',
      }])
      // items
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])
      // coupon → 找到
      .mockResolvedValueOnce([{ name: '满减券' }])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.coupon_name).toBe('满减券')
  })

  test('coupon_id 存在但优惠券查询无结果时 coupon_name 为 null', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D07' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D07', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: '138', customer_name: '顾客A',
        coupon_id: 'coupon-expired',
      }])
      // items
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])
      // coupon → 未找到（已删除/过期）
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.coupon_name).toBeNull()
  })

  test('customer_name 存在时跳过姓名补全查询', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D08' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D08', status: '已支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: '138', customer_name: '已有姓名',
        client_user_id: null, coupon_id: null,
      }])
      // items（直接跳到 items，不查 client_wechat_users 和 name）
      .mockResolvedValueOnce([])
      // allocations
      .mockResolvedValueOnce([])
      // payments（Ticket 2 PR-A 新增）
      .mockResolvedValueOnce([])

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.customer_name).toBe('已有姓名')
    // 4 次 pg.query（order + items + allocations + payments），无姓名/手机补全查询
    expect(pg.query).toHaveBeenCalledTimes(4)
  })

  test('detail 返回 payments 流水（Ticket 2 PR-A）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-D09' })
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-D09', status: '部分支付', store_id: 'store-001',
        preferred_employee_id: null, client_phone: '138', customer_name: '顾客',
        coupon_id: null,
      }])
      .mockResolvedValueOnce([]) // items
      .mockResolvedValueOnce([]) // allocations
      .mockResolvedValueOnce([   // payments
        { change_type: '首次支付', amount: '100.00', payment_method: '线下', status: '已支付', paid_at: '2026-04-24', created_at: '2026-04-24', note: null },
        { change_type: '回款', amount: '50.00', payment_method: '线下', status: '已支付', paid_at: '2026-04-24', created_at: '2026-04-24', note: '店长发起回款' },
      ])

    await orderRoutes.detail(ctx)
    expect(ctx.result.payments).toHaveLength(2)
    expect(ctx.result.payments[0].change_type).toBe('首次支付')
    expect(ctx.result.payments[1].change_type).toBe('回款')
    expect(ctx.result.payments[1].amount).toBe(50)
  })
})

// ============================================================
// order.qrcode
// ============================================================
describe('order.qrcode', () => {
  const wxacode = globalThis.__mocks__.wxacode

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('待支付订单返回二维码', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-001', status: '待支付', sale_order_type: '销售单',
        client_phone: '138', customer_name: '张三', payment_method: '微信',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_name: '面部护理', sku_spec_name: '基础款' },
      ])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.saleOrderId).toBe('FY-QR-001')
    expect(ctx.result.qrCodeStatus).toBe('待扫码')
    expect(ctx.result.qrcodeUrl).toBe('cloud://mock-file-id/wxacode.png')
    expect(ctx.result.qrcodeError).toBe('')
    expect(ctx.result.totalAmount).toBe(500)
    expect(ctx.result.items).toHaveLength(1)
    expect(wxacode.generateWxacode).toHaveBeenCalledWith('FY-QR-001', expect.any(String))
  })

  test('已支付订单不生成二维码', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-002' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-002', status: '已支付', sale_order_type: '销售单',
        client_phone: '138', customer_name: '张三', payment_method: '线下',
        paid_at: '2024-06-15', store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '1000', product_name: 'P1', sku_spec_name: 'S1' },
      ])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrCodeStatus).toBe('已支付')
    expect(ctx.result.qrcodeUrl).toBe('')
    expect(wxacode.generateWxacode).not.toHaveBeenCalled()
  })

  test('待确认收款状态映射（status=待支付 + payment_method=线下 → qrCodeStatus 待确认收款 UI 标签）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-003', status: '待支付', sale_order_type: '销售单',
        client_phone: '138', customer_name: '张三', payment_method: '线下',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrCodeStatus).toBe('待确认收款')
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])

    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('二维码生成失败时设置 qrcodeError', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-ERR' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-ERR', status: '待支付', sale_order_type: '销售单',
        client_phone: '138', customer_name: '张三', payment_method: '线下',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([])

    wxacode.generateWxacode.mockRejectedValueOnce(new Error('生成失败'))

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrcodeUrl).toBe('')
    expect(ctx.result.qrcodeError).toBe('生成小程序码失败')
  })

  test('非本店美容师不能查看', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-QR-004' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-QR-004', status: '待支付', sale_order_type: '销售单',
      client_phone: '138', customer_name: '张三', payment_method: '线下',
      paid_at: null, store_id: 'store-other', opened_by: 'emp-001',
    }])

    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

})

// ============================================================
// order.createRefund
// ============================================================
//   - 入参: { refSaleOrderId, items, refundReason, handlingFee }
//   - 数据流（事务内）:
//       1) INSERT sale_order_payments(change_type='退款', amount=-finalRefund, status='待审批',
//          operator_employee_id, refund_reason, ref_sale_item_id, session_count,
//          note=JSON{handlingFee, refundByCard, refundByOrigin, items})
//       2) INSERT operation_logs(action='order.createRefund', target_type='sale_order_payment')
//   - 返回: { paymentId, status: '待审批', totalAmount, finalRefundAmount, refundByCard,
//     refundByOrigin, refundPaymentMethod, message }
//   - in-flight 唯一性：partial unique uq_sop_status_audit 防同原单第 2 笔待审批
describe('order.createRefund', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // assertOrderInScope helper SELECT store_id FROM sale_orders（先于业务 SELECT *）
    pg.query.mockResolvedValueOnce([{ store_id: 'store-001' }])
  })

  /**
   * 构造 createRefund 的事务 client.query mock。
   * 该路由 INSERT 顺序：
   *   1) INSERT sale_order_payments(...) RETURNING id  — 主表单条
   *   2) INSERT operation_logs(...)
   */
  function makeRefundTxnSpy({ paymentId = 1001 } = {}) {
    const calls = []
    const fn = vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(sql)) {
        return { rows: [{ id: paymentId }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: fn }))
    return { calls, fn }
  }

  test('部分退款（指定 ref_sale_item_id + 疗程卡）成功 — 写入主表单条', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      items: [{ saleItemId: 'item-001', refundQuantity: 1 }],
      refundReason: '质量问题',
      handlingFee: 50,
    })

    pg.query
      // SELECT sale_orders 原单
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-001', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', client_phone: '138', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '1000',
      }])
      // in-flight 唯一性校验
      .mockResolvedValueOnce([])
      // SELECT sale_items 原单明细（疗程卡 1 次）
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', sku_id: 'sku-001', product_name: '面部护理',
        sku_spec_name: '基础款', product_type: '疗程卡', session_count: 10,
        remaining_sessions: 10,
        unit_price: '1000', unit_real_price: '1000', quantity: 1,
        sales_category: '自销自耗', service_fee: '0',
      }])

    const { calls } = makeRefundTxnSpy({ paymentId: 1001 })

    await orderRoutes.createRefund(ctx)

    // ===== 返回值 =====
    expect(ctx.result.paymentId).toBe(1001)
    expect(ctx.result.status).toBe('待审批')
    expect(ctx.result.totalAmount).toBe(-950)         // -(1000 - 50)
    expect(ctx.result.finalRefundAmount).toBe(950)
    expect(ctx.result.refundByCard).toBe(0)
    expect(ctx.result.refundByOrigin).toBe(950)
    expect(ctx.result.refundPaymentMethod).toBe('线下')
    expect(ctx.result.message).toMatch(/退款已发起.*等待审批/)

    // ===== sop 写入断言：amount=-950, status='待审批', change_type='退款'，含 operator/refund 字段 =====
    const sopInsert = calls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(c.sql)
    )
    expect(sopInsert).toBeDefined()
    expect(sopInsert.sql).toMatch(/'退款'/)
    expect(sopInsert.sql).toMatch(/'待审批'/)
    // 合并后参数顺序: [refSaleOrderId, -finalRefundAmount, refundPaymentMethod,
    //                  operatorEmployeeId, refundReason, refSaleItemId, sessionCount,
    //                  noteJson, now]
    expect(sopInsert.params[0]).toBe('FY-ORIG-001')
    expect(sopInsert.params[1]).toBe(-950)
    expect(sopInsert.params[2]).toBe('线下')
    expect(sopInsert.params[3]).toBe('emp-001')
    expect(sopInsert.params[4]).toBe('质量问题')
    expect(sopInsert.params[5]).toBe('item-001')
    expect(sopInsert.params[6]).toBe(1)
    const note = JSON.parse(sopInsert.params[7])
    expect(note._v).toBe(1)
    expect(note.handlingFee).toBe(50)
    expect(note.refundByCard).toBe(0)
    expect(note.refundByOrigin).toBe(950)
    expect(note.items).toHaveLength(1)
    expect(note.items[0].refSaleItemId).toBe('item-001')
    expect(note.items[0].productType).toBe('疗程卡')
  })

  test('全单退款（家居产品）— ref_sale_item_id 填首项，session_count 等于 quantity', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-PICK',
      items: [{ saleItemId: 'item-pick', refundQuantity: 3 }],
      refundReason: '未提货退款',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-PICK', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '1000',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-pick', product_type: '家居产品',
        quantity: 5, picked_up_quantity: 2,
        unit_real_price: '200', session_count: 0,
        product_name: 'X', sku_spec_name: 'S', sku_id: 'sku-pick',
        unit_price: '200', sales_category: '自销自耗', service_fee: '0',
      }])

    const { calls } = makeRefundTxnSpy({ paymentId: 1002 })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.totalAmount).toBe(-600)
    expect(ctx.result.finalRefundAmount).toBe(600)

    const sopInsert = calls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(c.sql)
    )
    expect(sopInsert.params[5]).toBe('item-pick')
    expect(sopInsert.params[6]).toBe(3)   // 退 3 件 → quantity → 写入 session_count
  })

  test('储值卡全额抵扣原单退款：refundByCard=金额、refundByOrigin=0、payment_method=无→线下', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-CARDONLY',
      items: [{ saleItemId: 'item-card', refundQuantity: 1 }],
      refundReason: '储值卡全额退',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-CARDONLY', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '无',
        prepaid_card_amount: '200', total_amount: '200',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-card', product_type: '疗程卡',
        remaining_sessions: 1, session_count: 1,
        unit_real_price: '200', quantity: 1, product_name: '储值卡商品',
        sku_spec_name: 'S', sku_id: 'sku-card', unit_price: '200',
        sales_category: '自销自耗', service_fee: '0',
      }])

    const { calls } = makeRefundTxnSpy({ paymentId: 1003 })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.refundByCard).toBe(200)
    expect(ctx.result.refundByOrigin).toBe(0)
    // resolveRefundPaymentMethod('无') → '线下'
    expect(ctx.result.refundPaymentMethod).toBe('线下')

    // 单行模型：仅 1 笔 sop INSERT，note JSON 持有 refundByCard/refundByOrigin
    const sopInserts = calls.filter(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(c.sql))
    expect(sopInserts).toHaveLength(1)
    expect(sopInserts[0].params[2]).toBe('线下')

    const note = JSON.parse(sopInserts[0].params[7])
    expect(note.refundByCard).toBe(200)
    expect(note.refundByOrigin).toBe(0)
    expect(note.refundPaymentMethod).toBe('线下')
  })

  test('微信原单退款：refundPaymentMethod 过渡期映射为线下', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-WX',
      items: [{ saleItemId: 'item-wx', refundQuantity: 1 }],
      refundReason: '微信原路退',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-WX', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '微信',
        prepaid_card_amount: '0', total_amount: '300',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-wx', product_type: '疗程卡',
        remaining_sessions: 1, session_count: 1,
        unit_real_price: '300', quantity: 1, product_name: 'X',
        sku_spec_name: 'S', sku_id: 'sku-wx', unit_price: '300',
        sales_category: '自销自耗', service_fee: '0',
      }])

    makeRefundTxnSpy({ paymentId: 1004 })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.refundPaymentMethod).toBe('线下')
  })

  test('partial unique 冲突：同原单存在 in-flight 退款 → CONFLICT', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-INF',
      items: [{ saleItemId: 'item-001', refundQuantity: 1 }],
      refundReason: '测试',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-INF', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '100',
      }])
      // in-flight 校验命中
      .mockResolvedValueOnce([{ id: 999 }])

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/CONFLICT.*未完结退款/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ refSaleOrderId: 'FY-001', items: [{}], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少原单号 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({ items: [{}], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*原销售单号/)
  })

  test('退款明细为空 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({ refSaleOrderId: 'FY-001', items: [], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*退款明细/)
  })

  test('refundReason 缺失 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({ refSaleOrderId: 'FY-001', items: [{}] })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*退款原因/)
  })

  test('原单不存在或非可退状态 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-NOEXIST', items: [{ saleItemId: 'i1' }], refundReason: 'x',
    })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*原订单/)
  })

  test('明细 ID 不在原单中 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', items: [{ saleItemId: 'item-wrong' }], refundReason: 'x',
    })
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '已支付', store_id: 'store-001',
        client_user_id: null, client_phone: '138', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '100',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', product_type: '疗程卡', remaining_sessions: 1,
        unit_real_price: '100', quantity: 1, sku_id: 'sku-001',
        product_name: 'X', sku_spec_name: 'S', unit_price: '100', sales_category: '自销自耗',
        service_fee: '0', session_count: 1,
      }])

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*item-wrong.*不存在/)
  })

  test('refundQuantity 缺失：疗程卡使用 remaining_sessions 兜底', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      items: [{ saleItemId: 'item-001' }],
      refundReason: '退全单',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-001', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '1500',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', product_type: '疗程卡',
        session_count: 3, remaining_sessions: 3,
        unit_price: '1000', unit_real_price: '500', quantity: 3,
        sku_id: 'sku-001', product_name: 'X', sku_spec_name: 'S',
        sales_category: '自销自耗', service_fee: '0',
      }])

    makeRefundTxnSpy({ paymentId: 1010 })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.totalAmount).toBe(-1500)   // 500 × 3
    expect(ctx.result.status).toBe('待审批')
  })

  test('handlingFee 缺失：fee=0、不扣手续费', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-002',
      items: [{ saleItemId: 'item-002', refundQuantity: 2 }],
      refundReason: '质量问题',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-002', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '微信',
        prepaid_card_amount: '0', total_amount: '1600',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-002', product_type: '家居产品',
        session_count: 0, picked_up_quantity: 0,
        unit_price: '800', unit_real_price: '800', quantity: 2,
        sku_id: 'sku-002', product_name: 'Y', sku_spec_name: 'S',
        sales_category: '自销自耗', service_fee: '0',
      }])

    makeRefundTxnSpy({ paymentId: 1011 })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.totalAmount).toBe(-1600)
    expect(ctx.result.finalRefundAmount).toBe(1600)
  })

  test('无可退项：unused=0 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-USED',
      items: [{ saleItemId: 'item-used', refundQuantity: 1 }],
      refundReason: '测试',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-USED', status: '已完成', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '500',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-used', product_type: '疗程卡',
        remaining_sessions: 0, session_count: 5,
        unit_real_price: '100', quantity: 1, sku_id: 'sku-used',
        product_name: 'X', sku_spec_name: 'S', unit_price: '100',
        sales_category: '自销自耗', service_fee: '0',
      }])

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_STATE.*item-used.*可退数量 0/)
  })

  test('家居产品超额退款 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-OVER',
      items: [{ saleItemId: 'item-over', refundQuantity: 10 }],
      refundReason: '过度退款',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-OVER', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '500',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-over', product_type: '家居产品',
        quantity: 5, picked_up_quantity: 0,
        unit_real_price: '100', session_count: 0,
        sku_id: 'sku-over', product_name: 'X', sku_spec_name: 'S',
        unit_price: '100', sales_category: '自销自耗', service_fee: '0',
      }])

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_STATE.*item-over.*可退数量 5 不足 10/)
  })

  test('handlingFee ≥ totalRefund → finalRefund=0 → INVALID_STATE 无可退项', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-FEE',
      items: [{ saleItemId: 'item-fee', refundQuantity: 1 }],
      refundReason: '手续费吃掉退款',
      handlingFee: 1000,   // 大于退款金额
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-FEE', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: '线下',
        prepaid_card_amount: '0', total_amount: '100',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-fee', product_type: '家居产品',
        quantity: 1, picked_up_quantity: 0,
        unit_real_price: '100', session_count: 0,
        sku_id: 'sku-fee', product_name: 'X', sku_spec_name: 'S',
        unit_price: '100', sales_category: '自销自耗', service_fee: '0',
      }])

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_STATE.*无可退项/)
  })
})

// ============================================================
// order.approveRefund — 2026-04-26 重写
// ============================================================
//   - 入参: { paymentId, auditRemark? }
//   - 流程（事务内）:
//     1) CAS UPDATE sale_order_payments SET status='已支付', paid_at=NOW
//        WHERE id=$1 AND status='待审批' → rowCount===1 校验（幂等哨兵）
//     2) INSERT/ON CONFLICT UPDATE spd 写 audit_employee_id / audit_at / audit_remark
//     3) UPDATE sale_orders SET refunded_amount = COALESCE + ABS(amount)
//     4) 储值卡通道：仅当 payment_method='储值卡' 时回冲 prepaid_cards
//     5) cascadeRefund(client, {saleOrderId, saleItemId, sessionCount, refundReason}) — 5 通道
//     6) refreshSpendingTier + recalcCustomerType + operation_logs
describe('order.approveRefund', () => {
  beforeEach(() => { vi.clearAllMocks() })

  /** 构造 sopRow（pg.query 第一次返回值，预查 sop+so+spd JOIN）*/
  function makeSopRow(overrides = {}) {
    return {
      id: 1001,
      sale_order_id: 'FY-ORIG-001',
      amount: '-500.00',
      status: '待审批',
      payment_method: '线下',
      store_id: 'store-001',
      client_user_id: 'cu-001',
      refund_reason: '质量问题',
      ref_sale_item_id: 'orig-item-1',
      session_count: 5,
      ...overrides,
    }
  }

  /**
   * 构造 approveRefund 的事务 client.query mock。
   * 默认所有 UPDATE rowCount=1（CAS 成功）。返回 { calls, fn } 便于断言。
   *
   * 关键 SQL 分支：
   *   - UPDATE sale_order_payments SET status='已支付', audit_employee_id=... → CAS 哨兵 + 写审批
   *   - UPDATE sale_orders SET refunded_amount = ... → 累加退款
   *   - SELECT 1 FROM card_transactions ... type='充值' → 储值卡幂等检查
   *   - INSERT INTO prepaid_cards ... RETURNING card_id → 储值卡回冲
   *   - INSERT INTO card_transactions ... → 流水
   *   - cascadeRefund 通道 1-5（已 mock 为 0 row）
   *   - SELECT customer_type FROM client_wechat_users → recalcCustomerType
   *   - INSERT INTO operation_logs → 审计
   */
  function makeApproveTxnSpy({
    casRowCount = 1,        // CAS 哨兵 UPDATE sop 的 rowCount
    cardDupExists = false,  // 储值卡幂等检查是否命中已有记录
    customerType = '会员客',
    cascadeItems = [],      // cascadeRefund 内部 SELECT sale_items 时返回
    cascadeGifts = [],      // cascadeRefund 通道4 原赠送流水（用于算 G=Σamount + user_id）
    orderReceived = 500,    // cascadeRefund 通道4 SELECT sale_orders.received（比例分母）
    orderRefunded = 500,    // cascadeRefund 通道4 累计 refunded_amount（默认=received=整单退）
  } = {}) {
    const calls = []
    const fn = vi.fn(async (sql, _params) => {
      calls.push({ sql, params: _params })

      // ========= approveRefund 主路径 =========
      // 1. CAS UPDATE sop status '待审批'→'已支付'（同条 UPDATE 写审批人/时间/备注）
      if (sql.includes('UPDATE sale_order_payments') &&
          sql.includes("SET status = '已支付'")) {
        return { rows: [], rowCount: casRowCount }
      }
      // 2. UPDATE sale_orders refunded_amount
      if (sql.includes('UPDATE sale_orders') && sql.includes('refunded_amount')) {
        return { rows: [], rowCount: 1 }
      }
      // 储值卡幂等检查
      if (sql.includes('FROM card_transactions') && /type\s*=\s*'充值'/.test(sql)) {
        return { rows: cardDupExists ? [{ '?column?': 1 }] : [], rowCount: cardDupExists ? 1 : 0 }
      }
      if (sql.includes('INSERT INTO prepaid_cards')) {
        return { rows: [{ card_id: 'card-001' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO card_transactions')) {
        return { rows: [], rowCount: 1 }
      }

      // ========= cascadeRefund 内部 =========
      // SELECT sale_item_id FROM sale_items（无 saleItemId 时全单 cascade）
      if (sql.includes('SELECT sale_item_id FROM sale_items')) {
        return { rows: cascadeItems, rowCount: cascadeItems.length }
      }
      // 通道 1-2: UPDATE sale_allocations / service_commissions
      if (sql.includes('UPDATE sale_allocations')) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE service_commissions')) {
        return { rows: [], rowCount: 0 }
      }
      // 通道 3: UPDATE user_coupons
      if (sql.includes('UPDATE user_coupons')) {
        return { rows: [], rowCount: 0 }
      }
      // 通道 4（目标态比例冲销）: SELECT G + user_id（整单原赠送总额）
      if (sql.includes('AS g') && sql.includes('FROM point_transactions')) {
        const g = cascadeGifts.reduce((s, r) => s + Number(r.amount), 0)
        const uid = cascadeGifts[0]?.user_id ?? null
        return { rows: [{ g, user_id: uid }], rowCount: 1 }
      }
      // 通道 4: SELECT received + refunded_amount FROM sale_orders（比例分母/分子）
      if (sql.includes('SELECT received') && sql.includes('refunded') &&
          sql.includes('FROM sale_orders')) {
        return { rows: [{ received: orderReceived, refunded: orderRefunded }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO point_transactions')) {
        // 通道 4 单笔目标态冲销（ON CONFLICT DO UPDATE）
        return { rows: [{ id: 9999 }], rowCount: 1 }
      }
      if (sql.includes('UPDATE client_wechat_users') && sql.includes('points_balance')) {
        return { rows: [], rowCount: 1 }
      }
      // 通道 5: pickup
      if (sql.includes('UPDATE sale_items') && sql.includes('picked_up_quantity')) {
        return { rows: [], rowCount: 0 }
      }

      // ========= refreshSpendingTier / recalcCustomerType =========
      if (sql.includes('SET spending_tier')) {
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
        return { rows: [{ customer_type: customerType }], rowCount: 1 }
      }
      // recalcCustomerType inner SELECT CASE
      if (sql.includes('WHEN EXISTS') && sql.includes('FROM sale_orders')) {
        return { rows: [{ result: '会员客' }], rowCount: 1 }
      }
      if (sql.includes('UPDATE client_wechat_users') && sql.includes('customer_type')) {
        return { rows: [], rowCount: 1 }
      }

      // operation_logs
      if (sql.includes('INSERT INTO operation_logs')) {
        return { rows: [], rowCount: 1 }
      }

      return defaultQueryResult(sql)
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: fn }))
    return { calls, fn }
  }

  test('审批退款成功（线下原通道、不回冲储值卡）', async () => {
    const ctx = createManagerCtx({ paymentId: 1001, auditRemark: '同意退款' })

    pg.query.mockResolvedValueOnce([makeSopRow({ payment_method: '线下', amount: '-500' })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    expect(ctx.result.paymentId).toBe(1001)
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.refundAbs).toBe(500)
    expect(ctx.result.saleOrderId).toBe('FY-ORIG-001')
    expect(ctx.result.message).toMatch(/审批通过/)

    // CAS 哨兵 UPDATE sop（合并后参数顺序: [now, staffWfId, auditRemark, paymentId]）
    const casUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_order_payments') &&
      c.sql.includes("SET status = '已支付'") &&
      c.sql.includes("AND status = '待审批'")
    )
    expect(casUpdate).toBeDefined()
    expect(casUpdate.params[1]).toBe('emp-001')
    expect(casUpdate.params[2]).toBe('同意退款')
    expect(casUpdate.params[3]).toBe(1001)

    // refunded_amount 累加
    const refundedUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_orders') && c.sql.includes('refunded_amount')
    )
    expect(refundedUpdate).toBeDefined()
    expect(refundedUpdate.params[0]).toBe(500)
    expect(refundedUpdate.params[2]).toBe('FY-ORIG-001')

    // 非储值卡通道，不应触发 card_transactions / prepaid_cards 写入
    expect(calls.find(c => c.sql.includes('INSERT INTO prepaid_cards'))).toBeUndefined()

    // operation_logs 写审计（helper 参数布局：[7]=targetId）
    const log = calls.find(c => c.sql.includes('INSERT INTO operation_logs'))
    expect(log).toBeDefined()
    expect(log.params[7]).toBe('1001')
  })

  test('CAS 幂等哨兵：状态已变更（rowCount=0）→ INVALID_STATE', async () => {
    const ctx = createManagerCtx({ paymentId: 1001 })

    // 注意：源码先用 pg.query 预查 status，必须返回 status='待审批' 才会进入事务；
    // CAS 失败要发生在事务内（并发场景）
    pg.query.mockResolvedValueOnce([makeSopRow({ status: '待审批' })])

    makeApproveTxnSpy({ casRowCount: 0 })

    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/INVALID_STATE.*状态已变更/)
  })

  test('预查阶段状态非待审批 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({ paymentId: 1001 })
    pg.query.mockResolvedValueOnce([makeSopRow({ status: '已支付' })])

    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/INVALID_STATE.*不是待审批/)
  })

  test('退款流水不存在 → NOT_FOUND', async () => {
    const ctx = createManagerCtx({ paymentId: 9999 })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/NOT_FOUND.*退款流水不存在/)
  })

  test('跨店审批 → PERMISSION_DENIED', async () => {
    const ctx = createManagerCtx({ paymentId: 1001 })
    pg.query.mockResolvedValueOnce([makeSopRow({ store_id: 'store-OTHER' })])
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED.*订单不在当前门店范围内/)
  })

  test('缺少 paymentId → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*paymentId/)
  })

  test('非店长 → PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ paymentId: 1001 })
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('储值卡通道：payment_method=储值卡 → 回冲 prepaid_cards + 写 card_transactions(充值)', async () => {
    const ctx = createManagerCtx({ paymentId: 1002 })
    pg.query.mockResolvedValueOnce([makeSopRow({
      id: 1002, payment_method: '储值卡', amount: '-300', client_user_id: 'cu-001',
    })])

    const { calls } = makeApproveTxnSpy({ cardDupExists: false })

    await orderRoutes.approveRefund(ctx)

    expect(ctx.result.status).toBe('已支付')

    // UPSERT prepaid_cards（amount=300 → user_id='cu-001'）
    const upsert = calls.find(c => c.sql.includes('INSERT INTO prepaid_cards'))
    expect(upsert).toBeDefined()
    expect(upsert.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/)
    expect(upsert.params[1]).toBe('cu-001')
    expect(upsert.params[2]).toBe(300)

    // INSERT card_transactions(type='充值', ref_order_id='SOP-1002')
    const txn = calls.find(c => c.sql.includes('INSERT INTO card_transactions'))
    expect(txn).toBeDefined()
    expect(txn.sql).toMatch(/'充值'/)
    expect(txn.params[1]).toBe(300)
    expect(txn.params[2]).toBe('SOP-1002')
  })

  test('储值卡幂等：card_transactions 已有 SOP-{id} 充值行 → 不重复写卡', async () => {
    const ctx = createManagerCtx({ paymentId: 1003 })
    pg.query.mockResolvedValueOnce([makeSopRow({
      id: 1003, payment_method: '储值卡', amount: '-100', client_user_id: 'cu-001',
    })])

    const { calls } = makeApproveTxnSpy({ cardDupExists: true })

    await orderRoutes.approveRefund(ctx)

    // 应跳过 INSERT prepaid_cards / INSERT card_transactions
    expect(calls.find(c => c.sql.includes('INSERT INTO prepaid_cards'))).toBeUndefined()
    expect(calls.find(c => c.sql.includes('INSERT INTO card_transactions'))).toBeUndefined()
  })

  test('5 通道 cascade — 通道 1（sale_allocations 软删）SQL 出现', async () => {
    const ctx = createManagerCtx({ paymentId: 1004 })
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1004 })])

    const { calls } = makeApproveTxnSpy({
      cascadeItems: [{ sale_item_id: 'item-A' }, { sale_item_id: 'item-B' }],
    })

    await orderRoutes.approveRefund(ctx)

    // 通道 1: UPDATE sale_allocations
    const allocUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_allocations') && c.sql.includes('is_void = true')
    )
    // 注意：源码当传入 saleItemId 时 itemIds=[saleItemId]，否则按订单全行查询
    // 这里 sopRow.ref_sale_item_id='orig-item-1' 走单行分支
    expect(allocUpdate).toBeDefined()
    expect(allocUpdate.params[1]).toEqual(['orig-item-1'])
  })

  test('5 通道 cascade — 通道 2（service_commissions 软删 with voided_reason）', async () => {
    const ctx = createManagerCtx({ paymentId: 1005 })
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1005, refund_reason: '过敏' })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    const commUpdate = calls.find(c =>
      c.sql.includes('UPDATE service_commissions') && c.sql.includes('voided_reason')
    )
    expect(commUpdate).toBeDefined()
    // params[1] 应为 voidedReason 字符串
    expect(commUpdate.params[1]).toMatch(/退款审批通过.*过敏/)
  })

  test('5 通道 cascade — 通道 3（整单退款：user_coupons 回滚到未使用）', async () => {
    const ctx = createManagerCtx({ paymentId: 1006 })
    // ref_sale_item_id=null → 整单退款，券才回滚（部分退款不退券）
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1006, ref_sale_item_id: null })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    const couponUpdate = calls.find(c =>
      c.sql.includes('UPDATE user_coupons') && c.sql.includes("status = '未使用'")
    )
    expect(couponUpdate).toBeDefined()
    expect(couponUpdate.params[0]).toBe('FY-ORIG-001')
  })

  test('5 通道 cascade — 通道 3（部分退款：跳过 user_coupons，不退券）', async () => {
    const ctx = createManagerCtx({ paymentId: 1006 })
    // ref_sale_item_id 非 null → 部分退款，券挂订单维度无法精确到行，跳过
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1006, ref_sale_item_id: 'orig-item-1' })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    const couponUpdate = calls.find(c => c.sql.includes('UPDATE user_coupons'))
    expect(couponUpdate).toBeUndefined()
  })

  test('5 通道 cascade — 通道 4（整单退款：积分全额冲销 + balance 重算）', async () => {
    const ctx = createManagerCtx({ paymentId: 1007 })
    // 整单退款（ref_sale_item_id=null）+ refunded=received=500 → 比例=1 → 全额冲销 G=150
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1007, client_user_id: 'cu-001', ref_sale_item_id: null })])

    const { calls } = makeApproveTxnSpy({
      cascadeGifts: [
        { id: 1, user_id: 'cu-001', type: '消费赠送', amount: 100 },
        { id: 2, user_id: 'cu-001', type: '回款赠送', amount: 50 },
      ],
      orderReceived: 500,
      orderRefunded: 500,
    })

    await orderRoutes.approveRefund(ctx)

    // 单笔目标态冲销：amount = -round(G × refunded/received) = -round(150×500/500) = -150
    const reverseInserts = calls.filter(c =>
      c.sql.includes('INSERT INTO point_transactions') &&
      c.sql.includes("'消费冲销'")
    )
    expect(reverseInserts.length).toBe(1)
    expect(reverseInserts[0].params[2]).toBe(-150)

    // balance 重算
    const balanceUpdate = calls.find(c =>
      c.sql.includes('UPDATE client_wechat_users') && c.sql.includes('points_balance')
    )
    expect(balanceUpdate).toBeDefined()
  })

  test('5 通道 cascade — 通道 4（部分退款：积分按比例冲销）', async () => {
    const ctx = createManagerCtx({ paymentId: 1007 })
    // 部分退款：整单实收 1000、累计已退 200 → 比例 0.2 → 冲销 round(150×200/1000)=30
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1007, client_user_id: 'cu-001', ref_sale_item_id: 'orig-item-1' })])

    const { calls } = makeApproveTxnSpy({
      cascadeGifts: [
        { id: 1, user_id: 'cu-001', type: '消费赠送', amount: 100 },
        { id: 2, user_id: 'cu-001', type: '回款赠送', amount: 50 },
      ],
      orderReceived: 1000,
      orderRefunded: 200,
    })

    await orderRoutes.approveRefund(ctx)

    const reverseInserts = calls.filter(c =>
      c.sql.includes('INSERT INTO point_transactions') &&
      c.sql.includes("'消费冲销'")
    )
    expect(reverseInserts.length).toBe(1)
    expect(reverseInserts[0].params[2]).toBe(-30)
  })

  test('5 通道 cascade — 通道 5（pickup_records 反推家居产品 picked_up_quantity）', async () => {
    const ctx = createManagerCtx({ paymentId: 1008 })
    // ref_sale_item_id + sessionCount=2 触发 pickup 反推
    pg.query.mockResolvedValueOnce([makeSopRow({
      id: 1008, ref_sale_item_id: 'item-pickup', session_count: 2,
    })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    const pickupUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_items') &&
      c.sql.includes('picked_up_quantity') &&
      c.sql.includes("product_type = '家居产品'")
    )
    expect(pickupUpdate).toBeDefined()
    expect(pickupUpdate.params[0]).toBe(2)
    expect(pickupUpdate.params[2]).toBe('item-pickup')
  })

  test('refunded_amount 累加（多次部分退款场景：amount=200，累加 200）', async () => {
    const ctx = createManagerCtx({ paymentId: 1009 })
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1009, amount: '-200.00' })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    expect(ctx.result.refundAbs).toBe(200)
    const refundedUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_orders') && c.sql.includes('refunded_amount')
    )
    // SET refunded_amount = COALESCE(refunded_amount, 0) + $1
    expect(refundedUpdate.params[0]).toBe(200)
  })

  test('operation_logs 写审计：action / target_type / detail.cascade', async () => {
    const ctx = createManagerCtx({ paymentId: 1010, auditRemark: 'OK' })
    pg.query.mockResolvedValueOnce([makeSopRow({ id: 1010 })])

    const { calls } = makeApproveTxnSpy()

    await orderRoutes.approveRefund(ctx)

    // helper 参数布局：[5]=action, [6]=targetType, [7]=targetId, [8]=detail
    const log = calls.find(c => c.sql.includes('INSERT INTO operation_logs'))
    expect(log).toBeDefined()
    expect(log.params[5]).toBe('order.approveRefund')
    expect(log.params[6]).toBe('sale_order_payment')
    expect(log.params[7]).toBe('1010')
    const detail = JSON.parse(log.params[8])
    expect(detail.saleOrderId).toBe('FY-ORIG-001')
    expect(detail.refundAbs).toBe(500)
    expect(detail).toHaveProperty('cascade')
  })
})

// ============================================================
// order.rejectRefund — 2026-04-26 重写
// ============================================================
//   - 入参: { paymentId, auditRemark } （rejectedReason 兼容字段）
//   - 流程（事务内）:
//     1) CAS UPDATE sale_order_payments SET status='已作废' WHERE id=$1 AND status='待审批'
//        → rowCount===1 校验（幂等哨兵）
//     2) INSERT/ON CONFLICT spd 写 audit_employee_id / audit_at / audit_remark
//     3) INSERT operation_logs（仅状态翻转，不触发 cascadeRefund）
describe('order.rejectRefund', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function makeSopRowReject(overrides = {}) {
    return {
      id: 2001,
      sale_order_id: 'FY-ORIG-001',
      status: '待审批',
      store_id: 'store-001',
      ...overrides,
    }
  }

  function makeRejectTxnSpy({ casRowCount = 1 } = {}) {
    const calls = []
    const fn = vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('UPDATE sale_order_payments') &&
          sql.includes("SET status = '已作废'")) {
        return { rows: [], rowCount: casRowCount }
      }
      if (sql.includes('INSERT INTO operation_logs')) {
        return { rows: [], rowCount: 1 }
      }
      return defaultQueryResult(sql)
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: fn }))
    return { calls, fn }
  }

  test('驳回退款成功（auditRemark 字段）— 单条 UPDATE 翻转状态 + 写审批信息', async () => {
    const ctx = createManagerCtx({ paymentId: 2001, auditRemark: '不符合条件' })
    pg.query.mockResolvedValueOnce([makeSopRowReject()])

    const { calls } = makeRejectTxnSpy()

    await orderRoutes.rejectRefund(ctx)

    expect(ctx.result.paymentId).toBe(2001)
    expect(ctx.result.status).toBe('已作废')
    expect(ctx.result.message).toBe('退款已驳回')

    // 合并后：单条 CAS UPDATE 同时翻转状态 + 写 audit_employee_id / audit_at / audit_remark
    const casUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_order_payments') &&
      c.sql.includes("SET status = '已作废'") &&
      c.sql.includes("AND status = '待审批'")
    )
    expect(casUpdate).toBeDefined()
    // 参数顺序: [staffWfId, now, remark, paymentId]
    expect(casUpdate.params[0]).toBe('emp-001')
    expect(casUpdate.params[2]).toBe('不符合条件')
    expect(casUpdate.params[3]).toBe(2001)
  })

  test('驳回退款 — 兼容旧字段 rejectedReason', async () => {
    const ctx = createManagerCtx({ paymentId: 2002, rejectedReason: '老前端字段' })
    pg.query.mockResolvedValueOnce([makeSopRowReject({ id: 2002 })])

    const { calls } = makeRejectTxnSpy()

    await orderRoutes.rejectRefund(ctx)

    const casUpdate = calls.find(c =>
      c.sql.includes('UPDATE sale_order_payments') &&
      c.sql.includes("SET status = '已作废'")
    )
    expect(casUpdate.params[2]).toBe('老前端字段')
  })

  test('CAS 幂等哨兵：状态已变更（rowCount=0）→ INVALID_STATE', async () => {
    const ctx = createManagerCtx({ paymentId: 2003, auditRemark: '驳回' })
    pg.query.mockResolvedValueOnce([makeSopRowReject({ id: 2003 })])

    makeRejectTxnSpy({ casRowCount: 0 })

    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/INVALID_STATE.*状态已变更/)
  })

  test('预查阶段状态非待审批 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({ paymentId: 2004, auditRemark: 'X' })
    pg.query.mockResolvedValueOnce([makeSopRowReject({ id: 2004, status: '已支付' })])
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/INVALID_STATE.*不是待审批/)
  })

  test('退款流水不存在 → NOT_FOUND', async () => {
    const ctx = createManagerCtx({ paymentId: 99999, auditRemark: 'X' })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/NOT_FOUND.*退款流水不存在/)
  })

  test('跨店驳回 → PERMISSION_DENIED', async () => {
    const ctx = createManagerCtx({ paymentId: 2005, auditRemark: 'X' })
    pg.query.mockResolvedValueOnce([makeSopRowReject({ id: 2005, store_id: 'store-OTHER' })])
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED.*订单不在当前门店范围内/)
  })

  test('缺少 paymentId → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({ auditRemark: 'X' })
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*paymentId/)
  })

  test('非店长 → PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ paymentId: 2001 })
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('不触发 cascadeRefund — 仅状态翻转 + spd 写审批 + operation_logs', async () => {
    const ctx = createManagerCtx({ paymentId: 2006, auditRemark: 'X' })
    pg.query.mockResolvedValueOnce([makeSopRowReject({ id: 2006 })])

    const { calls } = makeRejectTxnSpy()

    await orderRoutes.rejectRefund(ctx)

    // 不应触发 cascade 任意通道
    expect(calls.find(c => c.sql.includes('UPDATE sale_allocations'))).toBeUndefined()
    expect(calls.find(c => c.sql.includes('UPDATE service_commissions'))).toBeUndefined()
    expect(calls.find(c => c.sql.includes('UPDATE user_coupons'))).toBeUndefined()
    expect(calls.find(c => c.sql.includes('INSERT INTO point_transactions'))).toBeUndefined()
    expect(calls.find(c => c.sql.includes('INSERT INTO prepaid_cards'))).toBeUndefined()
    // 不累加 refunded_amount
    expect(calls.find(c =>
      c.sql.includes('UPDATE sale_orders') && c.sql.includes('refunded_amount')
    )).toBeUndefined()

    // operation_logs 写 rejectRefund（helper 参数布局：[5]=action）
    const log = calls.find(c => c.sql.includes('INSERT INTO operation_logs'))
    expect(log).toBeDefined()
    expect(log.params[5]).toBe('order.rejectRefund')
  })
})

// ============================================================
// order.createRepayment（Ticket 2 PR-A：多次回款 payments 双写）
// ============================================================
describe('order.createRepayment', () => {
  beforeEach(() => { vi.clearAllMocks() })

  /**
   * 构造回款场景的 pg.transaction mock。
   * @param origOrder 原单锁 FOR UPDATE 返回的单行（total_amount/paid_amount/status...）
   * @param options  { newPaid, newPrepaid, lockedBalance }
   */
  function mockRepayTxn(origOrder, options = {}) {
    const txCalls = []
    const {
      newPaid = 0,
      newPrepaid = 0,
      lockedBalance = null,
    } = options

    // 2026-04-26 sale-order-domain-refactor: 源码读 origOrder.received（旧 paid_amount 字段已删）
    // 兼容旧测试 mock 写 paid_amount 时同步映射给 received。
    const adaptedOrigOrder = {
      ...origOrder,
      received: origOrder.received != null ? origOrder.received : origOrder.paid_amount,
      refunded_amount: origOrder.refunded_amount != null ? origOrder.refunded_amount : '0',
    }
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txCalls.push({ sql, params })
          // generateOrderNo 子事务（advisory_xact_lock 后 SELECT sale_order_id LIKE）
          if (sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 1 }
          }
          if (sql.includes('FROM sale_orders') && sql.includes('LIKE $1')) {
            return { rows: [], rowCount: 0 }
          }
          // 主事务 1: 锁原单 FOR UPDATE
          if (sql.includes('FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE')) {
            return { rows: [adaptedOrigOrder], rowCount: 1 }
          }
          // 主事务 2: 锁储值卡
          if (sql.includes('FROM prepaid_cards') && sql.includes('FOR UPDATE')) {
            if (!lockedBalance) return { rows: [], rowCount: 0 }
            return { rows: [{ card_id: 'card-001', balance: String(lockedBalance) }], rowCount: 1 }
          }
          // SUM payments 重算
          // 2026-04-26 sale-order-domain-refactor: source 列 new_paid → new_received
          if (sql.includes('FROM sale_order_payments') && sql.includes('SUM')) {
            return { rows: [{ new_received: String(newPaid), new_prepaid: String(newPrepaid) }], rowCount: 1 }
          }
          // 顾客类型重算
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })
    return txCalls
  }

  test('部分支付单全额回款 → 原单翻 已支付 + payments 行 change_type=回款', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      repayAmount: 100,
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-001', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: '张三',
    }])

    const txCalls = mockRepayTxn({
      sale_order_id: 'FY-ORIG-001',
      status: '部分支付',
      total_amount: '200',
      paid_amount: '100',
      prepaid_card_amount: '0',
      payable_amount: '200',
      client_user_id: 'cu-001',
      client_phone: '138',
      customer_name: '张三',
      document_type: null,
    }, { newPaid: 200, newPrepaid: 0 })

    await orderRoutes.createRepayment(ctx)

    expect(ctx.result.refStatus).toBe('已支付')
    expect(ctx.result.refReceived).toBe(200)
    expect(ctx.result.repayAmount).toBe(100)
    // 2026-04-26 sale-order-domain-refactor: 不再创建 sale_orders[type='回款单'] 单据；
    // repaymentOrderId 兼容字段保留为 null。原 FY-HKD-WX- 编号语义已废弃。
    expect(ctx.result.repaymentOrderId).toBeNull()
    // payments 写入断言
    const insertPayment = txCalls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && c.sql.includes("'回款'"))
    expect(insertPayment).toBeDefined()
    expect(Number(insertPayment.params[1])).toBe(100)  // amount
    // 原单 UPDATE 至 '已支付' — UPDATE SET 含 received（原 paid_amount 已 DROP）
    const updateOrig = txCalls.find(c =>
      c.sql.includes('UPDATE sale_orders') && c.sql.includes('received') && c.sql.includes('AND status = $7'))
    expect(updateOrig).toBeDefined()
    expect(updateOrig.params[0]).toBe('已支付')
  })

  test('多次部分回款：首次 50 保持部分支付，次次 150 翻 已支付', async () => {
    // 第一次回款（payable=300/paid=100 → 回 50）
    const ctx1 = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-002', repayAmount: 50, paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-002', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: '李四',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-ORIG-002', status: '部分支付',
      total_amount: '300', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '300', client_user_id: 'cu-001',
    }, { newPaid: 150, newPrepaid: 0 })

    await orderRoutes.createRepayment(ctx1)
    expect(ctx1.result.refStatus).toBe('部分支付')
    expect(ctx1.result.refReceived).toBe(150)

    // 第二次回款（payable=300/paid=150 → 回 150）
    vi.clearAllMocks()
    const ctx2 = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-002', repayAmount: 150, paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-002', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: '李四',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-ORIG-002', status: '部分支付',
      total_amount: '300', paid_amount: '150', prepaid_card_amount: '0',
      payable_amount: '300', client_user_id: 'cu-001',
    }, { newPaid: 300, newPrepaid: 0 })

    await orderRoutes.createRepayment(ctx2)
    expect(ctx2.result.refStatus).toBe('已支付')
    expect(ctx2.result.refReceived).toBe(300)
  })

  test('超额回款拦截 → INVALID_PARAMS:OVERPAY', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-003', repayAmount: 150, paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-003', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: 'C',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-ORIG-003', status: '部分支付',
      total_amount: '200', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '200', client_user_id: 'cu-001',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/本次回款金额超过订单欠款/)
  })

  test('已关闭订单防回款 → INVALID_STATE', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-CLOSED-001', repayAmount: 50, paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-CLOSED-001', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: 'C',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-CLOSED-001', status: '已关闭',
      total_amount: '200', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '200', client_user_id: 'cu-001',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_STATE/)
  })

  test('纯储值卡回款：repayAmount=0 + prepaidCardAmount=100 扣卡 + payments 写储值卡抵扣行', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-004',
      repayAmount: 0,
      prepaidCardAmount: 100,
      paymentMethod: '储值卡',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-004', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: 'C',
    }])
    const txCalls = mockRepayTxn({
      sale_order_id: 'FY-ORIG-004', status: '部分支付',
      total_amount: '200', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '200', client_user_id: 'cu-001',
    // 2026-04-26 sale-order-domain-refactor: received = Σ(首次支付+回款+储值卡抵扣)，
    // 储值卡 100 进入 received，所以 newReceived = 100(原首次支付) + 100(本次储值卡抵扣) = 200
    }, { newPaid: 200, newPrepaid: 100, lockedBalance: '150' })

    await orderRoutes.createRepayment(ctx)

    expect(ctx.result.refStatus).toBe('已支付')
    expect(ctx.result.prepaidCardAmount).toBe(100)
    // 扣卡 SQL
    const deduct = txCalls.find(c =>
      c.sql.includes('UPDATE prepaid_cards') && c.sql.includes('balance = balance -'))
    expect(deduct).toBeDefined()
    expect(Number(deduct.params[0])).toBe(100)
    // card_transactions 写入
    const cardTxn = txCalls.find(c =>
      c.sql.includes('INSERT INTO card_transactions') && c.sql.includes("'扣款'"))
    expect(cardTxn).toBeDefined()
    // payments 写入 储值卡抵扣 行
    const paymentRow = txCalls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && c.sql.includes("'储值卡抵扣'"))
    expect(paymentRow).toBeDefined()
    expect(Number(paymentRow.params[1])).toBe(100)
  })

  test('储值卡余额不足拒绝 → INSUFFICIENT_BALANCE', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-005',
      repayAmount: 0,
      prepaidCardAmount: 200,
      paymentMethod: '储值卡',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-005', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: 'C',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-ORIG-005', status: '部分支付',
      total_amount: '400', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '400', client_user_id: 'cu-001',
    }, { lockedBalance: '100' })

    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('微信支付方式暂未实现', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', repayAmount: 100, paymentMethod: '微信',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/微信扫码回款暂未开放/)
  })

  test('缺少原单号拒绝', async () => {
    const ctx = createManagerCtx({ repayAmount: 100, paymentMethod: '线下' })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_PARAMS.*原销售单号/)
  })

  test('回款金额 = 0 且无储值卡抵扣时拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', repayAmount: 0, paymentMethod: '线下',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_PARAMS.*回款金额/)
  })

  test('非法的支付方式拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', repayAmount: 100, paymentMethod: '奇葩',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_PARAMS.*支付方式/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({
      refSaleOrderId: 'FY-001', repayAmount: 100, paymentMethod: '线下',
    })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('items 旧签名兼容 → 合计推导 repayAmount', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-006',
      items: [{ saleItemId: 'i1', repayAmount: 60 }, { saleItemId: 'i2', repayAmount: 40 }],
      paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-ORIG-006', store_id: 'store-001',
      client_user_id: 'cu-001', client_phone: '138', customer_name: 'C',
    }])
    mockRepayTxn({
      sale_order_id: 'FY-ORIG-006', status: '部分支付',
      total_amount: '200', paid_amount: '100', prepaid_card_amount: '0',
      payable_amount: '200', client_user_id: 'cu-001',
    }, { newPaid: 200, newPrepaid: 0 })

    await orderRoutes.createRepayment(ctx)
    expect(ctx.result.repayAmount).toBe(100)
    expect(ctx.result.refStatus).toBe('已支付')
  })
})

// ============================================================
// order.createConversion
// ============================================================
// commit 977237c 重构 createConversion 入参（convertOutSaleItemIds: string[] 整张卡折抵 +
// 新增 clientUserId/paymentMethod 必填 + 差额负数充值储值卡）。下列测试已按新 API 重写。
describe('order.createConversion', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('创建转换单成功（差额>0 → 待支付，新 API 入参）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-001'],
      convertInItems: [{ skuId: 'sku-new', quantity: 10 }],
      paymentMethod: '线下',
    })

    // 1) 查 client（路由顶层 pg.query）
    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '张三', customer_type: '会员客', bound_store_id: 'store-001',
    }])
    // 2) 单一主事务：generateOrderNo（advisory lock + SELECT sale_order_id LIKE）+ 主流程
    pg.transaction.mockImplementationOnce(async (cb) => {
      const tx = {
        query: vi.fn()
          // generateOrderNo: advisory_xact_lock(hashtext('sale_order_id_gen'))
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // generateOrderNo: SELECT sale_order_id FROM sale_orders WHERE LIKE → seq=1
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          // SELECT held items（FOR UPDATE）— 余 1 次（整张卡折抵 → totalOut=1000）
          .mockResolvedValueOnce({
            rows: [{
              sale_item_id: 'item-001', store_id: 'store-001', item_direction: '购买',
              sku_id: 'sku-old', product_name: '旧项目', sku_spec_name: '标准',
              product_type: '疗程卡', session_count: 1, remaining_sessions: 1,
              quantity: 1, picked_up_quantity: 0,
              unit_price: '1000', unit_real_price: '1000',
              sales_category: '自销自耗', service_fee: '0',
              client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
            }], rowCount: 1,
          })
          // 转入 SKU 查询（quantity=10 → totalIn=15000）
          .mockResolvedValueOnce({
            rows: [{
              sku_id: 'sku-new', product_type: '疗程卡', spec_name: '高级款',
              price: '1500', session_count: 10, service_fee: '0', sales_category: '自销自耗',
            }], rowCount: 1,
          })
          // INSERT sale_orders
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // SELECT max sale_item_id
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          // INSERT 转出行
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // UPDATE remaining_sessions（疗程卡）
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // INSERT 转入行
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
      }
      return await cb(tx)
    })

    await orderRoutes.createConversion(ctx)

    // totalOut=1000*1=1000, totalIn=1500*10=15000, priceDiff=14000
    expect(ctx.result.priceDiff).toBe(14000)
    expect(ctx.result.status).toBe('待支付') // priceDiff>0 + 线下
    expect(ctx.result.message).toContain('转换单已创建')
  })

  test('缺少 clientUserId 拒绝', async () => {
    const ctx = createManagerCtx({
      convertOutSaleItemIds: ['i1'],
      convertInItems: [{ skuId: 'sku-1' }],
      paymentMethod: '线下',
    })
    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('转出项目为空拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: [],
      convertInItems: [{ skuId: 'sku-1' }],
      paymentMethod: '线下',
    })
    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*折抵卡/)
  })

  test('转入项目为空拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['i1'],
      convertInItems: [],
      paymentMethod: '线下',
    })
    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*转入/)
  })

  test('paymentMethod 非法拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['i1'],
      convertInItems: [{ skuId: 'sku-1' }],
      paymentMethod: '非法',
    })
    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*支付方式仅支持/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['i1'],
      convertInItems: [{ skuId: 'sku-1' }],
      paymentMethod: '线下',
    })
    await expect(orderRoutes.createConversion(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  // ===== D2.1 差额=0 路径 =====
  test('创建转换单成功（差额=0 → 已支付 + prepaidCardCredit=0）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-eq-001'],
      convertInItems: [{ skuId: 'sku-eq-new', quantity: 2 }],
      paymentMethod: '线下',
    })

    // 1) 查 client
    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '李四', customer_type: '会员客', bound_store_id: 'store-001',
    }])
    // 2) 单一主事务（totalOut=500×2=1000, totalIn=500×2=1000 → priceDiff=0）
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // generateOrderNo: advisory_xact_lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // generateOrderNo: SELECT sale_order_id LIKE
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-eq-001', store_id: 'store-001', item_direction: '购买',
          sku_id: 'sku-eq-old', product_name: '旧项目', sku_spec_name: '标准',
          product_type: '疗程卡', session_count: 2, remaining_sessions: 2,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '500', unit_real_price: '500',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          sku_id: 'sku-eq-new', product_type: '疗程卡', spec_name: '同价款',
          price: '500', session_count: 10, service_fee: '0', sales_category: '自销自耗',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT sale_orders
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT max sale_item_id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转出行
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE remaining_sessions
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转入行
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await orderRoutes.createConversion(ctx)

    expect(ctx.result.priceDiff).toBe(0)
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.prepaidCardCredit).toBe(0)
    // 不应有 prepaid_cards / card_transactions 相关 SQL
    const allSql = txQuery.mock.calls.map(c => c[0]).join('\n')
    expect(allSql).not.toMatch(/INSERT INTO prepaid_cards/)
    expect(allSql).not.toMatch(/INSERT INTO card_transactions/)
  })

  // ===== D2.2 差额<0 路径（UPSERT 储值卡 + 充值流水） =====
  test('创建转换单成功（差额<0 → UPSERT prepaid_cards + INSERT card_transactions）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-neg-001'],
      convertInItems: [{ skuId: 'sku-neg-new', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '王五', customer_type: '会员客', bound_store_id: 'store-001',
    }])

    // 单一主事务 totalOut=1000×2=2000, totalIn=500×1=500 → priceDiff=-1500
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // generateOrderNo: advisory_xact_lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // generateOrderNo: SELECT sale_order_id LIKE
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-neg-001', store_id: 'store-001', item_direction: '购买',
          sku_id: 'sku-neg-old', product_name: '高价旧项目', sku_spec_name: '2次卡',
          product_type: '疗程卡', session_count: 2, remaining_sessions: 2,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '1000', unit_real_price: '1000',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          sku_id: 'sku-neg-new', product_type: '疗程卡', spec_name: '低价款',
          price: '500', session_count: 5, service_fee: '0', sales_category: '自销自耗',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT sale_orders
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT max sale_item_id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转出行
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE remaining_sessions
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转入行
      // UPSERT prepaid_cards → RETURNING card_id
      .mockResolvedValueOnce({ rows: [{ card_id: 'card-credit-001' }], rowCount: 1 })
      // INSERT card_transactions
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await orderRoutes.createConversion(ctx)

    expect(ctx.result.priceDiff).toBe(-1500)
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.prepaidCardCredit).toBe(1500)

    // 断言序列：第 9 次（index 8）为 UPSERT prepaid_cards，第 10 次（index 9）为 INSERT card_transactions
    // 2026-04-24 schema 变更：UNIQUE(user_id)，一户一账户；INSERT 列集不含 store_id
    // 注：advisory lock + SELECT sale_order_id LIKE 占据 txQuery.mock.calls[0..1]，业务调用顺移 +1
    const upsertCall = txQuery.mock.calls.find(c => /INSERT INTO prepaid_cards/.test(c[0]))
    expect(upsertCall).toBeDefined()
    expect(upsertCall[0]).toMatch(/INSERT INTO prepaid_cards/)
    expect(upsertCall[0]).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/)
    expect(upsertCall[0]).not.toMatch(/store_id/)
    expect(upsertCall[0]).toMatch(/RETURNING card_id/)
    // 参数：clientUserId, amount（无 storeId）
    expect(upsertCall[1][0]).toBe('cu-001')
    expect(upsertCall[1][1]).toBe('1500.00')

    const txnCall = txQuery.mock.calls.find(c => /INSERT INTO card_transactions/.test(c[0]))
    expect(txnCall).toBeDefined()
    expect(txnCall[0]).toMatch(/INSERT INTO card_transactions/)
    expect(txnCall[0]).toMatch(/'充值'/)
    // 参数：cardId, amount, refOrderId
    expect(txnCall[1][0]).toBe('card-credit-001')
    expect(txnCall[1][1]).toBe('1500.00')
    expect(txnCall[1][2]).toMatch(/^FY-XSD-WX-/)
  })

  // ===== D2.3 三种拒绝路径 =====
  test('拒绝：跨店卡（held.store_id !== ctx.auth.storeId）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-other'],
      convertInItems: [{ skuId: 'sku-x', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: 'C', customer_type: '流量客', bound_store_id: 'store-001',
    }])
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
      return await cb(client)
    })
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-other', store_id: 'store-999', item_direction: '购买',
          sku_id: 'sku-old', product_name: 'X', sku_spec_name: 'S',
          product_type: '疗程卡', session_count: 1, remaining_sessions: 1,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '100', unit_real_price: '100',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
        }], rowCount: 1,
      })
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*门店/)
  })

  test('拒绝：疗程卡已耗尽（remaining_sessions=0）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-exhausted'],
      convertInItems: [{ skuId: 'sku-x', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: 'C', customer_type: '流量客', bound_store_id: 'store-001',
    }])
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
      return await cb(client)
    })
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-exhausted', store_id: 'store-001', item_direction: '购买',
          sku_id: 'sku-old', product_name: 'X', sku_spec_name: 'S',
          product_type: '疗程卡', session_count: 5, remaining_sessions: 0,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '100', unit_real_price: '100',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
        }], rowCount: 1,
      })
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*耗尽/)
  })

  test('拒绝：并发冲突（UPDATE remaining_sessions rowCount=0 → 卡状态变化）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-race'],
      convertInItems: [{ skuId: 'sku-x', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: 'C', customer_type: '流量客', bound_store_id: 'store-001',
    }])
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // generateOrderNo: advisory_xact_lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // generateOrderNo: SELECT sale_order_id LIKE
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-race', store_id: 'store-001', item_direction: '购买',
          sku_id: 'sku-old', product_name: 'X', sku_spec_name: 'S',
          product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '100', unit_real_price: '100',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          sku_id: 'sku-x', product_type: '疗程卡', spec_name: '新款',
          price: '200', session_count: 5, service_fee: '0', sales_category: '自销自耗',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT sale_orders
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT max sale_item_id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转出行
      // 关键：UPDATE remaining_sessions rowCount=0 触发并发冲突
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await expect(orderRoutes.createConversion(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*卡状态变化/)
  })

  // ===== D2.4 原体验卡单品（合并后=疗程卡）折抵分支 =====
  // 2026-05-21 单品合并：原"体验卡单品"已并入疗程卡，折抵统一按 remaining_sessions，走 remaining_sessions=0 UPDATE
  test('原体验卡单品（合并后=疗程卡）折抵：按 unit_real_price × remaining_sessions 计算 + 走 remaining_sessions UPDATE 分支', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-exp-001'],
      convertInItems: [{ skuId: 'sku-new', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '李四', customer_type: '会员客', bound_store_id: 'store-001',
    }])

    // 原体验卡单品（合并后疗程卡）：remaining_sessions=3，unit_real_price=200
    // totalOut = 200 × 3 = 600
    // totalIn = 1000 × 1 = 1000 → priceDiff=400
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // generateOrderNo: advisory_xact_lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // generateOrderNo: SELECT sale_order_id LIKE
      .mockResolvedValueOnce({
        rows: [{
          sale_item_id: 'item-exp-001', store_id: 'store-001', item_direction: '购买',
          sku_id: 'sku-exp-old', product_name: '体验项目', sku_spec_name: '体验装',
          product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
          quantity: 1, picked_up_quantity: 0,
          unit_price: '200', unit_real_price: '200',
          sales_category: '自销自耗', service_fee: '0',
          client_user_id: 'cu-001', order_status: '已支付', product_kind: '体验卡',
          parent_category_name: '体验卡',
          is_recharge_card: false, is_experience: true,
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          sku_id: 'sku-new', product_type: '疗程卡', spec_name: '升级款',
          price: '1000', session_count: 10, service_fee: '0', sales_category: '自销自耗',
        }], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT sale_orders
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT max sale_item_id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转出行
      // UPDATE 疗程卡 remaining_sessions=0
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT 转入行
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: txQuery }))

    await orderRoutes.createConversion(ctx)

    // 折抵金额 = 200 × 3 = 600，差额 = 1000 - 600 = 400
    expect(ctx.result.totalOut).toBe(600)
    expect(ctx.result.totalIn).toBe(1000)
    expect(ctx.result.priceDiff).toBe(400)
    expect(ctx.result.status).toBe('待支付') // priceDiff>0 + 线下

    // 验证走疗程卡分支：UPDATE 语句包含 SET remaining_sessions = 0，不含 picked_up_quantity = quantity
    const updateCall = txQuery.mock.calls.find(c => /SET remaining_sessions = 0/.test(c[0]))
    expect(updateCall).toBeDefined()
    expect(updateCall[0]).toMatch(/SET remaining_sessions = 0/)
    expect(updateCall[0]).not.toMatch(/picked_up_quantity = quantity/)
    // 参数 $4 = 折抵数量（剩余 3）
    expect(updateCall[1][3]).toBe(3)
  })
})

// ============================================================
// order.customerHeldCards — D2.5 新增
// ============================================================
describe('order.customerHeldCards', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('正常返回：多张疗程卡列表（含原体验卡单品=1 次卡）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })

    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'it-liao-1', source_sale_order_id: 'FY-A',
        product_name: '疗程A', sku_spec_name: '10次卡', product_type: '疗程卡',
        remaining_sessions: 4, remaining_quantity: 1,
        unit_real_price: '300.00', deductible_amount: '1200.00',
      },
      {
        sale_item_id: 'it-exp-1', source_sale_order_id: 'FY-B',
        product_name: '体验B', sku_spec_name: '体验装', product_type: '疗程卡',
        remaining_sessions: 3, remaining_quantity: 1,
        unit_real_price: '100.00', deductible_amount: '300.00',
      },
    ])

    await orderRoutes.customerHeldCards(ctx)

    expect(ctx.result.cards).toHaveLength(2)
    expect(ctx.result.cards[0].saleItemId).toBe('it-liao-1')
    expect(ctx.result.cards[0].productType).toBe('疗程卡')
    // 疗程卡：deductibleAmount = unit_real_price × remaining_sessions = 300 × 4 = 1200
    expect(ctx.result.cards[0].deductibleAmount).toBe('1200.00')
    expect(ctx.result.cards[0].remainingSessions).toBe(4)
    // 原体验卡单品（合并后疗程卡）：deductibleAmount = unit_real_price × remaining_sessions = 100 × 3 = 300
    expect(ctx.result.cards[1].productType).toBe('疗程卡')
    expect(ctx.result.cards[1].deductibleAmount).toBe('300.00')
    expect(ctx.result.cards[1].remainingSessions).toBe(3)
  })

  test('SQL 守卫：跨店卡不出现（WHERE si.store_id = $2）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })
    pg.query.mockResolvedValueOnce([])

    await orderRoutes.customerHeldCards(ctx)

    const sql = pg.query.mock.calls[0][0]
    const params = pg.query.mock.calls[0][1]
    expect(sql).toMatch(/si\.store_id\s*=\s*\$2/)
    expect(params[1]).toBe('store-001')
    expect(ctx.result.cards).toEqual([])
  })

  test('SQL 守卫：item_direction != "购买" 不出现', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })
    pg.query.mockResolvedValueOnce([])

    await orderRoutes.customerHeldCards(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toMatch(/si\.item_direction\s*=\s*'购买'/)
  })

  test('SQL 守卫：status 必须 IN (已支付, 已完成)', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })
    pg.query.mockResolvedValueOnce([])

    await orderRoutes.customerHeldCards(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toMatch(/so\.status IN \('已支付', '已完成'\)/)
  })

  test('SQL 守卫：疗程卡 remaining_sessions=0 不出现（> 0 过滤）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })
    pg.query.mockResolvedValueOnce([])

    await orderRoutes.customerHeldCards(ctx)

    const sql = pg.query.mock.calls[0][0]
    // 疗程卡分支必须含 remaining_sessions > 0
    expect(sql).toMatch(/si\.product_type = '疗程卡'[\s\S]*remaining_sessions[\s\S]*>\s*0/)
  })

  // 2026-05-21 单品合并：原"体验类单品卡 quantity-picked_up>0"折抵分支已删除，
  // 折抵对象统一为疗程卡 remaining_sessions>0（见上一条 SQL 守卫），原 is_experience 分支测试随之移除。

  test('权限守卫：美容师调用 → requireManager 抛 PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'cu-001' })
    await expect(orderRoutes.customerHeldCards(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 clientUserId 抛 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.customerHeldCards(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('deductibleAmount 计算一致性：行值直接透传且保留两位小数', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001' })
    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'it-1', source_sale_order_id: 'FY-X',
        product_name: 'P', sku_spec_name: 'S', product_type: '疗程卡',
        remaining_sessions: 7, remaining_quantity: 1,
        unit_real_price: '150.5', deductible_amount: 1053.5,
      },
    ])

    await orderRoutes.customerHeldCards(ctx)
    // 150.5 × 7 = 1053.5
    expect(ctx.result.cards[0].deductibleAmount).toBe('1053.50')
  })
})

// ============================================================
// order.createPickup
// ============================================================
describe('order.createPickup', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('取货成功', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 2 })

    // createPickup 主体在 pg.transaction(cb) 内，调用 client.query；用 mockImplementation 替换 transaction
    const clientResults = [
      { rows: [{ sale_item_id: 'item-001', quantity: 5, picked_up_quantity: 2 }], rowCount: 1 }, // UPDATE sale_items
      { rows: [{ sale_order_id: 'FY-001', client_user_id: 'cu-001' }], rowCount: 1 },             // SELECT itemRows
      { rows: [], rowCount: 1 },                                                                    // INSERT pickup_records
    ]
    let idx = 0
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn(async () => clientResults[idx++] || { rows: [], rowCount: 0 }) }
      return await cb(client)
    })

    await orderRoutes.createPickup(ctx)

    expect(ctx.result.saleItemId).toBe('item-001')
    expect(ctx.result.pickedUp).toBe(2)
    expect(ctx.result.remaining).toBe(3) // 5 - 2
    expect(ctx.result.message).toContain('取货成功')
  })

  test('超出可提货数量拒绝', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 10 })
    const clientResults = [
      { rows: [], rowCount: 0 }, // UPDATE rowCount=0
      { rows: [{ store_id: 'store-001', product_type: '家居产品', quantity: 5, picked_up_quantity: 5 }], rowCount: 1 }, // probe
    ]
    let idx = 0
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn(async () => clientResults[idx++] || { rows: [], rowCount: 0 }) }
      return await cb(client)
    })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*超出/)
  })

  test('跨店提货拒绝 — sale_items.store_id 与员工当前门店不一致', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-other-store', pickupQuantity: 1 })
    const clientResults = [
      { rows: [], rowCount: 0 }, // UPDATE rowCount=0 因 store_id 不匹配
      { rows: [{ store_id: 'store-999', product_type: '家居产品', quantity: 5, picked_up_quantity: 0 }], rowCount: 1 }, // probe
    ]
    let idx = 0
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn(async () => clientResults[idx++] || { rows: [], rowCount: 0 }) }
      return await cb(client)
    })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/仅在 store-999 可提货/)
  })

  test('缺少 saleItemId 拒绝', async () => {
    const ctx = createManagerCtx({ pickupQuantity: 1 })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleItemId/)
  })

  test('取货数量 <= 0 拒绝', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 0 })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*取货数量/)
  })
})

// ============================================================
// 储值卡抵扣相关新增测试（2026-04-24 ticket: prepaid-card-deduction-by-store）
// ============================================================
describe('order.create — 储值卡预选（店长开单 = 预选，不扣卡）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('useCard=true + 余额充足：全额抵扣（payable=0）→ 订单 已支付，payment_method=无，创建即扣卡 + 写储值卡抵扣流水（2026-05-21）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([]) // 无待支付
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '2000.00' }])  // 储值卡余额足够（create 前预选校验读余额）

    let txCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txCalls.push({ sql, params })
          // 扣卡块：SELECT card_id, balance FROM prepaid_cards ... FOR UPDATE → 返回足额账户
          if (typeof sql === 'string' && /SELECT card_id, balance FROM prepaid_cards/i.test(sql)) {
            return { rows: [{ card_id: 'card-stub-1', balance: '2000.00' }], rowCount: 1 }
          }
          // 结算副作用 recalcCustomerType 的 computed_type 查询
          if (typeof sql === 'string' && /AS computed_type/i.test(sql)) {
            return { rows: [{ computed_type: '流量客' }], rowCount: 1 }
          }
          // recalcCustomerType 的 UPDATE ... RETURNING customer_type
          if (typeof sql === 'string' && /RETURNING customer_type/i.test(sql)) {
            return { rows: [{ customer_type: '流量客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.totalAmount).toBe(1000)
    expect(ctx.result.prepaidCardAmount).toBe(1000)
    expect(ctx.result.paymentMethod).toBe('无')  // 后端强制覆盖
    // 2026-05-21：全额储值卡抵扣（payable=0）创建时即扣卡 + 结清
    expect(ctx.result.status).toBe('已支付')

    // 断言：事务内发生 prepaid_cards 扣减 + card_transactions 扣款 + 储值卡抵扣 payments 行
    const allSql = txCalls.map(c => c.sql).join('\n')
    expect(allSql).toMatch(/UPDATE prepaid_cards/)
    expect(allSql).toMatch(/INSERT INTO card_transactions/)
    expect(allSql).toMatch(/储值卡抵扣/)
  })

  test('useCard=true + 余额不足以抵全额：部分抵扣 → 订单 待支付，payment_method=微信', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '300.50' }])  // 余额 300.50 < 1000

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(300.5)
    // PR-2: 线上支付 pending → paidAmount=0（sale_orders.paid_amount 是"已入账"快照，不是"应付"）
    expect(ctx.result.paidAmount).toBe(0)
    expect(ctx.result.payableAmount).toBe(699.5)
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.status).toBe('待支付')
  })

  test('useCard=false：不抵扣，原流程', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      useCard: false,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.paidAmount).toBe(1000)
    expect(ctx.result.paymentMethod).toBe('线下')
    // PR-2: 线下全额现场 + receivedAmount 默认 payable → '待支付' + 1 行 首次支付 payments（confirmOffline 再转 '已支付'）
    expect(ctx.result.status).toBe('待支付')
  })

  test('前端传 prepaidCardAmount > 余额 → INSUFFICIENT_BALANCE', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
      prepaidCardAmount: 500,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '100.00' }])  // 余额不足

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('前端传 prepaidCardAmount > 应抵上限 → INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
      prepaidCardAmount: 5000,  // 超过订单总额 1000
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([{ balance: '99999.00' }])  // 余额足够

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*应抵上限/)
  })

  test('useCard=true 但顾客无卡：balance=0，prepaidCardAmount=0，paidAmount=total', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '线下',
      useCard: true,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      .mockResolvedValueOnce([])  // 无卡行

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.paidAmount).toBe(1000)
    expect(ctx.result.paymentMethod).toBe('线下')
  })

  test('SELECT balance 不带 FOR UPDATE（部分抵扣预选不写）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'cu-001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001', product_type: '疗程卡', spec_name: '基础款',
        price: '1000.00', special_price: null, session_count: 10,
        product_name: 'P', sales_category: '自销自耗', product_kind: '护理项目',
      }])
      // 余额 300 < 总额 1000 → 部分抵扣（payable>0），仍走"预选不扣卡"延后路径
      .mockResolvedValueOnce([{ balance: '300.00' }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: makeClientQueryMock({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    // pg.query 的第4个调用是 create 前的预选余额读取（SELECT balance）；不应含 FOR UPDATE
    const balanceSqlCall = pg.query.mock.calls[3]
    expect(balanceSqlCall[0]).toMatch(/SELECT balance FROM prepaid_cards/)
    expect(balanceSqlCall[0]).not.toMatch(/FOR UPDATE/)
    // 部分抵扣 → 待支付，事务内不扣卡（延后到 confirmOffline/payNotify）
    expect(ctx.result.status).toBe('待支付')
  })
})

describe('order.confirmOffline — 储值卡扣款（staffApi 唯一扣卡点）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('prepaid_card_amount > 0 确认收款：扣 balance + INSERT card_transactions + 置 已支付', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-PD-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-PD-001',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'cu-001',
        prepaid_card_amount: '300.00',
        paid_amount: '200.00',
        total_amount: '500.00',
        payable_amount: '200.00',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_type: '疗程卡' },
      ])
      // remainingPayable=0 → confirmAmount=0 → 不查 SELECT sale_order_payments

    const txCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txCalls.push({ sql, params })
          if (sql.includes('FROM card_transactions') && sql.includes("type = '扣款'")) {
            return { rows: [] }  // 幂等 — 未扣过
          }
          if (sql.includes('FROM prepaid_cards') && sql.includes('FOR UPDATE')) {
            return { rows: [{ card_id: 'card-001', balance: '500.00' }] }
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    // 断言：必有 UPDATE prepaid_cards SET balance = balance - 300
    const updateCall = txCalls.find(c => c.sql.includes('UPDATE prepaid_cards') && c.sql.includes('balance = balance -'))
    expect(updateCall).toBeDefined()
    expect(Number(updateCall.params[0])).toBe(300)
    // 断言：必有 INSERT card_transactions(type='扣款', amount=-300)
    const insertCall = txCalls.find(c => c.sql.includes('INSERT INTO card_transactions') && c.sql.includes("'扣款'"))
    expect(insertCall).toBeDefined()
    expect(Number(insertCall.params[1])).toBe(-300)
    expect(insertCall.params[2]).toBe('FY-PD-001')
  })

  test('prepaid_card_amount > 0 但已有扣款流水：幂等跳过不重复扣', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-PD-002' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-PD-002',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'cu-001',
        prepaid_card_amount: '300.00',
        paid_amount: '200.00',
        total_amount: '500.00',
        payable_amount: '200.00',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_type: '疗程卡' },
      ])

    const txCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          txCalls.push({ sql })
          if (sql.includes('FROM card_transactions') && sql.includes("type = '扣款'")) {
            return { rows: [{ '?column?': 1 }] }  // 已扣过
          }
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    // 幂等命中 → 无 UPDATE prepaid_cards / INSERT card_transactions(扣款)
    const hasUpdate = txCalls.some(c => c.sql.includes('UPDATE prepaid_cards') && c.sql.includes('balance = balance -'))
    const hasInsert = txCalls.some(c => c.sql.includes('INSERT INTO card_transactions') && c.sql.includes("'扣款'"))
    expect(hasUpdate).toBe(false)
    expect(hasInsert).toBe(false)
  })

  test('prepaid_card_amount > 0 但余额不足 → INSUFFICIENT_BALANCE', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-PD-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-PD-003',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'cu-001',
        prepaid_card_amount: '300.00',
        paid_amount: '200.00',
        total_amount: '500.00',
        payable_amount: '200.00',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_type: '疗程卡' },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql.includes('FROM card_transactions') && sql.includes("type = '扣款'")) {
            return { rows: [] }
          }
          if (sql.includes('FROM prepaid_cards') && sql.includes('FOR UPDATE')) {
            return { rows: [{ card_id: 'card-001', balance: '100.00' }] }  // 余额不足
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('prepaid_card_amount = 0 时：不触发扣卡，原行为不变', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NP-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-NP-001',
        status: '待支付',
        payment_method: '线下',
        store_id: 'store-001',
        client_user_id: 'cu-001',
        prepaid_card_amount: '0',
        paid_amount: '500.00',
        total_amount: '500.00',
        payable_amount: '500.00',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_type: '疗程卡' },
      ])

    const txCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          txCalls.push({ sql })
          if (sql.includes('SELECT customer_type FROM client_wechat_users')) {
            return { rows: [{ customer_type: '会员客' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    // 无 prepaid_cards 相关 SQL（除了充值卡识别）
    const dedCardSql = txCalls.find(c =>
      c.sql.includes('UPDATE prepaid_cards') && c.sql.includes('balance = balance -')
    )
    expect(dedCardSql).toBeUndefined()
  })
})

// ============================================================
// order.createRefund — 按比例拆分退款（储值卡部分 + 原通道部分）— 2026-04-26 重写
// ============================================================
//   2026-04-26 sale-order-domain-refactor: 拆分逻辑（splitRefundByOriginalPayment）
//   已迁至 createRefund 阶段，结果写入 sale_order_payments.note JSON。
//   approveRefund 仅按 payment_method 决定是否回冲储值卡。
//   本组测试覆盖 createRefund 时 refundByCard/refundByOrigin 的拆分计算。
describe('order.createRefund — 按比例拆分退款（refundByCard/refundByOrigin）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // assertOrderInScope helper SELECT store_id FROM sale_orders（先于业务 SELECT *）
    pg.query.mockResolvedValueOnce([{ store_id: 'store-001' }])
  })

  /**
   * 通用 mock：原单 payment_method='无'（全额储值卡场景）/'微信'/'线下' 等可调。
   * 返回 { calls, fn } 用于断言 sop INSERT 的 amount/payment_method、note JSON 的 split。
   */
  function setupSplitTest({
    refSaleOrderId = 'FY-ORIG-X',
    paymentMethod = '无',
    prepaidCardAmount = '0',
    totalAmount = '300',
    saleItemId = 'item-x',
    productType = '疗程卡',
    sessionCount = 5,
    remainingSessions = 5,
    quantity = 1,
    unitRealPrice = '100',
    refundQuantity = 1,
    refundReason = '测试拆分',
    handlingFee,
  } = {}) {
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: refSaleOrderId, status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', payment_method: paymentMethod,
        prepaid_card_amount: prepaidCardAmount, total_amount: totalAmount,
      }])
      .mockResolvedValueOnce([])  // in-flight 校验空
      .mockResolvedValueOnce([{
        sale_item_id: saleItemId, product_type: productType,
        session_count: sessionCount, remaining_sessions: remainingSessions,
        quantity, picked_up_quantity: 0,
        unit_price: unitRealPrice, unit_real_price: unitRealPrice,
        sku_id: `sku-${saleItemId}`, product_name: 'X', sku_spec_name: 'S',
        sales_category: '自销自耗', service_fee: '0',
      }])

    const calls = []
    const fn = vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(sql)) {
        return { rows: [{ id: 5001 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: fn }))

    const payload = {
      refSaleOrderId,
      items: [{ saleItemId, refundQuantity }],
      refundReason,
    }
    if (handlingFee !== undefined) payload.handlingFee = handlingFee

    return { calls, payload }
  }

  test('全额储值卡抵扣原单：refundByCard = refundAmount，refundByOrigin = 0', async () => {
    const { calls, payload } = setupSplitTest({
      paymentMethod: '无',
      prepaidCardAmount: '300',
      totalAmount: '300',
      unitRealPrice: '100',
      refundQuantity: 1,  // 退 100
    })
    const ctx = createManagerCtx(payload)

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.refundByCard).toBe(100)
    expect(ctx.result.refundByOrigin).toBe(0)

    // note JSON 中 split 一致（合并后写入主表 INSERT 的 params[7]）
    const sopInsert = calls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(c.sql)
    )
    const note = JSON.parse(sopInsert.params[7])
    expect(note.refundByCard).toBe(100)
    expect(note.refundByOrigin).toBe(0)
  })

  test('部分储值卡抵扣：按比例 — prepaid=100/total=300, refund=150 → byCard=50, byOrigin=100', async () => {
    const { calls, payload } = setupSplitTest({
      paymentMethod: '线下',
      prepaidCardAmount: '100',
      totalAmount: '300',
      unitRealPrice: '150',  // 1 件 150
      refundQuantity: 1,
    })
    const ctx = createManagerCtx(payload)

    await orderRoutes.createRefund(ctx)

    // floor(100/300 × 150, 2) = floor(50.00, 2) = 50
    expect(ctx.result.refundByCard).toBe(50)
    expect(ctx.result.refundByOrigin).toBe(100)
    // 不变量：byCard + byOrigin === refundAmount，无尾差
    expect(ctx.result.refundByCard + ctx.result.refundByOrigin).toBe(150)

    const sopInsert = calls.find(c =>
      c.sql.includes('INSERT INTO sale_order_payments') && /RETURNING\s+id/i.test(c.sql)
    )
    const note = JSON.parse(sopInsert.params[7])
    expect(note.refundByCard).toBe(50)
    expect(note.refundByOrigin).toBe(100)
  })

  test('精度边界：prepaid=100, total=301, refund=150 → byCard=49.83, byOrigin=100.17，无尾差', async () => {
    const { payload } = setupSplitTest({
      paymentMethod: '线下',
      prepaidCardAmount: '100',
      totalAmount: '301',
      unitRealPrice: '150',
      refundQuantity: 1,
    })
    const ctx = createManagerCtx(payload)

    await orderRoutes.createRefund(ctx)

    // floor((100/301) × 150, 2) = floor(49.83388…, 2) = 49.83
    expect(ctx.result.refundByCard).toBe(49.83)
    // 反向相减：150 - 49.83 = 100.17
    expect(ctx.result.refundByOrigin).toBe(100.17)
    // 精确相等，无尾差
    expect(Math.round((ctx.result.refundByCard + ctx.result.refundByOrigin) * 100) / 100).toBe(150)
  })

  test('无储值卡抵扣原单：byCard=0，byOrigin=refundAmount', async () => {
    const { payload } = setupSplitTest({
      paymentMethod: '微信',
      prepaidCardAmount: '0',
      totalAmount: '300',
      unitRealPrice: '100',
      refundQuantity: 1,
    })
    const ctx = createManagerCtx(payload)

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.refundByCard).toBe(0)
    expect(ctx.result.refundByOrigin).toBe(100)
  })

  test('handlingFee 扣减后再拆分：prepaid=100,total=300,refundRaw=150,fee=50 → byCard=floor(100/300×100,2)=33.33, byOrigin=66.67', async () => {
    const { payload } = setupSplitTest({
      paymentMethod: '线下',
      prepaidCardAmount: '100',
      totalAmount: '300',
      unitRealPrice: '150',  // 1 件 150
      refundQuantity: 1,
      handlingFee: 50,
    })
    const ctx = createManagerCtx(payload)

    await orderRoutes.createRefund(ctx)

    // finalRefund = 150 - 50 = 100，byCard = floor(100/300 × 100, 2) = floor(33.333, 2) = 33.33
    expect(ctx.result.finalRefundAmount).toBe(100)
    expect(ctx.result.refundByCard).toBe(33.33)
    expect(ctx.result.refundByOrigin).toBe(66.67)
    expect(Math.round((ctx.result.refundByCard + ctx.result.refundByOrigin) * 100) / 100).toBe(100)
  })
})

describe('order.createConversion — schema 变更：UPSERT 按 user_id、不含 store_id', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('负差额分支：UPSERT 按 user_id，INSERT 列集不含 store_id', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-neg-x'],
      convertInItems: [{ skuId: 'sku-cheap', quantity: 1 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '李四', customer_type: '会员客', bound_store_id: 'store-001',
    }])

    const txCalls = []
    pg.transaction.mockImplementationOnce(async (cb) => {
      const tx = {
        query: vi.fn(async (sql, params) => {
          txCalls.push({ sql, params })
          if (sql.includes('advisory_xact_lock')) return { rows: [], rowCount: 1 }
          // generateOrderNo: SELECT sale_order_id LIKE → empty → seq=1
          if (sql.includes('FROM sale_orders') && sql.includes('LIKE $1')) return { rows: [], rowCount: 0 }
          if (sql.includes('FOR UPDATE OF si')) {
            return {
              rows: [{
                sale_item_id: 'item-neg-x', store_id: 'store-001', item_direction: '购买',
                sku_id: 'sku-old', product_name: '旧', sku_spec_name: 'S',
                product_type: '疗程卡', session_count: 2, remaining_sessions: 2,
                quantity: 1, picked_up_quantity: 0,
                unit_price: '1000', unit_real_price: '1000',
                sales_category: '自销自耗', service_fee: '0',
                client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
              }], rowCount: 1,
            }
          }
          if (sql.includes('FROM product_skus')) {
            return {
              rows: [{
                sku_id: 'sku-cheap', product_type: '疗程卡', spec_name: '低价',
                price: '500', session_count: 5, service_fee: '0', sales_category: '自销自耗',
              }], rowCount: 1,
            }
          }
          if (sql.includes('INSERT INTO prepaid_cards')) {
            return { rows: [{ card_id: 'card-credit-neg' }], rowCount: 1 }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(tx)
    })

    await orderRoutes.createConversion(ctx)

    // totalOut = 1000×2=2000，totalIn=500×1=500，priceDiff=-1500
    const upsertCall = txCalls.find(c => c.sql.includes('INSERT INTO prepaid_cards'))
    expect(upsertCall).toBeDefined()
    expect(upsertCall.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/)
    expect(upsertCall.sql).not.toMatch(/store_id/)
    // 参数：clientUserId, amount（无 storeId）
    expect(upsertCall.params[0]).toBe('cu-001')
    expect(upsertCall.params[1]).toBe('1500.00')
  })

  test('正差额分支（补款）沿用"店长开单 = 预选"：订单状态按 paymentMethod，不立即扣卡', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      convertOutSaleItemIds: ['item-pos-x'],
      convertInItems: [{ skuId: 'sku-up', quantity: 2 }],
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '李四', customer_type: '会员客', bound_store_id: 'store-001',
    }])

    const txCalls = []
    pg.transaction.mockImplementationOnce(async (cb) => {
      const tx = {
        query: vi.fn(async (sql) => {
          txCalls.push({ sql })
          if (sql.includes('advisory_xact_lock')) return { rows: [], rowCount: 1 }
          // generateOrderNo: SELECT sale_order_id LIKE → empty → seq=1
          if (sql.includes('FROM sale_orders') && sql.includes('LIKE $1')) return { rows: [], rowCount: 0 }
          if (sql.includes('FOR UPDATE OF si')) {
            return {
              rows: [{
                sale_item_id: 'item-pos-x', store_id: 'store-001', item_direction: '购买',
                sku_id: 'sku-old', product_name: '旧', sku_spec_name: 'S',
                product_type: '疗程卡', session_count: 1, remaining_sessions: 1,
                quantity: 1, picked_up_quantity: 0,
                unit_price: '500', unit_real_price: '500',
                sales_category: '自销自耗', service_fee: '0',
                client_user_id: 'cu-001', order_status: '已支付', product_kind: '护理项目',
              }], rowCount: 1,
            }
          }
          if (sql.includes('FROM product_skus')) {
            return {
              rows: [{
                sku_id: 'sku-up', product_type: '疗程卡', spec_name: '升级',
                price: '1000', session_count: 10, service_fee: '0', sales_category: '自销自耗',
              }], rowCount: 1,
            }
          }
          return defaultQueryResult(sql)
        }),
      }
      return await cb(tx)
    })

    await orderRoutes.createConversion(ctx)

    // priceDiff = 2000 - 500 = 1500（>0，线下）→ 待支付
    expect(ctx.result.priceDiff).toBe(1500)
    expect(ctx.result.status).toBe('待支付')
    // 不应触发 prepaid_cards 入账（正差额走预选链路）
    const hasUpsert = txCalls.some(c => c.sql.includes('INSERT INTO prepaid_cards'))
    const hasDeduct = txCalls.some(c => c.sql.includes('INSERT INTO card_transactions'))
    expect(hasUpsert).toBe(false)
    expect(hasDeduct).toBe(false)
  })
})

