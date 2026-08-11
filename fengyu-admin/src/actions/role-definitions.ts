'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { withAnyPermission, withPermission } from '@/lib/with-permission'
import { requireAdmin, invalidatePermissionMatrixCache, KNOWN_PERMISSION_ACTIONS } from '@/lib/permissions'
import { ADMIN_ONLY_ACTIONS, getMissingUiDependencies } from '@/lib/permission-contract'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import type { RoleDefinition } from '@/lib/types'

const SUPER_ADMIN_REQUIRED_ACTIONS = [
  'system:config',
  'permission:assign_admin',
  'admin:reset_password',
] as const

export interface RoleDefinitionInput {
  name: string
  description?: string | null
  actions?: string[]
  copyFromRoleKey?: string | null
  canAccessAdmin?: boolean
  isSuperAdmin?: boolean
  isStoreManager?: boolean
  expectedUpdatedAt?: string
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

  const adminOnly = normalized.find((action) => (
    action.endsWith(':delete') || (ADMIN_ONLY_ACTIONS as readonly string[]).includes(action)
  ))
  if (adminOnly && !isSuperAdmin) {
    throw new Error(`INVALID_PARAMS: ${adminOnly} 仅超级管理员角色可持有`)
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
 * 超级管理员会绕过数据 scope，因此已在市场、门店等非总部节点分配的角色
 * 不得直接升级。调用方必须先撤销这些分配，再创建或升级总部范围的角色。
 */
async function hasNonHeadquartersAssignment(roleKey: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1
      FROM permission_roles pr
      JOIN org_nodes node ON node.id = pr.scope_id
     WHERE pr.role = ${roleKey}
       AND node.type <> '总部'
     LIMIT 1
  `)
  return (rows as unknown as unknown[]).length > 0
}

async function writeCompatibilityMirror(tx: any): Promise<void> {
  const rows = await tx
    .select({ roleKey: permissionRoleDefinitions.roleKey, actions: permissionRoleDefinitions.actions })
    .from(permissionRoleDefinitions)
  const matrix = Object.fromEntries(rows.map((row: { roleKey: string; actions: string[] }) => [row.roleKey, row.actions]))
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
  canAccessAdmin: boolean
  isSuperAdmin: boolean
  isStoreManager: boolean
  assignmentCount: number
  createdAt: Date
  updatedAt: Date
}): RoleDefinition {
  return {
    ...row,
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
      .orderBy(asc(permissionRoleDefinitions.createdAt), asc(permissionRoleDefinitions.name))
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
      sourceActions = isSuperAdmin
        ? source.actions
        : source.actions.filter((action) => (
          !action.endsWith(':delete')
          && !(ADMIN_ONLY_ACTIONS as readonly string[]).includes(action)
        ))
    }

    const roleKey = `role_${randomUUID()}`
    const actions = normalizeActions(sourceActions, isSuperAdmin)
    try {
      await db.transaction(async (tx) => {
        await tx.insert(permissionRoleDefinitions).values({
          roleKey,
          name: normalizeName(input.name),
          description: normalizeDescription(input.description),
          actions,
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
      name: normalizeName(input.name), actions, canAccessAdmin: input.canAccessAdmin !== false,
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

    if (!before.isSuperAdmin && nextSuper && await hasNonHeadquartersAssignment(roleKey)) {
      throw new Error('INVALID_STATE: 已在非总部范围分配的角色不能直接升级为超级管理员，请先撤销相关授权')
    }

    if (before.isSuperAdmin && !nextSuper) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(DISTINCT ${permissionRoles.employeeId})::int` })
        .from(permissionRoles)
        .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
        .innerJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
        .where(and(
          eq(permissionRoleDefinitions.isSuperAdmin, true),
          ne(permissionRoleDefinitions.roleKey, roleKey),
          eq(staffWechatUsers.isResigned, false),
        ))
      if (count < 1) throw new Error('INVALID_STATE: 系统至少需保留 1 名在职超级管理员')
    }

    const actions = normalizeActions(input.actions ?? before.actions, nextSuper)
    const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt) : before.updatedAt
    try {
      const changed = await db.transaction(async (tx) => {
        const rows = await tx
          .update(permissionRoleDefinitions)
          .set({
            name: normalizeName(input.name ?? before.name),
            description: normalizeDescription(input.description ?? before.description),
            actions,
            canAccessAdmin: nextAdminAccess,
            isSuperAdmin: nextSuper,
            isStoreManager: nextStoreManager,
            updatedBy: session.employeeId,
            updatedAt: new Date(),
          })
          .where(and(
            eq(permissionRoleDefinitions.roleKey, roleKey),
            eq(permissionRoleDefinitions.updatedAt, expected),
          ))
          .returning({ roleKey: permissionRoleDefinitions.roleKey })
        if (rows.length > 0) await writeCompatibilityMirror(tx)
        return rows.length > 0
      })
      if (!changed) return { success: false, message: '角色已被其他人修改，请刷新重试' }
    } catch (error) {
      if (pgErrorCode(error) === '23505') return { success: false, message: '角色名称已存在' }
      throw error
    }

    await logUpdate(session, 'role_definition.update', 'permission_role_definition', roleKey,
      { name: before.name, description: before.description, actions: before.actions, canAccessAdmin: before.canAccessAdmin, isSuperAdmin: before.isSuperAdmin, isStoreManager: before.isStoreManager },
      { name: input.name ?? before.name, description: input.description ?? before.description, actions, canAccessAdmin: nextAdminAccess, isSuperAdmin: nextSuper, isStoreManager: nextStoreManager },
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
