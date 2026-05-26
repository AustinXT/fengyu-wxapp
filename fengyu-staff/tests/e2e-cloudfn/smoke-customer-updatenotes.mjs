#!/usr/bin/env bun
/**
 * customer.updateNotes 冒烟
 *
 * 验证：
 *   1. 店长可更新顾客备注
 *   2. PG: client_wechat_users.notes 落库
 *   3. 非店长调用必拒
 */
import './setup.mjs'
import { NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-customer-updatenotes] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestStaff({
    employeeId: `${NS}_BEAU`, openid: `${NS}_BEAU_OPENID`,
    phone: '19999098009', name: `${NS}_美`, isManager: false, positionName: '美容师',
  })
  await createTestClient()

  const errors = []
  const note = `e2e_note_${Date.now()}`

  // 1. 店长更新
  const r1 = await invokeStaffApi('customer.updateNotes', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID, notes: note,
  })
  if (r1.code !== 0) errors.push(`店长 updateNotes code=${r1.code} msg=${r1.message}`)
  else {
    const c = (await pgQuery(`SELECT notes FROM client_wechat_users WHERE user_id = $1`, [TEST_CLIENT_USER_ID]))[0]
    if (c.notes !== note) errors.push(`notes 未落库，实际='${c.notes}'`)
    else rec(`  ✓ 店长 updateNotes 落库 ('${c.notes}')`)
  }

  // 2. 非店长拒
  const r2 = await invokeStaffApi('customer.updateNotes', {
    _testOpenid: `${NS}_BEAU_OPENID`,
    clientUserId: TEST_CLIENT_USER_ID, notes: 'should-not-write',
  })
  if (r2.code === 0) errors.push(`非店长 updateNotes 应拒，实际成功`)
  else rec(`  ✓ 非店长拒（${r2.message}）`)

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — updateNotes 权限 + 落库正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-customer-updatenotes] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
