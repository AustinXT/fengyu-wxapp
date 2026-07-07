

const pg = require('../db/pg')


async function list(ctx) {
  const { userId } = ctx.auth
  const { page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const records = await pg.query(`
    SELECT id, title, body, message_type, is_read, ref_entity_type, ref_entity_id, created_at
    FROM messages
    WHERE recipient_type = '客户' AND recipient_id = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, pageSize, offset])

  ctx.result = {
    records: records.map(r => ({
      id: r.id,
      title: r.title,
      body: r.body,
      type: r.message_type,
      isRead: r.is_read,
      refEntity: r.ref_entity_type,
      refId: r.ref_entity_id,
      createdAt: r.created_at,
    }))
  }
}


async function read(ctx) {
  const { userId } = ctx.auth
  const { messageId } = ctx.event.payload || {}
  if (!messageId) throw new Error('INVALID_PARAMS: 缺少 messageId')

  await pg.query(
    'UPDATE messages SET is_read = true WHERE id = $1 AND recipient_type = $2 AND recipient_id = $3 AND deleted_at IS NULL',
    [messageId, '客户', userId]
  )
  ctx.result = { success: true }
}


async function unreadCount(ctx) {
  const { userId } = ctx.auth
  const rows = await pg.query(
    "SELECT COUNT(*)::int AS count FROM messages WHERE recipient_type = '客户' AND recipient_id = $1 AND is_read = false AND deleted_at IS NULL",
    [userId]
  )
  ctx.result = { count: rows[0]?.count || 0 }
}

module.exports = { list, read, unreadCount }
