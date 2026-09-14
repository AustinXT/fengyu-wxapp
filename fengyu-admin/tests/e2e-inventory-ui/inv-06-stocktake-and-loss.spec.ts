/**
 * INV-06：盘点与报损
 *
 * 核心不变量：**盘点单不得改动库存**。
 * engine.ts:297-309 的 movementPlan 对「市场库存盘点」「分院库存盘点」返回 null
 * （既不在 INBOUND 也不在 OUTBOUND，更不在 NO_MOVEMENT 之外），只写
 * doc_items.stock_snapshot 留痕。这是最容易被误实现成「盘点即调账」的地方。
 *
 * 盘溢（市场产品盘溢）是入库类，建单即完成并产生正向流水。
 *
 * ⚠️ 报损（市场产品报损 / 院产品报损）需要选来源批次，受 BUG-LOT-LOADING 阻断，
 * 在 UI 上无法创建 —— 见 INV-05。本 spec 如实记录，不伪装成已覆盖。
 */

import { test, expect } from '@playwright/test'
import {
  INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import { createGenericDoc, docIdByRemark, docStatus, docMovementCount, lotQtyAll } from './_helpers/ui'

test.setTimeout(500_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  marketStocktake: `${NS}-市场盘点-${STAMP}`,
  storeStocktake: `${NS}-分院盘点-${STAMP}`,
  overflow: `${NS}-盘溢-${STAMP}`,
}
const QTY = { stocktake: 7, overflow: 6 }

test('INV-06：盘点不动库存 / 盘溢入库 / 报损受阻记录', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{ supplySkuId: string; supplySkuName: string }>('inv01')
  if (!inv01?.supplySkuId) throw new Error('缺少 INV-01 上下文')
  if (!isGateOpen()) openCutoverGate()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  const dialogs: string[] = []
  page.on('dialog', async (d) => {
    dialogs.push(d.message())
    await d.accept('INVT-自动应答').catch(() => null)
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ A. 市场库存盘点 —— 建单但不动库存 ═════════════════════════
    console.log('[INV-06] A 市场库存盘点')
    const marketBefore = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    const movesBefore = Number(psql(`SELECT count(*) FROM inventory_movements`))

    await createGenericDoc(page, {
      docType: '市场库存盘点',
      sourceLabel: `市场 · ${TOPO.MARKET_NAME}`,
      targetLabel: `市场 · ${TOPO.MARKET_NAME}`,
      skuName: inv01.supplySkuName,
      quantity: QTY.stocktake,
      remark: R.marketStocktake,
    })

    const mpdId = docIdByRemark('市场库存盘点', R.marketStocktake)
    recordVerdict(verdicts, 'doc: 市场库存盘点落库', Boolean(mpdId), mpdId || `提示: ${dialogs.join(' | ')}`)
    if (mpdId) {
      recordVerdict(verdicts, 'doc: 盘点单号前缀 MPD', mpdId.startsWith('MPD'), mpdId)
      recordVerdict(
        verdicts,
        '★ 盘点单不产生任何库存流水（movementPlan=null）',
        docMovementCount(mpdId) === 0,
        `movements=${docMovementCount(mpdId)}`,
      )
      const marketAfter = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        '★ 盘点后市场在手数量分毫未变',
        marketAfter === marketBefore,
        `${marketBefore} → ${marketAfter}`,
      )
      // 盘点的业务价值 = 记录「账面数量 vs 实盘数量」的差异。
      // 但 engine.ts:2777 的 stockSnapshot 只在**选中批次**时才写入
      // （`lot ? String(lot.quantityOnHand) : null`），而盘点单不属于
      // SOURCE_LOT_DOC_TYPES、UI 压根不提供批次选择器 —— 于是 stock_snapshot 恒为 NULL。
      // 结果：盘点单既不动库存、也不记账面数，退化成一张只有「数量」的白条，
      // 无法用于任何对账。记为缺陷而非功能失败。
      const snapshot = psql(
        `SELECT COALESCE(stock_snapshot::text,'NULL') FROM inventory_doc_items
          WHERE doc_id = ${sqlStr(mpdId)} LIMIT 1`,
      )
      recordVerdict(
        verdicts,
        'BUG-STOCKTAKE-SNAPSHOT: 盘点明细应记录账面数量 stock_snapshot（当前恒为 NULL）',
        snapshot !== 'NULL' && snapshot !== '',
        snapshot,
      )
      recordVerdict(verdicts, 'doc: 盘点单建单即完成', docStatus(mpdId) === '已完成', docStatus(mpdId))
    }

    // ══ B. 分院库存盘点 ═══════════════════════════════════════════
    console.log('[INV-06] B 分院库存盘点')
    const storeBefore = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    dialogs.length = 0
    await createGenericDoc(page, {
      docType: '分院库存盘点',
      sourceLabel: `门店 · ${TOPO.STORE_A_NAME}`,
      targetLabel: `门店 · ${TOPO.STORE_A_NAME}`,
      skuName: inv01.supplySkuName,
      quantity: QTY.stocktake,
      remark: R.storeStocktake,
    })
    const ypdId = docIdByRemark('分院库存盘点', R.storeStocktake)
    recordVerdict(verdicts, 'doc: 分院库存盘点落库', Boolean(ypdId), ypdId || `提示: ${dialogs.join(' | ')}`)
    if (ypdId) {
      recordVerdict(verdicts, 'doc: 盘点单号前缀 YPD', ypdId.startsWith('YPD'), ypdId)
      recordVerdict(
        verdicts,
        '★ 分院盘点同样不产生库存流水',
        docMovementCount(ypdId) === 0,
        `movements=${docMovementCount(ypdId)}`,
      )
      const storeAfter = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        '★ 分院盘点后门店在手数量分毫未变',
        storeAfter === storeBefore,
        `${storeBefore} → ${storeAfter}`,
      )
    }

    // 全局校验：两张盘点单合计没给全库增加任何流水
    const movesAfterStocktake = Number(psql(`SELECT count(*) FROM inventory_movements`))
    recordVerdict(
      verdicts,
      '★ 两张盘点单合计未新增任何库存流水',
      movesAfterStocktake === movesBefore,
      `${movesBefore} → ${movesAfterStocktake}`,
    )

    // ══ C. 市场产品盘溢 —— 入库类，应产生正向流水 ══════════════════
    console.log('[INV-06] C 市场产品盘溢')
    const beforeOverflow = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    dialogs.length = 0
    await createGenericDoc(page, {
      docType: '市场产品盘溢',
      sourceLabel: `市场 · ${TOPO.MARKET_NAME}`,
      targetLabel: `市场 · ${TOPO.MARKET_NAME}`,
      skuName: inv01.supplySkuName,
      quantity: QTY.overflow,
      remark: R.overflow,
    })
    const mpyId = docIdByRemark('市场产品盘溢', R.overflow)
    recordVerdict(verdicts, 'doc: 市场产品盘溢落库', Boolean(mpyId), mpyId || `提示: ${dialogs.join(' | ')}`)
    if (mpyId) {
      recordVerdict(verdicts, 'doc: 盘溢单号前缀 MPY', mpyId.startsWith('MPY'), mpyId)
      recordVerdict(verdicts, 'doc: 盘溢建单即完成', docStatus(mpyId) === '已完成', docStatus(mpyId))
      const afterOverflow = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `stock: 盘溢使市场库存增加 ${QTY.overflow}`,
        afterOverflow - beforeOverflow === QTY.overflow,
        `${beforeOverflow} → ${afterOverflow}`,
      )
      const dir = psql(`SELECT direction FROM inventory_movements WHERE doc_id = ${sqlStr(mpyId)} LIMIT 1`)
      recordVerdict(verdicts, 'movement: 盘溢方向 = 入库', dir === '入库', dir)
    }

    // ══ D. 报损受阻记录 ═══════════════════════════════════════════
    for (const docType of ['市场产品报损', '院产品报损']) {
      recordVerdict(
        verdicts,
        `BLOCKED: 无法创建「${docType}」（需选来源批次，受 BUG-LOT-LOADING 阻断）`,
        false,
        '见 INV-05',
      )
    }

    writeCtx('inv06', { mpdId, ypdId, mpyId })
  } finally {
    await ctx.close()
    summarize(6, verdicts)
  }

  const known = verdicts.filter((v) => v.verdict === 'FAIL' && /^(BLOCKED:|BUG-|UX-)/.test(v.check))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !/^(BLOCKED:|BUG-|UX-)/.test(v.check))
  if (known.length > 0) {
    console.log(`\n[INV-06] ⛔ 已知缺陷/受阻 ${known.length} 项:\n${JSON.stringify(known, null, 2)}`)
  }
  expect(functional, `INV-06 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
