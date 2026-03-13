'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import type { Employee } from '@/lib/types'

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
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))

  return rows.map(rowToEmployee)
}

export async function getEmployeeById(employeeId: string): Promise<Employee | null> {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(eq(staffWechatUsers.employeeId, employeeId))

  if (rows.length === 0) return null
  return rowToEmployee(rows[0])
}

export async function createEmployee(data: {
  employeeId: string
  phone?: string | null
  name?: string | null
  gender?: string | null
  idCard?: string | null
  storeId?: string | null
  orgNodeId?: string | null
  positionName?: string | null
  birthday?: string | null
  skills?: string[] | null
  isResigned?: boolean
}) {
  await db.insert(staffWechatUsers).values({
    employeeId: data.employeeId,
    phone: data.phone ?? null,
    name: data.name ?? null,
    gender: data.gender ?? null,
    idCard: data.idCard ?? null,
    storeId: data.storeId ?? null,
    orgNodeId: data.orgNodeId ?? null,
    positionName: data.positionName ?? null,
    birthday: data.birthday ?? null,
    skills: data.skills ?? null,
    isResigned: data.isResigned ?? false,
  })
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
  }>
) {
  await db.update(staffWechatUsers).set(data).where(eq(staffWechatUsers.employeeId, employeeId))
}
