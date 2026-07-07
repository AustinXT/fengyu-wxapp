

const cloud = require('wx-server-sdk')


const pg = require('../db/pg')
const { testBypassAllowed } = require('../utils/runtime-guard')




const AUTH_CACHE = new Map()
const CACHE_TTL = 60 * 1000 


async function auth(ctx, next) {
  const { OPENID } = cloud.getWXContext()

  
  let effectiveOpenid = OPENID
  if (testBypassAllowed('ALLOW_TEST_OPENID')) {
    const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
    if (testOpenid) effectiveOpenid = testOpenid
  }

  if (!effectiveOpenid) {
    throw new Error('UNAUTHORIZED: 无法获取用户身份')
  }

  
  const cached = AUTH_CACHE.get(effectiveOpenid)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    ctx.auth = cached.data
    return await next()
  }

  
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
      openid: effectiveOpenid,
      userId: null,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null
    }
  } else {
    ctx.auth = {
      isOpenid: true,
      openid: effectiveOpenid,
      userId: users[0].user_id,
      phone: users[0].phone,
      boundStoreId: users[0].bound_store_id,
      boundStoreName: users[0].bound_store_name,
      boundMarketName: users[0].bound_market_name
    }
  }

  
  AUTH_CACHE.set(effectiveOpenid, { data: ctx.auth, ts: Date.now() })

  
  if (AUTH_CACHE.size > 200) {
    const keys = [...AUTH_CACHE.keys()]
    for (let i = 0; i < 100; i++) {
      AUTH_CACHE.delete(keys[i])
    }
  }

  await next()
}


function requirePhone() {
  return async (ctx, next) => {
    if (!ctx.auth.phone) {
      throw new Error('PHONE_REQUIRED: 请先绑定手机号')
    }
    await next()
  }
}


function invalidateAuthCache(openid) {
  AUTH_CACHE.delete(openid)
}

module.exports = {
  auth,
  requirePhone,
  invalidateAuthCache
}
