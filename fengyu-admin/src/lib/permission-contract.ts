import type { RoleType } from './types'
import { PERMISSION_ACTION_CATALOG } from './permission-presentation'

/** 权限矩阵的完整角色集合，供运行时归一化和矩阵编辑器共用。 */
export const PERMISSION_MATRIX_ROLES = [
  'admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr', 'staff',
] as const satisfies readonly RoleType[]

export type PermissionMatrix = Record<RoleType, string[]>

/** 所有可被角色编辑器授予的权限；不再维护“已实现但不可配置”的隐藏权限。 */
export const KNOWN_PERMISSION_ACTIONS = Object.keys(PERMISSION_ACTION_CATALOG.labels).sort()
export const ADMIN_ONLY_ACTIONS: readonly string[] = [...PERMISSION_ACTION_CATALOG.adminOnly]
export const UI_ACTION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = PERMISSION_ACTION_CATALOG.dependencies

export type ActionGrantability = 'grantable' | 'unknown' | 'admin_only'

function isAdminOnlyAction(action: string): boolean {
  return ADMIN_ONLY_ACTIONS.includes(action)
}

export function getActionGrantability(
  role: RoleType,
  action: string,
  knownActions: ReadonlySet<string> = new Set(KNOWN_PERMISSION_ACTIONS),
): ActionGrantability {
  if (!knownActions.has(action)) return 'unknown'
  if (role !== 'admin' && isAdminOnlyAction(action)) return 'admin_only'
  return 'grantable'
}

export function isActionGrantable(
  role: RoleType,
  action: string,
  knownActions: ReadonlySet<string> = new Set(KNOWN_PERMISSION_ACTIONS),
): boolean {
  return getActionGrantability(role, action, knownActions) === 'grantable'
}

/** 自定义角色的可授予判断以高级能力而非 role_key 为准。 */
export function isActionGrantableForRoleDefinition(action: string, isSuperAdmin: boolean): boolean {
  return KNOWN_PERMISSION_ACTIONS.includes(action) && (isSuperAdmin || !isAdminOnlyAction(action))
}

function collectDependencies(action: string, result: Set<string>, visiting: Set<string>): void {
  if (visiting.has(action)) return
  visiting.add(action)
  for (const dependency of UI_ACTION_DEPENDENCIES[action] ?? []) {
    if (!result.has(dependency)) {
      result.add(dependency)
      collectDependencies(dependency, result, visiting)
    }
  }
  visiting.delete(action)
}

/** 返回某操作的递归 UI 前置权限，不包含操作本身。 */
export function getUiDependencyClosure(action: string): string[] {
  const dependencies = new Set<string>()
  collectDependencies(action, dependencies, new Set<string>())
  return [...dependencies].sort()
}

/** 勾选操作时连同递归前置权限一并补齐。 */
export function addActionWithUiDependencies(actions: readonly string[], action: string): string[] {
  return [...new Set([...actions, action, ...getUiDependencyClosure(action)])].sort()
}

/** 取消前置权限时，连同所有直接或间接依赖它的操作一并撤销。 */
export function removeActionWithDependents(actions: readonly string[], action: string): string[] {
  return actions
    .filter((candidate) => candidate !== action && !getUiDependencyClosure(candidate).includes(action))
    .sort()
}

/** 返回动作在给定动作集中的缺失 UI 依赖（包含递归依赖）。 */
export function getMissingUiDependencies(actions: readonly string[], action: string): string[] {
  const owned = new Set(actions)
  return getUiDependencyClosure(action).filter((dependency) => !owned.has(dependency))
}

/** 页面按钮和可提交表单使用的能力检查：动作本身及其 UI 硬依赖均须存在。 */
export function hasUiCapability(actions: readonly string[], action: string): boolean {
  return actions.includes(action) && getMissingUiDependencies(actions, action).length === 0
}

/** 页面同时依赖多项 Server Action 时使用（AND 关系）。 */
export function hasAllUiCapabilities(actions: readonly string[], required: readonly string[]): boolean {
  return required.every((action) => hasUiCapability(actions, action))
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
    result[role] = [...new Set(actions.map((action) => typeof action === 'string' ? action.trim() : '').filter(Boolean))].sort()
  }
  return result
}

/** 读取旧矩阵时清除未知及不可授予权限，避免将历史脏数据下发进 session。 */
export function sanitizePermissionMatrix(input: unknown, knownActions: readonly string[] = KNOWN_PERMISSION_ACTIONS): PermissionMatrix {
  const known = new Set(knownActions)
  const normalized = normalizePermissionMatrix(input)
  const result = normalizePermissionMatrix(null)
  for (const role of PERMISSION_MATRIX_ROLES) {
    result[role] = normalized[role].filter((action) => isActionGrantable(role, action, known))
  }
  return result
}

/** 角色定义使用高级能力判断管理员专属项，供运行时与编辑页读取历史数据时收口。 */
export function sanitizeRoleDefinitionActions(
  actions: readonly unknown[],
  isSuperAdmin: boolean,
  knownActions: readonly string[] = KNOWN_PERMISSION_ACTIONS,
): string[] {
  const known = new Set(knownActions)
  return [...new Set(actions.map((action) => typeof action === 'string' ? action.trim() : '').filter(Boolean))]
    .filter((action) => known.has(action) && (isSuperAdmin || !isAdminOnlyAction(action)))
    .sort()
}

export type MatrixValidationIssue =
  | { kind: 'unknown_action'; role: RoleType; action: string }
  | { kind: 'not_grantable'; role: RoleType; action: string; grantability: 'admin_only' }
  | { kind: 'missing_ui_dependency'; role: RoleType; action: string; missing: string[] }

export interface MatrixValidationResult { matrix: PermissionMatrix; issues: MatrixValidationIssue[] }

/** 保存前严格校验，客户端自动补齐仅改善交互，不能代替服务端权限边界。 */
export function validatePermissionMatrix(input: unknown, knownActions: readonly string[] = KNOWN_PERMISSION_ACTIONS): MatrixValidationResult {
  const known = new Set(knownActions)
  const matrix = normalizePermissionMatrix(input)
  const issues: MatrixValidationIssue[] = []
  for (const role of PERMISSION_MATRIX_ROLES) {
    for (const action of matrix[role]) {
      const grantability = getActionGrantability(role, action, known)
      if (grantability === 'unknown') issues.push({ kind: 'unknown_action', role, action })
      else if (grantability !== 'grantable') issues.push({ kind: 'not_grantable', role, action, grantability })
      else {
        const missing = getMissingUiDependencies(matrix[role], action)
        if (missing.length > 0) issues.push({ kind: 'missing_ui_dependency', role, action, missing })
      }
    }
  }
  return { matrix, issues }
}

export function formatMatrixValidationIssues(issues: readonly MatrixValidationIssue[]): string {
  return issues.map((issue) => {
    if (issue.kind === 'unknown_action') return `${issue.role}.${issue.action} 不是已知权限项`
    if (issue.kind === 'not_grantable') return `${issue.role}.${issue.action} 仅系统管理员可授予`
    return `${issue.role}.${issue.action} 缺少页面依赖：${issue.missing.join('、')}`
  }).join('；')
}
