#!/usr/bin/env bun
/**
 * clientApi.appointment.cancel
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/appointment.js (cancel)
 *   - 仅 status = '待确认' 时允许 cancel（已确认不可取消，由顾客侧收紧）
 *   - 其他状态（已确认/已完成/已取消/已关闭）→ INVALID_PARAMS: 仅待确认的预约可取消
 *   - 已关联服务单且服务已开始/完成（service_orders.status ∈ 待服务/服务中/已完成）
 *     → INVALID_STATE: 该预约已开始服务，无法取消（防止服务已发生却显示已取消）；
 *     服务单为 已取消 时不拦截
 *   - 跨用户：路由 SELECT WHERE client_user_id 不命中 → INVALID_PARAMS: 预约不存在
 *     （无显式 PERMISSION_DENIED 分支）
 *
 * 重要发现：
 *   - 取消成功后 status = '已取消'
 *   - 入参 cancelledReason（注意末尾 ed，匹配 PG 列 cancelled_reason）
 *   - appointment_status 枚举：待确认/已确认/已完成/已取消/已关闭
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
  TEST_CLIENT2_OPENID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  createTestClient2, cleanupClientExtras,
  createTestBeautician, createTestAppointment,
} from '../helpers/client-fixtures.mjs'

async function insertAppointment({ idx, status, userId = TEST_CLIENT_USER_ID }) {
  const apptId = `${NS}_CN_${idx}`.slice(0, 30)
  // employee_id 是 NOT NULL FK → staff_wechat_users，先建美容师
  const { employeeId } = await createTestBeautician({
    employeeId: `${NS}_CN_BEAUT`,
    openid: `${NS}_CN_BEAUT_OPENID`,
    phone: '19999099104',
  })
  await createTestAppointment({
    appointmentId: apptId,
    clientUserId: userId,
    employeeId,
    status,
  })
  return apptId
}

// 插入一条关联到预约的服务单（assigned_employee_id 复用 insertAppointment 建的美容师）
async function insertServiceOrder({ idx, appointmentId, status, employeeId = `${NS}_CN_BEAUT` }) {
  const soId = `${NS}_CN_SO_${idx}`.slice(0, 30)
  await pgQuery(
    `INSERT INTO service_orders (
       service_order_id, status, service_order_type, market_name, store_id,
       service_date, assigned_employee_id, client_user_id, appointment_id
     )
     VALUES ($1, $2::service_order_status, '售前'::service_order_type, $3, $4,
             CURRENT_DATE, $5, $6, $7)`,
    [soId, status, `${NS}_市场`, TEST_STORE_ID, employeeId, TEST_CLIENT_USER_ID, appointmentId]
  )
  return soId
}

async function casePendingCancel() {
  await createTestClient()
  const apptId = await insertAppointment({ idx: 1, status: '待确认' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId, cancelledReason: '临时',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data?.status !== '已取消') {
    throw new Error(`expect status=已取消, got: ${res.data?.status}`)
  }
  const rows = await pgQuery(
    `SELECT status, cancelled_reason FROM appointments WHERE appointment_id = $1`,
    [apptId]
  )
  if (rows[0].status !== '已取消') throw new Error(`PG status=${rows[0].status}`)
  if (rows[0].cancelled_reason !== '临时') {
    throw new Error(`cancelled_reason=${rows[0].cancelled_reason}`)
  }
}

async function caseConfirmedRejected() {
  await createTestClient()
  const apptId = await insertAppointment({ idx: 2, status: '已确认' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  // 已确认不可取消（顾客侧收紧）
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '仅待确认' })
  // 预约保持已确认，未被翻成已取消
  const rows = await pgQuery(`SELECT status FROM appointments WHERE appointment_id = $1`, [apptId])
  if (rows[0].status !== '已确认') {
    throw new Error(`PG status=${rows[0].status}，期望仍为 已确认（拒绝后不应变更）`)
  }
}

async function caseCompletedRejected() {
  await createTestClient()
  // 路由 allow list 仅 待确认，'已完成' 会被拒绝
  const apptId = await insertAppointment({ idx: 3, status: '已完成' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '仅待确认' })
}

async function caseCrossUserDenied() {
  await createTestClient()       // 顾客 A
  await createTestClient2()      // 顾客 B
  const apptId = await insertAppointment({ idx: 4, status: '待确认' }) // 默认绑顾客 A
  // 顾客 B 取消 → SELECT WHERE client_user_id 不命中 → INVALID_PARAMS 预约不存在
  const res = await invokeAs(TEST_CLIENT2_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '预约不存在' })
}

// 待确认预约 + 关联进行中（服务中）服务单 → 取消被拦截，预约保持待确认
async function caseLinkedServiceRejected() {
  await createTestClient()
  const apptId = await insertAppointment({ idx: 5, status: '待确认' })
  await insertServiceOrder({ idx: 5, appointmentId: apptId, status: '服务中' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  expectError(res, 'INVALID_STATE', { messageIncludes: '已开始服务' })
  // 预约未被翻成已取消（防止服务已发生却显示已取消）
  const rows = await pgQuery(`SELECT status FROM appointments WHERE appointment_id = $1`, [apptId])
  if (rows[0].status !== '待确认') {
    throw new Error(`PG status=${rows[0].status}，期望仍为 待确认（拦截后不应变更）`)
  }
}

// 待确认预约 + 关联服务单为已取消 → 守卫不命中，取消照常放行
async function caseCancelledServiceStillCancellable() {
  await createTestClient()
  const apptId = await insertAppointment({ idx: 6, status: '待确认' })
  await insertServiceOrder({ idx: 6, appointmentId: apptId, status: '已取消' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  if (res.code !== 0) {
    throw new Error(`expect code=0 (服务单已取消应放行), got ${res.code}: ${res.message}`)
  }
  const rows = await pgQuery(`SELECT status FROM appointments WHERE appointment_id = $1`, [apptId])
  if (rows[0].status !== '已取消') throw new Error(`PG status=${rows[0].status}`)
}

const CASES = [
  ['cancel 待确认 → status=已取消 + cancelled_reason saved', casePendingCancel],
  ['cancel 已确认 → INVALID_PARAMS 仅待确认 + 预约保持已确认', caseConfirmedRejected],
  ['cancel 已完成 → INVALID_PARAMS 仅待确认', caseCompletedRejected],
  ['cancel cross-user → INVALID_PARAMS/预约不存在', caseCrossUserDenied],
  ['cancel 已关联服务中服务单 → INVALID_STATE 已开始服务 + 预约保持待确认', caseLinkedServiceRejected],
  ['cancel 关联服务单已取消 → 仍可取消', caseCancelledServiceStillCancellable],
]

let pass = 0, fail = 0
console.log(`[appointment/cancel.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[appointment/cancel.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
