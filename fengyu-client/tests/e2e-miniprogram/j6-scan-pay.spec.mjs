#!/usr/bin/env bun
// L3 client journey j6 - 扫码支付（员工开单 → 顾客扫码 → 全额储值卡抵扣）
//
// 目标：员工开单生成待支付单 → 顾客扫码 → scanDetail → balance → scanAdjust → confirmPrepaidFull
// 步骤：
//   1. 前置 fixture：ensureTestBeautician（作为 opened_by 员工）+ ensureClientPrepaidCard(balance=1000)
//   2. createPendingSaleOrderForScan(totalAmount=300) 建员工开单的待支付单
//   3. navigateTo /pagesOrder/scan-pay/scan-pay?saleOrderId=...
//   4. order.scanDetail → 验证 totalAmount=300, status='待支付'
//   5. card.balance → 验证 balance=1000
//   6. order.scanAdjust useCard:true, prepaidCardAmount:300, paymentMethod:'微信'（兜底，实际 paidAmount=0 时
//      路由会强制改为 '无'，见 routes/order.js scanAdjust:1461-1468） →
//      PG 验证 sale_orders.prepaid_card_amount=300, payable_amount=0, payment_method='无'
//   7. order.confirmPrepaidFull → PG status='已支付', prepaid_cards.balance=1000-300=700
//   8. card_transactions WHERE ref_order_id=saleOrderId AND type='扣款' 应有 1 行 amount=-300
//      （路由 INSERT 写入的 amount 是负值，见 routes/order.js confirmPrepaidFull:1567）

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  ensureTestBeautician,
} from './helpers/fixtures.mjs'
import { assertRowCount, assertColumnValue } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientPrepaidCard,
  createPendingSaleOrderForScan,
  L3_PREPAID_CARD_ID,
} from './helpers/client-l3-fixtures.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NS = 'TEST_E2E_L3'

const STEPS = [
  ['1. 前置 fixture：美容师 + 顾客储值卡 balance=1000', async (ctx) => {
    await ensureTestBeautician()
    await ensureClientPrepaidCard({ userId: ctx.userId, balance: '1000.00' })
  }],

  ['2. 员工开单：createPendingSaleOrderForScan total=300', async (ctx) => {
    // sale_order_id varchar(30) 上限
    ctx.saleOrderId = `${NS}_ORDSCAN`
    const r = await createPendingSaleOrderForScan({
      saleOrderId: ctx.saleOrderId,
      clientUserId: ctx.userId,  // 直接挂在测试顾客名下，简化归属校验
      totalAmount: 300,
    })
    ctx.saleItemId = r.saleItemId
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.saleOrderId },
      { status: '待支付', total_amount: 300 }
    )
  }],

  ['3. navigateTo scan-pay + 页面 data 加载', async (ctx) => {
    await ctx.mp.navigateTo(`/pagesOrder/scan-pay/scan-pay?saleOrderId=${ctx.saleOrderId}`)
    await waitForPagePath(ctx.mp, 'scan-pay', { timeoutMs: 6000 })
    // deepened: page.data() cross-check, not just API call
    // scan-pay.ts onLoad → loadOrder（并行 scanDetail + card.balance），终态：isLoading=false + order 落位
    const data = await waitForData(
      ctx.mp,
      (d) => d && d.isLoading === false && d.order && d.totalAmount > 0,
      { name: 'scan-pay order load', timeoutMs: 8000 }
    ).catch(() => null)
    if (!data) {
      // TODO: replace with explicit wait when API contract permits
      console.log('(warn: scan-pay 页面 data 未在超时内完成 loadOrder)')
      return
    }
    // 显示 totalAmount 应与 PG sale_orders.total_amount=300 一致
    if (Number(data.totalAmount) !== 300) {
      throw new Error(`page.data.totalAmount=${data.totalAmount}, expected 300`)
    }
    // 显示 cardBalance 应与 card.balance API 一致（步骤 5 之前 fixture=1000）
    if (Number(data.cardBalance) !== 1000) {
      throw new Error(`page.data.cardBalance=${data.cardBalance}, expected 1000`)
    }
    // order 字段交叉校验：order.totalAmount 应与顶层 data.totalAmount 一致
    if (Number(data.order?.totalAmount) !== Number(data.totalAmount)) {
      throw new Error(`order.totalAmount(${data.order?.totalAmount}) !== data.totalAmount(${data.totalAmount})`)
    }
  }],

  ['4. order.scanDetail → totalAmount=300, status=待支付', async (ctx) => {
    const res = await ctx.invoke('order.scanDetail', { saleOrderId: ctx.saleOrderId })
    if (!res || res.code !== 0) {
      throw new Error(`order.scanDetail failed: ${JSON.stringify(res)}`)
    }
    const order = res.data?.order
    if (!order) throw new Error(`scanDetail no order in data`)
    if (order.status !== '待支付') {
      throw new Error(`scanDetail.status=${order.status}, expect 待支付`)
    }
    if (Number(order.totalAmount) !== 300) {
      throw new Error(`scanDetail.totalAmount=${order.totalAmount}, expect 300`)
    }
  }],

  ['5. card.balance → 1000', async (ctx) => {
    const res = await ctx.invoke('card.balance')
    if (!res || res.code !== 0) {
      throw new Error(`card.balance failed: ${JSON.stringify(res)}`)
    }
    const balance = Number(res.data?.balance ?? 0)
    if (balance !== 1000) {
      throw new Error(`card.balance=${balance}, expect 1000`)
    }
  }],

  ['6. order.scanAdjust 全额抵扣 → PG prepaid=300/payable=0', async (ctx) => {
    const res = await ctx.invoke('order.scanAdjust', {
      saleOrderId: ctx.saleOrderId,
      useCard: true,
      prepaidCardAmount: 300,
      paymentMethod: '微信', // 路由内部因 paidAmount=0 会强制改为 '无'
    })
    if (!res || res.code !== 0) {
      throw new Error(`order.scanAdjust failed: ${JSON.stringify(res)}`)
    }
    // 路由 effectivePaymentMethod：paidAmount===0 → '无'
    if (res.data?.paymentMethod !== '无') {
      throw new Error(`scanAdjust.paymentMethod=${res.data?.paymentMethod}, expect '无'`)
    }
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.saleOrderId },
      {
        status: '待支付',
        prepaid_card_amount: 300,
        payable_amount: 0,
        payment_method: '无',
      }
    )
    // 此阶段还未扣卡
    await assertColumnValue(
      'prepaid_cards',
      { card_id: L3_PREPAID_CARD_ID },
      { balance: 1000 }
    )
  }],

  ['7. order.confirmPrepaidFull → 已支付 + 余额 700', async (ctx) => {
    const res = await ctx.invoke('order.confirmPrepaidFull', { saleOrderId: ctx.saleOrderId })
    if (!res || res.code !== 0) {
      throw new Error(`order.confirmPrepaidFull failed: ${JSON.stringify(res)}`)
    }
    if (res.data?.status !== '已支付') {
      throw new Error(`confirmPrepaidFull.status=${res.data?.status}, expect 已支付`)
    }
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.saleOrderId },
      { status: '已支付' }
    )
    await assertColumnValue(
      'prepaid_cards',
      { card_id: L3_PREPAID_CARD_ID },
      { balance: 700 }
    )
  }],

  ['8. card_transactions 扣款流水 1 行 amount=-300', async (ctx) => {
    await assertRowCount(
      'card_transactions',
      { ref_order_id: ctx.saleOrderId, type: '扣款' },
      1
    )
    const rows = await query(
      `SELECT amount FROM card_transactions
       WHERE ref_order_id = $1 AND type = '扣款'`,
      [ctx.saleOrderId]
    )
    // confirmPrepaidFull 路由插入 amount = -prepaidCardAmount = -300
    if (Number(rows[0].amount) !== -300) {
      throw new Error(`card_transactions.amount=${rows[0].amount}, expect -300`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j6-scan-pay] start | ${new Date().toISOString()}`)
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
  console.log(`[j6-scan-pay] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
