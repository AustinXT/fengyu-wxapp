// mock/allocation.ts — 营业额分配相关 mock

export const allocationHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'allocation.save': (payload) => ({
    success: true,
    allocationId: 'alloc-new-001',
    orderNo: payload.orderNo,
  }),

  'allocation.delete': (payload) => ({
    success: true,
    allocationId: payload.allocationId,
  }),
}
