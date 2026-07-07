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
import { logOperation, logUpdate } from '@/lib/operation-log'

const VALID_NODE_TYPES = ['总部', '市场', '门店', '部门'] as const

export const getOrgNodes = withPermission(
  'org:list',
  async (): Promise<OrgNode[]> => {
  const rows = await db
    .select()
    .from(orgNodes)
    
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
  
  if (!VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  
  if (data.parentId) {
    const [parent] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, data.parentId))
      .limit(1)
    if (!parent) {
      return { success: false, message: '父节点不存在' }
    }
    
    if (parent.type === '部门' && data.type === '部门') {
      return { success: false, message: '部门不可嵌套' }
    }
    
    if (parent.type === '门店' && data.type !== '部门') {
      return { success: false, message: '门店节点下只能创建部门' }
    }

    
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
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  
  if (data.type && !VALID_NODE_TYPES.includes(data.type as typeof VALID_NODE_TYPES[number])) {
    return { success: false, message: `无效的节点类型: ${data.type}` }
  }

  
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权编辑该节点' }
  }

  
  const [before] = await db.select().from(orgNodes).where(eq(orgNodes.id, id)).limit(1)

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
  
  if (!(await isNodeInScope(session, id))) {
    return { success: false, message: '无权操作该节点' }
  }

  
  const [child] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, id))
    .limit(1)
  if (child) {
    return { success: false, message: '该节点下存在子节点，请先删除子节点' }
  }

  
  const [empRef] = await db
    .select({ employeeId: staffWechatUsers.employeeId })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.orgNodeId, id))
    .limit(1)
  if (empRef) {
    return { success: false, message: '该节点下仍有员工，请先移除员工归属' }
  }

  
  const [storeRef] = await db
    .select({ storeId: stores.storeId })
    .from(stores)
    .where(eq(stores.orgNodeId, id))
    .limit(1)
  if (storeRef) {
    return { success: false, message: '该节点关联了门店，请先移除门店' }
  }

  
  const [roleRef] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(eq(permissionRoles.scopeId, id))
    .limit(1)
  if (roleRef) {
    return { success: false, message: '该节点被权限角色引用，请先移除关联权限' }
  }

  
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
