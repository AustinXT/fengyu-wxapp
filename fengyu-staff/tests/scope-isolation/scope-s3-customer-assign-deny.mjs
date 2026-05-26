#!/usr/bin/env bun
/**
 * scope-s3：customer.assign 越权拒绝（assertCustomerInScope + assertEmployeeInScope）
 *
 * 验证 customer.assign 的两层 scope 守卫：
 *   1) MGR(nc01) 试图把 NC02 顾客分配给自店员工 → 顾客不在 scope 拒
 *   2) MGR(nc01) 试图把本店顾客分配给 MGR2(nc02) 员工 → 员工不在 scope 拒
 *   3) MGR(nc01) 把本店顾客分配给本店员工 → 通过（正例对照）
 *
 * 业务含义：店长不能跨店挪顾客，避免分润 / 业绩归属泄漏到他店。
 *
 * 关键引用：
 *   - routes/customer.js:assign (1010-1046)
 *   - utils/scope-guards.js: assertCustomerInScope / assertEmployeeInScope
 */
import './setup.mjs'
import { SCOPE_OPENID, SCOPE_CLIENTS, SCOPE_TOPOLOGY, ensureOpenidsSeeded } from './setup.mjs'
import { invokeStaffApi } from '../e2e-cloudfn/helpers/invoke.mjs'
import { pgQuery, closePool } from '../e2e-cloudfn/setup.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec('[scope-s3] start')
  ensureOpenidsSeeded()

  const errors = []

  // 找一个 store-nc01 本店员工（FY-TEST-MGR 自己 ok）
  const nc01StaffRow = await pgQuery(
    `SELECT employee_id FROM staff_wechat_users
      WHERE store_id=$1 AND COALESCE(is_resigned,false)=false
      LIMIT 1`,
    [SCOPE_TOPOLOGY.STORE_NC01],
  )
  if (nc01StaffRow.length === 0) {
    rec(`  ✗ FAIL: 找不到 store-nc01 员工`)
    return
  }
  const nc01StaffId = nc01StaffRow[0].employee_id
  rec(`  · nc01 员工 sample: ${nc01StaffId}`)

  // ── 1. MGR(nc01) 把 NC02 顾客分配给本店员工 → 应拒 (assertCustomerInScope) ──
  {
    // 记录 NC02 顾客原 bound_employee_id 以便事后校验未被改
    const beforeRows = await pgQuery(
      `SELECT bound_employee_id FROM client_wechat_users WHERE user_id=$1`,
      [SCOPE_CLIENTS.NC02],
    )
    const beforeBoundEmp = beforeRows[0]?.bound_employee_id ?? null

    const r = await invokeStaffApi('customer.assign', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      clientUserId: SCOPE_CLIENTS.NC02,
      employeeId: nc01StaffId,
    })
    const isDenied =
      r.code !== 0 &&
      (r.code === -403 || /PERMISSION_DENIED|NOT_FOUND/.test(r.message || ''))
    if (!isDenied) {
      errors.push(`(1) MGR assign NC02 顾客 应被 scope 拒, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (1) MGR(nc01) assign NC02 顾客 → 被拒 (${r.code} ${r.message})`)
    }
    // 防御：即使云函数 bug 没拒，DB 也不应被改写
    const afterRows = await pgQuery(
      `SELECT bound_employee_id FROM client_wechat_users WHERE user_id=$1`,
      [SCOPE_CLIENTS.NC02],
    )
    const afterBoundEmp = afterRows[0]?.bound_employee_id ?? null
    if (afterBoundEmp !== beforeBoundEmp) {
      errors.push(`(1) NC02 顾客 bound_employee_id 被改写: ${beforeBoundEmp} → ${afterBoundEmp}（应保持不变）`)
    }
  }

  // ── 2. MGR(nc01) 把本店顾客分配给跨店员工 (FY-TEST-MGR2, store-nc02) → 应拒 ──
  {
    const r = await invokeStaffApi('customer.assign', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      clientUserId: SCOPE_CLIENTS.NC01,
      employeeId: 'FY-TEST-MGR2', // store-nc02 manager
    })
    const isDenied =
      r.code !== 0 &&
      (r.code === -403 || /PERMISSION_DENIED|NOT_FOUND/.test(r.message || ''))
    if (!isDenied) {
      errors.push(`(2) MGR assign 给跨店员工 应被 scope 拒, 实际 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (2) MGR(nc01) assign 给 FY-TEST-MGR2 → 被拒 (${r.code} ${r.message})`)
    }
  }

  // ── 3. 正例对照：MGR(nc01) 把本店顾客分配给本店员工 → 通过 ──
  {
    // 取本店一个员工不是当前 assign 的对象，否则可能 no-op
    const beforeRow = await pgQuery(
      `SELECT bound_employee_id FROM client_wechat_users WHERE user_id=$1`,
      [SCOPE_CLIENTS.NC01],
    )
    const before = beforeRow[0]?.bound_employee_id ?? null
    const targetEmp = nc01StaffId

    const r = await invokeStaffApi('customer.assign', {
      _testOpenid: SCOPE_OPENID.MGR,
      _loginLevel: 'store',
      _currentStoreId: SCOPE_TOPOLOGY.STORE_NC01,
      clientUserId: SCOPE_CLIENTS.NC01,
      employeeId: targetEmp,
    })
    if (r.code !== 0) {
      errors.push(`(3) 正例 MGR assign 本店 NC01 顾客 给本店员工 失败 code=${r.code} msg=${r.message}`)
    } else {
      rec(`  ✓ (3) 正例：MGR(nc01) assign NC01 顾客 → 通过 (employeeName=${r.data?.employeeName})`)
      // 回滚到之前的 bound_employee_id（避免污染其他 spec）
      await pgQuery(
        `UPDATE client_wechat_users SET bound_employee_id=$1, updated_at=NOW() WHERE user_id=$2`,
        [before, SCOPE_CLIENTS.NC01],
      )
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — customer.assign scope guard 生效（顾客+员工双层）`)
}

try {
  await main()
} catch (e) {
  console.error('EXCEPTION:', e.message)
  console.error(e.stack)
} finally {
  try { await closePool() } catch {}
  process.exit(pass ? 0 : exitCode)
}
