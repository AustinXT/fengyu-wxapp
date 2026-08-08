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
import { requireAdmin, isAdminScope } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'

const VALID_NODE_TYPES = ['总部', '市场', '门店', '部门'] as const

function validateParentType(nodeType: OrgNode['type'], parentType: OrgNode['type']): string | null {
  if (nodeType === '总部') return '总部节点必须作为根节点'
  if (parentType === '部门') {
    return nodeType === '部门' ? '部门不可嵌套' : '部门节点下不能创建子节点'
  }
  if (parentType === '门店' && nodeType !== '部门') return '门店节点下只能创建部门'
  if (nodeType === '市场' && parentType !== '总部') return '市场节点只能在总部下'
  if (nodeType === '门店' && parentType !== '市场') return '门店节点只能在市场下'
  return null
}

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

  // 根节点只允许总部，且只有 admin 可创建，避免非 admin 趁无父节点绕过 scope 校验。
  if (!data.parentId) {
    if (data.type !== '总部') return { success: false, message: '只有总部节点可以作为根节点' }
    if (!isAdminScope(session)) return { success: false, message: '无权创建根节点' }
  } else {
    const [parent] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, data.parentId))
      .limit(1)
    if (!parent) {
      return { success: false, message: '父节点不存在' }
    }
    const parentTypeError = validateParentType(data.type, parent.type)
    if (parentTypeError) return { success: false, message: parentTypeError }

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
  if (!before) return { success: false, message: '节点不存在' }

  // 修改父节点或类型时，都需要重新校验完整的层级约束。
  if (data.parentId !== undefined || data.type !== undefined) {
    const targetParentId = data.parentId === undefined ? before.parentId : data.parentId
    const targetType = data.type ?? before.type

    // 不能将节点移动到自己或自己的子孙节点下（防止循环引用）
    if (targetParentId && targetParentId !== before.parentId) {
      const isDescendant = await checkIsDescendant(id, targetParentId)
      if (isDescendant) {
        return { success: false, message: '不能将节点移动到自己的子节点下' }
      }
    }

    if (!targetParentId) {
      if (targetType !== '总部') return { success: false, message: '只有总部节点可以作为根节点' }
      if (!isAdminScope(session)) return { success: false, message: '无权将节点移动为根节点' }
    } else {
      const [newParent] = await db
        .select({ type: orgNodes.type })
        .from(orgNodes)
        .where(eq(orgNodes.id, targetParentId))
        .limit(1)
      if (!newParent) {
        return { success: false, message: '目标父节点不存在' }
      }

      const parentTypeError = validateParentType(targetType, newParent.type)
      if (parentTypeError) return { success: false, message: parentTypeError }

      // scope 隔离：非 admin 只能移动到自己 scope 内的父节点下。
      if (targetParentId !== before.parentId && !(await isNodeInScope(session, targetParentId))) {
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
