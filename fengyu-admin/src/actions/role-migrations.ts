'use server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withPermission } from '@/lib/with-permission'
import { scopeSessionToAllActions } from '@/lib/action-scope'
import { isAdminScope, hasPermission } from '@/lib/permissions'
import { isEmployeeWithinScopeRoots, isNodeWithinScopeRoots } from '@/lib/org-ancestry'
import { lockOrgTree, lockActiveAdminCount } from '@/lib/invariant-locks'
import { logOperation } from '@/lib/operation-log'
import { pendingRoleMigrationsSql } from '@/lib/role-migration-pending'
import { revalidatePath } from 'next/cache'

async function visibleEmployee(session: Parameters<typeof isAdminScope>[0], employeeId: string, executor: Pick<typeof db, 'execute'> = db) {
  const rows = await executor.execute(sql`SELECT store_id AS "storeId", org_node_id AS "orgNodeId", is_resigned FROM staff_wechat_users WHERE employee_id = ${employeeId}`)
  const employee = (rows as unknown as Array<{ storeId: string | null; orgNodeId: string | null; is_resigned: boolean }>)[0]
  if (!employee || (!isAdminScope(session) && !await isEmployeeWithinScopeRoots(employee, session.roles.map(r => r.scopeId), executor))) throw new Error('NOT_FOUND: 员工不存在或不在您的权限范围内')
  return employee
}

export const getEmployeeRoleMigration = withPermission('permission:list', async (session, employeeId: string) => {
  const employee = await visibleEmployee(session, employeeId)
  const roles = await db.execute(sql`
    SELECT pr.id::float8 AS id, pr.role, rd.name AS role_name, pr.scope_id, n.name AS scope_name, n.type AS scope_type,
      s.org_node_id AS target_scope_id, s.store_name AS target_store_name,
      EXISTS (SELECT 1 FROM permission_roles target WHERE target.employee_id = pr.employee_id
        AND target.role = pr.role AND target.scope_id = s.org_node_id) AS target_exists
    FROM permission_roles pr JOIN permission_role_definitions rd ON rd.role_key = pr.role
    JOIN org_nodes n ON n.id = pr.scope_id LEFT JOIN stores s ON s.store_id = ${employee.storeId}
      AND s.is_closed = false AND EXISTS (SELECT 1 FROM org_nodes target_node WHERE target_node.id = s.org_node_id AND target_node.type = '门店')
    WHERE pr.employee_id = ${employeeId} ORDER BY pr.id
  `) as unknown as Array<{ id: number; role: string; role_name: string; scope_id: string; scope_name: string; scope_type: string; target_scope_id: string | null; target_store_name: string | null; target_exists: boolean }>
  const pending = await db.execute(pendingRoleMigrationsSql(employeeId)) as unknown as Array<{ event_id: string; binding_id: number; created_at: string }>
  const roots = session.roles.map(r => r.scopeId)
  const scopedRoles = (await Promise.all(roles.map(async role => ({ ...role, canReview: isAdminScope(session)
    || await isNodeWithinScopeRoots(role.scope_id, roots), canMigrate: Boolean(role.target_scope_id && (isAdminScope(session)
      || await isNodeWithinScopeRoots(role.target_scope_id, roots))) })))).filter(role => role.canReview)
  return { roles: scopedRoles, pending: pending.filter(p => scopedRoles.some(r => r.id === p.binding_id)), resigned: employee.is_resigned }
})

export const reviewEmployeeRoleMigration = withPermission('permission:assign', async (session, input: {
  employeeId: string; targetScopeId: string | null; eventId?: string; decision: 'migrate' | 'retain';
  bindings: Array<{ id: number; role: string; scopeId: string }>
}) => {
  if (!input || !['migrate', 'retain'].includes(input.decision) || !Array.isArray(input.bindings)
    || (input.decision === 'retain' && !input.eventId)
    || input.bindings.length === 0 || input.bindings.length > 100
    || input.bindings.some(b => !b || !Number.isSafeInteger(b.id) || b.id <= 0 || typeof b.role !== 'string' || !b.role || typeof b.scopeId !== 'string' || !b.scopeId)
    || new Set(input.bindings.map(b => b.id)).size !== input.bindings.length) throw new Error('INVALID_PARAMS: 请选择有效的角色绑定')
  if (input.decision === 'migrate') {
    if (!hasPermission(session, 'permission:revoke')) throw new Error('PERMISSION_DENIED: 迁移需要角色撤销权限')
    session = scopeSessionToAllActions(session, ['permission:assign', 'permission:revoke'])
  }
  await db.transaction(async tx => {
    await lockOrgTree(tx)
    await lockActiveAdminCount(tx)
    await tx.execute(sql`SELECT employee_id FROM staff_wechat_users WHERE employee_id = ${input.employeeId} FOR UPDATE`)
    const employee = await visibleEmployee(session, input.employeeId, tx)
    if (employee.is_resigned) throw new Error('INVALID_STATE: 员工已离职')
    const targets = await tx.execute(sql`SELECT s.org_node_id FROM stores s JOIN org_nodes n ON n.id = s.org_node_id
      WHERE s.store_id = ${employee.storeId} AND n.type = '门店' AND s.is_closed = false`)
    const target = (targets as unknown as Array<{ org_node_id: string }>)[0]
    if (input.decision === 'migrate' && (!target || target.org_node_id !== input.targetScopeId)) throw new Error('CONFLICT: 员工门店已变更，请重新预览')
    const pending = await tx.execute(pendingRoleMigrationsSql(input.employeeId)) as unknown as Array<{ event_id: string; binding_id: number }>
    if (input.eventId) {
      const eventPending = pending
      if (input.bindings.some(b => !eventPending.some(p => p.event_id === input.eventId && p.binding_id === b.id))) throw new Error('CONFLICT: 调店待办已变化，请重新预览')
    }
    const roots = session.roles.map(r => r.scopeId)
    for (const binding of input.bindings) {
      if (!isAdminScope(session) && (!await isNodeWithinScopeRoots(binding.scopeId, roots, tx)
        || (input.decision === 'migrate' && (!target || !await isNodeWithinScopeRoots(target.org_node_id, roots, tx))))) throw new Error('PERMISSION_DENIED: 旧门店或新门店超出权限范围')
      const current = await tx.execute(sql`
        SELECT pr.id FROM permission_roles pr JOIN org_nodes n ON n.id = pr.scope_id
        JOIN permission_role_definitions rd ON rd.role_key = pr.role
        WHERE pr.id = ${binding.id} AND pr.employee_id = ${input.employeeId} AND pr.role = ${binding.role}
          AND pr.scope_id = ${binding.scopeId} AND n.type = '门店'
          AND ${input.decision === 'migrate' ? sql`pr.scope_id <> ${target!.org_node_id} AND rd.is_super_admin = false AND '门店' = ANY(rd.allowed_scope_types)` : sql`true`} FOR UPDATE OF pr
      `)
      if ((current as unknown as unknown[]).length !== 1) throw new Error('CONFLICT: 角色绑定已变化，请重新预览')
      if (input.decision === 'retain') continue
      if (!target) throw new Error('CONFLICT: 员工无有效目标门店')
      const existing = await tx.execute(sql`SELECT id FROM permission_roles WHERE employee_id = ${input.employeeId}
        AND role = ${binding.role} AND scope_id = ${target.org_node_id}`)
      const result = (existing as unknown as unknown[]).length
        ? await tx.execute(sql`DELETE FROM permission_roles WHERE id = ${binding.id} AND employee_id = ${input.employeeId}
          AND role = ${binding.role} AND scope_id = ${binding.scopeId} RETURNING id`)
        : await tx.execute(sql`UPDATE permission_roles SET scope_id = ${target.org_node_id}, updated_at = now(), updated_by = ${session.employeeId}
          WHERE id = ${binding.id} AND employee_id = ${input.employeeId} AND role = ${binding.role} AND scope_id = ${binding.scopeId} RETURNING id`)
      if ((result as unknown as unknown[]).length !== 1) throw new Error('CONFLICT: 角色绑定已变化，迁移已回滚')
      await logOperation(session, 'permission.scopeMigrate', 'permission_role', input.employeeId, {
        bindingId: binding.id, role: binding.role, oldScopeId: binding.scopeId, newScopeId: target.org_node_id,
        keptExisting: (existing as unknown as unknown[]).length > 0,
      }, tx)
    }
    for (const eventId of new Set(pending.filter(p => input.bindings.some(b => b.id === p.binding_id)).map(p => p.event_id))) {
      await logOperation(session, 'permission.scopeReview.completed', 'permission_role', input.employeeId, {
        eventId, bindingIds: pending.filter(p => p.event_id === eventId && input.bindings.some(b => b.id === p.binding_id)).map(p => p.binding_id), decision: input.decision,
      }, tx)
    }
  })
  revalidatePath('/permissions')
  revalidatePath(`/employees/${input.employeeId}`)
  return { success: true }
})

export const getRoleMigrationQueue = withPermission('permission:list', async session => {
  const pending = await db.execute(pendingRoleMigrationsSql()) as unknown as Array<{ employee_id: string; employee_name: string | null; event_id: string; created_at: string; scope_id: string }>
  const rows: typeof pending = []
  for (const row of pending) {
    if (rows.some(r => r.employee_id === row.employee_id)) continue
    try {
      if (!isAdminScope(session) && !await isNodeWithinScopeRoots(row.scope_id, session.roles.map(r => r.scopeId))) continue
      await visibleEmployee(session, row.employee_id); rows.push(row)
    }
    catch (error) { if (!(error instanceof Error && error.message.startsWith('NOT_FOUND:'))) throw error }
    if (rows.length >= 100) break
  }
  return rows
})
