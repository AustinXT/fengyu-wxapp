import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'
vi.mock('@/db', () => ({ db: {} }))
import { canCreateSupplier, canManageSupplier, supplierCreationOwner, supplierWritableMarkets } from './supplier-access'
import { supplierDisplayName } from './supplier-label'

const MARKET = 'inventory:market_sku_manage'
const SUPPLY = 'inventory:supply_chain_master_data_manage'
function session(bindings: Array<[string, string, string[]]>): AuthSession {
  return {
    employeeId: 'E', name: '测试', phone: '',
    roles: bindings.map(([scopeType, scopeId, actions]) => ({
      role: 'finance', scopeType, scopeId, actions, scopeStoreIds: [], scopeOrgNodeIds: [scopeId],
    })),
    permissions: { actions: [...new Set(bindings.flatMap(([, , actions]) => actions))], scopeStoreIds: [] },
  } as AuthSession
}
describe('#365 供应商维护绑定', () => {
  it('供应链创建共有；市场建档由本市场绑定强制决定', () => {
    expect(supplierCreationOwner(session([['总部', 'HQ', [SUPPLY]]]))).toBeNull()
    expect(supplierCreationOwner(session([['市场', 'M1', [MARKET]]]))).toBe('M1')
  })
  it('市场不能维护共有或别的市场，供应链不能维护市场档案', () => {
    const market = session([['市场', 'M1', [MARKET]]])
    expect(canManageSupplier(market, null)).toBe(false)
    expect(canManageSupplier(market, 'M2')).toBe(false)
    expect(canManageSupplier(market, 'M1')).toBe(true)
    const supply = session([['总部', 'HQ', [SUPPLY]]])
    expect(canManageSupplier(supply, null)).toBe(true)
    expect(canManageSupplier(supply, 'M1')).toBe(false)
  })
  it('其它角色的市场范围不能被借来代建', () => {
    const mixed = session([['总部', 'HQ', [MARKET]], ['市场', 'M2', ['inventory:stock_list']]])
    expect(supplierWritableMarkets(mixed)).toEqual([])
    expect(() => supplierCreationOwner(mixed)).toThrow('唯一的本市场')
  })
  it('多个市场写绑定无法唯一确定本市场，拒绝由前端任选', () => {
    expect(() => supplierCreationOwner(session([['市场', 'M1', [MARKET]], ['市场', 'M2', [MARKET]]])))
      .toThrow('唯一的本市场')
  })
  it('市场误授供应链动作不能创建或维护共有，不能借总部读绑定', () => {
    const marketSupply = session([['市场', 'M1', [SUPPLY]]])
    expect(canManageSupplier(marketSupply, null)).toBe(false)
    expect(() => supplierCreationOwner(marketSupply)).toThrow('唯一的本市场')
    expect(canCreateSupplier(marketSupply)).toBe(false)
    const borrowedHq = session([['市场', 'M1', [SUPPLY]], ['总部', 'HQ', ['inventory:stock_list']]])
    expect(canManageSupplier(borrowedHq, null)).toBe(false)
    expect(canCreateSupplier(borrowedHq)).toBe(false)
    const own = session([['市场', 'M1', [SUPPLY, MARKET]]])
    expect(supplierCreationOwner(own)).toBe('M1')
    expect(canManageSupplier(own, null)).toBe(false)
    expect(canManageSupplier(own, 'M1')).toBe(true)
  })
  it('页面快捷入口与归属判据一致，拒多市场而放行单市场/总部', () => {
    expect(canCreateSupplier(session([['市场', 'M1', [MARKET]], ['市场', 'M2', [MARKET]]]))).toBe(false)
    expect(canCreateSupplier(session([['市场', 'M1', [MARKET]]]))).toBe(true)
    expect(canCreateSupplier(session([['总部', 'HQ', [SUPPLY]]]))).toBe(true)
  })
  it('同名选项按归属展示，共有标识明确', () => {
    expect(supplierDisplayName('恒美', null)).toBe('恒美（供应链共有）')
    expect(supplierDisplayName('恒美', '广州市场')).toBe('恒美（广州市场）')
  })
})
