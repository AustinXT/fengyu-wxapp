/**
 * 订单路由测试
 * 覆盖：create（正常/重复待支付/10分钟超时/优惠券）、pay、offlinePay、cancel、list、detail、appointableItems、scanDetail
 */

const pg = globalThis.__mocks__.pg
const {
  createCtx, createBoundCtx, createMockTransactionClient, sqlConjuncts, sliceBetweenAnchors, sliceUpdateWhere,
} = require('../helpers')

/**
 * issue #230：订单行封面图下发前必须缩略。
 * 形态取自生产实际数据（45/45 条均为此格式）：CloudBase COS 域名 + 两段 ASCII 对象键。
 */
const COS_COVER_URL = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/product-covers/a.jpg'
/** 非 COS 域名：数据万象不生效，safeThumbUrl 按 fail-closed 约定返回 null，不退回原图 */
const NON_COS_COVER_URL = 'https://img.example.com/a.jpg'

let routes
beforeEach(() => {
  vi.clearAllMocks()
  // 清除路由和 auth 缓存
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/order') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/order')
})

describe('order.scanDetail', () => {
  test('待支付订单返回详情 + 明细（含开单人和封面图）', async () => {
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付', store_id: 's1',
        sale_order_type: '销售单', total_amount: 100, store_name: '南昌旗舰店', opener_name: '张三', opened_by: 'emp-001',
        prepaid_card_amount: 30, payable_amount: 70, received: 0, refunded_amount: 0,
        first_payment_amount: 20, is_experience_conversion: false,
        payment_method: '微信', coupon_discount: 0,
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-001', unit_price: 200, quantity: 1, received: 100,
        sale_amount: 3000, session_count: 15,
        product_name: '温暖SPA·臀腿',
        cover_image: COS_COVER_URL,
      }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.orderNo).toBe('FY-001')
    expect(ctx.result.order.openerName).toBe('张三')
    expect(ctx.result.order.prepaidCardAmount).toBe(30)
    expect(ctx.result.order.payableAmount).toBe(70)
    expect(ctx.result.order.received).toBe(0)
    expect(ctx.result.order.refundedAmount).toBe(0)
    expect(ctx.result.order.firstPaymentAmount).toBe(20)
    expect(ctx.result.order.isExperienceConversion).toBe(false)
    expect(ctx.result.order.paymentMethod).toBe('微信')
    expect(ctx.result.items).toHaveLength(1)
    // issue #230：封面图下发前强制缩略（订单行 96rpx → 小档 400）
    expect(ctx.result.items[0].coverImage).toBe(`${COS_COVER_URL}?imageMogr2/thumbnail/400x400`)
    // 行金额展示口径：saleAmount（行应付总额，权威）取自 sale_amount 列，
    // 多次卡（session_count=15、unit_price=200）行总额 3000 ≠ 单次价 200
    expect(ctx.result.items[0].saleAmount).toBe(3000)
    expect(ctx.result.items[0].unitPrice).toBe(200)
    expect(ctx.result.items[0].sessionCount).toBe(15)

    // 验证 SQL 包含 opener JOIN 和 cover_image JOIN，且 items 查询含 sale_amount（权威行总额）
    const orderQuery = pg.query.mock.calls[0][0]
    expect(orderQuery).toContain('opener_name')
    const itemsQuery = pg.query.mock.calls[1][0]
    expect(itemsQuery).toContain('cover_image')
    expect(itemsQuery).toContain('sale_amount')
  })

  test('非待支付订单返回状态提示', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-002', status: '已支付',    }])

    const ctx = createBoundCtx({ orderNo: 'FY-002' })
    await routes.scanDetail(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.statusMsg).toContain('已完成支付')
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.scanDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ orderNo: 'nonexistent' })
    await expect(routes.scanDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })

  test('未绑定手机号 → PHONE_REQUIRED（audit-02 P0 修复）', async () => {
    const ctx = createCtx({
      payload: { orderNo: 'FY-001' },
      auth: { phone: null },
    })
    await expect(routes.scanDetail(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })
})

describe('order.create', () => {
  test('正常创建订单', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])  // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])  // check pending
    pg.query.mockResolvedValueOnce([{   // SKU query
      sku_id: 'sku-1', product_id: 'p1', product_type: '疗程卡',
      spec_name: '标准', price: '100', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expect(ctx.result.orderNo).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.totalAmount).toBe(100)
    expect(ctx.result.status).toBe('待支付')
  })

  test('B2 拆行：5次卡 ×2 → 2 行 sale_items（每行 quantity=1, session_count=5）', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])  // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])  // check pending
    pg.query.mockResolvedValueOnce([{   // SKU query
      sku_id: 'sku-1', product_id: 'p1', product_type: '疗程卡',
      spec_name: '标准', price: '100', special_price: null,
      session_count: 5, product_name: '护理A', sales_category: null,
    }])

    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 2 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(2)
    // INSERT 列顺序: ... product_type, session_count, remaining_sessions, unit_price, quantity, ...
    // params: $1=saleItemId $2=orderNo $3=storeId $4=skuId $5=productName
    //         $6=productType $7=session_count $8=remaining_sessions $9=unit_price $10=quantity ...
    for (const call of insertItemCalls) {
      expect(call[1][6]).toBe(5)
      expect(call[1][7]).toBe(5)
      expect(call[1][9]).toBe(1)
      expect(Number(call[1][11])).toBe(100)
      expect(Number(call[1][12])).toBe(100)
    }
    expect(ctx.result.totalAmount).toBe(200)
  })

  test('B2 不拆：家居产品 ×5 → 1 行 sale_items 并冻结库存组成', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])  // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])  // check pending
    pg.query.mockResolvedValueOnce([{   // SKU query
      sku_id: 'sku-home', product_id: 'p-home', product_type: '家居产品',
      spec_name: '精华液', price: '80', special_price: null,
      session_count: null, product_name: '精华液', sales_category: null,
    }])

    const clientQuery = vi.fn(async (sql) => {
      if (/FROM inventory_sku_product_sku_mappings mapping/.test(sql)) {
        return {
          rows: [{
            product_sku_id: 'sku-home',
            inventory_sku_id: 'inventory-sku-001',
            product_code: 'I001',
            product_name: '库存精华液',
            spec_name: null,
            quantity_per_sale_unit: 2,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-home', quantity: 5 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    const insertItemCalls = clientQuery.mock.calls.filter(c => /INSERT INTO sale_items/.test(c[0]))
    expect(insertItemCalls).toHaveLength(1)
    expect(insertItemCalls[0][1][6]).toBeNull()
    expect(insertItemCalls[0][1][7]).toBeNull()
    expect(insertItemCalls[0][1][9]).toBe(5)
    expect(JSON.parse(insertItemCalls[0][1][15])).toEqual({
      version: 1,
      components: [{
        inventorySkuId: 'inventory-sku-001',
        productCode: 'I001',
        productName: '库存精华液',
        specName: null,
        quantityPerSaleUnit: 2,
      }],
    })
    expect(clientQuery.mock.calls.some(([sql]) => /inventory_sku_product_sku_mappings/.test(sql))).toBe(true)
    expect(ctx.result.totalAmount).toBe(400)
  })

  test('进销存联动开启时，家居产品未配置库存组成拒绝建单', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-home', product_id: 'p-home', product_type: '家居产品',
      spec_name: '精华液', price: '80', special_price: null,
      session_count: null, product_name: '精华液', sales_category: null,
    }])
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-home', quantity: 1 }],
      paymentMethod: '微信',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_STATE: INVENTORY_COMPOSITION_MISSING/)
    expect(clientQuery.mock.calls.some(([sql]) => /inventory_sku_product_sku_mappings/.test(sql))).toBe(true)
  })

  // 开单在事务内按历史达标次数分类；后续首次成功入账路径会再次按同一规则确认。
  test('document_type 开单分类：无历史达标单 → 售前一次', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])  // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])  // check pending
    pg.query.mockResolvedValueOnce([{   // SKU query - 大额 5000（远超默认阈值 1980）
      sku_id: 'sku-1', product_id: 'p1', product_type: '疗程卡',
      spec_name: '标准', price: '5000', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
    }])
    // mock 5: 顾客身份查询 - 非会员客（customer_type=null）
    pg.query.mockResolvedValueOnce([{ name: null, customer_type: null, member_level: null }])

    let orderInsertCall
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (/INSERT INTO sale_orders/.test(sql)) {
            orderInsertCall = [sql, params]
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expect(ctx.result.totalAmount).toBe(5000)
    expect(orderInsertCall).toBeDefined()
    // params 顺序：$1=orderNo $2=initialStatus $3=documentType $4=marketName $5=storeId ...
    // JS 数组索引 [2] 对应 $3=document_type（详见 order.js L823-838）
    expect(orderInsertCall[1][2]).toBe('售前一次')
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: { storeId: 's1', items: [{ skuId: 'sku-1' }], paymentMethod: '微信' },
      auth: { phone: null },
    })
    await expect(routes.create(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('未绑定门店 → INVALID_PARAMS 请先绑定门店', async () => {
    // 手机号已绑、门店未绑：requirePhone 通过后被门店守卫拦截（与 card.recharge 口径一致）
    const ctx = createBoundCtx(
      { storeId: 's1', items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: '微信' },
      { boundStoreId: null },
    )
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*请先绑定门店后再下单/)
  })

  test('下单按提交门店复核 SKU 市场范围，拒绝跨市场 SKU', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 'store-b', store_name: 'B店', market_name: '市场B' }])
    pg.query.mockResolvedValueOnce([]) // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([]) // check pending
    // SQL 已按 store-b 的市场范围过滤，跨市场 SKU 不会进入结果集
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx(
      {
        storeId: 'store-b',
        items: [{ skuId: 'sku-market-a', quantity: 1 }],
        paymentMethod: '微信',
      },
      // 模拟用户从市场 A 切换到市场 B 后仍持有旧购物车
      { boundStoreId: 'store-a', boundMarketName: '市场A' },
    )

    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*sku-market-a.*不存在/)

    const [skuSql, skuParams] = pg.query.mock.calls[3]
    expect(skuSql).toContain('scope_market_node')
    expect(skuSql).toContain('scope_store.store_id = $2')
    expect(skuSql).toContain("NULLIF(regexp_replace(sk.market_scope, '[[:space:]]+', '', 'g'), '') IS NOT NULL")
    expect(skuParams).toEqual([['sku-market-a'], 'store-b'])
  })

  test('已有待支付订单 → INVALID_PARAMS + pendingOrderNo', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{ sale_order_id: 'FY-PENDING-001' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
    })

    try {
      await routes.create(ctx)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.message).toContain('INVALID_PARAMS')
      expect(err.data.pendingOrderNo).toBe('FY-PENDING-001')
    }
  })

  test('参数不完整 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ storeId: 's1' })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*参数不完整/)
  })

  test('J3 拒绝数组形式 couponId（一张订单仅支持 1 张券）', async () => {
    // B9 ticket follow-up：防绕过 schema 直接传 couponId: ['c1','c2']
    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: '微信',
      couponId: ['c1', 'c2'],
    })
    await expect(routes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*MULTIPLE_COUPON_NOT_SUPPORTED.*1 张优惠券/)
  })

  // ========== 优惠券抵扣路径 ==========

  function mockBaseCreateQueries(skuOverrides = {}) {
    // mock 1: 门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // mock 2: closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])
    // mock 3: check pending
    pg.query.mockResolvedValueOnce([])
    // mock 4: SKU 信息
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_id: 'p1', product_type: '疗程卡',
      spec_name: '标准', price: '200', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
      ...skuOverrides,
    }])
    // mock 5: 顾客姓名 + 会员身份（document_type 判断 + 会员价分流共用，order.js:505）
    pg.query.mockResolvedValueOnce([{ name: null, customer_type: null, member_level: null }])
  }

  function mockCreateTransaction() {
    // 按 SQL pattern 匹配 rowCount，比顺序 mock 鲁棒：
    // 路由在 2026-05 调整了事务内 SQL 顺序（INSERT order 现在在 coupon claim 之前），
    // 序号 mock 会让 coupon claim 拿到错的 rowCount=0 → throw '优惠券已失效'。
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          const s = String(sql)
          // coupon claim 严格期待 rowCount=1（路由判 rowCount!==1 → throw）
          if (/UPDATE\s+user_coupons/i.test(s)) {
            return { rows: [], rowCount: 1 }
          }
          // 其它 query（advisory lock / seq SELECT / INSERT / paid_sessions UPDATE / settlePoints / operation_logs）
          // 默认 rowCount=0 + 空 rows，路由不严格校验
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })
  }

  test('优惠券抵扣：现金券 ¥50 减免', async () => {
    mockBaseCreateQueries()
    // mock 5: 优惠券验证
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-1', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 50, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    // mock 6: SKU 品项分类
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    // mock 7: 顾客名称
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-1',
    })
    await routes.create(ctx)

    expect(ctx.result.totalAmount).toBe(150)  // 200 - 50
    expect(ctx.result.status).toBe('待支付')
  })

  test('优惠券抵扣不超过商品金额', async () => {
    mockBaseCreateQueries({ price: '30' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-2', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 50, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-2',
    })
    await routes.create(ctx)

    // discount capped at saleAmount ¥30, not ¥50
    expect(ctx.result.totalAmount).toBe(0)
  })

  test('券全额抵扣（totalAmount=0）→ 创建即结清「已支付」+ reason=coupon_full，不扣卡、不写 amount=0 流水', async () => {
    // 回归 2026-06-05 bug：券全额抵扣订单卡在「待支付」死循环
    //   （0 元发不起线上支付、payment_method='无' 也走不了 confirmOffline → 顾客端两界面循环）
    mockBaseCreateQueries({ price: '200' })
    // 现金券 ¥200 足额抵掉 ¥200 → totalAmount=0、prepaidCardAmount=0（无卡）
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-full', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 200, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }]) // 品项分类
    pg.query.mockResolvedValueOnce([{ name: '张三' }]) // 顾客名

    const txnQueries = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          const s = String(sql)
          txnQueries.push({ sql: s, params })
          if (/UPDATE\s+user_coupons/i.test(s)) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-full',
      useCard: false,
    })
    await routes.create(ctx)

    // 1) 应付为 0 → 创建即结清，不进任何支付/收款通道
    expect(ctx.result.totalAmount).toBe(0)
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.reason).toBe('coupon_full')
    expect(ctx.result.paymentParams).toBeNull()

    // 2) 订单主表 INSERT：status='已支付'、received=0、payment_method='无'、paid_at 非空
    // params: [0]orderNo [1]status [2]docType [3]market [4]store [5]now [6]userId
    //         [7]phone [8]name [9]total [10]actualPrepaid [11]pendingPrepaid [12]received [13]payable
    //         [14]payment_method [15]preferredStaff [16]couponId [17]couponDiscount [18]paid_at
    const orderInsert = txnQueries.find(q => /INSERT INTO sale_orders/.test(q.sql))
    expect(orderInsert).toBeDefined()
    expect(orderInsert.params[1]).toBe('已支付')
    expect(orderInsert.params[12]).toBe(0)   // received=0（券抵扣无到账）
    expect(orderInsert.params[14]).toBe('无') // payment_method
    expect(orderInsert.params[18]).not.toBeNull() // paid_at=now

    // 3) 无储值卡（prepaidCardAmount=0）：不扣卡、不写 amount=0 储值卡抵扣流水（否则违 chk_sop_amount_sign）
    expect(txnQueries.find(q => /UPDATE prepaid_cards/.test(q.sql))).toBeUndefined()
    expect(txnQueries.find(q => /INSERT INTO card_transactions/.test(q.sql))).toBeUndefined()
    expect(txnQueries.find(q => /INSERT INTO sale_order_payments/.test(q.sql))).toBeUndefined()
  })

  test('优惠券已失效 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    // 优惠券不存在或已过期
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-expired',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*优惠券已失效/)
  })

  test('优惠券门店不匹配 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-3', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 20, min_spend: 0,
      applicable_category_ids: null,
      applicable_store_ids: ['store-other'],  // 不包含 's1'
    }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-3',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于此门店/)
  })

  test('优惠券品项分类不匹配 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-4', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '品项券', discount_value: 30, min_spend: 0,
      applicable_category_ids: ['cat-special'],  // 限定分类
      applicable_store_ids: null,
    }])
    // SKU 的 category_id 不在 applicable_category_ids 中
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-other' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-4',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于当前商品/)
  })

  test('B14: 5次卡 1000 + 298 现金券 → sale_amount=702 / unit_real_price=140.4 / received=702（券必须摊到行 saleAmount）', async () => {
    // ticket 2026-05-30 client coupon not allocated to sale_items：
    // 历史 bug 是只摊 received，sale_amount/unit_real_price 残留 pre-coupon 1000/200。
    // 修复后券摊到 saleAmount，per-session 重派 unit_real_price = 702/5 = 140.4。
    mockBaseCreateQueries({
      price: '1000', session_count: 5, product_type: '疗程卡',
    })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-298', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 298, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
      applicable_product_ids: null, applicable_market_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1', product_id: 'p1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])

    let insertItemCall
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          const s = String(sql)
          if (/INSERT INTO sale_items/i.test(s)) {
            insertItemCall = [s, params]
          }
          if (/UPDATE\s+user_coupons/i.test(s)) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-298',
    })
    await routes.create(ctx)

    expect(insertItemCall).toBeDefined()
    // params: [0]=saleItemId [1]=orderNo [2]=storeId [3]=skuId [4]=productName
    //         [5]=productType [6]=session_count [7]=remaining_sessions [8]=unitPrice
    //         [9]=quantity [10]=unitRealPrice [11]=saleAmount [12]=received [13]=salesCategory [14]=isExperience
    expect(insertItemCall[1][6]).toBe(5)                          // session_count
    expect(Number(insertItemCall[1][8])).toBe(200)                // unit_price (per-session 标价 1000/5)
    expect(Number(insertItemCall[1][10])).toBeCloseTo(140.4, 2)   // unit_real_price (702/5)
    expect(Number(insertItemCall[1][11])).toBe(702)               // sale_amount (1000-298)
    expect(Number(insertItemCall[1][12])).toBe(702)               // received = sale_amount
    expect(ctx.result.totalAmount).toBe(702)
  })

  test('优惠券未满足满减条件 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries({ price: '80' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-5', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 20, min_spend: 100,  // 满100可用
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-5',
    })
    // 商品 ¥80 < 满减门槛 ¥100
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*未满足使用条件/)
  })

  test('多商品订单优惠券按比例分摊', async () => {
    // mock 1: 门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // mock 2: closeExpired
    pg.query.mockResolvedValueOnce([])
    // mock 3: check pending
    pg.query.mockResolvedValueOnce([])
    // mock 4: SKU 信息（2个 SKU）
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-a', product_id: 'pa', product_type: '疗程卡', spec_name: '标准', price: '300', special_price: null, session_count: 1, product_name: '护理A', sales_category: null },
      { sku_id: 'sku-b', product_id: 'pb', product_type: '疗程卡', spec_name: '5次卡', price: '200', special_price: null, session_count: 5, product_name: '护理B', sales_category: null },
    ])
    // mock 5: 顾客姓名 + 会员身份（order.js:505）
    pg.query.mockResolvedValueOnce([{ name: null, customer_type: null, member_level: null }])
    // mock 6: 优惠券
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-multi', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 100, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    // mock 7: 品项分类
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-a', category_id: 'cat-1' },
      { sku_id: 'sku-b', category_id: 'cat-2' },
    ])
    // mock 8: 顾客名（历史遗留 slot，create 流不再消费，保留以免漂移断言）
    pg.query.mockResolvedValueOnce([{ name: '李四' }])

    // 同 mockCreateTransaction：按 SQL pattern match coupon claim rowCount=1
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/UPDATE\s+user_coupons/i.test(String(sql))) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-a', quantity: 1 }, { skuId: 'sku-b', quantity: 1 }],
      paymentMethod: '线下',
      couponId: 'cpn-multi',
    })
    await routes.create(ctx)

    // 总价 500-100=400
    expect(ctx.result.totalAmount).toBe(400)
  })

  test('积分抵扣按订单级抵扣摊到商品明细，尾差由最后一行吸收', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-a', product_id: 'pa', product_type: '服务', spec_name: '护理A', price: '33', special_price: null, session_count: null, product_name: '护理A', sales_category: null },
      { sku_id: 'sku-b', product_id: 'pb', product_type: '服务', spec_name: '护理B', price: '68', special_price: null, session_count: null, product_name: '护理B', sales_category: null },
    ])
    pg.query.mockResolvedValueOnce([{ name: '张三', customer_type: null, member_level: null }])
    pg.query.mockResolvedValueOnce([{ points_balance: 1000 }])

    let orderInsertCall
    const itemInsertCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          const s = String(sql)
          if (/INSERT INTO sale_orders/i.test(s)) {
            orderInsertCall = [s, params]
          }
          if (/SELECT\s+COALESCE\(SUM\(remaining_amount\)/i.test(s) && /FROM point_batches/i.test(s)) {
            return { rows: [{ balance: '1000' }], rowCount: 1 }
          }
          if (/INSERT INTO point_transactions/i.test(s)) {
            return { rows: [{ id: 101 }], rowCount: 1 }
          }
          if (/INSERT INTO sale_items/i.test(s)) {
            itemInsertCalls.push([s, params])
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-a', quantity: 1 }, { skuId: 'sku-b', quantity: 1 }],
      paymentMethod: '微信',
      usePoints: true,
    })
    await routes.create(ctx)

    expect(ctx.result.totalAmount).toBe(97.97)
    expect(ctx.result.pointsUsed).toBe(303)
    expect(ctx.result.pointsDiscount).toBe(3.03)
    expect(orderInsertCall[1][18]).toBe(303)
    expect(orderInsertCall[1][19]).toBe(3.03)
    expect(itemInsertCalls).toHaveLength(2)
    expect(Number(itemInsertCalls[0][1][11])).toBe(32.01)
    expect(Number(itemInsertCalls[1][1][11])).toBe(65.96)
    expect(
      Math.round(itemInsertCalls.reduce((sum, call) => sum + Number(call[1][11]), 0) * 100) / 100,
    ).toBe(ctx.result.totalAmount)
  })

  // ========== 折扣券路径 ==========

  test('折扣券无封顶：1000 × 8 折 → 抵扣 200', async () => {
    mockBaseCreateQueries({ price: '1000' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-disc-1', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '折扣券', discount_value: '0.8', min_spend: '0',
      max_discount: null,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-disc-1',
    })
    await routes.create(ctx)

    // 1000 × (1 - 0.8) = 200, totalAmount = 800
    expect(ctx.result.totalAmount).toBe(800)
    expect(ctx.result.status).toBe('待支付')

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })

  test('折扣券带封顶且触发封顶：1000 × 8 折 + 封顶 150 → 抵扣 150', async () => {
    mockBaseCreateQueries({ price: '1000' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-disc-2', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '折扣券', discount_value: '0.8', min_spend: '0',
      max_discount: '150',
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-disc-2',
    })
    await routes.create(ctx)

    // 原始折扣 200 > 封顶 150，取封顶 → totalAmount = 1000 - 150 = 850
    expect(ctx.result.totalAmount).toBe(850)

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })

  test('折扣券带封顶但未触发：500 × 8 折 + 封顶 150 → 抵扣 100', async () => {
    mockBaseCreateQueries({ price: '500' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-disc-3', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '折扣券', discount_value: '0.8', min_spend: '0',
      max_discount: '150',
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-disc-3',
    })
    await routes.create(ctx)

    // 500 × (1 - 0.8) = 100 < 封顶 150，取原折扣 → totalAmount = 500 - 100 = 400
    expect(ctx.result.totalAmount).toBe(400)

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })

  test('折扣券满减不满足 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries({ price: '500' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-disc-4', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '折扣券', discount_value: '0.8', min_spend: '600',
      max_discount: null,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      couponId: 'cpn-disc-4',
    })
    // 商品 ¥500 < 满减门槛 ¥600
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*未满足使用条件/)

    // 防回归：断言真实执行的 SELECT 包含 max_discount 字段，不靠 mock 塞值掩盖
    const couponSelectCall = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(couponSelectCall).toBeDefined()
    expect(couponSelectCall[0]).toMatch(/ct\.max_discount/)
  })
})

describe('order.pay', () => {
  // 微信支付走拉卡拉收银台：需 lakala env 就绪（isReady 真），lakala-client.request 已在 setup.js mock。
  // 局部设 env 避免泄漏到其它 describe / 文件。
  const LAKALA_ENV = {
    LAKALA_API_BASE: 'https://test.wsmsd.cn/sit/api',
    LAKALA_APPID: 'OP00000003',
    LAKALA_SERIAL_NO: '00dfba8194c41b84cf',
    LAKALA_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----',
    LAKALA_PLATFORM_CERT_PEM: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
    LAKALA_NOTIFY_URL: 'https://notify.test/lakala/notify',
    LAKALA_ALIPAY_SHARE_SOURCE: 'FENGYU',
    LAKALA_ENV: 'release',
  }
  const lakalaEnvSnapshot = {}
  beforeEach(() => {
    for (const [k, v] of Object.entries(LAKALA_ENV)) {
      lakalaEnvSnapshot[k] = process.env[k]
      process.env[k] = v
    }
  })
  afterEach(() => {
    for (const k of Object.keys(LAKALA_ENV)) {
      if (lakalaEnvSnapshot[k] === undefined) delete process.env[k]
      else process.env[k] = lakalaEnvSnapshot[k]
    }
  })

  // 门店拉卡拉商户行（resolveLakalaMerchant 的 SELECT 结果）
  const STORE_LAKALA_ROW = [{ merchant_no: 'M-TEST', term_no: 'T-TEST', enabled: true }]

  // 按 SQL 派发的 pg.query mock（对查询条数/顺序鲁棒，避免脆弱的 once 序列）
  function mockPayQueries({
    order,
    paidSum = 0,
    merchantRows = STORE_LAKALA_ROW,
    lockedOrderOverrides = {},
  }) {
    let activeOutTradeNo = order.lakala_out_order_no || null
    const transactionSql = []
    const lockedOrder = () => ({
      sale_order_type: '销售单',
      prepaid_card_amount: 0,
      pending_prepaid_card_amount: 0,
      received: paidSum,
      refunded_amount: 0,
      first_payment_amount: null,
      payable_amount: null,
      ...order,
      ...lockedOrderOverrides,
      lakala_out_order_no: activeOutTradeNo,
    })
    pg.transaction.mockImplementation(async (cb) => {
      const clientQuery = vi.fn(async (sql, params) => {
        transactionSql.push({ sql, params })
        if (/FROM sale_orders[\s\S]*FOR UPDATE/.test(sql)) {
          return { rows: [lockedOrder()], rowCount: 1 }
        }
        if (/FROM prepaid_cards[\s\S]*FOR UPDATE/.test(sql)) {
          return { rows: [{ balance: '99999.00' }], rowCount: 1 }
        }
        if (/lakala_merchants/.test(sql)) {
          return { rows: merchantRows, rowCount: merchantRows.length }
        }
        if (/SET lakala_out_order_no = \$1/.test(sql)) {
          activeOutTradeNo = params[0]
          return { rows: [{ sale_order_id: order.sale_order_id }], rowCount: 1 }
        }
        if (/SET client_user_id = CASE[\s\S]*payment_method = \$2/.test(sql)) {
          return { rows: [{ sale_order_id: order.sale_order_id }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      })
      return cb({ query: clientQuery })
    })
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [order]
      if (/SET lakala_out_order_no = NULL/.test(sql)) {
        activeOutTradeNo = null
        return [{ sale_order_id: order.sale_order_id }]
      }
      return []
    })
    return { transactionSql }
  }

  test('正常发起微信支付（聚合主扫 trans_type=71 直接返回 wx.requestPayment 5 字段）', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    // 聚合主扫：直接返回 wx.requestPayment 5 字段（不含 appId，appId 由小程序 context 决定）
    expect(ctx.result.paymentParams.timeStamp).toBe('1700000000')
    expect(ctx.result.paymentParams.nonceStr).toBe('mock-nonce-001')
    expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_mock_001')
    expect(ctx.result.paymentParams.signType).toBe('RSA')
    expect(ctx.result.paymentParams.paySign).toBe('mock-pay-sign-001')
    expect(ctx.result.paymentParams.appId).toBeUndefined()  // 微信文档不要求传 appId
    expect(ctx.result.lakala).toBeUndefined()  // 不再有 lakala.counterUrl
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.paidAmount).toBe(100)
    // 调聚合主扫：account_type=WECHAT / trans_type=71 / sub_appid=client appid / 金额（分，字符串）
    const args = __mocks__.lakalaClient.requestPreorder.mock.calls[0][0]
    expect(args.accountType).toBe('WECHAT')
    expect(args.transType).toBe('71')
    expect(args.subAppid).toBe('wx811eb4ded3dfba3f')
    expect(args.openid).toBe('test-openid-001')
    expect(args.totalAmountFen).toBe(10000)
    expect(args.merchantNo).toBe('M-TEST')
    expect(args.termNo).toBe('T-TEST')
  })

  test('充值单按 payable_amount 实付口径预下单，不按充值面额 total_amount 扣款', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-CZ-WX-001', status: '待支付', sale_order_type: '充值单', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 1000, payable_amount: 300,
        prepaid_card_amount: 0, pending_prepaid_card_amount: 0, received: 0, refunded_amount: 0,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-CZ-WX-001' })
    await routes.pay(ctx)

    expect(ctx.result.paidAmount).toBe(300)
    expect(__mocks__.lakalaClient.requestPreorder.mock.calls[0][0].totalAmountFen).toBe(30000)
  })

  test('门店已启用拉卡拉但未配商户号 → LAKALA_NOT_CONFIGURED（不再 fallback env 默认号）', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
        sale_order_datetime: now.toISOString(),
      },
      merchantRows: [{ merchant_no: null, term_no: null, enabled: true }],
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/LAKALA_NOT_CONFIGURED/)
    // 一店一商户：商户号 null → 视为未开通，不调拉卡拉
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('门店配了商户号但无终端号 → 抛 LAKALA_TERM_NO_MISSING（一店一商户、env 不兜底）', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
        sale_order_datetime: now.toISOString(),
      },
      merchantRows: [{ merchant_no: '82242107230052S', term_no: null, enabled: true }],
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/LAKALA_TERM_NO_MISSING/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('paid_amount=0（全额抵扣）直接短路返回已支付', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付',
        client_user_id: 'user-001', total_amount: 300, paid_amount: 0, prepaid_card_amount: 300,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.reason).toBe('prepaid_card_full')
    expect(ctx.result.paymentParams).toBeNull()
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付',
      client_user_id: 'other-user',    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('超时订单自动关闭', async () => {
    const expiredTime = new Date(Date.now() - 11 * 60 * 1000)
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付',
        client_user_id: 'user-001',        sale_order_datetime: expiredTime.toISOString(),
      }])
      .mockResolvedValueOnce([])

    // closeExpiredOrder 用 pg.transaction 关单：默认 transaction mock 给 rowCount=0
    // → 永远不抛超时。此处令 UPDATE sale_orders 返回 rowCount=1 模拟真关单成功。
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT\s+client_user_id/i.test(sql)) {
            return { rows: [{ client_user_id: 'user-001', points_used: 0 }], rowCount: 1 }
          }
          if (/UPDATE\s+sale_orders/i.test(sql)) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      }
      return await cb(client)
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS.*超时/)
  })

  // ========== PR-4: 部分支付 / payAmount 校验 / 不写 payments 行 ==========

  test('pay 发起成功后不写 payments 行（只更新 sale_orders.payment_method）', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
        prepaid_card_amount: 0,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    // 不应出现 INSERT INTO sale_order_payments
    const insertCall = pg.query.mock.calls.find(([sql]) =>
      /INSERT INTO sale_order_payments/.test(sql)
    )
    expect(insertCall).toBeUndefined()
  })

  test('pay 携带 payAmount 超过剩余应付 → INVALID_PARAMS', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 200, paid_amount: 200,
        prepaid_card_amount: 0,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001', payAmount: 500 })
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS.*超过剩余应付/)
  })

  test('pay 携带 payAmount ≤0 → INVALID_PARAMS', async () => {
    const now = new Date()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付',
      client_user_id: 'user-001', total_amount: 200, paid_amount: 200,
      prepaid_card_amount: 0,
      sale_order_datetime: now.toISOString(),
    }])
    pg.query.mockResolvedValueOnce([{ paid_sum: 0 }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001', payAmount: 0 })
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('pay 在 部分支付 状态下允许发起补款（按剩余应付 200-50=150）', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-001', status: '部分支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 200, paid_amount: 50,
        prepaid_card_amount: 0,
        sale_order_datetime: now.toISOString(),
      },
      paidSum: 50, // 已有首次支付 50 → 剩余应付 150
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    expect(ctx.result.paidAmount).toBe(150)
    // 聚合主扫下单金额 = 本次应付 150 元 → 15000 分
    const args = __mocks__.lakalaClient.requestPreorder.mock.calls[0][0]
    expect(args.totalAmountFen).toBe(15000)
    expect(ctx.result.paymentParams).toBeDefined()
  })

  test('普通转换首次部分支付以 first_payment_amount 为服务端硬上限', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-CONV-PARTIAL', status: '待支付', sale_order_type: '转换单', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 2000, payable_amount: 2000, received: 0,
        prepaid_card_amount: 0, first_payment_amount: 500,
        sale_order_datetime: now.toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-CONV-PARTIAL' })
    await routes.pay(ctx)

    expect(ctx.result.paidAmount).toBe(500)
    expect(__mocks__.lakalaClient.requestPreorder.mock.calls[0][0].totalAmountFen).toBe(50000)
    expect(pg.query.mock.calls.some(([sql]) => String(sql).includes('first_payment_amount = NULL'))).toBe(false)

    vi.clearAllMocks()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-CONV-PARTIAL-2', status: '待支付', sale_order_type: '转换单', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 2000, payable_amount: 2000, received: 0,
        prepaid_card_amount: 0, first_payment_amount: 500,
        sale_order_datetime: now.toISOString(),
      },
    })
    const tamperedCtx = createBoundCtx({ orderNo: 'FY-CONV-PARTIAL-2', payAmount: 600 })
    await expect(routes.pay(tamperedCtx)).rejects.toThrow(/INVALID_PARAMS.*超过剩余应付/)
  })

  test('事务外旧快照 cap=NULL，锁内 cap=500 → 只按锁内金额预占并创建 500 元渠道单', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-CONV-CAP-RACE', status: '待支付', sale_order_type: '转换单', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 2000, payable_amount: 2000, received: 0,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0, first_payment_amount: null,
      sale_order_datetime: now.toISOString(),
    }
    const captured = mockPayQueries({
      order,
      lockedOrderOverrides: { first_payment_amount: 500 },
    })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id })
    await routes.pay(ctx)

    expect(ctx.result.paidAmount).toBe(500)
    expect(__mocks__.lakalaClient.requestPreorder.mock.calls[0][0].totalAmountFen).toBe(50000)
    const plan = captured.transactionSql.find(({ sql }) => /SET client_user_id = CASE/.test(sql))
    expect(plan.sql).toContain('lakala_out_order_no = $5')
    expect(plan.params[4]).toBe(__mocks__.lakalaClient.requestPreorder.mock.calls[0][0].outTradeNo)
  })

  test('受限 cap=500 时拒绝客户端下调为 400，避免渠道金额与回调冻结额不一致', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-CONV-CAP-LOW', status: '待支付', sale_order_type: '转换单', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 2000, payable_amount: 2000, received: 0,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0, first_payment_amount: null,
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order, lockedOrderOverrides: { first_payment_amount: 500 } })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id, payAmount: 400 })
    await expect(routes.pay(ctx)).rejects.toThrow(/支付金额必须等于本次冻结金额/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('事务外旧 received/pending 不参与下单：锁内资金已变化时拒绝按旧欠款预下单', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-PAY-SNAPSHOT-RACE', status: '部分支付', sale_order_type: '销售单', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 1000, payable_amount: 1000,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0, received: 0, refunded_amount: 0,
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({
      order,
      lockedOrderOverrides: { pending_prepaid_card_amount: 100, received: 200 },
    })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id, payAmount: 1000 })
    await expect(routes.pay(ctx)).rejects.toThrow(/支付金额超过剩余应付/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('受限回款已有活动拉卡拉意图 → CONFLICT，不创建第二个预下单', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const now = new Date()
    const order = {
      sale_order_id: 'FY-CONV-ACTIVE', status: '部分支付', sale_order_type: '转换单', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 2000, payable_amount: 2000, received: 500,
      prepaid_card_amount: 0, first_payment_amount: 500,
      lakala_out_order_no: 'FY-CONV-ACTIVE_1770000000',
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order, paidSum: 500 })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id, payAmount: 500 })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
    expect(pg.query.mock.calls.some(([sql]) => /SET client_user_id = CASE|SET payment_method/.test(sql))).toBe(false)
  })

  test('支付宝已有活动拉卡拉意图 → 在写 payment_method/顾客绑定前拒绝', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const now = new Date()
    const order = {
      sale_order_id: 'FY-ALI-ACTIVE', status: '待支付', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
      lakala_out_order_no: 'FY-ALI-ACTIVE_1770000000',
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id })
    await expect(routes.alipayPay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
    expect(pg.query.mock.calls.some(([sql]) => /SET payment_method = '支付宝'/.test(sql))).toBe(false)
  })

  // ===== #214 中断支付后「继续支付」：复用同一笔渠道场次 =====
  // 复用而非「关旧单建新单」：后者在关单失败时会留下两笔可支付的单，旧单一旦被付款，
  // payNotify 的「非当前拉卡拉意图」校验会拒绝入账 → 钱收了订单不动。
  function reusableOrder(overrides = {}, intentOverrides = {}) {
    const outTradeNo = 'FY-REUSE-001_1770000000'
    return {
      sale_order_id: 'FY-REUSE-001', status: '待支付', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 298, payable_amount: 298,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
      lakala_out_order_no: outTradeNo,
      sale_order_datetime: new Date().toISOString(),
      lakala_payment_intent: {
        outTradeNo,
        expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        paymentMethod: '微信',
        payAmount: 298,
        paymentParams: {
          timeStamp: '1760000000', nonceStr: 'reuse-nonce',
          package: 'prepay_id=wx_reuse_001', signType: 'RSA', paySign: 'reuse-sign',
        },
        ...intentOverrides,
      },
      ...overrides,
    }
  }

  test('命中有效场次快照 → 复用原 paymentParams，不再向渠道下单 (#214)', async () => {
    mockPayQueries({ order: reusableOrder() })
    // 复用前会查一次渠道确认这笔场次还没被支付
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await routes.pay(ctx)

    expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_reuse_001')
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  // round-16：前端此前只能读自己的页面状态来冻结展示口径，而从发起 order.pay 到它返回
  // 的这段时间里，异步的余额刷新或用户拨动都可能已经改掉那份状态——照着改完的状态冻结，
  // 记下的就是一个渠道单里根本不存在的金额，展示与实收分叉。
  // 这笔渠道单实际预占多少卡额，只有服务端说了算。
  test('pay 必须下发这笔渠道单实际预占的待扣卡额 (#214)', async () => {
    mockPayQueries({
      order: reusableOrder(
        { pending_prepaid_card_amount: 98, payable_amount: 200 },
        { payAmount: 200 },
      ),
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await routes.pay(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(98)
    expect(ctx.result.paidAmount).toBe(200)
  })

  // 顾客已付款但回调还没入账时立刻重新扫码：不查渠道就回发旧参数，前端会去唤起一笔
  // 已成功的场次，顾客只能得到误导性失败或无尽等待。
  test('复用前发现渠道已支付 → 拒绝复用并提示刷新 (#214)', async () => {
    mockPayQueries({ order: reusableOrder() })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'SUCCESS' })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PAYMENT_ALREADY_SUCCEEDED/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  // 关单成功但复核那一跳超时时，fail-closed 会保留意图与快照。此时复用会回发一个
  // **已死亡**的场次，顾客每次重试都命中同一快照反复失败，直到快照过期才自愈——
  // 正是本 issue 要消灭的卡死的短时复刻（双谱系评审 round-2 发现）。
  test('快照对应的渠道场次已终态 → 释放意图并重建新场次，不回发死场次 (#214)', async () => {
    mockPayQueries({ order: reusableOrder() })
    // 复用前查单：渠道已 CLOSE（本地意图没来得及释放）
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await routes.pay(ctx)

    // 不再回发快照里的旧参数，而是重新向渠道下单
    expect(__mocks__.lakalaClient.requestPreorder).toHaveBeenCalled()
    expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_mock_001')
    // 释放走的是按单号 CAS
    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))).toBe(true)
  })

  // 查单失败时放行复用：复用的是同一笔渠道单，渠道对已支付场次本身会拒绝二次付款，
  // 不存在重复扣款；拒绝反而会让顾客重新卡在「发不了新支付」上。
  test('复用前查单失败 → 降级放行，仍回发原参数 (#214)', async () => {
    mockPayQueries({ order: reusableOrder() })
    __mocks__.lakalaClient.queryTrade.mockRejectedValueOnce(new Error('INVALID_STATE: LAKALA_TIMEOUT_30000ms'))

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await routes.pay(ctx)

    expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_reuse_001')
  })

  // round-11：快照不可复用、但渠道单仍活着（例如支付宝吱口令先于 10 分钟预下单过期）时，
  // 此前只在渠道已终态才释放 → 顾客还是只能干等渠道超时，本 issue 的症状原样复现。
  // 现在改走与取消/关单同一套 fail-closed 作废：关单 + 复核终态后释放并重建新场次。
  test('快照不可复用但渠道仍 CREATE → 主动关单释放后重建新场次 (#214)', async () => {
    mockPayQueries({
      order: reusableOrder({}, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    })
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })   // 作废前查单：仍可支付
      .mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })    // 关单后复核：已终态

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await routes.pay(ctx)

    // 关掉了旧场次
    expect(__mocks__.lakalaClient.closeTrade).toHaveBeenCalled()
    // 并重新向渠道下了一单（不是回发旧快照）
    expect(__mocks__.lakalaClient.requestPreorder).toHaveBeenCalled()
    expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_mock_001')
  })

  // round-12：预占意图与落快照之间隔着一次渠道预下单往返。这段窗口里意图「有单号没快照」，
  // 看起来和「快照残缺该作废」一样——此时另一请求若直接关单，会把前一个请求正在建的
  // 渠道单关掉，它返回给前端的支付参数就已经死了。
  test('意图刚预占、快照未落（创建中）→ 不作废，只 fail-fast 让调用方重试 (#214)', async () => {
    mockPayQueries({
      order: {
        sale_order_id: 'FY-CREATING', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
        lakala_out_order_no: 'FY-CREATING_1770000000',
        lakala_payment_intent: null,               // 快照还没落
        updated_at: new Date().toISOString(),      // 刚刚预占
        sale_order_datetime: new Date().toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-CREATING' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PAYMENT_INTENT_ACTIVE/)
    // 关键：一笔渠道请求都不该发出去
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  // round-13：这个闸门最初写在 try 里，抛出的 PAYMENT_INTENT_CHANGED 被自己的 catch
  // 接住、降级成了 PAYMENT_INTENT_ACTIVE —— 新设计的可重试错误成了不可达代码。
  test('作废耗时过长 → 本次不重建，返回可重试的 PAYMENT_INTENT_CHANGED (#214)', async () => {
    mockPayQueries({
      order: reusableOrder({}, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    })
    const payQueryImpl = pg.query.getMockImplementation()
    pg.query.mockImplementation(async (sql, params) => {
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return payQueryImpl(sql, params)
    })
    // 作废本身成功，但把预算耗光（每跳都慢）
    __mocks__.lakalaClient.queryTrade
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 60))
        return { ok: true, tradeState: 'CREATE' }
      })
      .mockImplementationOnce(async () => ({ ok: true, tradeState: 'CLOSE' }))
    // 把阈值压到 50ms，让上面那一跳必然超预算
    const routesModule = require('../../routes/order')
    const originalNow = Date.now
    let call = 0
    Date.now = () => originalNow() + (++call > 2 ? 60000 : 0)   // 作废后时间跳到超预算
    try {
      const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
      await expect(routesModule.pay(ctx)).rejects.toThrow(/PAYMENT_INTENT_CHANGED/)
    } finally {
      Date.now = originalNow
    }
    // 关键：旧场次确实被关掉了（不是「作废失败」那条路）
    expect(__mocks__.lakalaClient.closeTrade).toHaveBeenCalled()
    // 且没有去建新场次
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('意图无快照但已过宽限期 → 按不可复用处理，走主动作废 (#214)', async () => {
    mockPayQueries({
      order: {
        sale_order_id: 'FY-STALE', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
        lakala_out_order_no: 'FY-STALE_1770000000',
        lakala_payment_intent: null,
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),  // 5 分钟前
        sale_order_datetime: new Date().toISOString(),
      },
    })
    const payQueryImpl = pg.query.getMockImplementation()
    pg.query.mockImplementation(async (sql, params) => {
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return payQueryImpl(sql, params)
    })
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })

    const ctx = createBoundCtx({ orderNo: 'FY-STALE' })
    await routes.pay(ctx)

    expect(__mocks__.lakalaClient.closeTrade).toHaveBeenCalled()
    expect(__mocks__.lakalaClient.requestPreorder).toHaveBeenCalled()
  })

  test('旧场次已被支付 → 如实报「支付已成功」，不再含糊说「请勿重复发起」 (#214)', async () => {
    mockPayQueries({
      order: reusableOrder({}, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'SUCCESS' })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PAYMENT_ALREADY_SUCCEEDED/)
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  test('快照已过期 → 不复用，回到 PAYMENT_INTENT_ACTIVE (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({
      order: reusableOrder({}, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('快照剩余有效期不足 1 分钟 → 不复用（顾客来不及输密码） (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({
      order: reusableOrder({}, { expiresAt: new Date(Date.now() + 30 * 1000).toISOString() }),
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
  })

  test('快照单号与当前意图不一致 → 不复用（残留快照自动失效） (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({
      order: reusableOrder({}, { outTradeNo: 'FY-REUSE-001_1760000000' }),
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
  })

  // paymentParams 里的 prepay_id 绑定的是建单那位顾客的 openid。回发给第二个人不但
  // 泄漏他的 paySign，对方 wx.requestPayment 还必然失败，且有效期内每次重试都命中同一
  // 快照 → 这张单对他永久不可支付。（pr-ready 边界审计发现）
  test('快照归属他人 → 不复用，不泄漏 paySign (#214)', async () => {
    mockPayQueries({ order: reusableOrder({ client_user_id: 'user-999' }) })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PERMISSION_DENIED|PAYMENT_INTENT_ACTIVE/)
  })

  test('员工开单尚未认领（client_user_id 为空）→ 不复用任何快照 (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({
      order: reusableOrder({ client_user_id: null, opened_by: 'emp-001' }),
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
    expect(__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('快照金额与本次应付不符 → 不复用 (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({ order: reusableOrder({}, { payAmount: 100 }) })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
  })

  test('微信场次不被支付宝通道复用 (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({ order: reusableOrder() })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.alipayPay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
  })

  test('首次预下单成功后落盘场次快照，锚当前 out_trade_no (#214)', async () => {
    mockPayQueries({
      order: {
        sale_order_id: 'FY-SNAP-001', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
        sale_order_datetime: new Date().toISOString(),
      },
    })

    const ctx = createBoundCtx({ orderNo: 'FY-SNAP-001' })
    await routes.pay(ctx)

    const snapCall = pg.query.mock.calls.find(([sql]) => /SET lakala_payment_intent = \$1/.test(sql))
    expect(snapCall).toBeDefined()
    const snapshot = JSON.parse(snapCall[1][0])
    expect(snapshot.paymentMethod).toBe('微信')
    expect(snapshot.payAmount).toBe(100)
    expect(snapshot.paymentParams.package).toBe('prepay_id=wx_mock_001')
    expect(snapshot.outTradeNo).toBe(snapCall[1][2])  // CAS 锚与快照内单号一致
    expect(new Date(snapshot.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  // preorder 已在渠道侧建单（CREATE），但吱口令没拿到 → 意图活跃却无快照可复用。
  // 不释放的话顾客重试只会撞 PAYMENT_INTENT_ACTIVE，得等渠道超时才自愈
  // （双谱系评审 round-5）。
  test('支付宝吱口令失败 → 安全释放意图后再抛，不把订单锁死 (#214)', async () => {
    const now = new Date()
    mockPayQueries({
      order: {
        sale_order_id: 'FY-ALI-SC', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
        sale_order_datetime: now.toISOString(),
      },
    })
    // 安全释放在事务外解析商户（mockPayQueries 只 mock 了事务内那条），这里补上
    const payQueryImpl = pg.query.getMockImplementation()
    pg.query.mockImplementation(async (sql, params) => {
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return payQueryImpl(sql, params)
    })
    __mocks__.lakalaClient.requestAlipayShareCode.mockRejectedValueOnce(
      new Error('INVALID_STATE: LAKALA_TIMEOUT_30000ms'),
    )
    // 安全释放走 fail-closed：查单确认渠道已终态后释放
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })

    const ctx = createBoundCtx({ orderNo: 'FY-ALI-SC' })
    await expect(routes.alipayPay(ctx)).rejects.toThrow(/LAKALA_TIMEOUT/)

    // 释放确实发生了（按本次单号 CAS）
    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))).toBe(true)
  })

  // 渠道回了成功码但支付参数残缺：此时渠道单很可能已建好、本地意图已占。
  // 不拦就会落盘一份不可用的快照，顾客每次重试都复用它、每次都失败，直到场次过期
  // （双谱系评审 round-7）。
  test('预下单返回成功但缺 paySign → 安全释放后抛，不落畸形快照 (#214)', async () => {
    mockPayQueries({
      order: {
        sale_order_id: 'FY-INCOMPLETE', status: '待支付', store_id: 'store-1',
        client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
        sale_order_datetime: new Date().toISOString(),
      },
    })
    const payQueryImpl = pg.query.getMockImplementation()
    pg.query.mockImplementation(async (sql, params) => {
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return payQueryImpl(sql, params)
    })
    __mocks__.lakalaClient.requestPreorder.mockResolvedValueOnce({
      ok: true, code: 'BBS00000', tradeNo: 'LAK-T', logNo: 'L',
      paymentParams: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x' },  // 缺 paySign
      lakalaAppId: 'wx811eb4ded3dfba3f', raw: {},
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })

    const ctx = createBoundCtx({ orderNo: 'FY-INCOMPLETE' })
    await expect(routes.pay(ctx)).rejects.toThrow(/LAKALA_PREORDER_INCOMPLETE/)

    // 没有落下任何快照
    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_payment_intent/.test(sql))).toBe(false)
    // 意图已被安全释放
    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))).toBe(true)
  })

  test('历史畸形快照（缺 paySign）不被复用 (#214)', async () => {
    // #214（round-11）：不复用时会走 fail-closed 主动作废——渠道仍 CREATE 且关单后
    // 复核仍非终态 → 保留 PAYMENT_INTENT_ACTIVE（关不掉就不放行）
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    mockPayQueries({
      order: reusableOrder({}, {
        paymentParams: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x' },  // 缺 paySign
      }),
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REUSE-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
  })

  test('preorder 明确业务失败 → 按本次 out_trade_no CAS 释放意图', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-PREORDER-FAIL', status: '待支付', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order })
    __mocks__.lakalaClient.requestPreorder.mockRejectedValueOnce(
      new Error('INVALID_STATE: LAKALA_PREORDER_FAILED: BBS12345')
    )

    const ctx = createBoundCtx({ orderNo: order.sale_order_id })
    await expect(routes.pay(ctx)).rejects.toThrow(/LAKALA_PREORDER_FAILED/)

    const release = pg.query.mock.calls.find(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))
    expect(release).toBeDefined()
    expect(release[1][0]).toBe(order.sale_order_id)
    expect(release[1][1]).toMatch(/^FY-PREORDER-FAIL_\d+$/)
  })

  test('preorder 网络结果不确定 → 保留意图，不创建第二笔', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-PREORDER-UNKNOWN', status: '待支付', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order })
    __mocks__.lakalaClient.requestPreorder.mockRejectedValueOnce(
      new Error('INVALID_STATE: LAKALA_TIMEOUT_30000ms')
    )

    const ctx = createBoundCtx({ orderNo: order.sale_order_id })
    await expect(routes.pay(ctx)).rejects.toThrow(/LAKALA_TIMEOUT/)
    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))).toBe(false)
  })

  test('已有意图查询为 CLOSE → CAS 释放旧单后允许重新占位', async () => {
    const now = new Date()
    const order = {
      sale_order_id: 'FY-RETRY-CLOSED', status: '待支付', store_id: 'store-1',
      client_user_id: 'user-001', total_amount: 100, payable_amount: 100,
      prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
      lakala_out_order_no: 'FY-RETRY-CLOSED_1700000000',
      sale_order_datetime: now.toISOString(),
    }
    mockPayQueries({ order })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })

    const ctx = createBoundCtx({ orderNo: order.sale_order_id })
    await routes.pay(ctx)

    expect(pg.query.mock.calls.some(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))).toBe(true)
    expect(__mocks__.lakalaClient.requestPreorder).toHaveBeenCalledTimes(1)
    expect(__mocks__.lakalaClient.requestPreorder.mock.calls[0][0].outTradeNo)
      .not.toBe(order.lakala_out_order_no)
  })
})

describe('order.offlinePay', () => {
  test('正常选择线下付款', async () => {
    const now = new Date()
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付',
        client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
        sale_order_datetime: now.toISOString(),
      }])
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.offlinePay(ctx)

    expect(ctx.result.status).toBe('待支付')
  })

  test('全额抵扣（paid_amount=0）直接短路返回已支付', async () => {
    const now = new Date()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付',
      client_user_id: 'user-001', total_amount: 300, paid_amount: 0, prepaid_card_amount: 300,
      sale_order_datetime: now.toISOString(),
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.offlinePay(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.reason).toBe('prepaid_card_full')
  })

  test('非待支付订单 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付',
      client_user_id: 'user-001', total_amount: 100, paid_amount: 100,
      sale_order_datetime: new Date().toISOString(),
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.offlinePay(ctx)).rejects.toThrow(/INVALID_PARAMS.*状态不允许/)
  })
})

describe('order.list', () => {
  test('返回用户订单列表（含商品封面图和实收金额）', async () => {
    // page=1 触发 closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '已支付', total_amount: 100 },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', sale_item_id: 'SI-001', product_name: 'A', received: 95, cover_image: COS_COVER_URL },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.hasMore).toBe(false)
    expect(ctx.result.orders[0].items).toHaveLength(1)
    // issue #230：订单列表行封面 96rpx → 小档 400
    expect(ctx.result.orders[0].items[0].cover_image).toBe(`${COS_COVER_URL}?imageMogr2/thumbnail/400x400`)
    expect(ctx.result.orders[0].items[0].received).toBe(95)

    // 验证 SQL 包含 LIMIT/OFFSET 分页参数
    const listQuery = pg.query.mock.calls[1][0]
    expect(listQuery).toContain('LIMIT')
    expect(listQuery).toContain('OFFSET')

    // 验证明细查询 SQL 包含 received、cover_image JOIN
    const itemsQuery = pg.query.mock.calls[2][0]
    expect(itemsQuery).toContain('si.received')
    expect(itemsQuery).toContain('cover_image')
    expect(itemsQuery).toContain('product_skus')
  })

  test('hasMore=true 当结果超过 pageSize', async () => {
    pg.query.mockResolvedValueOnce([])
    // 返回 pageSize+1 条（默认 20+1=21 条），表示有下一页
    const orders = Array.from({ length: 21 }, (_, i) => ({
      sale_order_id: `FY-${String(i).padStart(3, '0')}`, status: '已支付', total_amount: 100,
    }))
    pg.query.mockResolvedValueOnce(orders)
    // items 查询（对 20 条订单的明细）
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.orders).toHaveLength(20)
    expect(ctx.result.hasMore).toBe(true)
  })

  test('page=2 跳过 closeExpiredOrdersByUser', async () => {
    pg.query.mockResolvedValueOnce([])  // 订单查询

    const ctx = createBoundCtx({ page: 2, pageSize: 10 })
    await routes.list(ctx)

    // page=2 不触发 closeExpired，只有 1 次 query（订单查询）
    expect(pg.query).toHaveBeenCalledTimes(1)
    // 验证 OFFSET 参数
    const params = pg.query.mock.calls[0][1]
    expect(params).toContain(10)  // offset = (2-1) * 10 = 10
  })

  test('按状态筛选', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ status: '已关闭' })
    await routes.list(ctx)

    const listCall = pg.query.mock.calls[1]
    expect(listCall[0]).toContain('o.status = $')
    expect(listCall[1]).toContain('已关闭')
  })
})

describe('order.detail', () => {
  test('返回订单详情（含商品封面图）', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付',
      client_user_id: 'user-001',
      sale_order_datetime: new Date().toISOString(),
      preferred_employee_id: null, coupon_id: null,
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', product_name: 'A',
      cover_image: COS_COVER_URL,
    }])
    // payments 并行查询（无明星员工 / 无券 → 但 payments 仍查询）
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
    // issue #230：订单详情行封面 120rpx → 小档 400
    expect(ctx.result.items[0].cover_image).toBe(`${COS_COVER_URL}?imageMogr2/thumbnail/400x400`)
    expect(ctx.result.payments).toEqual([])

    // 验证明细查询 SQL 包含 cover_image JOIN
    const itemsQuery = pg.query.mock.calls[1][0]
    expect(itemsQuery).toContain('cover_image')
    expect(itemsQuery).toContain('product_skus')
  })

  test('issue #230：非 COS 域名的封面下发 null，不退回原图', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付',
      client_user_id: 'user-001',
      sale_order_datetime: new Date().toISOString(),
      preferred_employee_id: null, coupon_id: null,
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', product_name: 'A',
      cover_image: NON_COS_COVER_URL,
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    // 退回原图 = 保护静默失效：调用方看不出区别，而那张图可能正是会撑爆进程的巨图
    expect(ctx.result.items[0].cover_image).toBeNull()
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ orderNo: 'nonexistent' })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })

  test('detail 返回 payments 数组（款项流水）', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '部分支付',
      client_user_id: 'user-001',
      sale_order_datetime: new Date().toISOString(),
      preferred_employee_id: null, coupon_id: null,
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', product_name: 'A', cover_image: '',
    }])
    pg.query.mockResolvedValueOnce([]) // item refunded map 查询
    // payments 查询
    pg.query.mockResolvedValueOnce([
      {
        change_type: '首次支付', amount: '100.00', payment_method: '微信',
        status: '已支付', paid_at: new Date('2026-04-24T10:00:00Z'),
        created_at: new Date('2026-04-24T10:00:00Z'), note: '微信 回调到账',
      },
      {
        change_type: '回款', amount: '200.00', payment_method: '微信',
        status: '已支付', paid_at: new Date('2026-04-24T11:00:00Z'),
        created_at: new Date('2026-04-24T11:00:00Z'), note: '补款',
      },
    ])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    expect(ctx.result.payments).toHaveLength(2)
    expect(ctx.result.payments[0].change_type).toBe('首次支付')
    expect(ctx.result.payments[0].amount).toBe(100)
    expect(ctx.result.payments[1].change_type).toBe('回款')
    expect(ctx.result.payments[1].amount).toBe(200)

    // 验证 SQL 查了 sale_order_payments 表（合并后无需 JOIN，note/refund_reason 直接在主表）
    const paymentsQueryCall = pg.query.mock.calls.find(
      ([sql]) => /SELECT id, change_type, amount, payment_method, status/.test(sql)
    )
    expect(paymentsQueryCall).toBeDefined()
    expect(paymentsQueryCall[0]).toMatch(/ORDER BY created_at ASC/)
    expect(paymentsQueryCall[0]).not.toContain('sale_order_payment_details')
  })
})

/**
 * issue #215：顾客端的支付倒计时必须只在「这一刻的懒清理真会关掉它」时出现。
 *
 * 原本 order.detail 只看 status 就按「下单时间 + 10 分钟」下发 expire_at，
 * 而 closeExpiredOrder 还有另外两条守卫（员工单 / 在途支付意图）。两边一错开，
 * 顾客就看着一个永远不会兑现的倒计时，且 order-detail 的「归零重载」会因为
 * 状态永远不变而按网络 RTT 持续打 order.detail。
 *
 * ⚠️ 判据本身（`PENDING_AUTO_CLOSE_GUARD_SQL`）由 PostgreSQL 求值，L1 的 pg mock
 * 喂什么有什么，**测不到谓词语义**。那部分由两件事守：
 *   1. 下面「与 closeExpiredOrder 的 UPDATE 守卫同源」那条做条件列表全等比较；
 *   2. 真库直验（2026-09-22 实测 10 例：只有
 *      `待支付 + opened_by IS NULL + lakala_out_order_no IS NULL` 判 true，
 *      空串 / 纯空白 / 其余状态一律 false，与 SQL 的 IS NULL 语义逐例一致）。
 * 本 describe 测的是「服务端如何由 auto_close_eligible 推导出 expire_at」这段 JS。
 */
describe('order.detail — 支付倒计时下发口径 (#215)', () => {
  const TEN_MIN_MS = 10 * 60 * 1000
  // 刚下单（未过期）——不触发懒清理分支，专注断言下发口径
  const FRESH_ORDER_TIME = new Date(Date.now() - 60 * 1000).toISOString()

  function mockDetailQueries(orderOverrides, refreshOverrides = orderOverrides) {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-215',
      client_user_id: 'user-001',
      sale_order_datetime: FRESH_ORDER_TIME,
      preferred_employee_id: null,
      coupon_id: null,
      status: '待支付',
      opened_by: null,
      lakala_out_order_no: null,
      ...orderOverrides,
    }])
    pg.query.mockResolvedValueOnce([])  // items
    pg.query.mockResolvedValueOnce([])  // 行级退款额
    pg.query.mockResolvedValueOnce([])  // payments
    // 可支付态一定会发重读查询，而生产里它**恒返回一行**（订单行就在那）。
    // 不喂的话会吃到全局默认的 `[]`，L1 就永远在「重读落空」这个非生产形态下跑，
    // 日后谁在「重读有行」路径上加逻辑就测不到了（双谱系评审 round-7）。
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-215',
      sale_order_datetime: FRESH_ORDER_TIME,
      status: '待支付',
      opened_by: null,
      lakala_out_order_no: null,
      ...refreshOverrides,
    }])
  }

  /**
   * 找出「重读判据列」那一次查询。
   * ⚠️ 判别式不能用「有没有 JOIN stores」—— 重读现在也 JOIN（要和主查询同口径拿
   * 当前门店名）。改为「**第一次之后**带 auto_close_eligible 的那次」：
   * 主查询恒为 calls[0]。
   */
  const findRefreshCall = () => pg.query.mock.calls
    .slice(1)
    .find(([sql]) => /AS auto_close_eligible/.test(sql))


  test('库判「会被自动关闭」→ 下发「下单时间 + 10 分钟」', async () => {
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order.expire_at).toBe(
      new Date(new Date(FRESH_ORDER_TIME).getTime() + TEN_MIN_MS).toISOString()
    )
  })

  test('库判「关不掉」→ 不下发 expire_at', async () => {
    mockDetailQueries({ auto_close_eligible: false, opened_by: 'E001' })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order.expire_at).toBeNull()
  })

  test('auto_close_eligible 是服务端中间量，不下发给前端', async () => {
    // 下发出去就会诱使前端拿它自己推导展示口径——前端要用的就是 expire_at 本身
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order).not.toHaveProperty('auto_close_eligible')
    expect(ctx.result.order).not.toHaveProperty('lakala_payment_intent')
  })

  test('主查询必须把判据作为 auto_close_eligible 一起取回', async () => {
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    const ordersSql = pg.query.mock.calls[0][0]
    expect(ordersSql).toContain('AS auto_close_eligible')
    expect(ordersSql).toContain("o.status = '待支付'")
    expect(ordersSql).toContain('o.opened_by IS NULL')
    expect(ordersSql).toContain('o.lakala_out_order_no IS NULL')
  })

  test('生产形态：sale_order_datetime 是 Date 对象时同样算得出 expire_at', async () => {
    // 线上 pg 对 timestamptz(1184) 直出 JS Date；上面的用例喂的是 ISO 字符串，
    // 两种输入都得走通，不然哪天 mock 与生产分叉了也看不出来
    const at = new Date(Date.now() - 60 * 1000)
    mockDetailQueries({ auto_close_eligible: true, sale_order_datetime: at })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order.expire_at).toBe(new Date(at.getTime() + TEN_MIN_MS).toISOString())
  })

  test('同时下发服务端算好的剩余毫秒（前端不拿设备时钟比绝对时间）', async () => {
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    // 下单于 60 秒前 → 还剩约 9 分钟
    expect(ctx.result.order.expire_in_ms).toBeGreaterThan(8.5 * 60 * 1000)
    expect(ctx.result.order.expire_in_ms).toBeLessThanOrEqual(9 * 60 * 1000)
  })

  test('协议字段齐全：正常倒计时响应必须同时带 expire_in_ms / expire_clock / expire_unresolved / server_elapsed_ms', async () => {
    // 前端测试是自己伪造这几个字段的，后端这边不断言的话，服务端漏发或改名时两边同时绿。
    // 尤其 expire_unresolved 丢了：补关失败的过期单会被成功刷新解除支付闸门，
    // 重新显示「去支付」，然后被支付接口以超时拒绝 —— 本 issue 的矛盾态复发。
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    const o = ctx.result.order
    expect(o).toHaveProperty('expire_in_ms')
    expect(o).toHaveProperty('expire_clock')
    expect(o).toHaveProperty('expire_unresolved')
    expect(o).toHaveProperty('server_elapsed_ms')
    expect(typeof o.expire_in_ms).toBe('number')
    expect(o.expire_in_ms).toBeGreaterThan(0)          // 权威值恒为严格正数
    expect(o.expire_clock).toMatch(/^\d{2}:\d{2}$/)
    expect(o.expire_unresolved).toBe(false)
    expect(typeof o.server_elapsed_ms).toBe('number')
    expect(o.server_elapsed_ms).toBeGreaterThanOrEqual(0)
  })

  test('降级响应：补关两次都没关掉 → expire_unresolved=true，两个时限字段为 null', async () => {
    // 这是 expire_unresolved 唯一存在的理由：把它和「旧云函数根本不发这些字段」区分开，
    // 前端对这两者的处理正好相反（前者才封支付入口，后者连文案都不该改）。
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    const eligibleRow = {
      sale_order_id: 'FY-215', client_user_id: 'user-001',
      sale_order_datetime: stale, preferred_employee_id: null, coupon_id: null,
      status: '待支付', opened_by: null, lakala_out_order_no: null,
      auto_close_eligible: true,
    }
    pg.query.mockResolvedValueOnce([eligibleRow])
    pg.query.mockResolvedValueOnce([])  // items
    pg.query.mockResolvedValueOnce([])  // 行级退款额
    pg.query.mockResolvedValueOnce([])  // payments
    // 重读与两次补关复读都仍然「可关且已过期」——补关被并发意图连着挤掉
    pg.query.mockResolvedValue([eligibleRow])

    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order.expire_unresolved).toBe(true)
    expect(ctx.result.order.expire_in_ms).toBeNull()
    expect(ctx.result.order.expire_clock).toBeNull()
    // 开头的懒清理 1 次 + 补关循环 2 次 = 3。写成 `>= 2` 是测不出「循环退化成一次」的
    // ——那时总数仍是 2（开头 1 + 补关 1），断言照样绿（双谱系评审 round-19）。
    expect(pg.transaction).toHaveBeenCalledTimes(3)
  })

  test('主查询时有在途意图、重读时意图已释放 → 补关循环独自跑满两次', async () => {
    // 上一条里开头那次懒清理也会计数，掩盖了「循环上限」本身。这里让主查询带着
    // 在途支付意图（auto_close_eligible=false）进来，开头的懒清理因此被跳过，
    // 于是**每一次事务都只可能来自补关循环** —— 把 `attempt < 2` 改成 `attempt < 1`
    // 立刻报红。这个时序在生产里真实存在：预下单失败会在两次查询之间清掉
    // lakala_out_order_no，订单从「关不掉」变回「该关」。
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-215', client_user_id: 'user-001',
      sale_order_datetime: stale, preferred_employee_id: null, coupon_id: null,
      status: '待支付', opened_by: null, lakala_out_order_no: 'LKL-INFLIGHT',
      auto_close_eligible: false,
    }])
    pg.query.mockResolvedValueOnce([])  // items
    pg.query.mockResolvedValueOnce([])  // 行级退款额
    pg.query.mockResolvedValueOnce([])  // payments
    // 重读与两次补关复读：意图已被清掉，单子重新「可关且已过期」，但 CAS 始终没关成
    pg.query.mockResolvedValue([{
      sale_order_id: 'FY-215', client_user_id: 'user-001',
      sale_order_datetime: stale, status: '待支付',
      opened_by: null, lakala_out_order_no: null, auto_close_eligible: true,
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(pg.transaction).toHaveBeenCalledTimes(2)
    expect(ctx.result.order.expire_unresolved).toBe(true)
    expect(ctx.result.order.expire_in_ms).toBeNull()
  })

  test('不下发 expire_at 时 expire_in_ms 也为 null', async () => {
    mockDetailQueries({ auto_close_eligible: false, opened_by: 'E001' })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(ctx.result.order.expire_at).toBeNull()
    expect(ctx.result.order.expire_in_ms).toBeNull()
  })

  test('重读查询必须带 client_user_id 归属条件（否则是跨顾客越权读）', async () => {
    // 这行结果会被 Object.assign **整行**合进要下发的 order。只按订单号重读的话，
    // 「管理员物理删掉这张单 + 当天最高序号被新单复用」（订单号是 MAX(...)+1 生成的）
    // 就会把另一个顾客的整行订单装进本次响应 —— 姓名、手机号、金额、门店全泄露。
    mockDetailQueries({ auto_close_eligible: true })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    const refreshCall = findRefreshCall()
    expect(refreshCall).toBeDefined()
    expect(refreshCall[0]).toContain('o.client_user_id = $2')
    expect(refreshCall[1]).toEqual(['FY-215', 'user-001'])
  })

  test('非可支付态不发重读查询（不白花一个往返）', async () => {
    mockDetailQueries({ status: '已支付', auto_close_eligible: false })
    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(findRefreshCall()).toBeUndefined()
  })

  test('待支付即使没到 10 分钟也要重读判据列', async () => {
    // 主查询与组装响应之间，另一台设备的 order.pay 可能刚写入 lakala_out_order_no。
    // 只在「跑过懒清理」时重读的话，这份响应会既发着倒计时、又把
    // has_active_payment_intent 算成 false —— 又一次展示口径与关单规则分叉。
    mockDetailQueries(
      { auto_close_eligible: true },
      // 重读拿到真相：意图刚被另一台设备写进来
      { auto_close_eligible: false, lakala_out_order_no: 'FY-215_1750000000' },
    )

    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    expect(findRefreshCall()).toBeDefined()
    expect(ctx.result.order.expire_at).toBeNull()
    expect(ctx.result.order.has_active_payment_intent).toBe(true)
  })

  test('请求处理期间跨过截止点 → 必须补关一次，不能下发「待支付 + 剩余 0」', async () => {
    // 请求开头那次懒清理检查时还差约 100 秒到 10 分钟 → 不触发；
    // 查明细/退款/流水期间（由重读 mock 的副作用把时间推进 110 秒）跨过截止点。
    // 不补这一下就会下发「待支付 + expire_in_ms=0」，前端据此只清倒计时不重载
    // （它有理由相信服务端已经试过关单了），而订单压根没被关 —— 矛盾态复发。
    //
    // ⚠️ 时间偏移必须在**开头那次检查之后**才生效，否则测的就不是「补关」这条路径了。
    // 这里挂在重读 mock 的副作用上：重读发生在 Promise.all 里，而 nowMs 在其之后才取。
    // 余量给足：下单于 500 秒前、偏移 110 秒。开头那次检查要误触发得等进程被卡 >100 秒
    //（20 倍余量，慢 CI 也不会假红）；而重读之后 -500+110 已越过 -600，补关必定触发。
    const realNow = Date.now
    let nowOffset = 0
    const justUnder = new Date(realNow() - 500 * 1000).toISOString()

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-215', client_user_id: 'user-001',
      sale_order_datetime: justUnder, preferred_employee_id: null, coupon_id: null,
      status: '待支付', opened_by: null, lakala_out_order_no: null,
      auto_close_eligible: true,
    }])
    pg.query.mockResolvedValueOnce([])  // items
    pg.query.mockResolvedValueOnce([])  // 行级退款额
    pg.query.mockResolvedValueOnce([])  // payments
    pg.query.mockImplementationOnce(async () => {   // 重读：此刻把时间推过截止点
      nowOffset = 110 * 1000
      return [{
        sale_order_id: 'FY-215', status: '待支付', sale_order_datetime: justUnder,
        lakala_out_order_no: null, auto_close_eligible: true,
      }]
    })
    pg.query.mockResolvedValueOnce([{   // 补关之后的复读
      sale_order_id: 'FY-215', status: '已关闭', sale_order_datetime: justUnder,
      lakala_out_order_no: null, auto_close_eligible: false,
    }])

    Date.now = () => realNow() + nowOffset
    let ctx
    try {
      ctx = createBoundCtx({ orderNo: 'FY-215' })
      await routes.detail(ctx)
    } finally {
      Date.now = realNow
    }

    // 关键：开头那次检查没触发（那时还差 5 秒），所以事务只可能来自补关那一次。
    // 少了 `await closeExpiredOrder(orderNo)` 这行，本断言立刻转红。
    expect(pg.transaction).toHaveBeenCalledTimes(1)
    expect(ctx.result.order.status).toBe('已关闭')
    expect(ctx.result.order.expire_at).toBeNull()
    expect(ctx.result.order.expire_in_ms).toBeNull()
  })

  test('懒清理真的关掉了单：UPDATE 生效 + 退券 + 退积分都执行到', async () => {
    // ⚠️ 全局默认的 transaction mock 让 closeExpiredOrder 恒返回 false。只断言
    // 「重读拿到已关闭」的话，把 closeExpiredOrder 整行删掉测试照样绿 —— 那只是
    // 在验证我自己喂的 mock。这里把事务配成真会关单，并钉住释放侧确实跑到了。
    const clientQuery = vi.fn(async (sql) => {
      if (/FROM sale_orders[\s\S]*FOR UPDATE/.test(sql)) {
        return { rows: [{ client_user_id: 'user-001', points_used: 100 }], rowCount: 1 }
      }
      if (/UPDATE sale_orders/.test(sql)) return { rows: [], rowCount: 1 }
      if (/UPDATE user_coupons/.test(sql)) return { rows: [], rowCount: 1 }
      if (/FROM client_wechat_users/.test(sql)) return { rows: [{ user_id: 'user-001' }], rowCount: 1 }
      if (/FROM point_transactions/.test(sql)) return { rows: [{ deducted: 100, returned: 0 }], rowCount: 1 }
      if (/INSERT INTO point_transactions/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-215', client_user_id: 'user-001',
      sale_order_datetime: stale, preferred_employee_id: null, coupon_id: null,
      status: '待支付', opened_by: null, lakala_out_order_no: null,
      auto_close_eligible: true,          // ← 关单前的快照
    }])
    pg.query.mockResolvedValueOnce([])  // items
    pg.query.mockResolvedValueOnce([])  // 行级退款额
    pg.query.mockResolvedValueOnce([])  // payments
    pg.query.mockResolvedValue([{       // 重读 / 复读：已被关掉
      sale_order_id: 'FY-215', status: '已关闭', sale_order_datetime: stale,
      lakala_out_order_no: null, auto_close_eligible: false,
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-215' })
    await routes.detail(ctx)

    const executed = clientQuery.mock.calls.map(([sql]) => sql)
    // 关单 UPDATE 带三条守卫
    const closeUpdate = executed.find((s) => /UPDATE sale_orders/.test(s))
    expect(closeUpdate).toBeDefined()
    expect(closeUpdate).toContain("status = '待支付'")
    expect(closeUpdate).toContain('opened_by IS NULL')
    expect(closeUpdate).toContain('lakala_out_order_no IS NULL')
    // 释放侧三样都要跑到（验收标准 2：「释放优惠券 / 积分 / 待结算储值卡」）
    expect(executed.some((s) => /UPDATE user_coupons/.test(s))).toBe(true)
    expect(executed.some((s) => /INSERT INTO point_transactions/.test(s))).toBe(true)
    // 待结算储值卡归零 + 应付额重算，就在关单那条 UPDATE 里
    expect(closeUpdate).toContain('pending_prepaid_card_amount = 0')
    expect(closeUpdate).toMatch(/payable_amount\s*=\s*CASE/)
    expect(closeUpdate).toContain('total_amount::numeric - prepaid_card_amount::numeric')

    expect(ctx.result.order.status).toBe('已关闭')
    expect(ctx.result.order.expire_at).toBeNull()
    expect(ctx.result.order.expire_in_ms).toBeNull()
  })

  test('expire_at 下发口径与 closeExpiredOrder 的 UPDATE 守卫同源（字面断言）', () => {
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const source = readFileSync(resolve(__dirname, '../../routes/order.js'), 'utf8')
    // 注释里也会提到这些守卫，断言必须落在代码本身上
    const stripComments = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

    // ⚠️ 切片锚点必须逐个断言找到了。`indexOf` 未命中返回 -1，而 `slice(start, -1)`
    // 会**返回从 start 到文件倒数第二字符的全部内容**（不是空串）——那段里到处都有
    // `opened_by IS NULL` / `lakala_out_order_no IS NULL`，下面的 toContain 会静默恒真，
    // 于是这个「唯一的漂移锁」在有人重命名 closeExpiredOrdersByUser 之后就悄悄失效了。
    const closeBody = stripComments(sliceBetweenAnchors(
      source,
      'async function closeExpiredOrder(orderNo) {',
      'async function closeExpiredOrdersByUser(userId) {',
    ))
    // 兜一层尺寸：这个函数就几十行，切出几千字符就是锚点错位了
    expect(closeBody.length).toBeLessThan(3000)

    // 守卫要钉在 **UPDATE 的 WHERE** 上——SELECT … FOR UPDATE 里也有 opened_by IS NULL，
    // 只断言整个函数体的话，单独从 UPDATE 删掉它仍然全绿
    // 切片走 fail-loud helper：裸 indexOf 拼出来的 `slice(x, -1)` 会静默切出大半个文件
    const closeWhere = sliceUpdateWhere(closeBody)

    // 判据常量（切片同样要逐个断言锚点——`indexOf` 未命中返回 -1，
    // `slice(x, -1)` 会切出从声明到文件尾的一大段，下面的比对就恒真了）
    const guardAt = source.indexOf('const PENDING_AUTO_CLOSE_GUARD_SQL')
    expect(guardAt, '未找到 PENDING_AUTO_CLOSE_GUARD_SQL').toBeGreaterThanOrEqual(0)
    const guardEnd = source.indexOf('\n\n', guardAt)
    expect(guardEnd, 'PENDING_AUTO_CLOSE_GUARD_SQL 声明未闭合').toBeGreaterThan(guardAt)
    const guardDecl = stripComments(source.slice(guardAt, guardEnd))

    expect(sqlConjuncts(guardDecl)).toEqual(sqlConjuncts(closeWhere))
    // 再钉一次内容本身，防止两侧「一起改错」还互相对得上
    expect(sqlConjuncts(guardDecl)).toEqual([
      "lakala_out_order_no IS NULL",
      "opened_by IS NULL",
      "status = '待支付'",
    ])

    // 判据必须留在 SQL 里由库求值；一旦有人把它搬回 JS，`IS NULL` vs `== null`、
    // 空串、列没 SELECT 出来是 undefined 这一堆跨语言语义差就会重新找上门
    expect(guardDecl).not.toContain('===')
    expect(guardDecl).not.toContain('=> ')

    // ⚠️ closeExpiredOrder **体内不得有时间谓词**（双谱系评审 round-6 P2）。
    // detail 的下发契约架在这条前提上：它只在**补关到关不动为止**之后才下发
    // expire_in_ms（且恒为严格正数），关不动就不下发。这里一旦加上
    // `sale_order_datetime < NOW() - INTERVAL ...`，补关成败就取决于 PG 与宿主的时钟差，
    // PG 慢一点就关不掉而复读仍判 eligible —— 矛盾态从后门回来。
    expect(closeBody).not.toMatch(/INTERVAL/)
    expect(closeBody).not.toMatch(/NOW\(\)\s*-/)
    expect(closeBody).not.toContain('sale_order_datetime')
  })
  test('顾客端落单只会是销售单/充值单 —— closeExpiredOrder 不排除转换单的前提', () => {
    // `closeExpiredOrder` 的三条守卫里**没有** `sale_order_type <> '转换单'`
    //（card.js 的充值路径和 order.cancel 都有）。它安全，靠的是
    //「转换单恒有 opened_by」这条定义域前提：顾客端自己落的单只有销售单和充值单，
    // 转换单只由 staff/admin 落且必写 opened_by。
    // 前提一破，转换单会被这里关掉，而释放侧不跑 rollbackPendingConversionOnClose ——
    // 疗程卡次数/家居数量永久蒸发（card.js 的注释里亲述过这个场景）。
    //
    // ⚠️ 扫**全部** route，且每条 INSERT 都必须能静态解析出单据类型：
    // 新增的 route、或把类型改成 `$N` 参数传进去，都要在这里报红而不是被静默漏扫。
    const { readFileSync, readdirSync } = require('fs')
    const { resolve } = require('path')
    const dir = resolve(__dirname, '../..', 'routes')

    const inserts = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      for (const m of src.matchAll(/INSERT INTO sale_orders[\s\S]{0,2500}?(?=`)/g)) {
        inserts.push({ file: f, sql: m[0] })
      }
    }
    expect(inserts.length, '一条 INSERT INTO sale_orders 都没扫到，正则或目录错了').toBeGreaterThan(0)

    const kinds = new Set()
    for (const { file, sql } of inserts) {
      const found = [...sql.matchAll(/'(销售单|充值单|转换单|内部单|退款单|寄存单)'/g)].map((m) => m[1])
      // 解析不出字面量 = 类型走了参数化（`$N`）或新写法，这条前提就不再可静态验证
      expect(
        found.length,
        `${file} 里有一条 INSERT INTO sale_orders 解析不出 sale_order_type 字面量，` +
        '「顾客端绝不落转换单」这条前提失去静态守护，请手工复核后更新本用例',
      ).toBeGreaterThan(0)
      for (const k of found) kinds.add(k)
    }

    expect([...kinds].sort()).toEqual(['充值单', '销售单'])
  })

})

describe('order.cancel', () => {
  const lakalaEnv = {
    LAKALA_API_BASE: 'https://x', LAKALA_APPID: 'OP', LAKALA_SERIAL_NO: 'sn',
    LAKALA_PRIVATE_KEY_PEM: 'pk', LAKALA_PLATFORM_CERT_PEM: 'cert',
  }
  const originalLakalaEnv = {}
  beforeEach(() => {
    for (const [key, value] of Object.entries(lakalaEnv)) {
      originalLakalaEnv[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterEach(() => {
    for (const key of Object.keys(lakalaEnv)) {
      if (originalLakalaEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalLakalaEnv[key]
    }
  })

  test('正常取消待支付订单', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
    }])
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
  })

  test('非待支付订单不允许取消', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付', client_user_id: 'user-001',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许取消/)
  })

  test('取消已发起但渠道已 FAIL 的线上待支付单 → 释放意图后关闭订单', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) return [{ sale_order_id: 'FY-001' }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'FAIL' })
    pg.transaction.mockImplementation(async (cb) => cb({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    }))

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
    expect(__mocks__.lakalaClient.queryTrade).toHaveBeenCalledWith(expect.objectContaining({
      merchantNo: 'M1', termNo: 'T1', outTradeNo: 'FY-001_1700000000',
    }))
    expect(pg.transaction).toHaveBeenCalledTimes(1)
  })

  // #214：渠道仍 CREATE（顾客没付款就退出）此前一律拒绝取消，实测要等约 20 分钟
  // 才能关单。现在改为主动向渠道关单 + 复核终态后放行。
  test('取消已发起且渠道仍 CREATE 的线上待支付单 → 关单并复核 CLOSE 后关闭订单 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) return [{ sale_order_id: 'FY-001' }]
      return []
    })
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })   // 首查：尚未付款
      .mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })    // 关单后复核
    pg.transaction.mockImplementation(async (cb) => cb({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    }))

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
    expect(__mocks__.lakalaClient.closeTrade).toHaveBeenCalledWith(expect.objectContaining({
      merchantNo: 'M1', termNo: 'T1', outTradeNo: 'FY-001_1700000000',
    }))
    expect(__mocks__.lakalaClient.queryTrade).toHaveBeenCalledTimes(2)  // 关单前后各一次
  })

  // fail-closed 主防线：关单请求发出去了，但复核显示渠道仍可支付 → 绝不本地关闭，
  // 否则顾客残留的支付面板付进来的钱会因 payNotify 的「非当前意图」校验无法入账。
  test('关单后复核仍非终态 → 保留意图、拒绝取消 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })   // 关单没生效

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_INTENT_ACTIVE/)
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  // 订单号是可枚举的日序号。若在闸门之前写 client_user_id，任意顾客枚举到一张员工开单
  // 就能把归属永久改到自己名下，而且闸门抛错后不回滚——被"认领"走的顾客此后连支付都会
  // PERMISSION_DENIED。所以归属写入必须与关单同在最后那条 CAS 里。
  test('取消失败时绝不写入 client_user_id（归属只随 CAS 落地） (#214)', async () => {
    const writes = []
    pg.query.mockImplementation(async (sql) => {
      writes.push(sql)
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-CLAIM-001', status: '待支付', client_user_id: null,
        opened_by: 'emp-001', store_id: 'store-1',
        lakala_out_order_no: 'FY-CLAIM-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    // 渠道仍可支付且关不掉 → 取消必须失败
    __mocks__.lakalaClient.queryTrade
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
      .mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const ctx = createBoundCtx({ orderNo: 'FY-CLAIM-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_INTENT_ACTIVE/)

    // 事务外不得出现任何写 client_user_id 的语句
    expect(writes.some((sql) => /SET client_user_id/.test(sql))).toBe(false)
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('查单未返回 trade_state（渠道查无此单）→ 不发关单请求，保留意图 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-GHOST-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-GHOST-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    // 业务错误码 + resp_data 为空 → tradeState 是空串，既非已付款也非可释放终态
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: false, code: 'BBS10000', tradeState: '' })

    const ctx = createBoundCtx({ orderNo: 'FY-GHOST-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_STATUS_UNCERTAIN/)
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  test('渠道状态大小写变体按大写归一，已付款单仍被拦住 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-CASE-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-CASE-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'Success' })

    const ctx = createBoundCtx({ orderNo: 'FY-CASE-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_ALREADY_SUCCEEDED/)
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  // 释放 CAS 返回 0 行有三种语义：别人已释放（可继续）/ 意图被换掉（必须拦）/ 状态已变（必须拦）。
  // 一律当失败会造成误报：轮询先释放、顾客随即点取消，就要点两次才成功。
  test('意图已被他处释放 → 视为已达成，取消照常完成 (#214)', async () => {
    let released = false
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-RACE-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-RACE-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) { released = true; return [] }  // CAS 扑空
      if (/SELECT lakala_out_order_no FROM sale_orders/.test(sql)) {
        return [{ lakala_out_order_no: released ? null : 'FY-RACE-001_1700000000' }]
      }
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CLOSE' })
    pg.transaction.mockImplementation(async (cb) => cb({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    }))

    const ctx = createBoundCtx({ orderNo: 'FY-RACE-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
  })

  test('关单请求本身失败 → 保留意图、拒绝取消 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })
    __mocks__.lakalaClient.closeTrade.mockRejectedValueOnce(new Error('INVALID_STATE: LAKALA_TIMEOUT_30000ms'))

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_INTENT_ACTIVE.*暂时无法终止/)
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  // REVOKED（当日交易撤销）是终态却长期被漏判，撤销过的单会永久卡住支付意图
  test('渠道 REVOKED（撤销）视为可释放终态，无需关单即可取消 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) return [{ sale_order_id: 'FY-001' }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'REVOKED' })
    pg.transaction.mockImplementation(async (cb) => cb({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    }))

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  test('取消已发起且渠道已 SUCCESS 的线上待支付单 → 禁止关闭并提示刷新', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'SUCCESS' })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_ALREADY_SUCCEEDED.*支付已成功/)
    expect(pg.transaction).not.toHaveBeenCalled()
  })
})

// ===== #214 跨 env 内部接口 order.voidPaymentIntent =====
// 仅供 staffApi 经 HTTP 触发器 + HMAC 调用；staff 侧没有也不该有拉卡拉凭据。
// ===== #214 scanDetail 下发的可续付元数据（round-9）=====
// 前端自己推算金额/方式/卡额会和快照对不上（round-8/9 连着两轮栽在这里），
// 权威数据在快照里，由后端给出。但**绝不能**把 paymentParams 一起带出去。
describe('order.scanDetail 的可续付元数据', () => {
  function mockScanOrder(overrides) {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders o/.test(sql)) return [{
        sale_order_id: 'FY-SCAN-001', status: '部分支付', store_id: 'store-1',
        opened_by: 'emp-001', client_user_id: 'user-001',
        total_amount: 300, payable_amount: 300, received: 100,
        prepaid_card_amount: 0, pending_prepaid_card_amount: 0,
        sale_order_datetime: new Date().toISOString(),
        ...overrides,
      }]
      return []
    })
  }

  test('有本人有效场次 → 下发金额/方式/卡额，但不含任何凭据', async () => {
    const outTradeNo = 'FY-SCAN-001_1700000000'
    mockScanOrder({
      lakala_out_order_no: outTradeNo,
      pending_prepaid_card_amount: 80,
      lakala_payment_intent: {
        outTradeNo,
        expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        paymentMethod: '微信',
        payAmount: 120,
        paymentParams: { package: 'prepay_id=secret', paySign: 'must-not-leak' },
      },
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-SCAN-001' })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.hasResumablePaymentIntent).toBe(true)
    expect(ctx.result.order.resumablePayAmount).toBe(120)
    expect(ctx.result.order.resumablePaymentMethod).toBe('微信')
    expect(ctx.result.order.resumablePrepaidCardAmount).toBe(80)
    // 凭据绝不外发
    expect(JSON.stringify(ctx.result)).not.toContain('must-not-leak')
    expect(JSON.stringify(ctx.result)).not.toContain('prepay_id=secret')
  })

  // 「有活动意图」与「快照可复用」必须是两个信号：合成一个的话，意图还在但快照刚过期
  // 会被判成没有场次 → 前端转回 repay 的 fail-fast → 顾客又被卡死（双谱系评审 round-10）。
  test('意图仍在但快照已过期 → 仍报告有活动意图，只是不可复用 (#214)', async () => {
    const outTradeNo = 'FY-SCAN-001_1700000000'
    mockScanOrder({
      lakala_out_order_no: outTradeNo,
      lakala_payment_intent: {
        outTradeNo,
        expiresAt: new Date(Date.now() + 10 * 1000).toISOString(),  // 只剩 10s，低于复用门槛
        paymentMethod: '微信', payAmount: 120,
        paymentParams: { package: 'p', paySign: 's' },
      },
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-SCAN-001' })
    await routes.scanDetail(ctx)

    // 路由信号：有意图 → 前端必须走 pay（它能查单释放后重建）
    expect(ctx.result.order.hasActivePaymentIntent).toBe(true)
    // 复用信号：快照不可用 → 不给元数据，前端按本地口径展示、后端重建场次
    expect(ctx.result.order.hasResumablePaymentIntent).toBe(false)
    expect(ctx.result.order.resumablePayAmount).toBeNull()
  })

  test('场次属于他人 → 两个信号都为否', async () => {
    const outTradeNo = 'FY-SCAN-001_1700000000'
    mockScanOrder({
      client_user_id: 'user-999',
      lakala_out_order_no: outTradeNo,
      lakala_payment_intent: {
        outTradeNo,
        expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        paymentMethod: '微信', payAmount: 120,
        paymentParams: { package: 'p', paySign: 's' },
      },
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-SCAN-001' })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.hasActivePaymentIntent).toBe(false)
    expect(ctx.result.order.hasResumablePaymentIntent).toBe(false)
    expect(ctx.result.order.resumablePayAmount).toBeNull()
  })

  test('快照已过期 → 不下发元数据', async () => {
    const outTradeNo = 'FY-SCAN-001_1700000000'
    mockScanOrder({
      lakala_out_order_no: outTradeNo,
      lakala_payment_intent: {
        outTradeNo,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        paymentMethod: '微信', payAmount: 120,
        paymentParams: { package: 'p', paySign: 's' },
      },
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-SCAN-001' })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.hasResumablePaymentIntent).toBe(false)
  })

  test('无活动意图 → 不下发元数据', async () => {
    mockScanOrder({ lakala_out_order_no: null })

    const ctx = createBoundCtx({ saleOrderId: 'FY-SCAN-001' })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.hasResumablePaymentIntent).toBe(false)
    expect(ctx.result.order.resumablePaymentMethod).toBeNull()
  })
})

describe('order.voidPaymentIntent', () => {
  function internalCtx(payload) {
    const ctx = createBoundCtx(payload)
    ctx.event._fromHttp = true
    ctx.event._hmacVerified = true
    return ctx
  }

  test('cloud.callFunction 直调（缺 HMAC 标记）→ PERMISSION_DENIED', async () => {
    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.voidPaymentIntent(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  // TOCTOU 防线（双谱系评审 round-3）：staff 预检时看到的是意图 A，跨 env 请求到达前
  // A 可能已到账清锁、顾客又发起了补款意图 B。按订单号「关当前那笔」会把合法的 B 关掉，
  // 而 staff 事务随后因订单已变「部分支付」拒绝关闭 —— 订单没关成，顾客的补款却被破坏。
  test('预读单号与当前意图不一致 → 拒绝，绝不改为操作新意图 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders WHERE sale_order_id/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_NEW',
      }]
      return []
    })

    const ctx = internalCtx({ saleOrderId: 'FY-001', expectedOutTradeNo: 'FY-001_OLD' })
    await expect(routes.voidPaymentIntent(ctx)).rejects.toThrow(/PAYMENT_INTENT_CHANGED/)
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  test('订单状态已变（已支付）→ 拒绝，不发任何渠道请求 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders WHERE sale_order_id/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '已支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1',
      }]
      return []
    })

    const ctx = internalCtx({ saleOrderId: 'FY-001', expectedOutTradeNo: 'FY-001_1' })
    await expect(routes.voidPaymentIntent(ctx)).rejects.toThrow(/PAYMENT_INTENT_CHANGED/)
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
  })

  // 滚动部署期间必然存在「旧版 staffApi 只发 saleOrderId」的窗口。软校验会在那段时间
  // 静默跳过比对、关掉顾客新发起的合法支付；强制必填则让旧版调用直接失败（fail-closed）。
  test('存在活动意图但缺 expectedOutTradeNo → 拒绝，且一笔渠道请求都不发 (#214)', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders WHERE sale_order_id/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1',
      }]
      return []
    })

    const ctx = internalCtx({ saleOrderId: 'FY-001' })
    await expect(routes.voidPaymentIntent(ctx)).rejects.toThrow(/INVALID_PARAMS.*expectedOutTradeNo/)
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
    expect(__mocks__.lakalaClient.closeTrade).not.toHaveBeenCalled()
  })

  test('无活动意图 → noop，不发渠道请求', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders WHERE sale_order_id/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: null,
      }]
      return []
    })

    const ctx = internalCtx({ saleOrderId: 'FY-001' })
    await routes.voidPaymentIntent(ctx)
    expect(ctx.result.result).toBe('noop')
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
  })
})

describe('order.queryLakalaStatus', () => {
  const env = {
    LAKALA_API_BASE: 'https://x', LAKALA_APPID: 'OP', LAKALA_SERIAL_NO: 'sn',
    LAKALA_PRIVATE_KEY_PEM: 'pk', LAKALA_PLATFORM_CERT_PEM: 'cert',
  }
  const snap = {}
  beforeEach(() => { for (const [k, v] of Object.entries(env)) { snap[k] = process.env[k]; process.env[k] = v } })
  afterEach(() => { for (const k of Object.keys(env)) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k] } })

  test('待支付且已发起拉卡拉 → 查询聚合主扫并透传 trade_state（SUCCESS 才算到账）', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1700000000', client_user_id: 'user-001',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, code: 'BBS00000', msg: '操作成功',
      tradeState: 'INIT', tradeNo: 'LAK-T-001', accTradeNo: '',
      payMode: 'WECHAT', totalAmountFen: 0, payerAmountFen: 0, raw: {},
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.queryLakalaStatus(ctx)

    expect(ctx.result.lakalaQueried).toBe(true)
    expect(ctx.result.localStatus).toBe('待支付')
    expect(ctx.result.lakalaTradeState).toBe('INIT')  // SUCCESS 才到账，INIT 还在等
    expect(__mocks__.lakalaClient.queryTrade).toHaveBeenCalledWith(
      expect.objectContaining({ merchantNo: 'M1', termNo: 'T1', outTradeNo: 'FY-001_1700000000' })
    )
  })

  test('订单未经拉卡拉发起（lakala_out_order_no 为空）→ 不查拉卡拉', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: null, client_user_id: 'user-001',
      }]
      return []
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.queryLakalaStatus(ctx)

    expect(ctx.result.lakalaQueried).toBe(false)
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
  })

  test('拉卡拉明确 FAIL → 查询接口按旧单号 CAS 释放活动意图', async () => {
    const outTradeNo = 'FY-FAIL-001_1700000000'
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT sale_order_id, status/.test(sql)) return [{
        sale_order_id: 'FY-FAIL-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: outTradeNo, client_user_id: 'user-001',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) return [{ sale_order_id: 'FY-FAIL-001' }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, code: 'BBS00000', tradeState: 'FAIL', tradeNo: 'LAK-T-FAIL', raw: {},
    })

    const ctx = createBoundCtx({ orderNo: 'FY-FAIL-001' })
    await routes.queryLakalaStatus(ctx)

    expect(ctx.result.lakalaTradeState).toBe('FAIL')
    expect(ctx.result.lakalaIntentReleased).toBe(true)
    const release = pg.query.mock.calls.find(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))
    expect(release[1]).toEqual(['FY-FAIL-001', outTradeNo])
  })

  // #214：queryLakalaStatus 是小程序轮询的主释放路径，此前只认 ['FAIL','CLOSE']，
  // REVOKED 单在这里不释放 → 顾客侧仍然发不了新支付（pr-ready sibling 审计发现的漏改）。
  test('拉卡拉 REVOKED（撤销）→ 查询接口同样释放活动意图 (#214)', async () => {
    const outTradeNo = 'FY-REVOKED-001_1700000000'
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT sale_order_id, status/.test(sql)) return [{
        sale_order_id: 'FY-REVOKED-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: outTradeNo, client_user_id: 'user-001',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      if (/SET lakala_out_order_no = NULL/.test(sql)) return [{ sale_order_id: 'FY-REVOKED-001' }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, code: 'BBS00000', tradeState: 'REVOKED', tradeNo: 'LAK-T-RVK', raw: {},
    })

    const ctx = createBoundCtx({ orderNo: 'FY-REVOKED-001' })
    await routes.queryLakalaStatus(ctx)

    expect(ctx.result.lakalaIntentReleased).toBe(true)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockImplementation(async () => [{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'other-user',
      lakala_out_order_no: 'FY-001_x',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.queryLakalaStatus(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('order.decideReconcile (pure)', () => {
  test('终态 / 非待支付·部分支付 → skip', () => {
    expect(routes.decideReconcile('已支付', true, 'SUCCESS')).toBe('skip')
    expect(routes.decideReconcile('已完成', true, null)).toBe('skip')
    expect(routes.decideReconcile('已关闭', true, 'SUCCESS')).toBe('skip')
    expect(routes.decideReconcile('支付失败', true, 'SUCCESS')).toBe('skip')
  })
  test('无拉卡拉单 → skip', () => {
    expect(routes.decideReconcile('待支付', false, null)).toBe('skip')
    expect(routes.decideReconcile('部分支付', false, 'SUCCESS')).toBe('skip')
  })
  test('待支付·部分支付 + 拉卡拉未 SUCCESS → wait', () => {
    expect(routes.decideReconcile('待支付', true, 'INIT')).toBe('wait')
    expect(routes.decideReconcile('部分支付', true, null)).toBe('wait')
    expect(routes.decideReconcile('待支付', true, 'CLOSE')).toBe('wait')
  })
  test('待支付·部分支付 + 拉卡拉 SUCCESS → reconcile', () => {
    expect(routes.decideReconcile('待支付', true, 'SUCCESS')).toBe('reconcile')
    expect(routes.decideReconcile('部分支付', true, 'SUCCESS')).toBe('reconcile')
  })
})

describe('order.confirmPayment', () => {
  const env = {
    LAKALA_API_BASE: 'https://x', LAKALA_APPID: 'OP', LAKALA_SERIAL_NO: 'sn',
    LAKALA_PRIVATE_KEY_PEM: 'pk', LAKALA_PLATFORM_CERT_PEM: 'cert',
  }
  const snap = {}
  beforeEach(() => { for (const [k, v] of Object.entries(env)) { snap[k] = process.env[k]; process.env[k] = v } })
  afterEach(() => { for (const k of Object.keys(env)) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k] } })

  test('待支付 + 拉卡拉 SUCCESS → callFunction 调 payNotify 触发补偿入账，重查 status 已翻 → reconciled', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT status, received, first_payment_amount FROM sale_orders/.test(sql)) {
        return [{ status: '已支付', received: 100, first_payment_amount: null }]
      }
      if (/FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1700000000', client_user_id: 'user-001', payment_method: '微信',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, code: 'BBS00000', msg: '操作成功',
      tradeState: 'SUCCESS', tradeNo: 'LAK-T-001', accTradeNo: 'wx-txn-001',
      payMode: 'WECHAT', totalAmountFen: 1, payerAmountFen: 1, raw: { acc_trade_no: 'wx-txn-001' },
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPayment(ctx)

    expect(ctx.result.reconciled).toBe(true)
    expect(ctx.result.status).toBe('已支付')
    expect(__mocks__.lakalaClient.queryTrade).toHaveBeenCalledWith(
      expect.objectContaining({ merchantNo: 'M1', termNo: 'T1', outTradeNo: 'FY-001_1700000000' })
    )
    expect(__mocks__.cloud.callFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'payNotify',
        data: expect.objectContaining({
          orderNo: 'FY-001_1700000000', transactionId: 'LAK-T-001', payAmount: 0.01, paymentMethod: '微信',
        }),
      })
    )
  })

  test('历史状态已是部分支付：拉卡拉尚未成功时不把旧状态当本场次到账；成功后以 ACK/实收增长确认', async () => {
    let afterNotify = false
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT status, received, first_payment_amount FROM sale_orders/.test(sql)) {
        afterNotify = true
        return [{ status: '部分支付', received: 1000, first_payment_amount: null }]
      }
      if (/FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-PARTIAL', status: '部分支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-PARTIAL_1700000000', client_user_id: 'user-001', payment_method: '微信',
        received: 500, first_payment_amount: 500,
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, tradeState: 'CREATE', tradeNo: 'LAK-PARTIAL', totalAmountFen: 50000, raw: {},
    })

    const waitingCtx = createBoundCtx({ saleOrderId: 'FY-PARTIAL' })
    await routes.confirmPayment(waitingCtx)
    expect(waitingCtx.result.status).toBe('部分支付')
    expect(waitingCtx.result.reconciled).toBe(false)
    expect(waitingCtx.result.received).toBe(500)
    expect(waitingCtx.result.firstPaymentAmount).toBe(500)
    expect(afterNotify).toBe(false)

    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({
      ok: true, tradeState: 'SUCCESS', tradeNo: 'LAK-PARTIAL', totalAmountFen: 50000, raw: {},
    })
    const paidCtx = createBoundCtx({ saleOrderId: 'FY-PARTIAL' })
    await routes.confirmPayment(paidCtx)
    expect(paidCtx.result.status).toBe('部分支付')
    expect(paidCtx.result.reconciled).toBe(true)
    expect(paidCtx.result.received).toBe(1000)
    expect(paidCtx.result.firstPaymentAmount).toBeNull()
  })

  test('终态（已支付）→ skip，不查拉卡拉也不调入账', async () => {
    pg.query.mockImplementation(async (sql) => [{
      sale_order_id: 'FY-001', status: '已支付', store_id: 'store-1',
      lakala_out_order_no: 'FY-001_1700000000', client_user_id: 'user-001', payment_method: '微信',
    }])
    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPayment(ctx)

    expect(ctx.result.reconciled).toBe(false)
    expect(ctx.result.reason).toBe('terminal')
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
    expect(__mocks__.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('无拉卡拉单（全额储值卡 / 线下单）→ skip，不查拉卡拉', async () => {
    pg.query.mockImplementation(async (sql) => [{
      sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
      lakala_out_order_no: null, client_user_id: 'user-001', payment_method: '储值卡',
    }])
    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPayment(ctx)

    expect(ctx.result.reconciled).toBe(false)
    expect(ctx.result.reason).toBe('no_lakala_order')
    expect(__mocks__.lakalaClient.queryTrade).not.toHaveBeenCalled()
  })

  test('拉卡拉 trade_state 非 SUCCESS → wait，返回本地 status 不入账（前端继续轮询）', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1700000000', client_user_id: 'user-001', payment_method: '微信',
      }]
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'INIT', tradeNo: 'LAK-T', totalAmountFen: 1, raw: {} })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPayment(ctx)

    expect(ctx.result.reconciled).toBe(false)
    expect(ctx.result.lakalaTradeState).toBe('INIT')
    expect(ctx.result.reason).toBe('not_success')
    expect(__mocks__.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('callFunction payNotify 异常 → 降级返回本地 status，不 throw', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', store_id: 'store-1',
        lakala_out_order_no: 'FY-001_1700000000', client_user_id: 'user-001', payment_method: '微信',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'SUCCESS', tradeNo: 'LAK-T', totalAmountFen: 1, raw: {} })
    __mocks__.cloud.callFunction.mockRejectedValueOnce(new Error('timeout'))

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPayment(ctx)

    expect(ctx.result.reconciled).toBe(false)
    expect(ctx.result.reason).toBe('paynotify_call_failed')
    expect(ctx.result.status).toBe('待支付')
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockImplementation(async () => [{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'other-user',
      lakala_out_order_no: 'FY-001_x',
    }])
    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.confirmPayment(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('order.appointableItems', () => {
  test('返回可预约项目列表', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', order_status: '已支付',
      order_remark: '顾客希望安排安静房间',
      store_id: 's1', store_name: '测试店', market_name: '华东',
      preferred_employee_id: null, sale_item_id: 'SI-001',
      sku_id: 'sku-1', product_name: '护理A',
      product_type: '疗程卡', session_count: 10, remaining_sessions: 8,
      unit_price: 100, unit_real_price: 80, sale_amount: 800, expire_date: null,
    }])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].orderRemark).toBe('顾客希望安排安静房间')
    expect(ctx.result.orders[0].items).toHaveLength(1)
    expect(ctx.result.orders[0].items[0].active).toBe(true)
    expect(pg.query.mock.calls[0][0]).toContain('o.remark AS order_remark')
  })

  test('包含部分支付订单中已解锁的疗程卡', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-PARTIAL', order_status: '部分支付',
      order_remark: null,
      store_id: 's1', store_name: '测试店', market_name: '华东',
      preferred_employee_id: null, sale_item_id: 'SI-PARTIAL',
      sku_id: 'sku-1', product_name: '护理A',
      product_type: '疗程卡', session_count: 5, remaining_sessions: 5,
      paid_sessions: 2, unit_price: 100, unit_real_price: 100,
      sale_amount: 500, expire_date: null,
    }])

    const ctx = createBoundCtx({ includeInactive: true })
    await routes.appointableItems(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(ctx.result.orders[0].orderStatus).toBe('部分支付')
    expect(ctx.result.orders[0].orderRemark).toBeNull()
    expect(ctx.result.orders[0].items[0].paidSessions).toBe(2)
  })

  test('SQL 守卫：可预约权益包含购买行和转换单转入行，排除转出行', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("si.item_direction = '购买'")
    expect(sql).toContain("o.sale_order_type = '转换单'")
    expect(sql).toContain("si.item_direction = '转入'")
    expect(sql).not.toContain("si.item_direction = '转出'")
  })

  test('SQL 守卫：默认可预约查询纳入已完成销售单，并按已付未用次数过滤', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(sql).toContain('si.paid_sessions IS NULL')
    expect(sql).toContain('si.paid_sessions > (si.session_count - si.remaining_sessions)')
  })
})

describe('order.homeProducts', () => {
  test('返回真实提货、退款和待提数量', async () => {
    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'SI-HOME-1', sale_order_id: 'SO-HOME-1', product_name: '精华液',
        unit: '盒', purchased_quantity: 5,
        paid_quantity: 4, picked_quantity: 2, refunded_quantity: 1,
        remaining_quantity: 2, pending_pickup_quantity: 2,
        store_id: 's2', store_name: '外店', purchased_at: '2026-08-01T10:00:00Z', refund_pending: false,
      },
      {
        sale_item_id: 'SI-HOME-2', sale_order_id: 'SO-HOME-2', product_name: '面膜',
        unit: '盒', purchased_quantity: 1, paid_quantity: 1,
        picked_quantity: 0, refunded_quantity: 0,
        remaining_quantity: 1, pending_pickup_quantity: 1, store_id: 's1', store_name: '本店',
        purchased_at: '2026-08-02T10:00:00Z', refund_pending: true,
      },
    ])

    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    expect(ctx.result.items).toEqual([
      expect.objectContaining({
        saleItemId: 'SI-HOME-1', pickedQuantity: 2, refundedQuantity: 1,
        remainingQuantity: 2, status: '部分提货', storeName: '外店',
      }),
      expect.objectContaining({ saleItemId: 'SI-HOME-2', status: '退款处理中' }),
    ])
    expect(pg.query.mock.calls[0][1]).toEqual([ctx.auth.userId])
  })

  test('SQL 仅查有效购买行，提货/退款/转换三语义各自直读独立列（#154）', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    const sql = pg.query.mock.calls[0][0]

    // #154 起提货件数直读 sale_items.picked_up_quantity，pickup_totals CTE 已删除。
    // 这不是"图省事少个 JOIN"，而是并发正确性要求：件数在 si 自身列上，本行被
    // FOR UPDATE 锁住时 EvalPlanQual 会重新读到最新值；JOIN 出去的聚合子查询不会，
    // 并发提货下会拿着快照算可提量。回退成 JOIN pickup_records 是真实缺陷，必须挡。
    // （pickup_records 降级为明细表，只用于 cron 的 C5 守恒审计
    //  `picked_up_quantity == SUM(pickup_records.pickup_quantity)`。）
    //
    // ⚠️ 旧断言曾是 toContain('FROM pickup_records')——#154 改了 8 个源文件却没动
    // 任何测试，这条断言就此过时并让整条用例长期红着，连带**后面 7 条断言从未执行过**，
    // 最终挡住 clientApi 接入 CI（#276）。
    expect(sql).not.toContain('pickup_records')

    // 三语义各自直读独立列，互不倒推
    expect(sql).toContain('COALESCE(si.picked_up_quantity, 0)))::int AS picked_quantity')
    expect(sql).toContain('COALESCE(si.refunded_quantity, 0)))::int AS refunded_quantity')
    expect(sql).toContain('COALESCE(si.converted_quantity, 0)))::int AS converted_quantity')

    // 「已结算」才是派生量 = 已提货 + 已退款 + 已转换
    expect(sql).toContain(
      'COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0)',
    )

    // 反向：「已退款」不得再由 settled − 已提货 − 已转换 倒推（#154 前的写法）
    expect(sql).not.toMatch(/settled_quantity\s*-\s*picked_quantity/)

    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(sql).toContain("si.item_direction = '购买'")
    expect(sql).toContain("si.product_type = '家居产品'")
    expect(sql).toMatch(/FLOOR\(GREATEST\(0, si\.received::numeric\) \* si\.quantity \/ NULLIF\(si\.sale_amount::numeric, 0\)\)/)
    // issue #120：放行口径改为按物理剩余份额，旧的 pending 过滤会吞掉未付清的行。
    // 注意不能只断言 'pending_pickup_quantity > 0'——那串在 ORDER BY 里也有，测不出过滤口径。
    expect(sql).toContain('WHERE picked_quantity > 0 OR remaining_quantity > 0')
    expect(sql).not.toContain('WHERE picked_quantity > 0 OR pending_pickup_quantity > 0')
    expect(sql).toContain("(o.sale_order_type = '寄存单') AS is_deposit")
    expect(sql).toContain('CASE WHEN is_deposit THEN NULL')
  })

  // issue #120：买 1 件未付清 → FLOOR=0 → pending=0，旧 WHERE 把整行剔除，
  // 顾客在「我的家居产品」里完全看不到自己买过这件货。
  test('未付清整件的行仍返回，状态为待付清并带欠款金额', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-UNPAID', sale_order_id: 'SO-UNPAID', product_name: '舒缓精华液',
      unit: '盒', purchased_quantity: 1, paid_quantity: 0,
      picked_quantity: 0, refunded_quantity: 0,
      remaining_quantity: 1, pending_pickup_quantity: 0, unpaid_amount: '380.00',
      store_id: 's1', store_name: '本店', purchased_at: '2026-09-13T10:00:00Z',
      refund_pending: false,
    }])

    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      purchasedQuantity: 1,
      paidQuantity: 0,
      pendingPickupQuantity: 0,
      unpaidAmount: 380,
      status: '待付清',
    })
  })

  // 寄存单 sale_amount 是原价快照、received 是历史值，相减不是欠款。
  // 顾客端尤其不能显示这笔钱——那是向顾客伪造一笔不存在的债务。
  test('寄存单行不下发欠款，状态为待提货', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-DEPOSIT', sale_order_id: 'SO-DEPOSIT', product_name: '生物胶原修复面膜',
      unit: '盒', purchased_quantity: 27, paid_quantity: 0,
      picked_quantity: 0, refunded_quantity: 0,
      remaining_quantity: 27, pending_pickup_quantity: 0, unpaid_amount: null,
      store_id: 's1', store_name: '本店', purchased_at: '2026-08-03T10:00:00Z',
      refund_pending: false,
    }])

    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      unpaidAmount: null,
      status: '待提货',
      purchasedQuantity: 27,
    })
  })

  test('退款过的行不下发欠款金额，且仍有剩余份额时不标已完成', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-REFUNDED', sale_order_id: 'SO-REFUNDED', product_name: '面膜',
      unit: '盒', purchased_quantity: 3, paid_quantity: 0,
      picked_quantity: 0, refunded_quantity: 1,
      remaining_quantity: 2, pending_pickup_quantity: 0, unpaid_amount: '200.00',
      store_id: 's1', store_name: '本店', purchased_at: '2026-08-20T10:00:00Z',
      refund_pending: false,
    }])

    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      unpaidAmount: null,
      status: '待提货',
      remainingQuantity: 2,
    })
  })

  // issue #122：部分支付且实收不足一次单价 → paid_sessions=0，可用次数 0。
  // 顾客端卡包（includeInactive=true）本就展示这类卡，本次补「待付清」金额。
  test('可用次数为 0 的卡下发行级欠款', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'SO-UNPAID', order_status: '部分支付', paid_at: '2026-09-13T10:00:00Z',
      sale_item_id: 'SI-UNPAID', product_name: '深层补水', product_type: '疗程卡',
      session_count: 15, remaining_sessions: 15, paid_sessions: 0,
      sale_amount: '3000.00', received: '150.00', unpaid_amount: '2850.00',
      unit: '次', quantity: 1,
    }])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    expect(ctx.result.orders[0].items[0]).toMatchObject({
      saleItemId: 'SI-UNPAID',
      paidSessions: 0,
      unpaidAmount: 2850,
    })
  })

  test('欠款字段为空时透传 null，不塞 0', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'SO-PAID', order_status: '已支付', paid_at: '2026-07-25T10:00:00Z',
      sale_item_id: 'SI-PAID', product_name: '面部护理', product_type: '疗程卡',
      session_count: 10, remaining_sessions: 8, paid_sessions: 10,
      sale_amount: '3980.00', received: '3980.00', unpaid_amount: null,
      unit: '次', quantity: 1,
    }])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    expect(ctx.result.orders[0].items[0].unpaidAmount).toBeNull()
  })

  test('欠款 SQL 排除已审批退款单，避免按净实收虚增欠款', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("WHEN o.status = '部分支付'")
    expect(sql).toContain('AND si.paid_sessions < si.session_count')
    expect(sql).toContain('END AS unpaid_amount')
    // received 是行级净实收（已扣退款），退过款的单相减必然虚增欠款
    expect(sql).toMatch(/unpaid_amount/)
  })

  test('部分支付家居产品返回已付和待提整件数', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-PARTIAL-HOME', sale_order_id: 'SO-PARTIAL-HOME', product_name: '面膜',
      unit: '盒', purchased_quantity: 10, paid_quantity: 2,
      picked_quantity: 0, refunded_quantity: 0,
      remaining_quantity: 10, pending_pickup_quantity: 2,
      store_id: 's1', store_name: '本店', purchased_at: '2026-08-13T10:00:00Z',
      refund_pending: false,
    }])

    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      purchasedQuantity: 10,
      paidQuantity: 2,
      pendingPickupQuantity: 2,
      status: '待提货',
    })
  })
})

// ================================================================
// 储值卡抵扣消费测试（储值卡抵扣 by store，2026-04-23 ticket Wave 2A）
// ================================================================

describe('prepaid card deduction - order.create', () => {
  function mockBaseCreate(price = '300') {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }]) // 门店
    pg.query.mockResolvedValueOnce([]) // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([]) // check pending
    pg.query.mockResolvedValueOnce([{ // SKU
      sku_id: 'sku-1', product_id: 'p1', product_type: '疗程卡',
      spec_name: '标准', price, special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
    }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }]) // 顾客名
  }

  test('不用卡（useCard=false）：prepaid=0, paid=total, payment_method 保留前端传值', async () => {
    mockBaseCreate('300')

    const txnQueries = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (...args) => {
          txnQueries.push(args)
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: false,
    })
    await routes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.paidAmount).toBe(300)
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.reason).toBeUndefined()

    // 事务内不应查 prepaid_cards（因 useCard=false）
    const prepaidQueries = txnQueries.filter(a => /prepaid_cards/.test(a[0]))
    expect(prepaidQueries.length).toBe(0)
  })

  test('用卡全抵：余额 >= 应付 → paid=0, payment_method 强制 "无", 直接已支付 + 扣款流水', async () => {
    mockBaseCreate('300')

    const txnQueries = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txnQueries.push({ sql, params })
          if (/advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-abc', balance: '500.00' }], rowCount: 1 }
          }
          if (/FROM sale_orders\s+WHERE sale_order_id LIKE/.test(sql)) return { rows: [], rowCount: 0 }
          if (/FROM sale_items\s+WHERE sale_item_id LIKE/.test(sql)) return { rows: [], rowCount: 0 }
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            return { rows: [], rowCount: 0 } // 幂等检查：未扣过
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })
    await routes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(300)
    expect(ctx.result.paidAmount).toBe(0)
    expect(ctx.result.paymentMethod).toBe('无')
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.reason).toBe('prepaid_card_full')
    expect(ctx.result.paymentParams).toBeNull()

    // 验证事务内 UPDATE prepaid_cards + INSERT card_transactions 被调用
    const updateBalance = txnQueries.find(q => /UPDATE prepaid_cards SET balance = balance - \$1/.test(q.sql))
    expect(updateBalance).toBeDefined()
    expect(updateBalance.params[0]).toBe(300)
    expect(updateBalance.params[1]).toBe('card-abc')

    const insertTxn = txnQueries.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeDefined()
    expect(insertTxn.params[0]).toBe('card-abc')
    expect(insertTxn.params[1]).toBe(-300)

    // 订单 INSERT 包含 prepaid_card_amount / received（2026-04-26 paid_amount→received）, status='已支付'
    const orderInsert = txnQueries.find(q => /INSERT INTO sale_orders/.test(q.sql))
    expect(orderInsert.sql).toContain('prepaid_card_amount')
    expect(orderInsert.sql).toContain('received')
    expect(orderInsert.sql).not.toContain('paid_amount')
    expect(orderInsert.params[1]).toBe('已支付') // initialStatus
  })

  test('用卡部分抵：余额 < 应付 → prepaid=balance, paid>0, payment_method 保留', async () => {
    mockBaseCreate('300')

    const txnQueries = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          txnQueries.push({ sql })
          if (/FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-abc', balance: '100.00' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })
    await routes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.pendingPrepaidCardAmount).toBe(100)
    expect(ctx.result.paidAmount).toBe(200)
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.status).toBe('待支付')

    // 部分抵扣时，事务内不应扣 balance / 写 card_transactions
    const updateBalance = txnQueries.find(q => /UPDATE prepaid_cards SET balance = balance - /.test(q.sql))
    expect(updateBalance).toBeUndefined()
    const insertTxn = txnQueries.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeUndefined()
  })

  test('paid=0 时 payment_method 强制覆盖为 "无"（即使前端传"微信"）', async () => {
    mockBaseCreate('300')

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '1000' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信', // 恶意传"微信"
      useCard: true,
    })
    await routes.create(ctx)

    expect(ctx.result.paidAmount).toBe(0)
    expect(ctx.result.paymentMethod).toBe('无') // 强制覆盖
  })

  test('前端传 prepaidCardAmount 超余额 → INSUFFICIENT_BALANCE', async () => {
    mockBaseCreate('300')

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '50' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
      prepaidCardAmount: 200, // 超余额
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('前端传 prepaidCardAmount 超应付金额 → INVALID_PARAMS', async () => {
    mockBaseCreate('100')

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '1000' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
      prepaidCardAmount: 500, // > totalAmount=100
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*超过应付/)
  })

  test('无卡且 useCard=true：prepaid=0, paid=total, payment_method 保留', async () => {
    mockBaseCreate('300')

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/FOR UPDATE/.test(sql)) {
            return { rows: [], rowCount: 0 } // 无卡
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true, // 开关开但无余额 → 自动降为 0
    })
    await routes.create(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.paidAmount).toBe(300)
    expect(ctx.result.paymentMethod).toBe('微信')
  })

  test('全额抵扣幂等：若 card_transactions 已存在扣款流水则跳过 INSERT', async () => {
    mockBaseCreate('300')

    const txnQueries = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txnQueries.push({ sql, params })
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '500' }], rowCount: 1 }
          }
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            // 幂等：已存在
            return { rows: [{ '?column?': 1 }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
    })
    await routes.create(ctx)

    // UPDATE balance 和 INSERT card_transactions 都不应被调用
    const updateBalance = txnQueries.find(q => /UPDATE prepaid_cards SET balance = balance - /.test(q.sql))
    expect(updateBalance).toBeUndefined()
    const insertTxn = txnQueries.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeUndefined()
  })
})

describe('prepaid card deduction - order.cancel', () => {
  test('无扣款（prepaid_card_amount=0）：无需回冲', async () => {
    // 2026-04-26 sale-order-domain-refactor: paid_amount → 由 payable_amount 表达"应付实金"
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      prepaid_card_amount: 0, payable_amount: 100, total_amount: 100,
    }])

    const txnCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          txnCalls.push(sql)
          // CAS 守卫：UPDATE sale_orders SET status='已关闭' 必须返回 rowCount=1
          if (/UPDATE sale_orders SET status = '已关闭'/.test(sql)) {
            return { rows: [], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
    // 不触发储值卡回冲相关 SQL
    const revIns = txnCalls.find(s => /INSERT INTO card_transactions/.test(s))
    expect(revIns).toBeUndefined()
  })

  test('已扣款（全额抵扣已支付单）：反向 INSERT 充值流水 + balance 回冲', async () => {
    // 全额抵扣判定：payable_amount=0（即 total = prepaid_card_amount）
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-002', status: '已支付', client_user_id: 'user-001',
      prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
    }])

    const txnCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txnCalls.push({ sql, params })
          // CAS 守卫：UPDATE sale_orders SET status='已关闭' 必须返回 rowCount=1
          if (/UPDATE sale_orders SET status = '已关闭'/.test(sql)) {
            return { rows: [], rowCount: 1 }
          }
          // 第一次查 card_transactions 扣款流水 → 已存在
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            return { rows: [{ id: 1 }], rowCount: 1 }
          }
          // 第二次查 card_transactions 充值流水（反向幂等） → 未存在
          if (/FROM card_transactions/.test(sql) && /type = '充值'/.test(sql)) {
            return { rows: [], rowCount: 0 }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ orderNo: 'FY-002' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
    // 触发 UPDATE prepaid_cards + INSERT 充值流水
    const balUpd = txnCalls.find(q => /UPDATE prepaid_cards SET balance = balance \+ \$1/.test(q.sql))
    expect(balUpd).toBeDefined()
    expect(Number(balUpd.params[0])).toBe(300)
    const revIns = txnCalls.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(revIns).toBeDefined()
    expect(Number(revIns.params[1])).toBe(300) // 充值金额 +300
  })

  test('已支付单但无储值卡抵扣 → 拒绝取消', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-003', status: '已支付', client_user_id: 'user-001',
      prepaid_card_amount: 0, payable_amount: 100, total_amount: 100,
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-003' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许取消/)
  })
})

describe('prepaid card deduction - order.scanAdjust', () => {
  test('关掉开关：useCard=false → prepaid=0, paid=total, 按前端选的支付方式', async () => {
    // 读订单
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: null,
      opened_by: 'emp-001', total_amount: 300, prepaid_card_amount: 300, paid_amount: 0,
    }])
    // 读余额
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1', balance: '500' }])
    // UPDATE
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: false,
      paymentMethod: '微信',
    })
    await routes.scanAdjust(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(0)
    expect(ctx.result.paidAmount).toBe(300)
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.status).toBe('待支付')
  })

  test('部分抵扣：传 prepaidCardAmount=100 → paid=200', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      opened_by: 'emp-001', total_amount: 300, prepaid_card_amount: 0, paid_amount: 300,
    }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1', balance: '500' }])
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: true,
      prepaidCardAmount: 100,
      paymentMethod: '微信',
    })
    await routes.scanAdjust(ctx)

    expect(ctx.result.prepaidCardAmount).toBe(100)
    expect(ctx.result.paidAmount).toBe(200)
    expect(ctx.result.paymentMethod).toBe('微信')
  })

  test('状态非待支付 → 拒绝', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付', client_user_id: 'user-001',
      opened_by: 'emp-001', total_amount: 300,
    }])

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: false,
      paymentMethod: '微信',
    })
    await expect(routes.scanAdjust(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许调整/)
  })

  test('匿名自助下单（opened_by=null + client_user_id=null）→ 拒绝订单归属未确定', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: null,
      opened_by: null, total_amount: 300,
    }])

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: false,
      paymentMethod: '微信',
    })
    await expect(routes.scanAdjust(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单归属未确定/)
  })

  test('自助下单 + client_user_id=userId（顾客本人调整自己的待支付订单）→ 通过', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      opened_by: null, total_amount: 300, prepaid_card_amount: 0, paid_amount: 300,
    }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1', balance: '500', updated_at: '2026-05-20T00:00:00Z' }])
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: true,
      prepaidCardAmount: 300,
    })
    await routes.scanAdjust(ctx)
    expect(ctx.result.prepaidCardAmount).toBe(300)
    expect(ctx.result.paidAmount).toBe(0)
    expect(ctx.result.paymentMethod).toBe('无')
  })

  test('抵扣金额超余额 → INSUFFICIENT_BALANCE', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      opened_by: 'emp-001', total_amount: 300,
    }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1', balance: '50' }])

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: true,
      prepaidCardAmount: 200,
      paymentMethod: '微信',
    })
    await expect(routes.scanAdjust(ctx)).rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'other-user',
      opened_by: 'emp-001', total_amount: 300,
    }])

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: false,
      paymentMethod: '微信',
    })
    await expect(routes.scanAdjust(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  // ====== 2026-05-19 dirty-read 修复：余额快照 + 版本号 ======
  test('scanAdjust 返回 balanceSnapshot 包含 updatedAt（版本号）', async () => {
    const fakeUpdatedAt = new Date('2026-05-19T10:00:00Z')
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      opened_by: 'emp-001', total_amount: 300, prepaid_card_amount: 0, paid_amount: 300,
    }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1', balance: '500', updated_at: fakeUpdatedAt }])
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: true,
      prepaidCardAmount: 100,
      paymentMethod: '微信',
    })
    await routes.scanAdjust(ctx)

    expect(ctx.result.balanceSnapshot).toEqual({
      cardId: 'card-1',
      balance: 500,
      updatedAt: fakeUpdatedAt,
    })

    // 校验 SQL 选取了 updated_at 字段
    const balanceQuery = pg.query.mock.calls[1][0]
    expect(balanceQuery).toContain('updated_at')
  })

  test('scanAdjust 无卡（顾客无 prepaid_cards 行）→ balanceSnapshot = null', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
      opened_by: 'emp-001', total_amount: 300, prepaid_card_amount: 0, paid_amount: 300,
    }])
    pg.query.mockResolvedValueOnce([]) // 无卡
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      useCard: false,
      paymentMethod: '微信',
    })
    await routes.scanAdjust(ctx)

    expect(ctx.result.balanceSnapshot).toBeNull()
  })
})

describe('prepaid card deduction - order.confirmPrepaidFull', () => {
  test('成功：扣减 balance + INSERT 扣款流水 + 置已支付', async () => {
    const txnCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txnCalls.push({ sql, params })
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '500' }], rowCount: 1 }
          }
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            return { rows: [], rowCount: 0 } // 未扣过
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPrepaidFull(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.saleOrderId).toBe('FY-001')

    const balUpd = txnCalls.find(q => /UPDATE prepaid_cards SET balance = balance - \$1/.test(q.sql))
    expect(balUpd).toBeDefined()
    expect(Number(balUpd.params[0])).toBe(300)

    const insertTxn = txnCalls.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeDefined()
    expect(Number(insertTxn.params[1])).toBe(-300)

    const statusUpd = txnCalls.find(q => /UPDATE sale_orders[\s\S]*status = '已支付'/.test(q.sql))
    expect(statusUpd).toBeDefined()
  })

  test('余额不足 → INSUFFICIENT_BALANCE', async () => {
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '100' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.confirmPrepaidFull(ctx)).rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('payable_amount>0 非全额抵扣 → 拒绝（2026-04-26 paid_amount→payable_amount）', async () => {
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '100', payable_amount: '200', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.confirmPrepaidFull(ctx)).rejects.toThrow(/INVALID_PARAMS.*非全额抵扣/)
  })

  test('订单状态非待支付 → 拒绝', async () => {
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '已支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.confirmPrepaidFull(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许支付/)
  })

  test('幂等：已有扣款流水则不二次写入', async () => {
    const txnCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          txnCalls.push({ sql })
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '500' }], rowCount: 1 }
          }
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            return { rows: [{ '?column?': 1 }], rowCount: 1 } // 已扣过
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await routes.confirmPrepaidFull(ctx)

    expect(ctx.result.status).toBe('已支付')
    // UPDATE balance 和 INSERT 都应跳过
    const balUpd = txnCalls.find(q => /UPDATE prepaid_cards SET balance = balance - /.test(q.sql))
    expect(balUpd).toBeUndefined()
    const insertTxn = txnCalls.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeUndefined()
    // 但 status UPDATE 仍需执行
    const statusUpd = txnCalls.find(q => /UPDATE sale_orders[\s\S]*status = '已支付'/.test(q.sql))
    expect(statusUpd).toBeDefined()
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'other-user',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' })
    await expect(routes.confirmPrepaidFull(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  // ====== 2026-05-19 dirty-read 修复：版本号校验 ======
  test('confirmPrepaidFull 传过期 expectedBalanceUpdatedAt → 抛 CONFLICT，余额不变', async () => {
    const lockedTs = new Date('2026-05-19T10:00:00Z')
    const expectedTs = new Date('2026-05-19T09:55:00Z') // 5 分钟前的快照，已过期
    const txnCalls = []
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          txnCalls.push({ sql })
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '500', updated_at: lockedTs }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-001',
      expectedBalanceUpdatedAt: expectedTs.toISOString(),
    })
    await expect(routes.confirmPrepaidFull(ctx)).rejects.toThrow(/CONFLICT.*余额已变动/)
    // 不应执行 UPDATE balance / INSERT card_transactions
    const balUpd = txnCalls.find(q => /UPDATE prepaid_cards SET balance = balance - /.test(q.sql))
    expect(balUpd).toBeUndefined()
    const insertTxn = txnCalls.find(q => /INSERT INTO card_transactions/.test(q.sql))
    expect(insertTxn).toBeUndefined()
  })

  test('confirmPrepaidFull 不传 expectedBalanceUpdatedAt → 兼容旧前端（版本校验跳过）', async () => {
    const lockedTs = new Date('2026-05-19T10:00:00Z')
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (/SELECT sale_order_id, status, client_user_id/.test(sql)) {
            return {
              rows: [{
                sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
                prepaid_card_amount: '0', pending_prepaid_card_amount: '300', payable_amount: '0', total_amount: '300',
              }],
              rowCount: 1,
            }
          }
          if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
            return { rows: [{ card_id: 'card-1', balance: '500', updated_at: lockedTs }], rowCount: 1 }
          }
          if (/FROM card_transactions/.test(sql) && /type = '扣款'/.test(sql)) {
            return { rows: [], rowCount: 0 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ saleOrderId: 'FY-001' }) // 不传 expectedBalanceUpdatedAt
    await routes.confirmPrepaidFull(ctx)
    expect(ctx.result.status).toBe('已支付')
  })
})
