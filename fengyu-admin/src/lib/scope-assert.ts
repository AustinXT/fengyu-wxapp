

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { AuthSession } from './types'
import { isAdminScope, isInScope } from './permissions'


export async function assertCustomerInScope(
  session: AuthSession,
  clientUserId: string,
): Promise<{ boundStoreId: string | null }> {
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')

  const rows = (await db.execute(sql`
    SELECT bound_store_id FROM client_wechat_users WHERE user_id = ${clientUserId}
  `)) as unknown as Array<{ bound_store_id: string | null }>

  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不存在')
  }
  const boundStoreId = rows[0].bound_store_id
  if (isAdminScope(session)) return { boundStoreId }
  if (!boundStoreId || !isInScope(session, boundStoreId)) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前门店范围内')
  }
  return { boundStoreId }
}


export async function assertOrderInScope(
  session: AuthSession,
  saleOrderId: string,
): Promise<{ storeId: string | null }> {
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const rows = (await db.execute(sql`
    SELECT store_id FROM sale_orders WHERE sale_order_id = ${saleOrderId}
  `)) as unknown as Array<{ store_id: string | null }>

  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 订单不存在')
  }
  const storeId = rows[0].store_id
  if (isAdminScope(session)) return { storeId }
  if (!storeId || !isInScope(session, storeId)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  return { storeId }
}


export async function assertEmployeeInScope(
  session: AuthSession,
  employeeId: string,
): Promise<{ storeId: string | null }> {
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')

  const rows = (await db.execute(sql`
    SELECT store_id FROM staff_wechat_users WHERE employee_id = ${employeeId}
  `)) as unknown as Array<{ store_id: string | null }>

  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 员工不存在')
  }
  const storeId = rows[0].store_id
  if (isAdminScope(session)) return { storeId }
  if (!storeId || !isInScope(session, storeId)) {
    throw new Error('PERMISSION_DENIED: 员工不在当前门店范围内')
  }
  return { storeId }
}
