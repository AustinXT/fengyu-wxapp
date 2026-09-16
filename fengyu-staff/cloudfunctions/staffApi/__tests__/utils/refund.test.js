/**
 * 退款工具单元测试（ticket FY-XSD-WX-2607150028 — 多收余数 overpay）
 *
 * 覆盖：
 *   - computeOverpayRemainder：部分支付单 received 不能被单次价整除时的订单级孤儿零头
 *     · 整除无零头 → 0
 *     · 不整除有零头（本工单 3000 = 7×398 + 214）→ 214
 *     · 已消耗价值先扣
 *     · 已退款 refunded_amount 从 received 扣
 *     · 家居 picked_up 计入已消耗
 *   - OVERPAY_SENTINEL 常量非空（防 refund-cascade 空明细兜底误全退）
 */

const {
  buildRefundDetails,
  computeItemOverpayRemainders,
  computeOverpayRemainder,
  calculateUnusedQuantity,
  isHandlingFeeInvalidForRefund,
  isZeroCashPaidSessionRefund,
  OVERPAY_SENTINEL,
} = require('../../utils/refund')

describe('OVERPAY_SENTINEL', () => {
  test('非空字符串（null 会触发 refund-cascade 空明细兜底误全退）', () => {
    expect(OVERPAY_SENTINEL).toBeTruthy()
    expect(typeof OVERPAY_SENTINEL).toBe('string')
  })
})

describe('computeOverpayRemainder 多收余数（overpay）', () => {
  // 构造疗程卡品项（session_count=1，paid_sessions 控制 unused）
  const card = (overrides = {}) => ({
    product_type: '疗程卡',
    session_count: 1,
    remaining_sessions: 1,
    paid_sessions: 1,
    unit_real_price: 398,
    ...overrides,
  })

  test('整除无零头 → 0（received = Σ 整次×单价）', () => {
    const order = { received: 2786, refunded_amount: 0 }
    const items = Array.from({ length: 7 }, () => card())
    // 7×398=2786 全付全未用，received 恰整除 → 无余数
    expect(computeOverpayRemainder(order, items)).toBe(0)
  })

  test('不整除有零头 → 余数（本工单 3000 = 7×398 + 214 → 214）', () => {
    const order = { received: 3000, refunded_amount: 0 }
    // 7 个满次品项（各 398）+ 多收的 214 不对应任何整次
    const items = Array.from({ length: 7 }, () => card())
    expect(computeOverpayRemainder(order, items)).toBe(214)
  })

  test('余数单独退：7 项已退完（paid_sessions=0），只剩 214 余数', () => {
    // 第二次退款场景：received=3000、refunded=2786 → netReceived=214；所有品项 paid_sessions=0
    const order = { received: 3000, refunded_amount: 2786 }
    const items = Array.from({ length: 19 }, () => card({ paid_sessions: 0 }))
    // consumedValue=0、maxSessionRefundable=0（全 paid_sessions=0 → unused=0）→ 余数 = 214-0-0 = 214
    expect(computeOverpayRemainder(order, items)).toBe(214)
  })

  test('已消耗次数的价值先扣（已消费的次数不可退）', () => {
    // 1 张 10 次卡，单价 100，已消费 3 次（remaining=7），received=1000 全付
    const order = { received: 1000, refunded_amount: 0 }
    const items = [{
      product_type: '疗程卡', session_count: 10, remaining_sessions: 7,
      paid_sessions: 10, unit_real_price: 100,
    }]
    // consumedValue = (10-7)×100 = 300；maxSessionRefundable = unused(7)×100 = 700
    // netReceived 1000 - 300 - 700 = 0
    expect(computeOverpayRemainder(order, items)).toBe(0)
  })

  test('已消耗 + 多收零头共存：余数 = netReceived − 已消耗 − 整次可退', () => {
    // 1 张 10 次卡单价 100，已消费 3 次，received=1050（多收 50 零头）
    const order = { received: 1050, refunded_amount: 0 }
    const items = [{
      product_type: '疗程卡', session_count: 10, remaining_sessions: 7,
      paid_sessions: 10, unit_real_price: 100,
    }]
    // consumed=300、unused=7×100=700 → 余数 = 1050 - 300 - 700 = 50
    expect(computeOverpayRemainder(order, items)).toBe(50)
  })

  test('已退款 refunded_amount 从 received 扣（不重复退）', () => {
    const order = { received: 3000, refunded_amount: 1000 }
    const items = Array.from({ length: 5 }, () => card()) // 5×398=1990 整次可退
    // netReceived = 3000-1000 = 2000；consumed=0；maxSession=1990 → 余数 = 2000-0-1990 = 10
    expect(computeOverpayRemainder(order, items)).toBe(10)
  })

  test('家居已提货计入已消耗价值', () => {
    const order = { received: 500, refunded_amount: 0 }
    const items = [{
      product_type: '家居产品', quantity: 2, picked_up_quantity: 1,
      unit_real_price: 200, session_count: null,
    }]
    // 家居 unused = quantity-picked = 1；consumedValue = picked(1)×200 = 200
    // maxSession = unused(1)×200 = 200 → 余数 = 500 - 200 - 200 = 100
    expect(computeOverpayRemainder(order, items)).toBe(100)
  })

  test('净已收不足（received − refunded < 已消耗+可退）→ max(0) 兜底为 0', () => {
    const order = { received: 100, refunded_amount: 0 }
    const items = Array.from({ length: 7 }, () => card()) // 7×398=2786 远超 100
    // netReceived 100 - 0 - 2786 < 0 → 0
    expect(computeOverpayRemainder(order, items)).toBe(0)
  })

  test('无品项/空订单 → 余数 = 全部净已收（整单纯现金退）', () => {
    expect(computeOverpayRemainder({ received: 214, refunded_amount: 0 }, [])).toBe(214)
    expect(computeOverpayRemainder({ received: 214, refunded_amount: 0 }, null)).toBe(214)
  })

  test('与 calculateUnusedQuantity 口径一致：paid_sessions=0 的部分支付项不计入整次可退', () => {
    // 本工单品项 066：received=214、session_count=1 → paid_sessions=floor(214/398)=0 → unused=0
    const partialItem = {
      product_type: '疗程卡', session_count: 1, remaining_sessions: 1,
      paid_sessions: 0, unit_real_price: 398,
    }
    expect(calculateUnusedQuantity(partialItem)).toBe(0)
    // 7 满次项 + 1 部分支付项：maxSessionRefundable 仍 = 7×398（部分项贡献 0）
    const order = { received: 3000, refunded_amount: 0 }
    const items = [...Array.from({ length: 7 }, () => card()), partialItem]
    expect(computeOverpayRemainder(order, items)).toBe(214)
  })
})

describe('buildRefundDetails 行级多收余数', () => {
  const card = (overrides = {}) => ({
    sale_item_id: 'SI',
    sku_id: null,
    product_name: '面部护理卡',
    product_type: '疗程卡',
    session_count: 1,
    remaining_sessions: 1,
    paid_sessions: 1,
    unit_price: 100,
    quantity: 1,
    unit_real_price: 100,
    picked_up_quantity: null,
    sales_category: null,
    service_fee: 0,
    sale_amount: 100,
    received: 100,
    ...overrides,
  })

  test('行级余数只并入所属商品子项，退款 A 不影响 B', () => {
    const a = card({ sale_item_id: 'SI-A', received: 150 })
    const b = card({ sale_item_id: 'SI-B', received: 100 })

    const overpayByItem = computeItemOverpayRemainders([a, b])
    expect(overpayByItem.get('SI-A')).toBe(50)
    expect(overpayByItem.get('SI-B')).toBe(0)

    const { refundDetails, totalRefund } = buildRefundDetails(
      [a, b],
      [{ saleItemId: 'SI-A', includeOverpay: true }],
    )
    expect(refundDetails).toHaveLength(1)
    expect(refundDetails[0].refSaleItemId).toBe('SI-A')
    expect(refundDetails[0].quantity).toBe(1)
    expect(refundDetails[0].overpayAmount).toBe(50)
    expect(refundDetails[0].refundAmount).toBe(150)
    expect(totalRefund).toBe(150)
  })

  test('显式 refundQuantity=0 且 includeOverpay=true 时允许只退该行余数', () => {
    const a = card({ sale_item_id: 'SI-A', received: 150 })

    const { refundDetails, totalRefund } = buildRefundDetails(
      [a],
      [{ saleItemId: 'SI-A', refundQuantity: 0, includeOverpay: true }],
    )
    expect(refundDetails[0].quantity).toBe(0)
    expect(refundDetails[0].overpayAmount).toBe(50)
    expect(refundDetails[0].refundAmount).toBe(50)
    expect(refundDetails[0].isFullItemRefund).toBe(false)
    expect(totalRefund).toBe(50)
  })

  test('券全额抵扣疗程卡：保留退项数量，现金退款额为 0', () => {
    const a = card({
      sale_item_id: 'SI-ZERO',
      session_count: 5,
      remaining_sessions: 5,
      paid_sessions: 5,
      unit_real_price: 0,
      sale_amount: 0,
      received: 0,
    })

    const { refundDetails, totalRefund } = buildRefundDetails(
      [a],
      [{ saleItemId: 'SI-ZERO' }],
    )
    expect(refundDetails[0].quantity).toBe(5)
    expect(refundDetails[0].unitRealPrice).toBe(0)
    expect(refundDetails[0].saleAmount).toBe(0)
    expect(refundDetails[0].refundAmount).toBe(0)
    expect(refundDetails[0].isFullItemRefund).toBe(true)
    expect(totalRefund).toBe(0)
  })
})

describe('isZeroCashPaidSessionRefund', () => {
  const freeCard = (overrides = {}) => ({
    sale_item_id: 'SI-ZERO',
    sku_id: 'SKU-ZERO',
    product_name: '赠送护理卡',
    product_type: '疗程卡',
    session_count: 5,
    remaining_sessions: 5,
    paid_sessions: 5,
    unit_price: 0,
    quantity: 1,
    unit_real_price: 0,
    sale_amount: 0,
    received: 0,
    picked_up_quantity: null,
    sales_category: null,
    service_fee: 0,
    ...overrides,
  })

  test('0 元疗程卡零消费全退允许走 0 元退项', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [freeCard()],
      [{ saleItemId: 'SI-ZERO' }],
    )

    expect(refundDetails[0].isFullItemRefund).toBe(true)
    expect(isZeroCashPaidSessionRefund(refundDetails, 0, totalRefund)).toBe(true)
  })

  test('0 元疗程卡已消费部分次数时拒绝 0 元退项豁免', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [freeCard({ session_count: 5, remaining_sessions: 3, paid_sessions: 5 })],
      [{ saleItemId: 'SI-ZERO' }],
    )

    expect(refundDetails[0].quantity).toBe(3)
    expect(refundDetails[0].isFullItemRefund).toBe(false)
    expect(isZeroCashPaidSessionRefund(refundDetails, 0, totalRefund)).toBe(false)
  })
})

describe('isHandlingFeeInvalidForRefund', () => {
  test('0 元赠送疗程不参与手续费上限，0 手续费不会被误判超限', () => {
    const details = [
      { productType: '疗程卡', unitRealPrice: 199 },
      { productType: '疗程卡', unitRealPrice: 0 },
      { productType: '疗程卡', unitRealPrice: 0 },
    ]

    expect(isHandlingFeeInvalidForRefund(details, 0)).toBe(false)
    expect(isHandlingFeeInvalidForRefund(details, 1)).toBe(false)
    expect(isHandlingFeeInvalidForRefund(details, 199)).toBe(true)
  })

  test('只有 0 元疗程时不使用 0 作为手续费上限', () => {
    expect(isHandlingFeeInvalidForRefund([
      { productType: '疗程卡', unitRealPrice: 0 },
    ], 1)).toBe(false)
  })
})

describe('calculateUnusedQuantity — 家居受「剩余已付」封顶（#145/#153）', () => {
  const home = (over = {}) => ({
    product_type: '家居产品',
    quantity: 10,
    picked_up_quantity: 0,
    unit_real_price: '100',
    received: '1000',
    picked_quantity: 0,
    converted_amount: '0',
    ...over,
  })

  // 折抵能带走「剩余已付」的**全部金额**却只占用向下取整的件数（付 ¥450 折 4 件带走 ¥450），
  // 剩下的物理件已经没有对应的已付金额了。只按 quantity − picked_up_quantity 判可退，
  // 顾客能折走 ¥450 之后再退 ¥450，而他只付了 ¥450。
  test('折走全部已付后不可再退（付 450 → 折 4 件带走 450 → 可退 0）', () => {
    expect(calculateUnusedQuantity(home({
      picked_up_quantity: 4, received: '450', converted_amount: '450',
    }))).toBe(0)
  })

  test('未折抵的部分支付按已付整件数封顶（付 450 → 可退 4 件）', () => {
    expect(calculateUnusedQuantity(home({ received: '450' }))).toBe(4)
  })

  test('付清未提可退全部', () => {
    expect(calculateUnusedQuantity(home())).toBe(10)
  })

  test('已提货件从剩余已付里扣（付清已提 3 → 可退 7）', () => {
    expect(calculateUnusedQuantity(home({ picked_up_quantity: 3, picked_quantity: 3 }))).toBe(7)
  })

  // received 已由 paid-sessions STEP 1.5 扣过退款，picked_up_quantity 又含退款结算数，
  // 两边都减就是重复扣减（顾客少退）。
  test('退款件不重复扣减（付清 10 件退 2 件 → 仍可退 8）', () => {
    expect(calculateUnusedQuantity(home({
      picked_up_quantity: 2, received: '800', picked_quantity: 0,
    }))).toBe(8)
  })

  test('分币单价按分整除，与 PG numeric 一致（16.67 × 3 = 50.01 → 3 件）', () => {
    expect(calculateUnusedQuantity(home({
      quantity: 3, unit_real_price: '16.67', received: '50.01',
    }))).toBe(3)
  })

  // 历史调用方（未传聚合）零回归：回退到物理剩余，金额门仍兜底
  test('未传 picked_quantity / converted_amount 时回退物理剩余', () => {
    expect(calculateUnusedQuantity({
      product_type: '家居产品', quantity: 10, picked_up_quantity: 3,
      unit_real_price: '100', received: '1000',
    })).toBe(7)
  })

  test('单价为 0（赠品行）回退物理剩余，不被零除', () => {
    expect(calculateUnusedQuantity(home({ unit_real_price: '0', received: '0' }))).toBe(10)
  })
})

describe('computeItemOverpayRemainders — 家居余数按实际已转走金额算（#145/#153）', () => {
  const home = (over = {}) => ({
    sale_item_id: 'si-1',
    product_type: '家居产品',
    quantity: 10,
    picked_up_quantity: 0,
    unit_real_price: '100',
    received: '1000',
    picked_quantity: 0,
    converted_amount: '0',
    ...over,
  })
  const overpayOf = (row) => computeItemOverpayRemainders([row]).get(row.sale_item_id)

  // 折抵带走的是「剩余已付」的实际金额（付 ¥450 折 4 件带走 ¥450），
  // 用 picked_up_quantity × 单价（= 400）算已消耗，差额 ¥50 会被误判成多收余数再退一次。
  test('折走全部已付后余数为 0（付 450 折 4 件带走 450）', () => {
    expect(overpayOf(home({
      picked_up_quantity: 4, received: '450', converted_amount: '450',
    }))).toBe(0)
  })

  test('未折抵的部分支付保留真实余数（付 450 → 可退 4 件 + ¥50 余数）', () => {
    expect(overpayOf(home({ received: '450' }))).toBe(50)
  })

  test('已提货件按实际提货金额扣（付清已提 3 → 无余数）', () => {
    expect(overpayOf(home({ picked_up_quantity: 3, picked_quantity: 3 }))).toBe(0)
  })

  // 历史调用方未传聚合时回退旧口径（picked_up_quantity × 单价），零回归
  test('未传聚合字段时回退旧口径', () => {
    expect(overpayOf({
      sale_item_id: 'si-2', product_type: '家居产品', quantity: 10,
      picked_up_quantity: 3, unit_real_price: '100', received: '1000',
    })).toBe(0)
  })

  test('疗程卡不受影响，仍按已消费次数算', () => {
    expect(overpayOf({
      sale_item_id: 'si-3', product_type: '疗程卡', quantity: 1,
      session_count: 10, remaining_sessions: 7, paid_sessions: 10,
      unit_real_price: '100', received: '1050', picked_up_quantity: 0,
    })).toBe(50)
  })
})
