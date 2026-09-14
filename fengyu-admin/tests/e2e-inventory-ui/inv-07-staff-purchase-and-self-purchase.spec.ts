/**
 * INV-07：员工购 / 自采入库 / 内部领用
 *
 *   市场员工购（§1.4：走市场员工购价，不计入门店营收，直接算市场收入）
 *   供应链员工购（§11.1/§11.2：只能从有权限的总部库存出库；员工须属该总部组织树
 *                 且未归属任何市场/门店；只允许供应链 SKU；不创建销售单、不计入营收）
 *   自采产品入库（§4：市场财务自办，入库后可像正常产品一样配货给门店）
 *
 * ⚠️ 两处已确认的产品缺陷，导致本 spec 大部分断言无法执行：
 *
 *   BUG-EMPLOYEE-CTE（P0，100% 必现）
 *     src/lib/inventory/business.ts 有 5 处递归 CTE 写错了别名引用 ——
 *     CTE 在 JOIN 时起了别名（`JOIN descendants parent` / `JOIN ancestors ancestor`），
 *     但 SELECT/WHERE 仍用原名（`descendants.path` / `ancestors.path`），
 *     PostgreSQL 直接报 `invalid reference to FROM-clause entry`。
 *     位置：1234、1263、1273、1329、1371。
 *     后果：listMarketEmployeeOptions / listSupplyChainEmployeeOptions 必然抛错
 *     → 员工下拉恒为空 → **市场员工购与供应链员工购完全不可用**；
 *     即使绕过下拉，提交时的 employeeForMarket / employeeForSupplyChain 校验同样会炸。
 *     这不是数据问题：dev 库按正确 SQL 能查出 85 / 115 个候选员工。
 *
 *   BUG-LOT-LOADING（P0）
 *     内部领用需选来源批次，受此阻断（见 INV-05）。
 */

import { test, expect } from '@playwright/test'
import {
  INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import {
  docIdByRemark, docStatus, fillByLabel, labelled, lotQtyAll, openOperation, peekToast,
  selectByLabel, selectContaining, selectLotWithQty, skuSelect, submitForm,
} from './_helpers/ui'

/** 轮询等待下拉出现真实选项（首项是占位）；最长 20 秒 */
async function waitForOptions(sel: import('@playwright/test').Locator): Promise<string[]> {
  for (let i = 0; i < 20; i += 1) {
    const texts = await sel.locator('option').allTextContents()
    if (texts.length > 1) return texts
    await sel.page().waitForTimeout(1000)
  }
  return await sel.locator('option').allTextContents()
}

test.setTimeout(500_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  marketStaff: `${NS}-市场员工购-${STAMP}`,
  supplyStaff: `${NS}-供应链员工购-${STAMP}`,
  selfPurchase: `${NS}-自采入库-${STAMP}`,
}
const QTY = { marketStaff: 2, supplyStaff: 2, selfPurchase: 40 }

test('INV-07：员工购 / 自采入库 / 内部领用受阻', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{
    supplySkuId: string; supplySkuName: string
    selfSkuId: string; selfSkuName: string; supplierName: string
  }>('inv01')
  if (!inv01?.supplySkuId) throw new Error('缺少 INV-01 上下文')
  if (!isGateOpen()) openCutoverGate()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  page.on('dialog', async (d) => { await d.accept('').catch(() => null) })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ A. 市场员工购（§1.4）══════════════════════════════════════
    console.log('[INV-07] A 市场员工购')
    const marketBefore = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    await openOperation(page, 'market', '市场员工购')
    await selectByLabel(page, '市场', { contains: TOPO.MARKET_NAME })
    // toast 只存活约 4 秒，必须在选完市场后**立刻**抓，否则轮询完再抓永远是空
    const marketStaffToast = await peekToast(page, 5000)

    const staffSel = labelled(page, '购买员工').locator('select').first()
    const staffOptions = await waitForOptions(staffSel)
    recordVerdict(
      verdicts,
      'BUG-EMPLOYEE-CTE: 市场员工购的员工下拉应有候选（当前必为空）',
      staffOptions.length > 1,
      staffOptions.length > 1
        ? `候选数=${staffOptions.length - 1}`
        : `候选数=0；页面提示="${marketStaffToast}"`,
    )
    if (staffOptions.length > 1) {
      await staffSel.selectOption({ index: 1 })
      await selectContaining(skuSelect(page), inv01.supplySkuName)
      await selectLotWithQty(page, '市场批次', QTY.marketStaff)
      await fillByLabel(page, '数量', String(QTY.marketStaff))
      await fillByLabel(page, '备注', R.marketStaff)
      await submitForm(page, '创建员工购出库单', /市场员工购出库单已创建/)

      const ygId = docIdByRemark('员工购出库', R.marketStaff)
      recordVerdict(verdicts, 'doc: 市场员工购出库单落库', Boolean(ygId), ygId)
      recordVerdict(verdicts, 'doc: 单号前缀 YGG', ygId.startsWith('YGG'), ygId)
      recordVerdict(verdicts, 'doc: 建单即完成', docStatus(ygId) === '已完成', docStatus(ygId))
      const marketAfter = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `stock: 市场库存减 ${QTY.marketStaff}`,
        marketBefore - marketAfter === QTY.marketStaff,
        `${marketBefore} → ${marketAfter}`,
      )
      // §1.4：员工购按市场员工购价计价，不计入门店营收（不产生销售单）
      const ygAmount = psql(`SELECT COALESCE(total_amount::text,'NULL') FROM inventory_docs WHERE id = ${sqlStr(ygId)}`)
      recordVerdict(verdicts, '§1.4 员工购单金额按市场员工购价核算', Number(ygAmount) > 0, ygAmount)
      const ygSaleOrder = psql(
        `SELECT COALESCE(related_sale_order_id,'') FROM inventory_docs WHERE id = ${sqlStr(ygId)}`,
      )
      recordVerdict(verdicts, '§1.4 员工购不关联销售单（不计门店营收）', ygSaleOrder === '', ygSaleOrder || '(空)')
      recordVerdict(
        verdicts,
        '§10.3 员工购单归属所选市场',
        psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(ygId)}`) === TOPO.MARKET,
        psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(ygId)}`),
      )
      writeCtx('inv07_market_staff', { ygId })
    }

    // ══ B. 供应链员工购（§11.1/§11.2）═════════════════════════════
    console.log('[INV-07] B 供应链员工购')
    const hqBefore = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
    await openOperation(page, 'supply-chain', '供应链员工购')
    await selectByLabel(page, '供应链总部', { contains: '品牌总部' })
    const scStaffToast = await peekToast(page, 5000)

    const scStaffSel = labelled(page, '购买员工').locator('select').first()
    const scStaffOptions = await waitForOptions(scStaffSel)
    recordVerdict(
      verdicts,
      'BUG-EMPLOYEE-CTE: 供应链员工购的员工下拉应有候选（当前必为空）',
      scStaffOptions.length > 1,
      scStaffOptions.length > 1
        ? `候选数=${scStaffOptions.length - 1}`
        : `候选数=0；页面提示="${scStaffToast}"`,
    )
    if (scStaffOptions.length > 1) {
      await scStaffSel.selectOption({ index: 1 })
      await selectContaining(skuSelect(page), inv01.supplySkuName)
      await selectLotWithQty(page, '供应链批次', QTY.supplyStaff)
      await fillByLabel(page, '数量', String(QTY.supplyStaff))
      await fillByLabel(page, '备注', R.supplyStaff)
      await submitForm(page, '创建供应链员工购出库单', /供应链员工购出库单已创建/)

      const gygId = docIdByRemark('供应链员工购出库', R.supplyStaff)
      recordVerdict(verdicts, 'doc: 供应链员工购出库单落库', Boolean(gygId), gygId)
      recordVerdict(verdicts, 'doc: 单号前缀 GYG', gygId.startsWith('GYG'), gygId)
      const hqAfter = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `§11.1 只扣总部库存（减 ${QTY.supplyStaff}）`,
        hqBefore - hqAfter === QTY.supplyStaff,
        `${hqBefore} → ${hqAfter}`,
      )
      // §10.3：总部单据不带市场归属
      const gygMarket = psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(gygId)}`)
      recordVerdict(verdicts, '§10.3 总部单据不带市场归属', gygMarket === '', gygMarket || '(空)')
      recordVerdict(
        verdicts,
        '§11.2 不创建销售单',
        psql(`SELECT COALESCE(related_sale_order_id,'') FROM inventory_docs WHERE id = ${sqlStr(gygId)}`) === '',
        '(空)',
      )
      writeCtx('inv07_supply_staff', { gygId })
    }

    // ══ C. 自采产品入库（§4）══════════════════════════════════════
    console.log('[INV-07] C 自采产品入库')
    const selfBefore = lotQtyAll(TOPO.MARKET, inv01.selfSkuId)
    await openOperation(page, 'market', '自采产品入库')
    await selectByLabel(page, '入库市场', { contains: TOPO.MARKET_NAME })
    await selectByLabel(page, '供应商', { contains: inv01.supplierName })
    await page.waitForTimeout(1500)
    await selectContaining(skuSelect(page), inv01.selfSkuName)
    await fillByLabel(page, '数量', String(QTY.selfPurchase))
    const selfBatch = `${NS}-ZC${STAMP}`
    await fillByLabel(page, '批号', selfBatch)
    await fillByLabel(page, '实际采购单价', '260')
    await fillByLabel(page, '备注', R.selfPurchase)
    await submitForm(page, '创建自采产品入库单', /自采产品入库单已创建/)

    const zrkId = docIdByRemark('自采产品入库', R.selfPurchase)
    recordVerdict(verdicts, 'doc: 自采产品入库单落库', Boolean(zrkId), zrkId)
    recordVerdict(verdicts, 'doc: 单号前缀 ZRK', zrkId.startsWith('ZRK'), zrkId)
    recordVerdict(verdicts, 'doc: 自采入库建单即完成', docStatus(zrkId) === '已完成', docStatus(zrkId))
    const selfAfter = lotQtyAll(TOPO.MARKET, inv01.selfSkuId)
    recordVerdict(
      verdicts,
      `§4 自采产品入市场库（增 ${QTY.selfPurchase}）`,
      selfAfter - selfBefore === QTY.selfPurchase,
      `${selfBefore} → ${selfAfter}`,
    )
    recordVerdict(
      verdicts,
      '§4 自采入库归属发起市场',
      psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(zrkId)}`) === TOPO.MARKET,
      psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(zrkId)}`),
    )
    recordVerdict(
      verdicts,
      '§4 自采入库关联供应商档案',
      Boolean(psql(`SELECT COALESCE(supplier_id,'') FROM inventory_docs WHERE id = ${sqlStr(zrkId)}`)),
      psql(`SELECT COALESCE(supplier_name, supplier_id, '') FROM inventory_docs WHERE id = ${sqlStr(zrkId)}`),
    )

    // ══ D. 内部领用受阻 ═══════════════════════════════════════════
    recordVerdict(
      verdicts,
      'BLOCKED: 无法创建「内部领用」（需选来源批次，受 BUG-LOT-LOADING 阻断）',
      false,
      '见 INV-05',
    )

    writeCtx('inv07', { selfBatch, selfSkuId: inv01.selfSkuId })
  } finally {
    await ctx.close()
    summarize(7, verdicts)
  }

  const known = verdicts.filter((v) => v.verdict === 'FAIL' && /^(BLOCKED:|BUG-|UX-)/.test(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !/^(BLOCKED:|BUG-|UX-)/.test(v.check))
  if (known.length > 0) console.log(`\n[INV-07] ⛔ 已知缺陷/受阻:\n${JSON.stringify(known, null, 2)}`)
  expect(functional, `INV-07 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
