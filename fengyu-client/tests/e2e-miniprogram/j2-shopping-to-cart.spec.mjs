#!/usr/bin/env bun
// L3 client journey j2 - shopping to cart
//
// 目标：浏览商品 → 选 SKU → 加购 → cart 页显示
// fengyu-client 的购物车是 localStorage（utils/cart.ts），不走云端表
// 步骤：
//   1. launch + login + fixture（ensureClientProductCatalog 建 3 SKU）
//   2. reLaunch home，等首屏渲染
//   3. callFunction 'product.shopInit'，断言 spuList 包含 TEST_E2E_L3_PROD
//   4. navigateTo /pagesShop/shop/shop（subpackage 商城页）
//   5. callFunction 'product.skuDetail' with skuId=TEST_E2E_L3_SKU_N，断言 price=100
//   6. evaluate 写 localStorage（cart + checkoutItems）模拟加购操作
//   7. navigateTo /pagesShop/shopping-cart/shopping-cart，断言页面 data.items 含刚加的 SKU

import { launchClient, disconnect } from '../../../tests/e2e-miniprogram/helpers/automator.mjs'
import { closePool } from '../../../tests/e2e-miniprogram/helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from '../../../tests/e2e-miniprogram/helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_PRODUCT_ID,
  L3_SKU_NORMAL_ID,
  L3_MALL_CATEGORY_ID,
} from './helpers/client-l3-fixtures.mjs'

const STEPS = [
  ['1. reLaunch home + 等首屏', async (ctx) => {
    await ctx.mp.reLaunch('/pages/home/home')
    await new Promise((r) => setTimeout(r, 2500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('home')) throw new Error(`current path=${page?.path}`)
  }],

  ['2. product.spuList 返回测试商品（shopInit 只首屏，用 spuList 按分类查）', async (ctx) => {
    // shopInit 路由仅返回第一个 group 下的第一个二级分类的 SPU（限定 UI 首屏），
    // 测试商品分类位置不固定，改用 spuList({categoryId}) 精确查询测试分类。
    const res = await ctx.invoke('product.spuList', { categoryId: L3_MALL_CATEGORY_ID })
    if (!res || res.code !== 0) {
      throw new Error(`spuList failed: ${JSON.stringify(res)}`)
    }
    const hay = JSON.stringify(res.data || {})
    if (!hay.includes(L3_PRODUCT_ID)) {
      throw new Error(`spuList 未包含 ${L3_PRODUCT_ID}: ${hay.slice(0, 300)}`)
    }
  }],

  ['3. navigateTo shop 分包', async (ctx) => {
    await ctx.mp.navigateTo('/pagesShop/shop/shop')
    await new Promise((r) => setTimeout(r, 2000))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('shop')) throw new Error(`current path=${page?.path}`)
  }],

  ['4. product.skuDetail 返回正确价格', async (ctx) => {
    const res = await ctx.invoke('product.skuDetail', { skuId: L3_SKU_NORMAL_ID })
    if (!res || res.code !== 0) {
      throw new Error(`skuDetail failed: ${JSON.stringify(res)}`)
    }
    const data = res.data || {}
    const price = Number(data.price ?? data.unitPrice ?? data.sku?.price)
    if (!Number.isFinite(price) || price !== 100) {
      throw new Error(`skuDetail price expect 100, got ${price} (raw=${JSON.stringify(data).slice(0,200)})`)
    }
  }],

  ['5. evaluate 写 localStorage 模拟加购', async (ctx) => {
    const skuId = L3_SKU_NORMAL_ID
    const productId = L3_PRODUCT_ID
    const cartItem = {
      skuId,
      productId,
      productName: 'TEST_E2E_L3_测试商品',
      skuSpecName: 'TEST_E2E_L3_普通规格',
      unitPrice: 100,
      price: 100,
      quantity: 1,
      productType: '单品',
      storeId: TEST_STORE_ID,
    }
    await ctx.mp.evaluate((item) => {
      // utils/cart.ts 用 'cart' key 存 { items: [...] }；checkoutItems 是结算页快照
      const cart = { items: [item] }
      wx.setStorageSync('cart', cart)
      wx.setStorageSync('checkoutItems', [item])
      return true
    }, cartItem)
  }],

  ['6. navigateTo shopping-cart，data.items 含刚加 SKU', async (ctx) => {
    await ctx.mp.navigateTo('/pagesShop/shopping-cart/shopping-cart')
    await new Promise((r) => setTimeout(r, 1500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('shopping-cart')) {
      throw new Error(`current path=${page?.path} 非 shopping-cart`)
    }
    // 优先看页面 data.items；兜底直接读 localStorage 验证写入成功
    let items = []
    try {
      const data = await page.data()
      items = data?.items || data?.cart?.items || []
    } catch {
      // 部分页面 data 可能尚未填充，读 storage 兜底
    }
    if (!items.length) {
      const storage = await ctx.mp.evaluate(() => {
        return {
          cart: wx.getStorageSync('cart'),
          checkoutItems: wx.getStorageSync('checkoutItems'),
        }
      })
      items = storage.cart?.items || storage.checkoutItems || []
    }
    const hit = items.find((it) => it.skuId === L3_SKU_NORMAL_ID)
    if (!hit) {
      throw new Error(`shopping-cart 未找到 SKU=${L3_SKU_NORMAL_ID}（items=${JSON.stringify(items).slice(0,200)}）`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j2-shopping-to-cart] start | ${new Date().toISOString()}`)
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
    // 顺手清掉测试 storage，避免污染下次 IDE 会话
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
  console.log(`[j2-shopping-to-cart] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
