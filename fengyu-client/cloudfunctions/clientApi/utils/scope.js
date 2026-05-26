/**
 * 顾客端 scope 守卫（OPENID 单用户场景的轻量边界守护）
 *
 * SUMMARY v3 §2 #13 / ticket notes/tickets/2026-05-17-scope-helper-cross-end-audit.md
 *
 * client 端不同于 staff/admin（多店 scope），主体场景是 OPENID 单用户操作。
 * 仅提供两个 helper：
 *   1. assertUserStoreBound — 操作前确保用户已绑店（store_unbind / appointment 等）
 *   2. assertUserOwnsOrder  — 操作前确保订单归属当前用户（cancel / detail 越权防御）
 *
 * 与 staff/admin 端 assertCustomerInScope/assertOrderInScope/assertEmployeeInScope 的
 * 语义差异：client 按 user_id 自检归属（OPENID 单用户），不按 store_id 做多店 scope。
 *
 * **修改本文件必须同步 fengyu-staff/cloudfunctions/staffApi/utils/scope.js 的设计思路
 * 与错误前缀约定**，并保持 PERMISSION_DENIED:* / INVALID_PARAMS:* 错误前缀一致。
 *
 * 跨端字面量守护见 fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js
 * '§2 #13' describe 块。
 */

/**
 * 断言用户已绑定门店（bound_store_id IS NOT NULL）。
 *
 * 用法：store_unbind 申请、预约创建等需要"必须已绑店"的入口前置校验。
 *
 * @param {{query: Function}} client - 事务客户端或 pg 池
 * @param {string} userId
 * @returns {Promise<{boundStoreId: string}>}
 * @throws INVALID_PARAMS: 缺少 userId
 * @throws PERMISSION_DENIED: 用户不存在 / 用户未绑定门店
 */
async function assertUserStoreBound(client, userId) {
  if (!userId) throw new Error('INVALID_PARAMS: 缺少 userId')
  const rows = await client.query(
    'SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1',
    [userId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 用户不存在')
  }
  const boundStoreId = rows[0].bound_store_id
  if (!boundStoreId) {
    throw new Error('PERMISSION_DENIED: 用户未绑定门店')
  }
  return { boundStoreId }
}

/**
 * 断言订单归属当前用户（sale_orders.client_user_id = userId）。
 *
 * 用法：order.cancel / order.detail / order.scanAdjust 等用户操作自己订单的入口防御。
 *
 * @param {{query: Function}} client - 事务客户端或 pg 池
 * @param {string} userId
 * @param {string} saleOrderId
 * @returns {Promise<{storeId: string|null}>}
 * @throws INVALID_PARAMS: 缺少 userId / 缺少 saleOrderId
 * @throws PERMISSION_DENIED: 订单不存在 / 订单不归属当前用户
 */
async function assertUserOwnsOrder(client, userId, saleOrderId) {
  if (!userId) throw new Error('INVALID_PARAMS: 缺少 userId')
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  const rows = await client.query(
    'SELECT client_user_id, store_id FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 订单不存在')
  }
  if (rows[0].client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 订单不归属当前用户')
  }
  return { storeId: rows[0].store_id }
}

module.exports = {
  assertUserStoreBound,
  assertUserOwnsOrder,
}
