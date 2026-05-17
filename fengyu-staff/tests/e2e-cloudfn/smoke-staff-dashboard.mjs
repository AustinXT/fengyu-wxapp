#!/usr/bin/env bun
/**
 * staff.dashboard 冒烟（5 指标看板）
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-staff-dashboard] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()

  const today = new Date().toISOString().slice(0, 10)
  const r = await invokeStaffApi('staff.dashboard', {
    _testOpenid: TEST_MANAGER_OPENID,
    startDate: today, endDate: today,
  })
  if (r.code !== 0) { rec(`  ✗ FAIL code=${r.code} msg=${r.message}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — dashboard 返回 keys=${Object.keys(r.data || {}).join(',')}`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
