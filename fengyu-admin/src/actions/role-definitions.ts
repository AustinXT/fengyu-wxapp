'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { withAnyPermission, withPermission } from '@/lib/with-permission'
import { requireAdmin, invalidatePermissionMatrixCache, KNOWN_PERMISSION_ACTIONS } from '@/lib/permissions'
import {
  getMissingUiDependencies,
  isActionGrantableForRoleDefinition,
  sanitizeRoleDefinitionActions,
} from '@/lib/permission-contract'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
// 取锁顺序（组织树 → admin 计数 → 行锁）见该模块顶部（#318）
import { lockActiveAdminCount } from '@/lib/invariant-locks'
import { countActiveAdmins } from '@/lib/admin-guard'
import type { RoleDefinition } from '@/lib/types'

const SUPER_ADMIN_REQUIRED_ACTIONS = [
  'system:config',
  'system:diagnostics',
  'permission:assign_admin',
  'admin:reset_password',
] as const

/**
 * 角色列表按职责与权限范围展示，而不是按数据的创建时间展示。
 *
 * 自定义角色排在内置角色之后，仍保留其创建时间和名称作为稳定的次级排序。
 */
const ROLE_DISPLAY_PRIORITY = sql`
  CASE
    WHEN ${permissionRoleDefinitions.roleKey} = 'admin' THEN 0
    WHEN ${permissionRoleDefinitions.isSuperAdmin} = true THEN 1
    WHEN ${permissionRoleDefinitions.roleKey} = 'manager' THEN 10
    WHEN ${permissionRoleDefinitions.roleKey} = 'finance' THEN 20
    WHEN ${permissionRoleDefinitions.roleKey} = 'hr' THEN 30
    WHEN ${permissionRoleDefinitions.roleKey} = 'product' THEN 40
    WHEN ${permissionRoleDefinitions.roleKey} = 'customer_mgr' THEN 50
    WHEN ${permissionRoleDefinitions.roleKey} = 'staff' THEN 60
    ELSE 100
  END
`

export interface RoleDefinitionInput {
  name: string
  description?: string | null
  actions?: string[]
  allowedScopeTypes?: Array<'总部' | '市场' | '门店'>
  copyFromRoleKey?: string | null
  canAccessAdmin?: boolean
  isSuperAdmin?: boolean
  isStoreManager?: boolean
  expectedUpdatedAt?: string
}

const INVENTORY_TIER_ACTIONS = {
  总部: [
    'inventory:supply_chain_operate', 'inventory:supply_chain_approve',
    'inventory:supply_chain_price_view', 'inventory:supply_chain_master_data_manage',
    'inventory:shipment_cancel_approve',
  ],
  市场: [
    'inventory:market_operate', 'inventory:market_approve', 'inventory:market_price_view',
    'inventory:market_sku_manage', 'inventory:self_purchase_receive',
    'inventory:shipment_cancel_request',
  ],
  门店: ['inventory:store_operate'],
} as const

function normalizeAllowedScopeTypes(
  value: readonly string[] | undefined,
  actions: readonly string[],
  isSuperAdmin: boolean,
): Array<'总部' | '市场' | '门店'> {
  if (isSuperAdmin) return ['总部']
  const valid = new Set(['总部', '市场', '门店'])
  const normalized = [...new Set(value ?? ['总部', '市场', '门店'])]
  if (normalized.length === 0 || normalized.some((item) => !valid.has(item))) {
    throw new Error('INVALID_PARAMS: 角色至少需要一个有效的可绑定层级')
  }
  const tiers = (Object.entries(INVENTORY_TIER_ACTIONS) as Array<[
    '总部' | '市场' | '门店', readonly string[],
  ]>).filter(([, tierActions]) => tierActions.some((action) => actions.includes(action)))
  if (tiers.length > 1) throw new Error('INVALID_PARAMS: 普通角色不能混合多个进销存层级动作')
  if (tiers.length === 1) return [tiers[0][0]]
  return normalized as Array<'总部' | '市场' | '门店'>
}

function normalizeName(value: string): string {
  const name = String(value || '').trim()
  if (!name) throw new Error('INVALID_PARAMS: 请输入角色名称')
  if (name.length > 30) throw new Error('INVALID_PARAMS: 角色名称不能超过 30 个字')
  return name
}

function normalizeDescription(value?: string | null): string | null {
  const description = String(value || '').trim()
  if (description.length > 200) throw new Error('INVALID_PARAMS: 角色说明不能超过 200 个字')
  return description || null
}

function normalizeActions(actions: readonly string[], isSuperAdmin: boolean): string[] {
  const known = new Set(KNOWN_PERMISSION_ACTIONS)
  const normalized = [...new Set(actions.map((action) => String(action).trim()).filter(Boolean))].sort()
  const unknown = normalized.find((action) => !known.has(action))
  if (unknown) throw new Error(`INVALID_PARAMS: 未知权限项 ${unknown}`)

  const notGrantable = normalized.find((action) => !isActionGrantableForRoleDefinition(action, isSuperAdmin))
  if (notGrantable) {
    throw new Error(`INVALID_PARAMS: ${notGrantable} 仅超级管理员角色可持有`)
  }

  for (const action of normalized) {
    const missing = getMissingUiDependencies(normalized, action)
    if (missing.length > 0) {
      throw new Error(`INVALID_PARAMS: ${action} 缺少页面依赖：${missing.join('、')}`)
    }
  }

  if (isSuperAdmin) {
    for (const action of SUPER_ADMIN_REQUIRED_ACTIONS) {
      if (!normalized.includes(action)) {
        throw new Error(`INVALID_PARAMS: 超级管理员角色必须保留 ${action}`)
      }
    }
  }
  return normalized
}

/**
 * 复核存量分配与层级白名单的冲突：permission_roles 的 DB 触发器只在分配行自身
 * INSERT/UPDATE 时校验 scope 节点类型，编辑角色定义（收窄 allowedScopeTypes 或
 * 加入进销存层级动作触发 normalize 收敛）不会触发复核；staffApi 鉴权也不读
 * allowed_scope_types，矛盾分配会在小程序端持续生效。因此创建/升级/编辑前按
 * 目标层级集合检查存量分配，有冲突先拒绝（口径同 0039 迁移期 DO 守卫）。
 * 超级管理员绕过数据 scope，只允许绑定总部节点，等价于白名单 ['总部']。
 */
async function hasConflictingScopeAssignment(
  roleKey: string,
  allowedScopeTypes: readonly ('总部' | '市场' | '门店')[],
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1
      FROM permission_roles pr
      JOIN org_nodes node ON node.id = pr.scope_id
     WHERE pr.role = ${roleKey}
       AND NOT (node.type = ANY(${allowedScopeTypes}::text[]))
     LIMIT 1
  `)
  return (rows as unknown as unknown[]).length > 0
}

async function writeCompatibilityMirror(tx: any): Promise<void> {
  const rows = await tx
    .select({
      roleKey: permissionRoleDefinitions.roleKey,
      actions: permissionRoleDefinitions.actions,
      isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
    })
    .from(permissionRoleDefinitions)
  const matrix = Object.fromEntries(rows.map((row: {
    roleKey: string
    actions: string[]
    isSuperAdmin: boolean
  }) => [
    row.roleKey,
    sanitizeRoleDefinitionActions(row.actions, row.isSuperAdmin, KNOWN_PERMISSION_ACTIONS),
  ]))
  const value = JSON.stringify(matrix)
  await tx.execute(sql`
    INSERT INTO system_configs (key, value, updated_at)
    VALUES ('permission_matrix', ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
  `)
}

function serialize(row: {
  roleKey: string
  name: string
  description: string | null
  actions: string[]
  allowedScopeTypes: string[]
  canAccessAdmin: boolean
  isSuperAdmin: boolean
  isStoreManager: boolean
  assignmentCount: number
  createdAt: Date
  updatedAt: Date
}): RoleDefinition {
  return {
    ...row,
    actions: sanitizeRoleDefinitionActions(row.actions, row.isSuperAdmin, KNOWN_PERMISSION_ACTIONS),
    allowedScopeTypes: row.allowedScopeTypes as Array<'总部' | '市场' | '门店'>,
    assignmentCount: Number(row.assignmentCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const getRoleDefinitions = withAnyPermission(
  ['permission:list', 'system:config'],
  async (): Promise<RoleDefinition[]> => {
    const rows = await db
      .select({
        roleKey: permissionRoleDefinitions.roleKey,
        name: permissionRoleDefinitions.name,
        description: permissionRoleDefinitions.description,
        actions: permissionRoleDefinitions.actions,
        allowedScopeTypes: permissionRoleDefinitions.allowedScopeTypes,
        canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
        isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
        isStoreManager: permissionRoleDefinitions.isStoreManager,
        assignmentCount: sql<number>`count(DISTINCT ${permissionRoles.employeeId})::int`,
        createdAt: permissionRoleDefinitions.createdAt,
        updatedAt: permissionRoleDefinitions.updatedAt,
      })
      .from(permissionRoleDefinitions)
      .leftJoin(permissionRoles, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
      .groupBy(permissionRoleDefinitions.roleKey)
      .orderBy(
        ROLE_DISPLAY_PRIORITY,
        asc(permissionRoleDefinitions.createdAt),
        asc(permissionRoleDefinitions.name),
      )
    return rows.map(serialize)
  },
)

export const createRoleDefinition = withPermission(
  'system:config',
  async (session, input: RoleDefinitionInput): Promise<{ success: boolean; message: string; roleKey?: string }> => {
    const isSuperAdmin = input.isSuperAdmin === true
    const isStoreManager = input.isStoreManager === true
    if (isSuperAdmin || isStoreManager || input.canAccessAdmin === false) requireAdmin(session)

    let sourceActions = input.actions ?? []
    if (input.copyFromRoleKey) {
      const [source] = await db
        .select({ actions: permissionRoleDefinitions.actions })
        .from(permissionRoleDefinitions)
        .where(eq(permissionRoleDefinitions.roleKey, input.copyFromRoleKey))
        .limit(1)
      if (!source) throw new Error('NOT_FOUND: 复制来源角色不存在')
      sourceActions = sanitizeRoleDefinitionActions(source.actions, isSuperAdmin, KNOWN_PERMISSION_ACTIONS)
    }

    const roleKey = `role_${randomUUID()}`
    const actions = normalizeActions(sourceActions, isSuperAdmin)
    const allowedScopeTypes = normalizeAllowedScopeTypes(input.allowedScopeTypes, actions, isSuperAdmin)
    try {
      await db.transaction(async (tx) => {
        await tx.insert(permissionRoleDefinitions).values({
          roleKey,
          name: normalizeName(input.name),
          description: normalizeDescription(input.description),
          actions,
          allowedScopeTypes,
          canAccessAdmin: isSuperAdmin ? true : input.canAccessAdmin !== false,
          isSuperAdmin,
          isStoreManager,
          createdBy: session.employeeId,
          updatedBy: session.employeeId,
        })
        await writeCompatibilityMirror(tx)
      })
    } catch (error) {
      if (pgErrorCode(error) === '23505') return { success: false, message: '角色名称已存在' }
      throw error
    }

    await logOperation(session, 'role_definition.create', 'permission_role_definition', roleKey, {
      name: normalizeName(input.name), actions, allowedScopeTypes, canAccessAdmin: input.canAccessAdmin !== false,
      isSuperAdmin, isStoreManager,
    })
    invalidatePermissionMatrixCache()
    revalidatePath('/settings/permission-matrix')
    revalidatePath('/permissions')
    return { success: true, message: '角色已创建', roleKey }
  },
)

export const updateRoleDefinition = withPermission(
  'system:config',
  async (
    session,
    roleKey: string,
    input: RoleDefinitionInput,
  ): Promise<{ success: boolean; message: string }> => {
    const [before] = await db
      .select()
      .from(permissionRoleDefinitions)
      .where(eq(permissionRoleDefinitions.roleKey, roleKey))
      .limit(1)
    if (!before) throw new Error('NOT_FOUND: 角色不存在')

    const nextSuper = input.isSuperAdmin ?? before.isSuperAdmin
    const nextStoreManager = input.isStoreManager ?? before.isStoreManager
    const nextAdminAccess = nextSuper ? true : (input.canAccessAdmin ?? before.canAccessAdmin)
    const capabilityChanged = nextSuper !== before.isSuperAdmin
      || nextStoreManager !== before.isStoreManager
      || nextAdminAccess !== before.canAccessAdmin
    if (capabilityChanged) requireAdmin(session)

    if (!before.isSuperAdmin && nextSuper && await hasConflictingScopeAssignment(roleKey, ['总部'])) {
      throw new Error('INVALID_STATE: 已在非总部范围分配的角色不能直接升级为超级管理员，请先撤销相关授权')
    }

    /**
     * 「降级超管角色」也会减少活跃超管 —— 守卫见下面的事务内（#318）。
     * 这里**不**做事务外预查：那份查询与 UPDATE 之间可被并发插队，
     * 而这条不变量的另外三个入口（`updateEmployee` 标离职 / `deleteEmployee` /
     * `revokeRole` 撤超管）都已经收进 `admin:active_count` 那把锁，只差这一处。
     */

    const actions = normalizeActions(
      input.actions ?? sanitizeRoleDefinitionActions(
        before.actions,
        before.isSuperAdmin,
        KNOWN_PERMISSION_ACTIONS,
      ),
      nextSuper,
    )
    const allowedScopeTypes = normalizeAllowedScopeTypes(
      input.allowedScopeTypes ?? before.allowedScopeTypes,
      actions,
      nextSuper,
    )
    // 编辑可能收窄层级（含 normalize 对进销存层级动作的强制收敛）；按目标层级复核
    // 存量分配，矛盾时拒绝，防止小程序端继续按旧绑定放行。
    if (await hasConflictingScopeAssignment(roleKey, allowedScopeTypes)) {
      throw new Error('INVALID_STATE: 存在与新可绑定层级冲突的角色分配，请先撤销相关授权后再保存')
    }
    // PostgreSQL 的 timestamptz 可保留微秒，而 JavaScript Date 只能保留毫秒。
    // 页面拿到的是 ISO 毫秒值，直接等值比较会让刚创建的角色也误判为并发冲突。
    const expectedUpdatedAt = input.expectedUpdatedAt ?? before.updatedAt.toISOString()
    try {
      const changed = await db.transaction(async (tx) => {
        /**
         * ## 与另外三个入口共用**同一把** `admin:active_count` 锁（#318）
         *
         * 光把计数塞进事务不够串行：READ COMMITTED 下「降级角色 R1」与「撤销某人的 R2 绑定」
         * 各自都读到「还有别的在职超管」、改的又是不同行，双双提交 → 零超管，系统锁死。
         * 锁序见 `lib/invariant-locks.ts`：本路径只需 ②。
         *
         * ⚠️ **capability 变更的两个方向都取锁**，不只降级（#318 第 2 轮）：
         * 「谁是活跃超管」这个集合由**绑定**和**角色定义的超管位**共同决定，而
         * `assignRole` / `revokeRole` 是按锁内重读的 `is_super_admin` 决策的 ——
         * 升级方向不取锁，它们就会读到一个正在变的判据（GLM 报的那条击穿路径的上游）。
         */
        if (capabilityChanged) await lockActiveAdminCount(tx)

        const rows = await tx
          .update(permissionRoleDefinitions)
          .set({
            name: normalizeName(input.name ?? before.name),
            description: normalizeDescription(input.description ?? before.description),
            actions,
            allowedScopeTypes,
            canAccessAdmin: nextAdminAccess,
            isSuperAdmin: nextSuper,
            isStoreManager: nextStoreManager,
            updatedBy: session.employeeId,
            updatedAt: new Date(),
          })
          .where(and(
            eq(permissionRoleDefinitions.roleKey, roleKey),
            sql`date_trunc('milliseconds', ${permissionRoleDefinitions.updatedAt}) = ${expectedUpdatedAt}`,
          ))
          .returning({ roleKey: permissionRoleDefinitions.roleKey })
        if (rows.length === 0) return false

        /**
         * ## 「先改再数」——守卫必须排在 CAS UPDATE **之后**（#318 第 2 轮，codex P2）
         *
         * 排在前面时，一次注定失败的乐观锁提交会先撞上「至少保留 1 名超管」，
         * 把用户带到完全错误的方向（他该看到的是「角色已被其他人修改，请刷新重试」）。
         * 放在后面还顺带简化了判据：UPDATE 已经把本角色的超管位写成 false，
         * 所以直接数**全局**活跃超管即可（`countActiveAdmins` 与另外三个入口同一个 helper），
         * 不必再写 `ne(roleKey)` 去手工排除自己。归零就抛出去回滚。
         */
        if (before.isSuperAdmin && !nextSuper && await countActiveAdmins(tx) === 0) {
          throw new Error('INVALID_STATE: 系统至少需保留 1 名在职超级管理员')
        }

        await writeCompatibilityMirror(tx)
        return true
      })
      if (!changed) return { success: false, message: '角色已被其他人修改，请刷新重试' }
    } catch (error) {
      if (pgErrorCode(error) === '23505') return { success: false, message: '角色名称已存在' }
      throw error
    }

    await logUpdate(session, 'role_definition.update', 'permission_role_definition', roleKey,
      { name: before.name, description: before.description, actions: before.actions, allowedScopeTypes: before.allowedScopeTypes, canAccessAdmin: before.canAccessAdmin, isSuperAdmin: before.isSuperAdmin, isStoreManager: before.isStoreManager },
      { name: input.name ?? before.name, description: input.description ?? before.description, actions, allowedScopeTypes, canAccessAdmin: nextAdminAccess, isSuperAdmin: nextSuper, isStoreManager: nextStoreManager },
    )
    invalidatePermissionMatrixCache()
    revalidatePath('/settings/permission-matrix')
    revalidatePath('/permissions')
    return { success: true, message: '角色已保存' }
  },
)

export const deleteRoleDefinition = withPermission(
  'system:config',
  async (session, roleKey: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [target] = await db
      .select({ name: permissionRoleDefinitions.name })
      .from(permissionRoleDefinitions)
      .where(eq(permissionRoleDefinitions.roleKey, roleKey))
      .limit(1)
    if (!target) return { success: false, message: '角色不存在' }

    const [{ count }] = await db
      .select({ count: sql<number>`count(DISTINCT ${permissionRoles.employeeId})::int` })
      .from(permissionRoles)
      .where(eq(permissionRoles.role, roleKey))
    if (count > 0) return { success: false, message: `该角色仍分配给 ${count} 名员工，请先撤销授权` }

    await db.transaction(async (tx) => {
      await tx.delete(permissionRoleDefinitions).where(eq(permissionRoleDefinitions.roleKey, roleKey))
      await writeCompatibilityMirror(tx)
    })
    await logOperation(session, 'role_definition.delete', 'permission_role_definition', roleKey, { name: target.name })
    invalidatePermissionMatrixCache()
    revalidatePath('/settings/permission-matrix')
    revalidatePath('/permissions')
    return { success: true, message: '角色已删除' }
  },
)
