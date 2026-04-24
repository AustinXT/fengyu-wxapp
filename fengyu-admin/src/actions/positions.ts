'use server'

import { db } from '@/db'
import { positions } from '@db/lookup'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Position, PositionScope } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'

function rowToPosition(row: typeof positions.$inferSelect): Position {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as PositionScope,
    sortOrder: row.sortOrder,
    isValid: row.isValid,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  }
}

/** 全量查询职位列表 */
export async function getPositions(): Promise<Position[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(positions)
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(positions.scope), asc(positions.sortOrder))

  return rows.map(rowToPosition)
}

/** 查询启用中的职位（用于下拉选项） */
export async function getActivePositions(): Promise<Position[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(positions)
    .where(eq(positions.isValid, true))
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(positions.scope), asc(positions.sortOrder))

  return rows.map(rowToPosition)
}

export async function createPosition(data: {
  id: string
  name: string
  scope: PositionScope
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  if (!data.name?.trim()) {
    return { success: false, message: '请输入职位名称' }
  }

  try {
    await db.insert(positions).values({
      id: data.id,
      name: data.name.trim(),
      scope: data.scope,
      sortOrder: data.sortOrder ?? 0,
      isValid: data.isValid ?? true,
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '该层级下已存在同名职位' }
    throw err
  }

  await logOperation(session, 'position.create', 'position', data.id, { name: data.name, scope: data.scope })
  revalidatePath('/employees')
  return { success: true, message: '职位创建成功' }
}

export async function updatePosition(
  id: string,
  data: Partial<{
    name: string
    scope: PositionScope
    sortOrder: number
    isValid: boolean
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(positions).where(eq(positions.id, id)).limit(1)

  const whereConditions = expectedUpdatedAt
    ? and(eq(positions.id, id), sql`date_trunc('milliseconds', ${positions.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(positions.id, id)

  let result: any
  try {
    result = await db.update(positions).set(data).where(whereConditions)
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '该层级下已存在同名职位' }
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '职位不存在',
    }
  }

  await logUpdate(session, 'position.update', 'position', id, before as Record<string, unknown>, data)
  revalidatePath('/employees')
  return { success: true, message: '职位已更新' }
}

export async function deletePosition(id: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  const result = await db.delete(positions).where(eq(positions.id, id))

  if ((result as any).count === 0) {
    return { success: false, message: '职位不存在' }
  }

  await logOperation(session, 'position.delete', 'position', id, {})
  revalidatePath('/employees')
  return { success: true, message: '职位已删除' }
}
