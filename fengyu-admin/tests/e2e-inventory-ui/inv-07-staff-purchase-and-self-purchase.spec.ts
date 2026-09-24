/**
 * INV-07：员工购 / 自采入库 / 内部领用 / 院顾客产品出库不可通用建单（#350 负向守护）
 *
 *   市场员工购（§1.4：走市场员工购价，不计入门店营收，直接算市场收入）
 *   供应链员工购（§11.1/§11.2：只能从有权限的总部库存出库；员工须属该总部组织树
 *                 且未归属任何市场/门店；只允许供应链 SKU；不创建销售单、不计入营收）
 *   自采产品入库（§4：市场财务自办，入库后可像正常产品一样配货给门店）
 *   内部领用（通用建单出库类，建单即完成）；院顾客产品出库 #350 起只走提货，这里只做负向守护
 *
 * #130（员工购递归 CTE 别名错）已修：business.ts:1301-1348 / 1396-1456 现在都是
 * 无别名的 `JOIN descendants ON …` / `JOIN ancestors ON …`，
 * listMarketEmployeeOptions / listSupplyChainEmployeeOptions 能正常返回候选。
 * A/B 两段的「员工下拉有候选」已从 `BUG-` 豁免项**转为正式守护** —— 退化即红，
 * 且候选数会经 ctx 交给 INV-10 转述（见文末 writeCtx('inv07')）。
 *
 * D 段补齐 SOURCE_LOT 六类出库里剩下的两种（#129 验收标准第 2 条要求六种全覆盖；
 * 分院调货出库 / 市场间调货出库由 INV-05 覆盖，两种报损由 INV-06 覆盖）：
 *   内部领用（NLY）—— 出库主体必须是**总部**（engine.ts:813-816），
 *                      同主体类型，source/target 传同一个（:266-281）。
 *   院顾客产品出库（GCK）—— **#350 起不再能从通用建单入口创建**：顾客出库必须绑定销售单，
 *                      只能由提货服务（提货录入页 createPickupRecord / 小程序提货）产生。
 *                      D-2 改为断言单据中心的新建类型下拉里已没有它（负向守护）；
 *                      提货生成 GCK 的正向链路由 staff L2 smoke-order-pickup 覆盖。
 */

import { test, expect } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import {
  createGenericDoc, docIdByRemark, docMovementCount, docStatus, fillByLabel, labelled,
  lotQtyAll, openOperation, peekToast,
  pickSku, selectByLabel, selectContaining, selectLotWithQty, skuSelect, submitForm,
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
  internalUse: `${NS}-内部领用-${STAMP}`,
}
// internalUse 走总部库存（充裕）。#350 前 customerOut 走门店 A；顾客出库已改走提货，D-2 只做负向守护
const QTY = { marketStaff: 2, supplyStaff: 2, selfPurchase: 40, internalUse: 2 }

test('INV-07：员工购 / 自采入库 / 内部领用 / 院顾客产品出库不可通用建单', async ({ browser }) => {
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
    // #130 守护（原为 `BUG-EMPLOYEE-CTE: …（当前必为空）` 的豁免项）：
    // listMarketEmployeeOptions 的递归 CTE 一旦再写错别名，PG 报
    // `invalid reference to FROM-clause entry`，下拉就会退回「只剩占位项」。
    recordVerdict(
      verdicts,
      '§1.4 市场员工购的员工下拉有候选（#130 守护）',
      staffOptions.length > 1,
      staffOptions.length > 1
        ? `候选数=${staffOptions.length - 1}`
        : `候选数=0；页面提示="${marketStaffToast}"`,
    )
    if (staffOptions.length > 1) {
      await staffSel.selectOption({ index: 1 })
      await pickSku(skuSelect(page), inv01.supplySkuName)
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
    // #130 守护，同 A 段；供应链侧走 listSupplyChainEmployeeOptions（business.ts:1396-1456）
    recordVerdict(
      verdicts,
      '§11.1 供应链员工购的员工下拉有候选（#130 守护）',
      scStaffOptions.length > 1,
      scStaffOptions.length > 1
        ? `候选数=${scStaffOptions.length - 1}`
        : `候选数=0；页面提示="${scStaffToast}"`,
    )

    /*
     * 判定一出来就立刻写盘 —— 不攒到 spec 末尾。
     * C/D 两段是真实 UI 链路，中途抛出会让 ctx 停在**上一轮**的候选数上，
     * INV-10 据此生成的 UX-FINDINGS.md 就是假情报（同 inv-01 / inv-06 的做法）。
     * D 段跑完后会带着 nlyId 再写一次，展开同一份 employeeCtx，字段不丢。
     *
     * ⚠️ 两套键名、两种口径，别互相赋值：
     *   - `marketStaffOptionCount` / `supplyStaffOptionCount` 是 INV-10 实际读的键
     *     （inv-10-ux-audit.spec.ts:239-245），口径是**含占位项**的 option 总数 ——
     *     它按 `<= 1` 判「恒为空」。
     *   - `employeeOptionsOk` / `marketStaffCount` / `supplyStaffCount` 是本轮三条线
     *     约定的 ctx 契约键，口径是**去掉占位项**的真实候选数。
     */
    const employeeCtx = {
      at: new Date().toISOString(),
      employeeOptionsOk: staffOptions.length > 1 && scStaffOptions.length > 1,
      marketStaffCount: Math.max(0, staffOptions.length - 1),
      supplyStaffCount: Math.max(0, scStaffOptions.length - 1),
      marketStaffOptionCount: staffOptions.length,
      supplyStaffOptionCount: scStaffOptions.length,
    }
    writeCtx('inv07', employeeCtx)

    if (scStaffOptions.length > 1) {
      await scStaffSel.selectOption({ index: 1 })
      await pickSku(skuSelect(page), inv01.supplySkuName)
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
    await pickSku(skuSelect(page), inv01.selfSkuName)
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

    // ══ D. 通用建单出库类：内部领用（+ #350 院顾客产品出库负向守护）════
    // 两者都是 OUTBOUND 且不在 APPROVAL_DOC_TYPES 里 → defaultStatusForDoc 给「已完成」，
    // 建单事务内直接 applyMovement 扣减（engine.ts:3282-3292），没有第二拍。

    // ── D-1 内部领用（NLY）：出库主体必须是总部 ──────────────────
    console.log('[INV-07] D-1 内部领用')
    const hqBeforeUse = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
    const nlyCreated = await createGenericDoc(page, {
      docType: '内部领用',
      // 同主体类型（INTERNAL_SAME_NODE，engine.ts:266-281）：两端必须一致，
      // 不一致服务端按 #200 AC4 直接拒单，所以这里两端都传总部。
      sourceLabel: '总部 · 品牌总部',
      targetLabel: '总部 · 品牌总部',
      skuName: inv01.supplySkuName,
      quantity: QTY.internalUse,
      remark: R.internalUse,
      needLot: true,
    })
    const nlyId = docIdByRemark('内部领用', R.internalUse)
    recordVerdict(
      verdicts,
      'doc: 内部领用单落库',
      Boolean(nlyId),
      nlyId || `建单未成功，页面提示：${nlyCreated.toast || '(无 toast)'}`,
    )
    if (nlyId) {
      recordVerdict(verdicts, 'doc: 单号前缀 NLY', nlyId.startsWith('NLY'), nlyId)
      recordVerdict(verdicts, 'doc: 内部领用建单即完成', docStatus(nlyId) === '已完成', docStatus(nlyId))
      const hqAfterUse = lotQtyAll(TOPO.HQ, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `stock: 内部领用扣减总部库存（减 ${QTY.internalUse}）`,
        hqBeforeUse - hqAfterUse === QTY.internalUse,
        `${hqBeforeUse} → ${hqAfterUse}`,
      )
      const nlyMoves = docMovementCount(nlyId)
      const nlyDir = psql(`SELECT direction FROM inventory_movements WHERE doc_id = ${sqlStr(nlyId)} LIMIT 1`)
      recordVerdict(
        verdicts,
        'movement: 内部领用产生 1 条出库流水',
        nlyMoves === 1 && nlyDir === '出库',
        `count=${nlyMoves} / direction=${nlyDir || '(无)'}`,
      )
      // §10.3：总部既不是市场、也没有母市场（0039 的 inventory_location_market_id
      // 对 '总部' 返回 NULL），所以总部单据不带市场归属 —— 与 B 段的 GYG 同口径。
      const nlyMarket = psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(nlyId)}`)
      recordVerdict(verdicts, '§10.3 内部领用（总部单据）不带市场归属', nlyMarket === '', nlyMarket || '(空)')
      recordVerdict(
        verdicts,
        '内部领用不关联销售单',
        psql(`SELECT COALESCE(related_sale_order_id,'') FROM inventory_docs WHERE id = ${sqlStr(nlyId)}`) === '',
        '(空)',
      )
    }

    // ── D-2 院顾客产品出库（GCK）不再能从通用入口建（#350）───────────
    console.log('[INV-07] D-2 院顾客产品出库不在通用建单下拉里')
    await page.goto(`${BASE}/inventory/docs`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建/ }).first().click()
    const createDialog = page.getByRole('dialog').filter({ hasText: '新建库存单据' })
    await expect(createDialog.getByText('新建库存单据')).toBeVisible({ timeout: 15_000 })
    const docTypeOptions = await createDialog.locator('select').first().locator('option').allTextContents()
    // 正向锚点：先确认拿到的真是单据类型下拉、且超管可建类型没被意外收窄 ——
    // 否则「不含院顾客产品出库」在一个空下拉或别的下拉上恒真（评审 P3）
    recordVerdict(
      verdicts,
      '#350 新建类型下拉是完整的 9 种通用类型（含院顾客退货）',
      docTypeOptions.includes('院顾客退货') && docTypeOptions.length === 9,
      JSON.stringify(docTypeOptions),
    )
    recordVerdict(
      verdicts,
      '#350 单据中心新建类型下拉不含「院顾客产品出库」（顾客出库只走提货）',
      !docTypeOptions.includes('院顾客产品出库'),
      JSON.stringify(docTypeOptions),
    )
    await page.keyboard.press('Escape').catch(() => null)

    writeCtx('inv07', { ...employeeCtx, selfBatch, selfSkuId: inv01.selfSkuId, nlyId })
  } finally {
    await ctx.close()
    summarize(7, verdicts)
  }

  // 豁免面收敛到 `/^UX-/`（原为 `/^(BLOCKED:|BUG-|UX-)/`）：
  //   - `BLOCKED:` 已随 #129 清空（D 段的「内部领用受阻」换成了真实链路）；
  //   - `BUG-` 已随 #130 清空（A/B 的员工下拉转为正式守护）。
  // 两支都留着的话，#129/#130 一旦回归就会被悄悄归进「已知缺陷」而不让 spec 红 ——
  // 那正是本次改造要消灭的东西。本 spec 目前一条 `UX-` 也没有，等于全量硬闸。
  const known = verdicts.filter((v) => v.verdict === 'FAIL' && /^UX-/.test(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !/^UX-/.test(v.check))
  if (known.length > 0) console.log(`\n[INV-07] ⛔ 已知缺陷/受阻:\n${JSON.stringify(known, null, 2)}`)
  expect(functional, `INV-07 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
