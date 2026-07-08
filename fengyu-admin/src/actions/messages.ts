'use server'

import { db } from '@/db'
import { messages } from '@db/message'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { orgNodes, stores } from '@db/org'
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import type { OrgNode, BatchMessageCustomer } from '@/lib/types'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'

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


export const getMessagesPaginated = withPermission(
  'message:list',
  async (
    _session,
    filters: MessageFilters = {},
  ): Promise<PaginatedMessages> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [isNull(messages.deletedAt)]

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
    
    conditions.push(gte(messages.createdAt, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    conditions.push(lte(messages.createdAt, beijingBoundaryTs(filters.dateTo, '23:59:59')))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  
  
  const clientRecipient = alias(clientWechatUsers, 'client_recipient') as unknown as typeof clientWechatUsers
  const staffRecipient = alias(staffWechatUsers, 'staff_recipient') as unknown as typeof staffWechatUsers

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
  },
)


export const getMessageTypes = withPermission(
  'message:list',
  async (): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ messageType: messages.messageType })
    .from(messages)
    .where(isNull(messages.deletedAt))

  return rows
    .map((r) => r.messageType)
    .filter((t): t is string => t !== null && t !== '')
    .sort()
  },
)


export const deleteMessage = withPermission(
  'message:delete',
  async (
    session,
    id: number,
  ): Promise<{ success: boolean; message: string }> => {
    const [snapshot] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), isNull(messages.deletedAt)))
      .limit(1)

    if (!snapshot) {
      return { success: false, message: '消息不存在或已被删除' }
    }

    await logOperation(session, 'message.delete', 'message', String(id), {
      snapshot: {
        id: snapshot.id,
        recipientType: snapshot.recipientType,
        recipientId: snapshot.recipientId,
        title: snapshot.title,
        messageType: snapshot.messageType,
        isRead: snapshot.isRead,
        createdAt: snapshot.createdAt,
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await db
      .update(messages)
      .set({ deletedAt: nowTs(), deletedBy: session.employeeId })
      .where(and(eq(messages.id, id), isNull(messages.deletedAt)))

    if (result.count === 0) {
      return { success: false, message: '消息状态变更，请刷新重试' }
    }

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/messages')
    return { success: true, message: '消息已删除' }
  },
)






const BATCH_SEND_MAX = 1000


async function resolveOrgNodeToStoreIds(orgNodeId: string): Promise<string[] | null> {
  const [node] = await db
    .select({ type: orgNodes.type, parentId: orgNodes.parentId })
    .from(orgNodes)
    .where(eq(orgNodes.id, orgNodeId))
    .limit(1)

  if (!node) return null
  if (node.type === '总部') return null

  if (node.type === '门店') {
    const [store] = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .where(eq(stores.orgNodeId, orgNodeId))
      .limit(1)
    return store ? [store.storeId] : []
  }

  if (node.type === '市场') {
    const storeRows = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, orgNodeId))
    return storeRows.map((r) => r.storeId)
  }

  return null
}


async function buildBatchMessageCustomerWhere(filters: {
  orgNodeId?: string
  memberLevel?: string
  search?: string
}): Promise<SQL | undefined | null> {
  const conditions: (SQL | undefined)[] = []

  if (filters.orgNodeId) {
    const storeIds = await resolveOrgNodeToStoreIds(filters.orgNodeId)
    if (storeIds !== null) {
      if (storeIds.length === 0) return null
      if (storeIds.length === 1) {
        conditions.push(eq(clientWechatUsers.boundStoreId, storeIds[0]))
      } else {
        conditions.push(inArray(clientWechatUsers.boundStoreId, storeIds))
      }
    }
  }

  if (filters.memberLevel) {
    conditions.push(
      eq(
        clientWechatUsers.memberLevel,
        filters.memberLevel as typeof clientWechatUsers.memberLevel.enumValues[number],
      ),
    )
  }

  if (filters.search) {
    const pattern = `%${filters.search.replace(/[%_]/g, '\\$&')}%`
    conditions.push(
      or(
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
      ),
    )
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}


export const getOrgNodesForBatchMessage = withPermission(
  'message:send',
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


export const getCustomersForBatchMessage = withPermission(
  'message:send',
  async (
    _session,
    filters: {
      orgNodeId?: string
      memberLevel?: string
      search?: string
      page?: number
      pageSize?: number
    },
  ): Promise<{ data: BatchMessageCustomer[]; total: number }> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const whereClause = await buildBatchMessageCustomerWhere({
    orgNodeId: filters.orgNodeId,
    memberLevel: filters.memberLevel,
    search: filters.search,
  })
  if (whereClause === null) {
    return { data: [], total: 0 }
  }

  const [[countRow], rows] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(clientWechatUsers)
      .where(whereClause),
    db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        storeName: stores.storeName,
        memberLevel: clientWechatUsers.memberLevel,
      })
      .from(clientWechatUsers)
      .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
      .where(whereClause)
      
      .orderBy(asc(clientWechatUsers.name))
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      phone: r.phone,
      storeName: r.storeName ?? null,
      memberLevel: r.memberLevel,
    })),
    total: countRow?.count ?? 0,
  }
  },
)

export interface BatchSendMessagesParams {
  title: string
  body?: string
  messageType?: string
  
  userIds?: string[]
  
  filters?: {
    orgNodeId?: string
    memberLevel?: string
    search?: string
  }
}


export const batchSendMessages = withPermission(
  'message:send',
  async (
    session,
    params: BatchSendMessagesParams,
  ): Promise<{ success: boolean; message: string; count?: number }> => {
  
  const title = params.title?.trim() ?? ''
  if (!title) {
    return { success: false, message: '请输入消息标题' }
  }
  if (title.length > 200) {
    return { success: false, message: '消息标题不能超过 200 个字符' }
  }
  const body = params.body?.trim() || null
  const messageType = params.messageType?.trim() || null
  if (messageType && messageType.length > 50) {
    return { success: false, message: '消息分类不能超过 50 个字符' }
  }

  
  let recipientIds: string[] = []

  if (params.userIds && params.userIds.length > 0) {
    
    const unique = [...new Set(params.userIds)]
    if (unique.length > BATCH_SEND_MAX) {
      return { success: false, message: `单次批量发送不能超过 ${BATCH_SEND_MAX} 人` }
    }
    const existing = await db
      .select({ userId: clientWechatUsers.userId })
      .from(clientWechatUsers)
      .where(inArray(clientWechatUsers.userId, unique))
    const existingSet = new Set(existing.map((e) => e.userId))
    recipientIds = unique.filter((id) => existingSet.has(id))
    if (recipientIds.length === 0) {
      return { success: false, message: '所选顾客均不存在或已被删除' }
    }
  } else if (params.filters) {
    
    const whereClause = await buildBatchMessageCustomerWhere(params.filters)
    if (whereClause === null) {
      return { success: false, message: '所选组织下暂无顾客，无需发送' }
    }
    
    const [{ count }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(clientWechatUsers)
      .where(whereClause)
    if (count === 0) {
      return { success: false, message: '当前筛选条件下没有匹配的顾客' }
    }
    if (count > BATCH_SEND_MAX) {
      return {
        success: false,
        message: `筛选结果 ${count} 人，超过单次上限 ${BATCH_SEND_MAX}，请缩小范围`,
      }
    }
    const rows = await db
      .select({ userId: clientWechatUsers.userId })
      .from(clientWechatUsers)
      .where(whereClause)
    recipientIds = rows.map((r) => r.userId)
  } else {
    return { success: false, message: '请指定接收人（选择顾客或设置筛选条件）' }
  }

  
  const values = recipientIds.map((userId) => ({
    recipientType: '客户' as const,
    recipientId: userId,
    title,
    body,
    messageType,
    isRead: false,
    createdAt: nowTs(),
  }))

  
  const CHUNK = 500
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(messages).values(values.slice(i, i + CHUNK))
  }

  
  await logOperation(session, 'message.batchSend', 'message', 'batch', {
    title,
    messageType,
    count: recipientIds.length,
    mode: params.userIds ? 'userIds' : 'filters',
    filters: params.filters,
  })

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/messages')
  return {
    success: true,
    message: `已向 ${recipientIds.length} 位顾客发送消息`,
    count: recipientIds.length,
  }
  },
)
