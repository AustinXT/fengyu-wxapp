// mock/allocation.ts — 营业额分配相关 mock（按回款逐笔分配）

export const allocationHandlers: Record<string, (payload: Record<string, any>) => any> = {
  // 待分配/已分配回款列表
  'allocation.pendingPayments': () => ({
    payments: [],
    page: 1,
    pageSize: 20,
  }),

  // 某笔回款的分配建议
  'allocation.suggestPayment': (payload) => ({
    salePaymentId: payload.salePaymentId,
    saleOrderId: 'FY-XSD-WX-MOCK0001',
    eventAmount: 0,
    items: [],
    allocLines: [],
    candidateEmployees: [],
    existingAllocations: [],
    rates: [],
    ratesByRole: {},
    totalAmount: 0,
    frozen: false,
  }),

  // 保存某笔回款的分配
  'allocation.savePayment': (payload) => ({
    salePaymentId: payload.salePaymentId,
    message: '提成分配已保存',
    allocationCount: Array.isArray(payload.allocations) ? payload.allocations.length : 0,
  }),

  // 删除某笔回款的分配
  'allocation.deletePaymentAllocation': (payload) => ({
    salePaymentId: payload.salePaymentId,
    message: '营业额分配已清除',
  }),
}
