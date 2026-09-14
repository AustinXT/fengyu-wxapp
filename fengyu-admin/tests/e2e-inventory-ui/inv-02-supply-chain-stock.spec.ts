/**
 * INV-02：期初门禁负向断言 → 开闸 → 供应链备货链
 *
 * 三段：
 *   A. 门禁关闭态下走通用建单，断言写入被 fail-closed 拒绝
 *      （cutover.ts:49-51 抛 INVALID_STATE: 库存期初尚未导入并核验完成）
 *   B. 开闸（置「已初始化」，用户已确认开后不恢复），重建同一张单应成功
 *   C. 供应链备货：品项公司报货需求 → 供应链采购订单 → 供应链采购入库
 *      —— 总部批次由此产生，是 INV-03 三级主链的前提
 *
 * ⚠️ 建单失败时 inventory-docs-page.tsx:402 走的是原生 alert()，不是 toast。
 * 必须挂 page.on('dialog') 接管，否则弹窗会阻塞整个页面。这本身是 UX 发现之一。
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  INVT_ACCOUNTS,
  INVT_PASS,
  NS,
  TOPO,
  login,
  psql,
  readCtx,
  recordVerdict,
  sqlStr,
  summarize,
  today,
  writeCtx,
  type Verdict,
} from './_helpers/env'
import { closeCutoverGate, openCutoverGate, readCutoverStatus } from './_helpers/cutover'

test.setTimeout(420_000)

const STAMP = Date.now().toString().slice(-8)
const GATE_PROBE_REMARK = `${NS}-门禁探针-${STAMP}`
const OVERFLOW_REMARK = `${NS}-盘溢-${STAMP}`

test('INV-02：门禁 fail-closed → 开闸 → 供应链备货', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuId: string; supplySkuName: string; supplierName: string }>('inv01')
  if (!inv01?.supplySkuId) {
    throw new Error('缺少 INV-01 上下文，请先跑 inv-01-master-data.spec.ts')
  }

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

  /** 原生 alert/confirm/prompt 全部接管并记录 —— 既防阻塞，也作为 UX 规则 #4 的证据 */
  const nativeDialogs: Array<{ type: string; message: string }> = []
  page.on('dialog', async (dialog) => {
    nativeDialogs.push({ type: dialog.type(), message: dialog.message() })
    await dialog.accept('').catch(() => dialog.dismiss().catch(() => null))
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ A. 门禁关闭态：写入必须被拒 ════════════════════════════════
    console.log('[INV-02] A: 关闸并验证 fail-closed')
    closeCutoverGate()
    recordVerdict(verdicts, 'gate: 已置为关闭态', readCutoverStatus() === '待初始化', readCutoverStatus())

    const docsBefore = Number(psql(`SELECT count(*) FROM inventory_docs`))
    await createOverflowDoc(page, inv01.supplySkuName, GATE_PROBE_REMARK)

    const docsAfterBlocked = Number(psql(`SELECT count(*) FROM inventory_docs`))
    recordVerdict(
      verdicts,
      'gate: 关闭态下建单未落库（fail-closed 生效）',
      docsAfterBlocked === docsBefore,
      `before=${docsBefore} after=${docsAfterBlocked}`,
    )
    // 功能上门禁已生效（单据没落库）。这里单独考察「用户能不能看懂为什么被拒」。
    // 实测：通用建单弹窗 catch 里是 alert((err as Error).message)，而 Server Action
    // 抛出的 ApiError 在**生产构建**下被 Next.js 统一脱敏成 "An error occurred in the
    // Server Components render..."，业务文案「库存期初尚未导入并核验完成」完全丢失。
    // 用户只看到一句英文技术提示，不知道该做什么 —— 记为 UX 发现而非功能失败。
    const gateAlert = nativeDialogs.find((d) => /期初|暂不可办理/.test(d.message))
    recordVerdict(
      verdicts,
      'UX-ERRMSG-01: 拒绝原因应可读（期望含「期初」/「暂不可办理」，实测将失败）',
      Boolean(gateAlert),
      gateAlert?.message ?? `实际提示: ${nativeDialogs.map((d) => d.message).join(' || ')}`,
    )
    // UX 规则 #4：建单失败用原生 alert 而非页面内提示
    recordVerdict(
      verdicts,
      'UX-NATIVE-01: 建单失败不应使用原生 alert（期望 0 个，实测将失败）',
      nativeDialogs.filter((d) => d.type === 'alert').length === 0,
      `alert 数=${nativeDialogs.filter((d) => d.type === 'alert').length}`,
    )

    // ══ B. 开闸后同一张单应成功 ═══════════════════════════════════
    console.log('[INV-02] B: 开闸')
    openCutoverGate()
    recordVerdict(verdicts, 'gate: 已开闸', readCutoverStatus() === '已初始化', readCutoverStatus())

    await page.reload()
    await page.waitForLoadState('networkidle')
    await createOverflowDoc(page, inv01.supplySkuName, OVERFLOW_REMARK)

    const overflowDoc = psql(
      `SELECT id || '|' || doc_type || '|' || status || '|' || total_quantity::text
         FROM inventory_docs WHERE remark = ${sqlStr(OVERFLOW_REMARK)}`,
    )
    const [overflowId, overflowType, overflowStatus, overflowQty] = overflowDoc.split('|')
    recordVerdict(verdicts, 'gate: 开闸后建单成功', Boolean(overflowId), overflowId)
    recordVerdict(verdicts, 'doc: 类型 = 市场产品盘溢', overflowType === '市场产品盘溢', overflowType)
    recordVerdict(verdicts, 'doc: 盘溢建单即完成', overflowStatus === '已完成', overflowStatus)
    recordVerdict(verdicts, 'doc: 总数量 = 10', Number(overflowQty) === 10, overflowQty)
    // 盘溢是入库类，应产生正向流水
    const overflowMove = psql(
      `SELECT direction || '|' || quantity_delta::text || '|' || quantity_before::text || '|' || quantity_after::text
         FROM inventory_movements WHERE doc_id = ${sqlStr(overflowId)} LIMIT 1`,
    )
    const [dir, delta, before, after] = overflowMove.split('|')
    recordVerdict(verdicts, 'movement: 盘溢方向 = 入库', dir === '入库', dir)
    recordVerdict(
      verdicts,
      'movement: after = before + delta（流水自洽）',
      Number(after) === Number(before) + Number(delta),
      `${before} + ${delta} = ${after}`,
    )

    // ══ C. 供应链备货链 ═══════════════════════════════════════════
    console.log('[INV-02] C-1: 品项公司报货需求')
    await page.goto(`${BASE}/inventory/operations/supply-chain`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '品项公司报货需求' }).click()
    await expect(page.getByRole('heading', { name: '品项公司报货需求' })).toBeVisible({ timeout: 15_000 })

    const REQ_REMARK = `${NS}-品项报货-${STAMP}`
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await selectContaining(
      page.locator('select').filter({ hasText: '选择库存商品' }).first(),
      inv01.supplySkuName,
    )
    await fillByLabel(page, '数量', '100')
    await fillByLabel(page, '备注', REQ_REMARK)
    await page.getByRole('button', { name: '创建品项公司报货需求' }).click()
    await expect(page.getByText(/品项公司报货需求已创建/)).toBeVisible({ timeout: 20_000 })

    const reqDoc = psql(
      `SELECT id || '|' || status || '|' || total_quantity::text
         FROM inventory_docs WHERE doc_type = '品项公司报货需求' AND remark = ${sqlStr(REQ_REMARK)}`,
    )
    const [reqId, reqStatus, reqQty] = reqDoc.split('|')
    recordVerdict(verdicts, 'doc: 品项公司报货需求落库', Boolean(reqId), reqId)
    recordVerdict(verdicts, 'doc: 报货需求建单即完成', reqStatus === '已完成', reqStatus)
    recordVerdict(verdicts, 'doc: 报货数量 = 100', Number(reqQty) === 100, reqQty)
    // 报货类单据永不动库存（NO_MOVEMENT_DOC_TYPES，engine.ts:297-309）
    const reqMoves = psql(`SELECT count(*) FROM inventory_movements WHERE doc_id = ${sqlStr(reqId)}`)
    recordVerdict(verdicts, 'doc: 报货需求不产生库存流水（§报货不增减库存）', reqMoves === '0', reqMoves)

    console.log('[INV-02] C-2: 供应链采购订单')
    await page.getByRole('button', { name: '关闭' }).click().catch(() => null)
    await page.getByRole('button', { name: '供应链采购订单' }).click()
    await expect(page.getByRole('heading', { name: '供应链采购订单' })).toBeVisible({ timeout: 15_000 })

    const PO_REMARK = `${NS}-供应链采购-${STAMP}`
    await selectByLabel(page, '品项公司报货需求', { contains: reqId })
    await page.waitForTimeout(1500)   // 选单后要拉明细
    await selectByLabel(page, '供应商', { contains: inv01.supplierName })
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await fillByLabel(page, '采购数量', '100')
    await fillByLabel(page, '备注', PO_REMARK)
    await page.getByRole('button', { name: '创建供应链采购订单' }).click()
    await expect(page.getByText(/供应链采购订单已创建/)).toBeVisible({ timeout: 20_000 })

    const poDoc = psql(
      `SELECT id || '|' || status || '|' || total_quantity::text
         FROM inventory_docs WHERE doc_type = '供应链采购订单' AND remark = ${sqlStr(PO_REMARK)}`,
    )
    const [poId, poStatus, poQty] = poDoc.split('|')
    recordVerdict(verdicts, 'doc: 供应链采购订单落库', Boolean(poId), poId)
    recordVerdict(verdicts, 'doc: 采购订单状态 = 待收货', poStatus === '待收货', poStatus)
    recordVerdict(verdicts, 'doc: 采购数量 = 100', Number(poQty) === 100, poQty)
    const poLink = psql(
      `SELECT relation_type FROM inventory_doc_links
        WHERE from_doc_id = ${sqlStr(reqId)} AND to_doc_id = ${sqlStr(poId)} LIMIT 1`,
    )
    recordVerdict(verdicts, 'link: 报货需求 → 采购订单 血缘已建立', poLink.length > 0, poLink)

    console.log('[INV-02] C-3: 供应链采购入库')
    await page.getByRole('button', { name: '关闭' }).click().catch(() => null)
    await page.getByRole('button', { name: '供应链采购入库' }).click()
    await expect(page.getByRole('heading', { name: '供应链采购入库' })).toBeVisible({ timeout: 15_000 })

    const GRK_REMARK = `${NS}-供应链入库-${STAMP}`
    const BATCH_NO = `${NS}-B${STAMP}`
    await selectByLabel(page, '供应链采购订单', { contains: poId })
    await page.waitForTimeout(1500)
    // 「供应链库存主体」在选定采购订单后 disabled={Boolean(doc)} —— 主体随单锁定，
    // 不需要也不能再设置。这是个合理的交互设计，顺手记一条正向断言。
    const lockedLocation = selectOf(page, '供应链库存主体')
    recordVerdict(
      verdicts,
      'UX-GOOD: 选定采购订单后库存主体自动锁定（防止主体与单据不一致）',
      await lockedLocation.isDisabled(),
      `disabled=${await lockedLocation.isDisabled()}`,
    )
    await fillByLabel(page, '实收数量', '100')
    await fillByLabel(page, '批号', BATCH_NO)
    await fillByLabel(page, '备注', GRK_REMARK)
    await page.getByRole('button', { name: '登记供应链采购入库' }).click()
    await expect(page.getByText(/供应链采购入库单已创建/)).toBeVisible({ timeout: 20_000 })

    const grkDoc = psql(
      `SELECT id || '|' || status FROM inventory_docs
        WHERE doc_type = '供应链采购入库' AND remark = ${sqlStr(GRK_REMARK)}`,
    )
    const [grkId, grkStatus] = grkDoc.split('|')
    recordVerdict(verdicts, 'doc: 供应链采购入库落库', Boolean(grkId), grkId)
    recordVerdict(verdicts, 'doc: 入库单已完成', grkStatus === '已完成', grkStatus)

    // 总部库存到账 —— 这是 INV-03 主链的前提
    const hqLot = psql(
      `SELECT l.quantity_on_hand::text || '|' || COALESCE(l.batch_no,'')
         FROM inventory_stock_lots l
         JOIN inventory_locations loc ON loc.location_id = l.location_id
        WHERE loc.org_node_id = ${sqlStr(TOPO.HQ)} AND l.sku_id = ${sqlStr(inv01.supplySkuId)}
          AND l.batch_no = ${sqlStr(BATCH_NO)}`,
    )
    const [hqQty, hqBatch] = hqLot.split('|')
    recordVerdict(verdicts, 'stock: 总部批次到账 100', Number(hqQty) === 100, hqQty)
    recordVerdict(verdicts, 'stock: 批号正确落库', hqBatch === BATCH_NO, hqBatch)

    const poStatusAfter = psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`)
    recordVerdict(verdicts, 'doc: 采购订单收完转已完成', poStatusAfter === '已完成', poStatusAfter)

    writeCtx('inv02', {
      overflowId, reqId, poId, grkId, batchNo: BATCH_NO,
      hqStockQty: Number(hqQty), docDate: today(),
    })
    console.log(`[INV-02] 原生弹窗累计捕获 ${nativeDialogs.length} 个:`, JSON.stringify(nativeDialogs))
  } finally {
    await ctx.close()
    summarize(2, verdicts)
  }

  const uxFindings = verdicts.filter((v) => v.verdict === 'FAIL' && v.check.startsWith('UX-'))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !v.check.startsWith('UX-'))
  if (uxFindings.length > 0) {
    console.log(`\n[INV-02] ⚠️ UX 发现 ${uxFindings.length} 条:`)
    console.log(JSON.stringify(uxFindings, null, 2))
  }
  expect(functional, `INV-02 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})

// ───────────────────────── helpers ─────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 按 FormField/Field 的 <label> 包裹关系定位并填值 */
async function fillByLabel(page: import('@playwright/test').Page, labelText: string, value: string) {
  await page
    .locator('label')
    .filter({ hasText: new RegExp(`^${escapeRe(labelText)}`) })
    .locator('input, textarea')
    .first()
    .fill(value)
}

/** 按 label 定位 <select> */
function selectOf(page: import('@playwright/test').Page, labelText: string) {
  return page
    .locator('label')
    .filter({ hasText: new RegExp(`^${escapeRe(labelText)}`) })
    .locator('select')
    .first()
}

/**
 * 选中「option 文本包含 text」的那一项。
 *
 * 为什么不用 selectOption({ label: /正则/ })：Playwright 的 label 只接受**精确字符串**，
 * 传正则会报 "options[0].label: expected string, got object"。而这里要匹配的 option
 * 文本是拼出来的（如「INV-SKU-20260913-0001 · 商品名 · 规格」），只能按包含匹配。
 */
async function selectContaining(sel: import('@playwright/test').Locator, text: string) {
  const value = await sel.locator('option').filter({ hasText: text }).first().getAttribute('value')
  if (value === null) {
    const all = await sel.locator('option').allTextContents()
    throw new Error(`未找到含「${text}」的选项。现有选项: ${JSON.stringify(all)}`)
  }
  await sel.selectOption(value)
}

async function selectByLabel(
  page: import('@playwright/test').Page,
  labelText: string,
  option: { label: string } | { contains: string },
) {
  const sel = selectOf(page, labelText)
  if ('contains' in option) await selectContaining(sel, option.contains)
  else await sel.selectOption({ label: option.label })
}

/**
 * 在 /inventory/docs 走通用建单做一张「市场产品盘溢」。
 * 选它是因为：① 属 INVENTORY_GENERIC_DOC_TYPES，通用入口可建；
 * ② 不在 SOURCE_LOT_DOC_TYPES 里，无需先有源批次（dev 库初始 0 批次）。
 */
async function createOverflowDoc(
  page: import('@playwright/test').Page,
  skuName: string,
  remark: string,
) {
  await page.goto(`${BASE}/inventory/docs`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /新建/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建库存单据')).toBeVisible({ timeout: 15_000 })

  const selects = dialog.locator('select')
  await selects.nth(0).selectOption('市场产品盘溢')         // 单据类型
  await selects.nth(1).selectOption({ label: `市场 · ${TOPO.MARKET_NAME}` })  // 出库/发起主体
  await selects.nth(2).selectOption({ label: `市场 · ${TOPO.MARKET_NAME}` })  // 入库/接收主体
  await dialog.locator('textarea').first().fill(remark)

  // 明细行：SKU（唯一的 select，因盘溢不需批次选择器）+ 数量
  await selectContaining(dialog.locator('select').last(), skuName)
  await dialog.getByPlaceholder('数量').fill('10')

  await dialog.getByRole('button', { name: '提交' }).click()
  // 成功则弹窗关闭；失败走原生 alert（已由 page.on('dialog') 接管）
  await page.waitForTimeout(3000)
  await page.keyboard.press('Escape').catch(() => null)
}
