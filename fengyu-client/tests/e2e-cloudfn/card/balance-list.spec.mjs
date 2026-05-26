#!/usr/bin/env bun
/**
 * clientApi.card.{balance,list}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/card.js
 *   - balance: requirePhone → prepaid_cards WHERE user_id (一户一账户)
 *   - list:    无 requirePhone → SELECT pc.card_id, balance, created_at FROM prepaid_cards
 *
 * 用每个 case 独立的 openid/userId/cardId 后缀，绕过 auth 中间件 5min OPENID 缓存。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestPrepaidCard, cleanupClientExtras, suffixToPhone,
} from '../helpers/client-fixtures.mjs'
import { ensureTestStore, cleanupTestData } from '../helpers/fixtures.mjs'

/**
 * 独立 fixture：建一个带 openid/phone 的顾客，避开根 createTestClient 的全局常量
 * 让每个用例用独立 user 避开 AUTH_CACHE。
 */
async function makeClient(suffix, { phone = suffixToPhone(`balance-list:${suffix}`) } = {}) {
  const userId = `${NS}_CLI_${suffix}`
  const openid = `${NS}_CLI_OPENID_${suffix}`
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id`,
    [userId, openid, phone, `${NS}_顾客${suffix}`, TEST_STORE_ID]
  )
  return { userId, openid, phone }
}

async function makeClientNoPhone(suffix) {
  const userId = `${NS}_CLI_${suffix}`
  const openid = `${NS}_CLI_OPENID_${suffix}`
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, NULL, $3, '女', $4, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = NULL`,
    [userId, openid, `${NS}_顾客${suffix}`, TEST_STORE_ID]
  )
  return { userId, openid }
}

async function caseBalanceNoCard() {
  const { openid } = await makeClient('B1')
  const res = await invokeAs(openid, 'card.balance', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data?.balance !== 0) throw new Error(`expect balance=0, got ${res.data?.balance}`)
  if (res.data?.cardId !== null) throw new Error(`expect cardId=null, got ${res.data?.cardId}`)
}

async function caseBalanceWithCard() {
  const { userId, openid } = await makeClient('B2')
  await createTestPrepaidCard({
    cardId: `${NS}_CARD_B2`,
    userId,
    balance: '500.00',
  })
  const res = await invokeAs(openid, 'card.balance', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data?.balance !== 500) throw new Error(`expect balance=500, got ${res.data?.balance}`)
  if (res.data?.cardId !== `${NS}_CARD_B2`) {
    throw new Error(`cardId mismatch: ${res.data?.cardId}`)
  }
}

async function caseBalancePhoneRequired() {
  const { openid } = await makeClientNoPhone('B3')
  const res = await invokeAs(openid, 'card.balance', {})
  if (res.code !== -403) throw new Error(`expect code=-403, got ${res.code}: ${res.message}`)
  if (res.errorType !== 'PHONE_REQUIRED') {
    throw new Error(`expect errorType=PHONE_REQUIRED, got ${res.errorType}`)
  }
}

async function caseListNoCard() {
  const { openid } = await makeClient('L1')
  const res = await invokeAs(openid, 'card.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const cards = res.data?.cards || []
  if (cards.length !== 0) throw new Error(`expect empty, got ${cards.length}`)
}

async function caseListWithCard() {
  const { userId, openid } = await makeClient('L2')
  await createTestPrepaidCard({
    cardId: `${NS}_CARD_L2`,
    userId,
    balance: '300.00',
  })
  const res = await invokeAs(openid, 'card.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const cards = res.data?.cards || []
  if (cards.length !== 1) throw new Error(`expect 1 card, got ${cards.length}`)
  if (cards[0].cardId !== `${NS}_CARD_L2`) throw new Error(`cardId mismatch`)
  if (cards[0].balance !== 300) throw new Error(`balance mismatch: ${cards[0].balance}`)
}

const CASES = [
  ['balance no card → balance=0, cardId=null', caseBalanceNoCard],
  ['balance with card → returns numeric balance', caseBalanceWithCard],
  ['balance without phone → PHONE_REQUIRED', caseBalancePhoneRequired],
  ['list no card → empty array', caseListNoCard],
  ['list with single card → 1 row', caseListWithCard],
]

let pass = 0, fail = 0
console.log(`[card-balance-list.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[card-balance-list.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
