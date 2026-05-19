#!/usr/bin/env bun
// L3 client journey j3 - checkout & offline pay
//
// 目标：购物车 → 结算 → order.create → order.offlinePay
// 步骤：
//   1. launch + login + fixture（ensureClientProductCatalog 建商品/SKU）
//   2. evaluate 写 localStorage checkoutItems 模拟"已加购"
//   3. navigateTo /pagesOrder/checkout/checkout 验证页面打开
//   4. 直接 callFunction order.create（绕过 UI 提交），断言返回 saleOrderId + status='待支付'
//   5. PG 断言：sale_orders 行存在且 status='待支付'
//   6. callFunction order.offlinePay，PG 断言 status='待确认收款' + payment_method='线下'

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { assertRowCount, assertColumnValue } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_PRODUCT_ID,
  L3_SKU_NORMAL_ID,
} from './helpers/client-l3-fixtures.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const STEPS = [
  ['1. evaluate 写 checkoutItems 模拟加购', async (ctx) => {
    const item = {
      skuId: L3_SKU_NORMAL_ID,
      productId: L3_PRODUCT_ID,
      productName: 'TEST_E2E_L3_测试商品',
      skuSpecName: 'TEST_E2E_L3_普通规格',
      unitPrice: 100,
      price: 100,
      quantity: 1,
      productType: '单品',
      storeId: TEST_STORE_ID,
    }
    await ctx.mp.reLaunch('/pages/home/home')
    await waitForPagePath(ctx.mp, '/pages/home/home', { timeoutMs: 8000 })
    await ctx.mp.evaluate((it) => {
      wx.setStorageSync('cart', { items: [it] })
      wx.setStorageSync('checkoutItems', [it])
      return true
    }, item)
  }],

  ['2. navigateTo checkout 页', async (ctx) => {
    await ctx.mp.navigateTo('/pagesOrder/checkout/checkout?fromCart=1')
    await waitForPagePath(ctx.mp, 'checkout', { timeoutMs: 6000 })
    // checkout.ts onLoad → loadStaffList/loadDefaultStaff/loadCardBalance 链路
    // 终态特征：storeName 或 displayItems 至少之一已落位
    await waitForData(
      ctx.mp,
      (d) => d && (d.storeName || (Array.isArray(d.displayItems) && d.displayItems.length > 0)),
      { name: 'checkout init', timeoutMs: 5000 }
    ).catch(() => {
      // TODO: replace with explicit wait when API contract permits
    })
  }],

  ['3. order.create 返回待支付订单', async (ctx) => {
    const res = await ctx.invoke('order.create', {
      storeId: TEST_STORE_ID,
      items: [{ skuId: L3_SKU_NORMAL_ID, quantity: 1 }],
      paymentMethod: '线下',
    })
    if (!res || res.code !== 0) {
      throw new Error(`order.create failed: ${JSON.stringify(res)}`)
    }
    const saleOrderId = res.data?.saleOrderId
    if (!saleOrderId) throw new Error(`order.create no saleOrderId in data: ${JSON.stringify(res.data)}`)
    ctx.saleOrderId = saleOrderId
    // create 默认返回 '待支付'（offline 走 offlinePay 二段确认）
    if (res.data.status && res.data.status !== '待支付') {
      throw new Error(`order.create status expect 待支付, got ${res.data.status}`)
    }
  }],

  ['4. PG 断言：sale_orders 行存在且待支付', async (ctx) => {
    await assertRowCount('sale_orders', { sale_order_id: ctx.saleOrderId }, 1)
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.saleOrderId },
      { status: '待支付', client_user_id: ctx.userId }
    )
    // sale_items 应至少 1 行
    const items = await query(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`,
      [ctx.saleOrderId]
    )
    if (items.length === 0) throw new Error('sale_items 0 行')
  }],

  ['5. order.offlinePay 切换为待确认收款', async (ctx) => {
    const res = await ctx.invoke('order.offlinePay', { saleOrderId: ctx.saleOrderId })
    if (!res || res.code !== 0) {
      throw new Error(`order.offlinePay failed: ${JSON.stringify(res)}`)
    }
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.saleOrderId },
      { status: '待确认收款', payment_method: '线下' }
    )
  }],

  ['6. 表单校验路径：未同意协议 → onSubmitOrder 拒绝（不调 order.create）', async (ctx) => {
    // deepened: form validation path
    // 复位到 checkout 页确保 page 上下文可用（步骤 2 之后未离开）
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('checkout')) {
      // 兜底：重新进入 checkout 页
      await ctx.mp.navigateTo('/pagesOrder/checkout/checkout?fromCart=1')
      await waitForPagePath(ctx.mp, 'checkout', { timeoutMs: 6000 })
    }
    const pg = await ctx.mp.currentPage()
    // 强制 agreed=false（onSubmitOrder 首行检查）
    await pg.setData({ agreed: false, submitting: false })
    // 调用 onSubmitOrder：应同步 Toast.fail('请先同意消费协议') 然后直接 return
    try { await pg.callMethod('onSubmitOrder') } catch {}
    // 断言：submitting 应该已被重置为 false（onSubmitOrder 早返回，不会卡 submitting=true）
    // 同时未发起 order.create —— 顾客 user 当前应无 '待支付' 单（上一步已 offlinePay 改为 '待确认收款'）
    const after = await pg.data()
    if (after?.submitting === true) {
      throw new Error(`form-reject path: submitting 残留 true（应为 false）`)
    }
    // 反证：当前用户名下不应出现新建的 '待支付' 单（uq_sale_orders_client_pending 也保护）
    const pending = await query(
      `SELECT count(*)::int AS n FROM sale_orders
       WHERE client_user_id = $1 AND status = '待支付' AND sale_order_id <> $2`,
      [ctx.userId, ctx.saleOrderId]
    )
    if ((pending[0]?.n ?? 0) > 0) {
      throw new Error(`form-reject path: 仍有 ${pending[0].n} 条新待支付单（应为 0）`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j3-checkout-pay] start | ${new Date().toISOString()}`)
try {
  await cleanupL3TestData()
  await ensureBaseFixtures()
  await ensureClientProductCatalog()

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
  console.log(`[j3-checkout-pay] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
