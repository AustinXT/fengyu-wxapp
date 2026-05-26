'use server'

import { db } from '@/db'
import { skillTags } from '@db/lookup'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SkillTag } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'

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
export const getSkillTags = withPermission('employee:list', async (): Promise<SkillTag[]> => {
  const rows = await db
    .select()
    .from(skillTags)
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(skillTags.sortOrder))

  return rows.map(rowToSkillTag)
})

/** 查询启用中的技能标签（用于选项） */
export const getActiveSkillTags = withPermission('employee:list', async (): Promise<SkillTag[]> => {
  const rows = await db
    .select()
    .from(skillTags)
    .where(eq(skillTags.isValid, true))
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(skillTags.sortOrder))

  return rows.map(rowToSkillTag)
})

export const createSkillTag = withPermission(
  'employee:update',
  async (
    session,
    data: {
      id: string
      name: string
      sortOrder?: number
      isValid?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
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
  },
)

export const updateSkillTag = withPermission(
  'employee:update',
  async (
    session,
    id: string,
    data: Partial<{
      name: string
      sortOrder: number
      isValid: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(skillTags).where(eq(skillTags.id, id)).limit(1)

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

    await logUpdate(session, 'skillTag.update', 'skill_tag', id, before as Record<string, unknown>, data)
    revalidatePath('/employees')
    return { success: true, message: '标签已更新' }
  },
)

export const deleteSkillTag = withPermission(
  'employee:update',
  async (session, id: string): Promise<{ success: boolean; message: string }> => {
    const result = await db.delete(skillTags).where(eq(skillTags.id, id))

    if ((result as any).count === 0) {
      return { success: false, message: '标签不存在' }
    }

    await logOperation(session, 'skillTag.delete', 'skill_tag', id, {})
    revalidatePath('/employees')
    return { success: true, message: '标签已删除' }
  },
)
