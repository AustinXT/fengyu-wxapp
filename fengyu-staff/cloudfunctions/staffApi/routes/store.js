/**
 * 门店模块路由（员工端）
 * store.list — 从 WorkFine 查询营业中的门店
 * store.unbindRequests — 查询待审批的顾客解绑申请（店长）
 * store.approveUnbind — 审批通过解绑申请（店长）
 * store.rejectUnbind — 拒绝解绑申请（店长）
 */

const mssql = require('../db/mssql')
const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')

/**
 * 门店列表
 * 从 WorkFine UDT_M_219 查询营业中门店，带市场信息
 */
async function list(ctx) {
  const storeRows = await mssql.query(`
    SELECT
      UDF_M_437 AS market_name,
      UDF_M_438 AS store_name,
      UDF_M_1777 AS open_date,
      UDF_M_8590 AS bed_count
    FROM UDT_M_219
    WHERE (UDF_M_11956 IS NULL OR UDF_M_11956 != '是')
    ORDER BY UDF_M_437, UDF_M_438
  `)

  ctx.result = storeRows.map(r => ({
    storeId: r.store_name ? r.store_name.trim() : '',
    storeName: r.store_name ? r.store_name.trim() : '',
    marketName: r.market_name ? r.market_name.trim() : '',
  }))
}

/**
 * 查询门店待审批的顾客解绑申请（店长）
 */
async function unbindRequests(ctx) {
  await requireManager()(ctx, async () => {})

  const { storeName } = ctx.auth

  const rows = await pg.query(`
    SELECT
      r.request_id,
      r.user_id,
      r.from_store_name,
      r.note,
      r.created_at,
      u.phone
    FROM store_unbind_requests r
    LEFT JOIN client_wechat_users u ON u.user_id = r.user_id
    WHERE r.from_store_name = $1 AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `, [storeName])

  ctx.result = {
    requests: rows.map(r => ({
      requestId: r.request_id,
      fromStoreName: r.from_store_name,
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

  const { storeName, staffWfId } = ctx.auth
  const { requestId } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT user_id, from_store_name, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_name !== storeName) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== 'pending') throw new Error('INVALID_PARAMS: 申请状态不允许审批')

  // 解绑顾客门店
  await pg.query(
    `UPDATE client_wechat_users SET bound_store_name = NULL, bound_market_name = NULL WHERE user_id = $1`,
    [req.user_id]
  )

  // 更新申请状态
  await pg.query(
    `UPDATE store_unbind_requests
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
     WHERE request_id = $2`,
    [staffWfId, requestId]
  )

  ctx.result = { success: true }
}

/**
 * 拒绝解绑申请（店长）
 * payload: { requestId, rejectReason? }
 */
async function rejectUnbind(ctx) {
  await requireManager()(ctx, async () => {})

  const { storeName, staffWfId } = ctx.auth
  const { requestId, rejectReason } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT from_store_name, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  const req = rows[0]
  if (req.from_store_name !== storeName) throw new Error('PERMISSION_DENIED: 无权审批此申请')
  if (req.status !== 'pending') throw new Error('INVALID_PARAMS: 申请状态不允许审批')

  await pg.query(
    `UPDATE store_unbind_requests
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2, updated_at = NOW()
     WHERE request_id = $3`,
    [staffWfId, rejectReason || null, requestId]
  )

  ctx.result = { success: true }
}

module.exports = { list, unbindRequests, approveUnbind, rejectUnbind }
