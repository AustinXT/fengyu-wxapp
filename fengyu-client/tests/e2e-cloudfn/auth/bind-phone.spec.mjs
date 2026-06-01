#!/usr/bin/env bun
/**
 * clientApi.auth.bindPhone 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/auth.js → bindPhone
 *
 * 用例（绑定走 CloudID mock：phoneData 注入 event 顶层，模拟微信平台已解密结果；
 *       phoneNumber 明文直传旁路已默认关闭，见 case 6）：
 *   1. happy: 已 login 的用户 bindPhone(CloudID) → phone 写入 + updatedOrdersCount=0
 *   2. 补全历史订单：预插一条 client_phone=X / client_user_id=NULL 的 sale_order，
 *      bindPhone(X) 后 sale_orders.client_user_id 被回填
 *   3. 已绑定再绑：用户 phone 不为 null → INVALID_PARAMS: 已绑定手机号
 *   4. 手机号被别人占用：另一个用户先占用 phone X，本用户再绑 X →
 *      INVALID_PARAMS: 该手机号已被其他用户绑定
 *   5. 缺参数：不传 phoneNumber 也不传 phoneData →
 *      INVALID_PARAMS: 缺少 phoneData 或 phoneNumber 参数
 *   6. 安全守护：phoneNumber 明文直传未开 ALLOW_DIRECT_PHONE → INVALID_PARAMS: phoneNumber 直传未启用
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const TEST_OPENID = `${NS}_BP_OPENID`
const TEST_OPENID2 = `${NS}_BP_OPENID_2`
const PHONE_OK = '19999088001'
const PHONE_OCCUPIED = '19999088002'

async function seedLoggedInUser(openid = TEST_OPENID, userIdSuffix = 'BP_USR') {
  const userId = `${NS}_${userIdSuffix}`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET openid = EXCLUDED.openid, phone = NULL`,
    [userId, openid]
  )
  return userId
}

// directPhone（phoneNumber 直传）旁路已默认关闭（仅非 prod 且 ALLOW_DIRECT_PHONE=true 才开）。
// 测试统一走 CloudID 路径：把"已解密手机号"注入 event.phoneData 顶层（模拟微信平台 CloudID 解密结果）。
function bindPhoneCloudID(openid, phone) {
  return invokeAs(openid, 'auth.bindPhone', {}, { phoneData: { data: { purePhoneNumber: phone } } })
}

// 新核心：访客从未 login 建行（无 openid 行、无 phone 行）→ bindPhone 懒建顾客档案
async function caseWalkInLazyCreate() {
  await ensureTestStore()
  // 不 seed 任何行
  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OK)
  expectSuccess(res)
  if (res.data.phone !== PHONE_OK) throw new Error(`phone mismatch: ${res.data.phone}`)
  if (!/^FYGK-\d{8}-\d{5}$/.test(res.data.userId)) {
    throw new Error(`expect FYGK userId, got ${res.data.userId}`)
  }
  const rows = await pgQuery(
    'SELECT user_id, phone FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows.length !== 1) throw new Error(`expect 1 row created, got ${rows.length}`)
  if (rows[0].phone !== PHONE_OK) throw new Error(`PG phone mismatch: ${rows[0].phone}`)
}

// 新核心：孤儿档案回流 —— 按 phone 命中 openid 为 NULL 的行（WorkFine/后台建档）→ attach openid，复用 user_id，不新建
async function caseOrphanAttach() {
  await ensureTestStore()
  const orphanUserId = `${NS}_BP_ORPHAN`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone)
     VALUES ($1, NULL, $2)
     ON CONFLICT (user_id) DO UPDATE SET openid = NULL, phone = EXCLUDED.phone`,
    [orphanUserId, PHONE_OK]
  )
  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OK)
  expectSuccess(res)
  if (res.data.userId !== orphanUserId) {
    throw new Error(`expect reuse orphan user_id=${orphanUserId}, got ${res.data.userId}`)
  }
  // openid 被写入孤儿行，且该 phone 仍只有 1 行（无重复档案）
  const rows = await pgQuery(
    'SELECT user_id, openid FROM client_wechat_users WHERE phone = $1',
    [PHONE_OK]
  )
  if (rows.length !== 1) throw new Error(`expect 1 row (no dup), got ${rows.length}`)
  if (rows[0].openid !== TEST_OPENID) throw new Error(`openid not attached: ${rows[0].openid}`)
}

async function caseHappy() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OK)
  expectSuccess(res)
  if (res.data.phone !== PHONE_OK) throw new Error(`phone mismatch: ${res.data.phone}`)
  // updatedOrdersCount 是 route 实现 bug（pg wrapper 不返回 rowCount），固定 0
  if (res.data.updatedOrdersCount !== 0) {
    throw new Error(`expect updatedOrdersCount=0, got ${res.data.updatedOrdersCount}`)
  }
  const rows = await pgQuery(
    'SELECT phone FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.phone !== PHONE_OK) throw new Error(`PG phone mismatch: ${rows[0]?.phone}`)
}

async function caseBackfillHistoricalOrders() {
  await ensureTestStore()
  const userId = await seedLoggedInUser()
  // 预插一条 phone 对得上、client_user_id 为 NULL 的销售单
  const saleOrderId = `${NS}_BP_HIST_ORD`
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     )
     VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
             NOW(), NULL, $4, $5,
             100, 0, 100, 100,
             '微信'::payment_method, '待分配'::allocation_status)`,
    [saleOrderId, `${NS}_市场`, TEST_STORE_ID, PHONE_OK, `${NS}_老顾客`]
  )

  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OK)
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 注：route 内部 updatedOrdersCount 计算依赖 pg.query 返回 result 对象上的 rowCount，
  // 但 clientApi/db/pg.js::query 仅 return result.rows（数组），导致 rowCount 总为 undefined → 0。
  // 这是路由实现侧 bug；当前 spec 不修源码，仅通过 PG 验证 client_user_id 已回填。
  const rows = await pgQuery(
    'SELECT client_user_id FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId]
  )
  if (rows[0]?.client_user_id !== userId) {
    throw new Error(`expect client_user_id=${userId} (backfilled), got ${rows[0]?.client_user_id}`)
  }
}

async function caseAlreadyBound() {
  await ensureTestStore()
  const userId = `${NS}_BP_BOUND_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone`,
    [userId, TEST_OPENID, '19999088009']
  )
  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OK)
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '已绑定手机号' })
}

async function casePhoneOccupied() {
  await ensureTestStore()
  // 先有用户 A 占用 phone
  const userIdA = `${NS}_BP_OCCUPIER`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone`,
    [userIdA, TEST_OPENID2, PHONE_OCCUPIED]
  )
  // 再有用户 B 想绑同样 phone
  await seedLoggedInUser(TEST_OPENID, 'BP_USR')
  const res = await bindPhoneCloudID(TEST_OPENID, PHONE_OCCUPIED)
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '该手机号已被其他用户绑定' })
}

async function caseMissingParams() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindPhone', {})
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '缺少 phoneData 或 phoneNumber' })
}

// 安全守护：directPhone（phoneNumber 直传）旁路在未开 ALLOW_DIRECT_PHONE 时必须被拒，
// 防止"绑任意手机号 → 账户接管 + 越权读历史订单"。e2e 环境不设 ALLOW_DIRECT_PHONE，故直传应返 INVALID_PARAMS。
async function caseDirectPhoneDisabled() {
  await ensureTestStore()
  await seedLoggedInUser()
  const res = await invokeAs(TEST_OPENID, 'auth.bindPhone', { phoneNumber: PHONE_OK })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: 'phoneNumber 直传未启用' })
}

const CASES = [
  ['walk-in lazy create: no prior row → bindPhone creates customer', caseWalkInLazyCreate],
  ['orphan attach: phone-matched openid-NULL row → attach openid, reuse user_id', caseOrphanAttach],
  ['happy: bindPhone writes phone + updatedOrdersCount=0', caseHappy],
  ['backfill historical orders (client_user_id IS NULL → set)', caseBackfillHistoricalOrders],
  ['already bound → INVALID_PARAMS', caseAlreadyBound],
  ['phone occupied by other user → INVALID_PARAMS', casePhoneOccupied],
  ['missing both phoneNumber and phoneData → INVALID_PARAMS', caseMissingParams],
  ['directPhone 直传未开 ALLOW_DIRECT_PHONE → INVALID_PARAMS（安全守护）', caseDirectPhoneDisabled],
]

let pass = 0, fail = 0
console.log(`[bind-phone.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[bind-phone.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
