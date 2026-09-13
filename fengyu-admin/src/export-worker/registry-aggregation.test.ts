import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/actions/orders', () => ({
  exportOrders: vi.fn(),
  exportOrderPayments: vi.fn(),
  exportAllocationOrders: vi.fn(),
}))

import { exportAllocationOrders, exportOrderPayments, exportOrders } from '@/actions/orders'
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
    prepaidCardAmount: '100.00',
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
        nextCursor: {
          sortDatetime: '2026-08-01 10:00:00+08',
          saleOrderId: 'ORDER-1',
          source: 'item',
          sourceId: 'ITEM-1',
        },
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

  it('回款明细透传列表筛选并保留负数金额', async () => {
    vi.mocked(exportOrderPayments).mockResolvedValue({
      rows: [{
        paymentId: 42,
        saleOrderId: 'ORDER-1',
        productName: '肩颈护理10次',
        changeType: '退款',
        paymentStatus: '已支付',
        paymentAmount: '-120.00',
        received: '-120.00',
        refundedAmount: '120.00',
        paymentMethod: '微信',
        performanceAttributionDate: '2026-08-17',
        performanceAttributionStatus: '系统默认',
      }],
      truncated: false,
      hasMore: false,
    } as never)

    const params = { status: '已支付', type: '销售单', dateBasis: 'payment', from: '2026-08-01' }
    const content = await createExportContent('payments', params)
    const rows = await collect(content.rows)
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))

    expect(exportOrderPayments).toHaveBeenCalledWith(params, { limit: 500 })
    expect(content.sheetName).toBe('回款明细')
    expect(rows).toHaveLength(1)
    expect(columns['款项流水号']?.value(rows[0])).toBe('#42')
    expect(columns['商品明细']?.value(rows[0])).toBe('肩颈护理10次')
    expect(columns['款项金额']?.value(rows[0])).toBe(-120)
    expect(columns['实付']?.value(rows[0])).toBe('-120.00')
    expect(columns['已退']?.value(rows[0])).toBe('120.00')
    expect(columns['业绩归属日期']?.value(rows[0])).toBe('2026-08-17')
  })

  // 回款块能粘到订单明细下方合成一张表，全靠这条不变量。orderColumns 加列时本用例先失败。
  it('回款明细前 34 列与订单明细逐字对齐，且金额列单元格类型一致', async () => {
    vi.mocked(exportOrders).mockResolvedValue({ rows: [], truncated: false, hasMore: false } as never)
    vi.mocked(exportOrderPayments).mockResolvedValue({ rows: [], truncated: false, hasMore: false } as never)

    const orderContent = await createExportContent('orders', {})
    const paymentContent = await createExportContent('payments', {})
    const orderHeaders = orderContent.columns.map((column) => column.header)

    expect(paymentContent.columns.slice(0, orderHeaders.length).map((column) => column.header))
      .toEqual(orderHeaders)
    expect(paymentContent.columns.length).toBeGreaterThan(orderHeaders.length)

    // 金额列必须两边同为文本，否则合表后 Excel 求和会漏掉其中一段
    const sample = { totalAmount: '1.00', prepaidCardAmount: '1.00', cashAmount: '1.00', received: '1.00', refundedAmount: '1.00' }
    for (const header of ['订单金额', '储值卡抵扣', '现付', '实付', '已退']) {
      const orderColumn = orderContent.columns.find((column) => column.header === header)!
      const paymentColumn = paymentContent.columns.find((column) => column.header === header)!
      expect(typeof paymentColumn.value(sample)).toBe(typeof orderColumn.value(sample))
      expect(paymentColumn.value(sample)).toBe('1.00')
    }
  })
})
