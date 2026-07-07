

const pg = require('../db/pg')
const crypto = require('crypto')
const { checkText } = require('../utils/wx-sec-check')


async function list(ctx) {
  const { city } = ctx.event.payload || {}

  const params = []
  let whereClause = 'WHERE s.is_closed = false'

  
  
  if (city) {
    params.push(`%${city}%`)
    whereClause += ` AND s.district LIKE $${params.length}`
  }

  const stores = await pg.query(`
    SELECT
      pm.name AS market_name,
      s.store_name,
      s.store_id,
      s.opening_date AS open_date,
      s.bed_count AS available_beds,
      s.district AS store_region,
      s.cover_image,
      s.street_address,
      s.latitude,
      s.longitude,
      s.phone,
      s.business_hours,
      s.description,
      s.announcement,
      s.parking_info
    FROM stores s
    LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
    LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
    ${whereClause}
    ORDER BY pm.name, s.store_name
  `, params)

  
  stores.forEach(s => {
    s.open_date = formatOpenDate(s.open_date)
  })

  ctx.result = { stores }
}


async function detail(ctx) {
  const { storeId, storeName } = ctx.event.payload || {}
  if (!storeId && !storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 或 storeName')
  }

  
  const storeFilter = storeId
    ? { sql: 's.store_id = $1', param: storeId }
    : { sql: 's.store_name = $1', param: storeName }

  
  const storeResult = await pg.query(`
    SELECT
      s.store_id,
      pm.name AS market_name,
      s.store_name,
      s.opening_date AS open_date,
      s.bed_count AS available_beds,
      s.district AS store_region,
      s.cover_image,
      s.images,
      s.street_address,
      s.latitude,
      s.longitude,
      s.phone,
      s.business_hours,
      s.description,
      s.announcement,
      s.parking_info
    FROM stores s
    LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
    LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
    WHERE ${storeFilter.sql} AND s.is_closed = false
    LIMIT 1
  `, [storeFilter.param])

  if (storeResult.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }

  const store = storeResult[0]
  store.open_date = formatOpenDate(store.open_date)
  store.images = Array.isArray(store.images) ? store.images : []

  
  const actualStoreId = store.store_id
  const [staffResult, customerResult] = await Promise.all([
    pg.query(
      'SELECT COUNT(*)::int AS staff_count FROM staff_wechat_users WHERE store_id = $1 AND is_resigned = false',
      [actualStoreId]
    ),
    pg.query(
      'SELECT COUNT(*)::int AS customer_count FROM client_wechat_users WHERE bound_store_id = $1',
      [actualStoreId]
    )
  ])
  store.staff_count = staffResult[0]?.staff_count || 0
  store.customer_count = customerResult[0]?.customer_count || 0

  ctx.result = { store }
}


function formatOpenDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}


async function requestUnbind(ctx) {
  const { userId, boundStoreId } = ctx.auth
  if (!userId) throw new Error('UNAUTHORIZED: 未登录')
  if (!boundStoreId) throw new Error('INVALID_PARAMS: 当前未绑定任何门店')

  const { toStoreId, note } = ctx.event.payload || {}
  if (!toStoreId) throw new Error('INVALID_PARAMS: 缺少目标门店 toStoreId')
  if (toStoreId === boundStoreId) throw new Error('INVALID_PARAMS: 目标门店不能与当前门店相同')

  
  const target = await pg.query(
    `SELECT store_id FROM stores WHERE store_id = $1 AND is_closed = false`,
    [toStoreId]
  )
  if (target.length === 0) throw new Error('INVALID_PARAMS: 目标门店不存在或已停业')

  
  const existing = await pg.query(
    `SELECT request_id FROM store_unbind_requests WHERE user_id = $1 AND status = '待处理'`,
    [userId]
  )
  if (existing.length > 0) {
    throw new Error('INVALID_PARAMS: 已有待审批的转店申请，请等待审批结果')
  }

  
  await checkText(note, { scene: 1 })

  
  const requestId = crypto.randomUUID()
  const insRes = await pg.query(
    `INSERT INTO store_unbind_requests (request_id, user_id, from_store_id, to_store_id, status, note)
     VALUES ($1, $2, $3, $4, '待处理', $5)
     ON CONFLICT (user_id) WHERE status = '待处理' DO NOTHING
     RETURNING request_id`,
    [requestId, userId, boundStoreId, toStoreId, note || null]
  )
  if (insRes.length === 0) {
    throw new Error('CONFLICT: 已有待审批的转店申请，请等待审批结果')
  }

  ctx.result = { requestId }
}


async function getUnbindRequest(ctx) {
  const { userId } = ctx.auth
  if (!userId) {
    ctx.result = { request: null }
    return
  }

  const rows = await pg.query(
    `SELECT r.request_id, r.from_store_id, r.to_store_id, r.status, r.note, r.created_at,
            sf.store_name AS from_store_name,
            st.store_name AS to_store_name
     FROM store_unbind_requests r
     LEFT JOIN stores sf ON sf.store_id = r.from_store_id
     LEFT JOIN stores st ON st.store_id = r.to_store_id
     WHERE r.user_id = $1 AND r.status = '待处理'
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [userId]
  )

  ctx.result = {
    request: rows.length > 0 ? {
      requestId: rows[0].request_id,
      fromStoreName: rows[0].from_store_name || '',
      toStoreId: rows[0].to_store_id || '',
      toStoreName: rows[0].to_store_name || '',
      status: rows[0].status,
      note: rows[0].note,
      createdAt: rows[0].created_at,
    } : null
  }
}


async function cancelUnbindRequest(ctx) {
  const { userId } = ctx.auth
  if (!userId) throw new Error('UNAUTHORIZED: 未登录')

  const { requestId } = ctx.event.payload || {}
  if (!requestId) throw new Error('INVALID_PARAMS: 缺少 requestId')

  const rows = await pg.query(
    `SELECT user_id, status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 申请不存在')
  if (rows[0].user_id !== userId) throw new Error('PERMISSION_DENIED: 无权操作此申请')
  if (rows[0].status !== '待处理') throw new Error('INVALID_PARAMS: 申请状态不允许取消')

  const cancelUpd = await pg.query(
    `UPDATE store_unbind_requests SET status = '已取消', updated_at = NOW() WHERE request_id = $1 AND status = '待处理'`,
    [requestId]
  )
  if (cancelUpd.rowCount === 0) {
    throw new Error(
      `INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:${requestId}:待处理→已取消`
    )
  }

  ctx.result = { success: true }
}


async function geocode(ctx) {
  const { latitude, longitude } = ctx.event.payload || {}
  if (!latitude || !longitude) throw new Error('INVALID_PARAMS: 缺少坐标')

  const key = process.env.TMAP_KEY
  const secret = process.env.TMAP_SECRET

  const query = `get_poi=0&key=${key}&location=${latitude},${longitude}`
  const path = '/ws/geocoder/v1/'
  const sig = crypto.createHash('md5').update(`${path}?${query}${secret}`).digest('hex')

  const url = `https://apis.map.qq.com${path}?${query}&sig=${sig}`

  const https = require('https')
  const body = await new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })

  const json = JSON.parse(body)
  if (json.status !== 0) {
    console.error('[geocode] LBS API error:', JSON.stringify(json))
    throw new Error('INVALID_PARAMS: 逆地理编码失败')
  }

  const ac = json.result?.address_component || {}
  const cityName = (ac.city || '').replace(/市$/, '')

  ctx.result = {
    province: ac.province || '',
    city: cityName,
    district: ac.district || '',
  }
}

module.exports = {
  list,
  detail,
  requestUnbind,
  getUnbindRequest,
  cancelUnbindRequest,
  geocode,
}
