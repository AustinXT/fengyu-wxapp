#!/usr/bin/env bun
/**
 * staff.bindStore 冒烟（切换 current_store_id）
 *
 * 简化版：仅验证调用成功 + 不崩溃，scope 切换语义由 auth 测试覆盖。
 */
import './setup.mjs'
import { NS, TEST_STORE_ID, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-store-bindstore] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()

  const r = await invokeStaffApi('staff.bindStore', {
    _testOpenid: TEST_MANAGER_OPENID, storeId: TEST_STORE_ID,
  })
  if (r.code !== 0) { rec(`  ✗ FAIL: code=${r.code} msg=${r.message}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — staff.bindStore 成功 (msg=${r.data?.message || JSON.stringify(r.data)})`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
