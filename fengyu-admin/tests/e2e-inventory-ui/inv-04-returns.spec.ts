/**
 * INV-04：退货双链
 *
 *   院退货：门店发起 → 市场审批 → 门店出库 + 市场回库
 *   市场退货：市场发起 → 供应链审批/驳回 → 市场出库 + 总部回库
 *
 * 核心不变量（说明.md §7.3 + engine/business 实现）：
 *   - 申请时**不扣减**来源批次，改为建立 inventory_stock_reservations（状态「已预留」）
 *   - 审批通过：预留转「已完成」+ 来源出库 + 目标入库（同一事务）
 *   - 驳回：预留转「已释放」，库存分毫不动
 *   - 退货明细的单价快照沿用配货时的门店真实单价（后续退/调以此为准）
 *
 * 前置：INV-03 跑完，门店 A 与市场均有库存。
 */

import { test, expect } from '@playwright/test'
import {
  INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import {
  clickAndExpectToast, docIdByRemark, docStatus, fillByLabel, lotQtyAll,
  openOperation, pickCandidateDoc, reservationStates, pickSku, selectByLabel, selectContaining, selectLotWithQty,
  skuSelect, submitForm,
} from './_helpers/ui'

test.setTimeout(600_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  storeReturn: `${NS}-院退货-${STAMP}`,
  marketReturnRejected: `${NS}-市场退货驳回-${STAMP}`,
  marketReturnApproved: `${NS}-市场退货通过-${STAMP}`,
}
const QTY = { storeReturn: 5, marketReturnRejected: 3, marketReturnApproved: 4 }

test('INV-04：退货双链 —— 预留机制 / 审批回库 / 驳回释放', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuId: string; supplySkuName: string }>('inv01')
  if (!inv01?.supplySkuId) throw new Error('缺少 INV-01 上下文')
  if (!isGateOpen()) openCutoverGate()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  page.on('dialog', async (d) => { await d.accept('').catch(() => null) })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ A. 院退货：门店发起 ═══════════════════════════════════════
    console.log('[INV-04] A-1 门店发起院退货')
    const storeBefore = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    const marketBefore = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)

    await openOperation(page, 'store', '门店退货申请')
    await selectByLabel(page, '退货主体', { contains: TOPO.STORE_A_NAME })
    await selectByLabel(page, '回库主体', { contains: TOPO.MARKET_NAME })
    await pickSku(skuSelect(page), inv01.supplySkuName)
    await selectLotWithQty(page, '来源批次', QTY.storeReturn)
    await fillByLabel(page, '数量', String(QTY.storeReturn))
    await fillByLabel(page, '退货原因', 'INVT-质量问题')
    await fillByLabel(page, '备注', R.storeReturn)
    await submitForm(page, '创建退货申请', /退货申请已创建/)

    const storeReturnId = docIdByRemark('院退货', R.storeReturn)
    recordVerdict(verdicts, 'doc: 院退货单落库', Boolean(storeReturnId), storeReturnId)
    recordVerdict(verdicts, 'doc: 院退货初始状态 = 待审批', docStatus(storeReturnId) === '待审批', docStatus(storeReturnId))

    // 核心不变量：申请阶段不动库存，只建预留
    const storeAfterApply = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      '§预留 申请阶段门店库存不减',
      storeAfterApply === storeBefore,
      `${storeBefore} → ${storeAfterApply}`,
    )
    const resv = reservationStates(storeReturnId)
    recordVerdict(verdicts, '§预留 申请后建立「已预留」记录', resv.includes('已预留'), resv || '(无预留)')

    // 退货单价应沿用配货时的门店真实单价（§7.3 后续退/调以此为准）
    const returnPrice = psql(
      `SELECT COALESCE(store_actual_unit_price::text, store_standard_unit_price::text, 'NULL')
         FROM inventory_doc_items WHERE doc_id = ${sqlStr(storeReturnId)} LIMIT 1`,
    )
    recordVerdict(
      verdicts,
      '§7.3 退货明细沿用门店真实单价',
      returnPrice !== 'NULL' && Number(returnPrice) > 0,
      returnPrice,
    )

    // ══ A-2. 市场审批通过 ═════════════════════════════════════════
    console.log('[INV-04] A-2 市场审批门店退货')
    await openOperation(page, 'market', '审批门店退货')
    await pickCandidateDoc(page, '待审批退货单', storeReturnId)
    await page.waitForTimeout(1500)
    await fillByLabel(page, '备注', 'INVT-同意退货')
    await clickAndExpectToast(page, '审批并回库', /退货已审批回库/)

    recordVerdict(verdicts, 'doc: 审批后转「已完成」', docStatus(storeReturnId) === '已完成', docStatus(storeReturnId))
    const storeAfterApprove = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    const marketAfterApprove = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      `stock: 审批后门店减 ${QTY.storeReturn}`,
      storeBefore - storeAfterApprove === QTY.storeReturn,
      `${storeBefore} → ${storeAfterApprove}`,
    )
    recordVerdict(
      verdicts,
      `stock: 审批后市场增 ${QTY.storeReturn}（同一事务出库+回库）`,
      marketAfterApprove - marketBefore === QTY.storeReturn,
      `${marketBefore} → ${marketAfterApprove}`,
    )
    const resvAfter = reservationStates(storeReturnId)
    recordVerdict(verdicts, '§预留 审批后预留转「已完成」', resvAfter.includes('已完成'), resvAfter)

    // ══ B. 市场退货：发起后被供应链驳回 ═══════════════════════════
    console.log('[INV-04] B-1 市场发起退货（待驳回）')
    const marketBeforeReject = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    await openOperation(page, 'market', '市场退货申请')
    await selectByLabel(page, '退货主体', { contains: TOPO.MARKET_NAME })
    await selectByLabel(page, '回库主体', { contains: '品牌总部' })
    await pickSku(skuSelect(page), inv01.supplySkuName)
    await selectLotWithQty(page, '来源批次', QTY.marketReturnRejected)
    await fillByLabel(page, '数量', String(QTY.marketReturnRejected))
    await fillByLabel(page, '退货原因', 'INVT-多发')
    await fillByLabel(page, '备注', R.marketReturnRejected)
    await submitForm(page, '创建退货申请', /退货申请已创建/)

    const rejectId = docIdByRemark('市场退货', R.marketReturnRejected)
    recordVerdict(verdicts, 'doc: 市场退货单落库', Boolean(rejectId), rejectId)
    recordVerdict(verdicts, 'doc: 市场退货初始状态 = 待审批', docStatus(rejectId) === '待审批', docStatus(rejectId))

    console.log('[INV-04] B-2 供应链驳回')
    await openOperation(page, 'supply-chain', '审批市场退货')
    await pickCandidateDoc(page, '待审批退货单', rejectId)
    await page.waitForTimeout(1500)
    await fillByLabel(page, '备注', 'INVT-不同意退货')
    await clickAndExpectToast(page, '驳回退货', /退货申请已驳回/)

    recordVerdict(verdicts, 'doc: 驳回后转「已驳回」', docStatus(rejectId) === '已驳回', docStatus(rejectId))
    const marketAfterReject = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      '§预留 驳回后库存分毫未动',
      marketAfterReject === marketBeforeReject,
      `${marketBeforeReject} → ${marketAfterReject}`,
    )
    const resvRejected = reservationStates(rejectId)
    recordVerdict(verdicts, '§预留 驳回后预留转「已释放」', resvRejected.includes('已释放'), resvRejected)
    recordVerdict(
      verdicts,
      'doc: 已驳回是终态（不产生库存流水）',
      Number(psql(`SELECT count(*) FROM inventory_movements WHERE doc_id = ${sqlStr(rejectId)}`)) === 0,
      'movements=0',
    )

    // ══ C. 市场退货：发起后被供应链通过 ═══════════════════════════
    console.log('[INV-04] C-1 市场再发起退货（待通过）')
    const hqBeforeApprove = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
    const marketBeforeApprove = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    await openOperation(page, 'market', '市场退货申请')
    await selectByLabel(page, '退货主体', { contains: TOPO.MARKET_NAME })
    await selectByLabel(page, '回库主体', { contains: '品牌总部' })
    await pickSku(skuSelect(page), inv01.supplySkuName)
    await selectLotWithQty(page, '来源批次', QTY.marketReturnApproved)
    await fillByLabel(page, '数量', String(QTY.marketReturnApproved))
    await fillByLabel(page, '退货原因', 'INVT-滞销')
    await fillByLabel(page, '备注', R.marketReturnApproved)
    await submitForm(page, '创建退货申请', /退货申请已创建/)
    const approveId = docIdByRemark('市场退货', R.marketReturnApproved)

    console.log('[INV-04] C-2 供应链审批通过')
    await openOperation(page, 'supply-chain', '审批市场退货')
    await pickCandidateDoc(page, '待审批退货单', approveId)
    await page.waitForTimeout(1500)
    await fillByLabel(page, '备注', 'INVT-同意')
    await clickAndExpectToast(page, '审批并回库', /退货已审批回库/)

    recordVerdict(verdicts, 'doc: 市场退货审批后「已完成」', docStatus(approveId) === '已完成', docStatus(approveId))
    const marketAfterApprove2 = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    const hqAfterApprove = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
    recordVerdict(
      verdicts,
      `stock: 市场减 ${QTY.marketReturnApproved}`,
      marketBeforeApprove - marketAfterApprove2 === QTY.marketReturnApproved,
      `${marketBeforeApprove} → ${marketAfterApprove2}`,
    )
    recordVerdict(
      verdicts,
      `stock: 总部增 ${QTY.marketReturnApproved}`,
      hqAfterApprove - hqBeforeApprove === QTY.marketReturnApproved,
      `${hqBeforeApprove} → ${hqAfterApprove}`,
    )
    // 审批通过会生成配对的「供应链退货入库」单
    const restockDoc = psql(
      `SELECT to_doc_id FROM inventory_doc_links
        WHERE from_doc_id = ${sqlStr(approveId)} AND relation_type = '退货回库' LIMIT 1`,
    )
    recordVerdict(
      verdicts,
      'link: 生成配对的退货回库单',
      Boolean(restockDoc),
      restockDoc || '(未找到「退货回库」关系)',
    )

    writeCtx('inv04', { storeReturnId, rejectId, approveId })
  } finally {
    await ctx.close()
    summarize(4, verdicts)
  }

  const ux = verdicts.filter((v) => v.verdict === 'FAIL' && v.check.startsWith('UX-'))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !v.check.startsWith('UX-'))
  if (ux.length > 0) console.log(`\n[INV-04] ⚠️ UX 发现:\n${JSON.stringify(ux, null, 2)}`)
  expect(functional, `INV-04 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
