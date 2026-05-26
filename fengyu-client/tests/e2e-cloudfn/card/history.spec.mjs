#!/usr/bin/env bun
/**
 * clientApi.card.history
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/card.js
 *   SELECT id, type, amount, ref_order_id, created_at FROM card_transactions
 *   WHERE card_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
 *   ORDER BY created_at DESC LIMIT $2 OFFSET $3
 *
 * 用每个 case 独立的 openid/userId/cardId，绕过 AUTH_CACHE。
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

async function makeClient(suffix) {
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
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone`,
    [userId, openid, suffixToPhone(`history:${suffix}`), `${NS}_顾客${suffix}`, TEST_STORE_ID]
  )
  return { userId, openid }
}

async function insertTxn(cardId, type, amount) {
  await pgQuery(
    `INSERT INTO card_transactions (card_id, type, amount)
     VALUES ($1, $2::card_transaction_type, $3::numeric)`,
    [cardId, type, String(amount)]
  )
}

async function caseHappy() {
  const { userId, openid } = await makeClient('H1A')
  const cardId = `${NS}_CARD_H1`
  await createTestPrepaidCard({ cardId, userId, balance: '1000.00' })
  await insertTxn(cardId, '充值', 500)
  await insertTxn(cardId, '扣款', -100)
  await insertTxn(cardId, '充值', 300)

  const res = await invokeAs(openid, 'card.history', { cardId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const records = res.data?.records || []
  if (records.length !== 3) throw new Error(`expect 3 records, got ${records.length}`)
  // 按 created_at DESC：最新插入的第三条应排第一
  // 但由于 created_at 默认 NOW() 三条几乎同时，至少校验类型集合
  const types = records.map(r => r.type).sort()
  if (JSON.stringify(types) !== JSON.stringify(['充值', '充值', '扣款'])) {
    throw new Error(`types mismatch: ${types.join(',')}`)
  }
  for (const r of records) {
    if (typeof r.amount !== 'number') throw new Error(`amount not number: ${r.amount}`)
  }
}

async function caseMissingCardId() {
  const { openid } = await makeClient('H2A')
  const res = await invokeAs(openid, 'card.history', {})
  if (res.code !== -400) throw new Error(`expect code=-400, got ${res.code}: ${res.message}`)
  if (res.errorType !== 'INVALID_PARAMS') {
    throw new Error(`expect errorType=INVALID_PARAMS, got ${res.errorType}`)
  }
}

async function casePagination() {
  const { userId, openid } = await makeClient('H3A')
  const cardId = `${NS}_CARD_H3`
  await createTestPrepaidCard({ cardId, userId, balance: '1000.00' })
  for (let i = 0; i < 5; i++) {
    await insertTxn(cardId, '充值', 100 + i)
  }
  const p1 = await invokeAs(openid, 'card.history', { cardId, page: 1, pageSize: 2 })
  if (p1.code !== 0) throw new Error(`p1 code=${p1.code}: ${p1.message}`)
  if ((p1.data?.records || []).length !== 2) {
    throw new Error(`p1 expect 2, got ${p1.data?.records?.length}`)
  }
  const p2 = await invokeAs(openid, 'card.history', { cardId, page: 2, pageSize: 2 })
  if ((p2.data?.records || []).length !== 2) {
    throw new Error(`p2 expect 2, got ${p2.data?.records?.length}`)
  }
  const p3 = await invokeAs(openid, 'card.history', { cardId, page: 3, pageSize: 2 })
  if ((p3.data?.records || []).length !== 1) {
    throw new Error(`p3 expect 1, got ${p3.data?.records?.length}`)
  }
}

async function case6MonthWindow() {
  const { userId, openid } = await makeClient('H4A')
  const cardId = `${NS}_CARD_H4`
  await createTestPrepaidCard({ cardId, userId, balance: '1000.00' })
  // 插入一条最近的
  await insertTxn(cardId, '充值', 200)
  // 插入一条早于 6 个月（手工 UPDATE created_at）
  const res = await pgQuery(
    `INSERT INTO card_transactions (card_id, type, amount)
     VALUES ($1, '充值'::card_transaction_type, 100::numeric)
     RETURNING id`,
    [cardId]
  )
  const oldId = res[0].id
  await pgQuery(
    `UPDATE card_transactions SET created_at = NOW() - INTERVAL '7 months' WHERE id = $1`,
    [oldId]
  )
  const hist = await invokeAs(openid, 'card.history', { cardId })
  if (hist.code !== 0) throw new Error(`code=${hist.code}: ${hist.message}`)
  const records = hist.data?.records || []
  if (records.length !== 1) throw new Error(`expect 1 record (only recent), got ${records.length}`)
  if (records.find(r => r.id === oldId)) {
    throw new Error('expect old record filtered out by 6-month window')
  }
}

const CASES = [
  ['happy: returns recent txns', caseHappy],
  ['missing cardId → INVALID_PARAMS', caseMissingCardId],
  ['pagination page/pageSize splits correctly', casePagination],
  ['6-month window: older txn not returned', case6MonthWindow],
]

let pass = 0, fail = 0
console.log(`[card-history.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[card-history.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
