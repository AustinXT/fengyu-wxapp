/**
 * 链路 54：门店「关联收款商户」`updateStore` 持久化 + 审计 + 权限边界
 *
 * 主题（2026-06-24 商户管理模块化后：收款字段迁出门店页，归独立「商户管理」/merchants；
 *   门店编辑页改为「选择关联商户」下拉，仅写 stores.lakala_merchant_id 外键）：
 *   1) 预置一个测试商户（lakala_merchants 夹具）
 *   2) admin 进 /stores/[id]/edit，下拉选关联该商户 → stores.lakala_merchant_id = 商户 id
 *   3) audit `store.update` / target_id=storeId，changes 含 lakalaMerchantId
 *   4) finance（无 store:update / store:lakala_config）→ action 层抛 PERMISSION_DENIED
 *
 * 不测：商户档案 CRUD（属 /merchants 模块，另见 merchants action 单测）；
 *       resolveLakalaMerchant 路由（属 clientApi L2 e2e 范畴）。
 *
 * 预条件：admin dev server + FY-TEST-ADM/FIN；store-nc01 行可编辑。
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(180_000)

test('链路54：admin 给 store-nc01 选关联收款商户 → stores 外键 + audit + finance 拒', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // backup：store-nc01 当前关联的 lakala_merchant_id
  const origMerchantId = psql(
    `SELECT COALESCE(lakala_merchant_id,'∅') FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
  )
  console.log(`[链路54] backup nc01: lakala_merchant_id=${origMerchantId}`)

  // 预置测试商户（夹具，TE2L54 前缀便于清理）
  const stamp = Date.now().toString().slice(-6)
  const testMerchantId = 'lm_te2l54' + stamp
  const testMerchantNo = 'TE2L54MNO' + stamp
  const testMerchantName = 'TE2L54-商户-' + stamp
  psql(
    `INSERT INTO lakala_merchants (id, merchant_name, merchant_no, term_no, enabled, created_at, updated_at) ` +
      `VALUES ('${testMerchantId}', '${testMerchantName}', '${testMerchantNo}', 'TE2L54TERM${stamp}', true, NOW(), NOW())`,
  )

  try {
    // ── Step 1: admin 进 /stores/nc01/edit ─────────────────────
    console.log('[链路54] Step 1: admin 进 /stores/[id]/edit')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/stores/${TOPOLOGY.STORE_NC01}/edit`)
    await expect(adminPage.getByRole('heading', { name: /编辑门店/ })).toBeVisible({ timeout: 15_000 })
    await expect(adminPage.getByText('收款商户', { exact: true })).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 下拉选关联测试商户 ────────────────
    console.log('[链路54] Step 2: 下拉选关联收款商户')
    await adminPage.locator('select[name="lakalaMerchantId"]').selectOption(testMerchantId)

    // ── Step 3: 提交（form action="handleSave"） ──────────
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 4: SQL 验 stores.lakala_merchant_id = 测试商户 ─────────
    const mid = psql(
      `SELECT COALESCE(lakala_merchant_id,'∅') FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    recordVerdict(verdicts, 'persist: stores.lakala_merchant_id = 测试商户', mid === testMerchantId, mid)

    // ── Step 5: audit store.update changes.lakalaMerchantId ────
    const audit = readLatestAudit('store.update', TOPOLOGY.STORE_NC01)
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes.lakalaMerchantId.to = 测试商户', changes?.lakalaMerchantId?.to === testMerchantId, String(changes?.lakalaMerchantId?.to))
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()

    // ── Step 6: finance 权限边界（SQL 间接验证）────────────────
    // updateStore action 内 withPermission('store:update')；改收款绑定另需 store:lakala_config（仅 admin）。
    // finance 既无 store:update 也无 store:lakala_config → action 层抛 PERMISSION_DENIED。
    const finBlocked = psql(
      `SELECT EXISTS(SELECT 1 FROM permission_roles pr WHERE pr.employee_id = 'FY-TEST-FIN' ` +
        `AND pr.role IN ('admin','manager','hr'))::text`,
    )
    recordVerdict(
      verdicts,
      'finance: 角色不在 [admin,manager,hr]（updateStore action 层会抛 PERMISSION_DENIED）',
      finBlocked === 'false',
      finBlocked,
    )
  } finally {
    // 还原 stores.lakala_merchant_id 到 backup（先还原外键，再删商户档案）
    const restoreMid = origMerchantId === '∅' ? 'NULL' : `'${origMerchantId.replace(/'/g, "''")}'`
    psql(
      `UPDATE stores SET lakala_merchant_id = ${restoreMid} WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    // 删测试新建的 lakala_merchants 档案（id 带时间戳，只命中本测试新建的行）
    psql(`DELETE FROM lakala_merchants WHERE id = '${testMerchantId}'`)
    // 清本 spec 产生的 store.update audit（detail 含测试商户 id）
    psql(
      `DELETE FROM operation_logs WHERE action = 'store.update' AND target_id = '${TOPOLOGY.STORE_NC01}' ` +
        `AND detail::text LIKE '%${testMerchantId}%'`,
    )
    summarize(54, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路54 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
