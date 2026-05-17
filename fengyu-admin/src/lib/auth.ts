import { getSessionFromCookie } from '@/actions/auth'
import { ROLE_LABELS } from './types'
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
 * Check if user has a specific role
 */
export function hasRole(session: AuthSession, role: RoleType): boolean {
  return session.roles.some(r => r.role === role)
}

/**
 * Get display role label in Chinese
 */
export function getRoleLabel(role: RoleType): string {
  return ROLE_LABELS[role] ?? role
}
