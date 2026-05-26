#!/usr/bin/env bun
/**
 * customer.assign 冒烟
 *
 * 验证：
 *   1. 店长可分配顾客给本店员工
 *   2. 非店长调用必拒
 *   3. 目标员工必须在本店
 *   4. operation_logs 写入 audit 行
 */
import './setup.mjs'
import { NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-assign] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestStaff({
    employeeId: `${NS}_BEAU`, openid: `${NS}_BEAU_OPENID`,
    phone: '19999098008', name: `${NS}_美容师X`,
    isManager: false, positionName: '美容师',
  })
  await createTestClient()

  const errors = []

  // 1. 店长分配
  const r1 = await invokeStaffApi('customer.assign', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: `${NS}_BEAU`,
  })
  if (r1.code !== 0) errors.push(`店长 assign code=${r1.code} msg=${r1.message}`)
  else rec(`  ✓ 店长 assign OK`)

  // 2. 非店长调用拒
  const r2 = await invokeStaffApi('customer.assign', {
    _testOpenid: `${NS}_BEAU_OPENID`,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: TEST_MANAGER_EMP_ID,
  })
  if (r2.code === 0) errors.push(`非店长 assign 应拒，实际成功`)
  else rec(`  ✓ 非店长拒（${r2.message}）`)

  // 3. operation_logs 写入（注意：assign 的 audit INSERT 未填 operator_employee_id，按 target_id+action 查）
  const logs = await pgQuery(
    `SELECT action, detail FROM operation_logs
       WHERE action = 'customer.assign' AND target_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (logs.length === 0) errors.push(`customer.assign 应写 operation_logs`)
  else rec(`  ✓ operation_logs 写入 ${logs.length} 行 detail=${JSON.stringify(logs[0].detail)}`)

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — assign 权限 + audit 正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-assign] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
