

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { shanghaiYYMMDD } = require('../utils/datetime')





async function _loadRechargeConfig(client) {
  const queryRunner = client || pg
  const rows = await queryRunner.query(
    `SELECT key, value FROM system_configs WHERE key IN ('recharge.tiers','recharge.minAmount','recharge.maxAmount')`
  )
  const cfg = {}
  for (const r of rows) cfg[r.key] = r.value
  if (!cfg['recharge.tiers'] || !cfg['recharge.minAmount'] || !cfg['recharge.maxAmount']) {
    throw new Error('INVALID_STATE: 系统未配置充值卡档位')
  }
  let tiers
  try { tiers = JSON.parse(cfg['recharge.tiers']) } catch (e) {
    throw new Error('INVALID_STATE: recharge.tiers 配置格式错误')
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('INVALID_STATE: recharge.tiers 必须为非空数组')
  }
  for (const t of tiers) {
    if (typeof t.faceValue !== 'number' || typeof t.payAmount !== 'number') {
      throw new Error('INVALID_STATE: recharge.tiers 条目格式错误')
    }
  }
  tiers.sort((a, b) => a.faceValue - b.faceValue)
  const minAmount = Number(cfg['recharge.minAmount'])
  const maxAmount = Number(cfg['recharge.maxAmount'])
  if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount <= 0 || maxAmount < minAmount) {
    throw new Error('INVALID_STATE: recharge.minAmount/maxAmount 配置无效')
  }
  return { tiers, minAmount, maxAmount }
}


function matchTier(amount, cfg) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数')
  }
  if (amount < cfg.minAmount) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${cfg.minAmount}`)
  }
  if (amount > cfg.maxAmount) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${cfg.maxAmount}`)
  }
  const hit = cfg.tiers.find(t => t.faceValue === amount)
  if (hit) {
    const discount = amount > 0 ? Math.round((hit.payAmount / amount) * 100) / 100 : 1
    return { payAmount: hit.payAmount, discount }
  }
  let baseTier = cfg.tiers[0]
  for (const t of cfg.tiers) {
    if (amount >= t.faceValue) baseTier = t
  }
  const ratio = baseTier.payAmount / baseTier.faceValue
  const payAmount = Math.round(amount * ratio * 100) / 100
  const discount = Math.round(ratio * 100) / 100
  return { payAmount, discount }
}






async function list(ctx) {
  const { userId } = ctx.auth

  const cards = await pg.query(`
    SELECT pc.card_id, pc.balance, pc.created_at
    FROM prepaid_cards pc
    WHERE pc.user_id = $1
    ORDER BY pc.created_at DESC
  `, [userId])

  ctx.result = {
    cards: cards.map(c => ({
      cardId: c.card_id,
      balance: Number(c.balance),
      createdAt: c.created_at,
    }))
  }
}


async function balance(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth

  const rows = await pg.query(
    'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1',
    [userId]
  )

  if (rows.length === 0) {
    ctx.result = { balance: 0, cardId: null }
    return
  }

  ctx.result = {
    cardId: rows[0].card_id,
    balance: Number(rows[0].balance),
  }
}


async function history(ctx) {
  const { userId } = ctx.auth
  const { cardId, page = 1, pageSize = 20 } = ctx.event.payload || {}
  if (!cardId) throw new Error('INVALID_PARAMS: 缺少 cardId')
  const offset = (page - 1) * pageSize

  const cards = await pg.query(
    'SELECT card_id FROM prepaid_cards WHERE card_id = $1 AND user_id = $2',
    [cardId, userId]
  )
  if (cards.length === 0) throw new Error('INVALID_PARAMS: 充值卡不存在')

  const records = await pg.query(`
    SELECT ct.id, ct.type, ct.amount, ct.ref_order_id, ct.created_at
    FROM card_transactions ct
    WHERE ct.card_id = $1 AND ct.created_at >= NOW() - INTERVAL '6 months'
    ORDER BY ct.created_at DESC
    LIMIT $2 OFFSET $3
  `, [cardId, pageSize, offset])

  ctx.result = {
    records: records.map(r => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}


async function rechargeConfig(ctx) {
  const cfg = await _loadRechargeConfig()
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


async function _closeExpiredPendingByUser(client, userId) {
  const expired = await client.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付'
     AND sale_order_datetime < NOW() - INTERVAL '10 minutes'`,
    [userId]
  )
  for (const row of expired.rows) {
    await client.query(
      `UPDATE sale_orders SET status = '已关闭', updated_at = NOW()
       WHERE sale_order_id = $1 AND status = '待支付'`,
      [row.sale_order_id]
    )
    await client.query(
      `UPDATE user_coupons SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [row.sale_order_id]
    )
  }
}


async function recharge(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId, boundStoreId, boundMarketName, phone } = ctx.auth
  const { faceValue } = ctx.event.payload || {}

  const cfg = await _loadRechargeConfig()
  const { discount, payAmount } = matchTier(Number(faceValue), cfg)
  const faceVal = Number(faceValue)

  if (!boundStoreId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店')
  }

  
  const storeRows = await pg.query(
    `SELECT s.store_id, s.store_name, pm.name AS market_name
     FROM stores s
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE s.store_id = $1`,
    [boundStoreId]
  )
  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 绑定门店不存在')
  }
  const marketName = storeRows[0].market_name || boundMarketName || ''

  
  let customerName = null
  let documentType = '售前'
  {
    const userRows = await pg.query(
      'SELECT name, customer_type FROM client_wechat_users WHERE user_id = $1',
      [userId]
    )
    if (userRows.length > 0) {
      if (userRows[0].name) customerName = userRows[0].name
      if (userRows[0].customer_type === '会员客') documentType = '售后'
    }
  }

  let saleOrderId
  await pg.transaction(async (client) => {
    await _closeExpiredPendingByUser(client, userId)

    const existing = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE client_user_id = $1 AND status = '待支付'`,
      [userId]
    )
    if (existing.rows.length > 0) {
      const err = new Error('INVALID_PARAMS: 您已有待支付订单，请先完成支付或取消订单')
      err.data = { pendingOrderNo: existing.rows[0].sale_order_id }
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

    
    
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, received, payable_amount, prepaid_card_amount, payment_method,
        created_at, updated_at
      ) VALUES ($1, '待支付', '充值单', $2, $3, $4, (SELECT store_name FROM stores WHERE store_id = $4), $5, $6, $7, $8, $9, 0, $10, 0, '微信', $5, $5)`,
      [saleOrderId, documentType, marketName, boundStoreId, now,
       userId, phone || null, customerName, faceVal, payAmount]
    )
  })

  ctx.result = {
    saleOrderId,
    faceValue: faceVal,
    payAmount,
    discount,
  }
}

module.exports = { list, balance, history, rechargeConfig, recharge, matchTier, _loadRechargeConfig }
