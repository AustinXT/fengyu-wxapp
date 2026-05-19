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

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientCoupon,
  ensureClientProductCatalog,
  L3_COUPON_ID,
  L3_SKU_NORMAL_ID,
  L3_PRODUCT_ID,
} from './helpers/client-l3-fixtures.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

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
    await waitForPagePath(ctx.mp, 'profile', { timeoutMs: 5000 })
  }],

  ['3. navigateTo my-coupons', async (ctx) => {
    await ctx.mp.navigateTo('/pagesCoupon/my-coupons/my-coupons')
    await waitForPagePath(ctx.mp, 'my-coupons', { timeoutMs: 6000 })
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

  ['7. checkout 集成：选券 → 应用折扣 → 总价反映优惠', async (ctx) => {
    // deepened: end-to-end coupon application path
    // 先在 home 准备 checkoutItems，再 navigateTo checkout
    await ctx.mp.reLaunch('/pages/home/home')
    await waitForPagePath(ctx.mp, '/pages/home/home', { timeoutMs: 8000 })
    const item = {
      skuId: L3_SKU_NORMAL_ID,
      spuId: L3_PRODUCT_ID,
      spuName: 'TEST_E2E_L3_测试商品',
      skuDisplayName: 'TEST_E2E_L3_普通规格',
      coverImage: '',
      price: 100,
      quantity: 1,
    }
    await ctx.mp.evaluate((it) => {
      wx.setStorageSync('checkoutItems', [it])
    }, item)

    await ctx.mp.navigateTo('/pagesOrder/checkout/checkout?fromCart=1')
    await waitForPagePath(ctx.mp, 'checkout', { timeoutMs: 6000 })
    // 等 checkout init 落位（displayItems 已写入 = onLoad 完成）
    await waitForData(
      ctx.mp,
      (d) => d && Array.isArray(d.displayItems) && d.displayItems.length > 0,
      { name: 'checkout init', timeoutMs: 5000 }
    ).catch(() => {
      // TODO: replace with explicit wait when API contract permits
    })

    const page = await ctx.mp.currentPage()
    // 直接调 onCouponPick 模拟选券（绕过 popup UI）
    await page.callMethod('onCouponPick', {
      currentTarget: {
        dataset: {
          couponId: L3_COUPON_ID,
          name: 'TEST_E2E_L3_满100减10券',
          discount: 10,
        },
      },
    })
    // 等 couponDiscount 落位 + recomputeAmounts 触发完毕
    const after = await waitForData(
      ctx.mp,
      (d) => Number(d?.couponDiscount) === 10 && d?.selectedCoupon?.couponId === L3_COUPON_ID,
      { name: 'coupon applied', timeoutMs: 3000 }
    ).catch(() => null)
    if (!after) {
      throw new Error(`checkout 未应用券折扣（couponDiscount 未变为 10）`)
    }
    // netBeforeCard = totalAmount - couponDiscount = 100 - 10 = 90
    if (Number(after.netBeforeCard) !== 90) {
      throw new Error(`netBeforeCard=${after.netBeforeCard}, expected 90 (100-10)`)
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
  if (mp) {
    try {
      await mp.evaluate(() => {
        wx.removeStorageSync('cart')
        wx.removeStorageSync('checkoutItems')
      })
    } catch {}
    await disconnect(mp)
  }
  await cleanupL3TestData()
  await closePool()
  console.log(`[j9-coupon] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
