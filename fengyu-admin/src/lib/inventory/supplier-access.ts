import { ApiError } from '@/lib/api-error'
import { scopeSessionToActions } from '@/lib/action-scope'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'

export const SUPPLIER_MANAGE_ACTIONS = [
  'inventory:supply_chain_master_data_manage',
  'inventory:market_sku_manage',
]

/** 共有档案只能由授予供应链维护动作的总部绑定维护，不借其它绑定的范围。 */
function canManageSharedSupplier(session: AuthSession): boolean {
  if (!hasPermission(session, SUPPLIER_MANAGE_ACTIONS[0])) return false
  return isAdminScope(session) || session.roles.some((role) => role.scopeType === '总部'
    && role.actions?.includes(SUPPLIER_MANAGE_ACTIONS[0]))
}

/** 页面入口与后端归属推导同源；多市场和误授总部动作的市场绑定均拒绝。 */
export function canCreateSupplier(session: AuthSession): boolean {
  try { supplierCreationOwner(session); return true } catch { return false }
}

/** 归属由实际授予建档动作的市场绑定确定；不能拼接其它角色的范围。 */
export function supplierCreationOwner(session: AuthSession): string | null {
  const scoped = scopeSessionToActions(session, SUPPLIER_MANAGE_ACTIONS)
  if (canManageSharedSupplier(scoped)) return null
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
  if (ownerMarketId === null) return canManageSharedSupplier(session)
  return (isAdminScope(session) && hasPermission(session, 'inventory:market_sku_manage'))
    || supplierWritableMarkets(session).includes(ownerMarketId)
}

export { supplierDisplayName } from './supplier-label'
