#!/usr/bin/env bun
// L3 client journey j1 - onboarding
//
// 目标：app launch → 自动 login（probe 真实 OPENID 模式）→ 验证首页 tab 加载
// 步骤：
//   1. launch client miniprogram → 验证 IDE 装载的是 client appid
//   2. probe 登录（loginAsTestClient 内部已 callFunction auth.login，并 UPSERT 测试态行）
//   3. reLaunch 到 /pages/home/home，evaluate getApp().globalData，断言 userId 非空
//   4. PG 断言：client_wechat_users WHERE openid=ctx.openid 行存在且 bound_store_id=TEST_STORE_ID
//   5. switchTab 到 /pages/appointment/appointment，断言 page.path 切换成功

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { assertRowCount, assertColumnValue } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const CLIENT_APPID = 'wx811eb4ded3dfba3f'

const STEPS = [
  ['1. 验证 IDE 装载 client appid', async (ctx) => {
    const probe = await ctx.mp.evaluate(() => {
      const env = wx.getAccountInfoSync?.()?.miniProgram ?? {}
      return { appid: env.appId ?? null }
    })
    if (probe.appid && probe.appid !== CLIENT_APPID) {
      throw new Error(`IDE appid=${probe.appid} 非 client (${CLIENT_APPID})`)
    }
  }],

  ['2. reLaunch 到 home，验证当前路由', async (ctx) => {
    await ctx.mp.reLaunch('/pages/home/home')
    // 注：currentPage().path 不带前导 '/'，必须用 'pages/home/home' 形式（与其他 step 一致）
    await waitForPagePath(ctx.mp, 'pages/home/home', { timeoutMs: 8000 })
    // 等 onLaunch 完成：globalData.userId 写入是 onLaunch syncLoginState 的尾部副作用
    const start = Date.now()
    while (Date.now() - start < 5000) {
      const gd = await ctx.mp.evaluate(() => {
        const app = getApp()
        return (app && app.globalData && app.globalData.userId) || null
      })
      if (gd) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }],

  ['3. evaluate globalData 验证 onLaunch 完成', async (ctx) => {
    const gd = await ctx.mp.evaluate(() => {
      const app = getApp()
      const d = (app && app.globalData) || {}
      return {
        userId: d.userId || null,
        boundStoreId: d.boundStoreId || null,
        boundStoreName: d.boundStoreName || null,
      }
    })
    if (!gd.userId) {
      throw new Error(`globalData.userId 为空（onLaunch 未完成？）`)
    }
    // 注意：INJECT 模式下 globalData 反映 IDE 真实登录身份（app.js onLaunch
    // 用 IDE 真实 OPENID 调 auth.login），ctx.userId 是 _testOpenid 覆盖后的测试身份。
    // 二者解耦，spec 仅验证 globalData 有 userId（onLaunch 正常完成）。
    // PROBE 模式（INJECT_MODE=false）下二者一致，但 INJECT 模式必不一致——不强行断言。
  }],

  ['4. PG 断言：client_wechat_users 已绑店', async (ctx) => {
    await assertRowCount('client_wechat_users', { openid: ctx.openid }, 1)
    await assertColumnValue(
      'client_wechat_users',
      { openid: ctx.openid },
      { bound_store_id: TEST_STORE_ID }
    )
  }],

  ['5. switchTab 到 appointment', async (ctx) => {
    await ctx.mp.switchTab('/pages/appointment/appointment')
    await waitForPagePath(ctx.mp, 'appointment', { timeoutMs: 5000 })
  }],
]

let mp = null
let pass = false
console.log(`[j1-onboarding] start | ${new Date().toISOString()}`)
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
  console.log(`[j1-onboarding] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
