/**
 * 充值卡模块路由
 */

const pg = require('../db/pg')

/**
 * 充值卡列表
 */
async function list(ctx) {
  const { userId } = ctx.auth

  const cards = await pg.query(`
    SELECT pc.card_id, pc.balance, pc.store_id, s.store_name, pc.created_at
    FROM prepaid_cards pc
    LEFT JOIN stores s ON pc.store_id = s.store_id
    WHERE pc.user_id = $1
    ORDER BY pc.created_at DESC
  `, [userId])

  ctx.result = {
    cards: cards.map(c => ({
      cardId: c.card_id,
      balance: c.balance,
      storeId: c.store_id,
      storeName: c.store_name,
      createdAt: c.created_at,
    }))
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
      amount: r.amount,
      refOrderId: r.ref_order_id,
      createdAt: r.created_at,
    }))
  }
}

module.exports = { list, history }
