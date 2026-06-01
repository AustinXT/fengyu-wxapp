// client L3 登录 helper
//
// 两种模式（自动检测）：
//
// 1. **probe 模式（默认）**：clientApi 未启 ALLOW_TEST_OPENID
//    - automator 调 wx.cloud.callFunction('auth.login') 获取 IDE 真实 OPENID
//    - 用该真实 OPENID 在 client_wechat_users 表 UPSERT 测试 fixture（phone / bound_store_id）
//    - 这一行就是这次 spec 的"测试顾客"
//    - cleanup 时按 openid LIKE 删（不行的话按 openid = realOpenid 精确删）
//
// 2. **inject 模式（可选）**：环境变量 ALLOW_TEST_OPENID_REMOTE=true（前提是远端 clientApi 已开 ALLOW_TEST_OPENID=true）
//    - 所有 callFunction 在 data 顶层注入 _testOpenid: TEST_OPENID_CLIENT
//    - 测试用固定的 TEST_E2E_L3_CLIENT_OPENID 跑，不污染真实 IDE 用户
//
// 当前默认走 probe 模式，因为 cloudbaserc.json 未含 ALLOW_TEST_OPENID。

import { query } from './pg.mjs'
import {
  TEST_STORE_ID,
  ensureBaseFixtures,
} from './fixtures.mjs'
import {
  NAMESPACE,
  TEST_CLIENT_USER_ID, TEST_OPENID_CLIENT, TEST_CLIENT_PHONE,
} from './constants.mjs'

const NS = NAMESPACE.replace(/_$/, '')

export const INJECT_MODE = process.env.ALLOW_TEST_OPENID_REMOTE === 'true'

/**
 * 通过 automator evaluate 调 wx.cloud.callFunction 拿当前 IDE 的真实 OPENID
 *
 * 注意：automator.callWxMethod 不支持 wx.cloud 命名空间下的方法（仅支持顶层 wx.xxx），
 * 必须用 mp.evaluate(() => wx.cloud.callFunction(...)) 进入小程序运行时调用。
 *
 * login 直接回传调用者自己的 openid（新访客不再建库行，userId 可能为 null）。
 *
 * 返回 { userId, openid }（新访客 userId=null，由调用方按 openid UPSERT 建档）
 */
async function probeRealOpenid(miniProgram) {
  const result = await miniProgram.evaluate(async () => {
    const r = await wx.cloud.callFunction({
      name: 'clientApi',
      data: { action: 'auth.login' },
    })
    return r.result
  })
  if (!result || result.code !== 0) {
    throw new Error(`probe auth.login failed: ${JSON.stringify(result)}`)
  }
  const openid = result.data?.openid
  if (!openid) throw new Error('probe auth.login: no openid returned')
  return { userId: result.data?.userId || null, openid }
}

/**
 * 准备测试顾客身份。
 *
 * - INJECT 模式：用固定 TEST_OPENID_CLIENT 创建 fixture client_wechat_users 行，
 *   并返回 invoke wrapper（其会在 data 注入 _testOpenid）
 * - PROBE 模式：先 probe IDE 真实 OPENID，UPSERT 该行为"测试态"（已绑店 + 已绑手机），
 *   返回 invoke wrapper（不注入 _testOpenid，让真实 OPENID 流走）
 *
 * @returns {Promise<{userId, openid, invoke}>}
 */
export async function loginAsTestClient(miniProgram, opts = {}) {
  await ensureBaseFixtures()

  if (INJECT_MODE) {
    // 直接 UPSERT 测试顾客
    await query(
      `INSERT INTO client_wechat_users (
         user_id, openid, phone, name, gender, bound_store_id,
         customer_type, spending_tier, points_balance
       )
       VALUES ($1, $2, $3, $4, '女', $5,
               '流量客'::customer_type, '<1990'::spending_tier, 0)
       ON CONFLICT (user_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
             bound_store_id = EXCLUDED.bound_store_id`,
      [TEST_CLIENT_USER_ID, TEST_OPENID_CLIENT, TEST_CLIENT_PHONE,
       `${NS}_顾客`, TEST_STORE_ID]
    )
    return {
      userId: TEST_CLIENT_USER_ID,
      openid: TEST_OPENID_CLIENT,
      invoke: makeInvoker(miniProgram, TEST_OPENID_CLIENT),
    }
  }

  // PROBE 模式
  const { openid } = await probeRealOpenid(miniProgram)
  // 新访客 login 不再建行 → 按 openid UPSERT 测试顾客态（已绑店 + 已绑手机）。
  // 已存在行则保留其 user_id 并升级；无行则用固定 TEST_CLIENT_USER_ID 建档。
  const existing = await query(
    `SELECT user_id FROM client_wechat_users WHERE openid = $1`,
    [openid]
  )
  let userId
  if (existing.length > 0) {
    userId = existing[0].user_id
    await query(
      `UPDATE client_wechat_users
         SET phone = COALESCE(phone, $1),
             bound_store_id = $2,
             name = COALESCE(NULLIF(name, ''), $3),
             updated_at = NOW()
       WHERE user_id = $4`,
      [TEST_CLIENT_PHONE, TEST_STORE_ID, `${NS}_顾客`, userId]
    )
  } else {
    userId = TEST_CLIENT_USER_ID
    await query(
      `INSERT INTO client_wechat_users (
         user_id, openid, phone, name, gender, bound_store_id,
         customer_type, spending_tier, points_balance
       )
       VALUES ($1, $2, $3, $4, '女', $5,
               '流量客'::customer_type, '<1990'::spending_tier, 0)
       ON CONFLICT (user_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
             bound_store_id = EXCLUDED.bound_store_id`,
      [userId, openid, TEST_CLIENT_PHONE, `${NS}_顾客`, TEST_STORE_ID]
    )
  }
  return {
    userId,
    openid,
    invoke: makeInvoker(miniProgram, null),  // 不注入，走真实 OPENID
  }
}

/**
 * 构造 callFunction wrapper
 *
 * clientApi/index.js 的 main(event) 解构 `{ action, payload }`，
 * 路由读 `ctx.event.payload`，所以 wrapper 必须把业务字段塞进 payload 里，
 * 不能展平到 data 顶层。
 *
 * 用法：
 *   const res = await invoke('order.list', { status: '待支付' })
 */
function makeInvoker(miniProgram, testOpenid) {
  return async function invoke(action, payload = {}) {
    // 必须用 evaluate 进入小程序运行时调 wx.cloud.callFunction
    // callWxMethod 不支持 wx.cloud.* 命名空间
    const data = { action, payload }
    if (testOpenid) data._testOpenid = testOpenid
    return await miniProgram.evaluate(async (cfData) => {
      const r = await wx.cloud.callFunction({ name: 'clientApi', data: cfData })
      return r.result
    }, data)
  }
}
