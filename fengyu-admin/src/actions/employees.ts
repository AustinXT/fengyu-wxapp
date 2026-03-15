'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { eq, and, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Employee } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

function rowToEmployee(row: {
  staff_wechat_users: typeof staffWechatUsers.$inferSelect
  stores: typeof stores.$inferSelect | null
  org_nodes: typeof orgNodes.$inferSelect | null
}): Employee {
  const e = row.staff_wechat_users
  return {
    employeeId: e.employeeId,
    openid: e.openid,
    phone: e.phone,
    name: e.name,
    gender: e.gender,
    idCard: e.idCard,
    storeId: e.storeId,
    orgNodeId: e.orgNodeId,
    positionName: e.positionName,
    birthday: e.birthday,
    skills: e.skills,
    isResigned: e.isResigned,
    lastLoginAt: e.lastLoginAt?.toISOString() ?? null,
    createdAt: e.createdAt?.toISOString() ?? '',
    updatedAt: e.updatedAt?.toISOString() ?? '',
    storeName: row.stores?.storeName ?? undefined,
    departmentName: row.org_nodes?.name ?? undefined,
  }
}

export async function getEmployees(): Promise<Employee[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(scopeCondition(session, staffWechatUsers.storeId))
    .limit(500)

  return rows.map(rowToEmployee)
}

export async function getEmployeeById(employeeId: string): Promise<Employee | null> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(and(eq(staffWechatUsers.employeeId, employeeId), scopeCondition(session, staffWechatUsers.storeId)))

  if (rows.length === 0) return null
  return rowToEmployee(rows[0])
}


export async function createEmployee(data: {
  phone: string
  name: string
  gender?: string | null
  idCard?: string | null
  storeId?: string | null
  orgNodeId?: string | null
  positionName?: string | null
  birthday?: string | null
  skills?: string[] | null
}): Promise<{ success: boolean; message: string; employeeId?: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:create')

  // 校验手机号唯一性（事务外，快速短路）
  if (data.phone) {
    const [existing] = await db
      .select({ employeeId: staffWechatUsers.employeeId })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.phone, data.phone))
      .limit(1)
    if (existing) {
      return { success: false, message: '该手机号已被其他员工使用' }
    }
  }

  // 事务：ID 生成（advisory lock）+ 插入，原子提交防并发重复
  const employeeId = await db.transaction(async (tx) => {
    const idRows = await tx.execute(sql`
      WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext('employee_id_gen'))
      )
      SELECT 'FY-' || to_char(NOW(), 'YYMMDD') ||
        LPAD(
          (SELECT COALESCE(MAX(
            CAST(NULLIF(SUBSTRING(employee_id FROM '.{3}$'), '') AS INTEGER)
          ), 0) + 1
          FROM staff_wechat_users
          WHERE employee_id LIKE 'FY-' || to_char(NOW(), 'YYMMDD') || '%'
          )::TEXT, 3, '0'
        ) AS id
      FROM lock
    `)
    const id = (idRows as any[])[0]?.id as string
    if (!id) throw new Error('员工编号生成失败')

    await tx.insert(staffWechatUsers).values({
      employeeId: id,
      phone: data.phone,
      name: data.name,
      gender: data.gender ?? null,
      idCard: data.idCard ?? null,
      storeId: data.storeId ?? null,
      orgNodeId: data.orgNodeId ?? null,
      positionName: data.positionName ?? null,
      birthday: data.birthday ?? null,
      skills: data.skills ?? null,
      isResigned: false,
    })

    return id
  })

  await logOperation(session, 'employee.create', 'employee', employeeId, { name: data.name })
  revalidatePath('/employees')
  return { success: true, message: '员工创建成功', employeeId }
}

export async function updateEmployee(
  employeeId: string,
  data: Partial<{
    phone: string | null
    name: string | null
    gender: string | null
    idCard: string | null
    storeId: string | null
    orgNodeId: string | null
    positionName: string | null
    birthday: string | null
    skills: string[] | null
    isResigned: boolean
  }>,
  /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  // 校验手机号唯一性（如果更新了手机号）
  if (data.phone) {
    const [existing] = await db
      .select({ employeeId: staffWechatUsers.employeeId })
      .from(staffWechatUsers)
      .where(and(eq(staffWechatUsers.phone, data.phone), sql`${staffWechatUsers.employeeId} != ${employeeId}`))
      .limit(1)
    if (existing) {
      return { success: false, message: '该手机号已被其他员工使用' }
    }
  }

  // 乐观锁：WHERE employee_id = $1 AND updated_at = $2
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(staffWechatUsers.employeeId, employeeId),
        eq(staffWechatUsers.updatedAt, new Date(expectedUpdatedAt)),
      )
    : eq(staffWechatUsers.employeeId, employeeId)

  const result = await db.update(staffWechatUsers).set(data).where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  // 标记离职时同步作废所有有效的 permission_roles
  if (data.isResigned === true) {
    await db
      .update(permissionRoles)
      .set({ isVoid: true, voidedAt: new Date(), updatedBy: session.employeeId })
      .where(and(
        eq(permissionRoles.employeeId, employeeId),
        eq(permissionRoles.isVoid, false),
      ))
  }

  await logOperation(session, 'employee.update', 'employee', employeeId, data)
  revalidatePath('/employees')
  return { success: true, message: '员工信息已更新' }
}
