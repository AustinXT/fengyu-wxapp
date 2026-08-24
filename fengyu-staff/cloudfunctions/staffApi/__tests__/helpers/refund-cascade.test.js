const { cascadeRefund } = require('../../helpers/refund-cascade')

describe('cascadeRefund 分享礼券回滚', () => {
  test('ANY($1::text[]) 只绑定一个数组参数', async () => {
    const saleOrderId = 'FY-TEST-REFUND-001'
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('AS positive_amount') && sql.includes('AS prior_refund_amount')) {
          return { rows: [{ sale_item_id: 'item-001', positive_amount: '100.00', prior_refund_amount: '0' }], rowCount: 1 }
        }
        if (sql.includes('SELECT sales_category FROM sale_items')) {
          return { rows: [{ sales_category: '自销自耗' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO sale_payment_item_receipts')) {
          return { rows: [{ id: 1 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
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

describe('cascadeRefund 多收余数商品行冲销', () => {
  test('全额退款时 OVERPAY 冲销真正承载尾款的商品行', async () => {
    const insertedReceipts = []
    const client = {
      query: vi.fn(async (sql, params = []) => {
        if (sql.includes('AS positive_amount') && sql.includes('AS prior_refund_amount')) {
          return {
            rows: [
              { sale_item_id: 'ITEM-1', positive_amount: '265.00', prior_refund_amount: '0' },
              { sale_item_id: 'ITEM-2', positive_amount: '265.00', prior_refund_amount: '0' },
              { sale_item_id: 'ITEM-3', positive_amount: '265.00', prior_refund_amount: '0' },
              { sale_item_id: 'ITEM-4', positive_amount: '205.00', prior_refund_amount: '0' },
            ],
            rowCount: 4,
          }
        }
        if (sql.includes('SELECT sales_category FROM sale_items')) {
          return { rows: [{ sales_category: '自销自耗' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO sale_payment_item_receipts')) {
          insertedReceipts.push({ saleItemId: params[2], amount: params[3] })
          return { rows: [{ id: insertedReceipts.length }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    }

    await cascadeRefund(client, {
      saleOrderId: 'FY-XSD-WX-2607310366',
      refundPaymentId: 5143,
      items: [
        { saleItemId: 'ITEM-1', sessionCount: 1, refundAmount: 265, isFullItemRefund: true },
        { saleItemId: 'ITEM-2', sessionCount: 1, refundAmount: 265, isFullItemRefund: true },
        { saleItemId: 'ITEM-3', sessionCount: 1, refundAmount: 265, isFullItemRefund: true },
        { saleItemId: 'OVERPAY', sessionCount: 0, refundAmount: 205, isFullItemRefund: false, isOverpay: true },
      ],
      isWholeOrderRefund: false,
      refundReason: '测试全额退款',
    })

    expect(insertedReceipts).toEqual([
      { saleItemId: 'ITEM-1', amount: '-265.00' },
      { saleItemId: 'ITEM-2', amount: '-265.00' },
      { saleItemId: 'ITEM-3', amount: '-265.00' },
      { saleItemId: 'ITEM-4', amount: '-205.00' },
    ])
    expect(insertedReceipts.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(-1000)
  })

  test('商品行实收不足以承载整笔退款时回滚', async () => {
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('AS positive_amount') && sql.includes('AS prior_refund_amount')) {
          return {
            rows: [{ sale_item_id: 'ITEM-1', positive_amount: '100.00', prior_refund_amount: '0' }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    }

    await expect(cascadeRefund(client, {
      saleOrderId: 'FY-TEST-INSUFFICIENT-RECEIPT',
      refundPaymentId: 9001,
      items: [{ saleItemId: 'ITEM-1', sessionCount: 1, refundAmount: 120, isFullItemRefund: true }],
      isWholeOrderRefund: true,
      refundReason: '超额退款守卫',
    })).rejects.toThrow('INVALID_STATE: 退款金额无法完整映射到商品行实收')

    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO sale_payment_item_receipts'))).toBe(false)
  })
})
