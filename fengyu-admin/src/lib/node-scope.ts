import type { AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'

/**
 * 校验某 org_node 是否在用户 scope 内（admin 始终通过）。
 *
 * 会话构造时已将每个角色根节点展开为自身及全部后代节点；这里直接做集合判断，
 * 因而没有固定深度限制，也不会因异常循环 parent 链卡住请求。
 *
 * 放在独立模块（而非 permissions.ts）以保持「调用方 mock isAdminScope 即可驱动本函数」的
 * 测试关系——若内联进 permissions.ts，模块内对 isAdminScope 的调用将无法被 mock 替换。
 */
export async function isNodeInScope(session: AuthSession, nodeId: string): Promise<boolean> {
  if (isAdminScope(session)) return true
  const expanded = session.permissions.scopeOrgNodeIds
    ?? session.permissions.scopeDeptNodeIds
    ?? session.roles.map((role) => role.scopeId)
  return expanded.includes(nodeId)
}
