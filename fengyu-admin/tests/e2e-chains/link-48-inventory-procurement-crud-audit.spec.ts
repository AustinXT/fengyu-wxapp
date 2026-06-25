/**
 * 链路 48：库存采购单 CRUD + 头尾一致性 + 审计（admin v1 UI 边界内）
 *
 * 主题：admin 后台通过 UI 触发 createProcurementOrder / deleteProcurementOrder
 *       全链路验证：
 *         1) 单据头 total_quantity = SUM(items.quantity)
 *         2) item_count = items 行数
 *         3) FK ON DELETE CASCADE 级联清空 items
 *         4) operation_logs 写入 'inventory.procurement.create' 与 'inventory.procurement.delete'
 *            detail 为裸 logOperation 形态：
 *              create: { docSubtype, storeId, itemCount }
 *              delete: {}
 *
 * 设计妥协：
 *   - admin v1 暂未暴露 updateProcurementOrder UI（详情页只读），本 spec 不测 update
 *   - scope 隔离不在本 spec 测，集中到 link-55
 *   - 由 admin（FY-TEST-ADM）触发，单店 store-nc01；不试探非授权角色（属 link-55 / link-50 范畴）
 *
 * 复用：scope-helpers.login/psql + _helpers/inventory.{readLatestAudit,cleanupInventoryByPrefix,cleanupAuditByPrefix,getInventoryHeader}
 *
 * 预条件：admin dev server @ localhost:3000；5434/fengyu_e2e 可达；FY-TEST-ADM 账号就绪（fengyu2026）。
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, TOPOLOGY, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import {
  cleanupInventoryByPrefix,
  cleanupAuditByPrefix,
  getInventoryHeader,
  readLatestAudit,
} from './_helpers/inventory'

const NAMESPACE = 'PROC-'  // admin 用 generateInventoryDocNo 生成的真实 id 形如 'PROC-202605-0001'，
                            // 无法预测，故按"本 spec 启动时间"窗口过滤；此处仅作 fallback 前缀
const REMARK_TAG = 'TE2L48-AUDIT-' + Date.now()

test.setTimeout(180_000)

test('链路48：采购单 UI 创建 → 头尾一致性 → UI 删除 → 级联 + 审计', async ({ browser }) => {
  const verdicts: Verdict[] = []
  let createdId = ''

  try {
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

    // ── Step 1: admin 登录 + 进采购单列表 ────────────────────────────
    console.log('[链路48] Step 1: admin 登录 → /inventory/procurement')
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/inventory/procurement`)
    await expect(adminPage.getByRole('heading', { name: /采购入库/ })).toBeVisible({ timeout: 15_000 })

    // 记录窗口起点：本 spec 创建的单据 createdAt 必 >= 此时间
    const winStart = psql(`SELECT NOW()::text`)

    // ── Step 2: UI 打开"新建"对话框 + 填表 ─────────────────────────
    console.log('[链路48] Step 2: 打开新建对话框 → 提交')
    await adminPage.getByRole('button', { name: /新\s*建/ }).click()
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeVisible({ timeout: 5_000 })

    // 主表：门店选 nc01（dialog 内的 select，不是页面顶部筛选器）；子类型默认 '院报货'；备注打 tag
    await adminPage.locator('dialog select').first().selectOption(TOPOLOGY.STORE_NC01)
    await adminPage.locator('dialog label:has-text("备注") input').fill(REMARK_TAG)

    // 明细第 1 行：产品编号 / 产品名 / 数量 3
    const firstRow = adminPage.locator('div').filter({ hasText: /产品编号产品名/ }).locator('..').locator('input[placeholder="编号"]').first()
    await adminPage.locator('input[placeholder="编号"]').first().fill('TE2L48-SKU-A')
    await adminPage.locator('input[placeholder="产品名"]').first().fill('测试家居 A')
    await adminPage.locator('input[placeholder="数量"]').first().fill('3')

    // 加一行：产品 B 数量 2
    await adminPage.getByRole('button', { name: /加一行/ }).click()
    await adminPage.locator('input[placeholder="编号"]').nth(1).fill('TE2L48-SKU-B')
    await adminPage.locator('input[placeholder="产品名"]').nth(1).fill('测试家居 B')
    await adminPage.locator('input[placeholder="数量"]').nth(1).fill('2')

    // 提交
    await adminPage.getByRole('button', { name: /^提\s*交$/ }).click()
    // 对话框关闭意味着成功；超时 15s
    await expect(adminPage.getByRole('heading', { name: /新建.*单据/ })).toBeHidden({ timeout: 15_000 })

    // ── Step 3: SQL 找回 createdId（按窗口 + 备注 tag 定位） ───────
    createdId = psql(
      `SELECT id FROM inventory_procurement_orders ` +
        `WHERE remark = '${REMARK_TAG}' AND created_at >= '${winStart}' ` +
        `ORDER BY created_at DESC LIMIT 1`,
    )
    recordVerdict(verdicts, 'create: 单据已落库且备注 tag 命中', Boolean(createdId), createdId || '(empty)')
    if (!createdId) throw new Error('FATAL: 找不到本 spec 创建的采购单（备注 tag: ' + REMARK_TAG + '）')
    console.log(`[链路48] createdId = ${createdId}`)

    // ── Step 4: 头尾一致性 ─────────────────────────────────────────
    const header = getInventoryHeader('procurement', createdId)
    recordVerdict(verdicts, 'head: total_quantity = 5 (3+2)', header?.totalQuantity === 5, header?.totalQuantity ?? 'null')
    recordVerdict(verdicts, 'head: item_count = 2', header?.itemRowCount === 2, header?.itemRowCount ?? 'null')
    recordVerdict(
      verdicts,
      'head: SUM(items.quantity) == header.total_quantity',
      header?.totalQuantity === header?.itemQuantitySum,
      `${header?.totalQuantity ?? 'null'} vs ${header?.itemQuantitySum ?? 'null'}`,
    )
    recordVerdict(verdicts, 'head: status = 已完成（默认）', header?.status === '已完成', header?.status ?? 'null')
    recordVerdict(verdicts, 'head: storeId = store-nc01', header?.storeId === TOPOLOGY.STORE_NC01, header?.storeId ?? 'null')

    // ── Step 5: 审计 inventory.procurement.create ────────────────
    const createAudit = readLatestAudit('inventory.procurement.create', createdId)
    recordVerdict(verdicts, 'audit.create: 落库存在', Boolean(createAudit), createAudit ? 'present' : 'missing')
    recordVerdict(
      verdicts,
      'audit.create: detail.itemCount = 2',
      createAudit?.detail?.itemCount === 2,
      String(createAudit?.detail?.itemCount ?? 'null'),
    )
    recordVerdict(
      verdicts,
      'audit.create: detail.storeId = store-nc01',
      createAudit?.detail?.storeId === TOPOLOGY.STORE_NC01,
      String(createAudit?.detail?.storeId ?? 'null'),
    )
    recordVerdict(
      verdicts,
      'audit.create: detail.docSubtype 存在（院报货/院入库/退货出库 之一）',
      typeof createAudit?.detail?.docSubtype === 'string' &&
        ['院报货', '院入库', '退货出库'].includes(createAudit.detail.docSubtype as string),
      String(createAudit?.detail?.docSubtype ?? 'null'),
    )
    recordVerdict(
      verdicts,
      'audit.create: operator = FY-TEST-ADM',
      createAudit?.operatorEmployeeId === 'FY-TEST-ADM',
      createAudit?.operatorEmployeeId ?? 'null',
    )

    // ── Step 6: UI 删除（refresh 列表后逐行找到含 createdId 的行）─
    console.log('[链路48] Step 6: UI 删除 → 期待级联清空 + audit')
    await adminPage.goto(`${BASE}/inventory/procurement`)
    await adminPage.waitForLoadState('networkidle')
    // 用搜索框定位到本单据（admin 列表搜索支持单据号）
    const searchBox = adminPage.locator('input[placeholder*="单据号"]')
    await searchBox.fill(createdId)
    await adminPage.waitForTimeout(500) // 防抖 300ms + 余量
    await expect(adminPage.locator('main').getByText(createdId)).toBeVisible({ timeout: 5_000 })

    // 拦截 confirm 弹窗（"确认删除单据 X？"）
    adminPage.once('dialog', (d) => d.accept())
    // 找到该行的删除按钮（行内的 Trash2 ghost button）— 最后一个 button 是删除（详情在前）
    // 注：admin UI 的 row 有 onRowClick 整行跳详情，删除按钮 click 会 propagation 也跳；
    //     不依赖 UI 列表"消失"断言，直接走 SQL 验已删除
    const row = adminPage.locator('tr', { hasText: createdId }).first()
    await row.getByRole('button').last().click()

    // dev 下 delete action 偶尔未及时提交：轮询删除结果（主表行=null + items=0 + 审计 delete 出现），
    // 替代固定 waitForTimeout(2000)，最长 15s。轮询超时不阻断，交由下方 recordVerdict 记录 FAIL 以保留诊断。
    try {
      await expect
        .poll(
          () => {
            const headerGone = getInventoryHeader('procurement', createdId) === null
            const itemsGone =
              psql(`SELECT COUNT(*) FROM inventory_procurement_order_items WHERE order_id = '${createdId}'`) === '0'
            const auditPresent = Boolean(readLatestAudit('inventory.procurement.delete', createdId))
            return headerGone && itemsGone && auditPresent
          },
          { timeout: 15_000, intervals: [500, 1000, 1500] },
        )
        .toBe(true)
    } catch {
      /* 轮询超时（delete 未提交）：不抛，下方 recordVerdict 会记录具体失败项 */
    }

    // ── Step 7: SQL 验级联 + 审计 delete ─────────────────────────
    const headerAfter = getInventoryHeader('procurement', createdId)
    recordVerdict(verdicts, 'delete: 主表行已清', headerAfter === null, headerAfter === null ? 'null' : 'still present')
    const itemsAfter = psql(`SELECT COUNT(*) FROM inventory_procurement_order_items WHERE order_id = '${createdId}'`)
    recordVerdict(verdicts, 'delete: items 级联清空（FK CASCADE）', itemsAfter === '0', itemsAfter)

    const deleteAudit = readLatestAudit('inventory.procurement.delete', createdId)
    recordVerdict(verdicts, 'audit.delete: 落库存在', Boolean(deleteAudit), deleteAudit ? 'present' : 'missing')
    recordVerdict(
      verdicts,
      'audit.delete: operator = FY-TEST-ADM',
      deleteAudit?.operatorEmployeeId === 'FY-TEST-ADM',
      deleteAudit?.operatorEmployeeId ?? 'null',
    )

    await adminCtx.close()
  } finally {
    // afterAll 清理：本 spec 产生的所有"TE2L48-" / 'PROC-' 命名空间残留 + audit
    // PROC- 是 admin 生成单据号的前缀，不可全删（会清掉真实开发数据）；
    // 仅清本 spec 已知 createdId（若主测路径失败而未删）+ 审计
    if (createdId) {
      cleanupInventoryByPrefix(createdId)
      cleanupAuditByPrefix(createdId)
    }
    // 兜底：清掉所有 remark = REMARK_TAG 的（防止前面 SQL 找回 createdId 失败）
    psql(`DELETE FROM inventory_procurement_orders WHERE remark = '${REMARK_TAG}'`)
    summarize(48, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路48 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
