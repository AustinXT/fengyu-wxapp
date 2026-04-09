'use server'

import { db } from '@/db'
import { messages } from '@db/message'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export interface AdminMessage {
  id: number
  recipientType: '客户' | '员工'
  recipientId: string
  title: string
  body: string | null
  messageType: string | null
  isRead: boolean
  refEntityType: string | null
  refEntityId: string | null
  createdAt: string
  /** JOIN 后的接收人显示名 */
  recipientName?: string
}

export interface MessageFilters {
  recipientType?: '客户' | '员工'
  messageType?: string
  isRead?: 'read' | 'unread'
  search?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

export interface PaginatedMessages {
  data: AdminMessage[]
  total: number
}

/**
 * 服务端分页消息列表
 *
 * messages 表无 store_id，不走 scope 过滤；该页面仅 admin 可见（管理员对全局消息做审计/清理）。
 * JOIN client_wechat_users / staff_wechat_users 用于展示接收人姓名。
 */
export async function getMessagesPaginated(
  filters: MessageFilters = {},
): Promise<PaginatedMessages> {
  const session = await getSession()
  requirePermission(session, 'message:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = []

  if (filters.recipientType) {
    conditions.push(eq(messages.recipientType, filters.recipientType))
  }
  if (filters.messageType) {
    conditions.push(eq(messages.messageType, filters.messageType))
  }
  if (filters.isRead === 'read') {
    conditions.push(eq(messages.isRead, true))
  } else if (filters.isRead === 'unread') {
    conditions.push(eq(messages.isRead, false))
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&')
    const pattern = `%${escaped}%`
    conditions.push(
      or(
        ilike(messages.title, pattern),
        ilike(messages.recipientId, pattern),
      ),
    )
  }
  if (filters.dateFrom) {
    conditions.push(gte(messages.createdAt, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lte(messages.createdAt, new Date(filters.dateTo + 'T23:59:59')))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  // 别名 JOIN：按 recipientType 匹配对应表，避免两表 ID 交叉
  const clientRecipient = alias(clientWechatUsers, 'client_recipient')
  const staffRecipient = alias(staffWechatUsers, 'staff_recipient')

  const [[countRow], rows] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(messages)
      .where(whereClause),
    db
      .select({
        message: messages,
        clientName: clientRecipient.name,
        staffName: staffRecipient.name,
      })
      .from(messages)
      .leftJoin(
        clientRecipient,
        and(
          eq(messages.recipientType, '客户'),
          eq(clientRecipient.userId, messages.recipientId),
        ) as SQL,
      )
      .leftJoin(
        staffRecipient,
        and(
          eq(messages.recipientType, '员工'),
          eq(staffRecipient.employeeId, messages.recipientId),
        ) as SQL,
      )
      .where(whereClause)
      .orderBy(desc(messages.createdAt))
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map((r) => {
      const m = r.message
      return {
        id: m.id,
        recipientType: m.recipientType as '客户' | '员工',
        recipientId: m.recipientId,
        title: m.title,
        body: m.body,
        messageType: m.messageType,
        isRead: m.isRead,
        refEntityType: m.refEntityType,
        refEntityId: m.refEntityId,
        createdAt: m.createdAt.toISOString(),
        recipientName:
          (m.recipientType === '客户' ? r.clientName : r.staffName) ?? undefined,
      }
    }),
    total: countRow?.count ?? 0,
  }
}

/**
 * 获取所有 message_type 用于筛选下拉
 */
export async function getMessageTypes(): Promise<string[]> {
  const session = await getSession()
  requirePermission(session, 'message:list')

  const rows = await db
    .selectDistinct({ messageType: messages.messageType })
    .from(messages)

  return rows
    .map((r) => r.messageType)
    .filter((t): t is string => t !== null && t !== '')
    .sort()
}

/**
 * 删除单条消息（物理删除）
 */
export async function deleteMessage(
  id: number,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'message:delete')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await db.delete(messages).where(eq(messages.id, id))

  if (result.count === 0) {
    return { success: false, message: '消息不存在或已被删除' }
  }

  await logOperation(session, 'message.delete', 'message', String(id))

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/messages')
  return { success: true, message: '消息已删除' }
}
