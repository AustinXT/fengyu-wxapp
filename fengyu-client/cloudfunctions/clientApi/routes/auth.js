

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')
const { testBypassAllowed } = require('../utils/runtime-guard')
const { checkText, checkImage } = require('../utils/wx-sec-check')
const { isMember } = require('../utils/member-pricing')


async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  
  const users = await pg.query(
    `SELECT u.user_id, u.phone, u.name, u.avatar_url, u.member_level, u.customer_type, u.bound_store_id,
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
    
    
    ctx.result = {
      isNewUser: true,
      userId: null,
      openid: OPENID,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null
    }
  } else {
    
    await pg.query(
      'UPDATE client_wechat_users SET last_login_at = $1, updated_at = $1 WHERE user_id = $2',
      [now, users[0].user_id]
    )

    ctx.result = {
      isNewUser: false,
      userId: users[0].user_id,
      openid: OPENID,
      phone: users[0].phone,
      name: users[0].name,
      avatarUrl: users[0].avatar_url,
      memberLevel: users[0].member_level,
      customerType: users[0].customer_type,
      isMember: isMember(users[0].customer_type, users[0].member_level),
      boundStoreId: users[0].bound_store_id,
      boundStoreName: users[0].bound_store_name,
      boundMarketName: users[0].bound_market_name
    }
  }
}


async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone } = ctx.event.payload
  
  const phoneData = ctx.event.phoneData

  let phoneNumber = null

  
  if (phoneData) {
    if (phoneData.errCode) {
      throw new Error(`INVALID_PARAMS: 手机号解密失败 (${phoneData.errMsg || phoneData.errCode})`)
    }

    const resolved = phoneData.data
    if (!resolved) {
      throw new Error('INVALID_PARAMS: 登录凭证未被解密，请稍后重试')
    }

    phoneNumber = resolved.purePhoneNumber || resolved.phoneNumber

    if (!phoneNumber) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  }
  
  else if (directPhone) {
    if (!testBypassAllowed('ALLOW_DIRECT_PHONE')) {
      throw new Error('INVALID_PARAMS: phoneNumber 直传未启用')
    }
    phoneNumber = directPhone
  }
  
  else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  const now = new Date()

  
  
  const byOpenid = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1 LIMIT 1',
    [OPENID]
  )
  if (byOpenid.length > 0 && byOpenid[0].phone) {
    
    throw new Error('INVALID_PARAMS: 已绑定手机号，如需修改请联系门店')
  }
  
  

  
  const phoneRows = await pg.query(
    'SELECT user_id, openid FROM client_wechat_users WHERE phone = $1 ORDER BY user_id DESC LIMIT 1',
    [phoneNumber]
  )

  let userId
  if (phoneRows.length > 0) {
    
    const row = phoneRows[0]
    if (row.openid && row.openid !== OPENID) {
      throw new Error('INVALID_PARAMS: 该手机号已被其他用户绑定')
    }
    
    userId = row.user_id
    await pg.query(
      'UPDATE client_wechat_users SET openid = $1, last_login_at = $2, updated_at = $2 WHERE user_id = $3',
      [OPENID, now, userId]
    )
  } else if (byOpenid.length > 0) {
    
    
    userId = byOpenid[0].user_id
    await pg.query(
      'UPDATE client_wechat_users SET phone = $1, last_login_at = $2, updated_at = $2 WHERE user_id = $3',
      [phoneNumber, now, userId]
    )
  } else {
    
    userId = await generateUserId()
    await pg.query(
      `INSERT INTO client_wechat_users (user_id, openid, phone, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [userId, OPENID, phoneNumber, now]
    )
  }

  
  invalidateAuthCache(OPENID)

  
  
  const updateResult = await pg.query(
    `UPDATE sale_orders
     SET client_user_id = $1, updated_at = $2
     WHERE client_phone = $3 AND client_user_id IS NULL`,
    [userId, now, phoneNumber]
  )

  
  
  
  
  
  try {
    const legacyCheckRows = await pg.query(
      `SELECT COUNT(*)::int AS cnt FROM sale_orders
       WHERE legacy_source = 'workfine' AND client_user_id = $1`,
      [userId]
    )
    const legacyLinked = legacyCheckRows[0]?.cnt || 0
    if (legacyLinked > 0) {
      console.log(`[bindPhone] linked ${legacyLinked} WorkFine legacy orders to user ${userId} (phone=${phoneNumber})`)
    }
  } catch (err) {
    
    console.error('[bindPhone] legacy order link check failed', err && err.message)
  }

  ctx.result = {
    success: true,
    userId,
    phone: phoneNumber,
    updatedOrdersCount: updateResult.rowCount || 0
  }
}


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


async function bindStore(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { storeId, sourceChannel, promoterEmployeeId, inviterUserId } = ctx.event.payload

  
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  
  
  if (users.length === 0 || !users[0].phone) {
    throw new Error('PHONE_REQUIRED: 请先绑定手机号')
  }

  
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

  
  
  
  
  
  if (
    inviterUserId &&
    typeof inviterUserId === 'string' &&
    inviterUserId.startsWith('FYGK-') &&
    inviterUserId !== users[0].user_id
  ) {
    try {
      await pg.query(
        `UPDATE client_wechat_users
            SET inviter_user_id = $1, invited_at = NOW(), updated_at = NOW()
          WHERE user_id = $2
            AND inviter_user_id IS NULL
            AND EXISTS (SELECT 1 FROM client_wechat_users WHERE user_id = $1)`,
        [inviterUserId, users[0].user_id]
      )
    } catch (err) {
      console.warn('[auth.bindStore] bind inviter failed (non-fatal):', err.message)
    }
  }

  
  invalidateAuthCache(OPENID)

  ctx.result = {
    success: true,
    userId: users[0].user_id,
    boundStoreId: storeId,
    boundStoreName: storeName,
    boundMarketName: marketName
  }
}


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
    
    await checkText(trimmedName, { scene: 1 })
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
  
  if (buffer.length === 0) {
    throw new Error('INVALID_PARAMS: 头像数据解析失败')
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

  
  await checkImage(buffer, { openid: OPENID })

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


async function uploadStaffAvatar(ctx) {
  if (!ctx.event._fromHttp || ctx.event._hmacVerified !== true) {
    throw new Error('PERMISSION_DENIED: 仅允许 HMAC 验签的 HTTP 入口')
  }

  const { base64, ext, employeeId } = ctx.event.payload || {}
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 base64 参数')
  }
  if (!employeeId || typeof employeeId !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 employeeId')
  }

  const normalizedExt = String(ext || 'jpg').toLowerCase()
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(normalizedExt)) {
    throw new Error('INVALID_PARAMS: 不支持的图片格式')
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw new Error('INVALID_PARAMS: 头像数据解析失败')
  }
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('INVALID_PARAMS: 图片大小超过 2MB')
  }

  const rand = Math.random().toString(36).slice(2, 8)
  const cloudPath = `avatars/staff/${employeeId}/${Date.now()}_${rand}.${normalizedExt}`

  
  const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer })
  if (!uploadRes.fileID) {
    throw new Error('INVALID_PARAMS: 上传失败')
  }

  const urlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] })
  const fi = urlRes.fileList && urlRes.fileList[0]
  if (!fi || fi.status !== 0 || !fi.tempFileURL) {
    throw new Error('INVALID_PARAMS: 头像上传成功但生成访问链接失败')
  }

  ctx.result = { fileID: uploadRes.fileID, avatarUrl: fi.tempFileURL }
}

module.exports = {
  login,
  bindPhone,
  bindStore,
  updateProfile,
  uploadAvatar,
  uploadStaffAvatar
}
