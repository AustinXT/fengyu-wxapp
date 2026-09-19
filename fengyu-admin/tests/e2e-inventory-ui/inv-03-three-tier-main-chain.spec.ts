/**
 * INV-03：三级正向主链（P0 主干）
 *
 * 门店报货 → 市场汇总 → 市场报货 → 采购订单 → 品项公司发货（含赠送）
 *   → 市场采购入库 → 分院配货 → 分院收货入库 → 货款结算
 *
 * 断言绑定说明.md 章节：
 *   §1.3  门店报货单不体现价格
 *   §3.2  汇总数量仅供参考，另给「市场可用库存」参考列，采购量手填
 *   §3.4  真实单价核算出本期应付货款
 *   §5.2  发货数量可大于报货数量（赠送部分）
 *   §5.3  品项公司发货单不含单价/货款
 *   §7.3  分院配货金额四件套决定门店真实单价
 *   §10.2 明细金额由 DB 触发器统一计算，赠品金额为 0
 *
 * 数量设计（刻意让各环节数量不同，才能验出履约口径）：
 *   门店报货 20 → 市场实际采购 30（≠汇总，验 §3.2 手填）→ 采购订单 30
 *   → 发货 30 + 赠送 5（验 §5.2）→ 市场入库 35 → 分院配货 20 + 赠送 2 → 门店收货 22
 *
 * 前置：INV-02 已开闸且总部有 100 件库存。
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'

test.setTimeout(600_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  storeReq: `${NS}-门店报货-${STAMP}`,
  marketReq: `${NS}-市场报货-${STAMP}`,
  po: `${NS}-采购订单-${STAMP}`,
  shipment: `${NS}-品项发货-${STAMP}`,
  marketReceipt: `${NS}-市场入库-${STAMP}`,
  allocation: `${NS}-分院配货-${STAMP}`,
  storeReceipt: `${NS}-门店收货-${STAMP}`,
}

const QTY = {
  storeRequest: 20,
  marketPurchase: 30,
  shipNormal: 30,
  shipGift: 5,
  marketReceive: 35,
  allocNormal: 20,
  allocGift: 2,
  storeReceive: 22,
}

test('INV-03：三级正向主链 —— 报货→采购→发货→入库→配货→收货', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuId: string; supplySkuName: string; supplierName: string }>('inv01')
  const inv02 = readCtx<{ batchNo: string }>('inv02')
  if (!inv01?.supplySkuId || !inv02?.batchNo) {
    throw new Error('缺少 INV-01/INV-02 上下文，请按顺序跑 inv-01 → inv-02')
  }
  if (!isGateOpen()) openCutoverGate()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  const nativeDialogs: Array<{ type: string; message: string }> = []
  page.on('dialog', async (d) => {
    nativeDialogs.push({ type: d.type(), message: d.message() })
    await d.accept('').catch(() => d.dismiss().catch(() => null))
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ 0. 前置：确保总部有一个足量的单批次 ═══════════════════════
    // 每跑一轮都会消耗总部库存，且发货只能从**单个批次**出。不做这步，
    // 第二次运行就会撞上「没有可用量 >= 35 的批次」（库存被拆成多个小批次）。
    // 走 INV-02 同款三步补一张新批次，让本 spec 可独立重复执行。
    const needQty = QTY.shipNormal + QTY.shipGift
    const hqBatch = await ensureHqBatch(page, inv01.supplySkuName, inv01.supplierName, needQty)
    recordVerdict(verdicts, `前置: 总部具备可用量 >= ${needQty} 的批次`, Boolean(hqBatch), hqBatch)

    // ══ 1. 门店报货（§1.3 不体现价格）══════════════════════════════
    console.log('[INV-03] 1/8 门店报货')
    await openOperation(page, 'store', '门店报货')
    await selectByLabel(page, '报货门店', { contains: TOPO.STORE_A_NAME })
    await selectByLabel(page, '所属市场', { contains: TOPO.MARKET_NAME })
    await selectContaining(skuSelect(page), inv01.supplySkuName)
    await fillByLabel(page, '数量', String(QTY.storeRequest))
    await fillByLabel(page, '备注', R.storeReq)

    // §1.3：门店报货单不需要体现价格 —— 表单里不应出现任何价格字段
    const storeFormPriceLabels = await page
      .locator('form label')
      .filter({ hasText: /单价|货款|金额|进货价|优惠/ })
      .count()
    recordVerdict(
      verdicts,
      '§1.3 门店报货表单不出现价格字段',
      storeFormPriceLabels === 0,
      `价格类字段数=${storeFormPriceLabels}`,
    )

    await submitForm(page, '创建门店报货单', /门店报货单已创建/)
    const storeReqId = docIdByRemark('门店报货', R.storeReq)
    recordVerdict(verdicts, 'doc: 门店报货单落库', Boolean(storeReqId), storeReqId)
    recordVerdict(
      verdicts,
      'doc: 门店报货单号前缀 DBH',
      storeReqId.startsWith('DBH'),
      storeReqId,
    )
    recordVerdict(
      verdicts,
      'doc: 门店报货不产生库存流水',
      psql(`SELECT count(*) FROM inventory_movements WHERE doc_id = ${sqlStr(storeReqId)}`) === '0',
      'movements=0',
    )

    // ══ 2. 市场汇总报货（§3.2 实时库存参考 + 手填采购量）═══════════
    console.log('[INV-03] 2/8 市场汇总报货')
    await openOperation(page, 'market', '市场汇总报货')
    await selectByLabel(page, '市场', { contains: TOPO.MARKET_NAME })
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await page.locator('form').getByRole('button', { name: '汇总门店报货' }).click()
    await expect(page.getByRole('columnheader', { name: '市场可用库存' })).toBeVisible({ timeout: 25_000 })

    // §3.2：汇总结果必须带「市场可用库存」参考列，且采购数量可手填（≠ 汇总量）
    recordVerdict(verdicts, '§3.2 汇总表带「市场可用库存」参考列', true, '列已渲染')
    const suggestHeader = await page.getByRole('columnheader', { name: '建议采购' }).count()
    recordVerdict(verdicts, '§3.2 汇总表带「建议采购」列', suggestHeader > 0, String(suggestHeader))

    const row = page.locator('tbody tr').filter({ hasText: inv01.supplySkuName }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const requestQty = (await row.locator('td').nth(2).innerText()).trim()
    recordVerdict(
      verdicts,
      `§3.1 汇总数量来自门店报货 = ${QTY.storeRequest}`,
      Number(requestQty) === QTY.storeRequest,
      requestQty,
    )
    await row.locator('input[type=checkbox]').check()
    await row.locator('input:not([type=checkbox])').first().fill(String(QTY.marketPurchase))
    await page.waitForTimeout(2500)   // 等福利报价回来
    await fillByLabel(page, '备注', R.marketReq)
    await submitForm(page, '创建市场报货单', /市场报货单已创建/)

    const marketReqId = docIdByRemark('市场报货', R.marketReq)
    recordVerdict(verdicts, 'doc: 市场报货单落库', Boolean(marketReqId), marketReqId)
    const marketReqRow = psql(
      `SELECT total_quantity::text || '|' || COALESCE(total_amount::text,'')
         FROM inventory_docs WHERE id = ${sqlStr(marketReqId)}`,
    )
    const [mrQty, mrAmount] = marketReqRow.split('|')
    recordVerdict(
      verdicts,
      `§3.2 实际采购量手填 = ${QTY.marketPurchase}（不等于汇总量 ${QTY.storeRequest}）`,
      Number(mrQty) === QTY.marketPurchase,
      mrQty,
    )
    // §3.4：应付货款 = Σ 明细金额，由 DB 触发器算（§10.2）
    const mrItemSum = psql(
      `SELECT COALESCE(SUM(amount),0)::text FROM inventory_doc_items WHERE doc_id = ${sqlStr(marketReqId)}`,
    )
    recordVerdict(
      verdicts,
      '§3.4/§10.2 应付货款 = 明细金额合计（DB 单源）',
      Number(mrAmount) === Number(mrItemSum),
      `单头=${mrAmount} 明细合计=${mrItemSum}`,
    )
    recordVerdict(
      verdicts,
      '§3.3 市场报货单金额已核算（非空且 > 0）',
      Number(mrAmount) > 0,
      mrAmount,
    )

    // ══ 3. 创建采购订单 ═══════════════════════════════════════════
    console.log('[INV-03] 3/8 创建采购订单')
    await openOperation(page, 'supply-chain', '创建采购订单')
    await selectByLabel(page, '市场报货单', { contains: marketReqId })
    await page.waitForTimeout(2000)
    await selectByLabel(page, '供应商', { contains: inv01.supplierName })
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await fillByLabel(page, '采购数量', String(QTY.marketPurchase))
    await fillByLabel(page, '备注', R.po)
    await submitForm(page, '创建采购订单', /采购订单已创建/)

    const poId = docIdByRemark('采购订单', R.po)
    recordVerdict(verdicts, 'doc: 采购订单落库', Boolean(poId), poId)
    // 注意「采购订单」与「供应链采购订单」是两种不同的 doc_type：
    // 「待收货」状态白名单只含 供应链采购订单/品项公司发货/分院配货/分院调货出库/市场间调货出库
    // （0009 触发器）。「采购订单」属 NO_MOVEMENT_DOC_TYPES，建单即「已完成」，不动库存。
    recordVerdict(
      verdicts,
      'doc: 采购订单建单即完成（属 NO_MOVEMENT 类型）',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`) === '已完成',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`),
    )
    recordVerdict(
      verdicts,
      'doc: 采购订单不产生库存流水',
      psql(`SELECT count(*) FROM inventory_movements WHERE doc_id = ${sqlStr(poId)}`) === '0',
      'movements=0',
    )
    recordVerdict(
      verdicts,
      'link: 市场报货单 → 采购订单 血缘',
      psql(`SELECT count(*) FROM inventory_doc_links WHERE from_doc_id = ${sqlStr(marketReqId)} AND to_doc_id = ${sqlStr(poId)}`) !== '0',
      'link 存在',
    )

    // ══ 4. 品项公司发货（§5.2 赠送 / §5.3 无金额）═════════════════
    console.log('[INV-03] 4/8 品项公司发货')
    const hqBefore = lotQty(TOPO.HQ, inv01.supplySkuId, hqBatch)
    await openOperation(page, 'supply-chain', '品项公司发货')
    await selectByLabel(page, '采购订单', { contains: poId })
    await page.waitForTimeout(2000)
    await selectByLabel(page, '发货总部', { label: '品牌总部' })

    // §5.3：发货单业务页面不展示单价和货款
    const shipPriceFields = await page
      .locator('form label')
      .filter({ hasText: /单价|货款|金额/ })
      .count()
    recordVerdict(
      verdicts,
      '§5.3/§10.4 品项公司发货表单不出现单价/货款字段',
      shipPriceFields === 0,
      `价格类字段数=${shipPriceFields}`,
    )

    await selectLotContaining(page, '发货批次', hqBatch)
    await fillByLabel(page, '正常发货', String(QTY.shipNormal))
    await fillByLabel(page, '赠送数量', String(QTY.shipGift))
    await fillByLabel(page, '物流公司', 'INVT-物流')
    await fillByLabel(page, '备注', R.shipment)
    await submitForm(page, '创建品项公司发货单', /品项公司发货单已创建/)

    const shipId = docIdByRemark('品项公司发货', R.shipment)
    recordVerdict(verdicts, 'doc: 品项公司发货单落库', Boolean(shipId), shipId)
    const shipRow = psql(
      `SELECT status || '|' || total_quantity::text || '|' || COALESCE(total_amount::text,'NULL')
         FROM inventory_docs WHERE id = ${sqlStr(shipId)}`,
    )
    const [shipStatus, shipQty, shipAmount] = shipRow.split('|')
    recordVerdict(verdicts, 'doc: 发货单状态 = 待收货', shipStatus === '待收货', shipStatus)
    recordVerdict(
      verdicts,
      `§5.2 发货量(${QTY.shipNormal}+赠送${QTY.shipGift}) 可大于采购量(${QTY.marketPurchase})`,
      Number(shipQty) === QTY.shipNormal + QTY.shipGift,
      shipQty,
    )
    const giftAmount = psql(
      `SELECT COALESCE(SUM(amount),0)::text FROM inventory_doc_items
        WHERE doc_id = ${sqlStr(shipId)} AND is_gift = true`,
    )
    recordVerdict(verdicts, '§10.2 赠品金额恒为 0', Number(giftAmount) === 0, giftAmount)

    // 发货即扣发货方库存（RECEIVE_REQUIRED 类型：source 出库）
    const hqAfter = lotQty(TOPO.HQ, inv01.supplySkuId, hqBatch)
    recordVerdict(
      verdicts,
      `stock: 发货即扣总部库存 ${hqBefore} → ${hqAfter}（减 ${QTY.shipNormal + QTY.shipGift}）`,
      hqBefore - hqAfter === QTY.shipNormal + QTY.shipGift,
      `${hqBefore} → ${hqAfter}`,
    )

    // ══ 5. 市场采购入库（§6.1 须先有发货单）═══════════════════════
    console.log('[INV-03] 5/8 市场采购入库')
    await openOperation(page, 'market', '市场采购入库')
    await selectByLabel(page, '品项公司发货单', { contains: shipId })
    await page.waitForTimeout(2000)
    const receiveInputs = page.locator('tbody tr input[inputmode=decimal]')
    const receiveRows = await receiveInputs.count()
    for (let i = 0; i < receiveRows; i += 1) {
      const outstanding = (await page.locator('tbody tr').nth(i).locator('td').nth(3).innerText()).trim()
      await receiveInputs.nth(i).fill(outstanding)
    }
    await fillByLabel(page, '备注', R.marketReceipt)
    await submitForm(page, '登记本次实收', /市场采购入库已创建/)

    const mrkReceiptId = docIdByRemark('市场采购入库', R.marketReceipt)
    recordVerdict(verdicts, 'doc: 市场采购入库落库', Boolean(mrkReceiptId), mrkReceiptId)
    const marketQty = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      `stock: 市场库存到账 ${QTY.marketReceive}`,
      marketQty >= QTY.marketReceive,
      String(marketQty),
    )
    recordVerdict(
      verdicts,
      'doc: 全部收完后发货单转「已完成」',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(shipId)}`) === '已完成',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(shipId)}`),
    )

    // ══ 6. 分院配货（§7.3 金额四件套）═════════════════════════════
    console.log('[INV-03] 6/8 分院配货')
    await openOperation(page, 'market', '分院配货')
    await selectByLabel(page, '门店报货单', { contains: storeReqId })
    await page.waitForTimeout(2000)
    await selectByLabel(page, '配货市场', { contains: TOPO.MARKET_NAME })
    await page.waitForTimeout(1500)

    // §7.3：门店进货价 / 数量 / 单价优惠 / 应付货款 四件套
    const hasDiscountField = await page
      .locator('form label')
      .filter({ hasText: /门店单价优惠/ })
      .count()
    recordVerdict(verdicts, '§7.3 配货表单含「门店单价优惠」', hasDiscountField > 0, String(hasDiscountField))

    const insufficientLots = await countInsufficientLots(page, '市场批次', QTY.allocNormal + QTY.allocGift)
    await selectLotWithQty(page, '市场批次', QTY.allocNormal + QTY.allocGift)
    recordVerdict(
      verdicts,
      'UX-LOT-01: 批次下拉未过滤/未警示可用量不足的批次（选错要到提交才报错）',
      insufficientLots === 0,
      `可用量不足的可选批次数=${insufficientLots}`,
    )
    await fillByLabel(page, '正常配货', String(QTY.allocNormal))
    await fillByLabel(page, '赠送数量', String(QTY.allocGift))
    await fillByLabel(page, '备注', R.allocation)
    await submitForm(page, '创建分院配货单', /分院配货单已创建/)

    const allocId = docIdByRemark('分院配货', R.allocation)
    recordVerdict(verdicts, 'doc: 分院配货单落库', Boolean(allocId), allocId)
    const allocRow = psql(
      `SELECT status || '|' || total_quantity::text || '|' || COALESCE(total_amount::text,'')
         FROM inventory_docs WHERE id = ${sqlStr(allocId)}`,
    )
    const [allocStatus, allocQty, allocAmount] = allocRow.split('|')
    recordVerdict(verdicts, 'doc: 配货单状态 = 待收货', allocStatus === '待收货', allocStatus)
    recordVerdict(
      verdicts,
      `doc: 配货总量 = ${QTY.allocNormal + QTY.allocGift}`,
      Number(allocQty) === QTY.allocNormal + QTY.allocGift,
      allocQty,
    )
    // §7.3：真实单价落到明细快照，后续退/调以此为准
    const allocPrice = psql(
      `SELECT COALESCE(store_actual_unit_price::text, store_standard_unit_price::text, 'NULL')
         FROM inventory_doc_items WHERE doc_id = ${sqlStr(allocId)} AND is_gift = false LIMIT 1`,
    )
    recordVerdict(
      verdicts,
      '§7.3 配货明细记录门店真实单价（后续退/调以此为准）',
      allocPrice !== 'NULL' && Number(allocPrice) > 0,
      allocPrice,
    )
    recordVerdict(verdicts, '§7.3 配货应付货款已核算', Number(allocAmount) > 0, allocAmount)

    // ══ 7. 分院收货入库 ═══════════════════════════════════════════
    console.log('[INV-03] 7/8 分院收货入库')
    const storeBefore = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    await openOperation(page, 'store', '分院收货入库')
    await selectByLabel(page, '分院配货单', { contains: allocId })
    await page.waitForTimeout(2000)
    const storeReceiveInputs = page.locator('tbody tr input[inputmode=decimal]')
    const storeRows = await storeReceiveInputs.count()
    for (let i = 0; i < storeRows; i += 1) {
      const outstanding = (await page.locator('tbody tr').nth(i).locator('td').nth(3).innerText()).trim()
      await storeReceiveInputs.nth(i).fill(outstanding)
    }
    await fillByLabel(page, '备注', R.storeReceipt)
    await submitForm(page, '登记本次实收', /分院收货入库已创建/)

    const storeReceiptId = docIdByRemark('院入库', R.storeReceipt)
    recordVerdict(verdicts, 'doc: 院入库单落库', Boolean(storeReceiptId), storeReceiptId)
    recordVerdict(verdicts, 'doc: 院入库单号前缀 YRK', storeReceiptId.startsWith('YRK'), storeReceiptId)
    const storeAfter = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      `stock: 门店库存增加 ${QTY.allocNormal + QTY.allocGift}`,
      storeAfter - storeBefore === QTY.allocNormal + QTY.allocGift,
      `${storeBefore} → ${storeAfter}`,
    )
    recordVerdict(
      verdicts,
      'doc: 配货单收完转「已完成」',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(allocId)}`) === '已完成',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(allocId)}`),
    )

    // 全链流水自洽：每条 movement 都满足 after = before + delta
    const badMoves = psql(
      `SELECT count(*) FROM inventory_movements
        WHERE quantity_after <> quantity_before + quantity_delta`,
    )
    recordVerdict(verdicts, 'movement: 全库流水 after=before+delta 自洽', badMoves === '0', `异常行=${badMoves}`)

    // ══ 8. 货款结算报表 ═══════════════════════════════════════════
    console.log('[INV-03] 8/8 货款结算报表')
    await page.goto(`${BASE}/inventory/settlements`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    const settlementText = await page.locator('main').innerText().catch(() => '')
    recordVerdict(
      verdicts,
      '结算页含「市场货款结算」段',
      /市场货款结算|市场应付/.test(settlementText),
      settlementText.slice(0, 60).replace(/\n/g, ' '),
    )
    recordVerdict(
      verdicts,
      '结算页含「分院货款结算」段',
      /分院货款结算|门店应付/.test(settlementText),
      'section',
    )
    recordVerdict(
      verdicts,
      '结算页无 null/undefined/NaN 泄漏',
      !/\bnull\b|\bundefined\b|\bNaN\b/.test(settlementText),
      'clean',
    )

    writeCtx('inv03', {
      storeReqId, marketReqId, poId, shipId, mrkReceiptId, allocId, storeReceiptId,
      skuId: inv01.supplySkuId, skuName: inv01.supplySkuName,
      storeStockAfter: storeAfter, marketStockAfter: marketQty,
    })
    if (nativeDialogs.length > 0) {
      console.log('[INV-03] 原生弹窗:', JSON.stringify(nativeDialogs))
    }
  } finally {
    await ctx.close()
    summarize(3, verdicts)
  }

  const uxFindings = verdicts.filter((v) => v.verdict === 'FAIL' && v.check.startsWith('UX-'))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !v.check.startsWith('UX-'))
  if (uxFindings.length > 0) console.log(`\n[INV-03] ⚠️ UX 发现:\n${JSON.stringify(uxFindings, null, 2)}`)
  expect(functional, `INV-03 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})

// ───────────────────────── helpers ─────────────────────────

/**
 * 点击表单的提交按钮。
 *
 * 必须限定在 <form> 内：办理台的操作卡片也是 <button>，且个别卡片与提交按钮同名
 * （如「创建采购订单」既是 supply-chain 的卡片标题又是表单提交按钮），
 * 直接 getByRole('button', {name}) 会 strict mode violation。
 */
async function submitForm(page: Page, name: string, expect: RegExp): Promise<string> {
  await page.locator('form').getByRole('button', { name, exact: true }).click()
  const toast = page.locator('[data-sonner-toast]').first()
  await toast.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null)
  const text = (await toast.innerText().catch(() => '')) || '(未出现任何 toast)'
  if (!expect.test(text)) {
    throw new Error(`提交「${name}」未得到预期结果。实际提示：${text.replace(/\n/g, ' ')}`)
  }
  return text
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 打开某层办理台的某张操作卡片 */
async function openOperation(page: Page, level: string, title: string) {
  await page.goto(`${BASE}/inventory/operations/${level}`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: title, exact: true }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 })
}

function labelled(page: Page, labelText: string) {
  return page.locator('label').filter({ hasText: new RegExp(`^${escapeRe(labelText)}`) })
}

async function fillByLabel(page: Page, labelText: string, value: string) {
  await labelled(page, labelText).locator('input, textarea').first().fill(value)
}

/** option 文本按「包含」匹配 —— selectOption 的 label 只认精确字符串，不收正则 */
async function selectContaining(sel: Locator, text: string) {
  const value = await sel.locator('option').filter({ hasText: text }).first().getAttribute('value')
  if (value === null) {
    throw new Error(`未找到含「${text}」的选项。现有: ${JSON.stringify(await sel.locator('option').allTextContents())}`)
  }
  await sel.selectOption(value)
}

/**
 * 候选唯一的主体字段会自动选中并降级成只读 `<output data-fixed-subject>`（#189），
 * 那里没有 select 可选 —— 改为核对展示值，语义与"选中它"等价。
 */
async function selectByLabel(page: Page, labelText: string, option: { label: string } | { contains: string }) {
  const field = labelled(page, labelText)
  const fixed = field.locator('[data-fixed-subject]')
  // 先等两种形态任一渲染出来，否则 hydration 未完成时 count() 读到 0 会误判成「可选」。
  await expect(field.locator('select, [data-fixed-subject]').first()).toBeVisible({ timeout: 20_000 })
  if (await fixed.count() > 0) {
    await expect(fixed.first()).toContainText('contains' in option ? option.contains : option.label)
    return
  }
  const sel = field.locator('select').first()
  if ('contains' in option) await selectContaining(sel, option.contains)
  else await sel.selectOption({ label: option.label })
}

/** 明细行里的 SkuPicker（占位文案「选择库存商品」） */
function skuSelect(page: Page) {
  return page.locator('select').filter({ hasText: '选择库存商品' }).first()
}

/**
 * 选中一个可用量 >= minQty 的批次。
 *
 * 不能简单取 index=1：同一主体常有多个批次（本链路里市场既有 INV-02 的盘溢 10 件，
 * 又有市场采购入库的 35 件），取第一个会撞上「库存不足：… 可用 10」。
 * option 文案形如「批次 XXX · 可用 35」，按其中的可用量挑。
 */
async function selectLotWithQty(page: Page, labelText: string, minQty: number): Promise<number> {
  const sel = labelled(page, labelText).locator('select').first()
  await expect(sel).toBeEnabled({ timeout: 20_000 })
  const texts = await sel.locator('option').allTextContents()
  for (let i = 1; i < texts.length; i += 1) {
    const available = Number(texts[i].match(/可用\s*([\d.]+)/)?.[1] ?? '0')
    if (available >= minQty) {
      await sel.selectOption({ index: i })
      return available
    }
  }
  throw new Error(`「${labelText}」没有可用量 >= ${minQty} 的批次。现有: ${JSON.stringify(texts)}`)
}

/** 批次下拉里可用量不足 minQty 的选项数量 —— 用于 UX 观察 */
async function countInsufficientLots(page: Page, labelText: string, minQty: number): Promise<number> {
  const texts = await labelled(page, labelText).locator('select').first().locator('option').allTextContents()
  return texts.slice(1).filter((t) => Number(t.match(/可用\s*([\d.]+)/)?.[1] ?? '0') < minQty).length
}

function docIdByRemark(docType: string, remark: string): string {
  return psql(
    `SELECT id FROM inventory_docs WHERE doc_type = ${sqlStr(docType)} AND remark = ${sqlStr(remark)} LIMIT 1`,
  )
}

/** 指定主体 + SKU + 批号的在手数量 */
function lotQty(orgNodeId: string, skuId: string, batchNo: string): number {
  const v = psql(
    `SELECT COALESCE(SUM(l.quantity_on_hand),0)::text FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
      WHERE loc.org_node_id = ${sqlStr(orgNodeId)} AND l.sku_id = ${sqlStr(skuId)}
        AND l.batch_no = ${sqlStr(batchNo)}`,
  )
  return Number(v)
}

/** 指定主体 + SKU 的全部批次在手合计 */
function lotQtyAll(orgNodeId: string, skuId: string): number {
  const v = psql(
    `SELECT COALESCE(SUM(l.quantity_on_hand),0)::text FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
      WHERE loc.org_node_id = ${sqlStr(orgNodeId)} AND l.sku_id = ${sqlStr(skuId)}`,
  )
  return Number(v)
}

/** 按批号文本选中批次 */
async function selectLotContaining(page: Page, labelText: string, batchNo: string) {
  const sel = labelled(page, labelText).locator('select').first()
  await expect(sel).toBeEnabled({ timeout: 20_000 })
  await selectContaining(sel, batchNo)
}

/**
 * 确保总部存在一个可用量 >= needQty 的**单一**批次，返回其批号。
 *
 * 已有满足条件的批次就直接复用；否则走「品项公司报货需求 → 供应链采购订单
 * → 供应链采购入库」补一张新批次。发货只能从单个批次出，所以这里要的是
 * 「单批次足量」而不是「总量足量」。
 */
async function ensureHqBatch(
  page: Page,
  skuName: string,
  supplierName: string,
  needQty: number,
): Promise<string> {
  const existing = psql(
    `SELECT l.batch_no FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
       JOIN inventory_skus s ON s.sku_id = l.sku_id
      WHERE loc.org_node_id = ${sqlStr(TOPO.HQ)} AND s.product_name = ${sqlStr(skuName)}
        AND l.quantity_on_hand >= ${needQty} AND l.batch_no IS NOT NULL
      ORDER BY l.quantity_on_hand DESC LIMIT 1`,
  )
  if (existing) return existing

  const tag = `${NS}-补货-${Date.now().toString().slice(-8)}`
  const batchNo = `${NS}-HQ${Date.now().toString().slice(-8)}`
  const replenishQty = String(Math.max(needQty * 3, 100))

  await openOperation(page, 'supply-chain', '品项公司报货需求')
  await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
  await selectContaining(skuSelect(page), skuName)
  await fillByLabel(page, '数量', replenishQty)
  await fillByLabel(page, '备注', `${tag}-req`)
  await submitForm(page, '创建品项公司报货需求', /品项公司报货需求已创建/)
  const reqId = docIdByRemark('品项公司报货需求', `${tag}-req`)

  await openOperation(page, 'supply-chain', '供应链采购订单')
  await selectByLabel(page, '品项公司报货需求', { contains: reqId })
  await page.waitForTimeout(2000)
  await selectByLabel(page, '供应商', { contains: supplierName })
  await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
  await fillByLabel(page, '采购数量', replenishQty)
  await fillByLabel(page, '备注', `${tag}-po`)
  await submitForm(page, '创建供应链采购订单', /供应链采购订单已创建/)
  const poId = docIdByRemark('供应链采购订单', `${tag}-po`)

  await openOperation(page, 'supply-chain', '供应链采购入库')
  await selectByLabel(page, '供应链采购订单', { contains: poId })
  await page.waitForTimeout(2000)
  await fillByLabel(page, '实收数量', replenishQty)
  await fillByLabel(page, '批号', batchNo)
  await fillByLabel(page, '备注', `${tag}-grk`)
  await submitForm(page, '登记供应链采购入库', /供应链采购入库单已创建/)
  return batchNo
}
