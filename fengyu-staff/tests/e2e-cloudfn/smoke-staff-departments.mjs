#!/usr/bin/env bun
/**
 * staff.departments 冒烟 + staff.skillTags 字典 SELECT 守护
 *
 * skillTags（routes/staff.js:856-864）：SELECT name FROM skill_tags WHERE is_valid=true ORDER BY sort_order, name
 * 极轻量字典查询无 scope，仅守 schema 字段稳定 + requireStaffBound 守卫存在。
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
  if (r.code !== 0) { rec(`  ✗ FAIL departments code=${r.code} msg=${r.message}`); return }
  rec(`  ✓ departments 返回 ${(r.data?.departments || r.data || []).length} 组`)

  // ─── skillTags 字典查询 ───
  const st = await invokeStaffApi('staff.skillTags', { _testOpenid: TEST_MANAGER_OPENID })
  if (st.code !== 0) { rec(`  ✗ FAIL skillTags code=${st.code} msg=${st.message}`); return }
  if (!Array.isArray(st.data?.skillTags)) {
    rec(`  ✗ FAIL skillTags 返回结构错：data.skillTags 应是数组，实际=${typeof st.data?.skillTags}`)
    return
  }
  rec(`  ✓ skillTags 返回 ${st.data.skillTags.length} 个标签`)

  // 未绑定员工调 skillTags → UNAUTHORIZED（守 requireStaffBound 守卫）
  const stUnbound = await invokeStaffApi('staff.skillTags', { _testOpenid: `${NS}_NOT_EXIST_OID` })
  if (stUnbound.code === 0) { rec(`  ✗ FAIL skillTags 未绑定员工应被拒，实际成功`); return }

  pass = true; exitCode = 0
  rec(`  ✅ PASS — departments + skillTags（含未绑定 deny）`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { try { await cleanupTestData(NS) } catch {} ; await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
