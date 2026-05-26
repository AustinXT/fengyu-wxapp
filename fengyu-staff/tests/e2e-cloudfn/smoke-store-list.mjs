#!/usr/bin/env bun
/**
 * store.list 冒烟（店长视角：仅返本店）
 */
import './setup.mjs'
import { NS, TEST_STORE_ID, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-store-list] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()

  const r = await invokeStaffApi('store.list', { _testOpenid: TEST_MANAGER_OPENID })
  const errors = []
  if (r.code !== 0) errors.push(`store.list code=${r.code} msg=${r.message}`)
  else {
    const stores = r.data?.stores || r.data || []
    const list = Array.isArray(stores) ? stores : []
    const found = list.find(s => (s.store_id || s.storeId) === TEST_STORE_ID)
    if (!found) errors.push(`store.list 应包含 ${TEST_STORE_ID}，实际 ${list.length} 项`)
    else rec(`  ✓ store.list 包含本店 (${list.length} 总)`)
  }
  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
