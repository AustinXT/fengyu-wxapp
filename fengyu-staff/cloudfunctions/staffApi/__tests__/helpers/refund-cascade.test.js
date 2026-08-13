const { cascadeRefund } = require('../../helpers/refund-cascade')

describe('cascadeRefund 分享礼券回滚', () => {
  test('ANY($1::text[]) 只绑定一个数组参数', async () => {
    const saleOrderId = 'FY-TEST-REFUND-001'
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    }

    await cascadeRefund(client, {
      saleOrderId,
      refundPaymentId: 1001,
      items: [{
        saleItemId: 'item-001',
        sessionCount: null,
        refundAmount: 100,
        isFullItemRefund: true,
      }],
      isWholeOrderRefund: true,
      refundReason: '测试整单退款',
    })

    const shareGiftCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('coupon_id = ANY($1::text[])')
    )

    expect(shareGiftCall).toBeTruthy()
    expect(shareGiftCall[1]).toEqual([[
      `sg-inviter-${saleOrderId}`,
      `sg-invitee-${saleOrderId}`,
    ]])
  })
})
