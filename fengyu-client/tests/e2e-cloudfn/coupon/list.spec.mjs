#!/usr/bin/env bun
/**
 * clientApi.coupon.list
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/coupon.js
 *   - requirePhone
 *   - 懒清扫：UPDATE user_coupons SET status='已过期' WHERE status='未使用' AND expire_at<=NOW()
 *   - JOIN coupon_templates，可按 status 过滤
 *
 * 每个 case 独立 openid/userId 避开 AUTH_CACHE。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestCoupon, createTestCouponTemplate,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'
import { ensureTestStore, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'

async function makeClient(suffix, { withPhone = true } = {}) {
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
    [
      userId, openid,
      withPhone ? `1999909${suffix.slice(-4).padStart(4, '0')}` : null,
      `${NS}_顾客${suffix}`,
      TEST_STORE_ID,
    ]
  )
  return { userId, openid }
}

async function caseAllStatuses() {
  const { userId, openid } = await makeClient('CL1')
  // 共用一个模板
  await createTestCouponTemplate({ templateId: `${NS}_CTPL_CL1` })
  await createTestCoupon({
    couponId: `${NS}_CPN_CL1A`, templateId: `${NS}_CTPL_CL1`, userId, status: '未使用',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_CL1B`, templateId: `${NS}_CTPL_CL1`, userId, status: '已使用',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_CL1C`, templateId: `${NS}_CTPL_CL1`, userId, status: '已过期',
    expireAt: new Date(Date.now() - 86400_000),
  })
  const res = await invokeAs(openid, 'coupon.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const coupons = res.data?.coupons || []
  if (coupons.length !== 3) throw new Error(`expect 3 coupons, got ${coupons.length}`)
}

async function caseStatusFilter() {
  const { userId, openid } = await makeClient('CL2')
  await createTestCouponTemplate({ templateId: `${NS}_CTPL_CL2` })
  await createTestCoupon({
    couponId: `${NS}_CPN_CL2A`, templateId: `${NS}_CTPL_CL2`, userId, status: '未使用',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_CL2B`, templateId: `${NS}_CTPL_CL2`, userId, status: '已使用',
  })
  const res = await invokeAs(openid, 'coupon.list', { status: '未使用' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const coupons = res.data?.coupons || []
  if (coupons.length !== 1) throw new Error(`expect 1 coupon, got ${coupons.length}`)
  if (coupons[0].status !== '未使用') throw new Error(`status mismatch: ${coupons[0].status}`)
}

async function caseLazyExpire() {
  const { userId, openid } = await makeClient('CL3')
  await createTestCouponTemplate({ templateId: `${NS}_CTPL_CL3` })
  // 一张 expire_at 已过期但状态仍为 '未使用'
  await createTestCoupon({
    couponId: `${NS}_CPN_CL3A`,
    templateId: `${NS}_CTPL_CL3`,
    userId,
    status: '未使用',
    expireAt: new Date(Date.now() - 60_000), // 1 min ago
  })
  // 调用 list 触发懒清扫
  const res = await invokeAs(openid, 'coupon.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)

  // PG 查验：状态应被改为 '已过期'
  const rows = await pgQuery(
    `SELECT status FROM user_coupons WHERE coupon_id = $1`,
    [`${NS}_CPN_CL3A`]
  )
  if (rows.length !== 1) throw new Error('coupon row missing')
  if (rows[0].status !== '已过期') {
    throw new Error(`expect lazy-swept status='已过期', got '${rows[0].status}'`)
  }
}

async function casePhoneRequired() {
  const { openid } = await makeClient('CL4', { withPhone: false })
  const res = await invokeAs(openid, 'coupon.list', {})
  if (res.code !== -403) throw new Error(`expect code=-403, got ${res.code}: ${res.message}`)
  if (res.errorType !== 'PHONE_REQUIRED') {
    throw new Error(`expect errorType=PHONE_REQUIRED, got ${res.errorType}`)
  }
}

const CASES = [
  ['list all returns 3 status coupons', caseAllStatuses],
  ['list filtered by status=未使用 returns only 1', caseStatusFilter],
  ['lazy-sweep flips expired 未使用 → 已过期 in DB', caseLazyExpire],
  ['no phone → PHONE_REQUIRED', casePhoneRequired],
]

let pass = 0, fail = 0
console.log(`[coupon-list.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[coupon-list.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
