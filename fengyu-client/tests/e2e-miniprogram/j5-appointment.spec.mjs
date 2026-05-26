#!/usr/bin/env bun
// L3 client journey j5 - 预约
//
// 目标：已支付疗程卡订单 → appointment.create → list 刷新
// 步骤：
//   1. 前置 fixture：ensureClientProductCatalog + ensureTestBeautician + 直接 SQL 插入
//      一条 '已支付' 疗程卡订单（5次卡，remaining_sessions=5）
//   2. switchTab 到 /pages/appointment/appointment
//   3. order.appointableItems → 验证返回该 sale_item
//   4. navigateTo /pagesAppointment/appointment-create/appointment-create
//   5. appointment.create with 明天 10:00-11:00 时段 → 验证 PG appointments +1 行 status='待确认'
//   6. appointment.list → 验证返回 1 条 且 ctx.userId 维度 count=1
//
// 路由实际行为发现（routes/appointment.js）：
//   - appointmentTime 入参为字符串：必须匹配 /^(\d{4}-\d{2}-\d{2})\s+.*?(\d{2}:\d{2})-\d{2}:\d{2}$/
//     例如 "2026-05-18 上午 10:00-11:00"
//   - 美容师字段名为 staffWfId（不是 employeeId），且 staffName 由前端传
//   - 同一 sale_item_id 只能有 1 个待确认/已确认预约（业务唯一约束）

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  ensureTestBeautician,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { assertRowCount } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_SKU_COURSE_ID,
} from './helpers/client-l3-fixtures.mjs'
import { TEST_CLIENT_PHONE } from './helpers/constants.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const NS = 'TEST_E2E_L3'

/**
 * 直接 SQL 插入一条 '已支付' 的疗程卡订单（5次卡，剩余 5 次）
 */
async function insertPaidCourseOrder({ userId }) {
  // sale_order_id varchar(30) 上限
  const saleOrderId = `${NS}_ORDJ5`
  const saleItemId = `${saleOrderId}_I1`
  await query(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, paid_at, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     )
     VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
             NOW(), NOW(), $4, $5, $6,
             500, 0, 500, 500,
             '微信'::payment_method, '待分配'::allocation_status)`,
    [saleOrderId, `${NS}_市场`, TEST_STORE_ID,
     userId, TEST_CLIENT_PHONE, `${NS}_顾客`]
  )
  await query(
    `INSERT INTO sale_items (
       sale_item_id, sale_order_id, store_id, item_direction,
       sku_id, product_name, sku_spec_name, product_type,
       unit_price, quantity, unit_real_price, sale_amount, received,
       session_count, remaining_sessions, is_experience
     )
     VALUES ($1, $2, $3, '购买'::item_direction,
             $4, $5, '5次卡', '疗程卡'::product_type,
             500, 1, 500, 500, 500,
             5, 5, false)`,
    [saleItemId, saleOrderId, TEST_STORE_ID, L3_SKU_COURSE_ID, `${NS}_疗程卡商品`]
  )
  return { saleOrderId, saleItemId }
}

/**
 * 生成明天 10:00-11:00 时段字符串（满足路由 parseAppointmentTime 正则）
 */
function tomorrowSlot() {
  const d = new Date(Date.now() + 86400_000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} 上午 10:00-11:00`
}

const STEPS = [
  ['1. 前置 fixture：商品 + 美容师 + 已支付疗程卡订单', async (ctx) => {
    await ensureClientProductCatalog()
    const beauty = await ensureTestBeautician()
    ctx.beauticianEmployeeId = beauty.employeeId
    const { saleOrderId, saleItemId } = await insertPaidCourseOrder({ userId: ctx.userId })
    ctx.saleOrderId = saleOrderId
    ctx.saleItemId = saleItemId
  }],

  ['2. switchTab appointment', async (ctx) => {
    await ctx.mp.switchTab('/pages/appointment/appointment')
    await waitForPagePath(ctx.mp, 'appointment', { timeoutMs: 5000 })
  }],

  ['3. order.appointableItems → 返回该 sale_item', async (ctx) => {
    const res = await ctx.invoke('order.appointableItems')
    if (!res || res.code !== 0) {
      throw new Error(`order.appointableItems failed: ${JSON.stringify(res)}`)
    }
    const orders = res.data?.orders || []
    const flatItems = orders.flatMap(o => o.items || [])
    const found = flatItems.find(it => it.saleItemId === ctx.saleItemId)
    if (!found) {
      throw new Error(`appointableItems 缺失 saleItemId=${ctx.saleItemId}；返回 ${JSON.stringify(flatItems.map(i => i.saleItemId))}`)
    }
    if (found.remainingSessions !== 5) {
      throw new Error(`remainingSessions=${found.remainingSessions}, expect 5`)
    }
  }],

  ['4. navigateTo appointment-create', async (ctx) => {
    await ctx.mp.navigateTo('/pagesAppointment/appointment-create/appointment-create')
    await waitForPagePath(ctx.mp, 'appointment-create', { timeoutMs: 6000 })
  }],

  ['5. appointment.create → PG appointments +1 行 status=待确认', async (ctx) => {
    const res = await ctx.invoke('appointment.create', {
      saleItemId: ctx.saleItemId,
      staffWfId: ctx.beauticianEmployeeId,
      staffName: `${NS}_美容师`,
      appointmentTime: tomorrowSlot(),
      notes: 'E2E L3 j5 appointment',
    })
    if (!res || res.code !== 0) {
      throw new Error(`appointment.create failed: ${JSON.stringify(res)}`)
    }
    const appointmentId = res.data?.appointmentId
    if (!appointmentId) throw new Error(`appointment.create no appointmentId`)
    ctx.appointmentId = appointmentId
    // 状态应为 '待确认'
    if (res.data?.status && res.data.status !== '待确认') {
      throw new Error(`status=${res.data.status}, expect 待确认`)
    }
    await assertRowCount(
      'appointments',
      { client_user_id: ctx.userId, status: '待确认' },
      1
    )
  }],

  ['6. appointment.list → 返回 1 条', async (ctx) => {
    const res = await ctx.invoke('appointment.list')
    if (!res || res.code !== 0) {
      throw new Error(`appointment.list failed: ${JSON.stringify(res)}`)
    }
    const list = res.data?.appointments || []
    const found = list.find(a => a.appointment_id === ctx.appointmentId)
    if (!found) {
      throw new Error(`appointment.list 缺失 appointmentId=${ctx.appointmentId}`)
    }
    if (found.status !== '待确认') {
      throw new Error(`list[0].status=${found.status}, expect 待确认`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j5-appointment] start | ${new Date().toISOString()}`)
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
  console.log(`[j5-appointment] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
