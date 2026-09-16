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
      // 原实现的 stockSnapshot 只在**选中批次**时才写（`lot ? String(lot.quantityOnHand) : null`），
      // 而盘点单不属于 SOURCE_LOT_DOC_TYPES、UI 不提供批次选择器 —— stock_snapshot 恒为 NULL，
      // 盘点单退化成一张只有「数量」的白条。issue #131 已修：无批次时按「主体 + SKU」汇总在手量写入。
      // 账面口径是**在手量、不扣预留**（#131 Q0）；按 SKU 汇总而非按批次（#131 Q1）。
      const snapshot = psql(
        `SELECT COALESCE(stock_snapshot::text,'NULL') FROM inventory_doc_items
          WHERE doc_id = ${sqlStr(mpdId)} ORDER BY id LIMIT 1`,
      )
      recordVerdict(
        verdicts,
        '盘点明细记录账面数量 stock_snapshot（#131）',
        snapshot !== 'NULL' && snapshot !== '',
        snapshot,
      )
      // 账面数必须等于该主体该 SKU 的全部批次在手量之和（按 SKU 汇总、不扣预留）。
      //
      // ⚠️ 时序：`marketBefore` 在建单**前**读（t0），引擎的账面 SUM 发生在建单事务内（t2），
      //    中间隔着整个表单填写与提交。本套件跑在**共享 dev 实例**上，这几秒里若有人
      //    对同一主体同一 SKU 入库一笔，两个值就会不等 —— 那是并发，不是回归。
      //    所以对不上时先复读一次当前值：若当前值也变了，判定为「疑似并发」（带 UX- 前缀
      //    走已知项、不让整支 spec 硬失败，也不把假 P1 经 ctx 传给 INV-10）。
      const bookNow = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
      const bookMatched = Number(snapshot) === marketBefore
      const concurrentWrite = !bookMatched && bookNow !== marketBefore
      recordVerdict(
        verdicts,
        concurrentWrite
          ? 'UX-并发：账面数核对期间该 SKU 在手量被他人改动，本轮不判定'
          : '账面数量 = 该主体下该 SKU 全部批次在手量之和（按 SKU 汇总，不扣预留）',
        concurrentWrite ? false : bookMatched,
        `stock_snapshot=${snapshot} vs 建单前 SUM=${marketBefore} / 当前 SUM=${bookNow}`,
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
      // 分院侧同样校验账面数 —— 否则「分院盘点写账面数」在真库上是空白
      //（单测覆盖了，但 E2E 这一层只验了市场段）。并发处理同市场段。
      const ypdSnapshot = psql(
        `SELECT COALESCE(stock_snapshot::text,'NULL') FROM inventory_doc_items
          WHERE doc_id = ${sqlStr(ypdId)} ORDER BY id LIMIT 1`,
      )
      recordVerdict(
        verdicts,
        '分院盘点明细记录账面数量 stock_snapshot（#131）',
        ypdSnapshot !== 'NULL' && ypdSnapshot !== '',
        ypdSnapshot,
      )
      const storeConcurrent = Number(ypdSnapshot) !== storeBefore && storeAfter !== storeBefore
      recordVerdict(
        verdicts,
        storeConcurrent
          ? 'UX-并发：分院账面数核对期间该 SKU 在手量被他人改动，本轮不判定'
          : '分院账面数量 = 该门店下该 SKU 全部批次在手量之和',
        storeConcurrent ? false : Number(ypdSnapshot) === storeBefore,
        `stock_snapshot=${ypdSnapshot} vs 建单前 SUM=${storeBefore} / 当前 SUM=${storeAfter}`,
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

    // 把**本 spec 自己的判定**交给 INV-10 转述，而不是让 INV-10 再查一遍库去
    // 反推「当前部署有没有生效」——它反推不了：ctx 文件跨运行保留，回退后单跑 INV-10
    // 会读到回退前建的非空单据，从而漏报（反向假绿）。
    // `at` 只用于让报告标明证据的时效，不当作「同一轮」的证明。
    // ⚠️ 必须**两条都 PASS**：只看「非 NULL」的话，把 stock_snapshot 写死成 1 也算通过，
    //    INV-10 就会漏报（INV-06 自己会红，但生成的 UX-FINDINGS.md 是错的）。
    //    第二条「账面数量 = 该主体该 SKU 全部批次在手量之和」才是口径守护。
    // 交给 INV-10 转述的两个事实，**各自独立**（`null` = 该判定没执行过）：
    //   - snapshotPresent     账面数非 NULL —— 与并发**无关**
    //   - snapshotMatchesBook 账面数等于该主体该 SKU 的在手量之和 —— 撞上并发会被降级成 null
    // ⚠️ 别把两者揉成一个「都执行了吗」的布尔：回退修复（写 NULL）又恰好撞上并发时，
    //    matches 变 null 会把**已经确认的「没写」**一起降级成「不知道」，报告就误导人了。
    // ⚠️ 也别揉成一个「合格吗」的布尔：写了但值不对（比如写死成 1）时，
    //    INV-10 会说成「没有写、退化成白条」—— 事实错误。
    // ⚠️ 市场段与分院段**都要算进去**：只汇总市场段的话，「市场盘点写对了、
    //    分院盘点仍写 NULL」这种回归会让 ctx 全是 true，INV-10 一条 finding 都不出。
    const verdictOf = (...prefixes: string[]): boolean | null => {
      const hits = prefixes.map((prefix) => verdicts.find((v) => v.check.startsWith(prefix)))
      if (hits.every((h) => h === undefined)) return null       // 都没执行 → 不知道
      if (hits.some((h) => h && h.verdict === 'FAIL')) return false  // 任一失败 → 失败
      return hits.some((h) => h === undefined) ? null : true    // 有的没执行 → 不知道
    }
    writeCtx('inv06', {
      mpdId,
      ypdId,
      mpyId,
      snapshotPresent: verdictOf(
        '盘点明细记录账面数量 stock_snapshot',
        '分院盘点明细记录账面数量 stock_snapshot',
      ),
      snapshotMatchesBook: verdictOf(
        '账面数量 = 该主体下该 SKU 全部批次在手量之和',
        '分院账面数量 = 该门店下该 SKU 全部批次在手量之和',
      ),
      at: new Date().toISOString(),
    })
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
