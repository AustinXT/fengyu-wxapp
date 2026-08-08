#!/usr/bin/env bun
/**
 * clientApi.auth.bindStore 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/auth.js → bindStore
 *
 * 用例：
 *   1. happy: bindStore({storeId}) → bound_store_id 写入 + 返回 boundStoreName / boundMarketName
 *   2. 换店：再次 bindStore 不同 storeId → bound_store_id 更新（路由不限制换店）
 *   3. sourceChannel 写入：传 sourceChannel='抖音' → customer_source = '抖音'
 *   4. 邀请人一次绑定：先建 inviter（FYGK-* user_id），再 bindStore 传 inviterUserId →
 *      inviter_user_id + invited_at 写入；再次 bindStore 传不同 inviterUserId 不覆盖（仅首次）
 *   5. 门店不存在：storeId 传不存在的 ID → INVALID_PARAMS: 门店不存在或已停业
 *
 * 注意：cleanupClientExtras 会清掉 openid LIKE 'TE2L2%' 的所有 client_wechat_users 行
 *       （包括我们插入的 inviter），无需额外清理。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID, TEST_MARKET_ORG_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const TEST_OPENID = `${NS}_BS_OPENID`
const INVITER_OPENID = `${NS}_BS_INV_OPENID`

// 绑门店前必须已绑手机号（bindStore 守卫），故 seed 带 phone 的已建档用户。
let _bsPhoneSeq = 0
async function seedLoggedInUser(openid = TEST_OPENID, userId = `${NS}_BS_USR`) {
  // phone 走唯一约束 + 格式校验，给每个 user 唯一手机号
  const phone = `1990000${String(7000 + (_bsPhoneSeq++)).padStart(4, '0')}`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           bound_store_id = NULL,
           customer_source = NULL,
           promoter_employee_name = NULL,
           inviter_user_id = NULL,
           invited_at = NULL`,
    [userId, openid, phone]
  )
  return userId
}

async function seedInviter(userId, openid = INVITER_OPENID) {
  // user_id 必须 FYGK- 开头才能通过 bindStore 的前缀校验
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET openid = EXCLUDED.openid`,
    [userId, openid]
  )
}

async function caseHappy() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', { storeId: TEST_STORE_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.boundStoreId !== TEST_STORE_ID) {
    throw new Error(`boundStoreId mismatch: ${res.data.boundStoreId}`)
  }
  if (!res.data.boundStoreName || !res.data.boundStoreName.includes(NS)) {
    throw new Error(`boundStoreName mismatch: ${res.data.boundStoreName}`)
  }
  if (!res.data.boundMarketName || !res.data.boundMarketName.includes(NS)) {
    throw new Error(`boundMarketName mismatch: ${res.data.boundMarketName}`)
  }
  const rows = await pgQuery(
    'SELECT bound_store_id FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.bound_store_id !== TEST_STORE_ID) {
    throw new Error(`PG bound_store_id mismatch: ${rows[0]?.bound_store_id}`)
  }
}

async function caseSwitchStore() {
  await ensureTestStore()
  await seedLoggedInUser()
  // 先建一个备用门店 B（必须先 INSERT org_nodes 再 INSERT stores 以满足 FK）
  const STORE_B_ID = `${NS}_STORE_B`
  const ORG_B_ID = `${NS}_STORE_ORG_B`
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [ORG_B_ID, `${NS}_测试店B`, TEST_MARKET_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [STORE_B_ID, `${NS}_测试店B`, ORG_B_ID]
  )

  // 第一次绑 A
  let res = await invokeAs(TEST_OPENID, 'auth.bindStore', { storeId: TEST_STORE_ID })
  expectSuccess(res)
  // 第二次绑 B
  res = await invokeAs(TEST_OPENID, 'auth.bindStore', { storeId: STORE_B_ID })
  expectSuccess(res)
  if (res.data.boundStoreId !== STORE_B_ID) {
    throw new Error(`expect boundStoreId=${STORE_B_ID}, got ${res.data.boundStoreId}`)
  }
}

async function caseSourceChannel() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', {
    storeId: TEST_STORE_ID,
    sourceChannel: '抖音',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    'SELECT customer_source FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.customer_source !== '抖音') {
    throw new Error(`expect customer_source='抖音', got '${rows[0]?.customer_source}'`)
  }
}

async function casePromoterEmployeeName() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', {
    storeId: TEST_STORE_ID,
    promoterEmployeeName: '王推荐',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    'SELECT promoter_employee_name FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID],
  )
  if (rows[0]?.promoter_employee_name !== '王推荐') {
    throw new Error(`expect promoter_employee_name='王推荐', got '${rows[0]?.promoter_employee_name}'`)
  }
}

async function caseLegacyPromoterFieldWritesName() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', {
    storeId: TEST_STORE_ID,
    promoterEmployeeId: '王旧版推荐',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    'SELECT promoter_employee_name FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID],
  )
  if (rows[0]?.promoter_employee_name !== '王旧版推荐') {
    throw new Error(`expect legacy promoterEmployeeId to write '王旧版推荐', got '${rows[0]?.promoter_employee_name}'`)
  }
}

async function caseInviter() {
  await ensureTestStore()
  const userId = await seedLoggedInUser()
  // 注意 user_id 必须 FYGK-* 才能通过路由前缀校验
  const inviterId = 'FYGK-20260101-99999'
  await seedInviter(inviterId)

  // 首次绑店带 inviter
  let res = await invokeAs(TEST_OPENID, 'auth.bindStore', {
    storeId: TEST_STORE_ID,
    inviterUserId: inviterId,
  })
  if (res.code !== 0) throw new Error(`first bind failed: ${res.message}`)
  let rows = await pgQuery(
    'SELECT inviter_user_id, invited_at FROM client_wechat_users WHERE user_id = $1',
    [userId]
  )
  if (rows[0]?.inviter_user_id !== inviterId) {
    throw new Error(`expect inviter_user_id=${inviterId}, got ${rows[0]?.inviter_user_id}`)
  }
  if (!rows[0]?.invited_at) throw new Error(`expect invited_at set, got null`)

  // 二次再绑同 store + 不同 inviter，应不覆盖
  const inviterId2 = 'FYGK-20260101-88888'
  await seedInviter(inviterId2, `${NS}_BS_INV2_OPENID`)
  res = await invokeAs(TEST_OPENID, 'auth.bindStore', {
    storeId: TEST_STORE_ID,
    inviterUserId: inviterId2,
  })
  if (res.code !== 0) throw new Error(`second bind failed: ${res.message}`)
  rows = await pgQuery(
    'SELECT inviter_user_id FROM client_wechat_users WHERE user_id = $1',
    [userId]
  )
  if (rows[0]?.inviter_user_id !== inviterId) {
    throw new Error(`expect inviter_user_id unchanged=${inviterId}, got ${rows[0]?.inviter_user_id}`)
  }
}

async function caseStoreNotExist() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', { storeId: 'NOT_EXIST_STORE_XYZ' })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '门店不存在或已停业' })
}

// 未授权手机号（无行 / 行无 phone）→ 绑门店前必须先绑手机号
async function casePhoneRequired() {
  await ensureTestStore()
  // 不 seed 任何行（模拟仅浏览、未授权手机号的访客）
  const res = await invokeAs(TEST_OPENID, 'auth.bindStore', { storeId: TEST_STORE_ID })
  expectError(res, 'PHONE_REQUIRED', { messageIncludes: '请先绑定手机号' })
}

const CASES = [
  ['happy: bindStore writes bound_store_id + returns names', caseHappy],
  ['switch store A → B', caseSwitchStore],
  ['sourceChannel 抖音 → customer_source', caseSourceChannel],
  ['promoterEmployeeName → promoter_employee_name', casePromoterEmployeeName],
  ['legacy promoterEmployeeId → promoter_employee_name', caseLegacyPromoterFieldWritesName],
  ['inviter first bind sets, second bind keeps first', caseInviter],
  ['storeId not exist → INVALID_PARAMS', caseStoreNotExist],
  ['no phone bound → PHONE_REQUIRED', casePhoneRequired],
]

let pass = 0, fail = 0
console.log(`[bind-store.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[bind-store.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
