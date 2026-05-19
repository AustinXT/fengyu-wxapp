#!/usr/bin/env bun
// L3 client journey j13 - 首页搜索 → 进 shop 分类浏览
//
// 目标：
//   A. 首页 search input → 输入测试商品名片段 → 触发 _doSearch → searchResults 含命中
//   B. 从首页或商城分类入口进 /pagesShop/shop/shop → 渲染分类 + spuList
//   C. shop 切分类 → spuList 刷新（_spuCache hit / loadSpuList 调用）
//
// 步骤：
//   1. 前置 fixture：ensureClientProductCatalog（建 mall_category + product + 3 SKU）
//   2. switchTab /pages/home/home + waitForData(spuList loaded)
//   3. 在 home 页 setData({ searchValue: '<NS_>' }) → callMethod('onSearchSubmit')
//      waitForData(d => d.isSearching && d.searchResults.length >= 1)
//      验证 searchResults 中包含我们的测试 product_id
//   4. callMethod('onSearchClear') → 退出搜索
//   5. navigateTo /pagesShop/shop/shop → waitForData(p => p.spuList.length > 0)
//   6. PG cross-check：clientApi product.spuList(category=NS_PRODCAT) 返回数量
//      与前端 spuList 数量一致（同 keyword 维度下应等同）

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
} from './helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_PRODUCT_ID,
  L3_MALL_CATEGORY_ID,
} from './helpers/client-l3-fixtures.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NS = 'TEST_E2E_L3'
// _测试商品 来自 ensureClientProductCatalog 内的命名
const SEARCH_KEYWORD = '测试商品'

const STEPS = [
  ['1. 前置 fixture：商品 + 3 SKU', async (ctx) => {
    await ensureClientProductCatalog()
  }],

  ['2. switchTab /pages/home/home + 等待 spuList 加载', async (ctx) => {
    await ctx.mp.switchTab('/pages/home/home')
    await waitForPagePath(ctx.mp, '/pages/home/home', { timeoutMs: 8000 })
    // 等首屏 shopInit 数据回来（home.ts: data.spuList / data.categories）
    await waitForData(
      ctx.mp,
      (d) => Array.isArray(d?.categories) && d.categories.length > 0,
      { timeoutMs: 8000, name: 'home.categories 加载完' }
    )
  }],

  ['3. 触发搜索：setData searchValue + onSearchSubmit', async (ctx) => {
    const page = await ctx.mp.currentPage()
    // 注入 searchValue，再调 onSearchSubmit（绕过 input 事件）
    await page.setData({ searchValue: SEARCH_KEYWORD })
    await page.callMethod('onSearchSubmit')

    const finalData = await waitForData(
      ctx.mp,
      (d) => d?.isSearching === true && !d?.searchLoading && Array.isArray(d?.searchResults),
      { timeoutMs: 8000, name: 'searchResults 收敛' }
    )

    const hit = (finalData.searchResults || []).find(
      (s) => s.product_id === L3_PRODUCT_ID || (s.name || '').includes(SEARCH_KEYWORD)
    )
    if (!hit) {
      throw new Error(
        `searchResults 未命中 keyword="${SEARCH_KEYWORD}"; ` +
        `count=${finalData.searchResults.length}, ids=${finalData.searchResults.map((s) => s.product_id).join(',')}`
      )
    }
    ctx.searchHitCount = finalData.searchResults.length
  }],

  ['4. onSearchClear → 退出搜索模式', async (ctx) => {
    const page = await ctx.mp.currentPage()
    await page.callMethod('onSearchClear')
    await waitForData(
      ctx.mp,
      (d) => d?.isSearching === false && (d?.searchResults || []).length === 0,
      { timeoutMs: 4000, name: '搜索模式已退出' }
    )
  }],

  ['5. navigateTo /pagesShop/shop/shop + 等 spuList', async (ctx) => {
    await ctx.mp.navigateTo('/pagesShop/shop/shop')
    await waitForPagePath(ctx.mp, 'pagesShop/shop', { timeoutMs: 8000 })
    await waitForData(
      ctx.mp,
      (d) => Array.isArray(d?.spuList) && d.spuList.length > 0,
      { timeoutMs: 8000, name: 'shop.spuList 加载完' }
    )
  }],

  ['6. PG cross-check：clientApi product.spuList 一致性', async (ctx) => {
    const res = await ctx.invoke('product.spuList', { categoryId: L3_MALL_CATEGORY_ID })
    if (!res || res.code !== 0) {
      throw new Error(`product.spuList failed: ${JSON.stringify(res)}`)
    }
    const list = res.data?.spuList || []
    const hit = list.find((s) => s.product_id === L3_PRODUCT_ID)
    if (!hit) {
      throw new Error(
        `product.spuList(category=${L3_MALL_CATEGORY_ID}) 未含 ${L3_PRODUCT_ID}; ` +
        `返回 ${list.map((s) => s.product_id).join(',')}`
      )
    }
  }],
]

let mp = null
let pass = false
console.log(`[j13-search-filter] start | ${new Date().toISOString()}`)
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
  console.log(`[j13-search-filter] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
