#!/usr/bin/env bun
// L3 client journey j8 - points + messages
//
// 目标：积分页（余额/流水）+ 消息中心（列表/未读数/标记已读）
// 步骤：
//   1. 前置：UPDATE points_balance=200 + member_level='星钻' + 3 条积分流水 + 3 条消息（2 未读 + 1 已读）
//   2. switchTab profile
//   3. navigateTo points → callFunction points.balance / points.history
//   4. navigateTo messages
//   5. message.unreadCount → 验证返回 2
//   6. message.read(messageId) → PG 验证 is_read=true，再 unreadCount → 1

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
} from './helpers/fixtures.mjs'
import { assertColumnValue } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  createClientMessages,
  createClientPointTxn,
} from './helpers/client-l3-fixtures.mjs'

const STEPS = [
  ['1. 前置：积分 + 流水 + 消息', async (ctx) => {
    // 设积分余额 + 会员等级
    await query(
      `UPDATE client_wechat_users
         SET points_balance = 200,
             member_level = '星钻'::member_level
       WHERE user_id = $1`,
      [ctx.userId]
    )
    // 3 条积分流水
    await createClientPointTxn({ userId: ctx.userId, type: '获取', amount: 100 })
    await createClientPointTxn({ userId: ctx.userId, type: '获取', amount: 50 })
    await createClientPointTxn({ userId: ctx.userId, type: '消费', amount: -30 })
    // 消息：2 未读 + 1 已读
    const ids = await createClientMessagesForUser(ctx.userId, [
      { title: 'L3-未读-1', isRead: false },
      { title: 'L3-未读-2', isRead: false },
      { title: 'L3-已读-3', isRead: true },
    ])
    ctx.messageIds = ids
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await new Promise((r) => setTimeout(r, 1500))
  }],

  ['3. navigateTo points → balance + history', async (ctx) => {
    await ctx.mp.navigateTo('/pagesProfile/points/points')
    await new Promise((r) => setTimeout(r, 1500))

    const balRes = await ctx.invoke('points.balance')
    if (!balRes || balRes.code !== 0) {
      throw new Error(`points.balance failed: ${JSON.stringify(balRes)}`)
    }
    if (Number(balRes.data?.balance) !== 200) {
      throw new Error(`points.balance balance=${balRes.data?.balance}, expected 200`)
    }
    if (balRes.data?.levelName !== '星钻') {
      throw new Error(`points.balance levelName=${balRes.data?.levelName}, expected 星钻`)
    }

    const histRes = await ctx.invoke('points.history')
    if (!histRes || histRes.code !== 0) {
      throw new Error(`points.history failed: ${JSON.stringify(histRes)}`)
    }
    const records = histRes.data?.records || []
    if (records.length !== 3) {
      throw new Error(`points.history records.length=${records.length}, expected 3`)
    }
  }],

  ['4. navigateTo messages', async (ctx) => {
    // 切回 profile（avoid navigateTo 5 level limit）
    await ctx.mp.navigateBack().catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    await ctx.mp.navigateTo('/pagesProfile/messages/messages')
    await new Promise((r) => setTimeout(r, 1500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('messages')) {
      throw new Error(`current path=${page?.path} 非 messages`)
    }
  }],

  ['5. message.unreadCount → 2', async (ctx) => {
    const res = await ctx.invoke('message.unreadCount')
    if (!res || res.code !== 0) {
      throw new Error(`message.unreadCount failed: ${JSON.stringify(res)}`)
    }
    if (res.data?.count !== 2) {
      throw new Error(`unreadCount=${res.data?.count}, expected 2`)
    }
  }],

  ['6. message.read 第一条未读 → PG 验证 + unreadCount→1', async (ctx) => {
    const firstUnreadId = ctx.messageIds[0]
    const readRes = await ctx.invoke('message.read', { messageId: firstUnreadId })
    if (!readRes || readRes.code !== 0) {
      throw new Error(`message.read failed: ${JSON.stringify(readRes)}`)
    }
    // PG 断言：is_read 改为 true
    await assertColumnValue('messages', { id: firstUnreadId }, { is_read: true })

    const after = await ctx.invoke('message.unreadCount')
    if (after.data?.count !== 1) {
      throw new Error(`after-read unreadCount=${after.data?.count}, expected 1`)
    }
  }],
]

/**
 * createClientMessages 的 helper 默认用 TEST_CLIENT_USER_ID，
 * probe 模式下 ctx.userId 是真实 IDE 用户，需要按 ctx.userId 写入。
 */
async function createClientMessagesForUser(userId, items) {
  const ids = []
  for (const it of items) {
    const res = await query(
      `INSERT INTO messages (
         recipient_type, recipient_id, title, body, message_type, is_read
       )
       VALUES ('客户'::message_recipient_type, $1, $2, '测试消息内容', 'system', $3)
       RETURNING id`,
      [userId, it.title, it.isRead]
    )
    ids.push(res[0].id)
  }
  return ids
}

let mp = null
let pass = false
let savedUserId = null
console.log(`[j8-points-messages] start | ${new Date().toISOString()}`)
try {
  await cleanupL3TestData()
  await ensureBaseFixtures()

  mp = await launchClient()
  const auth = await loginAsTestClient(mp)
  savedUserId = auth.userId
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
  // probe 模式下我们改了真实用户 points_balance / member_level，复位到静息态
  if (savedUserId) {
    try {
      await query(
        `UPDATE client_wechat_users
           SET points_balance = 0, member_level = NULL
         WHERE user_id = $1`,
        [savedUserId]
      )
      // 清这个用户名下的本次测试积分流水（amount in (100,50,-30)）
      await query(
        `DELETE FROM point_transactions
         WHERE user_id = $1 AND amount IN (100, 50, -30)`,
        [savedUserId]
      )
      // 清这个用户名下本次测试消息
      await query(
        `DELETE FROM messages
         WHERE recipient_id = $1 AND title LIKE 'L3-%'`,
        [savedUserId]
      )
    } catch (e) {
      console.warn(`[j8] cleanup probe user warn: ${e.message}`)
    }
  }
  await cleanupL3TestData()
  await closePool()
  console.log(`[j8-points-messages] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
