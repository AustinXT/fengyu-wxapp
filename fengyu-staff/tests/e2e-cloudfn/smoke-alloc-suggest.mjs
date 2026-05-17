#!/usr/bin/env bun
/**
 * allocation.suggest 冒烟
 *
 * 验证：
 *   1. 已支付 + 待分配 订单可生成 allocLines
 *   2. 按 preferred_employee_id 解析员工 skills
 *   3. 每个 (item × skill) 生成一条 allocLine
 *   4. 员工 skills 为空时 deptAnomalous=true
 *
 * 不依赖 commission_rate_matrix 数据（commRate=0 时 allocLine 仍生成）
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-alloc-suggest] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  // 店长（用于调用）
  await createTestStaff()
  // 美容师 + 养生师双 skill 员工（preferred_employee）
  await createTestStaff({
    employeeId: `${NS}_BEAU`,
    openid: `${NS}_BEAU_OPENID`,
    phone: '19999099005',
    name: `${NS}_美养双技`,
    isManager: false,
    positionName: '美容师',
    skills: ['美容师', '养生师'],
  })
  // 无 skill 员工（测 deptAnomalous）
  await createTestStaff({
    employeeId: `${NS}_NOSKILL`,
    openid: `${NS}_NOSKILL_OPENID`,
    phone: '19999099006',
    name: `${NS}_无技能`,
    isManager: false,
    positionName: '美容师',
    skills: [],
  })
  await createTestClient()

  // ─── A. preferred 有双 skill 员工 ───
  const orderA = `${NS}_SUG_A`
  await createTestSaleOrder({
    saleOrderId: orderA, clientUserId: TEST_CLIENT_USER_ID,
    productType: '单品', quantity: 1, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
    preferredEmployeeId: `${NS}_BEAU`,
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderA])

  const errors = []

  const sugA = await invokeStaffApi('allocation.suggest', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderA,
  })
  if (sugA.code !== 0) {
    errors.push(`suggest A 应成功，实际 code=${sugA.code} msg=${sugA.message}`)
  } else {
    const lines = sugA.data.allocLines || []
    rec(`  A: ${lines.length} allocLines (双 skill × 1 item)`)
    if (lines.length !== 2) errors.push(`A.allocLines 应=2（1 item × 2 skills），实际=${lines.length}`)
    const roles = new Set(lines.map(l => l.roleType))
    if (!roles.has('美容师') || !roles.has('养生师')) {
      errors.push(`A.roleType 应含 美容师 + 养生师，实际=${[...roles].join(',')}`)
    }
    if (sugA.data.beauticianRequired !== true) errors.push(`A.beauticianRequired 应=true（有 skills）`)
    if (sugA.data.deptAnomalous === true) errors.push(`A.deptAnomalous 应=false（有 skills）`)
  }

  // ─── B. preferred 无 skill 员工 ───
  const orderB = `${NS}_SUG_B`
  await createTestSaleOrder({
    saleOrderId: orderB, clientUserId: TEST_CLIENT_USER_ID,
    productType: '单品', quantity: 1, totalAmount: 300,
    status: '已支付', salesCategory: '他销自耗',
    preferredEmployeeId: `${NS}_NOSKILL`,
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderB])

  const sugB = await invokeStaffApi('allocation.suggest', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderB,
  })
  if (sugB.code !== 0) {
    errors.push(`suggest B 应成功，实际 code=${sugB.code}`)
  } else {
    rec(`  B: deptAnomalous=${sugB.data.deptAnomalous} beauticianRequired=${sugB.data.beauticianRequired}`)
    if (sugB.data.deptAnomalous !== true) errors.push(`B.deptAnomalous 应=true（员工无 skills），实际=${sugB.data.deptAnomalous}`)
    if (sugB.data.beauticianRequired === true) errors.push(`B.beauticianRequired 应=false`)
    if ((sugB.data.allocLines || []).length !== 0) errors.push(`B.allocLines 应=0（无 skills 不生成），实际=${(sugB.data.allocLines || []).length}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — suggest 按 skills 生成 allocLines + deptAnomalous 守卫正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-alloc-suggest] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-alloc-suggest] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
