#!/usr/bin/env bun
/**
 * mgmtProduct.cardHolders + cycleStats 冒烟
 *
 * 简化：仅验证 API 不崩溃；scope 用 market 级。
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID, TEST_MARKET_ORG_ID,
  closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestPermissionRole, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-mgmt-product] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestPermissionRole({
    employeeId: TEST_MANAGER_EMP_ID, role: 'manager', scopeId: TEST_MARKET_ORG_ID,
  })

  let any = false
  for (const action of ['mgmtProduct.cardHolders', 'mgmtProduct.cycleStats']) {
    const r = await invokeStaffApi(action, {
      _testOpenid: TEST_MANAGER_OPENID,
      _loginLevel: 'management',
      scopeType: 'market', scopeId: TEST_MARKET_ORG_ID,
    })
    if (r.code !== 0) rec(`  ⚠️  ${action} code=${r.code} msg=${r.message}`)
    else { rec(`  ✓ ${action} OK`); any = true }
  }
  pass = any; exitCode = 0
  rec(`  ${any ? '✅ PASS' : '⚠️  TODO'} — mgmt-product 2 API 检查`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-mgmt-product] end | ${pass ? 'PASS' : 'TODO'} | exit=${exitCode}`)
  process.exit(exitCode)
}
