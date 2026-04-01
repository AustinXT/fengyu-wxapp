'use server'

import { db } from '@/db'
import { skillTags } from '@db/lookup'
import { eq, and, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SkillTag } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

function rowToSkillTag(row: typeof skillTags.$inferSelect): SkillTag {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    isValid: row.isValid,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  }
}

/** 全量查询技能标签 */
export async function getSkillTags(): Promise<SkillTag[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(skillTags)
    .orderBy(skillTags.sortOrder)

  return rows.map(rowToSkillTag)
}

/** 查询启用中的技能标签（用于选项） */
export async function getActiveSkillTags(): Promise<SkillTag[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(skillTags)
    .where(eq(skillTags.isValid, true))
    .orderBy(skillTags.sortOrder)

  return rows.map(rowToSkillTag)
}

export async function createSkillTag(data: {
  id: string
  name: string
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  if (!data.name?.trim()) {
    return { success: false, message: '请输入标签名称' }
  }

  try {
    await db.insert(skillTags).values({
      id: data.id,
      name: data.name.trim(),
      sortOrder: data.sortOrder ?? 0,
      isValid: data.isValid ?? true,
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '该标签名称已存在' }
    throw err
  }

  await logOperation(session, 'skillTag.create', 'skill_tag', data.id, { name: data.name })
  revalidatePath('/employees')
  return { success: true, message: '标签创建成功' }
}

export async function updateSkillTag(
  id: string,
  data: Partial<{
    name: string
    sortOrder: number
    isValid: boolean
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(skillTags.id, id), sql`date_trunc('milliseconds', ${skillTags.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(skillTags.id, id)

  let result: any
  try {
    result = await db.update(skillTags).set(data).where(whereConditions)
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '该标签名称已存在' }
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '标签不存在',
    }
  }

  await logOperation(session, 'skillTag.update', 'skill_tag', id, data)
  revalidatePath('/employees')
  return { success: true, message: '标签已更新' }
}

export async function deleteSkillTag(id: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  const result = await db.delete(skillTags).where(eq(skillTags.id, id))

  if ((result as any).count === 0) {
    return { success: false, message: '标签不存在' }
  }

  await logOperation(session, 'skillTag.delete', 'skill_tag', id, {})
  revalidatePath('/employees')
  return { success: true, message: '标签已删除' }
}
