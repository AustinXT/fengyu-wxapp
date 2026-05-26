#!/usr/bin/env bun
/**
 * customer.customerBalance 冒烟（店长查顾客储值卡余额，跨店统一）
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestPrepaidCard, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-card-balance] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  await createTestPrepaidCard({ initialBalance: 888 })

  const r = await invokeStaffApi('customer.customerBalance', {
    _testOpenid: TEST_MANAGER_OPENID, customerUserId: TEST_CLIENT_USER_ID,
  })
  if (r.code !== 0) { rec(`  ✗ FAIL code=${r.code} msg=${r.message}`); return }
  const bal = Number(r.data?.balance ?? r.data?.totalBalance ?? 0)
  if (Math.abs(bal - 888) > 0.001) {
    rec(`  ✗ FAIL balance 应=888，实际=${bal}（data=${JSON.stringify(r.data)}）`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — balance=${bal}`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
