/**
 * 门店模块路由
 * 从 PG stores + org_nodes 查询门店数据
 */

const pg = require('../db/pg')
const crypto = require('crypto')

/**
 * 门店列表
 * 从 PG stores + org_nodes 查询，排除已停业的门店
 * @param {string} ctx.event.payload.city - 可选，按城市（市场名）筛选
 */
async function list(ctx) {
  const { city } = ctx.event.payload || {}

  const params = []
  let whereClause = 'WHERE s.is_closed = false'

  // 如果传入 city 参数，按市场名筛选
  if (city) {
    params.push(`${city}%`)
    whereClause += ` AND pm.name LIKE $${params.length}`
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

  // 格式化开业时间
  stores.forEach(s => {
    s.open_date = formatOpenDate(s.open_date)
  })

  ctx.result = { stores }
}

/**
 * 门店详情
 * 按 storeId 查询单条门店记录，并行查询员工数和顾客数
 */
async function detail(ctx) {
  const { storeId, storeName } = ctx.event.payload || {}
  if (!storeId && !storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 或 storeName')
  }

  // 支持按 storeId 或 storeName 查询
  const storeFilter = storeId
    ? { sql: 's.store_id = $1', param: storeId }
    : { sql: 's.store_name = $1', param: storeName }

  // 并行查询：门店基本信息、在职员工数、顾客数
  const [storeResult, staffResult, customerResult] = await Promise.all([
    pg.query(`
      SELECT
        s.store_id,
        pm.name AS market_name,
        s.store_name,
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
      WHERE ${storeFilter.sql} AND s.is_closed = false
      LIMIT 1
    `, [storeFilter.param]),
    pg.query(`
      SELECT COUNT(*)::int AS staff_count
      FROM staff_wechat_users
      WHERE store_id = $1 AND is_resigned = false
    `, [storeId || '__placeholder__']),
    pg.query(`
      SELECT COUNT(*)::int AS customer_count
      FROM client_wechat_users
      WHERE bound_store_id = $1
    `, [storeId || '__placeholder__'])
  ])

  if (storeResult.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }

  const store = storeResult[0]
  store.open_date = formatOpenDate(store.open_date)

  // 用实际 storeId 重新查询计数（如果是按 storeName 查的）
  if (!storeId && store.store_id) {
    const [staffCount, customerCount] = await Promise.all([
      pg.query(
        'SELECT COUNT(*)::int AS staff_count FROM staff_wechat_users WHERE store_id = $1 AND is_resigned = false',
        [store.store_id]
      ),
      pg.query(
        'SELECT COUNT(*)::int AS customer_count FROM client_wechat_users WHERE bound_store_id = $1',
        [store.store_id]
      )
    ])
    store.staff_count = staffCount[0]?.staff_count || 0
    store.customer_count = customerCount[0]?.customer_count || 0
  } else {
    store.staff_count = staffResult[0]?.staff_count || 0
    store.customer_count = customerResult[0]?.customer_count || 0
  }

  ctx.result = { store }
}

/**
 * 格式化开业时间: date → "yyyy年M月"
 */
function formatOpenDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/**
 * 申请解绑门店
 * 向当前绑定门店的店长提交解绑申请
 * payload: { note? }
 */
async function requestUnbind(ctx) {
  const { userId, boundStoreId, boundStoreName } = ctx.auth
  if (!userId) throw new Error('UNAUTHORIZED: 未登录')
  if (!boundStoreId) throw new Error('INVALID_PARAMS: 当前未绑定任何门店')

  const { note } = ctx.event.payload || {}

  // 检查是否已有 pending 申请
  const existing = await pg.query(
    `SELECT request_id FROM store_unbind_requests WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  )
  if (existing.length > 0) {
    throw new Error('INVALID_PARAMS: 已有待审批的解绑申请，请等待审批结果')
  }

  const requestId = crypto.randomUUID()
  await pg.query(
    `INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [requestId, userId, boundStoreName || '', note || null]
  )

  ctx.result = { requestId }
}

/**
 * 查询当前用户最新的 pending 解绑申请
 */
async function getUnbindRequest(ctx) {
  const { userId } = ctx.auth
  if (!userId) {
    ctx.result = { request: null }
    return
  }

  const rows = await pg.query(
    `SELECT request_id, from_store_name, status, note, created_at
     FROM store_unbind_requests
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  )

  ctx.result = {
    request: rows.length > 0 ? {
      requestId: rows[0].request_id,
      fromStoreName: rows[0].from_store_name,
      status: rows[0].status,
      note: rows[0].note,
      createdAt: rows[0].created_at,
    } : null
  }
}

/**
 * 取消解绑申请
 * payload: { requestId }
 */
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
  if (rows[0].status !== 'pending') throw new Error('INVALID_PARAMS: 申请状态不允许取消')

  await pg.query(
    `UPDATE store_unbind_requests SET status = 'cancelled', updated_at = NOW() WHERE request_id = $1`,
    [requestId]
  )

  ctx.result = { success: true }
}

/**
 * 逆地理编码：将经纬度转换为城市名
 * payload: { latitude, longitude }
 */
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
  if (json.status !== 0) throw new Error('INVALID_PARAMS: 逆地理编码失败')

  const city = json.result?.address_component?.city || ''
  const cityName = city.replace(/市$/, '')

  ctx.result = { city: cityName }
}

module.exports = {
  list,
  detail,
  requestUnbind,
  getUnbindRequest,
  cancelUnbindRequest,
  geocode,
}
