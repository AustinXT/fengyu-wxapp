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

it.each(['店经理', '品项老师'])('%s 默认预填与空角色回显使用对应矩阵', (role) => {
  const item = { serviceItemId: 'I1', unitRealPrice: '100', sessionUsed: 1, salesCategory: '自销自耗' }
  const employee = { employeeId: 'E1', skills: [role] }
  const rates = [{ orgName: '市场', orderType: '服务单', roleType: role, salesCategory: '自销自耗',
    amountTierMin: '0', amountTierMax: null, commissionRate: '0.2' }]
  for (const commissions of [[], [{ serviceItemId: 'I1', employeeId: 'E1', roleType: '', allocationRatio: '1', commissionRate: '0' }]]) {
    const entries = initCommissions([item] as never[], commissions as never[], [employee] as never[], rates as never[], '市场', 'E1')
    expect(entries.I1[0]).toMatchObject({ skillTag: role, employeeId: 'E1', commissionRate: 0.2, commissionAmount: '20.00' })
  }
  const existing = initCommissions([item] as never[], [{ serviceItemId: 'I1', employeeId: 'E1', roleType: '美容师', allocationRatio: '1', commissionRate: '0.1' }] as never[], [employee] as never[], [], '市场')
  expect(existing.I1[0].skillTag).toBe('美容师')
})
