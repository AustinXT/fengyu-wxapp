#!/usr/bin/env bun
/**
 * appointment.confirm 冒烟
 *
 * 验证：
 *   1. 待确认 → 已确认 (confirmed_at 写入)
 *   2. 非 manager 调用别人的预约 必拒
 *   3. 已确认状态再调 confirm 必拒
 *   4. 不存在的 appointmentId 必拒
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
  rec(`[smoke-appointment-confirm] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestStaff({
    employeeId: `${NS}_BEAU`, openid: `${NS}_BEAU_OPENID`,
    phone: '19999098007', name: `${NS}_美`,
    isManager: false, positionName: '美容师',
  })
  await createTestClient()

  const apptOk = `${NS}_APT_OK`
  const apptOther = `${NS}_APT_OTHER`
  const apptDone = `${NS}_APT_DONE`
  await createTestAppointment({ appointmentId: apptOk, status: '待确认', employeeId: TEST_MANAGER_EMP_ID, employeeName: `${NS}_店长` })
  await createTestAppointment({ appointmentId: apptOther, status: '待确认', employeeId: TEST_MANAGER_EMP_ID, employeeName: `${NS}_店长` })
  await createTestAppointment({ appointmentId: apptDone, status: '已确认', employeeId: TEST_MANAGER_EMP_ID, employeeName: `${NS}_店长` })

  const errors = []

  // 1. 正常确认
  const r1 = await invokeStaffApi('appointment.confirm', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: apptOk,
  })
  if (r1.code !== 0) errors.push(`正常 confirm 应成功，实际 code=${r1.code} msg=${r1.message}`)
  else {
    const row = (await pgQuery(`SELECT status, confirmed_at FROM appointments WHERE appointment_id = $1`, [apptOk]))[0]
    if (row.status !== '已确认') errors.push(`apptOk.status 应='已确认'，实际='${row.status}'`)
    if (!row.confirmed_at) errors.push(`apptOk.confirmed_at 应非 NULL`)
    else rec(`  ✓ 正常 confirm OK`)
  }

  // 2. 非 manager 调别人的预约（美容师调店长的预约）
  const r2 = await invokeStaffApi('appointment.confirm', {
    _testOpenid: `${NS}_BEAU_OPENID`, appointmentId: apptOther,
  })
  if (r2.code === 0) errors.push(`美容师调别人的预约应拒，实际成功`)
  else rec(`  ✓ 非 manager 调别人的预约被拒（${r2.message}）`)

  // 3. 已确认再 confirm
  const r3 = await invokeStaffApi('appointment.confirm', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: apptDone,
  })
  if (r3.code === 0) errors.push(`已确认再 confirm 应拒，实际成功`)
  else rec(`  ✓ 已确认状态被拒（${r3.message}）`)

  // 4. 不存在
  const r4 = await invokeStaffApi('appointment.confirm', {
    _testOpenid: TEST_MANAGER_OPENID, appointmentId: 'NOT-EXIST-APPT',
  })
  if (r4.code === 0) errors.push(`不存在 appointmentId 应拒，实际成功`)
  else rec(`  ✓ 不存在被拒`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — confirm 4 路径正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-appointment-confirm] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
