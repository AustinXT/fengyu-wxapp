import { getSessionFromCookie } from '@/actions/auth'
import type { AuthSession, RoleType } from './types'

export type { AuthSession }
export type AuthRole = AuthSession['roles'][number]

/**
 * Get the current auth session from JWT cookie → DB lookup.
 * Returns null if not authenticated.
 */
export async function getSession(): Promise<AuthSession | null> {
  return getSessionFromCookie()
}

/**
 * Check if user has a specific permission action
 */
export function hasPermission(session: AuthSession, action: string): boolean {
  return session.permissions.actions.includes(action)
}

/**
 * Check if user has a specific role
 */
export function hasRole(session: AuthSession, role: RoleType): boolean {
  return session.roles.some(r => r.role === role)
}

/**
 * Get display role label in Chinese
 */
export function getRoleLabel(role: RoleType): string {
  const labels: Record<string, string> = {
    admin: '超级管理员',
    manager: '店长',
    finance: '财务',
    hr: '人事',
    product: '商品管理员',
    customer_mgr: '顾客管理员',
    staff: '员工',
  }
  return labels[role] ?? role
}
