import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/actions/orders', () => ({
  exportOrders: vi.fn(),
  exportAllocationOrders: vi.fn(),
}))

import { exportAllocationOrders, exportOrders } from '@/actions/orders'
import { createExportContent } from './registry'

async function collect(rows: AsyncIterable<Record<string, unknown>>) {
  const result: Record<string, unknown>[] = []
  for await (const row of rows) result.push(row)
  return result
}

function sourceOrderRow(sourceId: string) {
  return {
    saleOrderId: 'ORDER-1',
    productType: '疗程卡',
    productName: '单次护理',
    sessionCount: 1,
    paidUnusedSessions: 1,
    unit: '次',
    unitRealPrice: 100,
    totalAmount: '100.00',
    prepaidCardAmount: '200.00',
    cashAmount: '0.00',
    received: '100.00',
    refundedAmount: '0.00',
    __sourceId: sourceId,
    __sourceKind: 'item',
    __skuId: 'SKU-1',
    __itemDirection: '购买',
    __quantity: 1,
    __remainingSessions: 1,
    __paidSessions: 1,
  }
}

describe('异步导出 worker 聚合接线', () => {
  beforeEach(() => vi.clearAllMocks())

  it('订单在两个 worker 页面中仍聚合为同一行', async () => {
    vi.mocked(exportOrders)
      .mockResolvedValueOnce({
        rows: [sourceOrderRow('ITEM-1')],
        truncated: false,
        hasMore: true,
        nextCursor: { itemOffset: 1, rechargeOffset: 0 },
      } as never)
      .mockResolvedValueOnce({
        rows: [sourceOrderRow('ITEM-2')],
        truncated: false,
        hasMore: false,
      } as never)

    const content = await createExportContent('orders', {})
    const rows = await collect(content.rows)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionCount: 2, totalAmount: '200.00', prepaidCardAmount: '200.00' })
  })

  it('营业额分配在两个 worker 页面中按完整回款聚合', async () => {
    const allocation = (receiptId: number) => ({
      saleOrderId: 'ORDER-1',
      productType: '疗程卡',
      productName: '单次护理',
      sessionCount: 1,
      paidUnusedSessions: 1,
      unit: '次',
      unitRealPrice: 100,
      saleAmount: 100,
      employeeName: '美容师甲',
      positionName: '美容师',
      allocationRatio: '1.000',
      allocationAmount: 100,
      commissionRate: '0.100',
      commissionAmount: 10,
      __sourceId: `ALLOC-${receiptId}`,
      __salePaymentId: 9,
      __receiptId: receiptId,
      __receiptAmount: '100.00',
      __paymentAmount: '200.00',
      __paymentMethod: '线下',
      __paymentChangeType: '首次支付',
      __skuId: 'SKU-1',
      __itemDirection: '购买',
      __quantity: 1,
      __remainingSessions: 1,
      __paidSessions: 1,
      __employeeId: 'EMP-A',
      __roleType: '美容师',
    })
    vi.mocked(exportAllocationOrders)
      .mockResolvedValueOnce({
        rows: [allocation(1)],
        truncated: false,
        hasMore: true,
        nextCursor: { allocatedOffset: 1, pendingOffset: 0 },
      } as never)
      .mockResolvedValueOnce({
        rows: [allocation(2)],
        truncated: false,
        hasMore: false,
      } as never)

    const content = await createExportContent('allocation-sales', {})
    const rows = await collect(content.rows)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionCount: 2,
      received: '200.00',
      allocationAmount: '200.00',
      commissionAmount: '20.00',
    })
  })
})
