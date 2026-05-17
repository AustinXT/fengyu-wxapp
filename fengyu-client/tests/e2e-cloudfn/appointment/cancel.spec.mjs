#!/usr/bin/env bun
/**
 * clientApi.appointment.cancel
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/appointment.js (line 185)
 *   - status ∈ {'待确认','已确认'} 时允许 cancel
 *   - 其他状态（已签到/已完成/已取消）→ INVALID_PARAMS: 预约状态不允许取消
 *   - 跨用户：路由 SELECT WHERE client_user_id 不命中 → INVALID_PARAMS: 预约不存在
 *     （无显式 PERMISSION_DENIED 分支）
 *
 * 重要发现：
 *   - 取消成功后 status = '已取消'
 *   - 入参 cancelledReason（注意末尾 ed，匹配 PG 列 cancelled_reason）
 *   - appointment_status 枚举包含 '已签到' 状态
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

async function caseConfirmedCancel() {
  await createTestClient()
  const apptId = await insertAppointment({ idx: 2, status: '已确认' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  // 路由 allowed: 待确认/已确认
  if (res.code !== 0) throw new Error(`expect code=0 (已确认 allowed), got ${res.code}: ${res.message}`)
  const rows = await pgQuery(`SELECT status FROM appointments WHERE appointment_id = $1`, [apptId])
  if (rows[0].status !== '已取消') throw new Error(`PG status=${rows[0].status}`)
}

async function caseCompletedRejected() {
  await createTestClient()
  // appointment_status 枚举不含 '已签到'，仅 待确认/已确认/已完成/已取消/已关闭
  // 路由 allow list 是 待确认/已确认，'已完成' 同样会被拒绝
  const apptId = await insertAppointment({ idx: 3, status: '已完成' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'appointment.cancel', {
    appointmentId: apptId,
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '预约状态不允许取消' })
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

const CASES = [
  ['cancel 待确认 → status=已取消 + cancelled_reason saved', casePendingCancel],
  ['cancel 已确认 → allowed → status=已取消', caseConfirmedCancel],
  ['cancel 已完成 → INVALID_PARAMS 预约状态不允许取消', caseCompletedRejected],
  ['cancel cross-user → INVALID_PARAMS/预约不存在', caseCrossUserDenied],
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
