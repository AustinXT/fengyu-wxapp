#!/usr/bin/env bun
// L3 client 预检（独立可跑）
//
// 1. IDE 端口 + 自动化连接
// 2. PG 连接
// 3. 当前 IDE 装载的项目 appId 是否匹配 client（wx811eb4ded3dfba3f）
// 4. 基础 fixture（org/store）就绪

import { ensureIdeReady, launchClient, disconnect } from './helpers/automator.mjs'
import { query, closePool } from './helpers/pg.mjs'
import { ensureBaseFixtures } from './helpers/fixtures.mjs'

const CLIENT_APPID = 'wx811eb4ded3dfba3f'

let mp = null
try {
  console.log('[L3 client setup] === 预检开始 ===')

  console.log('[L3 client setup] 1) 检测 IDE 自动化端口...')
  const port = await ensureIdeReady()
  console.log(`  OK — port = ${port}`)

  console.log(`[L3 client setup] 2) 连接 IDE + 验证 appId 是 client (${CLIENT_APPID})...`)
  mp = await launchClient()
  const probe = await mp.evaluate(() => {
    const env = wx.getAccountInfoSync?.()?.miniProgram ?? {}
    return { appid: env.appId ?? null, envVersion: env.envVersion ?? null }
  })
  console.log(`  IDE 装载 appId = ${probe.appid}`)
  if (probe.appid && probe.appid !== CLIENT_APPID) {
    throw new Error(
      `[L3 client setup] IDE 当前装载的小程序 appId 是 ${probe.appid}，` +
      `不是 client (${CLIENT_APPID})。请在 IDE 切换到 fengyu-client/miniprogram 项目后重试。`
    )
  }

  console.log('[L3 client setup] 3) 检测 PG 连接...')
  const rows = await query('SELECT 1 AS ok')
  if (rows[0]?.ok !== 1) throw new Error('PG 健康检查失败')
  console.log('  OK')

  console.log('[L3 client setup] 4) 准备基础 fixture (org/store)...')
  await ensureBaseFixtures()
  console.log('  OK')

  console.log('[L3 client setup] === 预检通过 ===')
} catch (e) {
  console.error('[L3 client setup] FAILED:', e.message)
  process.exitCode = 1
} finally {
  if (mp) await disconnect(mp)
  await closePool()
}
