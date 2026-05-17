import { redirect } from 'next/navigation'
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, sql, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { AuthSession, RoleType } from './types'

/**
 * PERMISSION_MATRIX: role → actions[]
 *
 * 每个角色的默认权限动作列表。
 * admin 拥有所有权限；其他角色按职能分配。
 */
export const PERMISSION_MATRIX: Record<RoleType, string[]> = {
  admin: [
    'dashboard:view',
    // 基础数据 CRUD（组织/门店/员工/商品/提成/优惠券）
    'org:list', 'org:create', 'org:update', 'org:delete',
    'store:list', 'store:create', 'store:update',
    'employee:list', 'employee:create', 'employee:update',
    'product:list', 'product:create', 'product:update',
    'commission:list', 'commission:create', 'commission:update', 'commission:delete',
    'coupon:list', 'coupon:create', 'coupon:update',
    // 系统管理（权限/日志/消息/配置）
    'permission:list', 'permission:assign', 'permission:revoke', 'permission:assign_admin',
    'operation_log:list',
    'point_transaction:list',
    'card_transaction:list',
    'message:list', 'message:delete', 'message:send',
    'system:config',
    // 退款管理（ticket 2026-04-24 退款 PR-Y）— admin 审批退款单
    'sale_order:refund',
    // admin 不碰业务数据（订单/分配/服务/预约/顾客）
  ],
  manager: [
    'dashboard:view',
    'store:list',
    'employee:list',
    'customer:list', 'customer:update', 'customer:create',
    'product:list',
    'coupon:list',
    'sale_order:list', 'sale_order:create', 'sale_order:update',
    'sale_order:refund',
    'sale_item:list',
    'allocation:list', 'allocation:save',
    'service:list', 'service:create', 'service:update',
    'appointment:list', 'appointment:confirm', 'appointment:checkin',
    'point_transaction:list',
    'card_transaction:list',
    'pickup_record:list', 'pickup_record:create',
    'data_center:dashboard',
    'store_unbind:list', 'store_unbind:approve', 'store_unbind:reject',
  ],
  finance: [
    'dashboard:view',
    'sale_order:list',
    'sale_order:refund',
    'sale_order:record_payment',
    'sale_item:list',
    'allocation:list',
    'customer:list',
    'point_transaction:list',
    'card_transaction:list',
    'pickup_record:list',
    'data_center:dashboard',
  ],
  hr: [
    'dashboard:view',
    'org:list', 'org:create', 'org:update',
    'store:list', 'store:create', 'store:update',
    'employee:list', 'employee:create', 'employee:update',
    'permission:list', 'permission:assign', 'permission:revoke',
  ],
  product: [
    'dashboard:view',
    'product:list', 'product:create', 'product:update',
    'coupon:list', 'coupon:create', 'coupon:update',
  ],
  customer_mgr: [
    'dashboard:view',
    'customer:list', 'customer:update', 'customer:create',
    'sale_item:list',
  ],
  staff: [],
}

/**
 * 根据角色数组计算合并后的 actions 集合
 */
export function computeActions(roles: Array<{ role: RoleType }>): string[] {
  const actionSet = new Set<string>()
  for (const { role } of roles) {
    const actions = PERMISSION_MATRIX[role]
    if (actions) {
      for (const a of actions) actionSet.add(a)
    }
  }
  return Array.from(actionSet)
}

/**
 * 根据角色的 scope 展开为门店 ID 列表
 *
 * - headquarters scope → 所有门店
 * - market scope → 该市场下所有门店
 * - store scope → 该门店自身（通过 orgNode → store 关联）
 */
export async function expandScopeStoreIds(
  roles: AuthSession['roles']
): Promise<string[]> {
  const storeIds = new Set<string>()

  for (const r of roles) {
    if (r.scopeType === '总部') {
      // 总部权限：返回所有门店
      const allStores = await db
        .select({ storeId: stores.storeId })
        .from(stores)
      for (const s of allStores) storeIds.add(s.storeId)
      return Array.from(storeIds) // 总部已包含全部
    }

    if (r.scopeType === '市场') {
      // 市场权限：该市场节点下的所有门店节点 → stores
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
      // 门店权限：通过 scopeId（orgNode id）找 store
      const storeRows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(eq(stores.orgNodeId, r.scopeId))
      for (const s of storeRows) storeIds.add(s.storeId)
    }
  }

  return Array.from(storeIds)
}

/**
 * 构建 store_id 范围 SQL 条件
 *
 * 返回 SQL 条件片段，约束查询只返回用户权限范围内门店的数据。
 * 使用时：`.where(and(existingConditions, buildScopeWhere(session, 'column_name')))`
 */
export function buildScopeWhere(session: AuthSession, storeIdColumn = 'store_id') {
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) {
    return sql`FALSE`
  }
  // 使用参数化查询避免 SQL 注入
  return sql`${sql.raw(storeIdColumn)} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`
}

/**
 * 判断 session 是否拥有 admin 角色（不受 scope 限制）
 */
export function isAdminScope(session: AuthSession): boolean {
  return session.roles.some(r => r.role === 'admin')
}

/**
 * 构建 Drizzle ORM 的 scope 条件
 *
 * - admin → 返回 undefined（不过滤，等效于 buildScopeWhere 返回空条件）
 * - 非 admin 有 scopeStoreIds → 返回 inArray(column, ids)
 * - 非 admin 无 scopeStoreIds → 返回 sql`FALSE`
 *
 * 用于 `.where(and(existingConditions, scopeCondition(session, table.storeId)))`
 * Drizzle 的 and() 会忽略 undefined 参数。
 */
export function scopeCondition(
  session: AuthSession,
  storeIdColumn: PgColumn,
): SQL | undefined {
  if (isAdminScope(session)) {
    return undefined // admin 无数据过滤
  }
  const ids = session.permissions.scopeStoreIds
  if (ids.length === 0) {
    return sql`FALSE`
  }
  return inArray(storeIdColumn, ids) as SQL
}

/**
 * 检查指定 storeId 是否在用户 scope 内
 *
 * admin → 始终 true
 */
export function isInScope(session: AuthSession, storeId: string): boolean {
  if (isAdminScope(session)) return true
  return session.permissions.scopeStoreIds.includes(storeId)
}

/**
 * 权限校验：检查当前 session 是否拥有指定 action
 *
 * 如果权限不足，抛出 Error（由 server action 边界捕获）
 */
export function requirePermission(session: AuthSession | null, action: string): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  if (!session.permissions.actions.includes(action)) {
    throw new Error(`PERMISSION_DENIED: 无权执行 ${action}`)
  }
}

/**
 * 权限校验：拥有 actions 中任一即可通过（OR 关系）
 *
 * 用于同一 Server Action 服务多个角色的场景：例如订单详情页 getOrderById
 * 既可被业务查看者（sale_order:list）调用，也可被审批人（sale_order:refund，admin）调用。
 */
export function requireAnyPermission(
  session: AuthSession | null,
  actions: string[],
): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  const has = actions.some((a) => session.permissions.actions.includes(a))
  if (!has) {
    throw new Error(`PERMISSION_DENIED: 无权执行 ${actions.join(' 或 ')}`)
  }
}
