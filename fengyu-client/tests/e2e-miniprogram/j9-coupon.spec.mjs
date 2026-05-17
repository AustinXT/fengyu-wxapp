#!/usr/bin/env bun
// L3 client journey j9 - coupon
//
// 目标：优惠券页（我的券）+ checkout 用券（available 满/未满门槛）
// 步骤：
//   1. 前置：ensureClientCoupon(满 100 减 10) + ensureClientProductCatalog
//   2. switchTab profile
//   3. navigateTo my-coupons
//   4. callFunction 'coupon.list' → 验证返回 1 张 status='未使用'
//   5. coupon.available {storeId, items[{skuId,quantity:1,amount:100}]} → 包含该券
//   6. coupon.available {amount:50}（不满门槛） → 不返回该券

import { launchClient, disconnect } from '../../../tests/e2e-miniprogram/helpers/automator.mjs'
import { closePool, query } from '../../../tests/e2e-miniprogram/helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from '../../../tests/e2e-miniprogram/helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientCoupon,
  ensureClientProductCatalog,
  L3_COUPON_ID,
  L3_SKU_NORMAL_ID,
} from './helpers/client-l3-fixtures.mjs'

const STEPS = [
  ['1. 前置：商品 + 优惠券（满 100 减 10）', async (ctx) => {
    await ensureClientProductCatalog()
    await ensureClientCoupon({
      userId: ctx.userId,
      discountValue: '10.00',
      minSpend: '100.00',
      status: '未使用',
    })
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await new Promise((r) => setTimeout(r, 1500))
  }],

  ['3. navigateTo my-coupons', async (ctx) => {
    await ctx.mp.navigateTo('/pagesCoupon/my-coupons/my-coupons')
    await new Promise((r) => setTimeout(r, 1500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('my-coupons')) {
      throw new Error(`current path=${page?.path} 非 my-coupons`)
    }
  }],

  ['4. coupon.list → 1 张未使用', async (ctx) => {
    const res = await ctx.invoke('coupon.list')
    if (!res || res.code !== 0) {
      throw new Error(`coupon.list failed: ${JSON.stringify(res)}`)
    }
    const coupons = res.data?.coupons || []
    // 仅校验包含 L3 测试券（probe 用户可能有历史券）
    const mine = coupons.find(c => c.couponId === L3_COUPON_ID)
    if (!mine) {
      throw new Error(`coupon.list 未含 L3 测试券，全部券=${JSON.stringify(coupons.map(c => c.couponId))}`)
    }
    if (mine.status !== '未使用') {
      throw new Error(`coupon status=${mine.status}, expected 未使用`)
    }
  }],

  ['5. coupon.available 满门槛 → 包含该券', async (ctx) => {
    const res = await ctx.invoke('coupon.available', {
      storeId: TEST_STORE_ID,
      items: [{ skuId: L3_SKU_NORMAL_ID, quantity: 1, amount: 100 }],
    })
    if (!res || res.code !== 0) {
      throw new Error(`coupon.available(100) failed: ${JSON.stringify(res)}`)
    }
    const coupons = res.data?.coupons || []
    const mine = coupons.find(c => c.couponId === L3_COUPON_ID)
    if (!mine) {
      throw new Error(`coupon.available(100) 未含 L3 测试券`)
    }
    if (Number(mine.discount) !== 10) {
      throw new Error(`discount=${mine.discount}, expected 10`)
    }
  }],

  ['6. coupon.available 不满门槛 → 不返回该券', async (ctx) => {
    const res = await ctx.invoke('coupon.available', {
      storeId: TEST_STORE_ID,
      items: [{ skuId: L3_SKU_NORMAL_ID, quantity: 1, amount: 50 }],
    })
    if (!res || res.code !== 0) {
      throw new Error(`coupon.available(50) failed: ${JSON.stringify(res)}`)
    }
    const coupons = res.data?.coupons || []
    const mine = coupons.find(c => c.couponId === L3_COUPON_ID)
    if (mine) {
      throw new Error(`coupon.available(50) 不应含 L3 测试券（min_spend=100），但返回了`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j9-coupon] start | ${new Date().toISOString()}`)
try {
  await cleanupL3TestData()
  await ensureBaseFixtures()

  mp = await launchClient()
  const auth = await loginAsTestClient(mp)
  const ctx = { mp, ...auth }

  for (const [name, fn] of STEPS) {
    process.stdout.write(`  · ${name} ... `)
    await fn(ctx)
    console.log('OK')
  }
  pass = true
} catch (e) {
  console.error(`  FAIL: ${e.message}`)
  if (process.env.E2E_DEBUG) console.error(e.stack)
} finally {
  if (mp) await disconnect(mp)
  await cleanupL3TestData()
  await closePool()
  console.log(`[j9-coupon] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
