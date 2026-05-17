#!/usr/bin/env bun
/**
 * clientApi.store.requestUnbind / getUnbindRequest / cancelUnbindRequest
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/store.js
 *
 * 用例：
 *   1. requestUnbind happy → store_unbind_requests +1 行（status='待处理'）
 *   2. getUnbindRequest → 返回最新待处理申请
 *   3. cancelUnbindRequest → status='已取消'
 *   4. 未绑店 requestUnbind → INVALID_PARAMS: 当前未绑定任何门店
 *   5. 重复 requestUnbind → INVALID_PARAMS: 已有待审批的解绑申请
 *
 * 注意：ctx.auth 由 auth middleware 在 ALLOW_TEST_OPENID=true 下从 _testOpenid 解析，
 *       客户端 invokeAs 已自动注入。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID,
  TEST_CLIENT_OPENID,
  TEST_CLIENT_USER_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  createTestClient,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

async function deleteUnbindRequests() {
  await pgQuery(
    `DELETE FROM store_unbind_requests WHERE user_id LIKE $1`,
    [`${NS}%`]
  )
}

async function caseRequestHappy() {
  await ensureTestStore()
  await createTestClient()  // 已绑 TEST_STORE_ID
  await deleteUnbindRequests()

  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.requestUnbind', { note: '搬家' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.requestId) throw new Error(`expect requestId, got ${res.data.requestId}`)

  const rows = await pgQuery(
    `SELECT status, note FROM store_unbind_requests WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (rows.length !== 1) throw new Error(`expect 1 unbind request, got ${rows.length}`)
  if (rows[0].status !== '待处理') throw new Error(`expect status='待处理', got '${rows[0].status}'`)
  if (rows[0].note !== '搬家') throw new Error(`expect note='搬家', got '${rows[0].note}'`)
}

async function caseGetRequest() {
  await ensureTestStore()
  await createTestClient()
  await deleteUnbindRequests()
  const submitRes = await invokeAs(TEST_CLIENT_OPENID, 'store.requestUnbind', { note: 'q' })
  if (submitRes.code !== 0) throw new Error(`request failed: ${submitRes.message}`)

  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.getUnbindRequest', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.request) throw new Error(`expect request, got null`)
  if (res.data.request.requestId !== submitRes.data.requestId) {
    throw new Error(`requestId mismatch: ${res.data.request.requestId}`)
  }
  if (res.data.request.status !== '待处理') {
    throw new Error(`expect status='待处理', got '${res.data.request.status}'`)
  }
}

async function caseCancelRequest() {
  await ensureTestStore()
  await createTestClient()
  await deleteUnbindRequests()
  const submitRes = await invokeAs(TEST_CLIENT_OPENID, 'store.requestUnbind', { note: 'q' })
  if (submitRes.code !== 0) throw new Error(`request failed: ${submitRes.message}`)
  const requestId = submitRes.data.requestId

  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.cancelUnbindRequest', { requestId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    `SELECT status FROM store_unbind_requests WHERE request_id = $1`,
    [requestId]
  )
  if (rows[0]?.status !== '已取消') {
    throw new Error(`expect status='已取消', got '${rows[0]?.status}'`)
  }
}

async function caseUnboundUser() {
  await ensureTestStore()
  // 使用全新 openid，避开 auth 中间件 AUTH_CACHE 中残留的旧 boundStoreId
  const unboundOpenid = `${NS}_UB_NEW_OPENID`
  const unboundUserId = `${NS}_UB_NEW_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', NULL,
             '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           bound_store_id = NULL`,
    [unboundUserId, unboundOpenid, '19999099022', `${NS}_未绑顾客`]
  )
  await deleteUnbindRequests()

  const res = await invokeAs(unboundOpenid, 'store.requestUnbind', {})
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '当前未绑定任何门店' })
}

async function caseDuplicateRequest() {
  await ensureTestStore()
  await createTestClient()
  await deleteUnbindRequests()
  const first = await invokeAs(TEST_CLIENT_OPENID, 'store.requestUnbind', { note: 'first' })
  if (first.code !== 0) throw new Error(`first request failed: ${first.message}`)

  const second = await invokeAs(TEST_CLIENT_OPENID, 'store.requestUnbind', { note: 'second' })
  expectError(second, 'INVALID_PARAMS', { messageIncludes: '已有待审批的解绑申请' })
}

const CASES = [
  ['requestUnbind happy → 待处理 row inserted', caseRequestHappy],
  ['getUnbindRequest → returns latest pending', caseGetRequest],
  ['cancelUnbindRequest → 已取消', caseCancelRequest],
  ['unbound user requestUnbind → INVALID_PARAMS', caseUnboundUser],
  ['duplicate requestUnbind → INVALID_PARAMS', caseDuplicateRequest],
]

let pass = 0, fail = 0
console.log(`[unbind-flow.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await deleteUnbindRequests()
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
  await deleteUnbindRequests()
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[unbind-flow.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
