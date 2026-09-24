import type { AuthSession } from './types'

/**
 * 纯函数角色判定（无 db / server-only 依赖）。
 *
 * breadcrumb-nav / sidebar 等 client 组件经 menu.ts 静态引用本函数；若从
 * permissions.ts import，会把 `@/db`（postgres 驱动）拖进 client bundle，
 * next build 报 Module not found: net/tls/fs（2026-09-01 dev 迁 sqlserver101
 * 部署现场复现；main 侧合并后从未 build 验证所致）。
 *
 * permissions.ts re-export 同名函数保持 server 调用方与 `vi.mock('@/lib/permissions')`
 * 的既有关系不变；修改判定逻辑时两处视图合一（实现只在本文件）。
 */
export function isAdminScope(session: AuthSession): boolean {
  return session.roles.some(r => r.isSuperAdmin ?? r.role === 'admin')
}
