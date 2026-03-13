'use server'

import { db } from '@/db'
import { orgNodes } from '@db/org'
import { eq, asc } from 'drizzle-orm'
import type { OrgNode } from '@/lib/types'

export async function getOrgNodes(): Promise<OrgNode[]> {
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
  await db.insert(orgNodes).values({
    id: data.id,
    name: data.name,
    type: data.type,
    parentId: data.parentId,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
  })
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
  await db.update(orgNodes).set(data).where(eq(orgNodes.id, id))
}

export async function deleteOrgNode(id: string) {
  await db.delete(orgNodes).where(eq(orgNodes.id, id))
}
