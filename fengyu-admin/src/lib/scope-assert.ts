/**
 * Scope 边界守卫（assert helpers）
 *
 * SUMMARY v3 §2 #13 / ticket notes/tickets/2026-05-17-scope-helper-cross-end-audit.md
 *
 * 与 fengyu-staff/cloudfunctions/staffApi/utils/scope.js 的 assertXxxInScope 同语义：
 *   - 读取目标实体的 store_id
 *   - 不在 scope 内 → 抛 PERMISSION_DENIED:* 错误（admin 端 throw 由 server action 边界捕获）
 *   - 在 scope 内 → 返回 storeId 供调用方复用
 *
 * 跨端不变量（双端 snapshot 守护见 staffApi cross-end-sql-snapshot.test.js）：
 *   - 错误前缀统一 PERMISSION_DENIED:*（与 staff 端 throw 模式一致，便于前端文案对齐）
 *   - admin 角色（isAdminScope）总是 true，不读 DB（避免无谓查询）
 *
 * **修改本文件必须同步 fengyu-staff/cloudfunctions/staffApi/utils/scope.js 的 assertXxxInScope。**
 */

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import type { AuthSession } from './types'
import { isAdminScope, isInScope } from './permissions'

/**
 * 断言 client_user_id 在当前 scope 内
 *
 * @param session 当前登录会话
 * @param clientUserId 顾客 user_id
 * @returns 顾客绑定的 bound_store_id（可能为 null）
 * @throws PERMISSION_DENIED: 顾客不存在 / 顾客不在当前门店范围内
 */
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

/**
 * 断言 sale_order_id 在当前 scope 内
 *
 * @param session
 * @param saleOrderId
 * @returns 订单所属 store_id
 * @throws PERMISSION_DENIED: 订单不存在 / 订单不在当前门店范围内
 */
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

/**
 * 断言 employee_id 在当前 scope 内（按 staff_wechat_users.store_id 判定）
 *
 * @param session
 * @param employeeId
 * @returns 员工所属 store_id
 * @throws PERMISSION_DENIED: 员工不存在 / 员工不在当前门店范围内
 */
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
