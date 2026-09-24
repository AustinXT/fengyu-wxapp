import type { AuthSession } from './types'

/**
 * 把会话数据范围收紧到“真正授予当前动作”的角色授权并集。
 *
 * 多角色会话的 actions 可以做并集，但 scope 不能脱离 action 独立并集；
 * 否则一个只把 employee:list 当引用读的数据角色，也会把另一个局部
 * 人事角色的员工管理范围扩大到数据角色所在市场。
 *
 * 旧的导出任务快照/测试会话没有角色级元数据时保持兼容；新会话全部
 * 带有 actions + 单角色 scope，会走严格收紧路径。
 */
export function scopeSessionToActions(
  session: AuthSession,
  actions: readonly string[],
): AuthSession {
  const hasRoleScopeMetadata = session.roles.every((role) =>
    Array.isArray(role.actions)
    && Array.isArray(role.scopeStoreIds)
    && Array.isArray(role.scopeOrgNodeIds),
  )
  if (!hasRoleScopeMetadata) return session

  const requested = new Set(actions)
  const roles = session.roles.filter((role) =>
    role.actions!.some((action) => requested.has(action)),
  )

  return {
    ...session,
    roles,
    permissions: {
      ...session.permissions,
      scopeStoreIds: Array.from(new Set(roles.flatMap((role) => role.scopeStoreIds!))),
      scopeOrgNodeIds: Array.from(new Set(roles.flatMap((role) => role.scopeOrgNodeIds!))),
    },
  }
}

/**
 * AND 权限必须落在同一条角色授权上，不能把市场 A 的基础动作与市场 B 的特殊动作拼接。
 * withAllPermissions 用于进销存敏感操作，以及数据中心经营明细报表（dashboard + 顾客明细 / 员工提成，#367）；
 * 同一角色会同时持有这组动作（角色编辑器按 UI 依赖自动补齐前置权限）。
 */
export function scopeSessionToAllActions(
  session: AuthSession,
  actions: readonly string[],
): AuthSession {
  const hasRoleScopeMetadata = session.roles.every((role) =>
    Array.isArray(role.actions)
    && Array.isArray(role.scopeStoreIds)
    && Array.isArray(role.scopeOrgNodeIds),
  )
  if (!hasRoleScopeMetadata) return session

  const roles = session.roles.filter((role) =>
    actions.every((action) => role.actions!.includes(action)),
  )
  if (roles.length === 0) {
    return {
      ...session,
      roles: [],
      permissions: {
        ...session.permissions,
        scopeStoreIds: [],
        scopeOrgNodeIds: [],
      },
    }
  }
  return {
    ...session,
    roles,
    permissions: {
      ...session.permissions,
      scopeStoreIds: Array.from(new Set(roles.flatMap((role) => role.scopeStoreIds!))),
      scopeOrgNodeIds: Array.from(new Set(roles.flatMap((role) => role.scopeOrgNodeIds!))),
    },
  }
}
