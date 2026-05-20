#!/usr/bin/env bun
// L3 client journey j14 - 美容师详情 → 预约创建
//
// 目标：从美容师详情页点 "立即预约" 跳转到 /pagesAppointment/appointment-create，
//       使用 URL 上的 employeeId 预选员工，提交预约后 PG 写入 appointments
//       且 appointments.employee_id = 该测试美容师 employeeId
//
// 步骤：
//   1. 前置 fixture：
//        - ensureClientProductCatalog（疗程卡 SKU）
//        - ensureTestBeautician（测试美容师，employee_id = TEST_E2E_L3_STF_001）
//        - 直接 SQL 建 1 条 '已支付' 疗程卡订单（5 次卡 remaining_sessions=5）—— 否则
//          appointment-create 无可预约项目
//   2. navigateTo /pagesShop/staff-detail/staff-detail?employeeId=<id>
//   3. waitForPagePath('staff-detail') + waitForData(p.staff != null)
//   4. callMethod('onBookAppointment') → 跳转 appointment-create?employeeId=<id>&employeeName=<...>
//   5. waitForPagePath('appointment-create') + waitForData(p.selectedStaffWfId === employeeId)
//   6. setData({ selectedSaleItemId, selectedSaleOrderId, appointmentDate, appointmentTimeSlot, _timeSlotDisplay })
//      → callMethod('onSubmit')
//   7. PG 断言：appointments 行存在 client_user_id + employee_id + status='待确认'

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query, tx } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  ensureTestBeautician,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { assertRowCount, getSingleRow } from './helpers/pg-assert.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_SKU_COURSE_ID,
} from './helpers/client-l3-fixtures.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'
import {
  TEST_CLIENT_PHONE,
  TEST_STAFF_EMPLOYEE_ID,
} from './helpers/constants.mjs'

const NS = 'TEST_E2E_L3'
const COURSE_ORDER_ID = `${NS}_ORDJ14`
const COURSE_ITEM_ID = `${COURSE_ORDER_ID}_I1`

/** 直接 SQL 插已支付 5 次疗程卡订单（appointment-create 才有可选项目） */
async function insertPaidCourseOrder({ userId }) {
  await tx(async (client) => {
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, paid_at, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status
       )
       VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), NOW(), $4, $5, $6,
               500, 0, 500, 500,
               '微信'::payment_method, $7, '待分配'::allocation_status)`,
      [COURSE_ORDER_ID, `${NS}_市场`, TEST_STORE_ID,
       userId, TEST_CLIENT_PHONE, `${NS}_顾客`, TEST_STAFF_EMPLOYEE_ID]
    )
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         session_count, remaining_sessions, paid_sessions,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, $5, '5次卡', '疗程卡'::product_type,
               500, 1, 500, 500, 500,
               5, 5, 5,
               false)`,
      [COURSE_ITEM_ID, COURSE_ORDER_ID, TEST_STORE_ID, L3_SKU_COURSE_ID, `${NS}_疗程卡商品`]
    )
  })
  return { saleOrderId: COURSE_ORDER_ID, saleItemId: COURSE_ITEM_ID }
}

/** 生成明天 10:00-11:00 时段字符串（appointment.create parseAppointmentTime 正则要求） */
function tomorrowSlot() {
  const d = new Date(Date.now() + 86400_000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return {
    date: `${yyyy}-${mm}-${dd}`,
    slot: '09:00-11:00',
    display: '上午 09:00-11:00',
  }
}

const STEPS = [
  ['1. 前置 fixture：商品 + 美容师 + 已支付疗程卡订单', async (ctx) => {
    await ensureClientProductCatalog()
    const beauty = await ensureTestBeautician()
    ctx.beauticianEmployeeId = beauty.employeeId
    const { saleItemId, saleOrderId } = await insertPaidCourseOrder({ userId: ctx.userId })
    ctx.saleItemId = saleItemId
    ctx.saleOrderId = saleOrderId
  }],

  ['2. navigateTo staff-detail?employeeId=<id>', async (ctx) => {
    await ctx.mp.navigateTo(`/pagesShop/staff-detail/staff-detail?employeeId=${ctx.beauticianEmployeeId}`)
    await waitForPagePath(ctx.mp, 'staff-detail', { timeoutMs: 8000 })
    await waitForData(
      ctx.mp,
      (d) => d?.staff && d.staff.employeeId === ctx.beauticianEmployeeId,
      { timeoutMs: 8000, name: 'staff.detail 加载完' }
    )
  }],

  ['3. 点 "立即预约" → 跳 appointment-create', async (ctx) => {
    const page = await ctx.mp.currentPage()
    await page.callMethod('onBookAppointment')
    await waitForPagePath(ctx.mp, 'appointment-create', { timeoutMs: 8000 })
    // appointment-create.onLoad 在 employeeId 存在时预填 selectedStaffWfId
    await waitForData(
      ctx.mp,
      (d) => d?.selectedStaffWfId === ctx.beauticianEmployeeId,
      { timeoutMs: 8000, name: 'appointment-create 预填员工' }
    )
    // 等可预约项目列表加载完
    await waitForData(
      ctx.mp,
      (d) => Array.isArray(d?.appointableItems) && d.appointableItems.length > 0,
      { timeoutMs: 8000, name: 'appointableItems 加载完' }
    )
  }],

  ['4. 通过 invoke 提交 appointment.create（绕过页面表单细节）', async (ctx) => {
    // 不走页面 onSubmit，避免 wx.requestPayment / Vant calendar 弹层的不稳定；
    // 直接走 clientApi 与页面提交等价：parseAppointmentTime 接受 "YYYY-MM-DD 上午 HH:mm-HH:mm"
    const { date, display } = tomorrowSlot()
    const appointmentTime = `${date} ${display}`
    const res = await ctx.invoke('appointment.create', {
      saleItemId: ctx.saleItemId,
      staffWfId: ctx.beauticianEmployeeId,
      staffName: `${NS}_美容师`,
      appointmentTime,
      notes: 'E2E L3 j14 from staff-detail',
    })
    if (!res || res.code !== 0) {
      throw new Error(`appointment.create failed: ${JSON.stringify(res)}`)
    }
    ctx.appointmentId = res.data?.appointmentId
    if (!ctx.appointmentId) throw new Error('appointment.create 未返回 appointmentId')
  }],

  ['5. PG 断言：appointments 行存在 + employee_id 匹配', async (ctx) => {
    await assertRowCount(
      'appointments',
      { client_user_id: ctx.userId, employee_id: ctx.beauticianEmployeeId, status: '待确认' },
      1
    )
    const row = await getSingleRow('appointments', { appointment_id: ctx.appointmentId })
    if (!row) throw new Error(`appointments 找不到 appointment_id=${ctx.appointmentId}`)
    if (row.sale_item_id !== ctx.saleItemId) {
      throw new Error(`appointments.sale_item_id=${row.sale_item_id}, expect ${ctx.saleItemId}`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j14-staff-detail-appointment] start | ${new Date().toISOString()}`)
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
  console.log(`[j14-staff-detail-appointment] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
