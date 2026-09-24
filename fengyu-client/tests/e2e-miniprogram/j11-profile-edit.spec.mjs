#!/usr/bin/env bun
// L3 client journey j11 - profile edit (改昵称 + 上传头像)
//
// 目标：profile-edit 修改昵称 + 上传头像
// 步骤：
//   1. switchTab profile，等渲染（顾客行已在 loginAsTestClient 创建）
//   2. navigateTo /pagesProfile/profile-edit/profile-edit，等加载
//   3. auth.updateProfile {name: 'TEST_E2E_L3_改名'} → PG 验证 name 写入
//   4. auth.uploadAvatar {base64, ext:'jpg'} → 验证 fileID 返回；PG 验证 avatar_url
//      ・base64 用极小有效图（>0 bytes 通过 size 校验，又不污染 COS）
//
// 决策（uploadAvatar 真上传）：
//   走真实云函数 → 真实 COS 上传，会在 avatars/{OPENID}/ 留下 1 张小图（< 100 bytes）。
//   理由：测的就是头像上传链路（前端调用 + 云函数 + PG avatar_url 更新），
//   降级到"只跑 size 校验失败分支"会丢主路径覆盖。COS 残留通过命名空间路径
//   `avatars/{OPENID}/` 可见，手动清理可选；不影响功能。

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
} from './helpers/fixtures.mjs'
import { assertColumnValue } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NEW_NAME = 'TEST_E2E_L3_改名'

// 极小 JPEG 头（SOI + EOI），仅 4 bytes，base64 后约 8 字符。
// uploadAvatar 路由只校验 buffer.length > 0 && < 2MB，不校验 magic bytes，可用。
const TINY_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

const STEPS = [
  ['1. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await waitForPagePath(ctx.mp, 'profile', { timeoutMs: 5000 })
  }],

  ['2. navigateTo profile-edit', async (ctx) => {
    await ctx.mp.navigateTo('/pagesProfile/profile-edit/profile-edit')
    await waitForPagePath(ctx.mp, 'profile-edit', { timeoutMs: 6000 })
  }],

  ['3. auth.updateProfile 改昵称 + PG 断言', async (ctx) => {
    // INJECT 模式下 auth.updateProfile 走 cloud.getWXContext() 真实 OPENID，
    // 影响 IDE 真实用户行；先 probe 拿真实 userId 用于 PG 断言。
    const probe = await ctx.mp.evaluate(async () => {
      const r = await wx.cloud.callFunction({ // 单 env 内并存 clientApi(prod 库) 与 clientApiDev(dev 库)：写死会让断言库与被测页面写入库分裂
 name: (() => { try { const v = wx.getAccountInfoSync().miniProgram.envVersion; return v === 'release' || v === 'trial' ? 'clientApi' : 'clientApiDev' } catch (e) { return 'clientApiDev' } })(), data: { action: 'auth.login' } })
      return r.result?.data?.userId
    })
    ctx.realUserId = probe

    const res = await ctx.invoke('auth.updateProfile', { name: NEW_NAME })
    if (!res || res.code !== 0) {
      throw new Error(`auth.updateProfile failed: ${JSON.stringify(res)}`)
    }
    if (res.data?.name !== NEW_NAME) {
      throw new Error(`updateProfile return name=${res.data?.name}, expected ${NEW_NAME}`)
    }
    await assertColumnValue(
      'client_wechat_users',
      { user_id: ctx.realUserId },
      { name: NEW_NAME }
    )
  }],

  ['4. auth.uploadAvatar 极小 JPEG + PG 验证 avatar_url 非空', async (ctx) => {
    const res = await ctx.invoke('auth.uploadAvatar', {
      base64: TINY_JPEG_BASE64,
      ext: 'jpg',
    })
    if (!res || res.code !== 0) {
      throw new Error(`auth.uploadAvatar failed: ${JSON.stringify(res)}`)
    }
    const fileID = res.data?.fileID
    if (!fileID || typeof fileID !== 'string') {
      throw new Error(`uploadAvatar 返回 fileID 非法: ${JSON.stringify(res.data)}`)
    }
    // 真实云函数 → COS：fileID 通常以 cloud:// 开头；不强校验前缀避免环境差异
    // 同 step3，断言 IDE 真实用户行
    const rows = await query(
      'SELECT avatar_url FROM client_wechat_users WHERE user_id = $1',
      [ctx.realUserId ?? ctx.userId]
    )
    if (!rows[0]?.avatar_url) {
      throw new Error('PG avatar_url 为空（uploadAvatar 未写库？）')
    }
    if (rows[0].avatar_url !== fileID) {
      throw new Error(`PG avatar_url=${rows[0].avatar_url} 与 res.fileID=${fileID} 不一致`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j11-profile-edit] start | ${new Date().toISOString()}`)
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
  console.log(`[j11-profile-edit] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
