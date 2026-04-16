/**
 * 认证模块路由
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')
const { maskPhone } = require('../utils/mask')

/**
 * 微信登录
 * 写入/更新 client_wechat_users
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  // 检查用户是否存在（JOIN stores + org_nodes 获取门店名和市场名）
  const users = await pg.query(
    `SELECT u.user_id, u.phone, u.name, u.avatar_url, u.member_level, u.bound_store_id,
            s.store_name AS bound_store_name,
            pm.name AS bound_market_name
     FROM client_wechat_users u
     LEFT JOIN stores s ON u.bound_store_id = s.store_id
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE u.openid = $1`,
    [OPENID]
  )

  const now = new Date()

  if (users.length === 0) {
    // 新用户,创建记录
    const userId = await generateUserId()
    await pg.query(
      `INSERT INTO client_wechat_users (user_id, openid, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $3, $3)`,
      [userId, OPENID, now]
    )

    // 清除认证缓存，确保后续请求获取到新建的 userId
    invalidateAuthCache(OPENID)

    ctx.result = {
      isNewUser: true,
      userId,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null
    }
  } else {
    // 老用户,更新最后登录时间
    await pg.query(
      'UPDATE client_wechat_users SET last_login_at = $1, updated_at = $1 WHERE user_id = $2',
      [now, users[0].user_id]
    )

    ctx.result = {
      isNewUser: false,
      userId: users[0].user_id,
      phone: users[0].phone,
      name: users[0].name,
      avatarUrl: users[0].avatar_url,
      memberLevel: users[0].member_level,
      boundStoreId: users[0].bound_store_id,
      boundStoreName: users[0].bound_store_name,
      boundMarketName: users[0].bound_market_name
    }
  }
}

/**
 * 绑定手机号
 * 支持两种方式：
 * 1. CloudID 方式（推荐）：前端传入 wx.cloud.CloudID(cloudID)，云函数自动解密
 * 2. 直接传入手机号（用于测试或特殊场景）
 * 同时补全历史订单的 client_user_id
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone } = ctx.event.payload
  // CloudID 必须在 event 顶层才能被微信平台自动解密
  const phoneData = ctx.event.phoneData

  let phoneNumber = null

  // 方式1: CloudID 方式（推荐）
  if (phoneData) {
    if (phoneData.errCode) {
      throw new Error(`INVALID_PARAMS: 手机号解密失败 (${phoneData.errMsg || phoneData.errCode})`)
    }

    const resolved = phoneData.data
    if (!resolved) {
      throw new Error('INVALID_PARAMS: CloudID 未被解密，请检查是否放在 data 顶层')
    }

    phoneNumber = resolved.purePhoneNumber || resolved.phoneNumber

    if (!phoneNumber) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  }
  // 方式2: 直接传入手机号（用于测试或特殊场景）
  else if (directPhone) {
    phoneNumber = directPhone
  }
  // 缺少参数
  else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  const now = new Date()

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  // 首绑守卫：已绑定手机号的用户必须走 auth.rebindPhone（换绑功能）
  if (users[0].phone) {
    throw new Error('INVALID_PARAMS: 已绑定手机号，请使用换绑功能')
  }

  const userId = users[0].user_id

  // 检查手机号是否已被其他用户绑定
  const phoneUsers = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE phone = $1 AND user_id != $2',
    [phoneNumber, userId]
  )

  if (phoneUsers.length > 0) {
    throw new Error('INVALID_PARAMS: 该手机号已被其他用户绑定')
  }

  // 更新手机号
  await pg.query(
    'UPDATE client_wechat_users SET phone = $1, updated_at = $2 WHERE user_id = $3',
    [phoneNumber, now, userId]
  )

  // 清除认证缓存，避免 requirePhone 仍读到旧的 phone: null
  invalidateAuthCache(OPENID)

  // 补全历史订单的 client_user_id（仅首绑场景触发）
  const updateResult = await pg.query(
    `UPDATE sale_orders
     SET client_user_id = $1, updated_at = $2
     WHERE client_phone = $3 AND client_user_id IS NULL`,
    [userId, now, phoneNumber]
  )

  ctx.result = {
    success: true,
    userId,
    phone: phoneNumber,
    updatedOrdersCount: updateResult.rowCount || 0
  }
}

/**
 * 换绑手机号（α 语义 — 跟人走：仅 UPDATE phone 一列，所有业务数据保留）
 *
 * 前置条件：ctx.auth.phone 必须非空（首绑走 bindPhone）
 * 幂等：新号 == 老号 → 直接返回成功
 * 占用检测：
 *   - 其他 user_id 已绑该号 → PHONE_BOUND_BY_OTHER_USER
 *   - 孤儿档案（openid IS NULL 的同号行）→ PHONE_HAS_EXISTING_PROFILE
 * 事务内：
 *   1. UPDATE client_wechat_users.phone（customer_id / member_level / points 等全部保留）
 *   2. INSERT operation_logs（detail 中手机号已 mask）
 *   换绑场景不触发匿名订单归并（sale_orders 不动）。
 */
async function rebindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone } = ctx.event.payload || {}
  const phoneData = ctx.event.phoneData

  // 前置：必须已绑定
  if (!ctx.auth || !ctx.auth.phone) {
    throw new Error('PHONE_REQUIRED: 请先绑定手机号')
  }

  const oldPhone = ctx.auth.phone

  let newPhone = null

  // 方式1：CloudID 解密
  if (phoneData) {
    if (phoneData.errCode) {
      throw new Error(`INVALID_PARAMS: 手机号解密失败 (${phoneData.errMsg || phoneData.errCode})`)
    }
    const resolved = phoneData.data
    if (!resolved) {
      throw new Error('INVALID_PARAMS: CloudID 未被解密，请检查是否放在 data 顶层')
    }
    newPhone = resolved.purePhoneNumber || resolved.phoneNumber
    if (!newPhone) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  } else if (directPhone) {
    // 方式2：直传手机号（测试/特殊场景）
    newPhone = directPhone
  } else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  // 查询当前用户（需 user_id）
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )
  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }
  const userId = users[0].user_id
  const currentPhone = users[0].phone

  // 幂等：新号 == 老号 直接返回成功
  if (newPhone === currentPhone) {
    ctx.result = {
      success: true,
      phone: newPhone,
      oldPhone: currentPhone,
      mergedAnonymousOrders: 0
    }
    return
  }

  // 占用检测 — 细分两种错误码
  const conflictRows = await pg.query(
    `SELECT user_id, openid FROM client_wechat_users
     WHERE phone = $1 AND user_id != $2 LIMIT 1`,
    [newPhone, userId]
  )
  if (conflictRows.length > 0) {
    if (conflictRows[0].openid) {
      throw new Error('PHONE_BOUND_BY_OTHER_USER: 该手机号已被其他微信账号绑定')
    }
    throw new Error('PHONE_HAS_EXISTING_PROFILE: 该手机号在系统中已存在消费档案，请联系门店协助处理')
  }

  const now = new Date()

  // 单事务：UPDATE phone + 审计日志
  await pg.transaction(async (client) => {
    // 仅更新 phone 一列（α 语义：customer_id / member_level / points 等全部保留）
    await client.query(
      'UPDATE client_wechat_users SET phone = $1, updated_at = $2 WHERE user_id = $3',
      [newPhone, now, userId]
    )

    // 审计日志：operation_logs（operator_employee_id 可为 null，顾客自助）
    const detail = {
      oldPhone: maskPhone(oldPhone),
      newPhone: maskPhone(newPhone),
      clientUserId: userId,
      mergedOrders: 0
    }
    await client.query(
      `INSERT INTO operation_logs
         (operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [null, '顾客自助', 'auth.rebindPhone', 'client_user', userId, detail, 'clientApi', now]
    )
    // 注意：换绑场景显式**不触发**匿名订单归并
    // （不执行 UPDATE sale_orders SET client_user_id = ... WHERE client_phone = new_phone AND client_user_id IS NULL）
  })

  // 清除认证缓存
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    phone: newPhone,
    oldPhone,
    mergedAnonymousOrders: 0
  }
}

/**
 * 生成用户 ID: FYGK-{YYYYMMDD}{3位序号}
 * 使用 advisory lock 防并发
 */
async function generateUserId() {
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const prefix = `FYGK-${yyyy}${mm}${dd}-`

  const rows = await pg.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gen_client_user_id'))")
    const { rows } = await client.query(
      "SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 ORDER BY user_id DESC LIMIT 1",
      [prefix + '%']
    )
    return rows
  })

  let seq = 1
  if (rows.length > 0) {
    seq = parseInt(rows[0].user_id.slice(prefix.length), 10) + 1
  }

  return prefix + String(seq).padStart(5, '0')
}

/**
 * 更新用户绑定门店
 * 从 PG stores + org_nodes 验证门店有效性
 */
async function bindStore(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { storeId, sourceChannel, promoterEmployeeId } = ctx.event.payload

  // 参数校验
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  // 验证门店是否存在（从 PG stores + org_nodes 查询）
  const storeCheck = await pg.query(
    `SELECT s.store_id, s.store_name, pm.name AS market_name
     FROM stores s
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE s.store_id = $1 AND s.is_closed = false`,
    [storeId]
  )

  if (storeCheck.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已停业')
  }

  const storeName = storeCheck[0].store_name
  const marketName = storeCheck[0].market_name || null
  const now = new Date()

  // 更新绑定门店（含可选的来源渠道和推荐人）
  const setClauses = ['bound_store_id = $1', 'updated_at = $2']
  const params = [storeId, now]
  if (sourceChannel) {
    params.push(sourceChannel)
    setClauses.push(`customer_source = $${params.length}`)
  }
  if (promoterEmployeeId) {
    params.push(promoterEmployeeId)
    setClauses.push(`promoter_employee_id = $${params.length}`)
  }
  params.push(users[0].user_id)
  await pg.query(
    `UPDATE client_wechat_users SET ${setClauses.join(', ')} WHERE user_id = $${params.length}`,
    params
  )

  // 清除认证缓存，确保后续请求读到最新的 boundStoreId
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    userId: users[0].user_id,
    boundStoreId: storeId,
    boundStoreName: storeName,
    boundMarketName: marketName
  }
}

/**
 * 更新用户资料（昵称）
 */
async function updateProfile(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { name, avatarUrl } = ctx.event.payload || {}

  if (!name && !avatarUrl) {
    throw new Error('INVALID_PARAMS: 至少提供 name 或 avatarUrl')
  }

  const now = new Date()

  const users = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  const setClauses = ['updated_at = $1']
  const params = [now]
  const result = {}

  if (name && typeof name === 'string' && name.trim().length > 0) {
    const trimmedName = name.trim().substring(0, 50)
    params.push(trimmedName)
    setClauses.push(`name = $${params.length}`)
    result.name = trimmedName
  }

  if (avatarUrl && typeof avatarUrl === 'string') {
    const trimmedUrl = avatarUrl.substring(0, 500)
    params.push(trimmedUrl)
    setClauses.push(`avatar_url = $${params.length}`)
    result.avatarUrl = trimmedUrl
  }

  params.push(users[0].user_id)
  await pg.query(
    `UPDATE client_wechat_users SET ${setClauses.join(', ')} WHERE user_id = $${params.length}`,
    params
  )

  invalidateAuthCache(OPENID)

  ctx.result = { success: true, ...result }
}

/**
 * 头像上传（云函数代理）
 * 小程序端直传 COS 默认被存储安全规则拦截（3002），改由云函数用管理员权限上传
 * 客户端传 base64，云函数解码后上传到 avatars/{openid}/ 路径，并同步更新 avatar_url
 */
async function uploadAvatar(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { base64, ext } = ctx.event.payload || {}

  if (!base64 || typeof base64 !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 base64 参数')
  }

  const normalizedExt = String(ext || 'jpg').toLowerCase()
  const allowedExts = ['jpg', 'jpeg', 'png', 'webp']
  if (!allowedExts.includes(normalizedExt)) {
    throw new Error('INVALID_PARAMS: 不支持的图片格式')
  }

  const buffer = Buffer.from(base64, 'base64')
  // 空 base64 解码得到空 buffer；过大图片拒绝（> 2MB）
  if (buffer.length === 0) {
    throw new Error('INVALID_PARAMS: base64 解码为空')
  }
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('INVALID_PARAMS: 图片大小超过 2MB')
  }

  const users = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )
  if (users.length === 0) {
    throw new Error('UNAUTHORIZED: 用户不存在,请先登录')
  }

  const rand = Math.random().toString(36).slice(2, 8)
  const cloudPath = `avatars/${OPENID}/${Date.now()}_${rand}.${normalizedExt}`
  const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer })
  const fileID = uploadRes.fileID

  if (!fileID) {
    throw new Error('INVALID_PARAMS: 上传失败')
  }

  const now = new Date()
  await pg.query(
    'UPDATE client_wechat_users SET avatar_url = $1, updated_at = $2 WHERE user_id = $3',
    [fileID, now, users[0].user_id]
  )

  invalidateAuthCache(OPENID)

  ctx.result = { fileID, avatarUrl: fileID }
}

module.exports = {
  login,
  bindPhone,
  rebindPhone,
  bindStore,
  updateProfile,
  uploadAvatar
}
