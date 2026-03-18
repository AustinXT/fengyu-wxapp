'use server'

import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { eq, and, asc, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { OrgNode } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import { logOperation } from '@/lib/operation-log'

const VALID_NODE_TYPES = ['headquarters', 'market', 'store', 'department'] as const

/**
 * 校验 org_node 是否在用户 scope 内（admin 始终通过）。
 * 从目标节点沿 parentId 向上遍历（最多 5 层），
 * 任一祖先命中 session.roles[].scopeId 即视为在 scope 内。
 */
async function isNodeInScope(session: AuthSession, nodeId: string): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = new Set(session.roles.map((r) => r.scopeId))
  if (scopeIds.size === 0) return false

  let currentId: string | null = nodeId
  for (let depth = 0; depth < 5 && currentId; depth++) {
    if (scopeIds.has(currentId)) return true
    const [node] = await db
      .select({ parentId: orgNodes.parentId })
      .from(orgNodes)
      .where(eq(orgNodes.id, currentId))
      .limit(1)
    currentId = node?.parentId ?? null
  }
  return false
}

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

    // scope 隔离：非 admin 只能在自己 scope 内的父节点下创建子节点
    if (!(await isNodeInScope(session, data.parentId))) {
      return { success: false, message: '无权在该节点下创建子节点' }
    }
  }

  try {
    await db.insert(orgNodes).values({
      id: data.id,
      name: data.name,
      type: data.type,
      parentId: data.parentId,
      sortOrder: data.sortOrder,
      isActive: data.isActive,
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '节点编号已存在' }
    if (err?.code === '23503') return { success: false, message: '父节点不存在，请刷新后重试' }
    throw err
  }

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

  // scope 隔离：非 admin 只能编辑自己 scope 内的节点
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权编辑该节点' }
  }

  const whereConditions = expectedUpdatedAt
    ? and(eq(orgNodes.id, id), sql`date_trunc('milliseconds', ${orgNodes.updatedAt}) = ${new Date(expectedUpdatedAt)}`)
    : eq(orgNodes.id, id)

  let result: any
  try {
    result = await db.update(orgNodes).set(data).where(whereConditions)
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '节点不存在',
    }
  }

  await logOperation(session, 'org.update', 'org_node', id, data)
  revalidatePath('/org')
  return { success: true, message: '节点已更新' }
}

export async function deleteOrgNode(
  id: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'org:delete')

  // scope 隔离
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权操作该节点' }
  }

  // 检查子节点
  const [child] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, id))
    .limit(1)
  if (child) {
    return { success: false, message: '该节点下存在子节点，请先删除子节点' }
  }

  // 检查员工绑定
  const [empRef] = await db
    .select({ employeeId: staffWechatUsers.employeeId })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.orgNodeId, id))
    .limit(1)
  if (empRef) {
    return { success: false, message: '该节点下仍有员工，请先移除员工归属' }
  }

  // 检查门店绑定
  const [storeRef] = await db
    .select({ storeId: stores.storeId })
    .from(stores)
    .where(eq(stores.orgNodeId, id))
    .limit(1)
  if (storeRef) {
    return { success: false, message: '该节点关联了门店，请先移除门店' }
  }

  // 检查权限角色引用
  const [roleRef] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(eq(permissionRoles.scopeId, id))
    .limit(1)
  if (roleRef) {
    return { success: false, message: '该节点被权限角色引用，请先移除关联权限' }
  }

  // 真实删除
  try {
    const result = await db.delete(orgNodes).where(eq(orgNodes.id, id))
    if ((result as any).count === 0) {
      return { success: false, message: '节点不存在' }
    }
  } catch (err: any) {
    if (err?.code === '23503') {
      return { success: false, message: '该节点仍有关联数据，无法删除' }
    }
    throw err
  }

  await logOperation(session, 'org.delete', 'org_node', id)
  revalidatePath('/org')
  return { success: true, message: '节点已删除' }
}
