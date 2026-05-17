#!/usr/bin/env bun
/**
 * store.unbindRequests 冒烟（仅查询，不构造 unbind 申请）
 *
 * 验证：调用不崩溃；空列表合理。
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-store-unbind] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()

  const r = await invokeStaffApi('store.unbindRequests', { _testOpenid: TEST_MANAGER_OPENID })
  if (r.code !== 0) { rec(`  ✗ FAIL code=${r.code} msg=${r.message}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — unbindRequests 调用成功 (${JSON.stringify(r.data).slice(0, 100)}...)`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
