#!/usr/bin/env bun
// L3 client journey j15 - 门店选择列表 → 门店详情
//
// 目标：
//   A. /pagesStore/store-select/store-select 渲染门店列表（含测试门店 + 第二门店）
//   B. 点击某门店 → 跳 /pagesStore/store-detail/store-detail
//   C. 详情页展示 address / business_hours / phone 等字段，与 clientApi.store.detail 返回一致
//
// 步骤：
//   1. 前置 fixture：基础 ensureBaseFixtures + 给测试门店补完 address / business_hours / phone
//      （schema：stores.street_address / business_hours / phone 列存在；详见 db/schema/org.ts）
//      再额外建一个第二门店挂在同一 market_org，方便确认列表有多行
//   2. navigateTo /pagesStore/store-select/store-select
//   3. waitForPagePath + waitForData(p.allStores 含测试门店 store_id)
//   4. navigateTo /pagesStore/store-detail/store-detail?storeId=<TEST_STORE_ID>&storeName=...
//   5. waitForPagePath('store-detail') + waitForData(p.store.store_id === TEST_STORE_ID)
//   6. 前端渲染字段断言：store.street_address / business_hours / phone 均非空
//   7. clientApi.store.detail 一致性：返回字段与前端 data.store 同步

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
  TEST_MARKET_ORG_ID,
} from './helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NS = 'TEST_E2E_L3'
const STORE_B_ORG_ID = `${NS}_STORE_ORG_B`
const STORE_B_ID = `${NS}_STORE_B`

const TEST_STORE_ADDRESS = '广州市天河区测试路 88 号'
const TEST_STORE_HOURS = '10:00-22:00'
const TEST_STORE_PHONE = '020-88880000'

const STEPS = [
  ['1. 前置 fixture：补完测试门店字段 + 建第二门店', async (ctx) => {
    // 给主测试门店补完 address / business_hours / phone
    // schema 列名见 db/schema/org.ts: street_address / business_hours / phone / latitude / longitude
    await query(
      `UPDATE stores
         SET street_address = $1,
             business_hours = $2,
             phone = $3,
             latitude = '23.1351'::numeric,
             longitude = '113.3300'::numeric,
             district = '天河区'
       WHERE store_id = $4`,
      [TEST_STORE_ADDRESS, TEST_STORE_HOURS, TEST_STORE_PHONE, TEST_STORE_ID]
    )
    // 建第二门店挂同一 market_org_id
    await query(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, '门店', $3, 1, true)
       ON CONFLICT (id) DO NOTHING`,
      [STORE_B_ORG_ID, `${NS}_测试店B`, TEST_MARKET_ORG_ID]
    )
    await query(
      `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed,
                           street_address, business_hours, phone, district)
       VALUES ($1, $2, $3, CURRENT_DATE, false, $4, $5, $6, $7)
       ON CONFLICT (store_id) DO UPDATE
         SET street_address = EXCLUDED.street_address,
             business_hours = EXCLUDED.business_hours,
             phone = EXCLUDED.phone`,
      [STORE_B_ID, `${NS}_测试店B`, STORE_B_ORG_ID,
       '广州市番禺区测试 B 路', '09:00-21:00', '020-88881111', '番禺区']
    )
  }],

  ['2. navigateTo store-select + 等列表加载', async (ctx) => {
    await ctx.mp.navigateTo('/pagesStore/store-select/store-select')
    await waitForPagePath(ctx.mp, 'store-select', { timeoutMs: 8000 })
    // 等 allStores 加载完 — 定位失败时仍会预加载（loadStores 永远跑），所以等任意非空
    await waitForData(
      ctx.mp,
      (d) => Array.isArray(d?.allStores) && d.allStores.length > 0,
      { timeoutMs: 8000, name: 'store-select.allStores 加载完' }
    )
    const data = await (await ctx.mp.currentPage()).data()
    const testStoreInList = (data.allStores || []).find((s) => s.store_id === TEST_STORE_ID)
    if (!testStoreInList) {
      throw new Error(
        `store-select.allStores 缺测试门店 ${TEST_STORE_ID}; ` +
        `got=${(data.allStores || []).map((s) => s.store_id).slice(0, 8).join(',')}`
      )
    }
  }],

  ['3. navigateTo store-detail?storeId=<TEST_STORE_ID>', async (ctx) => {
    const url = `/pagesStore/store-detail/store-detail?storeId=${encodeURIComponent(TEST_STORE_ID)}&storeName=${encodeURIComponent(NS + '_测试店')}`
    await ctx.mp.navigateTo(url)
    await waitForPagePath(ctx.mp, 'store-detail', { timeoutMs: 8000 })
    await waitForData(
      ctx.mp,
      (d) => d?.store && d.store.store_id === TEST_STORE_ID,
      { timeoutMs: 8000, name: 'store-detail.store 加载完' }
    )
  }],

  ['4. 前端渲染字段断言：address / hours / phone', async (ctx) => {
    const data = await (await ctx.mp.currentPage()).data()
    const s = data.store
    if (!s) throw new Error('store-detail.data.store 为空')
    if (s.street_address !== TEST_STORE_ADDRESS) {
      throw new Error(`store.street_address="${s.street_address}", expect "${TEST_STORE_ADDRESS}"`)
    }
    if (s.business_hours !== TEST_STORE_HOURS) {
      throw new Error(`store.business_hours="${s.business_hours}", expect "${TEST_STORE_HOURS}"`)
    }
    if (s.phone !== TEST_STORE_PHONE) {
      throw new Error(`store.phone="${s.phone}", expect "${TEST_STORE_PHONE}"`)
    }
  }],

  ['5. clientApi.store.detail 一致性', async (ctx) => {
    const res = await ctx.invoke('store.detail', { storeId: TEST_STORE_ID })
    if (!res || res.code !== 0) {
      throw new Error(`store.detail failed: ${JSON.stringify(res)}`)
    }
    const s = res.data?.store
    if (!s) throw new Error('store.detail 未返回 store')
    if (s.store_id !== TEST_STORE_ID) {
      throw new Error(`store.detail.store_id=${s.store_id}, expect ${TEST_STORE_ID}`)
    }
    if (s.street_address !== TEST_STORE_ADDRESS) {
      throw new Error(`api store.street_address mismatch (got "${s.street_address}")`)
    }
    if (s.business_hours !== TEST_STORE_HOURS) {
      throw new Error(`api store.business_hours mismatch (got "${s.business_hours}")`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j15-store-detail] start | ${new Date().toISOString()}`)
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
  console.log(`[j15-store-detail] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
