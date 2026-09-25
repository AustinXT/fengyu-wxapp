/**
 * INV-03：三级正向主链（P0 主干）
 *
 * 门店报货 → 市场汇总 → 市场报货 → 市场报货汇总 → 采购订单（市场行）→ 供应链采购入库（#335）
 *   → 品项公司发货（含赠送）→ 市场采购入库 → 分院配货 → 分院收货入库 → 货款结算
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
 *   门店报货 20 → 市场实际采购 30（≠汇总，验 §3.2 手填）→ 采购订单 30 → 供应链采购入库 30
 *   → 发货 25 + 赠送 5（引用市场报货单，#336；从刚入库的批次发出；总量 30 > 门店报货 20，验 §5.2）→ 市场入库 30
 *   → 分院配货 20 + 赠送 2 → 门店收货 22
 *
 * #335 起采购订单的市场行也经供应链采购入库进总部库存，本 spec 不再用
 * 「品项公司报货需求补货」给总部预备批次，发货直接从本采购单入库的批次出。
 * 分批入库、超量/已关闭单入库被拒的正反向由 smoke-inventory-chain 覆盖。
 *
 * 前置：INV-02 已开闸。
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import { pickCandidateDoc, pickSku } from './_helpers/ui'

test.setTimeout(600_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  storeReq: `${NS}-门店报货-${STAMP}`,
  marketReq: `${NS}-市场报货-${STAMP}`,
  summary: `${NS}-报货汇总-${STAMP}`,
  po: `${NS}-采购订单-${STAMP}`,
  shipment: `${NS}-品项发货-${STAMP}`,
  marketReceipt: `${NS}-市场入库-${STAMP}`,
  allocation: `${NS}-分院配货-${STAMP}`,
  storeReceipt: `${NS}-门店收货-${STAMP}`,
}

const QTY = {
  storeRequest: 20,
  marketPurchase: 30,
  shipNormal: 25,
  shipGift: 5,
  marketReceive: 30,
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

    // ══ 1. 门店报货（§1.3 不体现价格）══════════════════════════════
    console.log('[INV-03] 1/8 门店报货')
    await openOperation(page, 'store', '门店报货')
    await selectByLabel(page, '报货门店', { contains: TOPO.STORE_A_NAME })
    await selectByLabel(page, '所属市场', { contains: TOPO.MARKET_NAME })
    await pickSku(skuSelect(page), inv01.supplySkuName)
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

    // ══ 3. 市场报货汇总 → 采购订单 ══════════════════════════════
    // #193/#194：采购订单不再直接引用市场报货单，中间多一层跨市场汇总。
    console.log('[INV-03] 3/8 市场报货汇总 → 采购订单')
    await openOperation(page, 'supply-chain', '市场报货汇总')
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await page.getByRole('button', { name: '汇总各市场报货' }).click()
    await page.waitForTimeout(2000)
    // #194：「本次汇总」是表格的 <th>，行内 Input 在 <td> 里没有 <label> 可包裹 ——
    // 本文件的 fillByLabel（见下方 labelled()，locator('label').filter(...)）必然超时。
    // 可访问名改由 inventory-operations-page.tsx 的 MarketReportSummaryForm 用
    // aria-label 给出，实际文案是 `本次汇总 ${skuName} ${specName || skuId} ${marketName}`
    // （源码 :1754 的 rowName，勾选框同款前缀式，字段名在前）。
    // ⚠️ type="number" 的 ARIA role 是 spinbutton，不是 textbox。
    // 只用**前缀**匹配到商品名为止：规格名取决于 SKU 主数据，E2E 这边拿不到。
    // 商品名后补一个空格是必须的 —— rowName 里商品名之后恒有 `${specName || skuId}`
    // （skuId 非空，故分隔空格一定存在），不补空格时 `INVT-SKU-123` 会连带命中
    // `INVT-SKU-1234` 那行。同一 SKU 跨多市场仍可能多行命中，故再 .first() 兜底
    // （本轮只有一个市场在报货）。
    await page
      .getByRole('spinbutton', { name: new RegExp(`^本次汇总 ${escapeRe(inv01.supplySkuName)} `) })
      .first()
      .fill(String(QTY.marketPurchase))
    await fillByLabel(page, '备注', R.summary)
    await submitForm(page, '创建市场报货汇总单', /市场报货汇总单已创建/)
    const summaryId = docIdByRemark('市场报货汇总', R.summary)
    recordVerdict(verdicts, 'doc: 市场报货汇总单落库', Boolean(summaryId), summaryId)

    await openOperation(page, 'supply-chain', '采购订单')
    await pickCandidateDoc(page, '来源报货单', summaryId)
    await page.waitForTimeout(2000)
    await selectByLabel(page, '供应链库存主体', { label: '品牌总部' })
    await fillByLabel(page, '采购数量', String(QTY.marketPurchase))
    await fillByLabel(page, '备注', R.po)
    await submitForm(page, '创建采购订单', /采购订单已创建/)

    const poId = docIdByRemark('采购订单', R.po)
    recordVerdict(verdicts, 'doc: 采购订单落库', Boolean(poId), poId)
    // #335：市场行也经供应链采购入库，纯市场行的单同样从「待收货」开始。
    recordVerdict(
      verdicts,
      'doc: 纯市场行的采购订单建单为待收货（#335）',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`) === '待收货',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`),
    )
    recordVerdict(
      verdicts,
      'doc: 采购订单金额 = 采购数量 × 供应链采购价（#335）',
      psql(`SELECT COUNT(*) FROM inventory_doc_items WHERE doc_id = ${sqlStr(poId)} AND NOT is_gift
              AND amount IS DISTINCT FROM ROUND(quantity * supply_chain_unit_cost, 2)`) === '0',
      'mismatch=0',
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

    // ══ 3b. 供应链采购入库（#335：市场行生成总部批次）══════════════
    console.log('[INV-03] 3b/8 供应链采购入库（市场行）')
    const hqBatch = `${NS}-MKT${STAMP}`
    await openOperation(page, 'supply-chain', '供应链采购入库')
    await pickCandidateDoc(page, '采购订单', poId)
    await page.waitForTimeout(2000)
    await fillByLabel(page, '实收数量', String(QTY.marketPurchase))
    await fillByLabel(page, '批号', hqBatch)
    await fillByLabel(page, '备注', `${R.po}-grk`)
    await submitForm(page, '登记供应链采购入库', /供应链采购入库单已创建/)
    recordVerdict(
      verdicts,
      'doc: 市场行全部入库后采购订单转「已完成」（#335）',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`) === '已完成',
      psql(`SELECT status FROM inventory_docs WHERE id = ${sqlStr(poId)}`),
    )
    recordVerdict(
      verdicts,
      `stock: 市场行入库生成总部批次 ${QTY.marketPurchase}（#335）`,
      lotQty(TOPO.HQ, inv01.supplySkuId, hqBatch) === QTY.marketPurchase,
      String(lotQty(TOPO.HQ, inv01.supplySkuId, hqBatch)),
    )
    recordVerdict(
      verdicts,
      'link: 入库明细可追溯到采购行及其市场来源（#335）',
      psql(`SELECT COUNT(*) FROM inventory_doc_links l
              JOIN inventory_doc_items po_item ON po_item.id = l.from_item_id
             WHERE l.from_doc_id = ${sqlStr(poId)}
               AND l.relation_type = '采购订单供应链采购入库'
               AND po_item.market_id IS NOT NULL`) !== '0',
      'link 存在',
    )

    // ══ 4. 品项公司发货（§5.2 赠送 / §5.3 无金额）═════════════════
    // #336：发货直接引用市场报货单（不再选采购订单）：先定收货市场与发货总部，再勾报货单，
    // 每条报货明细默认一行正常发货（= 未发量），逐行选总部批次；赠送另加一行、单独选批次。
    console.log('[INV-03] 4/8 品项公司发货')
    const hqBefore = lotQty(TOPO.HQ, inv01.supplySkuId, hqBatch)
    await openOperation(page, 'supply-chain', '品项公司发货')
    await selectByLabel(page, '收货市场', { contains: TOPO.MARKET_NAME })
    await selectByLabel(page, '发货总部', { label: '品牌总部' })
    await pickCandidateDoc(page, '市场报货单', marketReqId)
    const shipProgress = page.getByRole('status', { name: '未发进度' })
    await expect(shipProgress).toContainText(`还有 ${QTY.marketPurchase} 件未发`, { timeout: 20_000 })
    recordVerdict(verdicts, `#336 发货表单顶部显示「还有 ${QTY.marketPurchase} 件未发」`, true, await shipProgress.innerText())

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
    await page.getByRole('button', { name: '加赠送' }).click()
    // 赠送行是第二个「发货批次」：与正常行同一个总部批次出库，市场收货后落成独立的赠送批次
    const giftLot = labelled(page, '发货批次').nth(1).locator('select')
    await expect(giftLot).toBeEnabled({ timeout: 20_000 })
    await selectContaining(giftLot, hqBatch)
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
      `§5.2 发货量(${QTY.shipNormal}+赠送${QTY.shipGift}) 可大于报货量(${QTY.storeRequest})`,
      Number(shipQty) === QTY.shipNormal + QTY.shipGift,
      shipQty,
    )
    const giftAmount = psql(
      `SELECT COALESCE(SUM(amount),0)::text FROM inventory_doc_items
        WHERE doc_id = ${sqlStr(shipId)} AND is_gift = true`,
    )
    recordVerdict(verdicts, '§10.2 赠品金额恒为 0', Number(giftAmount) === 0, giftAmount)
    recordVerdict(
      verdicts,
      `link: 市场报货 → 品项公司发货 直连血缘（正常 ${QTY.shipNormal} / 赠送 ${QTY.shipGift}，#336）`,
      psql(`SELECT string_agg(relation_type || '=' || quantity::int, ',' ORDER BY relation_type)
              FROM inventory_doc_links
             WHERE from_doc_id = ${sqlStr(marketReqId)} AND to_doc_id = ${sqlStr(shipId)}`)
        === `市场报货发货=${QTY.shipNormal},市场报货赠送发货=${QTY.shipGift}`,
      'link 存在',
    )
    // 验收：发货单详情能跳到原始报货单
    await page.goto(`${BASE}/inventory/docs/${encodeURIComponent(shipId)}`)
    const reportLink = page.getByRole('link', { name: marketReqId })
    await expect(reportLink).toBeVisible({ timeout: 20_000 })
    recordVerdict(verdicts, '#336 发货单详情血缘带出原始市场报货单并可跳转', true, marketReqId)

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
    await pickCandidateDoc(page, '品项公司发货单', shipId)
    await page.waitForTimeout(2000)
    const marketReceiveRows = await fillReceiptRows(page)
    recordVerdict(
      verdicts,
      'ui: 市场采购入库的「本次实收」输入可定位并填入',
      marketReceiveRows > 0,
      `已填行数=${marketReceiveRows}`,
    )
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
    await pickCandidateDoc(page, '门店报货单', storeReqId)
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
    await pickCandidateDoc(page, '分院配货单', allocId)
    await page.waitForTimeout(2000)
    const storeReceiveRows = await fillReceiptRows(page)
    recordVerdict(
      verdicts,
      'ui: 分院收货入库的「本次实收」输入可定位并填入',
      storeReceiveRows > 0,
      `已填行数=${storeReceiveRows}`,
    )
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
 * （如「采购订单」既是 supply-chain 的卡片标题又出现在表单提交按钮里），
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

/**
 * 收货进度表：逐行把「待收」数量抄进「本次实收」，返回实际填了几行。
 * 市场采购入库与分院收货入库共用同一份源码（ShipmentReceiptForm），故共用本函数。
 *
 * ⚠️ 不能再用 `input[inputmode=decimal]` 定位 —— #135 已把这些输入换成 `type="number"`，
 * 页面上根本没有 inputmode 属性，`count()` 恒为 0：循环一次都不执行，整步**静默空转**，
 * 只是靠表单预填的待收量碰巧提交成功（回归时同样不会报警）。
 * type=number 的 ARIA role 是 **spinbutton**（不是 textbox），行内控件没有 <label>，
 * 可访问名由 aria-label 给出（`本次实收 <商品名> 第N行`，#194）。
 *
 * 这里按**行**取控件而不是按可访问名匹配：同一 SKU 的赠品行与正常行连商品名带 skuId
 * 都相同，只有行序号能区分；按行定位与「待收」列天然同源，不会错位。
 * 返回值交调用方记 verdict —— 行数为 0 必须响亮失败，别再退回静默空转。
 */
async function fillReceiptRows(page: Page): Promise<number> {
  const rows = page.locator('form tbody tr')
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => null)
  const total = await rows.count()
  let filled = 0
  for (let i = 0; i < total; i += 1) {
    const row = rows.nth(i)
    // 每行只有一个数值输入（本次实收）；明细备注是普通 text → textbox，不会被误取
    const input = row.getByRole('spinbutton').first()
    if (await input.count() === 0) continue
    const outstanding = (await row.locator('td').nth(3).innerText()).trim()   // td[3] = 待收
    await input.fill(outstanding)
    filled += 1
  }
  return filled
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
  return page.getByRole('combobox', { name: '选择库存商品', exact: true }).first()
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
