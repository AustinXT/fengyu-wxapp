import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-error'
import {
  assertInventoryLocationInScope,
  canViewInventoryAmount,
  inventoryPriceScopeByTier,
  inventoryPriceVisibility,
  inventoryPriceVisibilityForOrgNodes,
  inventoryScopedLocationIds,
  inventoryScopedOrgNodeIds,
  inventoryTierRestrictedOrgNodeIds,
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

  it('说明.md §9.3/§9.5：价格档位按角色绑定收敛生效范围（防跨绑定借权）', () => {
    // 失败场景：市场 B 绑库存财务（market_price_view）+ 门店 A 绑门店库存员。
    const mixed = {
      employeeId: 'E-MIX',
      name: '混合绑定员工',
      phone: '13800000001',
      roles: [{
        role: 'inventory_market_finance',
        scopeId: 'MKT-B',
        scopeType: '市场',
        scopeStoreIds: ['STORE-B1'],
        scopeOrgNodeIds: ['MKT-B', 'NODE-B1'],
        actions: ['inventory:list', 'inventory:market_price_view'],
      }, {
        role: 'inventory_store_operator',
        scopeId: 'NODE-A1',
        scopeType: '门店',
        scopeStoreIds: ['STORE-A1'],
        scopeOrgNodeIds: ['NODE-A1'],
        actions: ['inventory:list', 'inventory:store_operate'],
      }],
      permissions: {
        actions: ['inventory:list', 'inventory:market_price_view', 'inventory:store_operate'],
        scopeStoreIds: ['STORE-B1', 'STORE-A1'],
        scopeOrgNodeIds: ['MKT-B', 'NODE-B1', 'NODE-A1'],
      },
    } as never
    const tiers = inventoryPriceScopeByTier(mixed)
    // 市场档只在市场 B 绑定展开的 org 上生效；门店绑定不注入任何价格档位。
    expect(tiers.market).toEqual(new Set(['MKT-B', 'NODE-B1']))
    expect(tiers.supplyChain).toEqual(new Set())
    // 门店 A 的单据（端点 NODE-A1）不得借市场 B 的价格权看金额。
    expect(inventoryPriceVisibilityForOrgNodes(tiers, ['NODE-A1', 'MKT-A'])).toBe('none')
    // 市场 B 自己的单据金额照常可见。
    expect(inventoryPriceVisibilityForOrgNodes(tiers, ['MKT-B', 'HQ'])).toBe('market')
    expect(inventoryPriceVisibilityForOrgNodes(tiers, ['NODE-B1'])).toBe('market')
  })

  it('价格档位行级判定：单绑定与 admin/兼容会话行为与现状一致', () => {
    // 单绑定市场会话：档位集合 = 该绑定 org 集合 = scope 集合，任何可见行都命中。
    const single = inventoryPriceScopeByTier(session({
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场',
      scopeOrgNodeIds: ['M1', 'NODE-S1'],
      actions: ['inventory:list', 'inventory:market_price_view'],
    }))
    expect(inventoryPriceVisibilityForOrgNodes(single, ['M1', 'HQ'])).toBe('market')
    expect(inventoryPriceVisibilityForOrgNodes(single, ['NODE-S1'])).toBe('market')
    // 总部供应链绑定：不展开后代，仅总部端点命中（可见单据必有总部端点）。
    const hq = inventoryPriceScopeByTier(session({
      role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
      scopeOrgNodeIds: ['HQ', 'M1'],
      actions: ['inventory:supply_chain_price_view'],
    }))
    expect(hq.supplyChain).toEqual(new Set(['HQ']))
    expect(inventoryPriceVisibilityForOrgNodes(hq, ['M1', 'HQ'])).toBe('supply_chain')
    // admin 全量：两档均不受 org 限制。
    const admin = inventoryPriceScopeByTier(session({ role: 'admin', scopeId: 'HQ', scopeType: '总部' }))
    expect(admin).toEqual({ supplyChain: null, market: null })
    expect(inventoryPriceVisibilityForOrgNodes(admin, ['ANY'])).toBe('all')
    // 旧会话兼容（无角色级 actions 元数据）：退回会话级动作并集，全局生效。
    const legacy = inventoryPriceScopeByTier({
      employeeId: 'E-L', name: '旧会话', phone: '13800000002',
      roles: [{ role: 'finance', scopeId: 'M1', scopeType: '市场' }],
      permissions: { actions: ['inventory:market_price_view'], scopeStoreIds: [] },
    } as never)
    expect(legacy.market).toBeNull()
    expect(inventoryPriceVisibilityForOrgNodes(legacy, ['ANY'])).toBe('market')
  })

  it('inventoryTierRestrictedOrgNodeIds：scope 与档位集合取交，档位无限制时原样返回', () => {
    expect(inventoryTierRestrictedOrgNodeIds(['A', 'B', 'C'], [new Set(['B', 'D']), new Set(['C'])]))
      .toEqual(['B', 'C'])
    expect(inventoryTierRestrictedOrgNodeIds(['A', 'B'], [null, new Set(['B'])])).toEqual(['A', 'B'])
    expect(inventoryTierRestrictedOrgNodeIds(null, [new Set(['A'])])).toEqual(['A'])
    expect(inventoryTierRestrictedOrgNodeIds(null, [null])).toBeNull()
    expect(inventoryTierRestrictedOrgNodeIds(['A'], [new Set<string>()])).toEqual([])
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
