'use server'

import { db } from '@/db'
import { storeUnbindRequests } from '@db/store-unbind'
import { clientWechatUsers } from '@db/user'
import { stores } from '@db/org'
import { eq, desc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logTransition } from '@/lib/operation-log'

export interface UnbindRequest {
  requestId: string
  userId: string
  customerName: string | null
  customerPhone: string | null
  fromStoreId: string
  fromStoreName: string | null
  status: string
  note: string | null
  rejectReason: string | null
  createdAt: string
}

export async function getUnbindRequests(): Promise<UnbindRequest[]> {
  const session = await getSession()
  requirePermission(session, 'store_unbind:list')

  const rows = await db
    .select({
      request: storeUnbindRequests,
      customerName: clientWechatUsers.name,
      customerPhone: clientWechatUsers.phone,
      fromStoreName: stores.storeName,
    })
    .from(storeUnbindRequests)
    .leftJoin(clientWechatUsers, eq(storeUnbindRequests.userId, clientWechatUsers.userId))
    .leftJoin(stores, eq(storeUnbindRequests.fromStoreId, stores.storeId))
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
    status: r.request.status,
    note: r.request.note,
    rejectReason: r.request.rejectReason,
    createdAt: r.request.createdAt.toISOString(),
  }))
}

export async function approveUnbind(requestId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'store_unbind:approve')

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
  if (!isInScope(session, request.fromStoreId)) {
    return { success: false, message: '无权操作该门店的解绑申请' }
  }

  // 更新请求状态 + 清除顾客绑定（原子事务，防止部分成功导致数据不一致）
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(storeUnbindRequests)
        .set({
          status: '已通过',
          reviewedBy: session.employeeId,
          reviewedAt: new Date(),
        })
        .where(eq(storeUnbindRequests.requestId, requestId))

      await tx
        .update(clientWechatUsers)
        .set({ boundStoreId: null, boundEmployeeId: null })
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
}

export async function rejectUnbind(
  requestId: string,
  reason: string
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'store_unbind:reject')

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
        reviewedAt: new Date(),
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
}
