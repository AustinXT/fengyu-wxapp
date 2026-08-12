import type { RoleType } from './types'

/** 权限矩阵的完整角色集合，供运行时归一化和矩阵编辑器共用。 */
export const PERMISSION_MATRIX_ROLES = [
  'admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr', 'staff',
] as const satisfies readonly RoleType[]

export type PermissionMatrix = Record<RoleType, string[]>

/**
 * 已实现但尚未交付 Admin UI 的库存能力。
 *
 * 保留在 known actions 中是为了把遗留 DB 配置报告为“不可授予”，而不是误报为拼写错误；
 * 但不会出现在 DEFAULT / ALL_ACTIONS / 矩阵编辑器中，也不会发给任何运行时角色。
 */
export const UNDELIVERED_ADMIN_ACTIONS = [
  'inventory:update',
  'inventory:create_doc',
  'inventory:approve',
  'inventory:price_view',
] as const

/**
 * 这些动作即使 Server Action 另有权限点，也必须由 admin 角色持有。
 * 所有物理删除仍由后端 requireAdmin() 二次硬闸；这里消除矩阵里的死权限。
 */
export const ADMIN_ONLY_ACTIONS = [
  'store:lakala_config',
  'permission:assign_admin',
  'admin:reset_password',
] as const

export type ActionGrantability = 'grantable' | 'unknown' | 'admin_only' | 'undelivered'

/**
 * 可从 UI 触发某动作所需的同角色硬依赖。
 *
 * 这里只登记页面会无条件读取、且缺失后该动作没有可达 UI 的权限；筛选下拉等可降级
 * 的辅助读取不在此处建模。映射也供页面使用 hasUiCapability，防止自定义矩阵中按钮
 * 与直达页面再次漂移。
 */
export const UI_ACTION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'org:create': ['org:list'],
  'org:update': ['org:list'],
  'org:delete': ['org:list'],

  'store:update': ['store:list'],

  'employee:create': ['employee:list', 'org:list', 'store:list'],
  'employee:update': ['employee:list', 'org:list', 'store:list'],
  'employee:delete': ['employee:list'],

  'product:create': ['product:list'],
  'product:update': ['product:list'],

  'commission:create': ['commission:list', 'employee:list'],
  'commission:update': ['commission:list', 'employee:list'],
  'commission:delete': ['commission:list', 'employee:list'],

  'coupon:create': ['coupon:list'],
  'coupon:update': ['coupon:list'],

  'sale_order:create': ['employee:list', 'store:list'],
  'sale_order:update': ['sale_order:list'],
  'sale_order:record_payment': ['sale_order:list'],
  'sale_order:deposit_approve': ['sale_order:list'],
  'sale_order:delete': ['sale_order:list'],

  'allocation:save': ['allocation:list', 'employee:list', 'sale_order:list', 'service:list', 'store:list'],

  'service:create': ['employee:list', 'service:list', 'store:list'],
  'service:update': ['service:list'],
  'service:delete': ['service:list'],

  'appointment:confirm': ['appointment:list'],
  'appointment:checkin': ['appointment:list'],
  'appointment:delete': ['appointment:list'],

  'customer:create': ['customer:list'],
  'customer:update': ['customer:list'],
  'customer:delete': ['customer:list'],

  'pickup_record:create': ['pickup_record:list', 'store:list'],
  'pickup_record:delete': ['pickup_record:list'],

  'store_unbind:approve': ['store_unbind:list'],
  'store_unbind:reject': ['store_unbind:list'],
  'store_unbind:delete': ['store_unbind:list'],

  'permission:assign': ['employee:list', 'org:list', 'permission:list'],
  'permission:revoke': ['employee:list', 'org:list', 'permission:list'],
  'permission:assign_admin': ['employee:list', 'org:list', 'permission:list'],

  'operation_log:delete': ['operation_log:list'],
  'message:send': ['message:list'],
  'message:delete': ['message:list'],
  'admin:reset_password': ['employee:list'],

  'legacy_order:approve': ['legacy_order:list', 'store:list'],
  'legacy_order:reject': ['legacy_order:list', 'store:list'],
  'legacy_order:update_phone': ['legacy_order:list', 'store:list'],
  'legacy_order:update_amount': ['legacy_order:list', 'store:list'],
  'legacy_order:pull': ['legacy_order:list', 'store:list'],

  'inventory:create': ['inventory:list', 'store:list'],
  'inventory:delete': ['inventory:list'],
  'inventory:export': ['inventory:list'],

  'merchant:create': ['merchant:list'],
  'merchant:update': ['merchant:list'],
  'merchant:delete': ['merchant:list'],
}

function isAdminOnlyAction(action: string): boolean {
  return action.endsWith(':delete') || (ADMIN_ONLY_ACTIONS as readonly string[]).includes(action)
}

function isUndeliveredAction(action: string): boolean {
  return (UNDELIVERED_ADMIN_ACTIONS as readonly string[]).includes(action)
}

/** 返回动作对该角色的可授予状态。knownActions 必须包含未交付动作，以便正确诊断。 */
export function getActionGrantability(
  role: RoleType,
  action: string,
  knownActions: ReadonlySet<string>,
): ActionGrantability {
  if (!knownActions.has(action)) return 'unknown'
  if (isUndeliveredAction(action)) return 'undelivered'
  if (role !== 'admin' && isAdminOnlyAction(action)) return 'admin_only'
  return 'grantable'
}

export function isActionGrantable(
  role: RoleType,
  action: string,
  knownActions: ReadonlySet<string>,
): boolean {
  return getActionGrantability(role, action, knownActions) === 'grantable'
}

/**
 * 清洗单个角色定义中的历史权限。
 *
 * 角色定义允许自定义 roleKey，不能直接复用矩阵版的 `sanitizePermissionMatrix`；
 * 是否可持有管理员专属权限要以 `isSuperAdmin` 能力为准，而非 roleKey 名称。
 * 该函数只用于读取历史数据和兼容镜像，写入入口仍必须严格校验，避免客户端借机新增非法权限。
 */
export function sanitizeRoleDefinitionActions(
  actions: readonly unknown[],
  isSuperAdmin: boolean,
  knownActions: readonly string[],
): string[] {
  const known = new Set(knownActions)
  const grantRole: RoleType = isSuperAdmin ? 'admin' : 'staff'
  return [...new Set(
    actions
      .map((action) => (typeof action === 'string' ? action.trim() : ''))
      .filter(Boolean),
  )]
    .filter((action) => isActionGrantable(grantRole, action, known))
    .sort()
}

/** 补齐角色、去空白、去重、排序；不在此处过滤动作，供保存校验保留原始问题。 */
export function normalizePermissionMatrix(input: unknown): PermissionMatrix {
  const result: PermissionMatrix = {
    admin: [], manager: [], finance: [], hr: [], product: [], customer_mgr: [], staff: [],
  }
  if (!input || typeof input !== 'object') return result

  const source = input as Record<string, unknown>
  for (const role of PERMISSION_MATRIX_ROLES) {
    const actions = source[role]
    if (!Array.isArray(actions)) continue
    result[role] = [...new Set(
      actions
        .map((action) => (typeof action === 'string' ? action.trim() : ''))
        .filter(Boolean),
    )].sort()
  }
  return result
}

/** 读取遗留 DB 矩阵时使用：未知、不可授予和未交付动作都不会进入运行时 session。 */
export function sanitizePermissionMatrix(
  input: unknown,
  knownActions: readonly string[],
): PermissionMatrix {
  const known = new Set(knownActions)
  const normalized = normalizePermissionMatrix(input)
  const result = normalizePermissionMatrix(null)

  for (const role of PERMISSION_MATRIX_ROLES) {
    result[role] = normalized[role].filter((action) => isActionGrantable(role, action, known))
  }
  return result
}

export type MatrixValidationIssue =
  | { kind: 'unknown_action'; role: RoleType; action: string }
  | { kind: 'not_grantable'; role: RoleType; action: string; grantability: 'admin_only' | 'undelivered' }
  | { kind: 'missing_ui_dependency'; role: RoleType; action: string; missing: string[] }

export interface MatrixValidationResult {
  matrix: PermissionMatrix
  issues: MatrixValidationIssue[]
}

/** 返回某动作在给定动作集中的缺失 UI 依赖。 */
export function getMissingUiDependencies(actions: readonly string[], action: string): string[] {
  const owned = new Set(actions)
  return (UI_ACTION_DEPENDENCIES[action] ?? []).filter((dependency) => !owned.has(dependency))
}

/** 页面按钮和可提交表单使用的能力检查：动作本身及其 UI 硬依赖均须存在。 */
export function hasUiCapability(actions: readonly string[], action: string): boolean {
  return actions.includes(action) && getMissingUiDependencies(actions, action).length === 0
}

/**
 * 保存前严格校验矩阵。
 *
 * 与 sanitize 的职责不同：sanitize 为兼容历史数据静默收口；本函数保留全部问题并拒绝写入，
 * 防止管理员误以为勾选已经生效。
 */
export function validatePermissionMatrix(
  input: unknown,
  knownActions: readonly string[],
): MatrixValidationResult {
  const known = new Set(knownActions)
  const matrix = normalizePermissionMatrix(input)
  const issues: MatrixValidationIssue[] = []

  for (const role of PERMISSION_MATRIX_ROLES) {
    for (const action of matrix[role]) {
      const grantability = getActionGrantability(role, action, known)
      if (grantability === 'unknown') {
        issues.push({ kind: 'unknown_action', role, action })
        continue
      }
      if (grantability !== 'grantable') {
        issues.push({ kind: 'not_grantable', role, action, grantability })
        continue
      }

      const missing = getMissingUiDependencies(matrix[role], action)
      if (missing.length > 0) {
        issues.push({ kind: 'missing_ui_dependency', role, action, missing })
      }
    }
  }

  return { matrix, issues }
}

/** 将校验问题压缩为可直接返回给矩阵编辑器的中文信息。 */
export function formatMatrixValidationIssues(issues: readonly MatrixValidationIssue[]): string {
  return issues.map((issue) => {
    if (issue.kind === 'unknown_action') {
      return `${issue.role}.${issue.action} 不是已知权限项`
    }
    if (issue.kind === 'not_grantable') {
      const reason = issue.grantability === 'admin_only' ? '仅系统管理员可授予' : '暂未交付 Admin UI，不能授予'
      return `${issue.role}.${issue.action} ${reason}`
    }
    return `${issue.role}.${issue.action} 缺少页面依赖：${issue.missing.join('、')}`
  }).join('；')
}
