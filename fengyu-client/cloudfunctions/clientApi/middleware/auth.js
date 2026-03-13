/**
 * 认证中间件
 * 从 cloud.getWXContext() 获取 OPENID,查询 client_wechat_users 获取 user_id
 */

const cloud = require('wx-server-sdk')
// cloud.init() 已在 index.js 中调用，此处不再重复

const pg = require('../db/pg')

// 用户信息缓存：OPENID → { data, ts }
const AUTH_CACHE = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/**
 * 认证中间件
 * 将 user_id 注入到 ctx.auth
 */
async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  // 测试模式: 支持通过 testOpenid 参数进行测试
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  const effectiveOpenid = testOpenid || OPENID

  if (!effectiveOpenid) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  // 检查缓存
  const cached = AUTH_CACHE.get(effectiveOpenid)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    ctx.auth = cached.data
    return await next()
  }

  // 查询用户（JOIN stores + org_nodes 获取门店名和市场名）
  const users = await pg.query(
    `SELECT u.user_id, u.phone, u.bound_store_id,
            s.store_name AS bound_store_name,
            pm.name AS bound_market_name
     FROM client_wechat_users u
     LEFT JOIN stores s ON u.bound_store_id = s.store_id
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE u.openid = $1`,
    [effectiveOpenid]
  )

  if (users.length === 0) {
    ctx.auth = {
      isOpenid: true,
      userId: null,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null
    }
  } else {
    ctx.auth = {
      isOpenid: true,
      userId: users[0].user_id,
      phone: users[0].phone,
      boundStoreId: users[0].bound_store_id,
      boundStoreName: users[0].bound_store_name,
      boundMarketName: users[0].bound_market_name
    }
  }

  // 写入缓存
  AUTH_CACHE.set(effectiveOpenid, { data: ctx.auth, ts: Date.now() })

  // 防止缓存无限增长（简单淘汰：超过 200 条清理最早的一半）
  if (AUTH_CACHE.size > 200) {
    const keys = [...AUTH_CACHE.keys()]
    for (let i = 0; i < 100; i++) {
      AUTH_CACHE.delete(keys[i])
    }
  }

  await next()
}

/**
 * 要求必须绑定手机号
 */
function requirePhone() {
  return async (ctx, next) => {
    if (!ctx.auth.phone) {
      throw new Error('PHONE_REQUIRED: 请先绑定手机号')
    }
    await next()
  }
}

/**
 * 清除指定 OPENID 的认证缓存
 * 在绑定手机号等修改用户信息后调用
 */
function invalidateAuthCache(openid) {
  AUTH_CACHE.delete(openid)
}

module.exports = {
  auth,
  requirePhone,
  invalidateAuthCache
}
