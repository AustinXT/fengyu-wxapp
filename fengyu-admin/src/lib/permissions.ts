import { redirect } from 'next/navigation'
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, or, sql, inArray } from 'drizzle-orm'
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
  // admin = 全部权限（系统管理员持有 ALL_ACTIONS，含业务数据）。
  // 2026-05-21 改：原先 admin 不带业务数据权限（订单/分配/服务/预约/顾客），
  // 导致 admin 单角色访问业务页 requirePermission 抛 PERMISSION_DENIED，
  // 生产构建脱敏 error.message 后误显示为 500。现 admin 全开，与 DB 覆盖矩阵对齐。
  // 维护：本数组必须是所有其它角色的并集（ALL_ACTIONS）；
  // permissions.test.ts 的 "admin == ALL_ACTIONS" 守护，新增 action 时勿漏。
  admin: [
    'dashboard:view',
    // 基础数据 CRUD（组织/门店/员工/商品/提成/优惠券）
    'org:list', 'org:create', 'org:update', 'org:delete',
    'store:list', 'store:create', 'store:update',
    'employee:list', 'employee:create', 'employee:update', 'employee:delete',
    'product:list', 'product:create', 'product:update',
    'commission:list', 'commission:create', 'commission:update', 'commission:delete',
    'coupon:list', 'coupon:create', 'coupon:update',
    // 业务数据（订单/明细/分配/服务/预约/顾客/疗程卡/提货/数据中心）
    'sale_order:list', 'sale_order:create', 'sale_order:update', 'sale_order:record_payment', 'sale_order:deposit_approve', 'sale_order:delete',
    'sale_item:list',
    'allocation:list', 'allocation:save',
    'service:list', 'service:create', 'service:update', 'service:delete',
    'appointment:list', 'appointment:confirm', 'appointment:checkin', 'appointment:delete',
    'customer:list', 'customer:create', 'customer:update', 'customer:delete',
    'pickup_record:list', 'pickup_record:create', 'pickup_record:delete',
    'data_center:dashboard',
    'store_unbind:list', 'store_unbind:approve', 'store_unbind:reject', 'store_unbind:delete',
    // 系统管理（权限/日志/消息/配置）
    'permission:list', 'permission:assign', 'permission:revoke', 'permission:assign_admin',
    'operation_log:list', 'operation_log:delete',
    'point_transaction:list',
    'card_transaction:list',
    'message:list', 'message:delete', 'message:send',
    'system:config',
    // 重置员工密码（admin 专属，取代原 isAdmin 旁路）
    'admin:reset_password',
    // 退款管理（2026-05-17 PR-Z 职责拆分；2026-05-17 PR-Z2 admin 拿回 approve 权）
    'sale_order:refund_create', 'sale_order:refund_approve',
    // 历史订单核对（WorkFine 导入的 status='未审核' 订单）
    'legacy_order:list', 'legacy_order:approve', 'legacy_order:reject',
    'legacy_order:update_phone', 'legacy_order:update_amount', 'legacy_order:pull',
    // 门店库存（4 类单据 v1，2026-05-19；admin 全开）
    'inventory:list', 'inventory:create', 'inventory:update', 'inventory:delete',
    // 门店库存 v2（中心库存表 + 统一单据；2026-07-24 会议）
    'inventory:stock_list', 'inventory:create_doc', 'inventory:approve', 'inventory:price_view', 'inventory:export',
    // 门店拉卡拉收款配置（门店关联收款商户；admin 专属，涉及收款，hr 不开）
    'store:lakala_config',
    // 商户管理（拉卡拉收款商户档案 CRUD；独立模块 /merchants，admin + finance）
    'merchant:list', 'merchant:create', 'merchant:update', 'merchant:delete',
  ],
  // 2026-06-24 对齐生产实配（运营在权限矩阵 UI 给店长扩权后固化为代码默认）。按模块字母序排列。
  // 相对历史默认的敏感扩权：sale_order:delete（删单）、employee:* 全 CRUD（维护本店员工）、
  // service:delete、pickup_record:delete、store_unbind:delete、store:lakala_config（门店收款配置）、
  // merchant:list（收款商户只读）、message:*、operation_log:list。退款 approve 仍仅 manager/admin 持有。
  manager: [
    'allocation:list', 'allocation:save',
    'appointment:checkin', 'appointment:confirm', 'appointment:delete', 'appointment:list',
    'card_transaction:list',
    'coupon:list',
    'customer:create', 'customer:delete', 'customer:list', 'customer:update',
    'dashboard:view',
    'data_center:dashboard',
    'employee:create', 'employee:delete', 'employee:list', 'employee:update',
    'inventory:create', 'inventory:create_doc', 'inventory:list', 'inventory:stock_list', 'inventory:update',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:list',
    'message:list', 'message:send',
    'operation_log:list',
    'org:list',
    'pickup_record:create', 'pickup_record:delete', 'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:create', 'sale_order:delete', 'sale_order:deposit_approve', 'sale_order:list', 'sale_order:record_payment', 'sale_order:refund_approve', 'sale_order:refund_create', 'sale_order:update',
    'service:create', 'service:delete', 'service:list', 'service:update',
    'store:lakala_config', 'store:list',
    'store_unbind:approve', 'store_unbind:delete', 'store_unbind:list', 'store_unbind:reject',
  ],
  // 2026-06-24 对齐生产实配。相对历史默认的扩权：commission:* 全 CRUD（提成矩阵）、coupon:list、
  // legacy_order 核对四项（approve/reject/update_amount/update_phone）、product:list、operation_log:list。
  // service:list — 营业额分配页含服务提成部分，finance 只读对账需看全。商户档案 /merchants 完整 CRUD。
  finance: [
    'allocation:list',
    'card_transaction:list',
    'commission:create', 'commission:delete', 'commission:list', 'commission:update',
    'coupon:list',
    'customer:list',
    'dashboard:view',
    'data_center:dashboard',
    'employee:list',
    'inventory:approve', 'inventory:export', 'inventory:list', 'inventory:price_view', 'inventory:stock_list',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:create', 'merchant:delete', 'merchant:list', 'merchant:update',
    'operation_log:list',
    'org:list',
    'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:deposit_approve', 'sale_order:list', 'sale_order:record_payment', 'sale_order:refund_create',
    'service:list',
    'store:list',
  ],
  // 2026-06-24 对齐生产实配。相对历史默认的扩权：message:*、product:list、sale_order:list、
  // service:list、operation_log:list。permission:assign 不含 assign_admin（hr 不能授 admin）。
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
  // 2026-06-24 对齐生产实配。相对历史默认的扩权：inventory 写权限（create/update/delete）、
  // sale_order:list、operation_log:list。
  product: [
    'coupon:create', 'coupon:list', 'coupon:update',
    'dashboard:view',
    'inventory:create', 'inventory:create_doc', 'inventory:delete', 'inventory:export', 'inventory:list', 'inventory:stock_list', 'inventory:update',
    'operation_log:list',
    'org:list',
    'product:create', 'product:list', 'product:update',
    'sale_order:list', 'sale_order:refund_create',
    'store:list',
  ],
  // 2026-06-24 对齐生产实配。相对历史默认的扩权：appointment 全套（含 delete）、customer:delete、
  // inventory:list、legacy_order 核对四项、pickup_record:list、product:list、operation_log:list。
  customer_mgr: [
    'appointment:checkin', 'appointment:confirm', 'appointment:delete', 'appointment:list',
    'customer:create', 'customer:delete', 'customer:list', 'customer:update',
    'dashboard:view',
    'employee:list',
    'inventory:list', 'inventory:stock_list',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'operation_log:list',
    'org:list',
    'pickup_record:list',
    'product:list',
    'sale_item:list',
    'sale_order:refund_create',
    'store:list',
  ],
  // staff（普通员工）专供小程序端，禁止登录 admin（canAccessAdmin 拦截）；矩阵留空。
  staff: [],
}

/**
 * ALL_ACTIONS：全仓所有 distinct 权限 action（各角色数组并集）。
 *
 * - admin 即持有 ALL_ACTIONS（系统管理员全开）。
 * - 供权限矩阵编辑器列全量、page-permission-coverage 测试、admin 完整性守护使用。
 * - 由于 admin 已是并集，这里 = sorted(unique(admin ∪ 其它角色))。
 */
export const ALL_ACTIONS: string[] = [
  ...new Set(Object.values(DEFAULT_PERMISSION_MATRIX).flat()),
].sort()

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
 * 根据角色的 scope 展开为「可见部门节点 id」列表（员工专用 scope 维度）。
 *
 * 部门节点（org_nodes.type='部门'）可挂 总部/市场/门店 下（不可嵌套，db/schema/org.ts
 * 层级约束）。职能部门员工 store_id IS NULL，靠本列表命中 scope 内部门节点纳入可见范围。
 *
 * - 总部 scope → 全部 type='部门' 节点
 * - 市场 scope → 挂该市场下的部门（市场级）+ 挂该市场下门店的部门（门店级）+ 该市场节点本身
 *   （覆盖 org_node_id 直接 = 市场节点的员工，如「品项公司」职能部门 / 市场级岗位，store_id IS NULL）
 * - 门店 scope → 挂该门店下的部门（scopeId 即门店 org_node id）
 * - 部门 scope → 忽略（与 expandScopeStoreIds 一致；permission_roles 生产无部门级 scope 角色）
 *
 * 仅员工表（staff_wechat_users.org_node_id）用到；orders/customers 等无此维度。
 */
export async function expandScopeDeptNodeIds(
  roles: AuthSession['roles'],
): Promise<string[]> {
  const deptIds = new Set<string>()

  for (const r of roles) {
    if (r.scopeType === '总部') {
      const all = await db.select({ id: orgNodes.id }).from(orgNodes)
        .where(eq(orgNodes.type, '部门'))
      for (const n of all) deptIds.add(n.id)
      return Array.from(deptIds) // 总部已含全部
    }

    if (r.scopeType === '市场') {
      // 该市场下的门店节点 id（覆盖「门店级部门」）
      const storeNodesUnder = await db.select({ id: orgNodes.id }).from(orgNodes)
        .where(and(eq(orgNodes.parentId, r.scopeId), eq(orgNodes.type, '门店')))
      const candidateParents = [r.scopeId, ...storeNodesUnder.map(n => n.id)]
      const depts = await db.select({ id: orgNodes.id }).from(orgNodes)
        .where(and(eq(orgNodes.type, '部门'), inArray(orgNodes.parentId, candidateParents)))
      for (const n of depts) deptIds.add(n.id)
      // 市场节点本身：org_node_id 直挂该市场的员工（品项公司/市场级岗位）纳入可见。
      // 与 buildEmployeeConditions 市场分支末项 eq(orgNodeId, marketId) 同口径。
      deptIds.add(r.scopeId)
    }

    if (r.scopeType === '门店') {
      const depts = await db.select({ id: orgNodes.id }).from(orgNodes)
        .where(and(eq(orgNodes.type, '部门'), eq(orgNodes.parentId, r.scopeId)))
      for (const n of depts) deptIds.add(n.id)
    }
  }

  return Array.from(deptIds)
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
 * 是否允许登录管理后台：持有任一非 staff 角色即可。
 *
 * staff（普通员工）专供小程序端，禁止进入 admin 后台。
 * 用于 actions/auth.ts 的登录闸（login 验密后）与会话二次闸（getSessionFromCookie）。
 * 仅看角色、不看权限点——即便某管理角色被配空矩阵，仍允许登录（避免误锁管理岗）。
 */
export function canAccessAdmin(roles: Array<{ role: string }>): boolean {
  return roles.some(r => r.role !== 'staff')
}

/**
 * 权限管理页操作者可操作的 scope 节点 id 集合
 *
 * - admin → null（全开，不置灰任何节点）
 * - 非 admin → 去重后的 session.roles[].scopeId
 *
 * 口径必须与 actions/permissions.ts 各 action 的 `userScopeIds`
 * （getRoles / getRolesByScope / getRoleCountsByScope / assignRole / revokeRole）
 * 完全一致：**精确 scopeId，不展开子树**。前端左侧组织树据此置灰其管辖外节点。
 */
export function accessiblePermissionScopeIds(session: AuthSession): string[] | null {
  if (isAdminScope(session)) return null
  return Array.from(new Set(session.roles.map(r => r.scopeId)))
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
 * 员工专用 scope 条件（store_id ∪ org_node_id 双维度）。
 *
 * - admin → undefined（不过滤）
 * - 非 admin → or(inArray(store_id, scopeStoreIds), inArray(org_node_id, scopeDeptNodeIds))
 *
 * 职能部门员工（养生部/推广部/品项公司…）store_id IS NULL，靠 org_node_id 命中 scope
 * 子树内的部门节点纳入；scopeDeptNodeIds 缺失/为空时退化为仅按 store_id 过滤（=旧行为，
 * 保守不暴露部门员工）。严格不越权：仅命中 scope 子树内的部门节点 + 该账号直属市场节点本身
 * （后者覆盖 org_node_id 直接挂市场的员工，见 expandScopeDeptNodeIds 市场分支）。
 *
 * 仅 staff_wechat_users 表用（唯一带 org_node_id 维度的业务表）；
 * orders/customers/services 继续用 scopeCondition(store_id)。
 */
export function employeeScopeCondition(
  session: AuthSession,
  storeIdColumn: PgColumn,
  orgNodeIdColumn: PgColumn,
): SQL | undefined {
  if (isAdminScope(session)) return undefined
  const storeIds = session.permissions.scopeStoreIds
  const deptIds = session.permissions.scopeDeptNodeIds ?? []
  const parts: SQL[] = []
  if (storeIds.length > 0) parts.push(inArray(storeIdColumn, storeIds) as SQL)
  if (deptIds.length > 0) parts.push(inArray(orgNodeIdColumn, deptIds) as SQL)
  if (parts.length === 0) return sql`FALSE`
  if (parts.length === 1) return parts[0]
  return or(...parts)
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
 * 寄存单审批硬规则。
 *
 * 权限矩阵只控制入口动作；总部限定不能只靠 sale_order:deposit_approve，
 * 因为 manager/finance 可存在市场或门店 scope。
 */
export function isDepositOrderApprover(session: AuthSession): boolean {
  return session.roles.some((role) => (
    role.role === 'admin' ||
    ((role.role === 'manager' || role.role === 'finance') && role.scopeType === '总部')
  ))
}

/**
 * 权限/认证错误：把错误类型写进 `digest`。
 *
 * 关键：Next.js 生产构建会脱敏 Server Component 抛出的 `error.message`
 * （客户端只剩通用文案），但**会原样转发开发者自设的 `error.digest`**。
 * 故 error.tsx 用 digest 判定 403/401，message 仅作 dev 兜底。
 */
export class PermissionError extends Error {
  readonly digest = 'PERMISSION_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

/**
 * 权限校验：检查当前 session 是否拥有指定 action
 *
 * 如果权限不足，抛出 PermissionError（digest='PERMISSION_DENIED'，由 error.tsx 渲染 403）
 */
export function requirePermission(session: AuthSession | null, action: string): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  if (!session.permissions.actions.includes(action)) {
    throw new PermissionError(`PERMISSION_DENIED: 无权执行 ${action}`)
  }
}

/**
 * 物理删除专属硬闸：仅系统管理员（admin 角色）可通过，不受权限矩阵 UI 支配。
 *
 * 用于所有物理删除（db.delete 真删）Server Action 的函数体首行——前置的
 * withPermission('xxx:delete', ...) 仍保留（满足 ESLint HOF 强制 + 纵深过滤），
 * 但真正的「仅系统管理员」判定由本函数以角色为准：即便运营在权限矩阵 UI 给其它
 * 角色勾上 :delete 点，物理删除也无法实际执行。isAdminScope 即 role==='admin'。
 */
export function requireAdmin(session: AuthSession | null): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  if (!isAdminScope(session)) {
    throw new PermissionError('PERMISSION_DENIED: 仅系统管理员可执行物理删除')
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
    throw new PermissionError(`PERMISSION_DENIED: 无权执行 ${actions.join(' 或 ')}`)
  }
}
