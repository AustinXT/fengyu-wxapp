const { cascadeRefund, planRolePoolRefundAllocations } = require('../../helpers/refund-cascade')

describe('退款营业额按角色池独立冲销', () => {
  const row = (overrides = {}) => ({
    employee_id: 'emp-1', role_type: '美容师', dept: '美容部',
    sum_total: '2700.00', prior_negative_total: '0',
    rate: '0.1200', sum_comm: '324.00', prior_negative_comm: '0',
    positive_receipt_total: '2700.00', prior_refund_receipt_total: '0',
    ...overrides,
  })

  test('两个 100% 角色池全退时各自冲销全部营业额，而不是共同平分退款', () => {
    const targets = planRolePoolRefundAllocations([
      row(),
      row({ employee_id: 'emp-2', role_type: '品项老师', rate: '0', sum_comm: '0' }),
    ], 2700)

    expect(targets.map((target) => [target.source.role_type, target.allocatedCents, target.commissionCents]))
      .toEqual([['品项老师', 270000, 0], ['美容师', 270000, 32400]])
  })

  test('同一角色池内按员工剩余份额使用最大余数法拆分', () => {
    const targets = planRolePoolRefundAllocations([
      row({ employee_id: 'emp-a', sum_total: '70.00', sum_comm: '7.00', positive_receipt_total: '100.00' }),
      row({ employee_id: 'emp-b', sum_total: '30.00', sum_comm: '3.00', positive_receipt_total: '100.00' }),
    ], 33.33)

    expect(Object.fromEntries(targets.map((target) => [target.source.employee_id, target.allocatedCents])))
      .toEqual({ 'emp-a': 2333, 'emp-b': 1000 })
    expect(targets.reduce((sum, target) => sum + target.allocatedCents, 0)).toBe(3333)
  })

  test('连续退款只冲销剩余容量且不会重复扣提成', () => {
    const targets = planRolePoolRefundAllocations([
      row({ sum_total: '100.00', prior_negative_total: '60.00', sum_comm: '12.00', prior_negative_comm: '7.20', positive_receipt_total: '100.00', prior_refund_receipt_total: '60.00' }),
    ], 40)

    expect(targets[0]).toMatchObject({ allocatedCents: 4000, commissionCents: 480, allocationRatio: '1.000' })
  })
})

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
