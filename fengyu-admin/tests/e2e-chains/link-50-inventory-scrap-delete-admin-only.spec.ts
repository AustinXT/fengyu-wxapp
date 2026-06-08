/**
 * 链路 50：库存报损单 CRUD + `inventory:delete` 权限分级（仅 admin）
 *
 * 主题：
 *   1) admin 创建报损单 → scrap_reason 必填强制（items[].scrapReason，schema 层 + action 层）
 *   2) 头尾一致性（total_quantity = SUM(items.quantity)、items 行数对齐）
 *   3) admin delete 成功；级联清 items + 审计
 *   4) **manager 看不到删除按钮**（canDelete=false）；finance/product 同
 *
 * UI 边界：admin v1 详情页只读 + 列表行删除按钮受 canDelete 控制；
 *         不存在"非授权角色绕 UI 调删除"的真实业务路径，所以"权限拒绝"在 e2e 层
 *         只能验"UI 按钮不渲染"（不是 server-side throw PERMISSION_DENIED）。
 *         action 层的 throw 已由 inventory.test.ts 单元测覆盖。
 *
 * 复用：scope-helpers + inventory helper
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import {
  cleanupInventoryByPrefix,
  cleanupAuditByPrefix,
  getInventoryHeader,
  readLatestAudit,
} from './_helpers/inventory'

const REMARK_TAG = 'TE2L50-' + Date.now()

test.setTimeout(180_000)

test('链路50：报损单 admin 创建 → 头尾一致性 → 权限分级 → admin 删除', async ({ browser }) => {
  const verdicts: Verdict[] = []
  let createdId = ''

  try {
    // ── Step 1: admin 登录 → 创建报损单（2 行明细，含 scrapReason）─────
    console.log('[链路50] Step 1: admin 创建报损单')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/inventory/scrap`)
    await expect(adminPage.getByRole('heading', { name: /报损出库/ })).toBeVisible({ timeout: 15_000 })
    const winStart = psql(`SELECT NOW()::text`)

    await adminPage.getByRole('button', { name: /新\s*建/ }).click()
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeVisible({ timeout: 5_000 })

    // 门店 select（scrap 无 counterpartStoreId 也无 docSubtype，只有 1 个 select 是门店）
    await adminPage.locator('dialog select').first().selectOption(TOPOLOGY.STORE_NC01)
    await adminPage.locator('label:has-text("备注") input').fill(REMARK_TAG)

    // 明细 row 1
    await adminPage.locator('input[placeholder="编号"]').first().fill('TE2L50-SKU-A')
    await adminPage.locator('input[placeholder="产品名"]').first().fill('报损测试品 A')
    await adminPage.locator('input[placeholder="数量"]').first().fill('5')
    // scrap 默认 '店用'，不动

    // 加 row 2：原因选"过期"
    await adminPage.getByRole('button', { name: /加一行/ }).click()
    await adminPage.locator('input[placeholder="编号"]').nth(1).fill('TE2L50-SKU-B')
    await adminPage.locator('input[placeholder="产品名"]').nth(1).fill('报损测试品 B')
    await adminPage.locator('input[placeholder="数量"]').nth(1).fill('3')
    // row 2 的 scrapReason select（每行 1 个 select，row 1 是第 2 个 select 总体，row 2 是第 3 个）
    const dialogSelects = adminPage.locator('dialog select')
    await dialogSelects.nth(2).selectOption('过期') // index 0=门店, index 1=row1.reason, index 2=row2.reason

    await adminPage.getByRole('button', { name: /^提\s*交$/ }).click()
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeHidden({ timeout: 15_000 })

    createdId = psql(
      `SELECT id FROM inventory_scrap_orders ` +
        `WHERE remark = '${REMARK_TAG}' AND created_at >= '${winStart}' ` +
        `ORDER BY created_at DESC LIMIT 1`,
    )
    recordVerdict(verdicts, 'create: 报损单落库', Boolean(createdId), createdId || '(empty)')
    if (!createdId) throw new Error('FATAL: 报损单创建失败（tag: ' + REMARK_TAG + '）')

    // ── Step 2: 头尾一致性 + scrapReason 落库 ──────────────────────
    const header = getInventoryHeader('scrap', createdId)
    recordVerdict(verdicts, 'head: totalQuantity=8 (5+3)', header?.totalQuantity === 8, String(header?.totalQuantity))
    recordVerdict(verdicts, 'head: item_count=2', header?.itemRowCount === 2, String(header?.itemRowCount))
    recordVerdict(
      verdicts,
      'head: SUM(items.quantity) == header.totalQuantity',
      header?.totalQuantity === header?.itemQuantitySum,
      `${header?.totalQuantity} vs ${header?.itemQuantitySum}`,
    )
    // 验 items[].scrap_reason 都非空（NOT NULL 约束 + items 各自原因）
    const reasons = psql(
      `SELECT array_agg(scrap_reason ORDER BY id) FROM inventory_scrap_order_items WHERE order_id = '${createdId}'`,
    )
    recordVerdict(verdicts, 'items: scrap_reason 都非空', !reasons.includes('NULL') && reasons.length > 0, reasons)

    // 审计 create
    const createAudit = readLatestAudit('inventory.scrap.create', createdId)
    recordVerdict(verdicts, 'audit.create: 落库存在', Boolean(createAudit), createAudit ? 'present' : 'missing')
    recordVerdict(
      verdicts,
      'audit.create: detail.itemCount=2',
      createAudit?.detail?.itemCount === 2,
      String(createAudit?.detail?.itemCount),
    )
    recordVerdict(
      verdicts,
      'audit.create: detail.storeId=nc01',
      createAudit?.detail?.storeId === TOPOLOGY.STORE_NC01,
      String(createAudit?.detail?.storeId),
    )

    await adminCtx.close()

    // ── Step 3: manager 登录 → list 命中行 → 验"删除按钮不渲染" ─────
    console.log('[链路50] Step 3: nc01 MGR 进列表 → canDelete=false (无删除按钮)')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    await login(mgrPage, TEST_PHONES.MGR)
    await mgrPage.goto(`${BASE}/inventory/scrap?q=${encodeURIComponent(createdId)}`)
    await mgrPage.waitForLoadState('networkidle')
    await mgrPage.waitForTimeout(500)
    await expect(mgrPage.locator('main').getByText(createdId)).toBeVisible({ timeout: 8_000 })
    const mgrRow = mgrPage.locator('tr', { hasText: createdId }).first()
    const mgrRowButtons = await mgrRow.getByRole('button').count()
    // manager 应该只看到 1 个按钮（"详情"），没有"删除"
    recordVerdict(verdicts, 'mgr 列表: 行内按钮数 = 1 (仅 详情, 无 删除)', mgrRowButtons === 1, String(mgrRowButtons))
    await mgrCtx.close()

    // ── Step 4: finance 登录 → list 命中行 → 验"无删除按钮" ──────
    console.log('[链路50] Step 4: finance 列表 → canDelete=false')
    const finCtx = await browser.newContext()
    const finPage = await finCtx.newPage()
    await login(finPage, TEST_PHONES.FIN)
    await finPage.goto(`${BASE}/inventory/scrap?q=${encodeURIComponent(createdId)}`)
    await finPage.waitForLoadState('networkidle')
    await finPage.waitForTimeout(500)
    const finMain = (await finPage.locator('main').innerText().catch(() => '')) || ''
    if (finMain.includes(createdId)) {
      const finRow = finPage.locator('tr', { hasText: createdId }).first()
      const finRowButtons = await finRow.getByRole('button').count()
      recordVerdict(verdicts, 'finance 列表: 行内按钮数 = 1 (仅 详情)', finRowButtons === 1, String(finRowButtons))
    } else {
      // finance 是 HQ scope，应该能看到所有店；若没看到说明 scope 异常，但本 spec 焦点不在 scope
      recordVerdict(verdicts, 'finance 列表: 命中（scope=HQ）', false, 'not in list')
    }
    await finCtx.close()

    // ── Step 5: admin 回来删除 ─────────────────────────────────────
    console.log('[链路50] Step 5: admin 删除报损单 → 级联 + audit')
    const admin2Ctx = await browser.newContext()
    const admin2Page = await admin2Ctx.newPage()
    await login(admin2Page, TEST_PHONES.ADM)
    await admin2Page.goto(`${BASE}/inventory/scrap?q=${encodeURIComponent(createdId)}`)
    await admin2Page.waitForLoadState('networkidle')
    await admin2Page.waitForTimeout(500)
    admin2Page.once('dialog', (d) => d.accept())
    const adminRow = admin2Page.locator('tr', { hasText: createdId }).first()
    // admin 应该 2 个按钮（详情 + 删除）
    const adminRowButtons = await adminRow.getByRole('button').count()
    recordVerdict(verdicts, 'admin 列表: 行内按钮数 = 2 (详情+删除)', adminRowButtons === 2, String(adminRowButtons))
    await adminRow.getByRole('button').last().click()
    await admin2Page.waitForTimeout(2000) // 不依赖 UI 列表"消失"，走 SQL 验

    const headerAfter = getInventoryHeader('scrap', createdId)
    recordVerdict(verdicts, 'delete: 主表行已清', headerAfter === null, headerAfter === null ? 'null' : 'present')
    const itemsAfter = psql(`SELECT COUNT(*) FROM inventory_scrap_order_items WHERE order_id = '${createdId}'`)
    recordVerdict(verdicts, 'delete: items 级联清空', itemsAfter === '0', itemsAfter)
    const deleteAudit = readLatestAudit('inventory.scrap.delete', createdId)
    recordVerdict(verdicts, 'audit.delete: 落库存在', Boolean(deleteAudit), deleteAudit ? 'present' : 'missing')

    await admin2Ctx.close()
  } finally {
    if (createdId) {
      cleanupInventoryByPrefix(createdId)
      cleanupAuditByPrefix(createdId)
    }
    psql(`DELETE FROM inventory_scrap_orders WHERE remark = '${REMARK_TAG}'`)
    summarize(50, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路50 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
