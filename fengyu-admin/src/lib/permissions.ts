import { redirect } from 'next/navigation'
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { permissionRoleDefinitions } from '@db/permission'
import { eq, and, or, sql, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { AuthSession, RoleType } from './types'
import { collectDescendantNodeIds, findAncestorNodeIdByType } from './org-scope'
import {
  KNOWN_PERMISSION_ACTIONS as CATALOG_ACTIONS,
  sanitizeRoleDefinitionActions,
} from './permission-contract'
// isAdminScope 实现在 session-role-guards.ts（client 组件经 menu.ts 引用，不得拖入 @/db）。
// 对外再导出必须用 export-from：vitest SSR 对 import X + export { X } 间接再导出会得到
// undefined 绑定（2026-09-01 business.test.ts 18 用例失败根因）；import 仅供本文件内部使用。
import { isAdminScope } from './session-role-guards'
export { isAdminScope } from './session-role-guards'

/** 权限目录是唯一真相源；管理员默认持有目录中的全部权限。 */
export const ALL_ACTIONS: string[] = [...CATALOG_ACTIONS]
export const KNOWN_PERMISSION_ACTIONS: string[] = [...CATALOG_ACTIONS]

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
  // 新增权限只登记目录，admin 自动同步拥有，无需手工维护第二份列表。
  admin: [...ALL_ACTIONS],
  // 店长：门店业务的非物理删除操作。物理删除和收款配置仅系统管理员可授予。
  manager: [
    'allocation:list', 'allocation:save',
    'appointment:checkin', 'appointment:confirm', 'appointment:list',
    'card_transaction:list',
    'coupon:list',
    'customer:create', 'customer:list', 'customer:update',
    'dashboard:view',
    'data_center:dashboard',
    'employee:create', 'employee:list', 'employee:update',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:list',
    'message:list', 'message:send',
    'operation_log:list',
    'org:list',
    'pickup_record:create', 'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:create', 'sale_order:deposit_approve', 'sale_order:list', 'sale_order:performance_attribution_update', 'sale_order:record_payment', 'sale_order:refund_approve', 'sale_order:refund_create', 'sale_order:update',
    'service:create', 'service:list', 'service:update',
    'store:list',
    'store_unbind:approve', 'store_unbind:list', 'store_unbind:reject',
  ],
  // 财务：提成矩阵维护、历史订单核对与商户档案维护；物理删除仅系统管理员可授予。
  // 相对历史默认的扩权：commission:* 全 CRUD（提成矩阵）、coupon:list、
  // legacy_order 核对四项（approve/reject/update_amount/update_phone）、product:list、operation_log:list。
  // service:list — 营业额分配页含服务提成部分，finance 只读对账需看全。商户档案 /merchants 完整 CRUD。
  finance: [
    'allocation:list',
    'card_transaction:list',
    'commission:create', 'commission:list', 'commission:update',
    'coupon:list',
    'customer:list',
    'dashboard:view',
    'data_center:dashboard',
    'employee:list',
    'legacy_order:approve', 'legacy_order:list', 'legacy_order:pull', 'legacy_order:reject', 'legacy_order:update_amount', 'legacy_order:update_phone',
    'merchant:create', 'merchant:list', 'merchant:update',
    'operation_log:list',
    'org:list',
    'pickup_record:list',
    'point_transaction:list',
    'product:list',
    'sale_item:list',
    'sale_order:deposit_approve', 'sale_order:list', 'sale_order:performance_attribution_update', 'sale_order:record_payment', 'sale_order:refund_create',
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
  // 2026-06-24 对齐生产实配。库存仅保留已交付的创建/查看/导出能力；
  // sale_order:list、operation_log:list。
  product: [
    'coupon:create', 'coupon:list', 'coupon:update',
    'dashboard:view',
    'operation_log:list',
    'org:list',
    'product:create', 'product:list', 'product:update',
    'sale_order:list', 'sale_order:refund_create',
    'store:list',
  ],
  // 2026-06-24 对齐生产实配。预约、顾客等物理删除仅系统管理员可授予。
  // inventory:list、legacy_order 核对四项、pickup_record:list、product:list、operation_log:list。
  customer_mgr: [
    'appointment:checkin', 'appointment:confirm', 'appointment:list',
    'customer:create', 'customer:list', 'customer:update',
    'dashboard:view',
    'employee:list',
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
  inventory_supply_chain_operator: [
    'inventory:export', 'inventory:list', 'inventory:shipment_cancel_approve',
    'inventory:stock_list', 'inventory:supply_chain_approve',
    'inventory:supply_chain_master_data_manage', 'inventory:supply_chain_operate',
    'inventory:supply_chain_price_view',
  ],
  inventory_market_finance: [
    'inventory:export', 'inventory:list', 'inventory:market_approve',
    'inventory:market_operate', 'inventory:market_price_view',
    'inventory:market_sku_manage', 'inventory:self_purchase_receive',
    'inventory:shipment_cancel_request', 'inventory:stock_list',
  ],
  inventory_store_operator: [
    'inventory:list', 'inventory:stock_list', 'inventory:store_operate',
  ],
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
 * 取当前生效的权限矩阵：角色定义表优先，失败时回退旧角色默认值。
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
    const rows = await db
      .select({
        roleKey: permissionRoleDefinitions.roleKey,
        actions: permissionRoleDefinitions.actions,
        isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
      })
      .from(permissionRoleDefinitions)
    if (rows.length === 0) {
      _matrixCache = { matrix: DEFAULT_PERMISSION_MATRIX, expiresAt: now + PERMISSION_MATRIX_CACHE_TTL_MS }
      return DEFAULT_PERMISSION_MATRIX
    }
    const matrix: Record<RoleType, string[]> = {}
    for (const row of rows) {
      matrix[row.roleKey] = sanitizeRoleDefinitionActions(
        row.actions,
        row.isSuperAdmin,
        KNOWN_PERMISSION_ACTIONS,
      )
    }
    _matrixCache = { matrix, expiresAt: now + PERMISSION_MATRIX_CACHE_TTL_MS }
    return matrix
  } catch (dbErr) {
    console.error('[role-definitions] DB read failed, fallback to legacy defaults', dbErr)
    return DEFAULT_PERMISSION_MATRIX
  }
}

/**
 * 根据角色数组计算合并后的 actions 集合
 *
 * 2026-05-18 起异步：从 getPermissionMatrix() 读取 DB 矩阵（含 30s 缓存 + DEFAULT fallback）。
 * 调用方仅 actions/auth.ts:getSessionFromCookie（已 async），无 edge runtime 触发面。
 */
export async function computeRoleActions(
  roles: Array<{ role: RoleType }>,
): Promise<string[][]> {
  const matrix = await getPermissionMatrix()
  return roles.map(({ role }) => [...(matrix[role] ?? [])])
}

export async function computeActions(roles: Array<{ role: RoleType }>): Promise<string[]> {
  const roleActions = await computeRoleActions(roles)
  const actionSet = new Set<string>()
  for (const actions of roleActions) {
    for (const action of actions) actionSet.add(action)
  }
  return Array.from(actionSet)
}

export interface ExpandedScope {
  orgNodeIds: string[]
  storeIds: string[]
}

export interface ExpandedRoleScope {
  /** 角色根节点自身及所有后代组织节点。 */
  orgNodeIds: string[]
  /** 后代组织节点关联的门店；总部额外覆盖历史无 org_node_id 门店。 */
  storeIds: string[]
  /** 与传入 roles 下标一一对应，供按动作过滤角色 scope。 */
  roleScopes: ExpandedScope[]
}

/**
 * 一次加载组织树，按“自身 + 任意层级后代”展开角色范围。
 *
 * 不能以 `parent_id = scopeId` 代替：市场下可能继续出现组织节点，且部门、市场级岗位
 * 的员工记录依赖 org_node_id 维度。总部继续保留全部门店（含历史未挂组织节点的门店）语义。
 */
export async function expandRoleScope(
  roles: AuthSession['roles'],
): Promise<ExpandedRoleScope> {
  if (roles.length === 0) return { orgNodeIds: [], storeIds: [], roleScopes: [] }

  const [nodes, storeRows] = await Promise.all([
    db.select({ id: orgNodes.id, parentId: orgNodes.parentId, type: orgNodes.type }).from(orgNodes),
    db.select({ storeId: stores.storeId, orgNodeId: stores.orgNodeId }).from(stores),
  ])

  const roleScopes = roles.map((role): ExpandedScope => {
    const orgNodeIds = role.scopeType === '总部'
      ? nodes.map((node) => node.id)
      : collectDescendantNodeIds(nodes, [role.scopeId])
    const visibleNodeIds = new Set(orgNodeIds)
    const storeIds = role.scopeType === '总部'
      ? storeRows.map((store) => store.storeId)
      : storeRows
        .filter((store) => store.orgNodeId && visibleNodeIds.has(store.orgNodeId))
        .map((store) => store.storeId)
    return { orgNodeIds, storeIds }
  })

  const orgNodeIds = Array.from(new Set(roleScopes.flatMap((scope) => scope.orgNodeIds)))
  const storeIds = Array.from(new Set(roleScopes.flatMap((scope) => scope.storeIds)))

  return {
    orgNodeIds,
    storeIds,
    roleScopes,
  }
}

/** 根据角色 scope 展开可见门店，保留既有公开 API。 */
export async function expandScopeStoreIds(roles: AuthSession['roles']): Promise<string[]> {
  return (await expandRoleScope(roles)).storeIds
}

/** 根据角色 scope 展开可见组织节点（包含根节点与所有后代）。 */
export async function expandScopeOrgNodeIds(roles: AuthSession['roles']): Promise<string[]> {
  return (await expandRoleScope(roles)).orgNodeIds
}

/**
 * 兼容旧调用方。员工范围应使用 expandScopeOrgNodeIds / scopeOrgNodeIds；
 * 这个别名在下一个兼容窗口结束前保留，返回范围不再只限部门节点。
 */
export async function expandScopeDeptNodeIds(roles: AuthSession['roles']): Promise<string[]> {
  return expandScopeOrgNodeIds(roles)
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

  const nodes = await db
    .select({ id: orgNodes.id, parentId: orgNodes.parentId, type: orgNodes.type })
    .from(orgNodes)
  const scopeIds = session.permissions.scopeOrgNodeIds
    ?? collectDescendantNodeIds(nodes, session.roles.map((role) => role.scopeId))
  const scopeSet = new Set(scopeIds)
  const marketIds = new Set(
    nodes.filter((node) => node.type === '市场' && scopeSet.has(node.id)).map((node) => node.id),
  )

  // 门店级绑定仍需要显示其所属市场；查找不限层级，防止未来树加中间节点后失效。
  for (const role of session.roles) {
    const marketId = findAncestorNodeIdByType(nodes, role.scopeId, '市场')
    if (marketId) marketIds.add(marketId)
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
 * 判断 session 是否拥有 admin 角色（不受 scope 限制）。
 * 实现移至 session-role-guards.ts（client 组件经 menu.ts 引用，不得拖入 @/db）；
 * re-export 见文件顶部 import 区，server 调用方与 vi.mock('@/lib/permissions') 关系不变。
 */

/**
 * 是否允许登录管理后台：持有任一非 staff 角色即可。
 *
 * staff（普通员工）专供小程序端，禁止进入 admin 后台。
 * 用于 actions/auth.ts 的登录闸（login 验密后）与会话二次闸（getSessionFromCookie）。
 * 仅看角色、不看权限点——即便某管理角色被配空矩阵，仍允许登录（避免误锁管理岗）。
 */
export function canAccessAdmin(roles: Array<{ role: string; canAccessAdmin?: boolean }>): boolean {
  return roles.some(r => r.canAccessAdmin ?? r.role !== 'staff')
}

/**
 * 权限管理页操作者可操作的 scope 节点 id 集合
 *
 * - admin → null（全开，不置灰任何节点）
 * - 非 admin → 角色根节点自身及全部后代节点
 *
 * 口径必须与 actions/permissions.ts 各 action 的 `userScopeIds`
 * （getRoles / getRolesByScope / getRoleCountsByScope / assignRole / revokeRole）
 * 完全一致。前端左侧组织树据此置灰其管辖外节点。
 */
export function accessiblePermissionScopeIds(session: AuthSession): string[] | null {
  if (isAdminScope(session)) return null
  return Array.from(new Set(
    session.permissions.scopeOrgNodeIds ?? session.roles.map((role) => role.scopeId),
  ))
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
 * - 非 admin → or(inArray(store_id, scopeStoreIds), inArray(org_node_id, scopeOrgNodeIds))
 *
 * 职能部门员工（养生部/推广部/品项公司…）store_id IS NULL，靠 org_node_id 命中 scope
 * scopeOrgNodeIds 包含绑定节点自身及其任意层级后代。旧会话的 scopeDeptNodeIds 仅作
 * 兼容回退；缺失时退化为仅按 store_id 过滤，避免临时会话扩大可见范围。
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
  const orgNodeIds = session.permissions.scopeOrgNodeIds
    ?? session.permissions.scopeDeptNodeIds
    ?? []
  const parts: SQL[] = []
  if (storeIds.length > 0) parts.push(inArray(storeIdColumn, storeIds) as SQL)
  if (orgNodeIds.length > 0) parts.push(inArray(orgNodeIdColumn, orgNodeIds) as SQL)
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
 * 检查指定组织节点是否在用户 scope 内（`isInScope` 的 org_node_id 对偶）
 *
 * admin → 始终 true。
 *
 * **口径必须与 `employeeScopeCondition` 的 orgNodeIds 完全一致**（含 `scopeDeptNodeIds`
 * 旧会话回退）—— 二者一个负责「入参新值是否可写」、一个负责「目标行是否可见」，
 * 口径一旦分叉就会出现「校验放行但 UPDATE 的 WHERE 匹配不到」或反之的静默错位。
 *
 * ⚠️ 不要与库存侧的 `inventoryScopedOrgNodeIds` / `assertOrgNodeVisible` 混用：那一套对
 * 「总部」scope **刻意不展开后代**（市场退货必须由总部逐个授权审批），而这里的
 * `scopeOrgNodeIds` 是含全部后代的展开集合。两套语义不同，各自服务不同的业务约束。
 *
 * ⚠️ 另有 `lib/node-scope.ts` 的 `isNodeInScope`（org.ts 建/改节点、stores.ts 建门店在用）
 * 与本函数前两级回退完全相同，**只有第三级不同**：它在两个集合都缺失时回退到
 * `session.roles.map(r => r.scopeId)`（角色根节点自身），本函数回退到空集。
 * 这不是疏忽，**恰恰是不能复用它的原因** —— 本函数与 `employeeScopeCondition` 服务于
 * 同一次 `updateEmployee` 调用（一个判新值可否写入、一个拼进 UPDATE 的 WHERE），
 * 而 `employeeScopeCondition` 的回退就是空集。改用 `isNodeInScope` 会在缺元数据的会话里
 * 造出「校验放行 → UPDATE 命中 0 行 → 用户看到『员工不存在或无权修改』」的静默错位。
 * 两者该不该统一（以及统一到哪一档）是独立议题，已另开 issue。
 */
export function isOrgNodeInScope(session: AuthSession, orgNodeId: string): boolean {
  if (isAdminScope(session)) return true
  const orgNodeIds = session.permissions.scopeOrgNodeIds
    ?? session.permissions.scopeDeptNodeIds
    ?? []
  return orgNodeIds.includes(orgNodeId)
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
 * 权限矩阵控制入口动作；审批人可为任一业务组织层级的店长或财务。
 * 具体订单仍由调用方按 store_id 做 isInScope 行级校验。
 */
export function isDepositOrderApprover(session: AuthSession): boolean {
  return hasPermission(session, 'sale_order:deposit_approve')
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
 * 仅超级管理员硬闸（生产判据是角色行的 `isSuperAdmin=true`，不是 `role === 'admin'`）。
 *
 * 用于两类 Server Action 的函数体首行：
 * ① 所有物理删除（db.delete 真删）；
 * ② 不可授权给其它角色的敏感写操作——角色能力位变更（role-definitions）、
 *    提成口径类字典（skill-tags 技能标签，见 #211）等。
 *
 * 前置的 withPermission('xxx:delete' / 'xxx:update', ...) 仍保留（满足 ESLint HOF
 * 强制 + 纵深过滤），但真正的判定由本函数以角色为准：即便运营在权限矩阵 UI 给其它
 * 角色勾上对应权限点，这些操作也无法实际执行。
 *
 * ⚠️ 两点容易误解，写方案前先看清：
 * ① `isAdminScope` 判的是 `isSuperAdmin ?? role === 'admin'`。`permission_roles.is_super_admin`
 *    是 notNull 列，生产会话恒为 boolean，故 `role === 'admin'` 只是旧会话/测试的兼容回退；
 *    显式 `isSuperAdmin=false` 的 admin 角色行会被拦下。
 * ② 本函数收到的 session 通常已被 `withPermission` 经 `scopeSessionToActions` 按外层 action
 *    收紧（只留自身 actions 含该动作的角色行）。所以实际语义是「**授予该 action 的角色里
 *    至少一个是超管**」，而非「会话里任意位置有超管角色」。当外层 action 属
 *    ADMIN_ONLY_ACTIONS 时两者等价；用共享 action（如 employee:update）时不等价 ——
 *    UI 侧复刻判定必须一并跑 scopeSessionToActions，见 `skill-tag-access.ts`。
 */
export function requireAdmin(session: AuthSession | null): asserts session is AuthSession {
  if (!session) {
    redirect('/login?expired=1')
  }
  if (!isAdminScope(session)) {
    throw new PermissionError('PERMISSION_DENIED: 仅系统管理员可执行该操作')
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
