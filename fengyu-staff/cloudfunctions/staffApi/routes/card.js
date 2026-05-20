/**
 * 充值卡模块路由（员工端）
 *
 * 2026-05-20 充值卡剥离 SKU 化：
 *   - 充值订单不再依赖 product_skus / sale_items；改用 sale_order_type='充值单' 标识
 *   - 档位配置从 product_skus.is_recharge_card=true 行迁到 system_configs（recharge.tiers）
 *   - total_amount=面值，payable_amount=实付，sale_items 0 行
 *
 * 入账：线下走 order.confirmOffline 识别 sale_order_type='充值单'；微信走 payNotify 同识别。
 *
 * 退款（仅退剩余余额，整笔退、不可拆、只能退 1 次）：
 *   1. card.createRefund — admin/staff 发起，写 sale_order_payments(change_type='退款', status='待审批')
 *   2. card.approveRefund — manager 审批通过：扣 balance + card_transactions(-faceVal) + status='已支付' + 调微信原路退款
 *   3. card.rejectRefund — manager 拒绝：status='已作废'
 */

const pg = require('../db/pg')
const { requireManager, requireStaffBound } = require('../middleware/auth')
const { loadRechargeConfig, matchTier } = require('../utils/recharge')

// ================= 路由 =================

/**
 * 返回充值卡档位 + 自定义金额边界（与 clientApi.card.rechargeConfig 字节同义）
 *
 * 数据来源：system_configs（admin 后台 system-configs 编辑入口维护）
 *
 * 权限：登录态可读（非店长也可浏览面值/折扣表）；真正下单走 card.recharge 仍 manager-only。
 */
async function rechargeConfig(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const cfg = await loadRechargeConfig(pg)
  ctx.result = {
    tiers: cfg.tiers.map(t => ({
      faceValue: t.faceValue,
      payAmount: t.payAmount,
      discount: t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1,
    })),
    minAmount: cfg.minAmount,
    maxAmount: cfg.maxAmount,
  }
}

/**
 * 店长替顾客开充值卡订单
 *
 * payload: {
 *   clientUserId: string,              // 必填，已注册顾客 user_id
 *   faceValue: number,                 // 充值面值；payAmount 由后端按 system_configs 推导
 *   paymentMethod: '线下'|'微信',
 *   remark?: string
 * }
 *
 * 返回: { saleOrderId, faceValue, payAmount, paymentMethod, status }
 */
async function recharge(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientUserId, faceValue, paymentMethod, remark } = payload

  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  if (!['线下', '微信'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }

  const cfg = await loadRechargeConfig(pg)
  const { payAmount } = matchTier(Number(faceValue), cfg)
  const faceVal = Number(faceValue)

  const storeId = ctx.auth.effectiveStoreId
  const marketName = ctx.auth.marketName || ''
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  // 查顾客 + document_type
  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'

  // 并发守卫：同顾客不能有另一笔待支付订单（uq_sale_orders_client_pending 也会兜底）
  const pendingRows = await pg.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付' LIMIT 1`,
    [clientUserId]
  )
  if (pendingRows.length > 0) {
    const err = new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    err.data = { pendingOrderNo: pendingRows[0].sale_order_id }
    throw err
  }

  // 事务内：advisory lock + 生成订单号 + INSERT sale_orders（不写 sale_items）
  let saleOrderId
  await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
    const dateStrOrder = now.toISOString().slice(2, 10).replace(/-/g, '')
    const orderSeqResult = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE sale_order_id LIKE $1
       ORDER BY sale_order_id DESC LIMIT 1`,
      [`FY-XSD-WX-${dateStrOrder}%`]
    )
    let orderSeq = 1
    if (orderSeqResult.rows.length > 0) {
      orderSeq = parseInt(orderSeqResult.rows[0].sale_order_id.slice(-4)) + 1
    }
    saleOrderId = `FY-XSD-WX-${dateStrOrder}${String(orderSeq).padStart(4, '0')}`

    // 线下/微信 → 统一 '待支付'；线下走 confirmOffline 入账，微信走 payNotify 回调入账
    const initialStatus = '待支付'

    // 充值单：total_amount=面值，payable_amount=实付，prepaid_card_amount=0（充值单本身不允许储值卡支付）
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, payable_amount, prepaid_card_amount,
        client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark,
        created_at, updated_at
      ) VALUES ($1, $2, '充值单', $3, $4, $5, $6, $7, $8, 0,
                $9, $10, $11, $12, $13, $14, $6, $6)`,
      [
        saleOrderId, initialStatus, documentType, marketName, storeId, now,
        faceVal, payAmount,
        clientUserId, clientPhone, customerName,
        paymentMethod, ctx.auth.staffWfId, remark || null,
      ]
    )
  })

  ctx.result = {
    saleOrderId,
    faceValue: faceVal,
    payAmount,
    paymentMethod,
    status: '待支付',
    message: '开单成功',
  }
}

/**
 * 发起充值卡退款（admin 或 staff 调用）
 *
 * 仅支持"退剩余余额"语义：refundFace = balance_now，整笔退，不可拆。
 * 实际原路退款金额 = round(refundFace * payable_amount / total_amount, 2)。
 *
 * payload: { saleOrderId: string, reason?: string }
 * 返回: { paymentId, refundFace, refundPay }
 */
async function createRefund(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleOrderId, reason } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  // 校验订单存在 + 为充值单 + 已支付
  const orderRows = await pg.query(
    `SELECT sale_order_id, sale_order_type, status, total_amount, payable_amount,
            client_user_id, payment_method, store_id
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orderRows.length === 0) throw new Error('NOT_FOUND: 订单不存在')
  const order = orderRows[0]
  if (order.sale_order_type !== '充值单') {
    throw new Error('INVALID_STATE: 非充值单不可走充值卡退款流程')
  }
  if (order.status !== '已支付') {
    throw new Error(`INVALID_STATE: 订单状态 ${order.status} 不可退款`)
  }

  // 校验无在途退款（uq_sop_status_audit 会兜底）
  const existing = await pg.query(
    `SELECT id FROM sale_order_payments
     WHERE sale_order_id = $1 AND change_type = '退款' AND status IN ('待审批', '已支付')`,
    [saleOrderId]
  )
  if (existing.length > 0) {
    throw new Error('CONFLICT: 该订单已有在途/已完成的退款，不可重复发起')
  }

  // 取顾客当前余额（按面值口径），refundFace = balance_now
  const cardRows = await pg.query(
    `SELECT pc.card_id, pc.balance FROM prepaid_cards pc WHERE pc.user_id = $1`,
    [order.client_user_id]
  )
  if (cardRows.length === 0) {
    throw new Error('NOT_FOUND: 顾客无充值卡账户，无可退余额')
  }
  const balanceNow = Number(cardRows[0].balance)
  if (!(balanceNow > 0)) {
    throw new Error('INSUFFICIENT_BALANCE: 当前余额为 0，无可退金额')
  }

  const totalAmount = Number(order.total_amount)
  const payableAmount = Number(order.payable_amount)
  const refundFace = balanceNow
  if (!(totalAmount > 0)) throw new Error('INVALID_STATE: 订单总额异常，无法计算退款金额')
  const refundPay = Math.round((refundFace * payableAmount / totalAmount) * 100) / 100

  // 写 sale_order_payments：change_type='退款' status='待审批' amount=负
  // external_txn_id 必填占位（chk_sop_method_txn 对 微信/支付宝 NOT NULL 强校验）；
  // approveRefund 调微信退款 API 后会 UPDATE 为真实 refund_id。
  // 占位串须每次唯一（uq_sop_txn）。
  const sourceEnd = ctx.event.payload?._sourceEnd === 'admin' ? 'admin' : 'staff'
  const placeholderTxnId = `refund-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const inserted = await pg.query(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, refund_reason, note, external_txn_id
     ) VALUES ($1, '退款', $2, $3, '待审批', $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      saleOrderId,
      -refundPay,
      order.payment_method,
      sourceEnd,
      ctx.auth.staffWfId || null,
      reason || null,
      JSON.stringify({ refundFace, balanceAtRequest: balanceNow }),
      placeholderTxnId,
    ]
  )
  const paymentId = inserted[0].id

  ctx.result = {
    paymentId,
    refundFace,
    refundPay,
    status: '待审批',
  }
}

/**
 * 店长审批通过充值卡退款
 *
 * payload: { paymentId: number }
 */
async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  await pg.transaction(async (client) => {
    // 锁定 sale_order_payments 行
    const payRows = await client.query(
      `SELECT sop.id, sop.sale_order_id, sop.amount, sop.status, sop.note,
              so.client_user_id, so.total_amount, so.payable_amount, so.store_id
       FROM sale_order_payments sop
       JOIN sale_orders so ON sop.sale_order_id = so.sale_order_id
       WHERE sop.id = $1 FOR UPDATE OF sop`,
      [paymentId]
    )
    if (payRows.rows.length === 0) throw new Error('NOT_FOUND: 退款单不存在')
    const pay = payRows.rows[0]
    if (pay.status !== '待审批') {
      throw new Error(`INVALID_STATE: 退款单当前状态 ${pay.status} 不可审批`)
    }

    // 权限：manager 必须覆盖订单门店
    const scopeStoreIds = ctx.auth.scopeStoreIds || []
    if (!scopeStoreIds.includes(pay.store_id)) {
      throw new Error('PERMISSION_DENIED: 当前店长无权审批该门店的退款')
    }

    // 读 note 拿 refundFace
    let meta
    try {
      meta = JSON.parse(pay.note || '{}')
    } catch (e) {
      throw new Error('INVALID_STATE: 退款单元数据格式异常（note 非合法 JSON）')
    }
    const refundFace = Number(meta.refundFace)
    if (!(refundFace > 0)) throw new Error('INVALID_STATE: 退款单缺少 refundFace 元数据')

    // advisory lock + 校验余额
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card-balance-${pay.client_user_id}`])
    const balRows = await client.query(
      `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
      [pay.client_user_id]
    )
    if (balRows.rows.length === 0) throw new Error('NOT_FOUND: 顾客充值卡账户已不存在')
    const card = balRows.rows[0]
    const balance = Number(card.balance)
    if (balance < refundFace) {
      throw new Error(`INSUFFICIENT_BALANCE: 当前余额 ${balance} < 退款面值 ${refundFace}（审批期间已被消费）`)
    }

    // 扣 balance + 写 card_transactions
    await client.query(
      `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
      [refundFace, card.card_id]
    )
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
       VALUES ($1, '扣款', $2, $3, $4)`,
      [card.card_id, -refundFace, pay.sale_order_id, `card-refund-${paymentId}`]
    )

    // 翻 status='已支付' + 记审批人 + paid_at
    await client.query(
      `UPDATE sale_order_payments
       SET status='已支付', audit_employee_id=$1, audit_at=NOW(), paid_at=NOW()
       WHERE id=$2`,
      [ctx.auth.staffWfId || null, paymentId]
    )

    // sale_orders.refunded_amount 累加（应用层冗余快照）
    await client.query(
      `UPDATE sale_orders SET refunded_amount = COALESCE(refunded_amount, 0) + $1, updated_at = NOW()
       WHERE sale_order_id = $2`,
      [Math.abs(Number(pay.amount)), pay.sale_order_id]
    )
  })

  // TODO: 调微信原路退款 API（refundPay = |pay.amount|）—— 当前 mock 阶段先跳过

  ctx.result = { paymentId, status: '已支付' }
}

/**
 * 店长拒绝充值卡退款
 *
 * payload: { paymentId: number, reason?: string }
 */
async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId, reason } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  const payRows = await pg.query(
    `SELECT sop.id, sop.status, so.store_id
     FROM sale_order_payments sop
     JOIN sale_orders so ON sop.sale_order_id = so.sale_order_id
     WHERE sop.id = $1`,
    [paymentId]
  )
  if (payRows.length === 0) throw new Error('NOT_FOUND: 退款单不存在')
  if (payRows[0].status !== '待审批') {
    throw new Error(`INVALID_STATE: 退款单当前状态 ${payRows[0].status} 不可审批`)
  }
  const scopeStoreIds = ctx.auth.scopeStoreIds || []
  if (!scopeStoreIds.includes(payRows[0].store_id)) {
    throw new Error('PERMISSION_DENIED: 当前店长无权审批该门店的退款')
  }

  await pg.query(
    `UPDATE sale_order_payments
     SET status='已作废', audit_employee_id=$1, audit_at=NOW(), audit_remark=$2
     WHERE id=$3 AND status='待审批'`,
    [ctx.auth.staffWfId || null, reason || null, paymentId]
  )

  ctx.result = { paymentId, status: '已作废' }
}

module.exports = { rechargeConfig, recharge, createRefund, approveRefund, rejectRefund }
