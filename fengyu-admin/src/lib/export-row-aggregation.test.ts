import { describe, expect, it } from 'vitest'
import {
  aggregateAllocationExportRows,
  aggregateContiguousExportRows,
  aggregateOrderExportRows,
  splitCentsWithLastRemainder,
} from './export-row-aggregation'

type Row = Record<string, unknown>

function orderRow(overrides: Row = {}): Row {
  return {
    saleOrderId: 'ORDER-1',
    saleOrderType: '销售单',
    productType: '疗程卡',
    categoryL1: '护理',
    categoryL2: '面部',
    productName: '单次护理',
    sessionCount: 1,
    paidUnusedSessions: 1,
    unit: '次',
    unitRealPrice: 100,
    salesCategory: '自销自耗',
    totalAmount: '100.00',
    prepaidCardAmount: '100.00',
    cashAmount: '0.00',
    received: '100.00',
    refundedAmount: '0.00',
    __sourceId: 'ITEM-1',
    __sourceKind: 'item',
    __skuId: 'SKU-SINGLE',
    __itemDirection: '购买',
    __quantity: 1,
    __remainingSessions: 1,
    __paidSessions: 1,
    ...overrides,
  }
}

function allocationRow(index: number, employee: 'A' | 'B', overrides: Row = {}): Row {
  return {
    saleOrderId: 'ORDER-1',
    productType: '疗程卡',
    categoryL1: '护理',
    categoryL2: '面部',
    productName: '单次护理',
    sessionCount: 1,
    paidUnusedSessions: 1,
    unit: '次',
    unitRealPrice: 100,
    salesCategory: '自销自耗',
    saleAmount: 100,
    prepaidCardAmount: 840,
    received: 2100,
    refundedAmount: 0,
    allocationStatus: '已分配',
    employeeName: employee === 'A' ? '美容师甲' : '美容师乙',
    positionName: '美容师',
    allocationRatio: '0.500',
    allocationAmount: 50,
    commissionRate: '0.100',
    commissionAmount: 5,
    __sourceId: `ALLOC-${index}-${employee}`,
    __salePaymentId: 88,
    __receiptId: index,
    __saleItemId: `ITEM-${index}`,
    __receiptAmount: '100.00',
    __paymentAmount: '1260.00',
    __paymentMethod: '线下',
    __paymentChangeType: '首次支付',
    __skuId: 'SKU-SINGLE',
    __itemDirection: '购买',
    __quantity: 1,
    __remainingSessions: 1,
    __paidSessions: 1,
    __employeeId: employee,
    __roleType: '美容师',
    ...overrides,
  }
}

describe('splitCentsWithLastRemainder', () => {
  it('累计比例分摊不能整除的尾差且总额严格守恒', () => {
    const parts = splitCentsWithLastRemainder(10_000, Array.from({ length: 21 }, () => 1))
    expect(parts.every((value) => value === 476 || value === 477)).toBe(true)
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(10_000)
  })

  it('2 分拆给 4 个等权行不会产生负尾差', () => {
    const parts = splitCentsWithLastRemainder(2, [1, 1, 1, 1])
    expect(parts).toEqual([1, 0, 1, 0])
    expect(parts.every((value) => value >= 0)).toBe(true)
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(2)
  })

  it('负总额分摊的每个分片保持同号并严格守恒', () => {
    const parts = splitCentsWithLastRemainder(-2, [1, 1, 1, 1])
    expect(parts).toEqual([-1, 0, -1, 0])
    expect(parts.every((value) => value <= 0)).toBe(true)
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(-2)
  })
})

describe('aggregateOrderExportRows', () => {
  it('21 行完全相同且无尾差时合并为一行', () => {
    const rows = Array.from({ length: 21 }, (_, index) => orderRow({ __sourceId: `ITEM-${index + 1}` }))
    const result = aggregateOrderExportRows(rows)

    expect(result).toHaveLength(1)
    expect(result[0].sessionCount).toBe(21)
    expect(result[0].paidUnusedSessions).toBe(21)
    expect(result[0].totalAmount).toBe('2100.00')
    expect(result[0].prepaidCardAmount).toBe('2100.00')
    expect(result[0].received).toBe('2100.00')
  })

  it('直接聚合已持久化的行级储值卡/现金实付，不再二次分摊', () => {
    const rows = Array.from({ length: 21 }, (_, index) => orderRow({
      __sourceId: `ITEM-${index + 1}`,
      prepaidCardAmount: index === 20 ? '4.80' : '4.76',
      cashAmount: index === 20 ? '95.20' : '95.24',
    }))
    const result = aggregateOrderExportRows(rows)

    expect(result).toHaveLength(2)
    expect(result.map((row) => row.sessionCount)).toEqual([20, 1])
    expect(result.map((row) => row.prepaidCardAmount)).toEqual(['95.20', '4.80'])
    expect(result.reduce((sum, row) => sum + Number(row.prepaidCardAmount), 0)).toBe(100)
    expect(result.reduce((sum, row) => sum + Number(row.cashAmount), 0)).toBe(2000)
  })

  it('两张相同 30 次卡合并为 60 次，不同 SKU 和使用状态保持分开', () => {
    const sameCards = [
      orderRow({ __sourceId: 'CARD-1', __skuId: 'SKU-30', sessionCount: 30, paidUnusedSessions: 30, __remainingSessions: 30, __paidSessions: 30, totalAmount: '3000.00', received: '3000.00', prepaidCardAmount: '6000.00' }),
      orderRow({ __sourceId: 'CARD-2', __skuId: 'SKU-30', sessionCount: 30, paidUnusedSessions: 30, __remainingSessions: 30, __paidSessions: 30, totalAmount: '3000.00', received: '3000.00', prepaidCardAmount: '6000.00' }),
    ]
    expect(aggregateOrderExportRows(sameCards)).toMatchObject([{ sessionCount: 60, paidUnusedSessions: 60 }])

    const separated = aggregateOrderExportRows([
      sameCards[0],
      orderRow({ ...sameCards[1], __sourceId: 'CARD-OTHER-SKU', __skuId: 'SKU-OTHER' }),
      orderRow({ ...sameCards[1], __sourceId: 'CARD-USED', __remainingSessions: 29, paidUnusedSessions: 29 }),
    ])
    expect(separated).toHaveLength(3)
  })

  it('无 SKU 的历史行即使名称相同也不误合并，家居产品使用 quantity 作为总数量', () => {
    const result = aggregateOrderExportRows([
      orderRow({ __sourceId: 'LEGACY-1', __skuId: null, productType: '家居产品', sessionCount: null, paidUnusedSessions: null, __quantity: 2 }),
      orderRow({ __sourceId: 'LEGACY-2', __skuId: null, productType: '家居产品', sessionCount: null, paidUnusedSessions: null, __quantity: 3 }),
    ])
    expect(result).toHaveLength(2)
    expect(result.map((row) => row.sessionCount)).toEqual([2, 3])
  })

  it('退款优先采用 receipt 的逐项事实，不把全退项退款错分给仍有净实收的项目', () => {
    const result = aggregateOrderExportRows([
      orderRow({ __sourceId: 'REFUNDED', received: '0.00', refundedAmount: '100.00', __itemRefundedAmount: '100.00' }),
      orderRow({ __sourceId: 'ACTIVE', __skuId: 'SKU-OTHER', received: '100.00', refundedAmount: '100.00', __itemRefundedAmount: '0.00' }),
    ])
    expect(result.map((row) => row.refundedAmount)).toEqual(['100.00', '0.00'])
  })

  it('退款 receipt 总额与净退款不一致时仍按退款商品缩放，不污染未退款商品', () => {
    const result = aggregateOrderExportRows([
      orderRow({
        __sourceId: 'REFUNDED',
        totalAmount: '100.00',
        received: '0.00',
        refundedAmount: '90.00',
        __itemRefundedAmount: '100.00',
      }),
      orderRow({
        __sourceId: 'ACTIVE',
        __skuId: 'SKU-OTHER',
        totalAmount: '100.00',
        received: '100.00',
        refundedAmount: '90.00',
        __itemRefundedAmount: null,
      }),
    ])

    expect(result.map((row) => row.refundedAmount)).toEqual(['90.00', '0.00'])
  })

  it('多个退款商品按毛退款明细权重缩放净退款且分值守恒', () => {
    const result = aggregateOrderExportRows([
      orderRow({
        __sourceId: 'REFUND-A',
        refundedAmount: '90.01',
        __itemRefundedAmount: '60.00',
      }),
      orderRow({
        __sourceId: 'REFUND-B',
        __skuId: 'SKU-B',
        refundedAmount: '90.01',
        __itemRefundedAmount: '40.00',
      }),
      orderRow({
        __sourceId: 'ACTIVE',
        __skuId: 'SKU-ACTIVE',
        refundedAmount: '90.01',
        __itemRefundedAmount: '0.00',
      }),
    ])

    expect(result.map((row) => row.refundedAmount)).toEqual(['54.01', '36.00', '0.00'])
    expect(result.reduce((sum, row) => sum + Number(row.refundedAmount), 0)).toBeCloseTo(90.01, 2)
  })

  it('历史数据完全没有退款 receipt 时才按退款前行应付兜底', () => {
    const result = aggregateOrderExportRows([
      orderRow({ __sourceId: 'LEGACY-A', totalAmount: '100.00', refundedAmount: '90.00', __itemRefundedAmount: null }),
      orderRow({ __sourceId: 'LEGACY-B', __skuId: 'SKU-B', totalAmount: '200.00', refundedAmount: '90.00', __itemRefundedAmount: null }),
    ])

    expect(result.map((row) => row.refundedAmount)).toEqual(['30.00', '60.00'])
  })
})

describe('aggregateAllocationExportRows', () => {
  it('21 张相同卡分给两位员工时聚合为两行并累计数量和金额', () => {
    const rows = Array.from({ length: 21 }, (_, index) => [
      allocationRow(index + 1, 'A'),
      allocationRow(index + 1, 'B'),
    ]).flat()
    const result = aggregateAllocationExportRows(rows)

    expect(result).toHaveLength(2)
    expect(result.map((row) => row.employeeName)).toEqual(['美容师甲', '美容师乙'])
    expect(result.map((row) => row.sessionCount)).toEqual([21, 21])
    expect(result.map((row) => row.received)).toEqual(['2100.00', '2100.00'])
    expect(result.map((row) => row.prepaidCardAmount)).toEqual(['840.00', '840.00'])
    expect(result.map((row) => row.allocationAmount)).toEqual(['1050.00', '1050.00'])
    expect(result.map((row) => row.commissionAmount)).toEqual(['105.00', '105.00'])
  })

  it('不同员工分配签名和不同 SKU 不合并', () => {
    const result = aggregateAllocationExportRows([
      allocationRow(1, 'A'), allocationRow(1, 'B'),
      allocationRow(2, 'A', { allocationRatio: '0.600', allocationAmount: 60 }),
      allocationRow(2, 'B', { allocationRatio: '0.400', allocationAmount: 40 }),
      allocationRow(3, 'A', { __skuId: 'SKU-OTHER' }),
      allocationRow(3, 'B', { __skuId: 'SKU-OTHER' }),
    ])
    expect(result).toHaveLength(6)
  })

  it('数值相等但小数位格式不同的比例仍视为同一分配维度', () => {
    const result = aggregateAllocationExportRows([
      allocationRow(1, 'A', { allocationRatio: '0.5', commissionRate: '0.1' }),
      allocationRow(2, 'A', { allocationRatio: '0.5000', commissionRate: '0.100000' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].sessionCount).toBe(2)
  })

  it('待分配 receipt 按 SKU 合并为一个占位行，退款金额保持逐项累计', () => {
    const pending = [1, 2].map((index) => allocationRow(index, 'A', {
      employeeName: null,
      positionName: null,
      allocationRatio: null,
      allocationAmount: null,
      commissionRate: null,
      commissionAmount: null,
      __employeeId: null,
      __roleType: null,
      __paymentChangeType: '退款',
      __paymentAmount: '-200.00',
      __receiptAmount: '-100.00',
    }))
    const result = aggregateAllocationExportRows(pending)

    expect(result).toHaveLength(1)
    expect(result[0].sessionCount).toBe(2)
    expect(result[0].received).toBe('-200.00')
    expect(result[0].refundedAmount).toBe('200.00')
    expect(result[0].employeeName).toBeNull()
  })

  it('转换事件按 receipt 有符号净额分摊现金与储值卡通道', () => {
    const result = aggregateAllocationExportRows([
      allocationRow(1, 'A', {
        __skuId: 'SKU-CONVERT-OUT',
        __itemDirection: '转出',
        __receiptAmount: '-80.00',
        __paymentAmount: '15.00',
        __paymentChangeType: '回款',
      }),
      allocationRow(2, 'A', {
        __skuId: 'SKU-CONVERT-IN',
        __itemDirection: '转入',
        __receiptAmount: '100.00',
        __paymentAmount: '15.00',
        __paymentChangeType: '回款',
      }),
    ])

    expect(result).toHaveLength(2)
    expect(result.map((row) => row.received)).toEqual(['-80.00', '100.00'])
    expect(result.map((row) => row.prepaidCardAmount)).toEqual(['-20.00', '25.00'])
    expect(result.reduce((sum, row) => sum + Number(row.prepaidCardAmount), 0)).toBe(5)
  })
})

describe('aggregateContiguousExportRows', () => {
  it('同一订单跨异步分页边界仍只输出一个聚合组', async () => {
    async function* source() {
      yield orderRow({ __sourceId: 'ITEM-1', prepaidCardAmount: '200.00' })
      yield orderRow({ __sourceId: 'ITEM-2', prepaidCardAmount: '200.00' })
      yield orderRow({ saleOrderId: 'ORDER-2', __sourceId: 'ITEM-3', prepaidCardAmount: '100.00' })
    }
    const result: Row[] = []
    for await (const row of aggregateContiguousExportRows(
      source(),
      (row) => String(row.saleOrderId),
      aggregateOrderExportRows,
    )) result.push(row)

    expect(result).toHaveLength(2)
    expect(result[0].sessionCount).toBe(2)
    expect(result[1].saleOrderId).toBe('ORDER-2')
  })
})
