#!/usr/bin/env bun
/**
 * 跨端契约：admin 端 Drizzle snake_case 写入 coupon_templates / user_coupons
 *  → client 端原生 SQL 读取，字段名一致、可见 / 可用判定一致。
 *
 * 关于 admin 端：
 *   - admin Server Action（fengyu-admin/src/actions/coupons.ts）走 Next.js Server Action
 *     context（cookies/redirect/revalidatePath），无法在 bun spawn 子进程外直 import 调用。
 *     fengyu-admin/tests/e2e-actions/_admin-preload.mjs 用 bun --preload 注入 4 个 mock
 *     才能跑通；为避免引入额外子进程 mock 体系，本 spec 选轻量路径：
 *   - 直接用 pgQuery INSERT coupon_templates + user_coupons 行（"pretend admin wrote it"）
 *   - 然后用 clientApi.coupon.list + clientApi.coupon.available 真调
 *   - 关键断言：client 能正确读到 admin schema 字段（discount_value/min_spend/expire_at），
 *     且 available 命中判定（金额阈值、状态过滤、过期时间）按 admin 写入语义工作
 *
 * Decision flag: 选 "pseudo admin via pgQuery"。注释明确标注 admin Server Action
 * 未直接 invoke，验证的是 schema 跨端契约不漂移。
 */
import './setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_COUPON_TEMPLATE_ID, TEST_COUPON_ID,
} from './setup.mjs'
import { invokeAs } from './helpers/invoke-client.mjs'
import {
  ensureCrossEndStore, createCrossClient, ensureCrossSku, cleanupCrossEnd,
} from './helpers/fixtures-cross.mjs'
import { TEST_SKU_NORMAL_ID, TEST_STORE_ID } from './setup.mjs'

/** 模拟 admin 端发券（与 fengyu-admin/src/actions/coupons.ts createCouponTemplate + issueCoupon 语义对齐） */
async function adminLikeIssueCoupon({
  templateId = TEST_COUPON_TEMPLATE_ID,
  couponId = TEST_COUPON_ID,
  userId = TEST_CLIENT_USER_ID,
  discountValue = '10.00',
  minSpend = '100.00',
  status = '未使用',
  expireAt = new Date(Date.now() + 86400_000 * 30),
} = {}) {
  // admin 用 Drizzle insert，字段映射 → snake_case
  // 这里直接写 snake_case SQL 模拟 — 关键是验证 client 能读到这些字段
  await pgQuery(
    `INSERT INTO coupon_templates (
       template_id, name, coupon_type, discount_value, min_spend,
       validity_mode, valid_from, valid_to, is_active
     )
     VALUES ($1, $2, '现金券'::coupon_type, $3::numeric, $4::numeric,
             'fixed', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true)
     ON CONFLICT (template_id) DO UPDATE
       SET discount_value = EXCLUDED.discount_value, min_spend = EXCLUDED.min_spend,
           is_active = true`,
    [templateId, `${NS}_admin写入券`, discountValue, minSpend]
  )
  await pgQuery(
    `INSERT INTO user_coupons (
       coupon_id, template_id, user_id, status, expire_at
     )
     VALUES ($1, $2, $3, $4::coupon_status, $5)
     ON CONFLICT (coupon_id) DO UPDATE
       SET status = EXCLUDED.status, expire_at = EXCLUDED.expire_at`,
    [couponId, templateId, userId, status, expireAt]
  )
}

async function caseClientReadsAdminWrittenCoupon() {
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  await adminLikeIssueCoupon()

  // client.coupon.list 应能看到这张券
  const listRes = await invokeAs(TEST_CLIENT_OPENID, 'coupon.list', { status: '未使用' })
  if (listRes.code !== 0) throw new Error(`coupon.list failed: ${listRes.message}`)
  const data = listRes.data
  // 路由返回 {coupons:[{...}]} 或 [{...}] — 兼容两种 shape
  const items = Array.isArray(data) ? data : (data.coupons || data.list || [])
  const mine = items.find((c) => c.couponId === TEST_COUPON_ID || c.coupon_id === TEST_COUPON_ID)
  if (!mine) {
    throw new Error(`expect coupon ${TEST_COUPON_ID} in list, got: ${JSON.stringify(items.map((c) => c.couponId || c.coupon_id))}`)
  }
  // 关键 schema 字段必须 client 端能读
  const discount = Number(mine.discountValue ?? mine.discount_value)
  if (discount !== 10) throw new Error(`expect discountValue=10, got ${discount}`)
  const minSpend = Number(mine.minSpend ?? mine.min_spend)
  if (minSpend !== 100) throw new Error(`expect minSpend=100, got ${minSpend}`)
}

async function caseClientAvailableHitsAdminCoupon() {
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  await ensureCrossSku({ price: '100.00' })
  await adminLikeIssueCoupon()

  // 金额=100 满足 minSpend=100 阈值
  // 路由签名（routes/coupon.js:111）payload: { storeId?, storeName?, items:[{skuId,quantity,amount}] }
  const res = await invokeAs(TEST_CLIENT_OPENID, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1, amount: 100 }],
  })
  if (res.code !== 0) throw new Error(`coupon.available failed: ${res.message}`)
  const data = res.data
  const items = Array.isArray(data) ? data : (data.coupons || data.list || data.available || [])
  const hit = items.find((c) => c.couponId === TEST_COUPON_ID || c.coupon_id === TEST_COUPON_ID)
  if (!hit) {
    throw new Error(`expect coupon ${TEST_COUPON_ID} available at amount=100, got: ${JSON.stringify(items.map((c) => c.couponId || c.coupon_id))}`)
  }
}

async function caseAdminWrittenCouponBelowMinSpendNotAvailable() {
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  await ensureCrossSku({ price: '100.00' })
  await adminLikeIssueCoupon({ minSpend: '200.00' })  // admin 设 minSpend=200

  const res = await invokeAs(TEST_CLIENT_OPENID, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1, amount: 100 }],
  })
  if (res.code !== 0) throw new Error(`coupon.available failed: ${res.message}`)
  const items = Array.isArray(res.data) ? res.data : (res.data.coupons || res.data.list || res.data.available || [])
  const hit = items.find((c) => c.couponId === TEST_COUPON_ID || c.coupon_id === TEST_COUPON_ID)
  // available 可能返回券但标 ineligible — 兼容两种 shape
  const eligible = hit && (hit.eligible !== false && hit.canUse !== false)
  if (eligible) {
    throw new Error(`expect coupon NOT eligible (totalAmount<minSpend), but got eligible: ${JSON.stringify(hit)}`)
  }
}

const CASES = [
  ['client.coupon.list 读 admin 写的 discount_value/min_spend', caseClientReadsAdminWrittenCoupon],
  ['client.coupon.available 命中 admin 写的券（满 100 减 10）', caseClientAvailableHitsAdminCoupon],
  ['admin minSpend=200 + client totalAmount=100 → 不命中', caseAdminWrittenCouponBelowMinSpendNotAvailable],
]

let pass = 0, fail = 0
console.log(`[cross-end/coupon-admin-issue] start | ${CASES.length} cases | ${new Date().toISOString()}`)
try {
  for (const [name, fn] of CASES) {
    await cleanupCrossEnd(NS)
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
  await cleanupCrossEnd(NS)
  await closePool()
}
console.log(`[cross-end/coupon-admin-issue] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
