import { redirect } from 'next/navigation'
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, sql, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { AuthSession, RoleType } from './types'


export const DEFAULT_PERMISSION_MATRIX: Record<RoleType, string[]> = {
  
  
  
  
  
  
  admin: [
    'dashboard:view',
    
    'org:list', 'org:create', 'org:update', 'org:delete',
    'store:list', 'store:create', 'store:update',
    'employee:list', 'employee:create', 'employee:update', 'employee:delete',
    'product:list', 'product:create', 'product:update',
    'commission:list', 'commission:create', 'commission:update', 'commission:delete',
    'coupon:list', 'coupon:create', 'coupon:update',
    
    'sale_order:list', 'sale_order:create', 'sale_order:update', 'sale_order:record_payment', 'sale_order:delete',
    'sale_item:list',
    'allocation:list', 'allocation:save',
    'service:list', 'service:create', 'service:update', 'service:delete',
    'appointment:list', 'appointment:confirm', 'appointment:checkin', 'appointment:delete',
    'customer:list', 'customer:create', 'customer:update', 'customer:delete',
    'pickup_record:list', 'pickup_record:create', 'pickup_record:delete',
    'data_center:dashboard',
    'store_unbind:list', 'store_unbind:approve', 'store_unbind:reject', 'store_unbind:delete',
    
    'permission:list', 'permission:assign', 'permission:revoke', 'permission:assign_admin',
    'operation_log:list', 'operation_log:delete',
    'point_transaction:list',
    'card_transaction:list',
    'message:list', 'message:delete', 'message:send',
    'system:config',
    
    'admin:reset_password',
    
    'sale_order:refund_create', 'sale_order:refund_approve',
    
    'legacy_order:list', 'legacy_order:approve', 'legacy_order:reject',
    'legacy_order:update_phone', 'legacy_order:update_amount', 'legacy_order:pull',
    
    'inventory:list', 'inventory:create', 'inventory:update', 'inventory:delete',
    
    'store:lakala_config',
    
    'merchant:list', 'merchant:create', 'merchant:update', 'merchant:delete',
  ],
  
  
  
  
  manager: [
    'allocation:list', 'allocation:save',
    'appointment:checkin', 'appointment:confirm', 'appointment:delete', 'appointment:list',
    'card_transaction:list',
    'coupon:list',
    'customer:create', 'customer:delete', 'customer:list', 'customer:update',
    'dashboard:view',
    'data_center:dashboard',
    'employee:create', 'employee:delete', 'employee:list', 'employee:update',
    'inventory:create', 'inventory:list', 'inventory:update',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:list',
    'message:list', 'message:send',
    'operation_log:list',
    'org:list',
    'pickup_record:create', 'pickup_record:delete', 'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:create', 'sale_order:delete', 'sale_order:list', 'sale_order:record_payment', 'sale_order:refund_approve', 'sale_order:refund_create', 'sale_order:update',
    'service:create', 'service:delete', 'service:list', 'service:update',
    'store:lakala_config', 'store:list',
    'store_unbind:approve', 'store_unbind:delete', 'store_unbind:list', 'store_unbind:reject',
  ],
  
  
  
  finance: [
    'allocation:list',
    'card_transaction:list',
    'commission:create', 'commission:delete', 'commission:list', 'commission:update',
    'coupon:list',
    'customer:list',
    'dashboard:view',
    'data_center:dashboard',
    'employee:list',
    'inventory:list',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:create', 'merchant:delete', 'merchant:list', 'merchant:update',
    'operation_log:list',
    'org:list',
    'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:list', 'sale_order:record_payment', 'sale_order:refund_create',
    'service:list',
    'store:list',
  ],
  
  
  hr: [
    'dashboard:view',
    'employee:create', 'employee:list', 'employee:update',
    'message:list', 'message:send',
    'operation_log:list',
    'org:create', 'org:list', 'org:update',
    'permission:assign', 'permission:list', 'permission:revoke',
    'product:list',
    'sale_order:list', 'sale_order:refund_create',
    'service:list',
    'store:create', 'store:list', 'store:update',
  ],
  
  
  product: [
    'coupon:create', 'coupon:list', 'coupon:update',
    'dashboard:view',
    'inventory:create', 'inventory:delete', 'inventory:list', 'inventory:update',
    'operation_log:list',
    'org:list',
    'product:create', 'product:list', 'product:update',
    'sale_order:list', 'sale_order:refund_create',
    'store:list',
  ],
  
  
  customer_mgr: [
    'appointment:checkin', 'appointment:confirm', 'appointment:delete', 'appointment:list',
    'customer:create', 'customer:delete', 'customer:list', 'customer:update',
    'dashboard:view',
    'employee:list',
    'inventory:list',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'operation_log:list',
    'org:list',
    'pickup_record:list',
    'product:list',
    'sale_item:list',
    'sale_order:refund_create',
    'store:list',
  ],
  
  staff: [],
}


export const ALL_ACTIONS: string[] = [
  ...new Set(Object.values(DEFAULT_PERMISSION_MATRIX).flat()),
].sort()


const PERMISSION_MATRIX_CACHE_TTL_MS = 30_000
let _matrixCache: { matrix: Record<RoleType, string[]>; expiresAt: number } | null = null


export function invalidatePermissionMatrixCache(): void {
  _matrixCache = null
}


export async function getPermissionMatrix(): Promise<Record<RoleType, string[]>> {
  const now = Date.now()
  if (_matrixCache && _matrixCache.expiresAt > now) {
    return _matrixCache.matrix
  }
  try {
    const rows = await db.execute<{ value: string }>(
      sql`SELECT value FROM system_configs WHERE key = 'permission_matrix' LIMIT 1`,
    )
    const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
    if (!raw) {
      _matrixCache = { matrix: DEFAULT_PERMISSION_MATRIX, expiresAt: now + PERMISSION_MATRIX_CACHE_TTL_MS }
      return DEFAULT_PERMISSION_MATRIX
    }
    try {
      const parsed = JSON.parse(raw) as Record<RoleType, string[]>
      _matrixCache = { matrix: parsed, expiresAt: now + PERMISSION_MATRIX_CACHE_TTL_MS }
      return parsed
    } catch (parseErr) {
      console.error('[permission-matrix] JSON parse failed, fallback to DEFAULT', parseErr)
      return DEFAULT_PERMISSION_MATRIX
    }
  } catch (dbErr) {
    console.error('[permission-matrix] DB read failed, fallback to DEFAULT', dbErr)
    return DEFAULT_PERMISSION_MATRIX
  }
}


export async function computeActions(roles: Array<{ role: RoleType }>): Promise<string[]> {
  const matrix = await getPermissionMatrix()
  const actionSet = new Set<string>()
  for (const { role } of roles) {
    const actions = matrix[role]
    if (actions) {
      for (const a of actions) actionSet.add(a)
    }
  }
  return Array.from(actionSet)
}


export async function expandScopeStoreIds(
  roles: AuthSession['roles']
): Promise<string[]> {
  const storeIds = new Set<string>()

  for (const r of roles) {
    if (r.scopeType === '总部') {
      
      const allStores = await db
        .select({ storeId: stores.storeId })
        .from(stores)
      for (const s of allStores) storeIds.add(s.storeId)
      return Array.from(storeIds) 
    }

    if (r.scopeType === '市场') {
      
      const storeNodes = await db
        .select({ id: orgNodes.id })
        .from(orgNodes)
        .where(and(eq(orgNodes.parentId, r.scopeId), eq(orgNodes.type, '门店')))
      if (storeNodes.length > 0) {
        const storeNodeIds = storeNodes.map(n => n.id)
        const marketStores = await db
          .select({ storeId: stores.storeId })
          .from(stores)
          .where(inArray(stores.orgNodeId, storeNodeIds))
        for (const s of marketStores) storeIds.add(s.storeId)
      }
    }

    if (r.scopeType === '门店') {
      
      const storeRows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(eq(stores.orgNodeId, r.scopeId))
      for (const s of storeRows) storeIds.add(s.storeId)
    }
  }

  return Array.from(storeIds)
}


export async function expandVisibleMarketIds(
  session: AuthSession,
): Promise<string[] | null> {
  
  if (session.roles.some(r => r.scopeType === '总部')) {
    return null
  }

  const marketIds = new Set<string>()
  const storeScopeIds: string[] = []

  for (const r of session.roles) {
    if (r.scopeType === '市场') {
      marketIds.add(r.scopeId)
    } else if (r.scopeType === '门店') {
      storeScopeIds.push(r.scopeId)
    }
  }

  if (storeScopeIds.length > 0) {
    
    const parentRows = await db
      .select({ parentId: orgNodes.parentId })
      .from(orgNodes)
      .where(and(inArray(orgNodes.id, storeScopeIds), eq(orgNodes.type, '门店')))
    for (const row of parentRows) {
      if (row.parentId) marketIds.add(row.parentId)
    }
  }

  return Array.from(marketIds)
}


export function buildScopeWhere(session: AuthSession, storeIdColumn = 'store_id') {
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) {
    return sql`FALSE`
  }
  
  return sql`${sql.raw(storeIdColumn)} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`
}


export function isAdminScope(session: AuthSession): boolean {
  return session.roles.some(r => r.role === 'admin')
}


export function canAccessAdmin(roles: Array<{ role: string }>): boolean {
  return roles.some(r => r.role !== 'staff')
}


export function accessiblePermissionScopeIds(session: AuthSession): string[] | null {
  if (isAdminScope(session)) return null
  return Array.from(new Set(session.roles.map(r => r.scopeId)))
}


export function scopeCondition(
  session: AuthSession,
  storeIdColumn: PgColumn,
): SQL | undefined {
  if (isAdminScope(session)) {
    return undefined 
  }
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) {
    return sql`FALSE`
  }
  return inArray(storeIdColumn, ids) as SQL
}


export function isInScope(session: AuthSession, storeId: string): boolean {
  if (isAdminScope(session)) return true
  return session.permissions.scopeStoreIds.includes(storeId)
}


export function hasPermission(session: AuthSession, action: string): boolean {
  return session.permissions.actions.includes(action)
}


export class PermissionError extends Error {
  readonly digest = 'PERMISSION_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}


export function requirePermission(session: AuthSession | null, action: string): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  if (!session.permissions.actions.includes(action)) {
    throw new PermissionError(`PERMISSION_DENIED: 无权执行 ${action}`)
  }
}


export function requireAnyPermission(
  session: AuthSession | null,
  actions: string[],
): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  const has = actions.some((a) => session.permissions.actions.includes(a))
  if (!has) {
    throw new PermissionError(`PERMISSION_DENIED: 无权执行 ${actions.join(' 或 ')}`)
  }
}
