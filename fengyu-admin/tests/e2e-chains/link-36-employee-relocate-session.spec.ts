/**
 * 链路 36：调店后旧 session 快照行为
 *
 * 主题：scope 是在登录构建 session 时由 expandScopeStoreIds() 计算并 snapshot 进 cookie 的；
 *       调店操作只改 DB（permission_roles.scope_id + staff_wechat_users.store_id），
 *       不会主动注销已登录 session。本链路守护这一行为：
 *         1. 已登录 session 在调店后**仍按旧 scope** 显示数据（session 是快照，不实时）
 *         2. logout + login 后 scope 切换生效
 *
 * 实现：
 *   1. 新建临时员工 FY-TEST-RELOC36（绑 store-nc01, manager scope=org-store-nc01）+ 设密码
 *   2. seed 1 笔 store-nc01 订单 + 1 笔 store-nc02 订单（验证两端可见性切换）
 *   3. 浏览器 A：以 FY-TEST-RELOC36 登录 → /orders 见 nc01 订单，不见 nc02 订单
 *   4. 浏览器 B（admin 操作 DB / 直调）：把 RELOC36 的 store_id + scope 改为 store-nc02
 *   5. 浏览器 A 刷新 /orders → 仍按旧 scope（仍见 nc01，不见 nc02）— SESSION SNAPSHOT 验证
 *   6. 浏览器 A logout → 再 login → /orders 切换为新 scope（见 nc02，不见 nc01）
 *   7. cleanup
 *
 * 关键引用：
 *   - actions/auth.ts:207 getSessionFromCookie + expandScopeStoreIds（session 构造时计算 scopeStoreIds）
 *   - actions/employees.ts updateEmployee 同步 permission_roles.scope_id
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TEST_PHONES, SCOPE_CLIENTS, TOPOLOGY,
  psql, login, logout, pageContainsKeyword, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const EID = 'FY-TEST-RELOC36'
const PHONE = '13900139036'
const TAG = 'CHAIN36'
const SOID_A = `FY-${TAG}-WX-0001` // store-nc01
const SOID_B = `FY-${TAG}-WX-0002` // store-nc02

function setup(): void {
  // 兜底清理可能的残留
  cleanup()

  // 临时员工：绑 store-nc01 + manager scope=org-store-nc01
  psql(`
    INSERT INTO staff_wechat_users (employee_id, name, phone, store_id, gender, is_resigned, created_at, updated_at)
    VALUES ('${EID}', '调店测试员36', '${PHONE}', '${TOPOLOGY.STORE_NC01}', '男', false, NOW(), NOW())
    ON CONFLICT (employee_id) DO UPDATE SET store_id='${TOPOLOGY.STORE_NC01}', is_resigned=false
  `)
  psql(`
    INSERT INTO admin_passwords (employee_id, password_hash, must_change, created_at, updated_at)
    SELECT '${EID}', password_hash, false, NOW(), NOW()
    FROM admin_passwords WHERE employee_id='FY-TEST-MGR' LIMIT 1
    ON CONFLICT (employee_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, must_change=false
  `)
  psql(`
    INSERT INTO permission_roles (employee_id, role, scope_id, created_at)
    VALUES ('${EID}', 'manager', '${TOPOLOGY.ORG_NC01}', NOW())
    ON CONFLICT (employee_id, role, scope_id) DO NOTHING
  `)

  // 两笔订单：一个 nc01、一个 nc02
  for (const [soid, storeId, clientUser, name, phone] of [
    [SOID_A, TOPOLOGY.STORE_NC01, SCOPE_CLIENTS.NC01, 'Fixture测试客', '13800138000'],
    [SOID_B, TOPOLOGY.STORE_NC02, SCOPE_CLIENTS.NC02, 'NC02测试客', '13800138002'],
  ] as const) {
    psql(`
      INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by, created_at, updated_at,
        payable_amount, received, refunded_amount, prepaid_card_amount
      ) VALUES (
        '${soid}', '已支付', '销售单', '南昌市场', '${storeId}',
        NOW(), '${clientUser}', '${phone}', '${name}',
        100.00, '线下', 'FY-TEST-MGR2', NOW(), NOW(),
        100.00, 100.00, 0, 0
      ) ON CONFLICT (sale_order_id) DO NOTHING
    `)
  }
}

function relocateEmployeeToNc02(): void {
  // 模拟 admin 通过 updateEmployee 触发调店：DB 改 store_id + scope_id
  psql(`UPDATE staff_wechat_users SET store_id='${TOPOLOGY.STORE_NC02}', updated_at=NOW() WHERE employee_id='${EID}'`)
  psql(`UPDATE permission_roles SET scope_id='${TOPOLOGY.ORG_NC02}' WHERE employee_id='${EID}' AND role='manager'`)
}

function cleanup(): void {
  for (const id of [SOID_A, SOID_B]) cleanupSaleOrder(id, psql, { logPrefix: '[链路36]' })
  try { psql(`DELETE FROM operation_logs WHERE target_id='${EID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM permission_roles WHERE employee_id='${EID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM admin_passwords WHERE employee_id='${EID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM staff_wechat_users WHERE employee_id='${EID}'`) } catch {/* noop */}
}

test.setTimeout(240_000)

test('链路36：调店后旧 session 快照行为', async ({ browser }) => {
  const verdicts: Verdict[] = []
  setup()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    // ── Step 1: 以 RELOC36 登录（store-nc01 scope）── 旧 scope 应见 nc01 不见 nc02
    console.log('[链路36] Step 1: 登录 RELOC36（绑 store-nc01）')
    await login(page, PHONE)

    const seeAOld = await pageContainsKeyword(page, `/orders?q=${SOID_A}`, SOID_A)
    const seeBOld = await pageContainsKeyword(page, `/orders?q=${SOID_B}`, SOID_B)
    recordVerdict(verdicts, 'old_session_sees_nc01', seeAOld, `${SOID_A} visible=${seeAOld}`)
    recordVerdict(verdicts, 'old_session_not_sees_nc02', !seeBOld, `${SOID_B} visible=${seeBOld}`)

    // ── Step 2: DB 调店 → nc02 ──
    console.log('[链路36] Step 2: 调店 → store-nc02 (DB 直改)')
    relocateEmployeeToNc02()

    // DB 立即校验
    const dbStore = psql(`SELECT store_id FROM staff_wechat_users WHERE employee_id='${EID}'`)
    const dbScope = psql(`SELECT scope_id FROM permission_roles WHERE employee_id='${EID}' AND role='manager'`)
    recordVerdict(verdicts, 'db_store_updated', dbStore === TOPOLOGY.STORE_NC02, `dbStore=${dbStore}`)
    recordVerdict(verdicts, 'db_scope_updated', dbScope === TOPOLOGY.ORG_NC02, `dbScope=${dbScope}`)

    // ── Step 3: 同一 session 刷新 → 仍按旧 scope ──
    console.log('[链路36] Step 3: 刷新同一 session — 验证 scope snapshot')
    const seeASnap = await pageContainsKeyword(page, `/orders?q=${SOID_A}`, SOID_A)
    const seeBSnap = await pageContainsKeyword(page, `/orders?q=${SOID_B}`, SOID_B)
    // 因为 session 是登录时 snapshot 的，调店不影响当前 cookie，故仍按旧 scope
    recordVerdict(verdicts, 'snapshot_still_sees_nc01', seeASnap, `${SOID_A} visible=${seeASnap}（snapshot 期望可见）`)
    recordVerdict(verdicts, 'snapshot_still_not_sees_nc02', !seeBSnap, `${SOID_B} visible=${seeBSnap}（snapshot 期望不可见）`)

    // ── Step 4: logout + login → 新 scope 生效 ──
    console.log('[链路36] Step 4: logout + login')
    await logout(page)
    await login(page, PHONE)

    const seeANew = await pageContainsKeyword(page, `/orders?q=${SOID_A}`, SOID_A)
    const seeBNew = await pageContainsKeyword(page, `/orders?q=${SOID_B}`, SOID_B)
    recordVerdict(verdicts, 'new_session_sees_nc02', seeBNew, `${SOID_B} visible=${seeBNew}`)
    recordVerdict(verdicts, 'new_session_not_sees_nc01', !seeANew, `${SOID_A} visible=${seeANew}`)
  } finally {
    await ctx.close()
    cleanup()
  }

  const overall = summarize(36, verdicts, { employee_id: EID })
  writeContext('link36', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
