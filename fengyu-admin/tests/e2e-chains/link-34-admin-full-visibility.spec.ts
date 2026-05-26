/**
 * 链路 34：总部 admin 全量可见基线
 *
 * 主题：FY-TEST-ADM（scope='总部'，scope_id=16d1184b46db099a）作为对照组，
 *       应见各门店（含跨市场）的员工记录。验证 scopeCondition() 对 admin 角色
 *       返回 undefined（无过滤），即没有 WHERE 条件附加。
 *
 * 历史背景：原版用 /orders 列表验证 admin 全量可见，但 admin 角色按设计
 *           不持业务数据权限（无 sale_order:list / customer:list 等，详见
 *           DEFAULT_PERMISSION_MATRIX）。改用 /employees 列表（admin 有
 *           employee:list 权限，scopeCondition 仍适用），同样能验证
 *           "admin scope → 全部 store_id 命中" 的核心不变量。
 *
 * 实现：
 *   1. seed 3 个临时员工（store-nc01 / store-nc02 / 跨市场 b79a82e33d6cf4f3）
 *   2. 以 FY-TEST-ADM 登录，访问 /employees 列表搜索
 *   3. 全部 3 个员工都应命中
 *   4. DB invariant：admin scope_id = 总部 16d1184b46db099a
 *
 * 关键引用：
 *   - lib/permissions.ts:265 scopeCondition() — admin 返回 undefined
 *   - lib/permissions.ts:189 expandScopeStoreIds() — 总部 scope 走 stores 全量返回
 *   - actions/employees.ts:144 getEmployeesPaginated + scopeCondition
 */

import { test, expect } from '@playwright/test'
import {
  TEST_PHONES, TOPOLOGY,
  psql, login, pageContainsKeyword, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN34'
const EID_A = `FY-TEST-${TAG}-A` // store-nc01
const EID_B = `FY-TEST-${TAG}-B` // store-nc02
const EID_C = `FY-TEST-${TAG}-C` // 跨市场 b79a82e33d6cf4f3
const NAME_A = `链34员工甲`
const NAME_B = `链34员工乙`
const NAME_C = `链34员工丙`

function insertStaff(employeeId: string, name: string, storeId: string, phone: string): void {
  psql(`
    INSERT INTO staff_wechat_users (
      employee_id, name, phone, store_id, gender, is_resigned, created_at, updated_at
    ) VALUES (
      '${employeeId}', '${name}', '${phone}', '${storeId}', '男', false, NOW(), NOW()
    )
    ON CONFLICT (employee_id) DO UPDATE SET
      name=EXCLUDED.name, store_id=EXCLUDED.store_id, is_resigned=false, updated_at=NOW()
  `)
}

function cleanupAll(): void {
  for (const id of [EID_A, EID_B, EID_C]) {
    try { psql(`DELETE FROM staff_wechat_users WHERE employee_id='${id}'`) } catch {/* noop */}
  }
}

test.setTimeout(120_000)

test('链路34：总部 admin 全量可见基线', async ({ browser }) => {
  const verdicts: Verdict[] = []
  cleanupAll()

  insertStaff(EID_A, NAME_A, TOPOLOGY.STORE_NC01, '13800134001')
  insertStaff(EID_B, NAME_B, TOPOLOGY.STORE_NC02, '13800134002')
  insertStaff(EID_C, NAME_C, TOPOLOGY.STORE_OTHER_MARKET, '13800134003')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    await login(page, TEST_PHONES.ADM)

    // 按 employee_id 精确搜索（getEmployeesPaginated 支持 employeeId ILIKE）
    for (const eid of [EID_A, EID_B, EID_C]) {
      const seen = await pageContainsKeyword(page, `/employees?q=${eid}`, eid)
      // suffix 取 EID 末段（A/B/C），保证 check 名稳定且不撞 0001/0002/0003
      recordVerdict(verdicts, `admin_sees_${eid.slice(-1)}`, seen, `${eid} visible=${seen}`)
    }

    // DB invariant: admin role 的 scope_id = 总部 + scope type='总部'
    const adminScopeRow = psql(`
      SELECT pr.scope_id || ':' || o.type
      FROM permission_roles pr JOIN org_nodes o ON pr.scope_id=o.id
      WHERE pr.employee_id='FY-TEST-ADM' AND pr.role='admin'
    `).trim()
    recordVerdict(verdicts, 'admin_scope_is_headquarters', adminScopeRow === `${TOPOLOGY.HQ_ORG_ID}:总部`, `actual=${adminScopeRow}`)
  } finally {
    await ctx.close()
    cleanupAll()
  }

  const overall = summarize(34, verdicts)
  writeContext('link34', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
