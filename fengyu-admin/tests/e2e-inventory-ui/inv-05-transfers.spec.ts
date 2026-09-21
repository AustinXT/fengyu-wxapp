/**
 * INV-05：调货链路（分院调货闭环 / 市场间调货 §10.3 归属 / 两条红线）
 *
 * 覆盖矩阵（对应 BUSINESS-SCENARIOS.md 的 INV-05 五步设计）：
 *   0  #129 回归守护     批次下拉解禁时长、渲染出真实批次、换 SKU / 换主体后跟随刷新
 *   1  分院调货出库      DTO 前缀、初始「待收货」、发出即扣来源门店、§10.3 归母市场
 *   2  门店 B 收货       自动生成配对 DTI、门店 B 入账、发货收货血缘、§7.3 门店真实单价延续
 *   3  §8.2 负向         分院间调货限同市场 —— 跨市场必须被拒且零落库
 *   4  市场间调货 §10.3  出库单归**来源**市场、入库单归**目标**市场（两半都验）
 *   5  自采负向          自采 SKU 不得跨市场调出，零落库
 *
 * 与 action 层 smoke 的分工（`tests/e2e-actions/smoke-inventory-transfer.impl.mjs`）：
 *   那边还额外覆盖「调用端传 marketId 被忽略」与 §9.4 跨市场可见性 —— UI 层既传不了
 *   marketId、也够不到别人的列表，这两条不在本 spec 重复；反过来，建单弹窗的批次下拉、
 *   行内收货按钮、错误 toast 文案只有 UI 层能验，那边也验不了。两边互补，都要跑。
 *
 * ⚠️ 破坏性：第 4 段会把 `QTY.marketTransfer` 件库存**永久**搬进「自贡凤御」（该市场原本
 *    零库存），`inventory_movements` 上有 append-only 触发器，删不掉。README 已声明本套件
 *    破例直连 dev 共享库且不清理 —— 后续别把那点库存当脏数据误删。
 *
 * ⚠️ 错误文案断言是**有意的文案守护**，直接钉住 engine.ts 的中文：
 *      /同市场内部的门店才可调货/  ← `assertSameMarketForStoreTransfer`
 *      /仅可在归属市场使用/        ← `assertSkuAvailableAtLocation`
 *    （只记函数名不记行号 —— 行号会漂。）改文案会让本 spec 红，那正是期望行为；
 *    但若被测实例是 #133 之前的老构建，digest 透出的是脱敏英文，也会红 ——
 *    正则匹配不到时**先查部署版本**再怀疑代码。
 *
 * 前置：必须按 inv-00 → inv-04 的顺序先跑过（inv-01 建 SKU 档案、inv-02 给总部备货、
 *    inv-03 把货配到门店 A / 南昌凤御）。缺任何一步，门店 A 或南昌凤御就没有
 *    「可用量 >= N 的批次」，本 spec 会在选批次那一步抛错。段前置会先打印三个主体的在手量。
 */

import { test, expect } from '@playwright/test'
import {
  BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO,
  anyStoreOfMarket, login, psql, readCtx, recordVerdict, sqlStr, summarize, writeCtx, type Verdict,
} from './_helpers/env'
import { isGateOpen, openCutoverGate } from './_helpers/cutover'
import {
  createGenericDoc, docIdByRemark, docMovementCount, docStatus, lotQtyAll, rowAction, selectContaining,
} from './_helpers/ui'

// 恢复真实链路后跑完五段要好几分钟（两次建单 + 两次收货 + 两次必失败的提交），
// 对齐 inv-03 的 600s；原来的 400s 是「只复现缺陷」时代的余量。
test.setTimeout(600_000)

const STAMP = Date.now().toString().slice(-8)
const R = {
  storeTransfer: `${NS}-分院调货-${STAMP}`,
  crossMarket: `${NS}-跨市场调货-${STAMP}`,
  marketTransfer: `${NS}-市场间调货-${STAMP}`,
  selfSeed: `${NS}-自采盘溢-${STAMP}`,
  selfTransfer: `${NS}-自采跨市场-${STAMP}`,
}
const QTY = { storeTransfer: 3, marketTransfer: 2, selfSeed: 5, selfTransfer: 1 }

// ───────────────────────── 本 spec 专用的 DB 读取 ─────────────────────────

/** 单据的市场归属。§10.3 由 DB 触发器 `inventory_set_doc_market_id` 派生，禁止调用方传值。 */
function docMarketId(docId: string): string {
  return psql(`SELECT COALESCE(market_id,'') FROM inventory_docs WHERE id = ${sqlStr(docId)}`)
}

/** 某单据首条明细的门店真实单价（§7.3 的承重列） */
function firstItemStorePrice(docId: string): string {
  return psql(
    `SELECT COALESCE(store_actual_unit_price::text,'NULL') FROM inventory_doc_items
      WHERE doc_id = ${sqlStr(docId)} ORDER BY id LIMIT 1`,
  )
}

/** 出库单 → 入库单的「发货收货」血缘条数 */
function shipReceiveLinkCount(fromDocId: string, toDocId: string): number {
  return Number(psql(
    `SELECT count(*) FROM inventory_doc_links
      WHERE from_doc_id = ${sqlStr(fromDocId)} AND to_doc_id = ${sqlStr(toDocId)}
        AND relation_type = '发货收货'`,
  ))
}

/** 某单据的流水方向分布，形如 "出库:1" */
function movementDirections(docId: string): string {
  return psql(
    `SELECT COALESCE(string_agg(direction || ':' || cnt::text, '|' ORDER BY direction), '')
       FROM (SELECT direction, count(*) AS cnt FROM inventory_movements
              WHERE doc_id = ${sqlStr(docId)} GROUP BY direction) t`,
  )
}

/**
 * 在手量 + 最大单批次量。
 * 引擎要的是「**单个**批次可用量 >= N」，而 `lotQtyAll` 给的是所有批次之和 ——
 * 撞上「没有可用量 >= N 的批次」时，这两个数放一起才分得清是总量不够还是被拆碎了。
 */
function onHandDigest(orgNodeId: string, skuId: string): string {
  return psql(
    `SELECT COALESCE(SUM(l.quantity_on_hand),0)::text || ' (最大批次 ' || COALESCE(MAX(l.quantity_on_hand),0)::text || ')'
       FROM inventory_stock_lots l
       JOIN inventory_locations loc ON loc.location_id = l.location_id
      WHERE loc.org_node_id = ${sqlStr(orgNodeId)} AND l.sku_id = ${sqlStr(skuId)}`,
  )
}

// ───────────────────────── 跨 spec 上下文（INV-10 转述用） ─────────────────────────

/**
 * ⚠️ **判定一出来就立刻写盘**，不要攒到 spec 末尾。
 * ctx 文件跨运行保留：攒到最后的话，中途任何一步挂掉都会让 ctx 继续挂着**上一轮**的
 * 「通过」，单跑 INV-10 会照着生成一份假报告（同 inv-01 已经解释过的理由）。
 *
 * `null` 的语义是「本轮没跑到这条判定」—— 既不是通过也不是失败。
 * 转述方（INV-10）分四支：false 且证据新鲜 → P0；null/缺失 → P2「未覆盖」；
 * 证据过期 → P2「证据过期」；true → 不产出。
 */
const ctxState: {
  at: string
  /** 单据中心批次下拉是否解禁并出现真实批次（#129 的核心症状） */
  lotLoadingOk: boolean | null
  /** 换 SKU / 换出库主体后批次列表是否跟随刷新且不卡死（#129 验收标准第 3 条） */
  lotRefreshOk: boolean | null
  /** 本轮**经通用建单弹窗**真正建出来的单据号（收货自动派生的 DTI/MTI 不计入，见下面四个专列字段） */
  genericDocsCreated: string[]
  dtoId: string
  dtiId: string
  mtoId: string
  mtiId: string
} = {
  at: new Date().toISOString(),
  lotLoadingOk: null,
  lotRefreshOk: null,
  genericDocsCreated: [],
  dtoId: '',
  dtiId: '',
  mtoId: '',
  mtiId: '',
}

function flushCtx(): void {
  ctxState.at = new Date().toISOString()
  writeCtx('inv05', { ...ctxState })
}

test('INV-05：调货链路 —— 分院调货收货闭环 / §10.3 归属 / 跨市场与自采红线', async ({ browser }) => {
  const verdicts: Verdict[] = []
  const inv01 = readCtx<{
    supplySkuId: string
    supplySkuName: string
    selfSkuId: string
    selfSkuName: string
  }>('inv01')
  if (!inv01?.supplySkuId || !inv01?.selfSkuId) {
    throw new Error('缺少 INV-01 上下文（supplySkuId / selfSkuId），请按 inv-00 → inv-04 的顺序整套跑')
  }
  if (!isGateOpen()) openCutoverGate()

  // 先把上一轮的判定清成「未知」：本轮若在段 0 之前就挂了，ctx 不能还挂着上次的 true
  flushCtx()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
  // 三个行内动作的备注早已改成弹窗内的 textarea（#134），这里只兜「万一又冒出原生弹窗」：
  // 不挂 handler 的话 Playwright 会自动 dismiss，页面反而静默卡住、查不出原因。
  const nativeDialogs: string[] = []
  page.on('dialog', async (d) => {
    nativeDialogs.push(`${d.type()}: ${d.message()}`)
    await d.accept('').catch(() => d.dismiss().catch(() => null))
  })

  // 建单页的 Server Action 是否真的回过 200 —— #129 当年正是「数据回来了但 UI 没用上」，
  // 这个计数只当 evidence 写进 actual，不单独成条断言。
  let docPostResponses = 0
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/inventory/docs') && r.status() === 200) {
      docPostResponses += 1
    }
  })

  try {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // ══ 前置：三个主体的在手量 ═══════════════════════════════════════
    // 一轮全套跑完门店 A 的供应链品会被消耗 3（本段调货）+ 2（inv-06 报损）+ 2（inv-07 顾客出库），
    // inv-03 的配货量一旦调小，这三支就会一起撞「没有可用量 >= N 的批次」。先打出来。
    const storeADigest = onHandDigest(TOPO.STORE_A_ORG, inv01.supplySkuId)
    const marketDigest = onHandDigest(TOPO.MARKET, inv01.supplySkuId)
    const marketSelfDigest = onHandDigest(TOPO.MARKET, inv01.selfSkuId)
    console.log(
      `[INV-05] 前置在手量：门店A(${TOPO.STORE_A_NAME})供应链=${storeADigest}`
      + ` / ${TOPO.MARKET_NAME}供应链=${marketDigest} / ${TOPO.MARKET_NAME}自采=${marketSelfDigest}`,
    )
    recordVerdict(
      verdicts,
      `前置: 门店 A 与 ${TOPO.MARKET_NAME} 的在手量足以支撑本轮（需 ${QTY.storeTransfer} / ${QTY.marketTransfer}）`,
      lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId) >= QTY.storeTransfer
      && lotQtyAll(TOPO.MARKET, inv01.supplySkuId) >= QTY.marketTransfer,
      `门店A=${storeADigest}｜${TOPO.MARKET_NAME}供应链=${marketDigest}｜${TOPO.MARKET_NAME}自采=${marketSelfDigest}`,
    )

    // ══ 0. #129 回归守护：批次下拉必须解禁、有真实批次、且跟随刷新 ══
    console.log('[INV-05] 0 #129 守护：单据中心批次下拉')
    await page.goto(`${BASE}/inventory/docs`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /新建/ }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: '新建库存单据' })
    await expect(dialog.getByText('新建库存单据')).toBeVisible({ timeout: 15_000 })

    const selects = dialog.locator('select')
    // 弹窗内 select 的固定顺序：0=单据类型 1=出库主体 2=入库主体 3=来源批次 4=SKU
    // （分院调货出库属 SOURCE_LOT_DOC_TYPES，明细行多一个批次下拉）
    await selects.nth(0).selectOption('分院调货出库')
    await selectContaining(selects.nth(1), `门店 · ${TOPO.STORE_A_NAME}`)
    await selectContaining(selects.nth(2), `门店 · ${TOPO.STORE_B_NAME}`)
    await page.waitForTimeout(500)
    await selectContaining(selects.nth(4), inv01.supplySkuName)

    const lotSel = selects.nth(3)
    const t0 = Date.now()
    // 用 then/catch 收成布尔，别让断言直接抛 —— 这条失败了后面的守护还要继续判
    const lotEnabled = await expect(lotSel).toBeEnabled({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    const elapsedMs = Date.now() - t0
    const placeholder = (await lotSel.locator('option').first().textContent())?.trim() ?? ''
    const lotOptionCount = await lotSel.locator('option').count()

    // #129 验收标准第 1 条要求 3 秒内解禁；这里给 15s 的判定线，把「慢」与「死」分开 ——
    // 真退化成自循环时是**永不解禁**，不会卡在 3~15 秒之间。
    recordVerdict(
      verdicts,
      '★ #129 守护: 选定主体与 SKU 后批次下拉在 15s 内可用',
      lotEnabled,
      `${elapsedMs}ms｜占位="${placeholder}"`,
    )
    recordVerdict(
      verdicts,
      '★ #129 守护: 批次下拉渲染出真实批次（option > 1）',
      lotOptionCount > 1,
      `option数=${lotOptionCount}（1 = 只有占位项）｜建单页 POST 200 次数=${docPostResponses}`,
    )
    ctxState.lotLoadingOk = lotEnabled && lotOptionCount > 1
    flushCtx()

    /*
     * #129 验收标准第 3 条：换 SKU / 换出库主体后，批次列表要跟着刷新且不卡死。
     *
     * 判定不能只看「最终 option 数对不对」—— 换主体前后都是「>1」，光比数量会在
     * React 还没 flush 的那一帧上拿到**旧列表**而假绿。所以比的是「option 文本整体变了
     * 且落到期望形态」：门店 A 没有自采批次 → 期望只剩占位项；换回供应链品、再换到市场
     * → 期望重新出现批次。
     *
     * 两条对数据形态的假设（变了就会红，那时先查数据、别先改代码）：
     *   · 门店 A 不持有自采 SKU 的批次（自采货只进市场，inv-07 的自采入库也只入市场）；
     *   · 门店 A 与 南昌凤御 的批次列表文本不完全相同（当前一个 2 批、一个 4 批）。
     */
    const refreshSteps = [
      {
        label: '切 SKU → 自采品（门店 A 无此批次）',
        want: '只剩占位项',
        act: async () => { await selectContaining(selects.nth(4), inv01.selfSkuName) },
        ok: (n: number) => n === 1,
      },
      {
        label: '切回 SKU → 供应链品',
        want: '重新出现批次',
        act: async () => { await selectContaining(selects.nth(4), inv01.supplySkuName) },
        ok: (n: number) => n > 1,
      },
      {
        label: `切出库主体 → 市场 · ${TOPO.MARKET_NAME}`,
        want: '按新主体重新取数',
        act: async () => { await selectContaining(selects.nth(1), `市场 · ${TOPO.MARKET_NAME}`) },
        ok: (n: number) => n > 1,
      },
    ] as const

    let refreshOk = true
    for (const step of refreshSteps) {
      const before = JSON.stringify(await lotSel.locator('option').allTextContents())
      await step.act()
      const pass = await expect.poll(
        async () => {
          const texts = await lotSel.locator('option').allTextContents()
          const disabled = await lotSel.isDisabled()
          return !disabled && JSON.stringify(texts) !== before && step.ok(texts.length)
        },
        { timeout: 15_000, message: step.label },
      ).toBe(true).then(() => true).catch(() => false)
      refreshOk = refreshOk && pass
      const finalTexts = await lotSel.locator('option').allTextContents()
      recordVerdict(
        verdicts,
        `★ #129 守护: ${step.label} 后批次下拉跟随刷新且不卡死（期望${step.want}）`,
        pass,
        `enabled=${!(await lotSel.isDisabled())} option数=${finalTexts.length}｜${JSON.stringify(finalTexts)}`,
      )
    }
    ctxState.lotRefreshOk = refreshOk
    flushCtx()

    await page.keyboard.press('Escape').catch(() => null)

    // ══ 1. 分院调货出库（同市场：门店 A → 门店 B）════════════════════
    console.log('[INV-05] 1 分院调货出库')
    const storeABefore = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
    const storeBBefore = lotQtyAll(TOPO.STORE_B_ORG, inv01.supplySkuId)
    const dtoRes = await createGenericDoc(page, {
      docType: '分院调货出库',
      sourceLabel: `门店 · ${TOPO.STORE_A_NAME}`,
      targetLabel: `门店 · ${TOPO.STORE_B_NAME}`,
      skuName: inv01.supplySkuName,
      quantity: QTY.storeTransfer,
      remark: R.storeTransfer,
      needLot: true,
    })
    const dtoId = docIdByRemark('分院调货出库', R.storeTransfer)
    recordVerdict(
      verdicts,
      'doc: 分院调货出库落库',
      Boolean(dtoId),
      dtoId || `建单失败: ${dtoRes.toast}`,
    )
    if (dtoId) {
      ctxState.dtoId = dtoId
      ctxState.genericDocsCreated = [...ctxState.genericDocsCreated, dtoId]
      flushCtx()
      recordVerdict(verdicts, 'doc: 分院调货出库单号前缀 DTO', dtoId.startsWith('DTO'), dtoId)
      // RECEIVE_REQUIRED_DOC_TYPES → defaultStatusForDoc 给「待收货」，不是「已完成」
      recordVerdict(verdicts, 'doc: 调货出库初始状态 = 待收货', docStatus(dtoId) === '待收货', docStatus(dtoId))
      // §10.3：非市场间调货走 COALESCE(来源市场, 目标市场)，同市场两端都是南昌凤御
      recordVerdict(
        verdicts,
        `★ §10.3 分院调货出库归母市场（${TOPO.MARKET_NAME}）`,
        docMarketId(dtoId) === TOPO.MARKET,
        docMarketId(dtoId),
      )
      // movementPlan 对 RECEIVE_REQUIRED 返回 {source, 出库} —— 发出即扣，不等收货
      const storeAAfter = lotQtyAll(TOPO.STORE_A_ORG, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `★ stock: 发出即扣门店 A 库存 ${QTY.storeTransfer}`,
        storeABefore - storeAAfter === QTY.storeTransfer,
        `${storeABefore} → ${storeAAfter}`,
      )
      recordVerdict(
        verdicts,
        'movement: 调货出库产生 1 条出库流水',
        docMovementCount(dtoId) === 1 && movementDirections(dtoId) === '出库:1',
        `条数=${docMovementCount(dtoId)} 方向=${movementDirections(dtoId)}`,
      )
    }

    // ══ 2. 门店 B 收货 → 自动生成配对入库单 ═══════════════════════════
    let dtiId = ''
    if (dtoId) {
      console.log('[INV-05] 2 门店 B 收货')
      // 备注留空：engine 的 `normalizeText(remark) ?? head.remark` 会把出库单备注继承给入库单，
      // 于是可以用 docIdByRemark 取到 DTI；toast 里的单号是第二重保险。
      const receive = await rowAction(page, dtoId, '收货')
        .then((toast) => ({ ok: true, toast }))
        .catch((e: unknown) => ({ ok: false, toast: e instanceof Error ? e.message : String(e) }))
      recordVerdict(verdicts, 'doc: 门店 B 收货操作成功', receive.ok, receive.toast)
      recordVerdict(
        verdicts,
        'doc: 收货后出库单转已完成',
        docStatus(dtoId) === '已完成',
        docStatus(dtoId),
      )

      dtiId = docIdByRemark('分院调货入库', R.storeTransfer)
        || (receive.toast.match(/已生成入库单\s*(\S+)/)?.[1] ?? '')
      recordVerdict(verdicts, 'doc: 收货自动生成配对入库单', Boolean(dtiId), dtiId || receive.toast)
    }
    if (dtiId) {
      ctxState.dtiId = dtiId
      flushCtx()
      recordVerdict(verdicts, 'doc: 配对入库单号前缀 DTI', dtiId.startsWith('DTI'), dtiId)
      recordVerdict(verdicts, 'doc: 配对入库单建出即已完成', docStatus(dtiId) === '已完成', docStatus(dtiId))
      recordVerdict(
        verdicts,
        `★ §10.3 分院调货入库同样归母市场（${TOPO.MARKET_NAME}）`,
        docMarketId(dtiId) === TOPO.MARKET,
        docMarketId(dtiId),
      )
      const storeBAfter = lotQtyAll(TOPO.STORE_B_ORG, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `★ stock: 门店 B 收货后库存 +${QTY.storeTransfer}`,
        storeBAfter - storeBBefore === QTY.storeTransfer,
        `${storeBBefore} → ${storeBAfter}`,
      )
      recordVerdict(
        verdicts,
        'link: 出库→入库 血缘（relation_type = 发货收货）',
        shipReceiveLinkCount(dtoId, dtiId) >= 1,
        `links=${shipReceiveLinkCount(dtoId, dtiId)}`,
      )
      // §7.3：门店真实单价是配货金额四件套算出来的，调货不得把它冲掉或归零
      const outPrice = firstItemStorePrice(dtoId)
      const inPrice = firstItemStorePrice(dtiId)
      recordVerdict(
        verdicts,
        '★ §7.3 入库批次延续门店真实单价（与出库单一致且 > 0）',
        outPrice === inPrice && Number(outPrice) > 0,
        `出库=${outPrice} 入库=${inPrice}`,
      )
    }

    // ══ 3. 跨市场分院调货应被拒（§8.2）═══════════════════════════════
    console.log('[INV-05] 3 §8.2 跨市场分院调货')
    // 不写死自贡的门店 id：dev 拓扑会随 prod→dev 同步重刷（见 anyStoreOfMarket 的注释）
    const other = anyStoreOfMarket(TOPO.MARKET_OTHER)
    if (!other) {
      // SKIP 而不是抛错：一次组织调整就能让某个市场暂时没有启用门店，不该因此判红
      recordVerdict(
        verdicts,
        '★ §8.2 分院间调货限同市场（跨市场须被拒）',
        true,
        `SKIP: ${TOPO.MARKET_OTHER_NAME} 下没有启用门店，本轮无法构造跨市场场景`,
      )
    } else {
      const crossRes = await createGenericDoc(page, {
        docType: '分院调货出库',
        sourceLabel: `门店 · ${TOPO.STORE_A_NAME}`,
        targetLabel: `门店 · ${other.name}`,
        skuName: inv01.supplySkuName,
        quantity: QTY.storeTransfer,
        remark: R.crossMarket,
        needLot: true,
      })
      recordVerdict(
        verdicts,
        `★ §8.2 跨市场分院调货被拒（门店 A → ${other.name}）`,
        !crossRes.ok,
        `ok=${crossRes.ok} toast="${crossRes.toast}"`,
      )
      recordVerdict(
        verdicts,
        '§8.2 拒绝文案点明「同市场内部的门店才可调货」',
        /同市场内部的门店才可调货/.test(crossRes.toast),
        crossRes.toast,
      )
      // assertGenericDocLocationRules 跑在 db.transaction 之前 —— 连单号都不该生成
      recordVerdict(
        verdicts,
        '§8.2 跨市场调货零落库（事务前即拦截）',
        docIdByRemark('分院调货出库', R.crossMarket) === '',
        docIdByRemark('分院调货出库', R.crossMarket) || '(无)',
      )
    }

    // ══ 4. 市场间调货 §10.3 归属派生 ═════════════════════════════════
    console.log('[INV-05] 4 市场间调货（§10.3）')
    const srcMarketBefore = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
    const dstMarketBefore = lotQtyAll(TOPO.MARKET_OTHER, inv01.supplySkuId)
    const mtoRes = await createGenericDoc(page, {
      docType: '市场间调货出库',
      sourceLabel: `市场 · ${TOPO.MARKET_NAME}`,
      targetLabel: `市场 · ${TOPO.MARKET_OTHER_NAME}`,
      skuName: inv01.supplySkuName,
      quantity: QTY.marketTransfer,
      remark: R.marketTransfer,
      needLot: true,
    })
    const mtoId = docIdByRemark('市场间调货出库', R.marketTransfer)
    recordVerdict(
      verdicts,
      'doc: 市场间调货出库落库',
      Boolean(mtoId),
      mtoId || `建单失败: ${mtoRes.toast}`,
    )
    if (mtoId) {
      ctxState.mtoId = mtoId
      ctxState.genericDocsCreated = [...ctxState.genericDocsCreated, mtoId]
      flushCtx()
      recordVerdict(verdicts, 'doc: 市场间调货出库单号前缀 MTO', mtoId.startsWith('MTO'), mtoId)
      recordVerdict(verdicts, 'doc: 市场间调货出库初始状态 = 待收货', docStatus(mtoId) === '待收货', docStatus(mtoId))
      // 本条是第 4 段的核心：触发器对「市场间调货出库」显式取 **source_market**，
      // 不走 COALESCE(source, target)。写成 MARKET_OTHER 就是把出库记到收货方头上。
      recordVerdict(
        verdicts,
        `★ §10.3 出库单归**来源**市场（${TOPO.MARKET_NAME}，不是 ${TOPO.MARKET_OTHER_NAME}）`,
        docMarketId(mtoId) === TOPO.MARKET,
        docMarketId(mtoId),
      )
      const srcMarketAfter = lotQtyAll(TOPO.MARKET, inv01.supplySkuId)
      recordVerdict(
        verdicts,
        `★ stock: ${TOPO.MARKET_NAME} 库存 −${QTY.marketTransfer}`,
        srcMarketBefore - srcMarketAfter === QTY.marketTransfer,
        `${srcMarketBefore} → ${srcMarketAfter}`,
      )

      const mtoReceive = await rowAction(page, mtoId, '收货')
        .then((toast) => ({ ok: true, toast }))
        .catch((e: unknown) => ({ ok: false, toast: e instanceof Error ? e.message : String(e) }))
      recordVerdict(verdicts, `doc: ${TOPO.MARKET_OTHER_NAME} 收货操作成功`, mtoReceive.ok, mtoReceive.toast)
      recordVerdict(verdicts, 'doc: 收货后市场间调货出库转已完成', docStatus(mtoId) === '已完成', docStatus(mtoId))

      const mtiId = docIdByRemark('市场间调货入库', R.marketTransfer)
        || (mtoReceive.toast.match(/已生成入库单\s*(\S+)/)?.[1] ?? '')
      recordVerdict(verdicts, 'doc: 收货自动生成市场间调货入库单', Boolean(mtiId), mtiId || mtoReceive.toast)
      if (mtiId) {
        ctxState.mtiId = mtiId
        flushCtx()
        recordVerdict(verdicts, 'doc: 市场间调货入库单号前缀 MTI', mtiId.startsWith('MTI'), mtiId)
        recordVerdict(
          verdicts,
          `★ §10.3 入库单归**目标**市场（${TOPO.MARKET_OTHER_NAME}）`,
          docMarketId(mtiId) === TOPO.MARKET_OTHER,
          docMarketId(mtiId),
        )
        const dstMarketAfter = lotQtyAll(TOPO.MARKET_OTHER, inv01.supplySkuId)
        recordVerdict(
          verdicts,
          `★ stock: ${TOPO.MARKET_OTHER_NAME} 库存 +${QTY.marketTransfer}`,
          dstMarketAfter - dstMarketBefore === QTY.marketTransfer,
          `${dstMarketBefore} → ${dstMarketAfter}`,
        )
      }
    }

    // ══ 5. 自采 SKU 不得跨市场调出 ═══════════════════════════════════
    console.log('[INV-05] 5 自采 SKU 跨市场调出')
    // 铺底：盘溢是 INBOUND 类，ensureLotFromSku 会校验自采 SKU 的归属市场 ——
    // 南昌凤御正是它的 owner_market，能建成；换成别的市场这一步自己就会被拒。
    if (lotQtyAll(TOPO.MARKET, inv01.selfSkuId) <= 0) {
      const seedRes = await createGenericDoc(page, {
        docType: '市场产品盘溢',
        sourceLabel: `市场 · ${TOPO.MARKET_NAME}`,
        targetLabel: `市场 · ${TOPO.MARKET_NAME}`,
        skuName: inv01.selfSkuName,
        quantity: QTY.selfSeed,
        remark: R.selfSeed,
        batchNo: `${NS}-ZCSEED-${STAMP}`,
      })
      const seedId = docIdByRemark('市场产品盘溢', R.selfSeed)
      if (seedId) {
        ctxState.genericDocsCreated = [...ctxState.genericDocsCreated, seedId]
        flushCtx()
      }
      recordVerdict(
        verdicts,
        `前置: 自采 SKU 在 ${TOPO.MARKET_NAME} 铺底 ${QTY.selfSeed} 件（盘溢）`,
        Boolean(seedId) && lotQtyAll(TOPO.MARKET, inv01.selfSkuId) >= QTY.selfTransfer,
        `${seedId || `建单失败: ${seedRes.toast}`}｜在手=${lotQtyAll(TOPO.MARKET, inv01.selfSkuId)}`,
      )
    }

    const selfRes = await createGenericDoc(page, {
      docType: '市场间调货出库',
      sourceLabel: `市场 · ${TOPO.MARKET_NAME}`,
      targetLabel: `市场 · ${TOPO.MARKET_OTHER_NAME}`,
      skuName: inv01.selfSkuName,
      quantity: QTY.selfTransfer,
      remark: R.selfTransfer,
      needLot: true,
    })
    recordVerdict(
      verdicts,
      '★ 自采 SKU 跨市场调出被拒',
      !selfRes.ok,
      `ok=${selfRes.ok} toast="${selfRes.toast}"`,
    )
    recordVerdict(
      verdicts,
      '拒绝文案点明「仅可在归属市场使用」',
      /仅可在归属市场使用/.test(selfRes.toast),
      selfRes.toast,
    )
    // 这条拦截发生在事务**内**（对目标库位再校验一次），靠回滚保证零落库
    recordVerdict(
      verdicts,
      '自采跨市场调货零落库（事务回滚）',
      docIdByRemark('市场间调货出库', R.selfTransfer) === '',
      docIdByRemark('市场间调货出库', R.selfTransfer) || '(无)',
    )

    if (nativeDialogs.length > 0) {
      // 这三个动作早就不该再出现原生弹窗了，真出现就是回归 —— 至少留下证据
      console.log('[INV-05] ⚠️ 出现了原生弹窗:', JSON.stringify(nativeDialogs))
    }
  } finally {
    flushCtx()
    await ctx.close()
    summarize(5, verdicts)
  }

  /*
   * 本套件的标准闸门。过滤器从 `/^(BLOCKED:|BUG-|UX-)/` 收敛为 `/^UX-/`：
   * BLOCKED 条目已随 #129 修复清空、BUG- 在本 spec 从未出现过，留着等于给未来的回归
   * 预开一个豁免口（同 inv-01 的既定做法）。UX- 保留给「并发降级」这类非缺陷项。
   */
  const ux = verdicts.filter((v) => v.verdict === 'FAIL' && v.check.startsWith('UX-'))
  const functional = verdicts.filter((v) => v.verdict === 'FAIL' && !v.check.startsWith('UX-'))
  if (ux.length > 0) console.log(`\n[INV-05] ⚠️ UX 发现:\n${JSON.stringify(ux, null, 2)}`)
  expect(functional, `INV-05 功能失败项:\n${JSON.stringify(functional, null, 2)}`).toHaveLength(0)
})
