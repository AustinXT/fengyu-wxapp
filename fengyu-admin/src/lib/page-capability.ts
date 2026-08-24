import { notFound } from 'next/navigation'
import type { AuthSession } from './types'
import { hasAllUiCapabilities, hasUiCapability } from './permission-contract'

/**
 * 创建、编辑等直达页在加载表单数据前调用。
 *
 * 服务端 action 仍会独立鉴权；这里防止只读角色通过手工 URL 看到无法提交的表单，
 * 并让自定义矩阵缺少页面硬依赖时稳定返回 404 而不是 SSR 403/500。
 */
export function requireUiPageCapability(
  session: AuthSession | null,
  action: string | readonly string[],
): asserts session is AuthSession {
  const actions = Array.isArray(action) ? action : [action]
  if (!session || !actions.some((item) => hasUiCapability(session.permissions.actions, item))) {
    notFound()
  }
}

/**
 * 页面在 SSR 阶段会并行调用多个 Server Action 时使用。
 *
 * 与 requireUiPageCapability 的 OR 语义不同：这里的每一个 action 都是页面
 * 无条件请求的数据依赖；任一缺失就不渲染页面，避免先抛出 Server Action 的 403。
 */
export function requireAllUiPageCapabilities(
  session: AuthSession | null,
  actions: readonly string[],
): asserts session is AuthSession {
  if (!session || !hasAllUiCapabilities(session.permissions.actions, actions)) {
    notFound()
  }
}
