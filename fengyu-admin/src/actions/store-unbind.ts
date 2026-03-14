'use server'

import { db } from '@/db'
import { storeUnbindRequests } from '@db/store-unbind'
import { clientWechatUsers } from '@db/user'
import { stores } from '@db/org'
import { eq, desc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

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
    .orderBy(desc(storeUnbindRequests.createdAt))

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

  // 查找请求
  const [request] = await db
    .select()
    .from(storeUnbindRequests)
    .where(eq(storeUnbindRequests.requestId, requestId))
    .limit(1)

  if (!request) {
    return { success: false, message: '解绑申请不存在' }
  }
  if (request.status !== 'pending') {
    return { success: false, message: '该申请已处理' }
  }

  // 更新请求状态
  await db
    .update(storeUnbindRequests)
    .set({
      status: 'approved',
      reviewedBy: session.employeeId,
      reviewedAt: new Date(),
    })
    .where(eq(storeUnbindRequests.requestId, requestId))

  // 清除顾客的绑定门店
  await db
    .update(clientWechatUsers)
    .set({ boundStoreId: null, boundEmployeeId: null })
    .where(eq(clientWechatUsers.userId, request.userId))

  await logOperation(session, 'store_unbind.approve', 'store_unbind_request', requestId, {
    userId: request.userId, fromStoreId: request.fromStoreId,
  })

  revalidatePath('/stores')
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
  if (request.status !== 'pending') {
    return { success: false, message: '该申请已处理' }
  }

  await db
    .update(storeUnbindRequests)
    .set({
      status: 'rejected',
      reviewedBy: session.employeeId,
      reviewedAt: new Date(),
      rejectReason: reason,
    })
    .where(eq(storeUnbindRequests.requestId, requestId))

  await logOperation(session, 'store_unbind.reject', 'store_unbind_request', requestId, {
    userId: request.userId, reason,
  })

  revalidatePath('/stores')
  return { success: true, message: '解绑申请已拒绝' }
}
