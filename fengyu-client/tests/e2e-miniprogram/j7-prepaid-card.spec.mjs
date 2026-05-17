#!/usr/bin/env bun
// L3 client journey j7 - prepaid-card
//
// 目标：profile → prepaid-cards 列表 → 流水查询 → recharge 创建充值订单
// 步骤：
//   1. 前置 fixture：ensureClientPrepaidCard(balance=500) + 2 条 card_transactions（充值/扣款）
//   2. switchTab 到 /pages/profile/profile，等渲染
//   3. navigateTo 到 /pagesProfile/prepaid-cards/prepaid-cards，等加载
//   4. callFunction 'card.list' → 验证 1 张卡，balance=500
//   5. callFunction 'card.history' {cardId} → 验证 2 条流水（倒序）
//   6. navigateTo 到 /pagesProfile/card-recharge/card-recharge，callFunction 'card.recharge' {faceValue:1000}
//      → 验证返回 saleOrderId/payAmount，PG 验证 sale_items.is_recharge_card=true 新增 1 行

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
  ensureClientPrepaidCard,
  L3_PREPAID_CARD_ID,
} from './helpers/client-l3-fixtures.mjs'

const STEPS = [
  ['1. 前置 fixture：充值卡 + 2 条流水', async (ctx) => {
    await ensureClientPrepaidCard({ userId: ctx.userId, balance: '500.00' })
    // 充值流水（type='充值'）
    await query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
       VALUES ($1, '充值', $2, NULL)`,
      [L3_PREPAID_CARD_ID, '200.00']
    )
    // 扣款流水（type='扣款'，amount 负数表示扣减）
    await query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
       VALUES ($1, '扣款', $2, NULL)`,
      [L3_PREPAID_CARD_ID, '-50.00']
    )
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await new Promise((r) => setTimeout(r, 1500))
  }],

  ['3. navigateTo prepaid-cards', async (ctx) => {
    await ctx.mp.navigateTo('/pagesProfile/prepaid-cards/prepaid-cards')
    await new Promise((r) => setTimeout(r, 1500))
    const page = await ctx.mp.currentPage()
    if (!page?.path?.includes('prepaid-cards')) {
      throw new Error(`current path=${page?.path} 非 prepaid-cards`)
    }
  }],

  ['4. card.list → 验证 1 张卡 balance=500', async (ctx) => {
    const res = await ctx.invoke('card.list')
    if (!res || res.code !== 0) {
      throw new Error(`card.list failed: ${JSON.stringify(res)}`)
    }
    const cards = res.data?.cards || []
    if (cards.length !== 1) {
      throw new Error(`card.list cards.length=${cards.length}, expected 1`)
    }
    if (Number(cards[0].balance) !== 500) {
      throw new Error(`card.list balance=${cards[0].balance}, expected 500`)
    }
    if (cards[0].cardId !== L3_PREPAID_CARD_ID) {
      throw new Error(`cardId=${cards[0].cardId}, expected ${L3_PREPAID_CARD_ID}`)
    }
  }],

  ['5. card.history → 验证 2 条流水（倒序）', async (ctx) => {
    const res = await ctx.invoke('card.history', { cardId: L3_PREPAID_CARD_ID })
    if (!res || res.code !== 0) {
      throw new Error(`card.history failed: ${JSON.stringify(res)}`)
    }
    const records = res.data?.records || []
    if (records.length !== 2) {
      throw new Error(`card.history records.length=${records.length}, expected 2`)
    }
    // 倒序：最近 INSERT 的 '扣款' 在前
    if (records[0].type !== '扣款') {
      throw new Error(`records[0].type=${records[0].type}, expected 扣款`)
    }
    if (records[1].type !== '充值') {
      throw new Error(`records[1].type=${records[1].type}, expected 充值`)
    }
  }],

  ['6. navigateTo card-recharge → card.recharge', async (ctx) => {
    await ctx.mp.navigateTo('/pagesProfile/card-recharge/card-recharge')
    await new Promise((r) => setTimeout(r, 1500))

    const res = await ctx.invoke('card.recharge', { faceValue: 1000 })
    if (!res || res.code !== 0) {
      throw new Error(`card.recharge failed: ${JSON.stringify(res)}`)
    }
    const { saleOrderId, faceValue, payAmount } = res.data || {}
    if (!saleOrderId) throw new Error('card.recharge: no saleOrderId')
    if (faceValue !== 1000) throw new Error(`faceValue=${faceValue}, expected 1000`)
    // 1000 档位 9.8 折 → 980
    if (Number(payAmount) !== 980) {
      throw new Error(`payAmount=${payAmount}, expected 980`)
    }

    // PG 断言：sale_orders 新增 1 行（status='待支付'）
    await assertRowCount('sale_orders', { sale_order_id: saleOrderId }, 1)
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: saleOrderId },
      { status: '待支付', client_user_id: ctx.userId, store_id: TEST_STORE_ID }
    )
    // PG 断言：sale_items 新增 1 行 is_recharge_card=true
    const items = await query(
      `SELECT sale_item_id, is_recharge_card FROM sale_items WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    if (items.length !== 1) {
      throw new Error(`sale_items count=${items.length}, expected 1`)
    }
    if (items[0].is_recharge_card !== true) {
      throw new Error(`is_recharge_card=${items[0].is_recharge_card}, expected true`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j7-prepaid-card] start | ${new Date().toISOString()}`)
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
  console.log(`[j7-prepaid-card] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
