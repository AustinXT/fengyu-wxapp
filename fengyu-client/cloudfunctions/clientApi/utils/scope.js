


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
