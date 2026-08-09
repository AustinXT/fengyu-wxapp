/**
 * 认证模块路由
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const { invalidateAuthCache } = require('../middleware/auth')
const { testBypassAllowed } = require('../utils/runtime-guard')
const { checkText, checkImage } = require('../utils/wx-sec-check')
const { isMember } = require('../utils/member-pricing')

/**
 * 微信登录
 * 写入/更新 client_wechat_users
 */
async function login(ctx) {
  const { OPENID } = cloud.getWXContext()

  // 检查用户是否存在（JOIN stores + org_nodes 获取门店名和市场名）
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
    // 仅浏览、未授权手机号的访客不建库行（避免顾客管理出现纯空壳档案）。
    // 顾客档案在 bindPhone 时才懒建/合并，对齐 staff 端 login 不建行的模式。
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
    // 老用户,更新最后登录时间
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

/**
 * 绑定手机号
 * 支持两种方式：
 * 1. CloudID 方式（推荐）：前端传入 wx.cloud.CloudID(cloudID)，云函数自动解密
 * 2. 直接传入手机号（用于测试或特殊场景）
 * 同时补全历史订单的 client_user_id
 */
async function bindPhone(ctx) {
  const { OPENID } = cloud.getWXContext()
  const { phoneNumber: directPhone, inviterUserId } = ctx.event.payload || {}
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
      throw new Error('INVALID_PARAMS: 登录凭证未被解密，请稍后重试')
    }

    phoneNumber = resolved.purePhoneNumber || resolved.phoneNumber

    if (!phoneNumber) {
      throw new Error('INVALID_PARAMS: 无法从 CloudID 获取手机号')
    }
  }
  // 方式2: 直接传入手机号（测试用，独立 ALLOW_DIRECT_PHONE 开关 + 非生产运行时；prod 由 runtime-guard 硬闸禁用）
  else if (directPhone) {
    if (!testBypassAllowed('ALLOW_DIRECT_PHONE')) {
      throw new Error('INVALID_PARAMS: phoneNumber 直传未启用')
    }
    phoneNumber = directPhone
  }
  // 缺少参数
  else {
    throw new Error('INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数')
  }

  const now = new Date()

  // openid 预检：拦截换绑 / 残留行场景，避免后续 INSERT 命中 uq_client_users_openid。
  // 顾客端 bindPhone 仅负责首次绑定；换手机号由管理后台操作。
  const byOpenid = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1 LIMIT 1',
    [OPENID]
  )
  if (byOpenid.length > 0 && byOpenid[0].phone) {
    if (byOpenid[0].phone === phoneNumber) {
      const userId = byOpenid[0].user_id
      await pg.query(
        'UPDATE client_wechat_users SET last_login_at = $1, updated_at = $1 WHERE user_id = $2',
        [now, userId]
      )
      invalidateAuthCache(OPENID)
      ctx.result = {
        success: true,
        userId,
        phone: phoneNumber,
        updatedOrdersCount: 0
      }
      return
    }
    // 已绑定其他手机号 → 首绑守卫（换绑走后台）
    throw new Error('INVALID_PARAMS: 已绑定手机号，如需修改请联系门店')
  }
  // byOpenid.length === 0 → 继续按 phone 查 / INSERT
  // byOpenid.length > 0 且 phone 为空 → 残留行，下面 phone 查询命中后走 attach UPDATE

  // 按手机号查找已有行（含 WorkFine 同步、管理后台手动建的孤儿档案）
  const phoneRows = await pg.query(
    'SELECT user_id, openid FROM client_wechat_users WHERE phone = $1 ORDER BY user_id DESC LIMIT 1',
    [phoneNumber]
  )

  let userId
  if (phoneRows.length > 0) {
    // 按 phone 找到已有行
    const row = phoneRows[0]
    if (row.openid && row.openid !== OPENID) {
      throw new Error('INVALID_PARAMS: 该手机号已被其他用户绑定')
    }
    // openid 为 NULL（孤儿档案回流）或就是本人 → 关联 openid，复用其 user_id
    userId = row.user_id
    await pg.query(
      'UPDATE client_wechat_users SET openid = $1, last_login_at = $2, updated_at = $2 WHERE user_id = $3',
      [OPENID, now, userId]
    )
  } else if (byOpenid.length > 0) {
    // 残留 openid 行（phone 为空，如清库前的旧登录行）→ 直接写入手机号，复用其 user_id，
    // 避免下面 INSERT 命中 uq_client_users_openid。
    userId = byOpenid[0].user_id
    await pg.query(
      'UPDATE client_wechat_users SET phone = $1, last_login_at = $2, updated_at = $2 WHERE user_id = $3',
      [phoneNumber, now, userId]
    )
  } else {
    // 未找到任何行 → walk-in 新客，懒建顾客档案
    userId = await generateUserId()
    await pg.query(
      `INSERT INTO client_wechat_users (user_id, openid, phone, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [userId, OPENID, phoneNumber, now]
    )
    // 分享礼：仅新建顾客时写入邀请关系。老顾客（已有 openid / phone / WorkFine 档案合并）
    // 不在这里补写，bindStore 也不再兜底写入，避免事后补绑邀请人。
    if (
      inviterUserId &&
      typeof inviterUserId === 'string' &&
      inviterUserId.startsWith('FYGK-') &&
      inviterUserId !== userId
    ) {
      try {
        await pg.query(
          `UPDATE client_wechat_users
              SET inviter_user_id = $1, invited_at = $2, updated_at = $2
            WHERE user_id = $3
              AND inviter_user_id IS NULL
              AND EXISTS (SELECT 1 FROM client_wechat_users WHERE user_id = $1)`,
          [inviterUserId, now, userId]
        )
      } catch (err) {
        console.warn('[auth.bindPhone] bind inviter failed (non-fatal):', err.message)
      }
    }
  }

  // 清除认证缓存，避免 requirePhone 仍读到旧的 phone: null
  invalidateAuthCache(OPENID)

  // 补全历史订单的 client_user_id（仅首绑场景触发）
  // CAS-EXEMPT: 仅回写顾客 user_id（PII），不翻 status
  const updateResult = await pg.query(
    `UPDATE sale_orders
     SET client_user_id = $1, updated_at = $2
     WHERE client_phone = $3 AND client_user_id IS NULL`,
    [userId, now, phoneNumber]
  )

  // 同步回填 WorkFine 历史导入订单的 client_user_id；不翻 status（仍 '未审核'）。
  // 顾客本次绑定让 admin /legacy-orders 列表的"已匹配顾客"列变绿，便于店员核对。
  // 实际审核动作发生在管理后台，触发标签重算见 lib/recompute-customer-tags.ts。
  // 注意：上面那条 UPDATE 已经覆盖 legacy_source IS NOT NULL 的行（条件未排除 legacy），
  // 这里不再重复 UPDATE 以免双写 updated_at；只做幂等查询打日志，便于排查。
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
    // 仅用于日志统计，失败不影响绑定主流程
    console.error('[bindPhone] legacy order link check failed', err && err.message)
  }

  ctx.result = {
    success: true,
    userId,
    phone: phoneNumber,
    updatedOrdersCount: updateResult.rowCount || 0
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gen_client_user_id')::bigint)")
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
  const payload = ctx.event.payload || {}
  const { storeId, sourceChannel, promoterEmployeeName, promoterEmployeeId } = payload

  // 参数校验
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }
  if (promoterEmployeeName !== undefined && typeof promoterEmployeeName !== 'string') {
    throw new Error('INVALID_PARAMS: 推荐人姓名格式不正确')
  }
  if (promoterEmployeeId !== undefined && typeof promoterEmployeeId !== 'string') {
    throw new Error('INVALID_PARAMS: 推荐人姓名格式不正确')
  }
  const normalizedPromoterEmployeeName = promoterEmployeeName?.trim()
  const normalizedLegacyPromoterEmployeeName = promoterEmployeeId?.trim()
  if (
    normalizedPromoterEmployeeName
    && normalizedLegacyPromoterEmployeeName
    && normalizedPromoterEmployeeName !== normalizedLegacyPromoterEmployeeName
  ) {
    throw new Error('INVALID_PARAMS: 两个推荐人字段内容不一致')
  }
  // 兼容已发布小程序的旧字段；两者都按推荐人姓名处理，待客户端覆盖后移除。
  const normalizedPromoterName = normalizedPromoterEmployeeName || normalizedLegacyPromoterEmployeeName
  if (normalizedPromoterName && normalizedPromoterName.length > 50) {
    throw new Error('INVALID_PARAMS: 推荐人姓名不能超过50个字符')
  }

  // 查询当前用户
  const users = await pg.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [OPENID]
  )

  // 未授权手机号者不建顾客档案 → 绑门店前必须先绑手机号。
  // 抛 PHONE_REQUIRED 让前端按 errorType 弹绑手机号弹窗。
  if (users.length === 0 || !users[0].phone) {
    throw new Error('PHONE_REQUIRED: 请先绑定手机号')
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

  // 更新绑定门店（含可选的来源渠道和推荐人姓名）
  const setClauses = ['bound_store_id = $1', 'updated_at = $2']
  const params = [storeId, now]
  if (sourceChannel) {
    params.push(sourceChannel)
    setClauses.push(`customer_source = $${params.length}`)
  }
  if (normalizedPromoterName) {
    params.push(normalizedPromoterName)
    setClauses.push(`promoter_employee_name = $${params.length}`)
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
    // 内容安全校验（昵称 = 资料类）：违规抛 INVALID_PARAMS，不落库
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

  // 内容安全校验：违规图直接抛错，不进 COS、不写 avatar_url
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

/**
 * 员工头像上传（跨 env 入口，仅供 staffApi 通过 HTTP 触发器 + HMAC 调用）
 *
 * staffApi 不能直接写 client env 的 COS（wx-server-sdk 跨 env upload 不可靠），
 * 转由本 action 在 client env 内 `cloud.uploadFile + getTempFileURL`，
 * 返回的 HTTPS URL 与 admin 写入的 `products.cover_image` 完全同 shape
 * （都是 client env CDN 域），保证三端 `<image src>` 透明渲染。
 *
 * 守卫：
 *   - index.js HTTP 入口校验 HMAC(body, CLIENT_SECRET) + 时间戳 + allowlist；
 *     校验通过后才在 ctx.event 注入 `_fromHttp=true, _hmacVerified=true`
 *   - 本函数额外断言这两个 flag，防止任何无签名 cloud.callFunction 直调
 */
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

  // 同 env upload（client env），与 admin product-covers/* 写入同一桶
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
