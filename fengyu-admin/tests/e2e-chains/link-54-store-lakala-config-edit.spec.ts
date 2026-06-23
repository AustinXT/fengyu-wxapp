/**
 * 链路 54：门店拉卡拉收款配置 `updateStore` 持久化 + 建档 + 审计 + 权限边界
 *
 * 主题（2026-06-24 改造后：进件模块下线，收款配置改门店编辑页手填，收款字段收敛到 lakala_merchants）：
 *   1) admin 进 /stores/[id]/edit 填收款配置（商户名 + 商户号 + 终端号 + 启用）
 *      → stores 仅持 lakala_merchant_id 外键（收款字段不再留 stores 快照列）
 *      → lakala_merchants 档案 upsert（merchant_name + merchant_no + term_no + enabled）
 *   2) audit `store.update` / target_id=storeId，changes 含 lakalaMerchantNo / lakalaTermNo（提交 DTO 字段）
 *   3) finance（无 store:update 权限）action 层会拒；收款配置另需 store:lakala_config（仅 admin）
 *
 * 字段范围说明：
 *   - 收款配置是一组（商户名+号+终端号+启用），统一由 stores.ts applyLakalaPaymentConfig 写 lakala_merchants
 *   - 商户号为空时停用关联档案（enabled=false），故本 spec 必须填完整商户号
 *   - 商户名/号/终端号/启用全落 lakala_merchants（该店经 lakala_merchant_id 关联的档案）
 *
 * 不测：resolveLakalaMerchant 路由（属 clientApi L2 e2e 范畴）
 *
 * 预条件：admin dev server + FY-TEST-ADM/FIN；store-nc01 行可编辑，且初态【无】拉卡拉档案
 *   （若 backup 显示 merchant_id 非空，说明夹具被污染，restore 的删档案逻辑会误删，需先清夹具）
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(180_000)

test('链路54：admin 填 store-nc01 收款配置 → stores 快照 + lakala_merchants 档案 + audit + finance 拒', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // backup：store-nc01 当前关联的 lakala_merchant_id（收款字段已收敛到 lakala_merchants，stores 仅留外键）
  const origMerchantId = psql(
    `SELECT COALESCE(lakala_merchant_id,'∅') FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
  )
  console.log(`[链路54] backup nc01: lakala_merchant_id=${origMerchantId}`)

  // 测试目标值（带 TE2L54 前缀便于清理）
  const stamp = Date.now().toString().slice(-6)
  const newMerchantName = 'TE2L54-商户-' + stamp
  const newMerchantNo = 'TE2L54MNO' + stamp
  const newTerm = 'TE2L54TERM' + stamp

  try {
    // ── Step 1: admin 进 /stores/nc01/edit ─────────────────────
    console.log('[链路54] Step 1: admin 进 /stores/[id]/edit')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/stores/${TOPOLOGY.STORE_NC01}/edit`)
    await expect(adminPage.getByRole('heading', { name: /编辑门店/ })).toBeVisible({ timeout: 15_000 })
    await expect(adminPage.getByText(/拉卡拉收款配置/)).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 填商户名 + 商户号 + 终端号 + 启用 ────────────────
    console.log('[链路54] Step 2: 填收款配置（商户名/号/终端号/启用）')
    await adminPage.locator('input[name="lakalaMerchantName"]').fill(newMerchantName)
    await adminPage.locator('input[name="lakalaMerchantNo"]').fill(newMerchantNo)
    await adminPage.locator('input[name="lakalaTermNo"]').fill(newTerm)
    const checkbox = adminPage.locator('input[type="checkbox"]').first()
    if (!(await checkbox.isChecked())) await checkbox.click()

    // ── Step 3: 提交（form action="handleSave"） ──────────
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 4: SQL 验 stores 关联外键（收款字段已无 stores 快照列）─────────
    const hasMid = psql(
      `SELECT (lakala_merchant_id IS NOT NULL)::text FROM stores WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    recordVerdict(verdicts, 'persist: stores.lakala_merchant_id 非空（已关联档案）', hasMid === 'true', hasMid)

    // ── Step 5: SQL 验 lakala_merchants 档案（upsert：名/号/终端号/启用）───
    const merch = psql(
      `SELECT merchant_name||'|'||COALESCE(merchant_no,'∅')||'|'||COALESCE(term_no,'∅')||'|'||enabled::text ` +
        `FROM lakala_merchants WHERE merchant_no = '${newMerchantNo}'`,
    )
    const [mName, mMerchNo, mTerm, mEnabled] = merch.split('|')
    recordVerdict(verdicts, '档案: merchant_name = newMerchantName', mName === newMerchantName, mName)
    recordVerdict(verdicts, '档案: merchant_no = newMerchantNo', mMerchNo === newMerchantNo, mMerchNo)
    recordVerdict(verdicts, '档案: term_no = newTerm', mTerm === newTerm, mTerm)
    recordVerdict(verdicts, '档案: enabled = true', mEnabled === 'true' || mEnabled === 't', mEnabled)

    // ── Step 6: audit store.update changes 含收款字段 ────
    const audit = readLatestAudit('store.update', TOPOLOGY.STORE_NC01)
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes.lakalaMerchantNo.to = newMerchantNo', changes?.lakalaMerchantNo?.to === newMerchantNo, String(changes?.lakalaMerchantNo?.to))
    recordVerdict(verdicts, 'audit: changes.lakalaTermNo.to = newTerm', changes?.lakalaTermNo?.to === newTerm, String(changes?.lakalaTermNo?.to))
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()

    // ── Step 7: finance 权限边界（SQL 间接验证）────────────────
    // updateStore action 内 withPermission('store:update')；收款配置另需 store:lakala_config（仅 admin）。
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
    // 还原 stores.lakala_merchant_id 到 backup 值（收款字段已无 stores 快照列，仅外键需还原）
    const restoreMid = origMerchantId === '∅' ? 'NULL' : `'${origMerchantId.replace(/'/g, "''")}'`
    psql(
      `UPDATE stores SET lakala_merchant_id = ${restoreMid} WHERE store_id = '${TOPOLOGY.STORE_NC01}'`,
    )
    // 删测试新建的 lakala_merchants 档案（merchant_no 唯一带时间戳，只命中本测试新建的行）
    psql(`DELETE FROM lakala_merchants WHERE merchant_no = '${newMerchantNo}'`)
    // 清本 spec 产生的 store.update audit
    psql(
      `DELETE FROM operation_logs WHERE action = 'store.update' AND target_id = '${TOPOLOGY.STORE_NC01}' ` +
        `AND detail::text LIKE '%TE2L54%'`,
    )
    summarize(54, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路54 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
