'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { orgNodes, stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { permissionRoles } from '@db/permission'
import { eq, and, asc, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { OrgNode } from '@/lib/types'
import { isNodeInScope } from '@/lib/node-scope'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'

const VALID_NODE_TYPES = ['总部', '市场', '门店', '部门'] as const

/**
 * 检查 targetId 是否是 nodeId 的子孙节点
 */
async function checkIsDescendant(nodeId: string, targetId: string): Promise<boolean> {
  if (nodeId === targetId) return true

  // BFS 查找所有子孙节点
  const queue = [nodeId]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    if (current === targetId) return true

    const children = await db
      .select({ id: orgNodes.id })
      .from(orgNodes)
      .where(eq(orgNodes.parentId, current))

    children.forEach((child) => queue.push(child.id))
  }

  return false
}

export const getOrgNodes = withPermission(
  'org:list',
  async (): Promise<OrgNode[]> => {
  const rows = await db
    .select()
    .from(orgNodes)
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(orgNodes.sortOrder))
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
  },
)

export const createOrgNode = withPermission(
  'org:create',
  async (
    session,
    data: {
      id: string
      name: string
      type: OrgNode['type']
      parentId: string | null
      sortOrder: number
      isActive: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
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
    if (parent.type === '部门' && data.type === '部门') {
      return { success: false, message: '部门不可嵌套' }
    }
    // 门店下只能建部门
    if (parent.type === '门店' && data.type !== '部门') {
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
    if (pgErrorCode(err) === '23505') return { success: false, message: '节点编号已存在' }
    if (pgErrorCode(err) === '23503') return { success: false, message: '父节点不存在，请刷新后重试' }
    throw err
  }

  await logOperation(session, 'org.create', 'org_node', data.id, { name: data.name, type: data.type })
  revalidatePath('/org')
  return { success: true, message: '节点创建成功' }
  },
)

export const updateOrgNode = withPermission(
  'org:update',
  async (
    session,
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
  ): Promise<{ success: boolean; message: string }> => {
  // 校验 type 是否有效
  if (data.type && !VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  // scope 隔离：非 admin 只能编辑自己 scope 内的节点
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权编辑该节点' }
  }

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)

  // 如果修改了 parentId，需要额外校验
  if (data.parentId !== undefined && data.parentId !== before?.parentId) {
    // 不能将节点移动到自己或自己的子孙节点下（防止循环引用）
    if (data.parentId) {
      const isDescendant = await checkIsDescendant(id, data.parentId)
      if (isDescendant) {
        return { success: false, message: '不能将节点移动到自己的子节点下' }
      }
    }

    // 校验新父节点的类型约束
    if (data.parentId) {
      const [newParent] = await db
        .select({ type: orgNodes.type })
        .from(orgNodes)
        .where(eq(orgNodes.id, data.parentId))
        .limit(1)
      if (!newParent) {
        return { success: false, message: '目标父节点不存在' }
      }

      const nodeType = data.type ?? before?.type
      // 市场只能在总部下
      if (nodeType === '市场' && newParent.type !== '总部') {
        return { success: false, message: '市场节点只能在总部下' }
      }
      // 门店只能在市场下
      if (nodeType === '门店' && newParent.type !== '市场') {
        return { success: false, message: '门店节点只能在市场下' }
      }
      // 部门不能在部门下
      if (nodeType === '部门' && newParent.type === '部门') {
        return { success: false, message: '部门不能嵌套' }
      }
      // 门店下只能有部门
      if (newParent.type === '门店' && nodeType !== '部门') {
        return { success: false, message: '门店节点下只能创建部门' }
      }

      // scope 隔离：非 admin 只能移动到自己 scope 内的父节点下
      if (!(await isNodeInScope(session, data.parentId))) {
        return { success: false, message: '无权将节点移动到该位置' }
      }
    }
  }

  const whereConditions = expectedUpdatedAt
    ? and(eq(orgNodes.id, id), sql`date_trunc('milliseconds', ${orgNodes.updatedAt}) = ${expectedUpdatedAt}`)
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

  await logUpdate(session, 'org.update', 'org_node', id, before as Record<string, unknown>, data)
  revalidatePath('/org')
  return { success: true, message: '节点已更新' }
  },
)

export const deleteOrgNode = withPermission(
  'org:delete',
  async (
    session,
    id: string,
  ): Promise<{ success: boolean; message: string }> => {
  requireAdmin(session)
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
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '该节点仍有关联数据，无法删除' }
    }
    throw err
  }

  await logOperation(session, 'org.delete', 'org_node', id)
  revalidatePath('/org')
  return { success: true, message: '节点已删除' }
  },
)
