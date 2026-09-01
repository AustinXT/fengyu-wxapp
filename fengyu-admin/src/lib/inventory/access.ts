import { ApiError } from '@/lib/api-error'
import type { AuthSession } from '@/lib/types'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import type { InventoryPriceVisibility } from './types'

/**
 * 进销存的总部 scope 与普通经营数据不同：总部只代表总部库存，不自动展开市场和门店。
 * withPermission 已把 roles 收紧到真正授予当前动作的角色绑定。
 */
export function inventoryScopedLocationIds(session: AuthSession): string[] | null {
  if (isAdminScope(session)) return null
  const ids = new Set<string>()
  for (const role of session.roles) {
    if (role.scopeType === '总部') {
      ids.add(role.scopeId)
      continue
    }
    if (role.scopeType === '市场') {
      ids.add(role.scopeId)
      for (const storeId of role.scopeStoreIds ?? []) ids.add(storeId)
      continue
    }
    for (const storeId of role.scopeStoreIds ?? []) ids.add(storeId)
  }
  // 兼容旧测试/导出会话；正常登录会话始终带角色级 scope 元数据。
  if (ids.size === 0 && session.roles.some((role) => !Array.isArray(role.scopeStoreIds))) {
    for (const storeId of session.permissions.scopeStoreIds) ids.add(storeId)
  }
  return [...ids]
}

/**
 * 单据按真实组织节点隔离。动作级 session.roles 已由 withPermission 收紧，
 * scopeOrgNodeIds 包含绑定节点自身及全部后代；库存总部不展开后代，
 * 市场可见门店单据，门店仅见自身。
 */
export function inventoryScopedOrgNodeIds(session: AuthSession): string[] | null {
  if (isAdminScope(session)) return null
  const ids = new Set<string>()
  for (const role of session.roles) {
    if (role.scopeType === '总部') {
      ids.add(role.scopeId)
      continue
    }
    const expanded = role.scopeOrgNodeIds?.length ? role.scopeOrgNodeIds : [role.scopeId]
    for (const orgNodeId of expanded) ids.add(orgNodeId)
  }
  if (ids.size === 0) {
    for (const orgNodeId of session.permissions.scopeOrgNodeIds ?? []) ids.add(orgNodeId)
  }
  return [...ids]
}

export function inventoryPriceVisibility(session: AuthSession): InventoryPriceVisibility {
  if (isAdminScope(session)) return 'all'
  const supplyChain = hasPermission(session, 'inventory:supply_chain_price_view')
  const market = hasPermission(session, 'inventory:market_price_view')
  if (supplyChain && market) return 'all'
  if (supplyChain) return 'supply_chain'
  if (market) return 'market'
  return 'none'
}

export function canViewInventoryAmount(session: AuthSession): boolean {
  return inventoryPriceVisibility(session) !== 'none'
}

export function assertInventoryLocationInScope(session: AuthSession, locationId: string): void {
  const scoped = inventoryScopedLocationIds(session)
  if (scoped !== null && !scoped.includes(locationId)) {
    // ApiError 保证 runWithApiResponse 按 errorType 序列化为 -403，而非降级 -1。
    throw new ApiError('PERMISSION_DENIED', '无权操作该库存主体')
  }
}
