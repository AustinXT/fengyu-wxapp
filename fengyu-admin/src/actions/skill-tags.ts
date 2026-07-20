'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { skillTags } from '@db/lookup'
import { staffWechatUsers } from '@db/user'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SkillTag } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'

function rowToSkillTag(row: typeof skillTags.$inferSelect): SkillTag {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
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

export const createSkillTag = withPermission(
  'employee:update',
  async (
    session,
    data: {
      id: string
      name: string
      sortOrder?: number
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
      })
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '该标签名称已存在' }
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
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 空名守卫（与 createSkillTag 一致）
    if (data.name !== undefined && !data.name.trim()) {
      return { success: false, message: '请输入标签名称' }
    }

    // 读旧值（改名判定 + 审计 diff + 级联 array_replace 的 oldName）
    const [before] = await db.select().from(skillTags).where(eq(skillTags.id, id)).limit(1)
    if (!before) {
      return { success: false, message: '标签不存在' }
    }
    const oldName = before.name
    const trimmedName = data.name === undefined ? undefined : data.name.trim()
    // 仅当显式传名、且与旧名不同时才视为改名（sortOrder 变更不触发员工级联）
    const nameChanged = trimmedName !== undefined && trimmedName !== oldName

    // 透传 payload（name 归一为 trim 值）
    const setData: Partial<{ name: string; sortOrder: number }> = { ...data }
    if (trimmedName !== undefined) setData.name = trimmedName

    const whereConditions = expectedUpdatedAt
      ? and(eq(skillTags.id, id), sql`date_trunc('milliseconds', ${skillTags.updatedAt}) = ${expectedUpdatedAt}`)
      : eq(skillTags.id, id)

    // 事务：① 改名级联 array_replace 员工 skills（仅改名）；② 更新字典行（乐观锁 + 唯一约束）。
    // 任一失败整体回滚（含已执行的级联），保证字典表与员工 skills 不脱节。
    let affectedStaff = 0
    try {
      affectedStaff = await db.transaction(async (tx) => {
        let cascadeCount = 0
        if (nameChanged) {
          const cascade = await tx
            .update(staffWechatUsers)
            .set({ skills: sql`array_replace(${staffWechatUsers.skills}, ${oldName}, ${trimmedName})` })
            .where(sql`${oldName} = ANY(${staffWechatUsers.skills})`)
          cascadeCount = (cascade as any).count ?? 0
        }
        let result: any
        try {
          result = await tx.update(skillTags).set(setData).where(whereConditions)
        } catch (err: any) {
          if (pgErrorCode(err) === '23505') throw new Error('SKILL_TAG_DUP_NAME')
          throw err
        }
        if ((result as any).count === 0) throw new Error('SKILL_TAG_OPTIMISTIC_MISS')
        return cascadeCount
      })
    } catch (e) {
      if (e instanceof Error && e.message === 'SKILL_TAG_DUP_NAME') {
        return { success: false, message: '该标签名称已存在' }
      }
      if (e instanceof Error && e.message === 'SKILL_TAG_OPTIMISTIC_MISS') {
        return {
          success: false,
          message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '标签不存在',
        }
      }
      throw e
    }

    await logUpdate(
      session,
      'skillTag.update',
      'skill_tag',
      id,
      before as Record<string, unknown>,
      nameChanged ? { ...setData, affectedStaff } : setData,
    )
    revalidatePath('/employees')
    return { success: true, message: '标签已更新' }
  },
)

export const deleteSkillTag = withPermission(
  'employee:update',
  async (session, id: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)

    // 先查 name（级联 array_remove 按名匹配；字典行删后无法回查）
    const [before] = await db
      .select({ name: skillTags.name })
      .from(skillTags)
      .where(eq(skillTags.id, id))
      .limit(1)
    if (!before) {
      return { success: false, message: '标签不存在' }
    }
    const name = before.name

    // 事务：① 从员工 skills 移除该名；② 删 skill_tags 行。任一失败整体回滚，
    // 保证「字典行不存在 ⇒ 员工身上也不留该名」（修复历史删除不级联 bug）。
    let affectedStaff = 0
    try {
      affectedStaff = await db.transaction(async (tx) => {
        const cascade = await tx
          .update(staffWechatUsers)
          .set({ skills: sql`array_remove(${staffWechatUsers.skills}, ${name})` })
          .where(sql`${name} = ANY(${staffWechatUsers.skills})`)
        const del = await tx.delete(skillTags).where(eq(skillTags.id, id))
        // 并发已被删 → 回滚级联，对外报「不存在」
        if ((del as any).count === 0) throw new Error('SKILL_TAG_GONE')
        return (cascade as any).count ?? 0
      })
    } catch (e) {
      if (e instanceof Error && e.message === 'SKILL_TAG_GONE') {
        return { success: false, message: '标签不存在' }
      }
      throw e
    }

    await logOperation(session, 'skillTag.delete', 'skill_tag', id, { name, affectedStaff })
    revalidatePath('/employees')
    return { success: true, message: '标签已删除' }
  },
)
