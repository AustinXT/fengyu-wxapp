import { describe, it, expect } from 'vitest'
import {
  buildRefundDetails,
  capRefundAmounts,
  computeItemOverpayRemainders,
  computeOverpayRemainder,
  isHandlingFeeInvalidForRefund,
  isZeroCashPaidSessionRefund,
  OVERPAY_SENTINEL,
  type RefundSourceItem,
} from '../refund'

describe('capRefundAmounts', () => {
  it('单项缩放：[1000] total=1000 target=200 → 该项=200、返回 200', () => {
    const details = [{ refundAmount: 1000 }]
    const ret = capRefundAmounts(details, 1000, 200)
    expect(ret).toBe(200)
    expect(details[0].refundAmount).toBe(200)
  })

  it('多项等比 + 整除无余数：[700,300] total=1000 target=200 → [140,60]、和精确=200', () => {
    const details = [{ refundAmount: 700 }, { refundAmount: 300 }]
    const ret = capRefundAmounts(details, 1000, 200)
    expect(ret).toBe(200)
    expect(details[0].refundAmount).toBe(140)
    expect(details[1].refundAmount).toBe(60)
    expect(details[0].refundAmount + details[1].refundAmount).toBe(200)
  })

  it('多项等比 + 最大余数补到较大项：[333.33,666.67] total=1000 target=200 → 和精确=200、尾差落较大项', () => {
    const details = [{ refundAmount: 333.33 }, { refundAmount: 666.67 }]
    const ret = capRefundAmounts(details, 1000, 200)
    expect(ret).toBe(200)
    // floor 后：66.66 + 133.33 = 199.99，尾差 0.01 补到较大项（item1）
    expect(details[0].refundAmount).toBe(66.66)
    expect(details[1].refundAmount).toBe(133.34)
    expect(details[0].refundAmount + details[1].refundAmount).toBe(200)
  })

  it('不截断：targetGross > originalTotal 原样返回、各项不变', () => {
    const details = [{ refundAmount: 500 }, { refundAmount: 300 }]
    const ret = capRefundAmounts(details, 800, 1000)
    expect(ret).toBe(800)
    expect(details[0].refundAmount).toBe(500)
    expect(details[1].refundAmount).toBe(300)
  })

  it('不截断：targetGross === originalTotal 原样返回、各项不变', () => {
    const details = [{ refundAmount: 500 }, { refundAmount: 300 }]
    const ret = capRefundAmounts(details, 800, 800)
    expect(ret).toBe(800)
    expect(details[0].refundAmount).toBe(500)
    expect(details[1].refundAmount).toBe(300)
  })

  it('边界：originalTotal<=0 原样返回、不缩放', () => {
    const details = [{ refundAmount: 100 }]
    const ret = capRefundAmounts(details, 0, -10)
    expect(ret).toBe(0)
    expect(details[0].refundAmount).toBe(100)
  })

  it('边界：空明细原样返回 originalTotal', () => {
    const details: Array<{ refundAmount: number }> = []
    const ret = capRefundAmounts(details, 1000, 200)
    expect(ret).toBe(1000)
  })
})

describe('buildRefundDetails', () => {
  /** 疗程卡源行：未消费、未退过 → maxUnused = remaining_sessions */
  function courseCardItem(): RefundSourceItem {
    return {
      sale_item_id: 'SI-CARD-1',
      sku_id: 'SKU-1',
      product_name: '面部护理卡',
      product_type: '疗程卡',
      refunded_quantity: 0,
      converted_quantity: 0,
      session_count: 10,
      remaining_sessions: 10,
      paid_sessions: 10,
      unit_price: '100',
      quantity: 1,
      unit_real_price: '100',
      picked_up_quantity: null,
      sales_category: null,
      service_fee: 0,
    }
  }

  it('疗程卡整卡全退：传 refundQuantity=2 但 maxUnused=10 → requested=10、refundAmount=10×unit', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [courseCardItem()],
      [{ saleItemId: 'SI-CARD-1', refundQuantity: 2 }],
    )

    expect(refundDetails).toHaveLength(1)
    const d = refundDetails[0]
    // 强制整卡全退：忽略传入的 refundQuantity=2，requested = maxUnused = 10
    expect(d.quantity).toBe(10)
    expect(d.unitRealPrice).toBe(100)
    expect(d.refundAmount).toBe(1000) // 10 × 100
    expect(d.isFullItemRefund).toBe(true)
    expect(totalRefund).toBe(1000)
  })

  it('疗程卡：不传 refundQuantity 同样整卡全退', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [courseCardItem()],
      [{ saleItemId: 'SI-CARD-1' }],
    )
    expect(refundDetails[0].quantity).toBe(10)
    expect(refundDetails[0].refundAmount).toBe(1000)
    expect(totalRefund).toBe(1000)
  })

  it('券全额抵扣疗程卡：保留退项数量，现金退款额为 0', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [{
        ...courseCardItem(),
        unit_real_price: '0',
        sale_amount: '0',
        received: '0',
      }],
      [{ saleItemId: 'SI-CARD-1' }],
    )

    expect(refundDetails[0].quantity).toBe(10)
    expect(refundDetails[0].unitRealPrice).toBe(0)
    expect(refundDetails[0].saleAmount).toBe(0)
    expect(refundDetails[0].refundAmount).toBe(0)
    expect(refundDetails[0].isFullItemRefund).toBe(true)
    expect(totalRefund).toBe(0)
  })

  it('家居产品：refundQuantity 生效（部分退）', () => {
    const homeItem: RefundSourceItem = {
      sale_item_id: 'SI-HOME-1',
      sku_id: 'SKU-2',
      product_name: '家居精华',
      product_type: '家居产品',
      refunded_quantity: 0,
      converted_quantity: 0,
      session_count: null,
      remaining_sessions: null,
      paid_sessions: null,
      unit_price: '50',
      quantity: 5,
      unit_real_price: '50',
      picked_up_quantity: 0,
      sales_category: null,
      service_fee: 0,
    }
    const { refundDetails, totalRefund } = buildRefundDetails(
      [homeItem],
      [{ saleItemId: 'SI-HOME-1', refundQuantity: 2 }],
    )
    expect(refundDetails[0].quantity).toBe(2)
    expect(refundDetails[0].refundAmount).toBe(100) // 2 × 50
    expect(totalRefund).toBe(100)
  })

  it('行级余数只并入所属商品子项，退款 A 不影响 B', () => {
    const a = {
      ...courseCardItem(),
      sale_item_id: 'SI-A',
      session_count: 1,
      remaining_sessions: 1,
      paid_sessions: 1,
      unit_real_price: '100',
      unit_price: '100',
      sale_amount: '100',
      received: '150',
    }
    const b = {
      ...courseCardItem(),
      sale_item_id: 'SI-B',
      session_count: 1,
      remaining_sessions: 1,
      paid_sessions: 1,
      unit_real_price: '100',
      unit_price: '100',
      sale_amount: '100',
      received: '100',
    }

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

  it('显式 refundQuantity=0 且 includeOverpay=true 时允许只退该行余数', () => {
    const a = {
      ...courseCardItem(),
      sale_item_id: 'SI-A',
      session_count: 1,
      remaining_sessions: 1,
      paid_sessions: 1,
      unit_real_price: '100',
      unit_price: '100',
      sale_amount: '100',
      received: '150',
    }

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
})

describe('isZeroCashPaidSessionRefund', () => {
  const freeCard = (overrides: Partial<RefundSourceItem> = {}): RefundSourceItem => ({
    sale_item_id: 'SI-ZERO',
    sku_id: 'SKU-ZERO',
    product_name: '赠送护理卡',
    product_type: '疗程卡',
    refunded_quantity: 0,
    converted_quantity: 0,
    session_count: 5,
    remaining_sessions: 5,
    paid_sessions: 5,
    unit_price: '0',
    quantity: 1,
    unit_real_price: '0',
    sale_amount: '0',
    received: '0',
    picked_up_quantity: null,
    sales_category: null,
    service_fee: 0,
    ...overrides,
  })

  it('0 元疗程卡零消费全退允许走 0 元退项', () => {
    const { refundDetails, totalRefund } = buildRefundDetails(
      [freeCard()],
      [{ saleItemId: 'SI-ZERO' }],
    )

    expect(refundDetails[0].isFullItemRefund).toBe(true)
    expect(isZeroCashPaidSessionRefund(refundDetails, 0, totalRefund)).toBe(true)
  })

  it('0 元疗程卡已消费部分次数时拒绝 0 元退项豁免', () => {
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
  it('0 元赠送疗程不参与手续费上限，0 手续费不会被误判超限', () => {
    const details = [
      { productType: '疗程卡' as const, unitRealPrice: 199 },
      { productType: '疗程卡' as const, unitRealPrice: 0 },
      { productType: '疗程卡' as const, unitRealPrice: 0 },
    ]

    expect(isHandlingFeeInvalidForRefund(details, 0)).toBe(false)
    expect(isHandlingFeeInvalidForRefund(details, 1)).toBe(false)
    expect(isHandlingFeeInvalidForRefund(details, 199)).toBe(true)
  })

  it('只有 0 元疗程时不使用 0 作为手续费上限', () => {
    expect(isHandlingFeeInvalidForRefund([
      { productType: '疗程卡' as const, unitRealPrice: 0 },
    ], 1)).toBe(false)
  })
})

describe('computeOverpayRemainder 多收余数（overpay，ticket FY-XSD-WX-2607150028）', () => {
  /** 单次疗程卡源行（admin 驼峰字段） */
  function card(overrides: Partial<RefundSourceItem> = {}): RefundSourceItem {
    return {
      sale_item_id: 'SI',
      sku_id: null,
      product_name: '面部三重维养',
      product_type: '疗程卡',
      refunded_quantity: 0,
      converted_quantity: 0,
      session_count: 1,
      remaining_sessions: 1,
      paid_sessions: 1,
      unit_price: '398',
      quantity: 1,
      unit_real_price: '398',
      picked_up_quantity: null,
      sales_category: null,
      service_fee: 0,
      ...overrides,
    }
  }

  it('OVERPAY_SENTINEL 非空（null 会触发 refund-cascade 空明细兜底误全退）', () => {
    expect(OVERPAY_SENTINEL).toBeTruthy()
    expect(typeof OVERPAY_SENTINEL).toBe('string')
  })

  it('整除无零头 → 0（7×398=2786 恰等于 received）', () => {
    const items = Array.from({ length: 7 }, () => card())
    expect(computeOverpayRemainder({ received: 2786, refundedAmount: 0 }, items)).toBe(0)
  })

  it('不整除有零头 → 余数（本工单 3000 = 7×398 + 214 → 214）', () => {
    const items = Array.from({ length: 7 }, () => card())
    expect(computeOverpayRemainder({ received: 3000, refundedAmount: 0 }, items)).toBe(214)
  })

  it('余数单独退：7 项已退完（paid_sessions=0），只剩 214 余数', () => {
    const items = Array.from({ length: 19 }, () => card({ paid_sessions: 0 }))
    expect(computeOverpayRemainder({ received: 3000, refundedAmount: 2786 }, items)).toBe(214)
  })

  it('已消耗次数价值先扣 + 多收零头共存', () => {
    // 10 次卡单价 100，已消费 3 次（remaining=7），received=1050
    const items = [card({
      sale_item_id: 'SI', session_count: 10, remaining_sessions: 7,
      paid_sessions: 10, unit_real_price: '100', unit_price: '100',
    })]
    // consumed=300、unused=7×100=700 → 余数 = 1050-300-700 = 50
    expect(computeOverpayRemainder({ received: 1050, refundedAmount: 0 }, items)).toBe(50)
  })

  it('空品项 → 余数 = 全部净已收', () => {
    expect(computeOverpayRemainder({ received: 214, refundedAmount: 0 }, [])).toBe(214)
  })
})
