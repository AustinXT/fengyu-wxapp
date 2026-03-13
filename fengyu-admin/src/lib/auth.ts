import type { AuthSession, RoleType } from './types'

export type { AuthSession }

export type AuthRole = AuthSession['roles'][number]

// Mock admin session
export const MOCK_SESSION: AuthSession = {
  employeeId: 'FY-260101-0001',
  name: '张明',
  phone: '13800138000',
  roles: [
    { role: 'admin', scopeId: 'org-hq', scopeType: 'headquarters' },
    { role: 'manager', scopeId: 'org-store-nc01', scopeType: 'store' },
    { role: 'hr', scopeId: 'org-hq', scopeType: 'headquarters' },
  ],
  permissions: {
    actions: [
      'org:list', 'org:create', 'org:update', 'org:delete',
      'store:list', 'store:create', 'store:update',
      'employee:list', 'employee:create', 'employee:update',
      'product:list', 'product:create', 'product:update',
      'commission:list', 'commission:create', 'commission:update', 'commission:delete',
      'customer:list', 'customer:update',
      'coupon:list', 'coupon:create', 'coupon:update',
      'permission:list', 'permission:assign', 'permission:revoke', 'permission:assign_admin',
      'sale_order:list', 'sale_order:create', 'sale_order:update',
      'allocation:list', 'allocation:save',
      'service:list', 'service:create', 'service:update',
      'appointment:list', 'appointment:confirm', 'appointment:checkin',
      'sync:trigger', 'sync:status',
      'operation_log:list',
      'system:config',
      'data_center:dashboard',
    ],
    scopeStoreIds: ['store-nc01', 'store-nc02', 'store-jj01', 'store-gqc01'],
  },
}

/**
 * Get the current auth session.
 * In development, returns a mock session.
 * In production, this will read from JWT cookie / server context.
 */
export function getSession(): AuthSession {
  return MOCK_SESSION
}

/** Alias kept for components already using useAuth() */
export function useAuth(): AuthSession {
  return MOCK_SESSION
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
