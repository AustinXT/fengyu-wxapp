'use server'

import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { eq, and, asc, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { OrgNode } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

const VALID_NODE_TYPES = ['headquarters', 'market', 'store', 'department'] as const

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
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'org:create')

  // 校验 type 是否有效
  if (!VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  // 校验层级约束：department 不可嵌套
  if (data.parentId) {
    const [parent] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, data.parentId))
      .limit(1)
    if (!parent) {
      return { success: false, message: '父节点不存在' }
    }
    // department 下不能再建 department
    if (parent.type === 'department' && data.type === 'department') {
      return { success: false, message: '部门不可嵌套' }
    }
    // store 下只能建 department
    if (parent.type === 'store' && data.type !== 'department') {
      return { success: false, message: '门店节点下只能创建部门' }
    }
  }

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
  return { success: true, message: '节点创建成功' }
}

export async function updateOrgNode(
  id: string,
  data: Partial<{
    name: string
    type: OrgNode['type']
    parentId: string | null
    sortOrder: number
    isActive: boolean
  }>,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'org:update')

  // 校验 type 是否有效
  if (data.type && !VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  const whereConditions = expectedUpdatedAt
    ? and(eq(orgNodes.id, id), eq(orgNodes.updatedAt, new Date(expectedUpdatedAt)))
    : eq(orgNodes.id, id)

  const result = await db.update(orgNodes).set(data).where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'org.update', 'org_node', id, data)
  revalidatePath('/org')
  return { success: true, message: '节点已更新' }
}

export async function deleteOrgNode(
  id: string,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
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

  // 检查是否有员工绑定到此节点
  const [empRef] = await db
    .select({ employeeId: staffWechatUsers.employeeId })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.orgNodeId, id))
    .limit(1)
  if (empRef) {
    return { success: false, message: '该节点下仍有员工，请先移除员工归属后再删除' }
  }

  // 检查是否有门店绑定到此节点
  const [storeRef] = await db
    .select({ storeId: stores.storeId })
    .from(stores)
    .where(eq(stores.orgNodeId, id))
    .limit(1)
  if (storeRef) {
    return { success: false, message: '该节点关联了门店，请先移除门店后再删除' }
  }

  // 检查是否有权限角色以此节点为 scope
  const [roleRef] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(eq(permissionRoles.scopeId, id))
    .limit(1)
  if (roleRef) {
    return { success: false, message: '该节点被权限角色引用，请先移除关联权限后再删除' }
  }

  // 软删除：设 isActive = false（含乐观锁）
  const whereConditions = expectedUpdatedAt
    ? and(eq(orgNodes.id, id), eq(orgNodes.updatedAt, new Date(expectedUpdatedAt)))
    : eq(orgNodes.id, id)

  const result = await db.update(orgNodes).set({ isActive: false }).where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'org.delete', 'org_node', id)
  revalidatePath('/org')
  return { success: true, message: '节点已停用' }
}
