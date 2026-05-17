#!/usr/bin/env bun
/**
 * clientApi.points.balance / points.history 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/points.js
 *
 * 用例：
 *   1. balance 默认 0          — 新顾客 → {balance: 0, levelName: null}
 *   2. balance 含会员等级       — UPDATE points_balance=200, member_level='星钻' → 对应值
 *   3. history 默认倒序         — 插 3 条不同 type → 返回 3 条按 created_at DESC
 *   4. history 分页             — 插 5 条 → page=1 pageSize=2 → 返回 2 条
 *   5. history 空               — 无流水 → records=[]
 *
 * 实测路由返回字段：{ balance, levelName, levelBenefits, nextLevel }（无 points / memberLevel）
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  pgQuery,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import { cleanupClientExtras, createTestPointTxn } from '../helpers/client-fixtures.mjs'

async function caseBalanceDefaultZero() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'points.balance', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.balance !== 0) throw new Error(`expect balance=0, got ${res.data.balance}`)
  if (res.data.levelName !== null) throw new Error(`expect levelName=null, got ${res.data.levelName}`)
}

async function caseBalanceWithMemberLevel() {
  await createTestClient()
  await pgQuery(
    `UPDATE client_wechat_users SET points_balance = 200, member_level = '星钻'::member_level WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'points.balance', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.balance !== 200) throw new Error(`expect balance=200, got ${res.data.balance}`)
  if (res.data.levelName !== '星钻') throw new Error(`expect levelName=星钻, got ${res.data.levelName}`)
}

async function caseHistoryDefaultDesc() {
  await createTestClient()
  await createTestPointTxn({ type: '消费赠送', amount: 10 })
  await new Promise(r => setTimeout(r, 5))
  await createTestPointTxn({ type: '使用扣减', amount: -3 })
  await new Promise(r => setTimeout(r, 5))
  await createTestPointTxn({ type: '人工调整', amount: 100, remark: 'NS_admin_adjust' })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'points.history', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const records = res.data.records
  if (!Array.isArray(records) || records.length !== 3) {
    throw new Error(`expect 3 records, got ${records?.length}`)
  }
  // 验证倒序：第一条应该是最新的（人工调整 amount=100）
  if (records[0].amount !== 100) {
    throw new Error(`expect first record amount=100 (newest), got ${records[0].amount}`)
  }
  if (records[2].amount !== 10) {
    throw new Error(`expect last record amount=10 (oldest), got ${records[2].amount}`)
  }
}

async function caseHistoryPagination() {
  await createTestClient()
  for (let i = 0; i < 5; i++) {
    await createTestPointTxn({ type: '消费赠送', amount: i + 1 })
    await new Promise(r => setTimeout(r, 3))
  }
  const res = await invokeAs(TEST_CLIENT_OPENID, 'points.history', { page: 1, pageSize: 2 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.records.length !== 2) {
    throw new Error(`expect 2 records (page=1 pageSize=2), got ${res.data.records.length}`)
  }
}

async function caseHistoryEmpty() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'points.history', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.records) || res.data.records.length !== 0) {
    throw new Error(`expect empty records, got ${JSON.stringify(res.data.records)}`)
  }
}

const CASES = [
  ['balance default → balance=0, levelName=null', caseBalanceDefaultZero],
  ['balance with member level → 200 / 星钻', caseBalanceWithMemberLevel],
  ['history 3 txns → desc order', caseHistoryDefaultDesc],
  ['history pagination → page=1 pageSize=2 returns 2', caseHistoryPagination],
  ['history empty → []', caseHistoryEmpty],
]

let pass = 0, fail = 0
console.log(`[points/balance-history.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[points/balance-history.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
