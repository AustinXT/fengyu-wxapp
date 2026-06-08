/**
 * 链路 54：门店拉卡拉 store-level 字段 `updateStore` 持久化 + 审计 + 权限边界
 *
 * 主题：
 *   1) admin 进 /stores/[id]/edit 改 store-level lakala 字段（lakala_term_no / lakala_enabled）
 *      → stores 行持久化
 *   2) audit `store.update` / target_id=storeId
 *      detail = { _v:3, _t:'update', changes:{ lakalaTermNo:{from,to}, lakalaEnabled:{from,to} } }
 *   3) finance（无 store:update 权限）action 层会拒
 *
 * 字段范围说明（2026-05-30 修订）：
 *   - lakala_merchant_no 是 link 商户后从 lakala_merchants 派生的快照，admin UI 不再手填（disabled），不在本 spec 覆盖
 *   - lakala_sub_appid 列已删（fix/001）；sub_appid 由云函数 env 全局供给
 *   - lakala_merchant_id 由 link/unlink 专用 action 维护，覆盖在 smoke-lakala-onboarding STEP9/10
 *   - 本 spec 仅守护 admin UI 真正可编辑的两个 store-level 字段：term_no + enabled
 *
 * 不测：resolveLakalaMerchant 路由（属 clientApi L2 e2e 范畴）
 *
 * 预条件：admin dev server + FY-TEST-ADM/FIN；store-nc01 行可编辑（updatedAt 取自数据库）
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(180_000)

test('链路54：admin 改 store-nc01 lakala term_no/enabled → stores 持久化 + audit changes + finance 拒', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // backup 原值：store-nc01 当前两个可编辑字段（psql 直读）
  const before = psql(
    `SELECT COALESCE(lakala_term_no, '∅') || '|' || lakala_enabled::text ` +
      `FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
  )
  const [origTerm, origEnabledStr] = before.split('|')
  const origEnabled = origEnabledStr === 't'
  console.log(`[链路54] backup nc01 lakala: term=${origTerm} enabled=${origEnabled}`)

  // 测试目标值（与 backup 必有差异）
  const newTerm = 'TE2L54-TERM-' + Date.now().toString().slice(-6)
  const newEnabled = !origEnabled

  try {
    // ── Step 1: admin 进 /stores/nc01/edit ─────────────────────
    console.log('[链路54] Step 1: admin 进 /stores/[id]/edit')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/stores/${TOPOLOGY.STORE_NC01}/edit`)
    await expect(adminPage.getByRole('heading', { name: /编辑门店/ })).toBeVisible({ timeout: 15_000 })
    await expect(adminPage.getByText(/拉卡拉聚合支付配置/)).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 改 term_no + enabled ────────────────────────
    console.log('[链路54] Step 2: 改 lakala term_no + enabled')
    await adminPage.locator('input[name="lakalaTermNo"]').fill(newTerm)
    // checkbox 切换：若当前与 newEnabled 不同，click 一次
    const checkbox = adminPage.locator('input[type="checkbox"]').first()
    const currentChecked = await checkbox.isChecked()
    if (currentChecked !== newEnabled) await checkbox.click()

    // ── Step 3: 提交（form action="handleSave"） ──────────
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 4: SQL 验 stores 行 ────────────────────────
    const after = psql(
      `SELECT COALESCE(lakala_term_no, '∅') || '|' || lakala_enabled::text ` +
        `FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    const [t2, e2] = after.split('|')
    recordVerdict(verdicts, 'persist: lakala_term_no = newTerm', t2 === newTerm, t2)
    // psql 返回 bool::text 是 'true'/'false'，不是 't'/'f'
    recordVerdict(
      verdicts,
      `persist: lakala_enabled = ${newEnabled}`,
      e2 === String(newEnabled),
      e2,
    )

    // ── Step 5: audit store.update changes 含两字段 ────
    const audit = readLatestAudit('store.update', TOPOLOGY.STORE_NC01)
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._v=3', audit?.detail?._v === 3, String(audit?.detail?._v))
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes.lakalaTermNo 含', Boolean(changes?.lakalaTermNo), changes?.lakalaTermNo ? 'yes' : 'no')
    recordVerdict(verdicts, 'audit: changes.lakalaEnabled 含', Boolean(changes?.lakalaEnabled), changes?.lakalaEnabled ? 'yes' : 'no')
    recordVerdict(
      verdicts,
      'audit: changes.lakalaTermNo.to = newTerm',
      changes?.lakalaTermNo?.to === newTerm,
      String(changes?.lakalaTermNo?.to),
    )
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()

    // ── Step 6: finance 权限边界改由 SQL 直查模拟 ───────────────
    // 注：updateStore action 内 withPermission('store:update') 守护，finance 无此权限会抛 PERMISSION_DENIED
    // 但 admin page.tsx 只调 getStore（store:list 权限），finance 仍能渲染编辑页 —— UI 层拒不了
    // 真正的"action 层 finance 拒"属 unit/integration 测，本 spec 不在此重复
    // 改为 SQL 验证 permission_roles 中 finance 不持 store:update（间接证明 action 层会拒）
    const finStoreUpdate = psql(
      `SELECT EXISTS(SELECT 1 FROM permission_roles pr WHERE pr.employee_id = 'FY-TEST-FIN' ` +
        `AND pr.role IN ('admin','manager','hr'))::text`,
    )
    recordVerdict(
      verdicts,
      'finance: 角色不在 [admin,manager,hr]（updateStore action 层会抛 PERMISSION_DENIED）',
      finStoreUpdate === 'false',
      finStoreUpdate,
    )
  } finally {
    // 还原 stores 两字段到 backup 值
    const restoreTerm = origTerm === '∅' ? 'NULL' : `'${origTerm.replace(/'/g, "''")}'`
    psql(
      `UPDATE stores SET lakala_term_no = ${restoreTerm}, lakala_enabled = ${origEnabled} ` +
        `WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    // 清掉本 spec 产生的 store.update audit（避免堆积污染）
    psql(
      `DELETE FROM operation_logs WHERE action = 'store.update' AND target_id = '${TOPOLOGY.STORE_NC01}' ` +
        `AND detail::text LIKE '%TE2L54-%'`,
    )
    summarize(54, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路54 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
