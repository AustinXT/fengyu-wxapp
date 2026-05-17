#!/usr/bin/env bun
/**
 * clientApi.appointment.create
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/appointment.js (line 13)
 *
 * 时间格式：parseAppointmentTime 正则 ^(YYYY-MM-DD)\s+.*?(HH:MM)-HH:MM$
 *   例 "2026-05-18 上午 10:00-11:00"
 *
 * 关键错误前缀：
 *   - INVALID_PARAMS: 缺少预约时间 / 预约时间格式不正确 / 预约时间不能为过去
 *   - INVALID_PARAMS: 订单明细不存在 / 剩余次数不足 / 该订单明细已有待确认或已确认的预约
 *   - INVALID_PARAMS: 请先绑定门店后再预约
 *   - PERMISSION_DENIED: 无权操作该订单
 *   - PHONE_REQUIRED: 请先绑定手机号
 *
 * 重要发现/差异：
 *   - schema 实际列名是 sale_items.remaining_sessions（fixture 用 remaining_count 是 bug，本 spec 直接 SQL）
 *   - 路由不校验同员工同时段冲突（没有 staffWfId+appointment_time 唯一性 SQL）→ 跳过此 case
 *   - 缺手机号：通过 requirePhone 中间件，与 order.create 同
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { ensureTestStore, createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder, cleanupClientExtras,
  createTestBeautician,
} from '../helpers/client-fixtures.mjs'

// 无 phone 顾客（PHONE_REQUIRED 测试）
const NOPHONE_USER_ID = `${NS}_CLI_NOP`
const NOPHONE_OPENID = `${NS}_CLI_NOP_OPENID`

async function ensureNoPhoneClient() {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, NULL, $3, '女', $4, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = NULL,
           bound_store_id = EXCLUDED.bound_store_id`,
    [NOPHONE_USER_ID, NOPHONE_OPENID, `${NS}_无手机`, TEST_STORE_ID]
  )
}

/**
 * 生成 "明天 10:00-11:00" 格式
 */
function tomorrowSlot() {
  const d = new Date(Date.now() + 86400_000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} 上午 10:00-11:00`
}

/**
 * 创建已支付 + 疗程卡 sale_items 的订单（remaining_sessions 由 SQL 直接设置）
 */
async function newPaidCourseOrder({ orderNo, sessionCount = 5, remainingSessions = 5 }) {
  await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 500,
    productType: '疗程卡', sessionCount,
  })
  await pgQuery(`UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = $1`, [orderNo])
  await pgQuery(
    `UPDATE sale_items SET session_count = $1, remaining_sessions = $2
     WHERE sale_order_id = $3`,
    [sessionCount, remainingSessions, orderNo]
  )
  // 返回 sale_item_id
  const items = await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 LIMIT 1`,
    [orderNo]
  )
  return { saleItemId: items[0].sale_item_id }
}

async function caseHappy() {
  await createTestClient()
  // appointments.employee_id 是 NOT NULL FK → staff_wechat_users。
  // 路由 INSERT 用 staffWfId || null，故必须传 staffWfId（实参为 employee_id）
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_APTC_BEAUT`,
    openid: `${NS}_APTC_BEAUT_OPENID`,
    phone: '19999099106',
  })
  const orderNo = `${NS}_APT_OK1`.slice(0, 30)
  const { saleItemId } = await newPaidCourseOrder({ orderNo, remainingSessions: 5 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.create', {
    saleItemId, appointmentTime: tomorrowSlot(),
    staffWfId: employeeId,
    staffName: `${NS}_美容师A`,
  })
  expectSuccess(res)
  if (res.data?.status !== '待确认') {
    throw new Error(`expect status=待确认, got: ${res.data?.status}`)
  }
  // PG 校验
  const rows = await pgQuery(
    `SELECT status FROM appointments WHERE appointment_id = $1 AND client_user_id = $2`,
    [res.data.appointmentId, TEST_CLIENT_USER_ID]
  )
  if (rows.length !== 1) throw new Error(`expect 1 appointment row, got ${rows.length}`)
  if (rows[0].status !== '待确认') throw new Error(`PG status=${rows[0].status}`)
}

async function caseNoRemainingRejected() {
  await createTestClient()
  const orderNo = `${NS}_APT_ZER1`.slice(0, 30)
  const { saleItemId } = await newPaidCourseOrder({ orderNo, remainingSessions: 0 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.create', {
    saleItemId, appointmentTime: tomorrowSlot(),
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '剩余次数不足' })
}

async function caseDuplicatePendingRejected() {
  await createTestClient()
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_APTD_BEAUT`,
    openid: `${NS}_APTD_BEAUT_OPENID`,
    phone: '19999099107',
  })
  const orderNo = `${NS}_APT_DUP1`.slice(0, 30)
  const { saleItemId } = await newPaidCourseOrder({ orderNo, remainingSessions: 5 })
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.create', {
    saleItemId, appointmentTime: tomorrowSlot(),
    staffWfId: employeeId,
  })
  expectSuccess(r1)
  // 再发一次同 saleItemId
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'appointment.create', {
    saleItemId, appointmentTime: tomorrowSlot(),
    staffWfId: employeeId,
  })
  expectError(r2, 'INVALID_PARAMS', { messageIncludes: '已有待确认' })
}

async function casePhoneRequired() {
  await ensureNoPhoneClient()
  // 无 phone 顾客也建一个可预约项目（直接 SQL）
  const orderNo = `${NS}_APT_NP1`.slice(0, 30)
  // 先把 saleOrder 绑到 NOPHONE_USER_ID
  await createTestPendingSaleOrder({
    saleOrderId: orderNo, clientUserId: NOPHONE_USER_ID,
    totalAmount: 500, productType: '疗程卡', sessionCount: 5,
  })
  await pgQuery(`UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = $1`, [orderNo])
  await pgQuery(
    `UPDATE sale_items SET session_count = 5, remaining_sessions = 5
     WHERE sale_order_id = $1`, [orderNo]
  )
  const items = await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 LIMIT 1`, [orderNo]
  )
  const res = await invokeAs(NOPHONE_OPENID, 'appointment.create', {
    saleItemId: items[0].sale_item_id, appointmentTime: tomorrowSlot(),
  })
  expectError(res, 'PHONE_REQUIRED')
}

async function caseMissingAppointmentTime() {
  await createTestClient()
  const orderNo = `${NS}_APT_MT1`.slice(0, 30)
  const { saleItemId } = await newPaidCourseOrder({ orderNo, remainingSessions: 5 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.create', {
    saleItemId,
    // 缺 appointmentTime
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '缺少预约时间' })
}

const CASES = [
  ['happy → appointments row inserted with status=待确认', caseHappy],
  ['remaining_sessions=0 → INVALID_PARAMS 剩余次数不足', caseNoRemainingRejected],
  ['duplicate pending for same saleItemId → INVALID_PARAMS', caseDuplicatePendingRejected],
  ['no phone → PHONE_REQUIRED', casePhoneRequired],
  ['missing appointmentTime → INVALID_PARAMS 缺少预约时间', caseMissingAppointmentTime],
]

let pass = 0, fail = 0
console.log(`[appointment/create.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[appointment/create.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
