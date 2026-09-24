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

/**
 * 价格档位的行级生效范围（说明.md §9.3/§9.5）。
 *
 * `inventoryPriceVisibility` 读的是会话动作并集，混合绑定会话（如市场 B 绑
 * inventory_market_finance + 门店 A 绑 inventory_store_operator）会把市场 B 的
 * 价格权限全局应用到门店 A 的单据上。此处改为逐条角色绑定计算：绑定持有
 * supply_chain_price_view / market_price_view 时，仅把该**单一绑定**按
 * inventoryScopedOrgNodeIds 同规则展开的 org 集合并入对应档位。
 *
 * `null` = 该档位不受 org 限制（仅 admin 全量）；
 * `Set` = 该档位仅对集合内 org 节点参与的行生效（空集 = 完全不生效）。
 */
export interface InventoryPriceTierScopes {
  supplyChain: ReadonlySet<string> | null
  market: ReadonlySet<string> | null
}

function roleOrgNodeIds(role: AuthSession['roles'][number]): string[] {
  // 与 inventoryScopedOrgNodeIds 的单绑定展开规则一致：库存总部不展开后代。
  if (role.scopeType === '总部') return [role.scopeId]
  return role.scopeOrgNodeIds?.length ? role.scopeOrgNodeIds : [role.scopeId]
}

export function inventoryPriceScopeByTier(session: AuthSession): InventoryPriceTierScopes {
  if (isAdminScope(session)) return { supplyChain: null, market: null }
  const hasRoleMetadata = session.roles.length > 0
    && session.roles.every((role) => Array.isArray(role.actions))
  if (!hasRoleMetadata) {
    // 旧会话（无角色级 actions 元数据）无法把价格权归属到具体绑定：
    // 单绑定会话用该绑定自身的 org 范围（与行可见范围同构，效果与修复前一致）；
    // 多绑定会话拒绝跨绑定拼接（§9.3），一律 fail-closed 空集——重新登录携带
    // 元数据后恢复。除 admin 外绝不返回 null（null = 全局放行）。
    if (session.roles.length === 1) {
      const scope: ReadonlySet<string> = new Set(roleOrgNodeIds(session.roles[0]))
      return {
        supplyChain: hasPermission(session, 'inventory:supply_chain_price_view') ? scope : new Set(),
        market: hasPermission(session, 'inventory:market_price_view') ? scope : new Set(),
      }
    }
    return { supplyChain: new Set(), market: new Set() }
  }
  const supplyChain = new Set<string>()
  const market = new Set<string>()
  for (const role of session.roles) {
    const grantsSupply = role.actions!.includes('inventory:supply_chain_price_view')
    const grantsMarket = role.actions!.includes('inventory:market_price_view')
    if (!grantsSupply && !grantsMarket) continue
    for (const orgNodeId of roleOrgNodeIds(role)) {
      if (grantsSupply) supplyChain.add(orgNodeId)
      if (grantsMarket) market.add(orgNodeId)
    }
  }
  return { supplyChain, market }
}

/**
 * 行级价格档位：档位对该行生效 = 档位集合覆盖该行的任一参与主体
 * （单据用 source/target 端点，与单据可见性同构；结算/批次行用其归属 org）。
 */
export function inventoryPriceVisibilityForOrgNodes(
  tiers: InventoryPriceTierScopes,
  orgNodeIds: ReadonlyArray<string | null | undefined>,
): InventoryPriceVisibility {
  const covers = (scope: ReadonlySet<string> | null) =>
    scope === null || orgNodeIds.some((id) => id != null && scope.has(id))
  const supplyChain = covers(tiers.supplyChain)
  const market = covers(tiers.market)
  if (supplyChain && market) return 'all'
  if (supplyChain) return 'supply_chain'
  if (market) return 'market'
  return 'none'
}

/**
 * 把 scope 可见范围按价格档位再收一层（货款结算等纯金额查询用）：
 * 任一档位不受限（null）时直接返回 scoped；否则取 scoped ∩ (各档位集合并集)。
 */
export function inventoryTierRestrictedOrgNodeIds(
  scoped: string[] | null,
  tierScopes: ReadonlyArray<ReadonlySet<string> | null>,
): string[] | null {
  if (tierScopes.some((scope) => scope === null)) return scoped
  const union = new Set<string>()
  for (const scope of tierScopes) for (const id of scope!) union.add(id)
  if (scoped === null) return [...union]
  return scoped.filter((id) => union.has(id))
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

/** 报货福利方案的维护权限（#354）。 */
export const INVENTORY_PROMOTION_MAINTAIN_ACTION = 'inventory:supply_chain_master_data_manage'

/**
 * 报货福利方案只由总部供应链维护（#354，9/18 会议 §2.2「单价优惠不可手填，由报货福利自动提取」）：
 * 维护权限必须来自**总部 scope** 的角色绑定，超级管理员除外。市场账号即便被误授了这项动作，
 * 也不能给本市场建优惠来压低对供应链的应付。
 *
 * 判的是角色绑定自带的 actions（withPermission 收紧后的 session 仍保留每条绑定的完整 actions），
 * 所以在 `inventory:stock_list` 包装下调用（列表可见性）同样成立；缺角色级元数据的旧会话退回会话级权限。
 */
export function isInventoryPromotionMaintainer(session: AuthSession): boolean {
  if (isAdminScope(session)) return true
  return session.roles.some((role) => role.scopeType === '总部' && (
    Array.isArray(role.actions)
      ? role.actions.includes(INVENTORY_PROMOTION_MAINTAIN_ACTION)
      : hasPermission(session, INVENTORY_PROMOTION_MAINTAIN_ACTION)
  ))
}

export function assertInventoryPromotionMaintainer(session: AuthSession): void {
  if (!isInventoryPromotionMaintainer(session)) {
    throw new ApiError('PERMISSION_DENIED', '报货福利方案只能由总部供应链维护')
  }
}
