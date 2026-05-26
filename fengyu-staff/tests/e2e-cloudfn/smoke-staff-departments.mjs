#!/usr/bin/env bun
/**
 * staff.departments 冒烟
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-staff-departments] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestStaff({
    employeeId: `${NS}_BEAU1`, openid: `${NS}_BEAU1_OPENID`,
    phone: '19999098010', name: `${NS}_美1`,
    isManager: false, positionName: '美容师', skills: ['美容师'],
  })

  const r = await invokeStaffApi('staff.departments', { _testOpenid: TEST_MANAGER_OPENID })
  if (r.code !== 0) { rec(`  ✗ FAIL code=${r.code} msg=${r.message}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — departments 返回 ${(r.data?.departments || r.data || []).length} 组`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
