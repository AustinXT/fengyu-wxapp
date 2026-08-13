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
