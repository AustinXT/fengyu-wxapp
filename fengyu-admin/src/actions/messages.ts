'use server'

import { db } from '@/db'
import { messages } from '@db/message'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { orgNodes, stores } from '@db/org'
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { withPermission } from '@/lib/with-permission'
import { isAdminScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import type { OrgNode, BatchMessageCustomer } from '@/lib/types'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'
import { resolveOrgNodeToStoreIds } from '@/lib/org-scope'

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
  marketId?: string    // 市场 org_node_id
  storeId?: string     // 门店 store_id
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
 * 2026-08-05 改：添加市场-门店筛选 + scope 过滤。
 * - 客户消息：通过 client_wechat_users.bound_store_id 关联门店，按 scope 过滤
 * - 员工消息：通过 staff_wechat_users → stores.store_id 关联门店，按 scope 过滤
 * - admin 不受 scope 限制，可查看全部消息
 *
 * JOIN client_wechat_users / staff_wechat_users 用于展示接收人姓名。
 */
export const getMessagesPaginated = withPermission(
  'message:list',
  async (
    session,
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
    // 日期串拼北京字面 timestamp（created_at 库存北京字面）；不经 new Date（date-only 串 UTC 午夜解析→+8h）。
    conditions.push(gte(messages.createdAt, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    conditions.push(lte(messages.createdAt, beijingBoundaryTs(filters.dateTo, '23:59:59')))
  }

  // scope 过滤（非 admin）+ 市场/门店筛选（所有角色）
  // 策略：通过接收人表（client_wechat_users / staff_wechat_users）的 bound_store_id / store_id 过滤
  let scopeStoreIds: string[] | null = null
  if (!isAdminScope(session)) {
    scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0) {
      // 无门店权限，返回空
      return { data: [], total: 0 }
    }
  }

  // 市场筛选：展开为门店 ID 列表
  let marketStoreIds: string[] | null = null
  if (filters.marketId) {
    marketStoreIds = await resolveOrgNodeToStoreIds(filters.marketId)
    if (marketStoreIds !== null && marketStoreIds.length === 0) {
      return { data: [], total: 0 }
    }
  }

  // 门店筛选
  const singleStoreId = filters.storeId || null

  // 合并 scope + 市场 + 门店筛选
  let finalStoreIds: string[] | null = null
  if (scopeStoreIds) {
    finalStoreIds = scopeStoreIds
    if (marketStoreIds) {
      finalStoreIds = finalStoreIds.filter((id) => marketStoreIds!.includes(id))
    }
    if (singleStoreId) {
      finalStoreIds = finalStoreIds.filter((id) => id === singleStoreId)
    }
  } else {
    if (marketStoreIds) {
      finalStoreIds = marketStoreIds
      if (singleStoreId) {
        finalStoreIds = finalStoreIds.filter((id) => id === singleStoreId)
      }
    } else if (singleStoreId) {
      finalStoreIds = [singleStoreId]
    }
  }

  if (finalStoreIds && finalStoreIds.length === 0) {
    return { data: [], total: 0 }
  }

  // 别名 JOIN：按 recipientType 匹配对应表，避免两表 ID 交叉
  // drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
  const clientRecipient = alias(clientWechatUsers, 'client_recipient') as unknown as typeof clientWechatUsers
  const staffRecipient = alias(staffWechatUsers, 'staff_recipient') as unknown as typeof staffWechatUsers

  // 根据门店过滤条件构建 JOIN 条件
  // 客户消息：通过 client_wechat_users.bound_store_id
  // 员工消息：直接使用 staff_wechat_users.store_id。
  let clientJoinCondition: SQL = and(
    eq(messages.recipientType, '客户'),
    eq(clientRecipient.userId, messages.recipientId),
  ) as SQL

  if (finalStoreIds) {
    if (finalStoreIds.length === 1) {
      clientJoinCondition = and(
        clientJoinCondition,
        eq(clientRecipient.boundStoreId, finalStoreIds[0]),
      ) as SQL
    } else {
      clientJoinCondition = and(
        clientJoinCondition,
        inArray(clientRecipient.boundStoreId, finalStoreIds),
      ) as SQL
    }
  }

  let staffJoinCondition: SQL = and(
    eq(messages.recipientType, '员工'),
    eq(staffRecipient.employeeId, messages.recipientId),
  ) as SQL

  if (finalStoreIds) {
    staffJoinCondition = and(
      staffJoinCondition,
      finalStoreIds.length === 1
        ? eq(staffRecipient.storeId, finalStoreIds[0])
        : inArray(staffRecipient.storeId, finalStoreIds),
    ) as SQL
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const [[countRow], rows] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(messages)
      .leftJoin(
        clientRecipient,
        clientJoinCondition,
      )
      .leftJoin(
        staffRecipient,
        staffJoinCondition,
      )
      .where(
        finalStoreIds
          ? and(
              whereClause,
              or(
                and(eq(messages.recipientType, '客户'), isNotNull(clientRecipient.userId)),
                and(eq(messages.recipientType, '员工'), isNotNull(staffRecipient.employeeId)),
              ),
            )
          : whereClause
      ),
    db
      .select({
        message: messages,
        clientName: clientRecipient.name,
        staffName: staffRecipient.name,
      })
      .from(messages)
      .leftJoin(
        clientRecipient,
        clientJoinCondition,
      )
      .leftJoin(
        staffRecipient,
        staffJoinCondition,
      )
      .where(
        finalStoreIds
          ? and(
              whereClause,
              or(
                and(eq(messages.recipientType, '客户'), isNotNull(clientRecipient.userId)),
                and(eq(messages.recipientType, '员工'), isNotNull(staffRecipient.employeeId)),
              ),
            )
          : whereClause
      )
      // 例外：消息流水表无 updatedAt 列
      .orderBy(desc(messages.createdAt), desc(messages.id))
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

/**
 * 获取所有 message_type 用于筛选下拉
 */
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

/**
 * 删除单条消息（软删除）
 *
 * 流程：1) SELECT snapshot 用于 log；2) logOperation 携带快照（sanitize 自动跑）；3) UPDATE 置 deleted_at/by。
 * 历史 detail/recipient 等 PII 字段由 logOperation 内的 sanitizeDetail 在入库前脱敏。
 */
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

// ----------------------------------------------------------------------------
// 批量发送消息相关 Actions
// ----------------------------------------------------------------------------

/** 单次批量发送的最大接收人数 */
const BATCH_SEND_MAX = 1000

/**
 * 构造"批量发送消息"场景下的客户筛选 WHERE 条件。
 * 返回 `null` 表示"存在筛选但无匹配门店"（调用方应直接返回空集而非查询）。
 */
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

/**
 * 组织树节点列表（批量发送消息筛选用）。
 * 权限走 message:send，避免依赖 org:list。
 */
export const getOrgNodesForBatchMessage = withPermission(
  'message:send',
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

/**
 * 批量发送消息时的顾客分页列表。
 * 不要求顾客有手机号（消息中心按 userId 投递，与优惠券不同）。
 */
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
      // 例外：picker 字母序
      .orderBy(asc(clientWechatUsers.name), asc(clientWechatUsers.userId))
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
  /** 精确投递：指定顾客 userId 列表（与 filters 二选一；两者都提供时以 userIds 为准） */
  userIds?: string[]
  /** 筛选投递：按当前筛选条件命中的全部顾客（上限 BATCH_SEND_MAX） */
  filters?: {
    orgNodeId?: string
    memberLevel?: string
    search?: string
  }
}

/**
 * 批量发送站内消息给多个客户。
 *
 * 两种投递模式：
 * 1. 精确投递：传 `userIds`，直接向指定顾客发送
 * 2. 筛选投递：传 `filters`，展开命中顾客后发送（总数 > BATCH_SEND_MAX 拒绝）
 *
 * 消息仅允许 recipient_type='客户'（员工消息暂不支持批量发送）。
 */
export const batchSendMessages = withPermission(
  'message:send',
  async (
    session,
    params: BatchSendMessagesParams,
  ): Promise<{ success: boolean; message: string; count?: number }> => {
  // 1. 基础校验
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

  // 2. 解析接收人 userId 列表
  let recipientIds: string[] = []

  if (params.userIds && params.userIds.length > 0) {
    // 精确投递：去重 + 校验存在
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
    // 筛选投递：展开命中顾客
    const whereClause = await buildBatchMessageCustomerWhere(params.filters)
    if (whereClause === null) {
      return { success: false, message: '所选组织下暂无顾客，无需发送' }
    }
    // 先 count，防止超限后才知道
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

  // 3. 构造消息行（createdAt 走 NOW() 写北京墙钟字面，见 lib/db-time）
  const values = recipientIds.map((userId) => ({
    recipientType: '客户' as const,
    recipientId: userId,
    title,
    body,
    messageType,
    isRead: false,
    createdAt: nowTs(),
  }))

  // 4. 分片 INSERT（防止单次 values 过大；1000 条以内其实单次也能处理，分片兜底）
  const CHUNK = 500
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(messages).values(values.slice(i, i + CHUNK))
  }

  // 5. 审计日志
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
