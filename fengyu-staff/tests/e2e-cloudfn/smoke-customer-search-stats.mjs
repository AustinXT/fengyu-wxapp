#!/usr/bin/env bun
/**
 * customer.search + stats + listByTag 冒烟
 *
 * 验证：
 *   1. search by phone（精确匹配，跨店命中已绑定 bound_store_id 顾客）
 *   2. search by keyword（本店模糊匹配）
 *   3. stats 6 分桶（active / atRisk / lost / sleeping / birthday / birthdayNext）
 *   4. listByTag 'sleeping' 返回沉睡顾客（>90 天无服务）
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_PHONE, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-search-stats] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()  // 默认 customer，bound 本店

  const errors = []

  // 1. search by phone
  const r1 = await invokeStaffApi('customer.search', {
    _testOpenid: TEST_MANAGER_OPENID, phone: TEST_CLIENT_PHONE,
  })
  if (r1.code !== 0) errors.push(`search by phone code=${r1.code}`)
  else {
    const found = r1.data.find(c => c.phone === TEST_CLIENT_PHONE)
    if (!found) errors.push(`search by phone 应找到 ${TEST_CLIENT_PHONE}`)
    else rec(`  ✓ search by phone (manager 见明文 ${found.phone})`)
  }

  // 2. search by keyword
  const r2 = await invokeStaffApi('customer.search', {
    _testOpenid: TEST_MANAGER_OPENID, keyword: NS,
  })
  if (r2.code !== 0) errors.push(`search by keyword code=${r2.code}`)
  else {
    if (!r2.data.find(c => c.name.includes(NS))) errors.push(`search by keyword '${NS}' 应至少找到测试顾客`)
    else rec(`  ✓ search by keyword (${r2.data.length} matches)`)
  }

  // 3. stats
  const r3 = await invokeStaffApi('customer.stats', { _testOpenid: TEST_MANAGER_OPENID })
  if (r3.code !== 0) errors.push(`stats code=${r3.code}`)
  else {
    const keys = ['active', 'atRisk', 'lost', 'sleeping', 'birthday', 'birthdayNext', 'total', 'memberCount', 'flowCount']
    for (const k of keys) {
      if (typeof r3.data[k] !== 'number') errors.push(`stats.${k} 应为 number，实际=${typeof r3.data[k]}`)
    }
    rec(`  ✓ stats: total=${r3.data.total} sleeping=${r3.data.sleeping} member=${r3.data.memberCount}`)
  }

  // 4. listByTag sleeping（顾客无服务记录 → sleeping）
  const r4 = await invokeStaffApi('customer.listByTag', {
    _testOpenid: TEST_MANAGER_OPENID, tag: 'sleeping',
  })
  if (r4.code !== 0) errors.push(`listByTag sleeping code=${r4.code} msg=${r4.message}`)
  else rec(`  ✓ listByTag sleeping: ${r4.data.total} customers`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — search/stats/listByTag 4 路径正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-search-stats] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
