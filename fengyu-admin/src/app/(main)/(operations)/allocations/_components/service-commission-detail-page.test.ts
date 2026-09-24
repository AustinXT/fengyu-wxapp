import { describe, expect, it } from 'vitest'
import { initCommissions } from './service-commission-detail-page'

describe('服务单提成按服务项目拆分', () => {
  it('同名项目按 serviceItemId 分开，并保留各自实际服务人员', () => {
    const serviceItems = [
      { serviceItemId: 'SERVICE-ITEM-1', productName: '水光护理', unitRealPrice: 100, sessionUsed: 1, salesCategory: '自销自耗' },
      { serviceItemId: 'SERVICE-ITEM-2', productName: '水光护理', unitRealPrice: 100, sessionUsed: 1, salesCategory: '自销自耗' },
    ]
    const commissions = [
      { serviceItemId: 'SERVICE-ITEM-1', employeeId: 'EMP-A', roleType: '美容师', allocationRatio: '1.000', commissionRate: '0.100' },
      { serviceItemId: 'SERVICE-ITEM-2', employeeId: 'EMP-B', roleType: '美容师', allocationRatio: '1.000', commissionRate: '0.100' },
    ]
    const employees = [
      { employeeId: 'EMP-A', skills: ['美容师'] },
      { employeeId: 'EMP-B', skills: ['美容师'] },
    ]

    const result = initCommissions(
      serviceItems as never[],
      commissions as never[],
      employees as never[],
      [],
      '测试市场',
      'store-test',
    )

    expect(Object.keys(result)).toEqual(['SERVICE-ITEM-1', 'SERVICE-ITEM-2'])
    expect(result['SERVICE-ITEM-1']).toHaveLength(1)
    expect(result['SERVICE-ITEM-1'][0].employeeId).toBe('EMP-A')
    expect(result['SERVICE-ITEM-2']).toHaveLength(1)
    expect(result['SERVICE-ITEM-2'][0].employeeId).toBe('EMP-B')
  })
})
