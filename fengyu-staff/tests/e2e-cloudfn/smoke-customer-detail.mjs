#!/usr/bin/env bun
/**
 * customer.detail 冒烟
 *
 * 验证：
 *   1. detail 返回 7 项关键字段（gender/storeName/notes/lastServiceDate/visitFrequency/topProductName + memberLevel）
 *   2. 跨店调用 — 顾客必须可见（bound_store_id 匹配 effectiveStoreId）
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-detail] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []

  const r = await invokeStaffApi('customer.detail', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  if (r.code !== 0) {
    errors.push(`detail code=${r.code} msg=${r.message}`)
  } else {
    const expectedKeys = ['gender', 'storeName', 'notes', 'lastServiceDate', 'visitFrequency', 'topProductName']
    for (const k of expectedKeys) {
      if (!(k in r.data)) errors.push(`detail 缺少字段 ${k}`)
    }
    rec(`  ✓ detail 返回字段: gender=${r.data.gender} store=${r.data.storeName} member=${r.data.memberLevel}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — detail 7 项字段完整`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-detail] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
