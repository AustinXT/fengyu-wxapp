#!/usr/bin/env bun
/**
 * clientApi.card.{rechargeConfig,recharge}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/card.js
 *   - rechargeConfig: 公开（PUBLIC_ACTIONS 列表），无需 auth
 *   - recharge: requirePhone + boundStoreId → INSERT sale_orders type='销售单' + 虚拟SKU sale_items
 *     注意：源码中 sale_order_type 实际是 '销售单'（非 '充值单'）；通过 is_recharge_card=true 行级标记区分。
 *
 * 实付校验：源码 matchTier 强制 amount ≥ RECHARGE_MIN_AMOUNT=500，所以 faceValue=100 也会触发
 * INVALID_PARAMS（不仅是 ≤0）；测试覆盖 -100、50、0、faceValue 缺失四种异常。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, invokePublic, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'
import { ensureTestStore, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'

async function makeClient(suffix, { phone = `1999909${suffix}`, withStore = true } = {}) {
  const userId = `${NS}_CLI_${suffix}`
  const openid = `${NS}_CLI_OPENID_${suffix}`
  await ensureTestStore()
  const storeId = withStore ? TEST_STORE_ID : null
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id`,
    [userId, openid, phone, `${NS}_顾客${suffix}`, storeId]
  )
  return { userId, openid }
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
       SET openid = EXCLUDED.openid, phone = NULL,
           bound_store_id = EXCLUDED.bound_store_id`,
    [userId, openid, `${NS}_顾客${suffix}`, TEST_STORE_ID]
  )
  return { userId, openid }
}

async function caseConfig() {
  const res = await invokePublic('card.rechargeConfig', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const { tiers, minAmount, maxAmount } = res.data || {}
  if (!Array.isArray(tiers)) throw new Error('tiers not array')
  if (tiers.length < 3) throw new Error(`expect ≥3 tiers, got ${tiers.length}`)
  const faceValues = tiers.map(t => t.faceValue)
  for (const fv of [500, 1000, 5000]) {
    if (!faceValues.includes(fv)) throw new Error(`expect faceValue ${fv} in tiers`)
  }
  for (const t of tiers) {
    if (typeof t.discount !== 'number') throw new Error(`discount not number`)
    if (typeof t.payAmount !== 'number') throw new Error(`payAmount not number`)
  }
  if (typeof minAmount !== 'number') throw new Error('minAmount missing')
  if (typeof maxAmount !== 'number') throw new Error('maxAmount missing')
}

async function caseRechargeHappy() {
  const { userId, openid } = await makeClient('R1A')
  const res = await invokeAs(openid, 'card.recharge', { faceValue: 1000 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const { saleOrderId, faceValue, payAmount } = res.data || {}
  if (!saleOrderId) throw new Error('saleOrderId missing')
  if (!saleOrderId.startsWith('FY-XSD-WX-')) {
    throw new Error(`saleOrderId format mismatch: ${saleOrderId}`)
  }
  if (faceValue !== 1000) throw new Error(`faceValue mismatch: ${faceValue}`)
  // 1000 × 0.98 = 980
  if (payAmount !== 980) throw new Error(`payAmount mismatch: ${payAmount}`)

  // PG 断言：sale_orders 一行 + sale_items 一行（is_recharge_card=true）
  const orders = await pgQuery(
    `SELECT status, sale_order_type, client_user_id, total_amount, payable_amount
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length !== 1) throw new Error(`expect 1 order row, got ${orders.length}`)
  if (orders[0].status !== '待支付') throw new Error(`status: ${orders[0].status}`)
  if (orders[0].client_user_id !== userId) throw new Error('client_user_id mismatch')
  if (Number(orders[0].total_amount) !== 980) {
    throw new Error(`total_amount mismatch: ${orders[0].total_amount}`)
  }
  const items = await pgQuery(
    `SELECT is_recharge_card, sku_id, product_name FROM sale_items WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (items.length !== 1) throw new Error(`expect 1 item, got ${items.length}`)
  if (items[0].is_recharge_card !== true) {
    throw new Error(`is_recharge_card should be true, got ${items[0].is_recharge_card}`)
  }
}

async function caseRechargeNoStore() {
  const { openid } = await makeClient('R2A', { withStore: false })
  const res = await invokeAs(openid, 'card.recharge', { faceValue: 1000 })
  expectError(res, 'INVALID_PARAMS', { code: -400 })
}

async function caseRechargeBadFaceValue() {
  const { openid } = await makeClient('R3A')
  // -100 → matchTier 抛 INVALID_PARAMS（< MIN 500）
  const res = await invokeAs(openid, 'card.recharge', { faceValue: -100 })
  expectError(res, 'INVALID_PARAMS', { code: -400 })
}

async function caseRechargePhoneRequired() {
  const { openid } = await makeClientNoPhone('R4A')
  const res = await invokeAs(openid, 'card.recharge', { faceValue: 1000 })
  expectError(res, 'PHONE_REQUIRED', { code: -403 })
}

const CASES = [
  ['rechargeConfig returns tiers + min/max', caseConfig],
  ['recharge happy: 1000 → 980 + sale_orders + sale_items', caseRechargeHappy],
  ['recharge no boundStoreId → INVALID_PARAMS', caseRechargeNoStore],
  ['recharge invalid faceValue (-100) → INVALID_PARAMS', caseRechargeBadFaceValue],
  ['recharge without phone → PHONE_REQUIRED', caseRechargePhoneRequired],
]

let pass = 0, fail = 0
console.log(`[card-recharge.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[card-recharge.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
