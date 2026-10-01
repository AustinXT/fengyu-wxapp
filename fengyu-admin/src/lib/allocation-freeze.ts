import type { AuthSession } from './types'
import { scopeSessionToActions } from './action-scope'
import { hasUiCapability } from './permission-contract'

// 与 staffApi allocation.js / serviceCommission.js 的三天窗口保持同一边界。
const FREEZE_DAYS = 3

export function isAllocationFrozen(anchor: Date | string | null | undefined, now = Date.now()): boolean {
  if (!anchor) return false
  return now - new Date(anchor).getTime() > FREEZE_DAYS * 86400000
}

/** 冻结后仅系统管理员或在目标门店有保存权限的财务角色可调整。 */
export function canAdjustFrozenAllocation(session: AuthSession, storeId: string): boolean {
  return session.roles.some((role) =>
    ((role.isSuperAdmin ?? role.role === 'admin')
      && role.actions?.includes('allocation:save') === true)
    || (role.role === 'finance'
      && role.actions?.includes('allocation:save') === true
      && role.scopeStoreIds?.includes(storeId) === true),
  )
}

/** 后台详情页的保存能力，与 Server Action 的动作范围和冻结守卫对齐。 */
export function canSaveAllocation(session: AuthSession, storeId: string, frozen: boolean): boolean {
  if (!hasUiCapability(session.permissions.actions, 'allocation:save')) return false
  const scoped = scopeSessionToActions(session, ['allocation:save'])
  const inScope = scoped.roles.some((role) => role.isSuperAdmin ?? role.role === 'admin')
    || scoped.permissions.scopeStoreIds.includes(storeId)
  return inScope && (!frozen || canAdjustFrozenAllocation(scoped, storeId))
}
