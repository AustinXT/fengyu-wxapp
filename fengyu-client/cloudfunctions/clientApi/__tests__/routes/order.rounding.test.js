/**
 * order.create 浮点 round 兜底测试
 *
 * 见 notes/tickets/2026-05-17-client-order-no-coupon-rounding.md
 *
 * 断言原则（R2）：
 *   - 不使用 toBe(具体值)：业务夹具无 0.1/0.29 价档，且 5.55*3=16.65 精确不漂移
 *   - 改用「小数位数 ≤ 2」语义断言：(value * 100) 必须严格为整数
 *   - 修复前所有 case 必 fail（漂移值 × 100 非整数）；修复后全部 pass
 *
 * Node 实测漂移基线：
 *   0.1 + 0.2     === 0.30000000000000004
 *   0.1 * 3       === 0.30000000000000004
 *   1.1 * 3       === 3.3000000000000003
 *   0.2 * 3       === 0.6000000000000001
 *   0.3 * 3       === 0.8999999999999999
 *   0.29 * 100    === 28.999999999999996
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/order') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/order')
})

/**
 * 断言：value 必须是 number 且小数位 ≤ 2
 * 浮点漂移会让 (value * 100) % 1 !== 0
 */
function expectAt2Decimals(value) {
  expect(typeof value).toBe('number')
  expect(Number.isFinite(value)).toBe(true)
  // 严格 0：浮点漂移会让此处 fail（例如 0.30000000000000004 * 100 = 30.000000000000004）
  expect((value * 100) % 1).toBe(0)
}

function mockNoCouponCreate(specialPrice) {
  // mock 1: 门店
  pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
  // mock 2: closeExpiredOrdersByUser
  pg.query.mockResolvedValueOnce([])
  // mock 3: check pending
  pg.query.mockResolvedValueOnce([])
  // mock 4: SKU 信息（无券路径用 special_price 注入纯小数驱动值，绕过业务价档）
  pg.query.mockResolvedValueOnce([{
    sku_id: 'sku-float', product_id: 'p-float', product_type: '疗程卡',
    spec_name: '浮点驱动 SKU', price: String(specialPrice), special_price: String(specialPrice),
    session_count: 1, sales_category: null,
    is_recharge_card: false, is_experience: false,
  }])
  // mock 5: 顾客名 + customer_type（document_type 判断）
  pg.query.mockResolvedValueOnce([{ name: '张三', customer_type: '会员客' }])
}

function captureInsertCalls() {
  const insertCalls = []
  pg.transaction.mockImplementation(async (cb) => {
    const client = {
      query: vi.fn(async (sql, params) => {
        if (/INSERT INTO sale_orders/i.test(sql)) {
          insertCalls.push({ sql, params })
        }
        // 优惠券 claim UPDATE 需要 rowCount=1，否则 routes/order.js L519-521 抛"优惠券已失效"
        if (/UPDATE user_coupons/i.test(sql)) {
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    await cb(client)
    return undefined
  })
  return insertCalls
}

describe('order.create 浮点 round 兜底（R2 真漂移 case）', () => {
  // case 1：经典 0.1 + 0.1 + 0.1 = 0.30000000000000004
  test('无券 0.1×3 ─ saleAmount=0.30000000000000004 应 round 到 0.30', async () => {
    mockNoCouponCreate(0.1)
    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 3 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 2：1.1 × 3 = 3.3000000000000003（漂移 +3e-16）
  test('无券 1.1×3 ─ 漂移 +3e-16 应 round 到 3.30', async () => {
    mockNoCouponCreate(1.1)
    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 3 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 3：0.2 × 3 = 0.6000000000000001
  test('无券 0.2×3 ─ 漂移 +1e-16 应 round 到 0.60', async () => {
    mockNoCouponCreate(0.2)
    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 3 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 4：0.3 × 3 = 0.8999999999999999（反向漂移 -1e-16）
  test('无券 0.3×3 ─ 反向漂移 -1e-16 应 round 到 0.90', async () => {
    mockNoCouponCreate(0.3)
    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 3 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 5：0.29 × 100 = 28.999999999999996（大 quantity）
  test('无券 0.29×100 ─ 大 quantity 累加漂移应 round 到 29.00', async () => {
    mockNoCouponCreate(0.29)
    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 100 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 6：INSERT 参数同步断言（修复后 PG 收到的 total_amount 也是干净 2 位）
  // SQL: INSERT INTO sale_orders (...total_amount...) VALUES (...$10...)
  //   params 顺序：[orderNo, status, documentType, marketName, storeId, now, userId,
  //                phone, customerName, totalAmount, prepaidCardAmount, ...]
  //   → totalAmount = params[9]（$10）
  test('无券 1.1×3 ─ INSERT sale_orders.total_amount ($10) 应 ≤ 2 位小数', async () => {
    mockNoCouponCreate(1.1)
    const insertCalls = captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 3 }],
      paymentMethod: '微信',
    })
    await routes.create(ctx)

    expect(insertCalls).toHaveLength(1)
    const totalAmountParam = insertCalls[0].params[9]
    expectAt2Decimals(Number(totalAmountParam))
  })

  // case 7：有券路径回归 — 原 L391-392 round 路径必须仍生效
  test('有券：现金券抵扣后 totalAmount 仍 ≤ 2 位（回归保护）', async () => {
    // mock 1: 门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // mock 2: closeExpired
    pg.query.mockResolvedValueOnce([])
    // mock 3: check pending
    pg.query.mockResolvedValueOnce([])
    // mock 4: SKU（0.29 × 7 = 2.0299999999999994 ─ 漂移基线）
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-float', product_id: 'p-float', product_type: '疗程卡',
      spec_name: '浮点 SKU', price: '0.29', special_price: '0.29',
      session_count: 1, sales_category: null,
      is_recharge_card: false, is_experience: false,
    }])
    // mock 5: coupon validate
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-r', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 0.5, min_spend: 0,
      max_discount: null,
      applicable_category_ids: null, applicable_store_ids: null,
      applicable_product_ids: null, applicable_market_ids: null,
    }])
    // mock 6: skuMeta
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-float', category_id: 'cat-1', product_id: 'p-float' }])
    // mock 7: customer name
    pg.query.mockResolvedValueOnce([{ name: '李四', customer_type: '会员客' }])

    captureInsertCalls()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-float', quantity: 7 }],
      paymentMethod: '微信',
      couponId: 'cpn-r',
    })
    await routes.create(ctx)

    expectAt2Decimals(ctx.result.totalAmount)
  })
})
