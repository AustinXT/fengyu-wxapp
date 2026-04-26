/**
 * 充值卡模块路由
 */

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { RECHARGE_VIRTUAL_SKU_ID } = require('./_constants')

// =============================================================
// 充值档位配置
// =============================================================
// TODO(future): 后续运营要"改档不发版"时，独立成 recharge_tier_config 表
// 由 admin 维护。本期硬编码，rechargeConfig 接口已支持后续无缝迁移。
const RECHARGE_TIERS = [
  { faceValue: 500, discount: 0.99 },
  { faceValue: 1000, discount: 0.98 },
  { faceValue: 5000, discount: 0.95 },
]
const RECHARGE_MIN_AMOUNT = 500
const RECHARGE_MAX_AMOUNT = 100000

/**
 * 按充值面值匹配折扣（区间左闭右开）
 * @param {number} amount - 面值
 * @returns {{ discount: number, payAmount: number }}
 * @throws 校验失败抛 'INVALID_PARAMS: ...'
 */
function matchTier(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  // 小数位 ≤ 2
  if (Math.round(amount * 100) !== amount * 100) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数')
  }
  if (amount < RECHARGE_MIN_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${RECHARGE_MIN_AMOUNT}`)
  }
  if (amount > RECHARGE_MAX_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${RECHARGE_MAX_AMOUNT}`)
  }

  // 区间匹配：500-999 → 9.9 折，1000-4999 → 9.8 折，≥5000 → 9.5 折
  let discount = RECHARGE_TIERS[0].discount
  for (const tier of RECHARGE_TIERS) {
    if (amount >= tier.faceValue) discount = tier.discount
  }

  const payAmount = Math.round(amount * discount * 100) / 100
  return { discount, payAmount }
}

// =============================================================
// 路由
// =============================================================

/**
 * 充值卡列表（一户一账户，余额跨店共享）
 */
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
      // PG numeric 经 node-postgres 返回字符串，需显式转 number 保证前端合约
      balance: Number(c.balance),
      createdAt: c.created_at,
    }))
  }
}

/**
 * 查询当前用户储值卡余额（跨店统一，一户一账户）
 * 无卡返回 { balance: 0, cardId: null }
 */
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

/**
 * 充值卡交易记录（最近6个月）
 */
async function history(ctx) {
  const { userId } = ctx.auth
  const { cardId, page = 1, pageSize = 20 } = ctx.event.payload || {}
  if (!cardId) throw new Error('INVALID_PARAMS: 缺少 cardId')
  const offset = (page - 1) * pageSize

  // Verify card ownership
  const cards = await pg.query(
    'SELECT card_id FROM prepaid_cards WHERE card_id = $1 AND user_id = $2',
    [cardId, userId]
  )
  if (cards.length === 0) throw new Error('INVALID_PARAMS: 充值卡不存在')

  // Get transactions (last 6 months)
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
      // PG numeric 经 node-postgres 返回字符串，需显式转 number 保证前端合约
      amount: Number(r.amount),
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}

/**
 * 拉取充值档位配置（公开接口，无需登录）
 */
async function rechargeConfig(ctx) {
  ctx.result = {
    tiers: RECHARGE_TIERS.map(t => ({
      faceValue: t.faceValue,
      discount: t.discount,
      payAmount: Math.round(t.faceValue * t.discount * 100) / 100,
    })),
    minAmount: RECHARGE_MIN_AMOUNT,
    maxAmount: RECHARGE_MAX_AMOUNT,
  }
}

/**
 * 关闭过期的待支付订单（10 分钟）以释放唯一约束 uq_sale_orders_client_pending
 * 与 order.create 中的同名逻辑保持一致，避免环依赖故在此独立实现一份精简版
 */
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

/**
 * 创建充值订单
 *
 * payload: { faceValue: number }   // 面值；实付由后端按 faceValue 推导
 * 返回:    { saleOrderId, faceValue, payAmount, paymentParams, mockMode }
 */
async function recharge(ctx) {
  // 必须绑定手机号
  await requirePhone()(ctx, async () => {})

  const { userId, boundStoreId, boundMarketName, phone } = ctx.auth
  const { faceValue } = ctx.event.payload || {}

  // 1. 校验金额并匹配档位
  const { discount, payAmount } = matchTier(Number(faceValue))

  // 2. 校验已绑定门店（D1 决策：充值卡按已绑定门店入账）
  if (!boundStoreId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店')
  }

  // 3. 查询门店 market_name 快照（与 order.create 逻辑一致）
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

  // 4. 查询顾客姓名（用于 customer_name 快照）
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

  // 5. 事务内创建订单（订单号 + 流水号在事务+锁内原子生成）
  let saleOrderId
  await pg.transaction(async (client) => {
    // a. 关闭该用户已过期的待支付订单（释放唯一约束）
    await _closeExpiredPendingByUser(client, userId)

    // b. 检查是否仍有待支付订单（单 client_user_id 唯一约束）
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

    // c. advisory lock 防并发序号冲突
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

    // 流水号
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
    const itemSeqResult = await client.query(
      `SELECT sale_item_id FROM sale_items
       WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let itemSeq = 1
    if (itemSeqResult.rows.length > 0) {
      itemSeq = parseInt(itemSeqResult.rows[0].sale_item_id.slice(-4)) + 1
    }
    const saleItemId = `XSLSH-WX-${dateStr}${String(itemSeq).padStart(4, '0')}`

    // d. INSERT sale_orders（实付 = payAmount，复用 total_amount 列）
    // 2026-04-26 sale-order-domain-refactor：
    //   - paid_amount 列已 DROP，初始 received = 0（待 payNotify 回调写流水后累加）
    //   - payable_amount = payAmount（应付实金）；prepaid_card_amount 默认 0
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, received, payable_amount, payment_method,
        created_at, updated_at
      ) VALUES ($1, '待支付', '销售单', $2, $3, $4, $5, $6, $7, $8, $9, 0, $9, '微信', $5, $5)`,
      [saleOrderId, documentType, marketName, boundStoreId, now, userId, phone || null, customerName, payAmount]
    )

    // e. INSERT sale_items（虚拟 SKU；商品名快照含面值，便于 payNotify 解析 + admin 列表展示）
    await client.query(
      `INSERT INTO sale_items (
        sale_item_id, sale_order_id, store_id, sku_id,
        product_name, sku_spec_name, product_type,
        session_count, remaining_sessions,
        unit_price, quantity, unit_real_price,
        sale_amount, received, service_fee
      ) VALUES ($1, $2, $3, $4, $5, $6, '家居产品', NULL, NULL, $7, 1, $7, $7, $7, 0)`,
      [
        saleItemId, saleOrderId, boundStoreId, RECHARGE_VIRTUAL_SKU_ID,
        `预付充值卡 ¥${faceValue}`, '预付充值卡（虚拟）', payAmount,
      ]
    )
  })

  // 6. 生成微信支付 mock 参数（沿用 order.pay 同款 mock 结构）
  // TODO: 接入真实微信支付统一下单接口（与 order.pay 同步替换）
  ctx.result = {
    saleOrderId,
    faceValue: Number(faceValue),
    payAmount,
    discount,
    paymentMethod: '微信',
    mockMode: true,
    paymentParams: {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).substr(2),
      package: `prepay_id=wx${Date.now()}`,
      signType: 'MD5',
      paySign: 'mock_sign',
    },
  }
}

module.exports = { list, balance, history, rechargeConfig, recharge, matchTier }
