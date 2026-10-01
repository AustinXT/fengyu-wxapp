import { ApiError } from '@/lib/api-error'
import { scopeSessionToActions } from '@/lib/action-scope'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'

export const SUPPLIER_MANAGE_ACTIONS = [
  'inventory:supply_chain_master_data_manage',
  'inventory:market_sku_manage',
]

/** 归属由实际授予建档动作的市场绑定确定；不能拼接其它角色的范围。 */
export function supplierCreationOwner(session: AuthSession): string | null {
  const scoped = scopeSessionToActions(session, SUPPLIER_MANAGE_ACTIONS)
  if (hasPermission(scoped, SUPPLIER_MANAGE_ACTIONS[0])) return null
  const markets = supplierWritableMarkets(scoped)
  if (markets.length !== 1) {
    throw new ApiError('PERMISSION_DENIED', '供应商建档必须具有唯一的本市场产品资料维护授权')
  }
  return markets[0]
}

export function supplierWritableMarkets(session: AuthSession): string[] {
  if (!hasPermission(session, 'inventory:market_sku_manage')) return []
  return [...new Set(session.roles.filter((role) => role.scopeType === '市场'
    && role.actions?.includes('inventory:market_sku_manage')).map((role) => role.scopeId))]
}

export function canManageSupplier(session: AuthSession, ownerMarketId: string | null): boolean {
  if (ownerMarketId === null) return hasPermission(session, SUPPLIER_MANAGE_ACTIONS[0])
  return (isAdminScope(session) && hasPermission(session, 'inventory:market_sku_manage'))
    || supplierWritableMarkets(session).includes(ownerMarketId)
}

export { supplierDisplayName } from './supplier-label'
