#!/usr/bin/env bun
// L3 client journey j4 - 订单管理
//
// 目标：profile → orders 列表 → detail → cancel
// 步骤：
//   1. 前置 fixture：ensureClientProductCatalog + 直接 SQL 插入 2 个待支付订单
//      （order.create 路由对每个 client_user_id 同时只允许 1 个 '待支付' 订单，所以走 SQL 旁路）
//   2. switchTab 到 /pages/profile/profile，等渲染
//   3. navigateTo 到 /pagesOrder/orders/orders，等加载
//   4. callFunction 'order.list' status='待支付' → 验证 2 条
//   5. navigateTo 到 /pagesOrder/order-detail/order-detail?saleOrderId=... → 验证页面打开
//      并 callFunction 'order.detail' 取回订单详情，校验关键字段
//   6. callFunction 'order.cancel' → PG status='已关闭'（cancel 路由实际行为，
//      源码 routes/order.js:1158 UPDATE sale_orders SET status = '已关闭' ...）

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
  ensureClientProductCatalog,
  L3_SKU_NORMAL_ID,
} from './helpers/client-l3-fixtures.mjs'
import { TEST_CLIENT_PHONE } from './helpers/constants.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NS = 'TEST_E2E_L3'

/**
 * 直接 SQL 插入一个属于 ctx.userId 的待支付销售单（绕过 order.create 的"单待支付"限制）
 * opened_by 留空（顾客自助下单语义）。
 */
async function insertPendingOrder({ userId, saleOrderId, quantity = 1, unitPrice = 100, status = '待支付' }) {
  const totalAmount = unitPrice * quantity
  await query(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     )
     VALUES ($1, $2::order_status, '销售单'::sale_order_type, $3, $4,
             NOW(), $5, $6, $7,
             $8, 0, $8, 0,
             '微信'::payment_method, '待分配'::allocation_status)`,
    [saleOrderId, status, `${NS}_市场`, TEST_STORE_ID,
     userId, TEST_CLIENT_PHONE, `${NS}_顾客`, totalAmount]
  )
  const itemId = `${saleOrderId}_I1`
  await query(
    `INSERT INTO sale_items (
       sale_item_id, sale_order_id, store_id, item_direction,
       sku_id, product_name, sku_spec_name, product_type,
       unit_price, quantity, unit_real_price, sale_amount, received,
       is_experience
     )
     VALUES ($1, $2, $3, '购买'::item_direction,
             $4, $5, '默认', '疗程卡'::product_type,
             $6, $7, $6, $8, 0, false)`,
    [itemId, saleOrderId, TEST_STORE_ID, L3_SKU_NORMAL_ID,
     `${NS}_测试商品`, unitPrice, quantity, totalAmount]
  )
  return { saleOrderId, saleItemId: itemId }
}

const STEPS = [
  ['1. 前置 fixture：商品 + 1 个待支付订单 + 1 个已关闭订单（uq_sale_orders_client_pending 同顾客限 1 待支付）', async (ctx) => {
    await ensureClientProductCatalog()
    // sale_order_id varchar(30) 上限
    ctx.orderA = `${NS}_ORDJ4A`   // 待支付（待 cancel 的目标）
    ctx.orderB = `${NS}_ORDJ4B`   // 已关闭（历史）
    await insertPendingOrder({ userId: ctx.userId, saleOrderId: ctx.orderA, quantity: 1, unitPrice: 100, status: '待支付' })
    // 第二单直接 INSERT 已关闭状态，避开 uq_sale_orders_client_pending（同顾客唯一待支付）
    await insertPendingOrder({ userId: ctx.userId, saleOrderId: ctx.orderB, quantity: 2, unitPrice: 100, status: '已关闭' })
    // 仅断言本次测试单存在；不按 client_user_id+status 全量计数，PROBE 模式真实
    // IDE 用户可能有历史订单（已关闭/已支付）会引入噪声。
    await assertRowCount('sale_orders', { sale_order_id: ctx.orderA, status: '待支付' }, 1)
    await assertRowCount('sale_orders', { sale_order_id: ctx.orderB, status: '已关闭' }, 1)
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await waitForPagePath(ctx.mp, 'profile', { timeoutMs: 5000 })
  }],

  ['3. navigateTo orders 列表', async (ctx) => {
    await ctx.mp.navigateTo('/pagesOrder/orders/orders')
    await waitForPagePath(ctx.mp, 'orders/orders', { timeoutMs: 6000 })
  }],

  ['4. order.list 含两单（A 待支付 + B 已关闭）', async (ctx) => {
    const res = await ctx.invoke('order.list', {})  // 不限 status 拿全部
    if (!res || res.code !== 0) {
      throw new Error(`order.list failed: ${JSON.stringify(res)}`)
    }
    const orders = res.data?.orders || []
    const ids = orders.map(o => o.sale_order_id)
    if (!ids.includes(ctx.orderA) || !ids.includes(ctx.orderB)) {
      throw new Error(`order.list 缺失测试单：返回 ${JSON.stringify(ids.slice(0, 10))}`)
    }
  }],

  ['5. navigateTo order-detail + order.detail 校验字段', async (ctx) => {
    await ctx.mp.navigateTo(`/pagesOrder/order-detail/order-detail?saleOrderId=${ctx.orderA}`)
    await waitForPagePath(ctx.mp, 'order-detail', { timeoutMs: 6000 })

    // 不依赖前端 data 结构（小程序页面 data 字段可能随版本变化），
    // 改为直接 callFunction 校验后端返回的详情字段稳定
    const res = await ctx.invoke('order.detail', { saleOrderId: ctx.orderA })
    if (!res || res.code !== 0) {
      throw new Error(`order.detail failed: ${JSON.stringify(res)}`)
    }
    const order = res.data?.order
    if (!order) throw new Error(`order.detail no order in data`)
    if (order.sale_order_id !== ctx.orderA) {
      throw new Error(`detail.sale_order_id=${order.sale_order_id}, expect ${ctx.orderA}`)
    }
    if (order.status !== '待支付') {
      throw new Error(`detail.status=${order.status}, expect 待支付`)
    }
    const items = res.data?.items || []
    if (items.length === 0) {
      throw new Error(`order.detail items 为空`)
    }
  }],

  ['6. order.cancel → PG status=已关闭', async (ctx) => {
    const res = await ctx.invoke('order.cancel', { saleOrderId: ctx.orderA })
    if (!res || res.code !== 0) {
      throw new Error(`order.cancel failed: ${JSON.stringify(res)}`)
    }
    // 路由实际行为：cancel 把 status 置 '已关闭'（不是 '已取消'），见 routes/order.js
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.orderA },
      { status: '已关闭' }
    )
    // 另一单 (orderB) 是 fixture 预置的 已关闭，状态不变
    await assertColumnValue(
      'sale_orders',
      { sale_order_id: ctx.orderB },
      { status: '已关闭' }
    )
  }],
]

let mp = null
let pass = false
console.log(`[j4-order-management] start | ${new Date().toISOString()}`)
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
  console.log(`[j4-order-management] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
