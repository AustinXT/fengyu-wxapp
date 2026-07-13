'use server'

import { db } from '@/db'
import { storeUnbindRequests } from '@db/store-unbind'
import { clientWechatUsers } from '@db/user'
import { stores } from '@db/org'
import { eq, desc } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope, requireAdmin } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logTransition, logOperation } from '@/lib/operation-log'
import { nowTs } from '@/lib/db-time'

export interface UnbindRequest {
  requestId: string
  userId: string
  customerName: string | null
  customerPhone: string | null
  fromStoreId: string
  fromStoreName: string | null
  toStoreId: string | null
  toStoreName: string | null
  status: string
  note: string | null
  rejectReason: string | null
  createdAt: string
}

export const getUnbindRequests = withPermission(
  'store_unbind:list',
  async (session): Promise<UnbindRequest[]> => {
  // drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
  const toStores = alias(stores, 'to_stores') as unknown as typeof stores
  const rows = await db
    .select({
      request: storeUnbindRequests,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fromStoreName: stores.storeName,
      toStoreName: toStores.storeName,
    })
    .from(storeUnbindRequests)
    .leftJoin(clientWechatUsers, eq(storeUnbindRequests.userId, clientWechatUsers.userId))
    .leftJoin(stores, eq(storeUnbindRequests.fromStoreId, stores.storeId))
    .leftJoin(toStores, eq(storeUnbindRequests.toStoreId, toStores.storeId))
    .where(scopeCondition(session, storeUnbindRequests.fromStoreId))
    // 默认排序：最近审批/更新的解绑申请浮顶（admin.sys.spec.md §5）
    .orderBy(desc(storeUnbindRequests.updatedAt), desc(storeUnbindRequests.createdAt))
    .limit(500)

  return rows.map((r) => ({
    requestId: r.request.requestId,
    userId: r.request.userId,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    fromStoreId: r.request.fromStoreId,
    fromStoreName: r.fromStoreName,
    toStoreId: r.request.toStoreId,
    toStoreName: r.toStoreName,
    status: r.request.status,
    note: r.request.note,
    rejectReason: r.request.rejectReason,
    createdAt: r.request.createdAt.toISOString(),
  }))
  },
)

export const approveUnbind = withPermission(
  'store_unbind:approve',
  async (session, requestId: string): Promise<{ success: boolean; message: string }> => {
  // 查找请求并校验 scope
  const [request] = await db
    .select()
    .from(storeUnbindRequests)
    .where(eq(storeUnbindRequests.requestId, requestId))
    .limit(1)

  if (!request) {
    return { success: false, message: '解绑申请不存在' }
  }
  if (request.status !== '待处理') {
    return { success: false, message: '该申请已处理' }
  }
  if (!request.toStoreId) {
    return { success: false, message: '申请缺少目标门店，无法转店' }
  }
  if (!isInScope(session, request.fromStoreId)) {
    return { success: false, message: '无权操作该门店的解绑申请' }
  }

  // 更新请求状态 + 把顾客门店从 from 转绑到 to（原子事务，防止部分成功导致数据不一致）
  // 转店仅改门店绑定 + 清美容师绑定，不动 customer_source（获客来源是历史属性，转店不改它）
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(storeUnbindRequests)
        .set({
          status: '已通过',
          reviewedBy: session.employeeId,
          reviewedAt: nowTs(),
        })
        .where(eq(storeUnbindRequests.requestId, requestId))

      await tx
        .update(clientWechatUsers)
        .set({ boundStoreId: request.toStoreId, boundEmployeeId: null, boundEmployeeName: null })
        .where(eq(clientWechatUsers.userId, request.userId))
    })
  } catch {
    return { success: false, message: '审批解绑失败，请稍后重试' }
  }

  await logTransition(session, 'store_unbind.approve', 'store_unbind_request', requestId, '待处理', '已通过', {
    userId: request.userId, fromStoreId: request.fromStoreId,
  })

  revalidatePath('/store-unbind')
  return { success: true, message: '解绑申请已通过' }
  },
)

export const rejectUnbind = withPermission(
  'store_unbind:reject',
  async (
    session,
    requestId: string,
    reason: string,
  ): Promise<{ success: boolean; message: string }> => {
  const [request] = await db
    .select()
    .from(storeUnbindRequests)
    .where(eq(storeUnbindRequests.requestId, requestId))
    .limit(1)

  if (!request) {
    return { success: false, message: '解绑申请不存在' }
  }
  if (request.status !== '待处理') {
    return { success: false, message: '该申请已处理' }
  }
  if (!isInScope(session, request.fromStoreId)) {
    return { success: false, message: '无权操作该门店的解绑申请' }
  }

  try {
    await db
      .update(storeUnbindRequests)
      .set({
        status: '已拒绝',
        reviewedBy: session.employeeId,
        reviewedAt: nowTs(),
        rejectReason: reason,
      })
      .where(eq(storeUnbindRequests.requestId, requestId))
  } catch {
    return { success: false, message: '驳回解绑失败，请稍后重试' }
  }

  await logTransition(session, 'store_unbind.reject', 'store_unbind_request', requestId, '待处理', '已拒绝', {
    userId: request.userId, reason,
  })

  revalidatePath('/store-unbind')
  return { success: true, message: '解绑申请已拒绝' }
  },
)

/**
 * 物理删除解绑申请（仅系统管理员；数据治理用，清理已处理的历史申请）。
 *
 * 守卫：仅「已通过 / 已拒绝 / 已取消」可删，'待处理'（进行中）禁删。
 * store_unbind_requests 无 inbound FK，直接删。
 */
export const deleteUnbindRequest = withPermission(
  'store_unbind:delete',
  async (session, requestId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [request] = await db
      .select({ status: storeUnbindRequests.status, fromStoreId: storeUnbindRequests.fromStoreId, userId: storeUnbindRequests.userId })
      .from(storeUnbindRequests)
      .where(eq(storeUnbindRequests.requestId, requestId))
      .limit(1)

    if (!request) {
      return { success: false, message: '解绑申请不存在' }
    }
    if (!isInScope(session, request.fromStoreId)) {
      return { success: false, message: '无权操作该门店的解绑申请' }
    }
    if (request.status === '待处理') {
      return { success: false, message: '待处理申请不可删除，请先通过或拒绝' }
    }

    const result = await db
      .delete(storeUnbindRequests)
      .where(eq(storeUnbindRequests.requestId, requestId))
    if ((result as any).count === 0) {
      return { success: false, message: '解绑申请已变更，请刷新重试' }
    }

    await logOperation(session, 'store_unbind.delete', 'store_unbind_request', requestId, {
      snapshot: { status: request.status, fromStoreId: request.fromStoreId, userId: request.userId },
    })

    revalidatePath('/store-unbind')
    return { success: true, message: '解绑申请已删除' }
  },
)
