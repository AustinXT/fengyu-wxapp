/**
 * 门店模块路由（员工端）
 * store.list — 门店列表（从 PG stores 查询）
 * store.unbindRequests — 查询待审批的顾客解绑申请（店长）
 * store.approveUnbind — 审批通过解绑申请（店长）
 * store.rejectUnbind — 拒绝解绑申请（店长）
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')

/**
 * 门店列表
 * 从 PG stores + org_nodes 查询营业中门店
 */
async function list(ctx) {
  const storeRows = await pg.query(`
    SELECT
      s.store_id,
      s.store_name,
      m.name AS market_name
    FROM stores s
    JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    WHERE s.is_closed = false
    ORDER BY m.name, s.store_name
  `)

  ctx.result = storeRows.map(r => ({
    storeId: r.store_id,
    storeName: r.store_name || '',
    marketName: r.market_name || '',
  }))
}

/**
 * 查询门店待审批的顾客解绑申请（店长）
 */
async function unbindRequests(ctx) {
  await requireManager()(ctx, async () => {})

  const { storeId } = ctx.auth

  const rows = await pg.query(`
    SELECT
      r.request_id,
      r.user_id,
      r.from_store_id,
      s.store_name AS from_store_name,
      r.note,
      r.created_at,
      u.phone
    FROM store_unbind_requests r
    LEFT JOIN client_wechat_users u ON u.user_id = r.user_id
    LEFT JOIN stores s ON s.store_id = r.from_store_id
    WHERE r.from_store_id = $1 AND r.status = '待处理'
    ORDER BY r.created_at ASC
  `, [storeId])

  ctx.result = {
    requests: rows.map(r => ({
      requestId: r.request_id,
      fromStoreName: r.from_store_name || '',
      note: r.note,
      createdAt: r.created_at,
      phoneMasked: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-4) : '未知',
    }))
  }
}

/**
 * 审批通过解绑申请（店长）
 * payload: { requestId }
 */
async function approveUnbind(ctx) {
  await requireManager()(ctx, async () => {})

  const { storeId, staffWfId } = ctx.auth
  const { requestId } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT user_id, from_store_id, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_id !== storeId) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== '待处理') throw new Error('INVALID_PARAMS: 申请状态不允许审批')

  // 事务：解绑顾客门店 + 更新申请状态
  await pg.transaction(async (client) => {
    await client.query(
      `UPDATE client_wechat_users SET bound_store_id = NULL WHERE user_id = $1`,
      [req.user_id]
    )
    await client.query(
      `UPDATE store_unbind_requests
       SET status = '已通过', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE request_id = $2`,
      [staffWfId, requestId]
    )
  })

  ctx.result = { success: true }
}

/**
 * 拒绝解绑申请（店长）
 * payload: { requestId, rejectReason? }
 */
async function rejectUnbind(ctx) {
  await requireManager()(ctx, async () => {})

  const { storeId, staffWfId } = ctx.auth
  const { requestId, rejectReason } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT from_store_id, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_id !== storeId) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== '待处理') throw new Error('INVALID_PARAMS: 申请状态不允许审批')

  await pg.query(
    `UPDATE store_unbind_requests
     SET status = '已拒绝', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2, updated_at = NOW()
     WHERE request_id = $3`,
    [staffWfId, rejectReason || null, requestId]
  )

  ctx.result = { success: true }
}

module.exports = { list, unbindRequests, approveUnbind, rejectUnbind }
