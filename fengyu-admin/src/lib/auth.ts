import { getSessionFromCookie } from '@/actions/auth'
import { ROLE_LABELS } from './types'
import type { AuthSession, RoleType } from './types'

export type { AuthSession }
export type AuthRole = AuthSession['roles'][number]


export async function getSession(): Promise<AuthSession | null> {
  return getSessionFromCookie()
}


export function hasRole(session: AuthSession, role: RoleType): boolean {
  return session.roles.some(r => r.role === role)
}


export function getRoleLabel(role: RoleType): string {
  return ROLE_LABELS[role] ?? role
}
