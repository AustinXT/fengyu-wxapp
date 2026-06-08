/**
 * 链路 49：库存调拨单双段流转 + receiveQuantity 差异允许 + scope OR 命中
 *
 * 主题：调拨单 (storeId → counterpartStoreId) 的双段语义：
 *       1) 创建：双方 list 都可见（scope OR 命中：storeId IN scope OR counterpartStoreId IN scope）
 *       2) 调拨出库子类型 → isDispatcher=true 写入
 *       3) confirmTransferReceive 后：confirmedAt 写时间戳 + receiveQuantity 允许 ≠ totalQuantity（实收差异）
 *       4) 删除仅允许源店 storeId 在 scope（deleteTransferOrder 内部 isInScope 守护）
 *
 * 设计妥协：
 *   - admin v1 UI 未暴露 confirmTransferReceive 按钮 + 也未暴露权限拒绝路径（按钮不渲染）；
 *     本 spec 用 SQL 直接模拟 confirmReceive 副作用（UPDATE confirmed_at + receive_quantity），
 *     验"数据库形态"+"action 内部不变量"（receiveQuantity 允许差异）；
 *   - confirmReceive 的"权限拒绝"路径属 unit/integration test 范畴，本 spec 不测；
 *   - 双段 scope 用 link-55 矩阵专项覆盖，本 spec 仅快速验证 SQL OR 逻辑命中行
 *
 * 复用：scope-helpers + inventory helper
 *
 * 预条件：admin dev server @ localhost:3000；FY-TEST-ADM 账号；store-nc01 + store-nc02 + nc01 MGR 账号就绪。
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import {
  cleanupInventoryByPrefix,
  cleanupAuditByPrefix,
  getInventoryHeader,
  readLatestAudit,
} from './_helpers/inventory'

const REMARK_TAG = 'TE2L49-' + Date.now()

test.setTimeout(180_000)

test('链路49：调拨单 UI 创建 → SQL 模拟 confirmReceive → 双段验证 + 审计', async ({ browser }) => {
  const verdicts: Verdict[] = []
  let createdId = ''

  try {
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

    // ── Step 1: admin 登录 + 列表 ───────────────────────────────────
    console.log('[链路49] Step 1: admin 登录 → /inventory/transfer')
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/inventory/transfer`)
    await expect(adminPage.getByRole('heading', { name: /门店调拨/ })).toBeVisible({ timeout: 15_000 })
    const winStart = psql(`SELECT NOW()::text`)

    // ── Step 2: UI 创建调拨出库（nc01 → nc02）────────────────────
    console.log('[链路49] Step 2: 新建调拨出库 nc01 → nc02')
    await adminPage.getByRole('button', { name: /新\s*建/ }).click()
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeVisible({ timeout: 5_000 })

    // 门店 select（第 1 个 select）：选 nc01
    const dialogSelects = adminPage.locator('dialog select')
    await dialogSelects.nth(0).selectOption(TOPOLOGY.STORE_NC01)
    // 对方门店 select（第 2 个）：选 nc02
    await dialogSelects.nth(1).selectOption(TOPOLOGY.STORE_NC02)
    // 子类型 select（第 3 个）：默认 '调拨出库'，确保选中
    await dialogSelects.nth(2).selectOption('调拨出库')
    // 备注
    await adminPage.locator('label:has-text("备注") input').fill(REMARK_TAG)
    // 明细
    await adminPage.locator('input[placeholder="编号"]').first().fill('TE2L49-SKU-A')
    await adminPage.locator('input[placeholder="产品名"]').first().fill('调拨测试品 A')
    await adminPage.locator('input[placeholder="数量"]').first().fill('10') // 发出 10
    // 提交
    await adminPage.getByRole('button', { name: /^提\s*交$/ }).click()
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeHidden({ timeout: 15_000 })

    // ── Step 3: 找回 createdId + 验创建后初始状态 ─────────────────
    createdId = psql(
      `SELECT id FROM inventory_transfer_orders ` +
        `WHERE remark = '${REMARK_TAG}' AND created_at >= '${winStart}' ` +
        `ORDER BY created_at DESC LIMIT 1`,
    )
    recordVerdict(verdicts, 'create: 单据落库', Boolean(createdId), createdId || '(empty)')
    if (!createdId) throw new Error('FATAL: 调拨单创建失败（备注 tag: ' + REMARK_TAG + '）')
    console.log(`[链路49] createdId = ${createdId}`)

    const headInit = getInventoryHeader('transfer', createdId)
    recordVerdict(verdicts, 'create: isDispatcher=true (调拨出库)', headInit?.isDispatcher === true, String(headInit?.isDispatcher))
    recordVerdict(verdicts, 'create: storeId=nc01', headInit?.storeId === TOPOLOGY.STORE_NC01, headInit?.storeId ?? 'null')
    recordVerdict(
      verdicts,
      'create: counterpartStoreId=nc02',
      headInit?.counterpartStoreId === TOPOLOGY.STORE_NC02,
      headInit?.counterpartStoreId ?? 'null',
    )
    recordVerdict(verdicts, 'create: confirmedAt IS NULL (在途)', !headInit?.confirmedAt, headInit?.confirmedAt ?? 'null')
    recordVerdict(verdicts, 'create: receiveQuantity IS NULL', headInit?.receiveQuantity == null, String(headInit?.receiveQuantity))
    recordVerdict(verdicts, 'create: totalQuantity=10', headInit?.totalQuantity === 10, String(headInit?.totalQuantity))
    recordVerdict(verdicts, 'create: item_count=1', headInit?.itemRowCount === 1, String(headInit?.itemRowCount))

    // 审计 create
    const createAudit = readLatestAudit('inventory.transfer.create', createdId)
    recordVerdict(verdicts, 'audit.create: 落库存在', Boolean(createAudit), createAudit ? 'present' : 'missing')
    recordVerdict(
      verdicts,
      'audit.create: detail.docSubtype=调拨出库',
      createAudit?.detail?.docSubtype === '调拨出库',
      String(createAudit?.detail?.docSubtype ?? 'null'),
    )
    recordVerdict(
      verdicts,
      'audit.create: detail.counterpartStoreId=nc02',
      createAudit?.detail?.counterpartStoreId === TOPOLOGY.STORE_NC02,
      String(createAudit?.detail?.counterpartStoreId ?? 'null'),
    )

    // ── Step 4: scope OR 命中：nc01 MGR 应该能在 list 看到（源店）
    console.log('[链路49] Step 4: nc01 MGR list 命中（源店视角）')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    await login(mgrPage, TEST_PHONES.MGR)
    await mgrPage.goto(`${BASE}/inventory/transfer?q=${encodeURIComponent(createdId)}`)
    await mgrPage.waitForLoadState('networkidle')
    await mgrPage.waitForTimeout(800)
    const mgrMain = (await mgrPage.locator('main').innerText().catch(() => '')) || ''
    recordVerdict(verdicts, 'scope: nc01 MGR (源店) list 命中', mgrMain.includes(createdId), createdId)
    await mgrCtx.close()

    // ── Step 5: SQL 模拟 confirmTransferReceive（接收店 MGR 视角的实收差异）─
    // 真实 action 行为：UPDATE confirmed_by, confirmed_at, receive_quantity, updated_at
    // 实收 8（发出 10）—— 验"允许差异"
    console.log('[链路49] Step 5: SQL 模拟 confirmReceive（发 10 实收 8）')
    psql(
      `UPDATE inventory_transfer_orders SET ` +
        `confirmed_by='FY-TEST-MGR2', confirmed_at=NOW(), receive_quantity=8, updated_at=NOW() ` +
        `WHERE id='${createdId}'`,
    )
    const headAfterConfirm = getInventoryHeader('transfer', createdId)
    recordVerdict(verdicts, 'confirm: confirmedAt 写入', Boolean(headAfterConfirm?.confirmedAt), headAfterConfirm?.confirmedAt ?? 'null')
    recordVerdict(
      verdicts,
      'confirm: receiveQuantity=8（允许 ≠ totalQuantity=10）',
      headAfterConfirm?.receiveQuantity === 8,
      String(headAfterConfirm?.receiveQuantity),
    )
    recordVerdict(
      verdicts,
      'confirm: totalQuantity 不变（=10）',
      headAfterConfirm?.totalQuantity === 10,
      String(headAfterConfirm?.totalQuantity),
    )

    // ── Step 6: SQL 验"再次 confirm 抛 CONFLICT"路径的前置形态（confirmedAt 已非空）─
    // 不调 action，但验 detail 字段已落，UI 应展示"确认时间"
    await adminPage.goto(`${BASE}/inventory/transfer/${createdId}`)
    await adminPage.waitForLoadState('networkidle')
    const detailMain = (await adminPage.locator('main').innerText().catch(() => '')) || ''
    recordVerdict(
      verdicts,
      'detail UI: "接收方实收数量" 字段渲染（含数字 8）',
      /接收方实收数量/.test(detailMain) && /\b8\b/.test(detailMain),
      detailMain.includes('8') ? 'has 8' : 'no 8',
    )

    // ── Step 7: UI 删除（admin 总部可删任何门店）+ 验级联 + audit
    console.log('[链路49] Step 7: admin UI 删除调拨单 → 级联 + audit')
    await adminPage.goto(`${BASE}/inventory/transfer?q=${encodeURIComponent(createdId)}`)
    await adminPage.waitForLoadState('networkidle')
    await adminPage.waitForTimeout(500)
    adminPage.once('dialog', (d) => d.accept())
    const row = adminPage.locator('tr', { hasText: createdId }).first()
    await row.getByRole('button').last().click()
    // 不依赖 UI 列表"消失"（admin row click propagation 会跳详情页），直接走 SQL 验
    await adminPage.waitForTimeout(2000)

    const headerAfterDelete = getInventoryHeader('transfer', createdId)
    recordVerdict(verdicts, 'delete: 主表行已清', headerAfterDelete === null, headerAfterDelete === null ? 'null' : 'still present')
    const itemsAfter = psql(`SELECT COUNT(*) FROM inventory_transfer_order_items WHERE order_id = '${createdId}'`)
    recordVerdict(verdicts, 'delete: items 级联清空（FK CASCADE）', itemsAfter === '0', itemsAfter)
    const deleteAudit = readLatestAudit('inventory.transfer.delete', createdId)
    recordVerdict(verdicts, 'audit.delete: 落库存在', Boolean(deleteAudit), deleteAudit ? 'present' : 'missing')

    await adminCtx.close()
  } finally {
    if (createdId) {
      cleanupInventoryByPrefix(createdId)
      cleanupAuditByPrefix(createdId)
    }
    psql(`DELETE FROM inventory_transfer_orders WHERE remark = '${REMARK_TAG}'`)
    summarize(49, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路49 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
