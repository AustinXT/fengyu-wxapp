#!/usr/bin/env bun
// L3 client journey j10 - store switch
//
// 目标：profile → store-select → 切换门店
// 步骤：
//   1. 前置 fixture：在 ensureBaseFixtures 基础上再补一个测试门店 _STORE_B
//      （挂在同一 _MARKET_ORG 下，cleanup 按 NS 前缀 LIKE 一并清掉）
//   2. switchTab 到 /pages/profile/profile，等渲染
//   3. navigateTo 到 /pagesStore/store-select/store-select，等加载
//   4. callFunction 'store.list' → 验证至少 2 个测试门店（含 _STORE 和 _STORE_B）
//   5. callFunction 'auth.bindStore' {storeId: _STORE_B} → 验证 res.code===0
//   6. PG 断言：client_wechat_users.bound_store_id = _STORE_B

import { launchClient, disconnect } from '../../../tests/e2e-miniprogram/helpers/automator.mjs'
import { closePool, query } from '../../../tests/e2e-miniprogram/helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
  TEST_MARKET_ORG_ID,
} from '../../../tests/e2e-miniprogram/helpers/fixtures.mjs'
import { assertColumnValue } from '../../../tests/e2e-miniprogram/helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'

const STORE_B_ORG_ID = 'TEST_E2E_L3_STORE_ORG_B'
const STORE_B_ID = 'TEST_E2E_L3_STORE_B'

const STEPS = [
  ['1. 前置 fixture：建第二个测试门店 _STORE_B', async (ctx) => {
    await query(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, '门店', $3, 1, true)
       ON CONFLICT (id) DO NOTHING`,
      [STORE_B_ORG_ID, 'TEST_E2E_L3_测试店B', TEST_MARKET_ORG_ID]
    )
    await query(
      `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
       VALUES ($1, $2, $3, CURRENT_DATE, false)
       ON CONFLICT (store_id) DO NOTHING`,
      [STORE_B_ID, 'TEST_E2E_L3_测试店B', STORE_B_ORG_ID]
    )
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await new Promise((r) => setTimeout(r, 1500))
  }],

  ['3. navigateTo store-select', async (ctx) => {
    await ctx.mp.navigateTo('/pagesStore/store-select/store-select')
    await new Promise((r) => setTimeout(r, 1500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('store-select')) {
      throw new Error(`current path=${page?.path} 非 store-select`)
    }
  }],

  ['4. store.list 返回 ≥2 个测试门店', async (ctx) => {
    const res = await ctx.invoke('store.list')
    if (!res || res.code !== 0) {
      throw new Error(`store.list failed: ${JSON.stringify(res)}`)
    }
    const stores = res.data?.stores || []
    const testStores = stores.filter((s) => s.store_id === TEST_STORE_ID || s.store_id === STORE_B_ID)
    if (testStores.length < 2) {
      const ids = stores.map((s) => s.store_id).filter((id) => String(id).startsWith('TEST_E2E_L3_'))
      throw new Error(`store.list 测试门店数=${testStores.length}, expected ≥2 (got NS ids=${JSON.stringify(ids)})`)
    }
  }],

  ['5. auth.bindStore 切到 _STORE_B', async (ctx) => {
    const res = await ctx.invoke('auth.bindStore', { storeId: STORE_B_ID })
    if (!res || res.code !== 0) {
      throw new Error(`auth.bindStore failed: ${JSON.stringify(res)}`)
    }
    if (res.data?.boundStoreId !== STORE_B_ID) {
      throw new Error(`bindStore return boundStoreId=${res.data?.boundStoreId}, expected ${STORE_B_ID}`)
    }
    // 记录路由实际操作的 user_id（INJECT 模式下 auth.bindStore 走 cloud.getWXContext()
    // 实际 OPENID，影响的是 IDE 真实用户行，不是 _testOpenid 的测试行）
    ctx.realUserId = res.data.userId
  }],

  ['6. PG 断言：bound_store_id = _STORE_B', async (ctx) => {
    // 用 res.data.userId（路由实际操作的 user_id）做断言
    await assertColumnValue(
      'client_wechat_users',
      { user_id: ctx.realUserId },
      { bound_store_id: STORE_B_ID }
    )
  }],
]

let mp = null
let pass = false
console.log(`[j10-store-switch] start | ${new Date().toISOString()}`)
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
  console.log(`[j10-store-switch] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
