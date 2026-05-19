import { redirect } from 'next/navigation'
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, sql, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { AuthSession, RoleType } from './types'

/**
 * DEFAULT_PERMISSION_MATRIX: role → actions[]
 *
 * 每个角色的默认权限动作列表（fallback / 重置基线）。
 * 运行时的权威值是 DB：system_configs[key='permission_matrix']；
 * 入口统一走 getPermissionMatrix()，DB 缺失 / 解析失败时回退到本常量。
 *
 * 直接 import 此常量仅限：
 *   1) admin /settings/permission-matrix 重置按钮
 *   2) UI 列出 ALL_ACTIONS（保证矩阵编辑器与代码默认对齐）
 *   3) 单元测试
 * 业务代码（hasPermission / requirePermission / scopeCondition）一律不直接读矩阵，
 * 而是吃 session.permissions.actions（已在 getSessionFromCookie 内由 computeActions 摊平）。
 */
export const DEFAULT_PERMISSION_MATRIX: Record<RoleType, string[]> = {
  admin: [
    'dashboard:view',
    // 基础数据 CRUD（组织/门店/员工/商品/提成/优惠券）
    'org:list', 'org:create', 'org:update', 'org:delete',
    'store:list', 'store:create', 'store:update',
    'employee:list', 'employee:create', 'employee:update',
    'product:list', 'product:create', 'product:update',
    'commission:list', 'commission:create', 'commission:update', 'commission:delete',
    'coupon:list', 'coupon:create', 'coupon:update',
    // 营业额分配（只读，便于审批退款时核对）
    'allocation:list',
    // 系统管理（权限/日志/消息/配置）
    'permission:list', 'permission:assign', 'permission:revoke', 'permission:assign_admin',
    'operation_log:list',
    'point_transaction:list',
    'card_transaction:list',
    'message:list', 'message:delete', 'message:send',
    'system:config',
    // 重置员工密码（admin 专属，取代原 isAdmin 旁路）
    'admin:reset_password',
    // 退款管理（2026-05-17 PR-Z 职责拆分；2026-05-17 PR-Z2 admin 拿回 approve 权）
    // admin 既可发起退款，也可审批（与 manager 并列为审批角色，manager 缺位时救场）
    'sale_order:refund_create', 'sale_order:refund_approve',
    // 历史订单核对（WorkFine 导入的 status='未审核' 订单，仅 admin/manager 操作）
    'legacy_order:list', 'legacy_order:approve', 'legacy_order:reject',
    'legacy_order:update_phone', 'legacy_order:update_amount',
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
    // 退款：店长可发起申请 + 审批（含 reject）— 唯一持 approve 的角色
    'sale_order:refund_create', 'sale_order:refund_approve',
    'sale_item:list',
    'allocation:list', 'allocation:save',
    'service:list', 'service:create', 'service:update',
    'appointment:list', 'appointment:confirm', 'appointment:checkin',
    'point_transaction:list',
    'card_transaction:list',
    'pickup_record:list', 'pickup_record:create',
    'data_center:dashboard',
    'store_unbind:list', 'store_unbind:approve', 'store_unbind:reject',
    // 历史订单核对（manager 是顾客到店时的主要操作角色）
    'legacy_order:list', 'legacy_order:approve', 'legacy_order:reject',
    'legacy_order:update_phone', 'legacy_order:update_amount',
  ],
  finance: [
    'dashboard:view',
    'sale_order:list',
    'sale_order:refund_create',
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
    // 退款发起：2026-05-17 PR-Z — 所有 admin 角色都能提退款申请
    'sale_order:refund_create',
  ],
  product: [
    'dashboard:view',
    'product:list', 'product:create', 'product:update',
    'coupon:list', 'coupon:create', 'coupon:update',
    'sale_order:refund_create',
  ],
  customer_mgr: [
    'dashboard:view',
    'customer:list', 'customer:update', 'customer:create',
    'sale_item:list',
    'sale_order:refund_create',
  ],
  staff: [],
}

/**
 * 进程级权限矩阵缓存
 *
 * - TTL 30s（与 cron-worker getMemberThreshold 30s/5min 双层缓存一致）
 * - 写入后由 saveMatrix/resetMatrix 主动调用 invalidatePermissionMatrixCache()
 * - admin 当前为 docker-compose 单副本，多进程不一致暂不处理（后续 ticket PG NOTIFY）
 */
const PERMISSION_MATRIX_CACHE_TTL_MS = 30_000
let _matrixCache: { matrix: Record<RoleType, string[]>; expiresAt: number } | null = null

/** 立刻让进程内缓存失效（saveMatrix/resetMatrix 调用） */
export function invalidatePermissionMatrixCache(): void {
  _matrixCache = null
}

/**
 * 取当前生效的权限矩阵：DB 优先，失败时回退 DEFAULT。
 *
 * - DB 行不存在 / JSON 解析失败 / DB 连接异常 → 静默回退 DEFAULT_PERMISSION_MATRIX，
 *   并 console.error 标记，确保任何情况下 admin 都能登录。
 * - 缓存命中直接返回；首次 / 失效 / 异常分支都不写入失败结果（让下次重试）。
 */
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

/**
 * 根据角色数组计算合并后的 actions 集合
 *
 * 2026-05-18 起异步：从 getPermissionMatrix() 读取 DB 矩阵（含 30s 缓存 + DEFAULT fallback）。
 * 调用方仅 actions/auth.ts:getSessionFromCookie（已 async），无 edge runtime 触发面。
 */
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
 * 根据 session.roles 展开当前账号可见的市场（org_nodes.type='市场'）ID 集合
 *
 * - 总部角色（任意一个）→ 返回 null，调用方按 null 解释为"不过滤，可见所有市场"
 * - 市场角色 → scopeId 直接计入
 * - 门店角色 → 通过 org_nodes.parent_id 反查所属市场计入
 *
 * 用于 admin /commission /products /coupons 三处 `getMarkets()` 下拉列表 scope 过滤。
 */
export async function expandVisibleMarketIds(
  session: AuthSession,
): Promise<string[] | null> {
  // 任一总部角色即视为全开
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
    // 门店节点 → parent_id（市场节点）
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
 * Check if user has a specific permission action
 */
export function hasPermission(session: AuthSession, action: string): boolean {
  return session.permissions.actions.includes(action)
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
 * 既可被业务查看者（sale_order:list）调用，也可被退款相关角色
 * （sale_order:refund_create 提单人 / sale_order:refund_approve 审批人）调用。
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
