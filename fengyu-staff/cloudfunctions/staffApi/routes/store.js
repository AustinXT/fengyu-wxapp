

const pg = require('../db/pg')
const { requireManager, requireStaffBound } = require('../middleware/auth')
const { logTransition } = require('../utils/operation-log')


async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const isHeadquarters = ctx.auth.staffLevel === 'headquarters'

  let storeRows
  if (isHeadquarters) {
    storeRows = await pg.query(`
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
  } else {
    const scopeIds = ctx.auth.scopeStoreIds || []
    if (scopeIds.length === 0) {
      ctx.result = []
      return
    }
    storeRows = await pg.query(`
      SELECT
        s.store_id,
        s.store_name,
        m.name AS market_name
      FROM stores s
      JOIN org_nodes so ON s.org_node_id = so.id
      LEFT JOIN org_nodes m ON so.parent_id = m.id
      WHERE s.is_closed = false
        AND s.store_id = ANY($1::text[])
      ORDER BY m.name, s.store_name
    `, [scopeIds])
  }

  ctx.result = storeRows.map(r => ({
    storeId: r.store_id,
    storeName: r.store_name || '',
    marketName: r.market_name || '',
  }))
}


async function unbindRequests(ctx) {
  await requireManager()(ctx, async () => {})

  const { effectiveStoreId } = ctx.auth

  const rows = await pg.query(`
    SELECT
      r.request_id,
      r.user_id,
      r.from_store_id,
      sf.store_name AS from_store_name,
      r.to_store_id,
      st.store_name AS to_store_name,
      r.note,
      r.created_at,
      u.phone
    FROM store_unbind_requests r
    LEFT JOIN client_wechat_users u ON u.user_id = r.user_id
    LEFT JOIN stores sf ON sf.store_id = r.from_store_id
    LEFT JOIN stores st ON st.store_id = r.to_store_id
    WHERE r.from_store_id = $1 AND r.status = '待处理'
    ORDER BY r.created_at ASC
  `, [effectiveStoreId])

  ctx.result = {
    requests: rows.map(r => ({
      requestId: r.request_id,
      fromStoreName: r.from_store_name || '',
      toStoreId: r.to_store_id || '',
      toStoreName: r.to_store_name || '',
      note: r.note,
      createdAt: r.created_at,
      phoneMasked: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-4) : '未知',
    }))
  }
}


async function approveUnbind(ctx) {
  await requireManager()(ctx, async () => {})

  const { effectiveStoreId, staffWfId } = ctx.auth
  const { requestId } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT user_id, from_store_id, to_store_id, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_id !== effectiveStoreId) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== '待处理') throw new Error('INVALID_PARAMS: 申请状态不允许审批')
  if (!req.to_store_id) throw new Error('INVALID_STATE: 申请缺少目标门店，无法转店')

  
  const target = await pg.query(
    `SELECT store_id FROM stores WHERE store_id = $1 AND is_closed = false`,
    [req.to_store_id]
  )
  if (target.length === 0) throw new Error('INVALID_PARAMS: 目标门店不存在或已停业')

  
  
  
  await pg.transaction(async (client) => {
    const upd = await client.query(
      `UPDATE store_unbind_requests
       SET status = '已通过', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE request_id = $2 AND status = '待处理'`,
      [staffWfId, requestId]
    )
    if (upd.rowCount === 0) {
      throw new Error(
        `INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:${requestId}:待处理→已通过`
      )
    }
    await client.query(
      `UPDATE client_wechat_users SET bound_store_id = $1, bound_employee_id = NULL, bound_employee_name = NULL, updated_at = NOW() WHERE user_id = $2`,
      [req.to_store_id, req.user_id]
    )
    
    await logTransition(client, ctx, 'store_unbind.approve', 'store_unbind_request', requestId, '待处理', '已通过', {
      clientUserId: req.user_id,
      fromStoreId: req.from_store_id,
      toStoreId: req.to_store_id,
    })
  })

  ctx.result = { success: true }
}


async function rejectUnbind(ctx) {
  await requireManager()(ctx, async () => {})

  const { effectiveStoreId, staffWfId } = ctx.auth
  const { requestId, rejectReason } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT from_store_id, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_id !== effectiveStoreId) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== '待处理') throw new Error('INVALID_PARAMS: 申请状态不允许审批')

  await pg.transaction(async (client) => {
    const rejectUpd = await client.query(
      `UPDATE store_unbind_requests
       SET status = '已拒绝', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2, updated_at = NOW()
       WHERE request_id = $3 AND status = '待处理'`,
      [staffWfId, rejectReason || null, requestId]
    )
    if (rejectUpd.rowCount === 0) {
      throw new Error(
        `INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:${requestId}:待处理→已拒绝`
      )
    }
    
    await logTransition(client, ctx, 'store_unbind.reject', 'store_unbind_request', requestId, '待处理', '已拒绝', {
      fromStoreId: req.from_store_id,
      rejectReason: rejectReason || null,
    })
  })

  ctx.result = { success: true }
}

module.exports = { list, unbindRequests, approveUnbind, rejectUnbind }
