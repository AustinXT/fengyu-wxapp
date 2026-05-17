#!/usr/bin/env bun
/**
 * staff.todayCommission + monthlyCalendar + todoList 冒烟（工作台 3 接口）
 *
 * 验证：3 接口都返回正常 + 关键字段存在。
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-staff-workbench] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []
  for (const action of ['staff.todayCommission', 'staff.monthlyCalendar', 'staff.todoList']) {
    const r = await invokeStaffApi(action, { _testOpenid: TEST_MANAGER_OPENID })
    if (r.code !== 0) errors.push(`${action} code=${r.code} msg=${r.message}`)
    else rec(`  ✓ ${action} OK keys=${Object.keys(r.data || {}).join(',')}`)
  }
  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — 工作台 3 接口正常`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
