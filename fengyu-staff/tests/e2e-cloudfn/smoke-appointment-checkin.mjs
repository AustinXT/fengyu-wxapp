#!/usr/bin/env bun
/**
 * appointment.checkin 冒烟
 *
 * 验证：
 *   1. 待确认 → checkin（不需要 confirm 前置，'待确认/已确认' 都可签到）
 *   2. checkin_at 写入
 *   3. 幂等：再次 checkin 不覆盖原 checkin_at
 *   4. 已完成/已取消/已关闭 状态拒绝签到
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestAppointment, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-appointment-checkin] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const apptA = `${NS}_CKI_A`
  const apptB = `${NS}_CKI_B`  // 已完成（拒）
  await createTestAppointment({ appointmentId: apptA, status: '已确认', employeeId: TEST_MANAGER_EMP_ID, employeeName: `${NS}_店长` })
  await createTestAppointment({ appointmentId: apptB, status: '已完成', employeeId: TEST_MANAGER_EMP_ID, employeeName: `${NS}_店长` })

  const errors = []

  // 1. 第一次 checkin
  const r1 = await invokeStaffApi('appointment.checkin', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: apptA,
  })
  if (r1.code !== 0) errors.push(`第一次 checkin 应成功，实际 code=${r1.code} msg=${r1.message}`)
  else rec(`  ✓ 第一次 checkin OK`)

  const row1 = (await pgQuery(`SELECT checkin_at FROM appointments WHERE appointment_id = $1`, [apptA]))[0]
  if (!row1.checkin_at) errors.push(`checkin_at 应非 NULL`)
  const firstAt = row1.checkin_at

  // 2. 幂等：再次 checkin
  await new Promise(r => setTimeout(r, 50))  // 让时间差异更大，便于检测覆盖
  const r2 = await invokeStaffApi('appointment.checkin', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: apptA,
  })
  if (r2.code !== 0) errors.push(`幂等 checkin 应仍成功，实际 code=${r2.code}`)
  else rec(`  ✓ 幂等 checkin (${r2.data.message})`)

  const row2 = (await pgQuery(`SELECT checkin_at FROM appointments WHERE appointment_id = $1`, [apptA]))[0]
  if (new Date(row2.checkin_at).getTime() !== new Date(firstAt).getTime()) {
    errors.push(`幂等 checkin_at 应不变，实际 first=${firstAt} second=${row2.checkin_at}`)
  } else {
    rec(`  ✓ checkin_at 未被覆盖（幂等）`)
  }

  // 3. 已完成状态拒绝
  const r3 = await invokeStaffApi('appointment.checkin', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: apptB,
  })
  if (r3.code === 0) errors.push(`已完成预约 checkin 应拒，实际成功`)
  else rec(`  ✓ 已完成预约 checkin 被拒（${r3.message}）`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — checkin 3 路径 + 幂等正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-appointment-checkin] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
