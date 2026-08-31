import { describe, expect, it } from 'vitest'
import { inventoryPriceVisibility, inventoryScopedLocationIds } from './access'

function session(input: {
  role: string
  scopeId: string
  scopeType: '总部' | '市场' | '门店'
  scopeStoreIds?: string[]
  actions?: string[]
}) {
  const actions = input.actions ?? []
  return {
    employeeId: 'E-TEST',
    name: '测试员工',
    phone: '13800000000',
    roles: [{
      role: input.role,
      scopeId: input.scopeId,
      scopeType: input.scopeType,
      scopeStoreIds: input.scopeStoreIds ?? [],
      scopeOrgNodeIds: [input.scopeId],
      actions,
    }],
    permissions: { actions, scopeStoreIds: input.scopeStoreIds ?? [] },
  } as never
}

describe('进销存独立 scope 与价格层级', () => {
  it('总部不展开后代，市场展开所属门店，门店只保留自身', () => {
    expect(inventoryScopedLocationIds(session({
      role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部', scopeStoreIds: ['S1'],
    }))).toEqual(['HQ'])
    expect(inventoryScopedLocationIds(session({
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场', scopeStoreIds: ['S1', 'S2'],
    }))).toEqual(['M1', 'S1', 'S2'])
    expect(inventoryScopedLocationIds(session({
      role: 'inventory_store_operator', scopeId: 'S1', scopeType: '门店', scopeStoreIds: ['S1'],
    }))).toEqual(['S1'])
  })

  it('供应链和市场价格权限按持有权限合并，门店无价格', () => {
    expect(inventoryPriceVisibility(session({
      role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
      actions: ['inventory:supply_chain_price_view'],
    }))).toBe('supply_chain')
    expect(inventoryPriceVisibility(session({
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场',
      actions: ['inventory:market_price_view'],
    }))).toBe('market')
    const dual = session({
      role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
      actions: ['inventory:supply_chain_price_view'],
    }) as { permissions: { actions: string[] } }
    // 模拟同一员工另有一条市场角色绑定后的会话动作并集。
    dual.permissions.actions.push('inventory:market_price_view')
    expect(inventoryPriceVisibility(dual as never)).toBe('all')
    expect(inventoryPriceVisibility(session({
      role: 'inventory_store_operator', scopeId: 'S1', scopeType: '门店',
      actions: ['inventory:store_operate'],
    }))).toBe('none')
  })
})
