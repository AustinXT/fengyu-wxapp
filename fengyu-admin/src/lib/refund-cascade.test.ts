import { describe, expect, it } from 'vitest'
import {
  planRolePoolRefundAllocations,
  type RefundAllocationSourceRow,
} from './refund-cascade'

const row = (overrides: Partial<RefundAllocationSourceRow> = {}): RefundAllocationSourceRow => ({
  employee_id: 'emp-1',
  role_type: '美容师',
  dept: '美容部',
  sum_total: '2700.00',
  prior_negative_total: '0',
  rate: '0.1200',
  sum_comm: '324.00',
  prior_negative_comm: '0',
  positive_receipt_total: '2700.00',
  prior_refund_receipt_total: '0',
  ...overrides,
})

describe('planRolePoolRefundAllocations', () => {
  it('两个 100% 角色池全退时各自冲销全部营业额', () => {
    const targets = planRolePoolRefundAllocations([
      row(),
      row({ employee_id: 'emp-2', role_type: '品项老师', rate: '0', sum_comm: '0' }),
    ], 2700)

    expect(targets.map((target) => [target.source.role_type, target.allocatedCents, target.commissionCents]))
      .toEqual([['品项老师', 270000, 0], ['美容师', 270000, 32400]])
  })

  it('同一角色池内用最大余数法精确拆分到分', () => {
    const targets = planRolePoolRefundAllocations([
      row({ employee_id: 'emp-a', sum_total: '70.00', sum_comm: '7.00', positive_receipt_total: '100.00' }),
      row({ employee_id: 'emp-b', sum_total: '30.00', sum_comm: '3.00', positive_receipt_total: '100.00' }),
    ], 33.33)

    expect(Object.fromEntries(targets.map((target) => [target.source.employee_id, target.allocatedCents])))
      .toEqual({ 'emp-a': 2333, 'emp-b': 1000 })
    expect(targets.reduce((sum, target) => sum + target.allocatedCents, 0)).toBe(3333)
  })

  it('部分覆盖角色池只按覆盖率冲销', () => {
    const targets = planRolePoolRefundAllocations([
      row({ sum_total: '50.00', sum_comm: '6.00', positive_receipt_total: '100.00' }),
    ], 40)

    expect(targets[0]).toMatchObject({ allocatedCents: 2000, commissionCents: 240, allocationRatio: '0.500' })
  })

  it('连续退款只冲销剩余容量和剩余提成', () => {
    const targets = planRolePoolRefundAllocations([
      row({
        sum_total: '100.00',
        prior_negative_total: '60.00',
        sum_comm: '12.00',
        prior_negative_comm: '7.20',
        positive_receipt_total: '100.00',
        prior_refund_receipt_total: '60.00',
      }),
    ], 40)

    expect(targets[0]).toMatchObject({ allocatedCents: 4000, commissionCents: 480, allocationRatio: '1.000' })
  })

  it('有待冲销分配但商品行没有剩余实收时拒绝继续', () => {
    expect(() => planRolePoolRefundAllocations([
      row({ positive_receipt_total: '100.00', prior_refund_receipt_total: '100.00' }),
    ], 10)).toThrow('INVALID_STATE: 退款营业额分配缺少可冲销的商品行实收')
  })
})
