

const pg = require('../db/pg')
const { requireManager, requireStaffBound } = require('../middleware/auth')
const { isStoreInScope } = require('../utils/scope')
const { loadRechargeConfig, matchTier } = require('../utils/recharge')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiYYMMDD } = require('../utils/datetime')


const LEGACY_INFLOW_NOTE = '旧系统充值金转入'




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

  
  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, bound_store_id FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  
  if (!isStoreInScope(ctx.auth, user.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法充值')
  }
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'

  
  let saleOrderId
  await pg.transaction(async (client) => {
    
    
    
    
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientUserId])
    const pendingRows = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE client_user_id = $1 AND status = '待支付' LIMIT 1`,
      [clientUserId]
    )
    if (pendingRows.rows.length > 0) {
      const err = new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
      err.data = { pendingOrderNo: pendingRows.rows[0].sale_order_id }
      throw err
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
    const dateStrOrder = shanghaiYYMMDD(now)
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

    
    const initialStatus = '待支付'

    
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, payable_amount, prepaid_card_amount,
        client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark,
        created_at, updated_at
      ) VALUES ($1, $2, '充值单', $3, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $5), $4), $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, 0,
                $9, $10, $11, $12, $13, $14, $6, $6)`,
      [
        saleOrderId, initialStatus, documentType, marketName, storeId, now,
        faceVal, payAmount,
        clientUserId, clientPhone, customerName,
        paymentMethod, ctx.auth.staffWfId, remark || null,
      ]
    )
    
    await logOperation(client, ctx, 'card.recharge', 'sale_order', saleOrderId, {
      _v: 3,
      clientUserId,
      faceValue: faceVal,
      payAmount,
      paymentMethod,
      storeId,
    })
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


async function inflow(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientUserId, amount, remark } = payload

  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('INVALID_PARAMS: 转入金额必须为正数')
  
  if (Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 转入金额最多保留 2 位小数')
  }
  if (amt > 99999999.99) throw new Error('INVALID_PARAMS: 转入金额超出上限') 

  const storeId = ctx.auth.effectiveStoreId
  
  const marketName = ctx.auth.marketName || ''
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, bound_store_id FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  
  if (!isStoreInScope(ctx.auth, user.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法转入')
  }
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'
  const note = remark ? `${LEGACY_INFLOW_NOTE}｜${remark}` : LEGACY_INFLOW_NOTE

  
  const requestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : null

  let saleOrderId
  let idempotentHit = false
  await pg.transaction(async (client) => {
    
    
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card_inflow:${clientUserId}`])

    
    
    if (requestId) {
      const dup = await client.query(
        `SELECT ref_order_id FROM card_transactions WHERE external_ref = $1 LIMIT 1`,
        [`card-inflow-${requestId}`]
      )
      if (dup.rows.length > 0) {
        saleOrderId = dup.rows[0].ref_order_id
        idempotentHit = true
        return
      }
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
    const dateStrOrder = shanghaiYYMMDD(now)
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

    
    
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, payable_amount, prepaid_card_amount, received,
        client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark, paid_at, allocation_status,
        created_at, updated_at
      ) VALUES ($1, '已支付', '充值单', $2, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $4), $3), $4, (SELECT store_name FROM stores WHERE store_id = $4), $5, $6, $6, 0, $6,
                $7, $8, $9, '线下', $10, $11, $5, '待分配', $5, $5)`,
      [
        saleOrderId, documentType, marketName, storeId, now,
        amt,
        clientUserId, clientPhone, customerName,
        ctx.auth.staffWfId, note,
      ]
    )

    
    await client.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, amount, payment_method, external_txn_id,
         status, source_end, operator_employee_id, note, created_at, paid_at
       ) VALUES ($1, '首次支付', $2, '线下', NULL, '已支付', 'staff', $3, $4, $5, $5)`,
      [saleOrderId, amt, ctx.auth.staffWfId || null, note, now]
    )

    
    
    
    
    const newCardId = `FY-CARD-${clientUserId}`
    const upsertRes = await client.query(
      `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
       RETURNING card_id`,
      [newCardId, clientUserId, amt]
    )
    const cardId = upsertRes.rows[0].card_id
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '充值', $2, $3, $4, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
      
      [cardId, amt, saleOrderId, requestId ? `card-inflow-${requestId}` : `card-topup-${saleOrderId}`]
    )

    
    await logOperation(client, ctx, 'card.inflow', 'sale_order', saleOrderId, {
      _v: 1,
      clientUserId,
      amount: amt,
      storeId,
      legacy: true,
    })
  })

  ctx.result = {
    saleOrderId,
    amount: amt,
    status: '已支付',
    message: idempotentHit ? '转入已完成（请勿重复提交）' : '转入成功',
  }
}


async function createRefund(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleOrderId, reason } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  
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

  
  const existing = await pg.query(
    `SELECT id FROM sale_order_payments
     WHERE sale_order_id = $1 AND change_type = '退款' AND status IN ('待审批', '已支付')`,
    [saleOrderId]
  )
  if (existing.length > 0) {
    throw new Error('CONFLICT: 该订单已有在途/已完成的退款，不可重复发起')
  }

  
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
  if (!(totalAmount > 0)) throw new Error('INVALID_STATE: 订单总额异常，无法计算退款金额')
  
  
  const refundFace = Math.min(totalAmount, balanceNow)
  const refundPay = Math.round((refundFace * payableAmount / totalAmount) * 100) / 100

  
  
  
  
  const sourceEnd = ctx.event.payload?._sourceEnd === 'admin' ? 'admin' : 'staff'
  const placeholderTxnId = `refund-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let paymentId
  await pg.transaction(async (client) => {
    const inserted = await client.query(
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
    paymentId = inserted.rows[0].id
    
    await logOperation(client, ctx, 'card.createRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId,
      refundFace,
      refundPay,
      reason: reason || null,
    })
  })

  ctx.result = {
    paymentId,
    refundFace,
    refundPay,
    status: '待审批',
  }
}


async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  await pg.transaction(async (client) => {
    
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

    
    const scopeStoreIds = ctx.auth.scopeStoreIds || []
    if (!scopeStoreIds.includes(pay.store_id)) {
      throw new Error('PERMISSION_DENIED: 当前店长无权审批该门店的退款')
    }

    
    let meta
    try {
      meta = JSON.parse(pay.note || '{}')
    } catch (e) {
      throw new Error('INVALID_STATE: 退款单元数据格式异常（note 非合法 JSON）')
    }
    const refundFace = Number(meta.refundFace)
    if (!(refundFace > 0)) throw new Error('INVALID_STATE: 退款单缺少 refundFace 元数据')

    
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

    
    await client.query(
      `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
      [refundFace, card.card_id]
    )
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
       VALUES ($1, '扣款', $2, $3, $4)`,
      [card.card_id, -refundFace, pay.sale_order_id, `card-refund-${paymentId}`]
    )

    
    const casUpd = await client.query(
      `UPDATE sale_order_payments
       SET status='已支付', audit_employee_id=$1, audit_at=NOW(), paid_at=NOW()
       WHERE id=$2 AND status='待审批'`,
      [ctx.auth.staffWfId || null, paymentId]
    )
    if (casUpd.rowCount !== 1) {
      throw new Error('INVALID_STATE: 退款单状态已变更，请刷新后重试')
    }

    
    await client.query(
      `UPDATE sale_orders SET refunded_amount = COALESCE(refunded_amount, 0) + $1, updated_at = NOW()
       WHERE sale_order_id = $2`,
      [Math.abs(Number(pay.amount)), pay.sale_order_id]
    )

    
    await logTransition(client, ctx, 'card.approveRefund', 'sale_order_payment', paymentId, '待审批', '已支付', {
      saleOrderId: pay.sale_order_id,
      refundFace,
      refundAmount: Math.abs(Number(pay.amount)),
    })
  })

  

  ctx.result = { paymentId, status: '已支付' }
}


async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId, reason } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  const payRows = await pg.query(
    `SELECT sop.id, sop.status, sop.sale_order_id, so.store_id
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

  await pg.transaction(async (client) => {
    await client.query(
      `UPDATE sale_order_payments
       SET status='已作废', audit_employee_id=$1, audit_at=NOW(), audit_remark=$2
       WHERE id=$3 AND status='待审批'`,
      [ctx.auth.staffWfId || null, reason || null, paymentId]
    )
    
    await logTransition(client, ctx, 'card.rejectRefund', 'sale_order_payment', paymentId, '待审批', '已作废', {
      saleOrderId: payRows[0].sale_order_id,
      reason: reason || null,
    })
  })

  ctx.result = { paymentId, status: '已作废' }
}

module.exports = { rechargeConfig, recharge, inflow, createRefund, approveRefund, rejectRefund }
