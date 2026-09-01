import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-error'
import {
  assertInventoryLocationInScope,
  canViewInventoryAmount,
  inventoryPriceVisibility,
  inventoryScopedLocationIds,
  inventoryScopedOrgNodeIds,
} from './access'

function session(input: {
  role: string
  scopeId: string
  scopeType: '总部' | '市场' | '门店'
  scopeStoreIds?: string[]
  scopeOrgNodeIds?: string[]
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
      scopeOrgNodeIds: input.scopeOrgNodeIds ?? [input.scopeId],
      actions,
    }],
    permissions: {
      actions,
      scopeStoreIds: input.scopeStoreIds ?? [],
      scopeOrgNodeIds: input.scopeOrgNodeIds ?? [input.scopeId],
    },
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

  it('单据 scope 的总部不展开后代，市场展开所属门店，门店只保留自身', () => {
    expect(inventoryScopedOrgNodeIds(session({
      role: 'inventory_supply_chain_operator',
      scopeId: 'HQ',
      scopeType: '总部',
      scopeStoreIds: ['STORE-1'],
      scopeOrgNodeIds: ['HQ', 'MARKET-1', 'NODE-STORE-1'],
    }))).toEqual(['HQ'])
    expect(inventoryScopedOrgNodeIds(session({
      role: 'inventory_market_finance',
      scopeId: 'MARKET-1',
      scopeType: '市场',
      scopeStoreIds: ['STORE-1'],
      scopeOrgNodeIds: ['MARKET-1', 'NODE-STORE-1'],
    }))).toEqual(['MARKET-1', 'NODE-STORE-1'])
    expect(inventoryScopedOrgNodeIds(session({
      role: 'inventory_store_operator',
      scopeId: 'NODE-STORE-1',
      scopeType: '门店',
      scopeStoreIds: ['STORE-1'],
    }))).toEqual(['NODE-STORE-1'])
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

  it('管理员 scope 价格恒为 all，canViewInventoryAmount 与可见性联动', () => {
    // isAdminScope 判定 isSuperAdmin ?? role === 'admin'，不依赖价格动作。
    expect(inventoryPriceVisibility(session({
      role: 'admin', scopeId: 'HQ', scopeType: '总部',
    }))).toBe('all')
    expect(canViewInventoryAmount(session({
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场',
      actions: ['inventory:market_price_view'],
    }))).toBe(true)
    expect(canViewInventoryAmount(session({
      role: 'inventory_store_operator', scopeId: 'S1', scopeType: '门店',
      actions: ['inventory:store_operate'],
    }))).toBe(false)
  })

  it('说明.md §9.2：总部会话对下辖市场/门店主体一律 PERMISSION_DENIED（scope 不下钻）', () => {
    // 总部绑定即使带完整组织树元数据（含市场/门店后代），库存 scope 也只保留总部自身；
    // 对任何市场或门店主体的操作必须被拒，防止父级关系自动放权。
    const hqSession = session({
      role: 'inventory_supply_chain_operator',
      scopeId: 'HQ',
      scopeType: '总部',
      scopeStoreIds: ['STORE-1'],
      scopeOrgNodeIds: ['HQ', 'MARKET-1', 'NODE-STORE-1'],
    })
    expect(() => assertInventoryLocationInScope(hqSession, 'MARKET-1'))
      .toThrow(new ApiError('PERMISSION_DENIED', '无权操作该库存主体'))
    expect(() => assertInventoryLocationInScope(hqSession, 'STORE-1'))
      .toThrow(new ApiError('PERMISSION_DENIED', '无权操作该库存主体'))
    expect(() => assertInventoryLocationInScope(hqSession, 'HQ')).not.toThrow()
    // 单据 scope 同口径：总部不含任何后代节点。
    expect(inventoryScopedOrgNodeIds(hqSession)).not.toContain('MARKET-1')
    expect(inventoryScopedOrgNodeIds(hqSession)).not.toContain('NODE-STORE-1')
  })

  it('库存主体越权抛出结构化 ApiError 而非裸 Error', () => {
    const storeSession = session({
      role: 'inventory_store_operator', scopeId: 'S1', scopeType: '门店', scopeStoreIds: ['S1'],
    })
    expect(() => assertInventoryLocationInScope(storeSession, 'S2'))
      .toThrow(new ApiError('PERMISSION_DENIED', '无权操作该库存主体'))
    expect(() => assertInventoryLocationInScope(storeSession, 'S2')).toThrow(ApiError)
    expect(() => assertInventoryLocationInScope(storeSession, 'S1')).not.toThrow()
    // 管理员与市场（含门店）scope 内的主体均放行。
    expect(() => assertInventoryLocationInScope(session({
      role: 'admin', scopeId: 'HQ', scopeType: '总部',
    }), 'ANY')).not.toThrow()
    expect(() => assertInventoryLocationInScope(session({
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场', scopeStoreIds: ['S1'],
    }), 'S1')).not.toThrow()
  })
})
