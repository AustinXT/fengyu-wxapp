import { describe, it, expect } from 'vitest'
import {
  buildRefundDetails,
  capRefundAmounts,
  computeOverpayRemainder,
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

  it('家居产品：refundQuantity 生效（部分退）', () => {
    const homeItem: RefundSourceItem = {
      sale_item_id: 'SI-HOME-1',
      sku_id: 'SKU-2',
      product_name: '家居精华',
      product_type: '家居产品',
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
})

describe('computeOverpayRemainder 多收余数（overpay，ticket FY-XSD-WX-2607150028）', () => {
  /** 单次疗程卡源行（admin 驼峰字段） */
  function card(overrides: Partial<RefundSourceItem> = {}): RefundSourceItem {
    return {
      sale_item_id: 'SI',
      sku_id: null,
      product_name: '面部三重维养',
      product_type: '疗程卡',
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
