import { notFound } from 'next/navigation'
import type { AuthSession } from './types'
import { hasUiCapability } from './permission-contract'

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
