/**
 * 订单路由测试
 * 覆盖：create（正常/重复待支付/10分钟超时/优惠券）、pay、offlinePay、cancel、list、detail、appointableItems、scanDetail
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createBoundCtx, createMockTransactionClient } = require('../helpers')

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
        cover_image: 'https://img.example.com/a.jpg',
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
    expect(ctx.result.items[0].coverImage).toBe('https://img.example.com/a.jpg')
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
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ tradeState: 'CLOSE' })

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
      { sale_order_id: 'FY-001', sale_item_id: 'SI-001', product_name: 'A', received: 95, cover_image: 'https://img.example.com/a.jpg' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.hasMore).toBe(false)
    expect(ctx.result.orders[0].items).toHaveLength(1)
    expect(ctx.result.orders[0].items[0].cover_image).toBe('https://img.example.com/a.jpg')
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
      cover_image: 'https://img.example.com/a.jpg',
    }])
    // payments 并行查询（无明星员工 / 无券 → 但 payments 仍查询）
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.items[0].cover_image).toBe('https://img.example.com/a.jpg')
    expect(ctx.result.payments).toEqual([])

    // 验证明细查询 SQL 包含 cover_image JOIN
    const itemsQuery = pg.query.mock.calls[1][0]
    expect(itemsQuery).toContain('cover_image')
    expect(itemsQuery).toContain('product_skus')
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
    expect(__mocks__.lakalaClient.queryTrade).toHaveBeenCalledWith({
      merchantNo: 'M1', termNo: 'T1', outTradeNo: 'FY-001_1700000000',
    })
    expect(pg.transaction).toHaveBeenCalledTimes(1)
  })

  test('取消已发起且渠道仍 CREATE 的线上待支付单 → 保持本地待支付', async () => {
    pg.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM sale_orders/.test(sql)) return [{
        sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
        store_id: 'store-1', lakala_out_order_no: 'FY-001_1700000000',
      }]
      if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
      return []
    })
    __mocks__.lakalaClient.queryTrade.mockResolvedValueOnce({ ok: true, tradeState: 'CREATE' })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/PAYMENT_INTENT_ACTIVE.*支付结果仍在确认中/)
    expect(pg.transaction).not.toHaveBeenCalled()
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

  test('SQL 仅查有效购买行，并用 pickup_records 拆分真实提货', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({})
    await routes.homeProducts(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('FROM pickup_records')
    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(sql).toContain("si.item_direction = '购买'")
    expect(sql).toContain("si.product_type = '家居产品'")
    expect(sql).toMatch(/FLOOR\(GREATEST\(0, si\.received::numeric\) \* si\.quantity \/ NULLIF\(si\.sale_amount::numeric, 0\)\)/)
    expect(sql).toContain('pending_pickup_quantity > 0')
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
