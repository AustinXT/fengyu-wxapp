#!/usr/bin/env bun
/**
 * staff.performanceDetail 冒烟
 *
 * 验证：employeeId + filterType + 分页参数能正常调用。
 */
import './setup.mjs'
import { NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-staff-performance] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()

  const errors = []
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = today.slice(0, 8) + '01'
  for (const ft of ['all', 'allocation', 'service']) {
    const r = await invokeStaffApi('staff.performanceDetail', {
      _testOpenid: TEST_MANAGER_OPENID, employeeId: TEST_MANAGER_EMP_ID, filterType: ft,
      startDate: monthStart, endDate: today, page: 1, pageSize: 10,
    })
    if (r.code !== 0) errors.push(`filterType=${ft} code=${r.code} msg=${r.message}`)
    else rec(`  ✓ filterType=${ft} OK`)
  }
  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — performanceDetail 3 filter 正常`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
