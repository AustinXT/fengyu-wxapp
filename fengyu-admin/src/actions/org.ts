'use server'

import { db } from '@/db'
import { orgNodes } from '@db/org'
import { eq, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { OrgNode } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export async function getOrgNodes(): Promise<OrgNode[]> {
  const session = await getSession()
  requirePermission(session, 'org:list')

  const rows = await db.select().from(orgNodes).orderBy(asc(orgNodes.sortOrder))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  }))
}

export async function createOrgNode(data: {
  id: string
  name: string
  type: OrgNode['type']
  parentId: string | null
  sortOrder: number
  isActive: boolean
}) {
  const session = await getSession()
  requirePermission(session, 'org:create')

  await db.insert(orgNodes).values({
    id: data.id,
    name: data.name,
    type: data.type,
    parentId: data.parentId,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
  })

  await logOperation(session, 'org.create', 'org_node', data.id, { name: data.name, type: data.type })
  revalidatePath('/org')
}

export async function updateOrgNode(
  id: string,
  data: Partial<{
    name: string
    type: OrgNode['type']
    parentId: string | null
    sortOrder: number
    isActive: boolean
  }>
) {
  const session = await getSession()
  requirePermission(session, 'org:update')

  await db.update(orgNodes).set(data).where(eq(orgNodes.id, id))

  await logOperation(session, 'org.update', 'org_node', id, data)
  revalidatePath('/org')
}

export async function deleteOrgNode(id: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'org:delete')

  // 检查是否有子节点
  const children = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, id))
    .limit(1)

  if (children.length > 0) {
    return { success: false, message: '该节点下存在子节点，无法删除' }
  }

  // 软删除：设 isActive = false
  await db.update(orgNodes).set({ isActive: false }).where(eq(orgNodes.id, id))

  await logOperation(session, 'org.delete', 'org_node', id)
  revalidatePath('/org')
  return { success: true, message: '节点已停用' }
}
