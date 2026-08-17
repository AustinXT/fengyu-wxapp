const { cascadeRefund } = require('../../helpers/refund-cascade')

describe('cascadeRefund 分享礼券回收', () => {
  test('整单退款将两个礼券 ID 作为单个 text[] 参数绑定', async () => {
    const queries = []
    const client = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params })
        if (/FROM point_transactions/.test(sql)) {
          return { rows: [{ g: 0, user_id: null }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    }

    await cascadeRefund(client, {
      saleOrderId: 'FY-XSD-WX-TEST',
      refundPaymentId: 1,
      items: [{
        saleItemId: 'ITEM-1',
        sessionCount: null,
        refundAmount: 0,
        isFullItemRefund: false,
      }],
      isWholeOrderRefund: true,
      refundReason: '测试整单退款',
    })

    const shareGiftQuery = queries.find(({ sql }) => /coupon_id = ANY\(\$1::text\[\]\)/.test(sql))
    expect(shareGiftQuery).toBeDefined()
    expect(shareGiftQuery.params).toEqual([[
      'sg-inviter-FY-XSD-WX-TEST',
      'sg-invitee-FY-XSD-WX-TEST',
    ]])
  })
})
