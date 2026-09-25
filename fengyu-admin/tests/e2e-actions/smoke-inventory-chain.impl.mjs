/**
 * 进销存三级正向全链冒烟（impl）。由 smoke-inventory-chain.mjs 以
 * `bun --preload _inv-smoke-preload.mjs` 启动；会话经 globalThis.__INV_SESSION 切换。
 *
 * 金额断言一律读 DB（docHeader/docItems 原生 SQL），验证触发器单源
 * （inventory_set_doc_item_amount + inventory_refresh_doc_totals + set_doc_market_id）。
 */
import path from 'node:path'
import { closePool, pgQuery } from './setup.mjs'
import {
  HQ_ORG, MKA_ORG, MKB_ORG, STA1_ID, STA1_ORG, STA2_ID, STA2_ORG,
  SKU_SUPPLY, SKU_SELF, SUPPLIER_ID, PROMO_ID,
  cleanupInventoryFixture, ensureInventoryFixture, insertSeedLot, lotQuantity,
  docHeader, docItems, locationLots,
  marketASession, marketBSession, storeA1Session, storeA2Session, supplyChainSession,
} from './helpers/inventory-fixtures.mjs'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const ADMIN_DIR = path.resolve(TESTS_DIR, '..', '..')
const A = (...p) => 'file://' + path.join(ADMIN_DIR, ...p)

const report = []
let failed = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const setSession = (s) => { globalThis.__INV_SESSION = s }
/** #345 自动批号 =「单号-行号」，行号是明细在单内的写入序号（docItems 按 id 升序即写入序） */
const expectedLineBatchNo = (docId, items, item) =>
  `${docId}-${String(items.findIndex((row) => row.id === item?.id) + 1).padStart(2, '0')}`
const num = (v) => (v === null || v === undefined ? null : Number(v))
async function expectThrow(name, pattern, fn) {
  try {
    await fn()
    check(name, false, '未抛错（应被拦截）')
  } catch (e) {
    check(name, pattern.test(e.message ?? ''), e.message)
  }
}

try {
  await cleanupInventoryFixture()
  await ensureInventoryFixture()

  const biz = await import(A('src', 'actions', 'inventory', 'business.ts'))
  const docs = await import(A('src', 'actions', 'inventory', 'docs.ts'))

  // ════ 阶段 0：总部备货（品项公司报货需求 → 采购订单 → 供应链采购入库）════
  // #194 起两个采购入口已合并为 createPurchaseOrder，来源按 sourceItemId 反查、
  // 供应商由商品档案带出，单头不再挂供应商。
  setSession(supplyChainSession())
  const { id: zbhId } = await biz.createItemCompanyReplenishment({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 100 }],
  })
  const zbhHead = await docHeader(zbhId)
  const [zbhItem] = await docItems(zbhId)
  check('品项公司报货需求建单', zbhHead?.status === '已完成', `${zbhId} status=${zbhHead?.status}`)
  check('品项公司报货金额=数量×供应链采购价(触发器)', num(zbhHead?.total_amount) === 80000,
    `total_amount=${zbhHead?.total_amount}（期望 100×800）`)

  const { id: pcgId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: zbhItem.id, quantity: 100 }],
  })
  const pcgHead = await docHeader(pcgId)
  const [pcgItem] = await docItems(pcgId)
  check('采购订单(供应链行)建单为待收货', pcgHead?.status === '待收货', pcgId)
  check('采购单头不挂供应商，供应商落在明细行',
    !pcgHead?.supplier_id && Boolean(pcgItem?.supplier_id),
    `head=${pcgHead?.supplier_id} line=${pcgItem?.supplier_id}`)
  check('供应链行的 market_id 为空（据此分流到供应链入库）', !pcgItem?.market_id, `${pcgItem?.market_id}`)

  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: pcgId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: pcgItem.id, quantity: 100, batchNo: 'B100', expiryDate: '2027-12-31' }],
  })
  const hqLots = await locationLots(HQ_ORG, SKU_SUPPLY)
  const hqLot = hqLots[0]
  check('供应链采购入库→总部批次 100 且成本快照 800',
    hqLots.length === 1 && num(hqLot?.quantity_on_hand) === 100 && num(hqLot?.supply_chain_unit_cost) === 800,
    `lots=${hqLots.length} qty=${hqLot?.quantity_on_hand} cost=${hqLot?.supply_chain_unit_cost}`)
  check('采购订单全收后完结', (await docHeader(pcgId))?.status === '已完成', '')
  check('手填批号原样保存(#345)', hqLot?.batch_no === 'B100', `batch=${hqLot?.batch_no}`)

  // ════ 阶段 1：门店报货（§1.3 无价格）════
  setSession(storeA2Session())
  await expectThrow('越权：门店A2 库存员替门店A1 报货被拒', /PERMISSION_DENIED/, () =>
    biz.createStoreReplenishmentRequest({
      storeId: STA1_ID, marketId: MKA_ORG,
      items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
    }))

  setSession(storeA1Session())
  const { id: dbhId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 6 }],
  })
  const dbhHead = await docHeader(dbhId)
  const [dbhItem] = await docItems(dbhId)
  check('门店报货建单且不体现价格(§1.3)',
    dbhHead?.status === '已完成' && dbhHead?.total_amount === null && dbhItem?.amount === null,
    `${dbhId} total_amount=${dbhHead?.total_amount}`)
  check('门店报货 market_id 归属本市场(触发器)', dbhHead?.market_id === MKA_ORG, `market_id=${dbhHead?.market_id}`)

  // ════ 阶段 2：市场汇总（§3.1 日期过滤 + §3.2 实时库存参考）════
  setSession(marketASession())
  const summary = await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG })
  const summaryLine = summary.items.find((line) => line.skuId === SKU_SUPPLY)
  check('市场汇总提取本市场门店报货(§3.1)',
    summaryLine?.outstandingQuantity === 6 && summaryLine?.requestItemIds.includes(Number(dbhItem.id)),
    JSON.stringify(summaryLine ?? null))
  check('市场汇总附带实时库存参考(§3.2)',
    summaryLine?.onHandQuantity === 0 && summaryLine?.availableQuantity === 0 && summaryLine?.suggestedPurchaseQuantity === 6,
    `onHand=${summaryLine?.onHandQuantity} avail=${summaryLine?.availableQuantity}`)
  const staleSummary = await biz.summarizeStoreReplenishmentRequests({
    marketId: MKA_ORG,
    startDate: '2020-01-01',
    endDate: '2020-01-02',
  })
  check('市场汇总按日期范围过滤(§3.1)',
    !staleSummary.items.some((line) => line.skuId === SKU_SUPPLY),
    `旧日期窗口行数=${staleSummary.items.length}`)

  // ════ 阶段 3：福利报价 + 市场报货（§2.2/§3.3/§3.4）════
  const quote = await biz.quoteMarketReplenishmentPrices({
    marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 6 }],
  })
  const quoteLine = quote.items[0]
  check('福利报价：市场进货价-单价优惠=实际单价(§2.2/§3.3)',
    quoteLine?.marketStandardUnitPrice === 1000 && quoteLine?.marketUnitDiscount === 50
      && quoteLine?.marketActualUnitPrice === 950 && quoteLine?.promotionPlanId === PROMO_ID,
    JSON.stringify({ std: quoteLine?.marketStandardUnitPrice, disc: quoteLine?.marketUnitDiscount, act: quoteLine?.marketActualUnitPrice }))

  const { id: mbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG,
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [dbhItem.id], purchaseQuantity: 6 }],
  })
  const mbhHead = await docHeader(mbhId)
  const [mbhItem] = await docItems(mbhId)
  check('市场报货应付货款=Σ数量×实际单价(§3.4, DB 触发器)',
    num(mbhHead?.total_amount) === 5700 && num(mbhItem?.amount) === 5700,
    `total=${mbhHead?.total_amount} item=${mbhItem?.amount}`)
  check('市场报货明细快照：标准价/优惠/实际价 + 实时库存',
    num(mbhItem?.standard_unit_price) === 1000 && num(mbhItem?.unit_discount) === 50
      && num(mbhItem?.actual_unit_price) === 950 && num(mbhItem?.supply_chain_unit_cost) === 800,
    JSON.stringify({ std: mbhItem?.standard_unit_price, disc: mbhItem?.unit_discount, act: mbhItem?.actual_unit_price }))
  check('市场报货 market_id=本市场(触发器)', mbhHead?.market_id === MKA_ORG, `market_id=${mbhHead?.market_id}`)

  const resummary = await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG })
  check('门店需求被市场报货占用后不再重复汇总',
    !resummary.items.some((line) => line.skuId === SKU_SUPPLY),
    JSON.stringify(resummary.items.map((line) => line.skuId)))
  await expectThrow('重复提取同一门店报货明细被拒(CONFLICT)', /CONFLICT/, () =>
    biz.createMarketReplenishment({
      marketId: MKA_ORG,
      supplyChainLocationId: HQ_ORG,
      items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [dbhItem.id], purchaseQuantity: 1 }],
    }))

  // ════ 阶段 4：市场报货汇总 → 采购订单 ════
  // #193 起采购不再直接引用市场报货单，中间多一层跨市场汇总。
  setSession(supplyChainSession())
  // marketIds 过滤单独验一次：它走 sql.join 展开数组，写成 `= ANY($1::text[])` 会
  // 被 drizzle 绑成单个参数直接 Failed query，而默认不传该参数的路径测不出来。
  const filteredSummary = await biz.summarizeMarketReplenishmentRequests({
    supplyChainLocationId: HQ_ORG,
    marketIds: [MKA_ORG],
  })
  check('汇总支持按市场筛选（数组参数）',
    filteredSummary.items.length > 0 && filteredSummary.items.every((i) => i.marketId === MKA_ORG),
    `items=${filteredSummary.items.length}`)
  const emptyMarketSummary = await biz.summarizeMarketReplenishmentRequests({
    supplyChainLocationId: HQ_ORG,
    marketIds: [MKB_ORG],
  })
  check('按无需求的市场筛选得到空集', emptyMarketSummary.items.length === 0,
    `items=${emptyMarketSummary.items.length}`)

  const { id: mhzId } = await biz.createMarketReportSummary({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 6, sourceReportItemIds: [mbhItem.id] }],
  })
  const [mhzItem] = await docItems(mhzId)
  check('汇总单明细带市场归属', mhzItem?.market_id === MKA_ORG, `${mhzItem?.market_id}`)
  check('汇总不回写来源市场报货行的 fulfilled_quantity（占用只记血缘）',
    num((await docItems(mbhId))[0]?.fulfilled_quantity) === 0,
    `fulfilled=${(await docItems(mbhId))[0]?.fulfilled_quantity}`)

  const { id: cgdId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: mhzItem.id, quantity: 6 }],
  })
  const cgdHead = await docHeader(cgdId)
  const [cgdItem] = await docItems(cgdId)
  // #335：市场行也走供应链采购入库，金额按供应链采购价（6×800），市场结算价 950 只作参考列
  check('采购订单(市场行)金额=采购数量×供应链采购价，市场价只作参考(#335)',
    num(cgdHead?.total_amount) === 4800 && num(cgdItem?.actual_unit_price) === 800
      && num(cgdItem?.amount) === 4800 && num(cgdItem?.market_actual_unit_price) === 950,
    `total=${cgdHead?.total_amount} actual=${cgdItem?.actual_unit_price} mkt=${cgdItem?.market_actual_unit_price}`)
  check('纯市场行的采购订单建单为待收货(#335)', cgdHead?.status === '待收货', `${cgdHead?.status}`)
  check('市场行带市场归属（来源追溯）', cgdItem?.market_id === MKA_ORG, `${cgdItem?.market_id}`)
  const receiptInbox = await docs.listInventoryOperationDocs({ operationId: 'supply-chain-receipt' })
  check('纯市场行的采购订单进入供应链采购入库待办(#335)',
    (receiptInbox.inbox?.data ?? []).some((row) => row.id === cgdId),
    JSON.stringify((receiptInbox.inbox?.data ?? []).map((row) => row.id)))
  // #194 的关键设计：采购单同时写两类血缘 —— 对汇总行写 `报货汇总采购订单`，
  // 并跨过汇总单对**原始市场报货行**写 `市场报货采购订单`，
  // 好让 engine 统计「已采购」时不必穿透两跳。
  const cgdLinks = await pgQuery(
    `SELECT relation_type, from_doc_id, from_item_id, quantity
       FROM inventory_doc_links WHERE to_doc_id = $1 ORDER BY relation_type`, [cgdId])
  check('采购单写了汇总血缘 + 跨汇总的原始报货血缘',
    cgdLinks.some((l) => l.relation_type === '报货汇总采购订单' && l.from_doc_id === mhzId)
    && cgdLinks.some((l) => l.relation_type === '市场报货采购订单' && l.from_doc_id === mbhId
      && num(l.quantity) === 6),
    JSON.stringify(cgdLinks))
  await expectThrow('超出汇总单未下单数量被拒(CONFLICT)', /CONFLICT/, () =>
    biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: mhzItem.id, quantity: 1 }],
    }))
  await expectThrow('原始市场报货单不能直接下采购订单(INVALID_STATE)', /INVALID_STATE/, () =>
    biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: mbhItem.id, quantity: 1 }],
    }))

  // ════ 阶段 4b：市场行供应链采购入库（#335，分批 2 + 1 + 3，超量被拒；批号留空自动生成 #345）════
  // #346：第一批填单价优惠 20（实际进价 780），第二批（1 件）优惠 30（770），第三批不填（800）
  const { id: cgdFirstInboundId } = await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: cgdId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: cgdItem.id, quantity: 2, unitDiscount: 20, expiryDate: '2027-12-31' }],
  })
  const [cgdFirstInboundItem] = await docItems(cgdFirstInboundId)
  check('#346 入库明细 标准 800 / 优惠 20 / 实际 780，金额 = 2 × 780',
    num(cgdFirstInboundItem?.standard_unit_price) === 800 && num(cgdFirstInboundItem?.unit_discount) === 20
      && num(cgdFirstInboundItem?.actual_unit_price) === 780 && num(cgdFirstInboundItem?.amount) === 1560
      && num(cgdFirstInboundItem?.supply_chain_unit_cost) === 780,
    JSON.stringify(cgdFirstInboundItem))
  const cgdPartialRow = (await docs.getInventoryCoreDocById(cgdId))
  const cgdPartialProgress = cgdPartialRow?.fulfillmentProgress
  check('市场行入库 2/6：待收货 + 派生「部分入库」，剩余 4(#335)',
    cgdPartialRow?.status === '待收货' && cgdPartialRow?.partiallyReceived === true
      && cgdPartialProgress?.kind === '供应链采购收货'
      && cgdPartialProgress.items[0]?.receivedQuantity === 2
      && cgdPartialProgress.items[0]?.outstandingQuantity === 4,
    JSON.stringify({ status: cgdPartialRow?.status, partial: cgdPartialRow?.partiallyReceived, progress: cgdPartialProgress }))
  check('#346 部分入库时入库后实际金额 = 已入库 2 × 780 + 未入库 4 × 下单价 800 = 4760；下单金额仍 4800',
    cgdPartialProgress?.items[0]?.receivedAmount === 1560 && cgdPartialProgress?.items[0]?.actualAmount === 4760
      && cgdPartialRow?.totalAmount === 4800,
    JSON.stringify({ progress: cgdPartialProgress?.items[0], total: cgdPartialRow?.totalAmount }))
  await expectThrow('市场行超过剩余量入库被拒(CONFLICT)', /CONFLICT/, () =>
    biz.receiveSupplyChainPurchaseOrder({
      purchaseOrderId: cgdId,
      supplyChainLocationId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgdItem.id, quantity: 5, batchNo: 'MKT-A', expiryDate: '2027-12-31' }],
    }))
  // 剩余 4 件拆成两张入库单并发提交：两个事务同时生成批号也不能重号（#345）
  const [{ id: cgdSecondInboundId }, { id: cgdInboundId }] = await Promise.all([
    biz.receiveSupplyChainPurchaseOrder({
      purchaseOrderId: cgdId,
      supplyChainLocationId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgdItem.id, quantity: 1, unitDiscount: 30, expiryDate: '2027-12-31' }],
    }),
    biz.receiveSupplyChainPurchaseOrder({
      purchaseOrderId: cgdId,
      supplyChainLocationId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgdItem.id, quantity: 3, expiryDate: '2027-12-31' }],
    }),
  ])
  check('市场行全部入库后采购订单完结(#335)', (await docHeader(cgdId))?.status === '已完成', '')
  // 三次入库各落一个批次（批次键含来源入库单），合计 6 件
  const cgdInboundIds = [cgdFirstInboundId, cgdSecondInboundId, cgdInboundId]
  const mktHqLots = (await locationLots(HQ_ORG, SKU_SUPPLY)).filter((lot) => lot.batch_no !== 'B100')
  check('市场行入库生成总部批次合计 6 件；批次成本按各次实际进价 780 / 770 / 800(#335 #346)',
    mktHqLots.length === 3
      && mktHqLots.reduce((sum, lot) => sum + num(lot.quantity_on_hand), 0) === 6
      && JSON.stringify(mktHqLots.map((lot) => [num(lot.quantity_on_hand), num(lot.supply_chain_unit_cost)]).sort((a, b) => a[1] - b[1]))
        === JSON.stringify([[1, 770], [2, 780], [3, 800]]),
    JSON.stringify(mktHqLots.map((lot) => [lot.quantity_on_hand, lot.supply_chain_unit_cost])))
  const skuMaster = await pgQuery(`SELECT supply_chain_purchase_price FROM inventory_skus WHERE sku_id = $1`, [SKU_SUPPLY])
  check('#346 商品档案供应链采购价不变（仍 800）', num(skuMaster[0]?.supply_chain_purchase_price) === 800,
    `${skuMaster[0]?.supply_chain_purchase_price}`)
  const cgdDoneProgress = (await docs.getInventoryCoreDocById(cgdId))?.fulfillmentProgress?.items?.[0]
  const cgdInboundTotal = (await Promise.all([cgdFirstInboundId, cgdSecondInboundId, cgdInboundId].map((id) => docHeader(id))))
    .reduce((sum, head) => sum + num(head?.total_amount), 0)
  check('#346 全部入库后：入库后实际金额 = 各入库单金额之和（1560 + 770 + 2400 = 4730）',
    cgdDoneProgress?.actualAmount === 4730 && cgdInboundTotal === 4730,
    JSON.stringify({ progress: cgdDoneProgress, inboundTotal: cgdInboundTotal }))
  const cgdInboundItems = (await Promise.all(cgdInboundIds.map((id) => docItems(id)))).flat()
  const expectedAutoBatchNos = cgdInboundIds.map((id) => `${id}-01`)
  check('批号留空：入库明细与批次按「入库单号-行号」生成，三次（含并发两次）互不相同(#345)',
    cgdInboundItems.length === 3
      && cgdInboundItems.every((item, index) => item.batch_no === expectedAutoBatchNos[index])
      && new Set(mktHqLots.map((lot) => lot.batch_no)).size === 3
      && mktHqLots.every((lot) => expectedAutoBatchNos.includes(lot.batch_no))
      && cgdInboundIds.every((id) => /^GRK-\d{8}-\d{4}$/.test(id)),
    JSON.stringify({ items: cgdInboundItems.map((item) => item.batch_no), lots: mktHqLots.map((lot) => lot.batch_no) }))
  const inboundTrace = await pgQuery(
    `SELECT l.from_item_id, po_item.market_id
       FROM inventory_doc_links l
       JOIN inventory_doc_items po_item ON po_item.id = l.from_item_id
      WHERE l.to_doc_id = $1 AND l.relation_type = '采购订单供应链采购入库'`, [cgdInboundId])
  check('入库明细可追溯到采购行及其市场来源(#335)',
    inboundTrace.length === 1 && Number(inboundTrace[0].from_item_id) === Number(cgdItem.id)
      && inboundTrace[0].market_id === MKA_ORG,
    JSON.stringify(inboundTrace))
  await expectThrow('已完成的采购订单不能再入库(INVALID_STATE)', /INVALID_STATE/, () =>
    biz.receiveSupplyChainPurchaseOrder({
      purchaseOrderId: cgdId,
      supplyChainLocationId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgdItem.id, quantity: 1 }],
    }))
  await expectThrow('已完成的采购订单不能关闭(INVALID_STATE)', /INVALID_STATE/, () =>
    biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: cgdId, cancellationReason: '测试' }))

  // ════ 阶段 5：品项公司发货（§5.2 赠送 / §5.3 无金额）════
  // #336 起发货直接引用市场原始报货单，以报货行未发量封顶，不再经采购订单；
  // 发货批次沿用总部备货批次，下游库存断言保持不变。
  await expectThrow('正常发货数量超过报货未发量被拒，报错写明可发上限(#336)', /CONFLICT.*最多可发 6/, () =>
    biz.createItemCompanyShipment({
      marketId: MKA_ORG,
      sourceOrgNodeId: HQ_ORG,
      items: [{ reportItemId: mbhItem.id, lotId: hqLot.id, quantity: 7 }],
    }))
  await expectThrow('发往别的市场被拒：报货单不是该收货市场报的(#336)', /INVALID_STATE/, () =>
    biz.createItemCompanyShipment({
      marketId: MKB_ORG,
      sourceOrgNodeId: HQ_ORG,
      items: [{ reportItemId: mbhItem.id, lotId: hqLot.id, quantity: 1 }],
    }))
  const { id: gfhId } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG,
    sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: mbhItem.id, lotId: hqLot.id, quantity: 6 }],
    giftItems: [{ reportItemId: mbhItem.id, lotId: hqLot.id, quantity: 2 }],
  })
  const gfhLinks = await pgQuery(
    `SELECT from_doc_id, from_item_id, relation_type, quantity FROM inventory_doc_links
      WHERE to_doc_id = $1 ORDER BY relation_type`, [gfhId])
  check('发货写「市场报货 → 品项公司发货」直连血缘，不再挂采购订单(#336)',
    gfhLinks.length === 2
      && gfhLinks.every((link) => link.from_doc_id === mbhId && Number(link.from_item_id) === Number(mbhItem.id))
      && gfhLinks.some((link) => link.relation_type === '市场报货发货' && num(link.quantity) === 6)
      && gfhLinks.some((link) => link.relation_type === '市场报货赠送发货' && num(link.quantity) === 2),
    JSON.stringify(gfhLinks))
  check('发货不回写采购行 fulfilled（只记入库量）(#335)',
    num((await docItems(cgdId))[0]?.fulfilled_quantity) === 6, `${(await docItems(cgdId))[0]?.fulfilled_quantity}`)
  const gfhHead = await docHeader(gfhId)
  const gfhItems = await docItems(gfhId)
  const gfhNormal = gfhItems.find((item) => !item.is_gift)
  const gfhGift = gfhItems.find((item) => item.is_gift)
  check('品项公司发货：正常+赠送两行且总量可大于报货(§5.2)',
    gfhItems.length === 2 && num(gfhNormal?.quantity) === 6 && num(gfhGift?.quantity) === 2,
    `items=${gfhItems.length}`)
  check('发货正常行 request_quantity 存报货数量(#336)',
    num(gfhNormal?.request_quantity) === num(mbhItem.quantity), `${gfhNormal?.request_quantity}`)
  check('品项公司发货：正常行沿用来源批号，赠送行按「发货单号-行号」生成独立批号(#345)',
    gfhNormal?.batch_no === 'B100' && gfhGift?.batch_no === expectedLineBatchNo(gfhId, gfhItems, gfhGift),
    JSON.stringify({ normal: gfhNormal?.batch_no, gift: gfhGift?.batch_no }))
  check('品项公司发货明细不携带价格快照(§5.3)',
    gfhItems.every((item) => item.actual_unit_price === null
      && item.market_actual_unit_price === null && item.supply_chain_unit_cost === null),
    JSON.stringify(gfhItems.map((item) => item.actual_unit_price)))
  // 赠送行金额被 DB 触发器按赠品规则置 0，单头汇总出 0.00；业务响应层必须整单遮蔽金额（§5.3/§10.4）
  const gfhDetail = await docs.getInventoryCoreDocById(gfhId)
  check('品项公司发货业务响应不展示货款金额(§5.3/§10.4)',
    gfhDetail !== null && gfhDetail.totalAmount === undefined
      && gfhDetail.items.every((item) => item.amount === undefined
        && item.standardUnitPrice === undefined && item.unitDiscount === undefined
        && item.actualUnitPrice === undefined && item.supplyChainUnitCost === undefined
        && item.marketActualUnitPrice === undefined && item.storeActualUnitPrice === undefined),
    JSON.stringify({ headTotal: gfhDetail?.totalAmount, dbTotal: gfhHead?.total_amount }))
  const hqAfterShip = await locationLots(HQ_ORG, SKU_SUPPLY)
  check('发货扣减总部库存 100-8=92', num(hqAfterShip[0]?.quantity_on_hand) === 92,
    `qty=${hqAfterShip[0]?.quantity_on_hand}`)

  // ════ 阶段 6：市场采购入库（§6.1 凭发货单收货；跨市场被拒 §9.4）════
  setSession(marketBSession())
  await expectThrow('市场B 不能收市场A 的品项公司发货(§9.4)', /PERMISSION_DENIED/, () =>
    biz.receiveItemCompanyShipment({
      shipmentId: gfhId,
      items: [{ shipmentItemId: gfhNormal.id, receivedQuantity: 6 }],
    }))

  setSession(marketASession())
  const { id: mrkId } = await biz.receiveItemCompanyShipment({
    shipmentId: gfhId,
    items: [
      { shipmentItemId: gfhNormal.id, receivedQuantity: 6 },
      { shipmentItemId: gfhGift.id, receivedQuantity: 2 },
    ],
  })
  const mrkHead = await docHeader(mrkId)
  check('市场采购入库金额=6×950（赠送 0，触发器）', num(mrkHead?.total_amount) === 5700,
    `total=${mrkHead?.total_amount}`)
  check('发货单全收后完结', (await docHeader(gfhId))?.status === '已完成', '')
  const mkaLots = await locationLots(MKA_ORG, SKU_SUPPLY)
  const mkaNormalLot = mkaLots.find((lot) => !lot.is_gift)
  const mkaGiftLot = mkaLots.find((lot) => lot.is_gift)
  check('市场批次价格快照（真实单价 950 取自报货行 / 门店标准价 1200 / 成本 800 取自总部批次）',
    num(mkaNormalLot?.quantity_on_hand) === 6
      && num(mkaNormalLot?.market_actual_unit_price) === num(mbhItem.market_actual_unit_price)
      && num(mkaNormalLot?.market_actual_unit_price) === 950
      && num(mkaNormalLot?.store_standard_unit_price) === 1200
      && num(mkaNormalLot?.supply_chain_unit_cost) === num(hqLot.supply_chain_unit_cost)
      && num(mkaGiftLot?.quantity_on_hand) === 2,
    JSON.stringify({ normal: mkaNormalLot?.quantity_on_hand, gift: mkaGiftLot?.quantity_on_hand }))
  check('赠送批次两类价格都记 0（市场价三列 + 供应链成本）(#336 拍板)',
    num(mkaGiftLot?.market_standard_unit_price) === 0 && num(mkaGiftLot?.market_unit_discount) === 0
      && num(mkaGiftLot?.market_actual_unit_price) === 0 && num(mkaGiftLot?.supply_chain_unit_cost) === 0,
    JSON.stringify({
      std: mkaGiftLot?.market_standard_unit_price, disc: mkaGiftLot?.market_unit_discount,
      act: mkaGiftLot?.market_actual_unit_price, cost: mkaGiftLot?.supply_chain_unit_cost,
    }))
  // 分院配货的批次下拉按 batch_no 展示：赠送批次与同源正常批次必须能区分
  check('市场收货沿用发货明细批号：赠送批次与正常批次批号不同(#345)',
    mkaNormalLot?.batch_no === 'B100' && mkaGiftLot?.batch_no === expectedLineBatchNo(gfhId, gfhItems, gfhGift),
    JSON.stringify({ normal: mkaNormalLot?.batch_no, gift: mkaGiftLot?.batch_no }))
  // 走 LotPicker 的同一个数据源（listInventoryLotOptions），按页面文案拼出两条选项，必须互不相同
  const lotStocks = await import(A('src', 'actions', 'inventory', 'stocks.ts'))
  const mkaLotOptions = await lotStocks.listInventoryLotOptions(MKA_ORG, SKU_SUPPLY)
  const mkaOptionLabels = mkaLotOptions.map((lot) => `批次 ${lot.batchNo || '未填写'}`)
  check('分院配货批次下拉数据源：正常与赠送两条选项批号不同(#345)',
    mkaLotOptions.length === 2
      && mkaLotOptions.some((lot) => lot.batchNo === mkaNormalLot?.batch_no)
      && mkaLotOptions.some((lot) => lot.batchNo === mkaGiftLot?.batch_no)
      && new Set(mkaOptionLabels).size === 2,
    JSON.stringify(mkaOptionLabels))

  const mbhDetail = await docs.getInventoryCoreDocById(mbhId)
  const mbhProgress = mbhDetail?.fulfillmentProgress
  const mbhProgressItem = mbhProgress?.items?.[0]
  check('市场报货可见发货/收货进度(§5.1)',
    mbhProgress?.kind === '报货履约'
      && mbhProgressItem?.orderedQuantity === 6
      && mbhProgressItem?.normalFulfilledQuantity === 6
      && mbhProgressItem?.giftFulfilledQuantity === 2
      && mbhProgressItem?.normalReceivedQuantity === 6
      && mbhProgressItem?.giftReceivedQuantity === 2,
    JSON.stringify(mbhProgressItem ?? null))

  // ════ 阶段 7：分院配货（§7.2 赠送 / §7.3 金额四件套）════
  const { id: fphId } = await biz.createStoreAllocation({
    storeRequestId: dbhId,
    sourceMarketId: MKA_ORG,
    items: [{ requestItemId: dbhItem.id, lotId: mkaNormalLot.id, quantity: 5, giftQuantity: 1, storeUnitDiscount: 100 }],
  })
  const fphHead = await docHeader(fphId)
  const fphItems = await docItems(fphId)
  const fphNormal = fphItems.find((item) => !item.is_gift)
  const fphGift = fphItems.find((item) => item.is_gift)
  check('分院配货金额四件套：1200-100=1100×5=5500(§7.3)',
    num(fphNormal?.standard_unit_price) === 1200 && num(fphNormal?.unit_discount) === 100
      && num(fphNormal?.actual_unit_price) === 1100 && num(fphNormal?.amount) === 5500
      && num(fphHead?.total_amount) === 5500,
    JSON.stringify({ std: fphNormal?.standard_unit_price, disc: fphNormal?.unit_discount, act: fphNormal?.actual_unit_price, total: fphHead?.total_amount }))
  check('分院配货赠送行金额 0(§7.2)', num(fphGift?.amount) === 0, `gift amount=${fphGift?.amount}`)
  check('分院配货从正常批次拨赠送：赠送行按「配货单号-行号」生成独立批号(#345)',
    fphNormal?.batch_no === 'B100' && fphGift?.batch_no === expectedLineBatchNo(fphId, fphItems, fphGift),
    JSON.stringify({ normal: fphNormal?.batch_no, gift: fphGift?.batch_no }))
  await expectThrow('分院配货超出门店报货未配数量被拒(CONFLICT)', /CONFLICT/, () =>
    biz.createStoreAllocation({
      storeRequestId: dbhId,
      sourceMarketId: MKA_ORG,
      items: [{ requestItemId: dbhItem.id, lotId: mkaGiftLot.id, quantity: 2 }],
    }))

  // ════ 阶段 8：院入库 + 真实单价延续 ════
  setSession(storeA1Session())
  const { id: yrkId } = await biz.receiveStoreAllocation({
    shipmentId: fphId,
    items: [
      { shipmentItemId: fphNormal.id, receivedQuantity: 5 },
      { shipmentItemId: fphGift.id, receivedQuantity: 1 },
    ],
  })
  const yrkHead = await docHeader(yrkId)
  const storeLots = await locationLots(STA1_ID, SKU_SUPPLY)
  const storeNormalLot = storeLots.find((lot) => !lot.is_gift)
  check('院入库金额=5×1100（赠送 0）且配货单完结',
    num(yrkHead?.total_amount) === 5500 && (await docHeader(fphId))?.status === '已完成',
    `total=${yrkHead?.total_amount}`)
  check('门店批次锁定真实单价 1100（后续退货/调货基准 §7.3）',
    num(storeNormalLot?.quantity_on_hand) === 5 && num(storeNormalLot?.store_actual_unit_price) === 1100,
    JSON.stringify({ qty: storeNormalLot?.quantity_on_hand, act: storeNormalLot?.store_actual_unit_price }))
  const storeGiftLot = storeLots.find((lot) => lot.is_gift)
  check('院入库沿用配货明细批号：门店赠送批次与正常批次批号不同(#345)',
    storeNormalLot?.batch_no === 'B100' && storeGiftLot?.batch_no === expectedLineBatchNo(fphId, fphItems, fphGift),
    JSON.stringify({ normal: storeNormalLot?.batch_no, gift: storeGiftLot?.batch_no }))

  const dbhDetail = await docs.getInventoryCoreDocById(dbhId)
  const dbhProgressItem = dbhDetail?.fulfillmentProgress?.items?.[0]
  check('门店报货可见配货/收货进度(§7.1)',
    dbhProgressItem?.normalFulfilledQuantity === 5 && dbhProgressItem?.giftFulfilledQuantity === 1
      && dbhProgressItem?.normalReceivedQuantity === 5 && dbhProgressItem?.giftReceivedQuantity === 1,
    JSON.stringify(dbhProgressItem ?? null))

  // ════ 阶段 9：价格档位与 scope（§8.1/§9.4/§9.5）════
  const yrkAsStore = await docs.getInventoryCoreDocById(yrkId)
  const storeItem = yrkAsStore?.items?.find((item) => !item.isGift)
  check('门店档不返回任何金额字段(§8.1/§9.5)',
    yrkAsStore !== null && yrkAsStore.totalAmount === undefined
      && storeItem?.standardUnitPrice === undefined && storeItem?.actualUnitPrice === undefined
      && storeItem?.amount === undefined && storeItem?.storeActualUnitPrice === undefined
      && storeItem?.supplyChainUnitCost === undefined,
    JSON.stringify({ total: yrkAsStore?.totalAmount, std: storeItem?.standardUnitPrice }))

  setSession(marketASession())
  const yrkAsMarket = await docs.getInventoryCoreDocById(yrkId)
  const marketItem = yrkAsMarket?.items?.find((item) => !item.isGift)
  check('市场档可见门店结算价但不可见供应链成本(§9.5)',
    marketItem?.storeActualUnitPrice === 1100 && marketItem?.supplyChainUnitCost === undefined,
    JSON.stringify({ storeAct: marketItem?.storeActualUnitPrice, cost: marketItem?.supplyChainUnitCost }))

  // §9.3/F1 回归：混合绑定（市场B财务 + 门店A1库存员）读门店A 单据，
  // 不得借市场 B 的价格权看到金额；价格档位必须按行级参与主体判定。
  {
    const mbRole = marketBSession().roles[0]
    const saRole = storeA1Session().roles[0]
    setSession({
      employeeId: saRole.scopeId,
      name: 'TE2AI_混合绑定',
      phone: '19999089000',
      roles: [mbRole, saRole],
      permissions: {
        actions: [...new Set([...mbRole.actions, ...saRole.actions])],
        scopeStoreIds: [...mbRole.scopeStoreIds, ...saRole.scopeStoreIds],
        scopeOrgNodeIds: [...mbRole.scopeOrgNodeIds, ...saRole.scopeOrgNodeIds],
      },
    })
    const yrkAsMixed = await docs.getInventoryCoreDocById(yrkId)
    const mixedItem = yrkAsMixed?.items?.find((item) => !item.isGift)
    check('混合绑定读门店A单据不得借市场B价格权(§9.3/F1)',
      yrkAsMixed !== null && yrkAsMixed.totalAmount === undefined
        && mixedItem?.standardUnitPrice === undefined && mixedItem?.actualUnitPrice === undefined
        && mixedItem?.amount === undefined && mixedItem?.storeActualUnitPrice === undefined
        && mixedItem?.marketActualUnitPrice === undefined && mixedItem?.supplyChainUnitCost === undefined,
      JSON.stringify({ total: yrkAsMixed?.totalAmount, act: mixedItem?.actualUnitPrice }))
  }

  setSession(supplyChainSession())
  check('总部 scope 不因父级关系看到市场↔门店单据(§9.2/§9.4)',
    (await docs.getInventoryCoreDocById(yrkId)) === null, yrkId)
  setSession(marketBSession())
  check('跨市场单据互不可见(§9.4)', (await docs.getInventoryCoreDocById(mbhId)) === null, mbhId)

  // ════ 阶段 9.5：货款结算真库口径 + 预留后可用量（F4）════
  const settle = await import(A('src', 'actions', 'inventory', 'settlements.ts'))
  const stocks = await import(A('src', 'actions', 'inventory', 'stocks.ts'))

  setSession(marketASession())
  const settlementAsMarket = await settle.listInventorySettlements({})
  const marketPayableRow = settlementAsMarket.marketRows.find((row) =>
    [row.sourceOrgNodeId, row.targetOrgNodeId].includes(MKA_ORG))
  const storePayableRow = settlementAsMarket.storeRows.find((row) =>
    [row.sourceOrgNodeId, row.targetOrgNodeId].some((id) => id === STA1_ORG || id === STA1_ID))
  check('市场结算=市场报货应付货款 5700(§3.4)',
    settlementAsMarket.canViewMarketSettlement === true
      && marketPayableRow?.payableAmount === 5700 && marketPayableRow?.docCount === 1,
    JSON.stringify(settlementAsMarket.marketRows))
  check('分院结算=分院配货应付货款 5500(§7.3)',
    settlementAsMarket.canViewStoreSettlement === true
      && storePayableRow?.payableAmount === 5500 && storePayableRow?.docCount === 1,
    JSON.stringify(settlementAsMarket.storeRows))

  setSession(supplyChainSession())
  const settlementAsSupply = await settle.listInventorySettlements({})
  check('供应链档见市场结算、不见分院结算(§9.5)',
    settlementAsSupply.canViewStoreSettlement === false && settlementAsSupply.storeRows.length === 0
      && settlementAsSupply.marketRows.some((row) => row.payableAmount === 5700),
    JSON.stringify({ market: settlementAsSupply.marketRows.length, store: settlementAsSupply.storeRows.length }))

  setSession(storeA1Session())
  const settlementAsStore = await settle.listInventorySettlements({})
  check('门店档结算报表不返回任何金额行(§9.5)',
    settlementAsStore.canViewMarketSettlement === false && settlementAsStore.canViewStoreSettlement === false
      && settlementAsStore.marketRows.length === 0 && settlementAsStore.storeRows.length === 0,
    JSON.stringify(settlementAsStore.marketRows))

  // 建预留（quantity 3 − fulfilled 1 − released 1 = 活动预留 1）后查可用量 = 5 − 1 = 4
  await pgQuery(
    `INSERT INTO inventory_stock_reservations (
       request_doc_id, request_item_id, lot_id, location_id, sku_id,
       quantity, fulfilled_quantity, released_quantity, status
     ) VALUES ($1, $2, $3, $4, $5, 3, 1, 1, '已预留')`,
    [dbhId, dbhItem.id, storeNormalLot.id, STA1_ID, SKU_SUPPLY],
  )
  const stockList = await stocks.listInventoryLots({ locationId: STA1_ID, skuId: SKU_SUPPLY })
  const reservedLotRow = stockList.data.find((row) => row.id === Number(storeNormalLot.id))
  check('建预留后可用量=在手−未完成预留(5−(3−1−1)=4)',
    reservedLotRow?.quantityOnHand === 5 && reservedLotRow?.availableQuantity === 4,
    JSON.stringify({ onHand: reservedLotRow?.quantityOnHand, avail: reservedLotRow?.availableQuantity }))
  check('门店档批次行无任何价格字段(§9.5)',
    reservedLotRow !== undefined && reservedLotRow.supplyChainUnitCost === undefined
      && reservedLotRow.marketActualUnitPrice === undefined && reservedLotRow.storeActualUnitPrice === undefined,
    JSON.stringify({ cost: reservedLotRow?.supplyChainUnitCost }))

  // ════ 阶段 10：品项公司发货撤回（§6.2 市场只申请、供应链审批）════
  setSession(storeA1Session())
  const { id: dbh2Id } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 3 }],
  })
  const [dbh2Item] = await docItems(dbh2Id)
  setSession(marketASession())
  const { id: mbh2Id } = await biz.createMarketReplenishment({
    marketId: MKA_ORG,
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [dbh2Item.id], purchaseQuantity: 3 }],
  })
  const [mbh2Item] = await docItems(mbh2Id)
  setSession(supplyChainSession())
  const { id: mhz2Id } = await biz.createMarketReportSummary({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 3, sourceReportItemIds: [mbh2Item.id] }],
  })
  const [mhz2Item] = await docItems(mhz2Id)
  const { id: cgd2Id } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: mhz2Item.id, quantity: 3 }],
  })
  const [cgd2Item] = await docItems(cgd2Id)
  const { id: gfh2Id } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG,
    sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: mbh2Item.id, lotId: hqLot.id, quantity: 3 }],
  })
  check('第二笔发货扣减总部库存 92-3=89',
    num((await locationLots(HQ_ORG, SKU_SUPPLY))[0]?.quantity_on_hand) === 89, '')

  setSession(marketASession())
  await expectThrow('市场端不可自行审批撤回(§6.2)', /PERMISSION_DENIED/, () =>
    biz.approveItemCompanyShipmentCancellation({ shipmentId: gfh2Id }))
  await biz.requestItemCompanyShipmentCancellation({
    shipmentId: gfh2Id,
    cancellationReason: '入库时发现效期异常',
  })
  check('撤回申请后发货单转待审批', (await docHeader(gfh2Id))?.status === '待审批', '')

  setSession(supplyChainSession())
  const mbh2PendingShipped = (await docs.getInventoryCoreDocById(mbh2Id))?.fulfillmentProgress?.items?.[0]?.normalFulfilledQuantity
  check('撤回待审批期间发货量仍占报货额度（与封顶同口径）(#336)', mbh2PendingShipped === 3, `${mbh2PendingShipped}`)
  await biz.approveItemCompanyShipmentCancellation({ shipmentId: gfh2Id, auditRemark: '同意撤回' })
  const gfh2Head = await docHeader(gfh2Id)
  const [cgd2ItemAfter] = await docItems(cgd2Id)
  const mbh2Progress = (await docs.getInventoryCoreDocById(mbh2Id))?.fulfillmentProgress?.items?.[0]
  check('供应链审批撤回：单据取消 + 总部库存回滚 + 报货行可发量恢复、采购行不动(§6.2/#336)',
    gfh2Head?.status === '已取消'
      && num((await locationLots(HQ_ORG, SKU_SUPPLY))[0]?.quantity_on_hand) === 92
      && num(cgd2ItemAfter?.fulfilled_quantity) === 0
      && mbh2Progress?.normalFulfilledQuantity === 0,
    `status=${gfh2Head?.status} fulfilled=${cgd2ItemAfter?.fulfilled_quantity} progress=${JSON.stringify(mbh2Progress)}`)
  // 发货与采购单脱钩（#336）：关单不再看发货量
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: cgd2Id, cancellationReason: '撤回后关闭' })
  check('市场行采购订单可关闭(#335/#336)', (await docHeader(cgd2Id))?.status === '已取消', '')
  await expectThrow('已关闭的采购订单不能入库(INVALID_STATE)', /INVALID_STATE/, () =>
    biz.receiveSupplyChainPurchaseOrder({
      purchaseOrderId: cgd2Id,
      supplyChainLocationId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgd2Item.id, quantity: 1 }],
    }))
  setSession(marketASession())
  const gfh2FirstItem = (await docItems(gfh2Id))[0]
  await expectThrow('已取消发货单不可再收货(§6.1)', /INVALID_STATE/, () =>
    biz.receiveItemCompanyShipment({
      shipmentId: gfh2Id,
      items: [{ shipmentItemId: gfh2FirstItem.id, receivedQuantity: 3 }],
    }))

  // ════ 阶段 9：混合采购单（市场行 + 供应链自用行）关闭 ════
  // #194 的新能力，也是评审两轮里各被打回一次的路径：
  // 早先「含市场行」一刀切拒绝关单 → 混合单供应链短供时既关不掉也释放不了占用；
  // 改成「市场行已发货才拒绝」后，释放循环又只认品项公司血缘，市场行照样报错。
  setSession(supplyChainSession())
  const { id: mixReqId } = await biz.createItemCompanyReplenishment({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 4 }],
  })
  const [mixReqItem] = await docItems(mixReqId)
  setSession(storeA1Session())
  const { id: mixStoreReqId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 2 }],
  })
  const [mixStoreItem] = await docItems(mixStoreReqId)
  setSession(marketASession())
  const { id: mixMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [mixStoreItem.id], purchaseQuantity: 2 }],
  })
  const [mixMbhItem] = await docItems(mixMbhId)
  setSession(supplyChainSession())
  const { id: mixMhzId } = await biz.createMarketReportSummary({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 2, sourceReportItemIds: [mixMbhItem.id] }],
  })
  const [mixMhzItem] = await docItems(mixMhzId)

  const { id: mixPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [
      { sourceItemId: mixReqItem.id, quantity: 4 },
      { sourceItemId: mixMhzItem.id, quantity: 2 },
    ],
  })
  const mixPoItems = await docItems(mixPoId)
  check('混合采购单：一张单同时含市场行与供应链自用行',
    mixPoItems.length === 2
      && mixPoItems.some((i) => i.market_id === MKA_ORG)
      && mixPoItems.some((i) => !i.market_id),
    JSON.stringify(mixPoItems.map((i) => ({ m: i.market_id, q: i.quantity }))))
  check('含供应链行的混合单状态为待收货',
    (await docHeader(mixPoId))?.status === '待收货', '')
  check('两类来源行的 fulfilled 都已占用',
    num((await docItems(mixReqId))[0]?.fulfilled_quantity) === 4
      && num((await docItems(mixMhzId))[0]?.fulfilled_quantity) === 2,
    `req=${(await docItems(mixReqId))[0]?.fulfilled_quantity} mhz=${(await docItems(mixMhzId))[0]?.fulfilled_quantity}`)

  await biz.cancelSupplyChainPurchaseOrder({
    purchaseOrderId: mixPoId, cancellationReason: '供应商短供',
  })
  check('混合单（市场行未发货）可关闭',
    (await docHeader(mixPoId))?.status === '已取消', '')
  check('关闭后两类来源行的 fulfilled 都回退',
    num((await docItems(mixReqId))[0]?.fulfilled_quantity) === 0
      && num((await docItems(mixMhzId))[0]?.fulfilled_quantity) === 0,
    `req=${(await docItems(mixReqId))[0]?.fulfilled_quantity} mhz=${(await docItems(mixMhzId))[0]?.fulfilled_quantity}`)
  // ════ 阶段 9b：市场行部分入库后关单（#335）════
  // 关单只退还未入库的部分：汇总行保留已入库量；原始市场报货的「已采购」按已入库保留，
  // 再次下单剩余量时不得把已入库的部分重复分摊到原始行上。
  setSession(storeA1Session())
  const { id: pcStoreReqId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 4 }],
  })
  const [pcStoreItem] = await docItems(pcStoreReqId)
  setSession(marketASession())
  const { id: pcMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [pcStoreItem.id], purchaseQuantity: 4 }],
  })
  const [pcMbhItem] = await docItems(pcMbhId)
  setSession(supplyChainSession())
  const { id: pcMhzId } = await biz.createMarketReportSummary({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 4, sourceReportItemIds: [pcMbhItem.id] }],
  })
  const [pcMhzItem] = await docItems(pcMhzId)
  const { id: pcPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: pcMhzItem.id, quantity: 4 }],
  })
  const [pcPoItem] = await docItems(pcPoId)
  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: pcPoId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: pcPoItem.id, quantity: 1, unitDiscount: 50, batchNo: 'PC-1' }],
  })
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: pcPoId, cancellationReason: '供应商短供' })
  const pcClosedProgress = (await docs.getInventoryCoreDocById(pcPoId))?.fulfillmentProgress?.items?.[0]
  check('#346 部分入库后关单：入库后实际金额只算已入库 1 × 750（口径 A），未入库 3 件不计',
    pcClosedProgress?.actualAmount === 750 && pcClosedProgress?.outstandingQuantity === 0,
    JSON.stringify(pcClosedProgress))
  const pcMbhAfterClose = (await docs.getInventoryCoreDocById(pcMbhId))?.fulfillmentProgress?.items?.[0]
  check('部分入库后关单：汇总行保留已入库 1，原始报货「已采购」保留 1(#335)',
    (await docHeader(pcPoId))?.status === '已取消'
      && num((await docItems(pcMhzId))[0]?.fulfilled_quantity) === 1
      && pcMbhAfterClose?.orderedQuantity === 1,
    `mhz=${(await docItems(pcMhzId))[0]?.fulfilled_quantity} mbh=${JSON.stringify(pcMbhAfterClose)}`)
  await expectThrow('关单后汇总行只能再下未入库的 3 件(CONFLICT)', /CONFLICT/, () =>
    biz.createPurchaseOrder({ supplyChainLocationId: HQ_ORG, items: [{ sourceItemId: pcMhzItem.id, quantity: 4 }] }))
  const { id: pcPo2Id } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: pcMhzItem.id, quantity: 3 }],
  })
  const pcReportLinks = await pgQuery(
    `SELECT quantity FROM inventory_doc_links
      WHERE to_doc_id = $1 AND relation_type = '市场报货采购订单'`, [pcPo2Id])
  const pcMbhAfterReorder = (await docs.getInventoryCoreDocById(pcMbhId))?.fulfillmentProgress?.items?.[0]
  check('再次下单剩余 3 件：原始报货分摊 3，「已采购」合计 4 不超过报货量(#335)',
    pcReportLinks.length === 1 && num(pcReportLinks[0].quantity) === 3
      && pcMbhAfterReorder?.orderedQuantity === 4,
    `links=${JSON.stringify(pcReportLinks)} mbh=${JSON.stringify(pcMbhAfterReorder)}`)
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: pcPo2Id, cancellationReason: '清理' })

  // ════ 阶段 9c：三来源合并的市场行部分入库后关单，保留量按分分配（#335 评审 P2）════
  // 三张市场报货各 1 件 → 汇总 3 → 采购 3 → 入库 1 → 关单 → 重下 2：
  // 原始报货的保留量必须是 0.34/0.33/0.33 这样的整分，重下 2 件的血缘合计严格 2.00，
  // 且每张报货累计「已采购」不超过 1。
  const trioReportItems = []
  for (let index = 0; index < 3; index += 1) {
    setSession(storeA1Session())
    const { id: trioStoreId } = await biz.createStoreReplenishmentRequest({
      storeId: STA1_ID, marketId: MKA_ORG,
      items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
    })
    const [trioStoreItem] = await docItems(trioStoreId)
    setSession(marketASession())
    const { id: trioMbhId } = await biz.createMarketReplenishment({
      marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
      items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [trioStoreItem.id], purchaseQuantity: 1 }],
    })
    const [trioMbhItem] = await docItems(trioMbhId)
    trioReportItems.push({ docId: trioMbhId, itemId: trioMbhItem.id })
  }
  setSession(supplyChainSession())
  const { id: trioMhzId } = await biz.createMarketReportSummary({
    supplyChainLocationId: HQ_ORG,
    items: [{
      skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 3,
      sourceReportItemIds: trioReportItems.map((item) => item.itemId),
    }],
  })
  const [trioMhzItem] = await docItems(trioMhzId)
  const { id: trioPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: trioMhzItem.id, quantity: 3 }],
  })
  const [trioPoItem] = await docItems(trioPoId)
  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: trioPoId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: trioPoItem.id, quantity: 1, batchNo: 'TRIO-1' }],
  })
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: trioPoId, cancellationReason: '供应商短供' })
  const trioRetained = []
  for (const item of trioReportItems) {
    trioRetained.push((await docs.getInventoryCoreDocById(item.docId))?.fulfillmentProgress?.items?.[0]?.orderedQuantity)
  }
  check('三来源部分入库关单：原始报货保留量按分分配、合计=已入库 1(#335)',
    trioRetained.every((value) => Math.round(value * 100) === value * 100)
      && Math.abs(trioRetained.reduce((sum, value) => sum + value, 0) - 1) < 0.001,
    JSON.stringify(trioRetained))
  const { id: trioPo2Id } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: trioMhzItem.id, quantity: 2 }],
  })
  const trioLinks = await pgQuery(
    `SELECT from_item_id, quantity FROM inventory_doc_links
      WHERE to_doc_id = $1 AND relation_type = '市场报货采购订单' ORDER BY from_item_id`, [trioPo2Id])
  const trioOrdered = []
  for (const item of trioReportItems) {
    trioOrdered.push((await docs.getInventoryCoreDocById(item.docId))?.fulfillmentProgress?.items?.[0]?.orderedQuantity)
  }
  check('三来源重下 2 件：血缘合计严格 2.00，每张报货累计已采购 = 1(#335)',
    Math.round(trioLinks.reduce((sum, link) => sum + num(link.quantity), 0) * 100) === 200
      && trioOrdered.every((value) => Math.abs(value - 1) < 0.001),
    JSON.stringify({ links: trioLinks, ordered: trioOrdered }))
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: trioPo2Id, cancellationReason: '清理' })

  // ════ 阶段 9d：同一原始报货行分两张汇总单、再并进同一采购行（#335 评审 codex round-2 P2）════
  // 同一对 (原始行, 采购行) 有两条血缘；部分入库关单后保留量只能算一次。
  setSession(storeA1Session())
  const { id: dupPairStoreId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 2 }],
  })
  const [dupPairStoreItem] = await docItems(dupPairStoreId)
  setSession(marketASession())
  const { id: dupPairMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [dupPairStoreItem.id], purchaseQuantity: 2 }],
  })
  const [dupPairMbhItem] = await docItems(dupPairMbhId)
  setSession(supplyChainSession())
  const dupPairSummaryItems = []
  for (let index = 0; index < 2; index += 1) {
    const { id: dupPairMhzId } = await biz.createMarketReportSummary({
      supplyChainLocationId: HQ_ORG,
      items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 1, sourceReportItemIds: [dupPairMbhItem.id] }],
    })
    dupPairSummaryItems.push((await docItems(dupPairMhzId))[0])
  }
  const { id: dupPairPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: dupPairSummaryItems.map((item) => ({ sourceItemId: item.id, quantity: 1 })),
  })
  const dupPairPoItems = await docItems(dupPairPoId)
  const dupPairLinks = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM inventory_doc_links
      WHERE to_doc_id = $1 AND relation_type = '市场报货采购订单' AND from_item_id = $2`, [dupPairPoId, dupPairMbhItem.id])
  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: dupPairPoId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: dupPairPoItems[0].id, quantity: 1, batchNo: 'DUPPAIR-1' }],
  })
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: dupPairPoId, cancellationReason: '供应商短供' })
  const dupPairOrdered = (await docs.getInventoryCoreDocById(dupPairMbhId))?.fulfillmentProgress?.items?.[0]?.orderedQuantity
  check('同一对(原始行,采购行)两条血缘：部分入库关单后「已采购」只算一次 = 1(#335)',
    dupPairPoItems.length === 1 && dupPairLinks[0]?.n === 2 && dupPairOrdered === 1,
    JSON.stringify({ lines: dupPairPoItems.length, links: dupPairLinks[0]?.n, ordered: dupPairOrdered }))
  const { id: dupPairPo2Id } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: dupPairSummaryItems.map((item) => ({ sourceItemId: item.id, quantity: 0.5 })),
  })
  const dupPairOrderedAfter = (await docs.getInventoryCoreDocById(dupPairMbhId))?.fulfillmentProgress?.items?.[0]?.orderedQuantity
  check('重下剩余 1 件后原始报货「已采购」= 2，不超过报货量(#335)', dupPairOrderedAfter === 2, `${dupPairOrderedAfter}`)
  await biz.cancelSupplyChainPurchaseOrder({ purchaseOrderId: dupPairPo2Id, cancellationReason: '清理' })

  // ════ 阶段 10：跨来源单合并到同一采购行，履约进度不得重复计数 ════
  // 两张品项公司报货需求的同一 SKU 会被合并成**一条**采购明细。
  // 下游入库量必须按各来源的血缘占比分摊回去；若按采购行全量归属，
  // 两张需求单会各自显示全量，合计凭空翻倍。
  const { id: dupReqAId } = await biz.createItemCompanyReplenishment({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 5 }],
  })
  const { id: dupReqBId } = await biz.createItemCompanyReplenishment({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 5 }],
  })
  const [dupItemA] = await docItems(dupReqAId)
  const [dupItemB] = await docItems(dupReqBId)
  const { id: dupPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [
      { sourceItemId: dupItemA.id, quantity: 5 },
      { sourceItemId: dupItemB.id, quantity: 5 },
    ],
  })
  const dupPoItems = await docItems(dupPoId)
  check('两张需求单的同一 SKU 合并成一条采购明细',
    dupPoItems.length === 1 && num(dupPoItems[0]?.quantity) === 10,
    `rows=${dupPoItems.length} qty=${dupPoItems[0]?.quantity}`)

  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: dupPoId,
    supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: dupPoItems[0].id, quantity: 6, batchNo: 'BDUP', expiryDate: '2027-12-31' }],
  })
  const dupProgressA = (await docs.getInventoryCoreDocById(dupReqAId))?.fulfillmentProgress?.items?.[0]
  const dupProgressB = (await docs.getInventoryCoreDocById(dupReqBId))?.fulfillmentProgress?.items?.[0]
  const dupReceivedTotal = (dupProgressA?.receivedQuantity ?? 0) + (dupProgressB?.receivedQuantity ?? 0)
  check('跨来源单合并后入库进度按占比分摊，两单合计等于实收 6（不是 12）',
    Math.abs(dupReceivedTotal - 6) < 0.01,
    `A=${dupProgressA?.receivedQuantity} B=${dupProgressB?.receivedQuantity} 合计=${dupReceivedTotal}`)

  // 多来源 + 部分收货 + 关闭：落库精度守恒与"已下单量"口径
  await biz.cancelSupplyChainPurchaseOrder({
    purchaseOrderId: dupPoId, cancellationReason: '供应商短供',
  })
  const dupAfterA = (await docItems(dupReqAId))[0]
  const dupAfterB = (await docItems(dupReqBId))[0]
  check('部分收货关闭后，两来源保留量之和严格等于实收 6（两位小数守恒）',
    Math.abs(num(dupAfterA?.fulfilled_quantity) + num(dupAfterB?.fulfilled_quantity) - 6) < 0.001,
    `A=${dupAfterA?.fulfilled_quantity} B=${dupAfterB?.fulfilled_quantity}`)
  check('保留量按占比而非顺序分配（各 3，不是 5/1）',
    num(dupAfterA?.fulfilled_quantity) === 3 && num(dupAfterB?.fulfilled_quantity) === 3,
    `A=${dupAfterA?.fulfilled_quantity} B=${dupAfterB?.fulfilled_quantity}`)
  const dupOrderedA = (await docs.getInventoryCoreDocById(dupReqAId))?.fulfillmentProgress?.items?.[0]
  check('已取消采购单的「已下单量」也按占比算（3 而不是 5）',
    Math.abs((dupOrderedA?.orderedQuantity ?? 0) - 3) < 0.01,
    `ordered=${dupOrderedA?.orderedQuantity}`)
  check('关闭后来源 A 可再下单 2 件（5 − 保留 3）',
    (await biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: dupItemA.id, quantity: 2 }],
    })).id.length > 0, '')
  await expectThrow('再多下 1 件即超出未下单数量(CONFLICT)', /CONFLICT/, () =>
    biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: dupItemA.id, quantity: 1 }],
    }))

  check('回退后该汇总行可以重新下单',
    (await biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: mixMhzItem.id, quantity: 2 }],
    })).id.length > 0, '')

  // ════ #345 赠送批次按正常数量配出：属性翻转也要换批号，门店不能出现同批号不同赠送属性的两条批次 ════
  setSession(marketASession())
  const giftLotBefore = (await locationLots(MKA_ORG, SKU_SUPPLY)).find((lot) => lot.is_gift)
  const { id: fphFlipId } = await biz.createStoreAllocation({
    storeRequestId: dbhId,
    sourceMarketId: MKA_ORG,
    items: [{ requestItemId: dbhItem.id, lotId: giftLotBefore.id, quantity: 1, giftQuantity: 1 }],
  })
  const fphFlipItems = await docItems(fphFlipId)
  const fphFlipNormal = fphFlipItems.find((item) => !item.is_gift)
  const fphFlipGift = fphFlipItems.find((item) => item.is_gift)
  check('赠送批次按正常数量配出：正常行按「配货单号-行号」换批号，赠送行沿用赠送批号(#345)',
    fphFlipNormal?.batch_no === expectedLineBatchNo(fphFlipId, fphFlipItems, fphFlipNormal) && fphFlipGift?.batch_no === giftLotBefore.batch_no,
    JSON.stringify({ normal: fphFlipNormal?.batch_no, gift: fphFlipGift?.batch_no, source: giftLotBefore?.batch_no }))
  setSession(storeA1Session())
  await biz.receiveStoreAllocation({
    shipmentId: fphFlipId,
    items: [
      { shipmentItemId: fphFlipNormal.id, receivedQuantity: 1 },
      { shipmentItemId: fphFlipGift.id, receivedQuantity: 1 },
    ],
  })
  const storeLotsAfterFlip = await locationLots(STA1_ID, SKU_SUPPLY)
  const giftFlagsByBatch = new Map()
  for (const lot of storeLotsAfterFlip) {
    giftFlagsByBatch.set(lot.batch_no, new Set([...(giftFlagsByBatch.get(lot.batch_no) ?? []), lot.is_gift]))
  }
  check('门店批次：同一批号不会同时出现赠送与正常两种属性(#345)',
    storeLotsAfterFlip.length >= 4 && [...giftFlagsByBatch.values()].every((flags) => flags.size === 1),
    JSON.stringify(storeLotsAfterFlip.map((lot) => [lot.batch_no, lot.is_gift])))

  // ════ 阶段 11：总部现货直接发货（#336）════
  // 报货 30、批号 A 只有 10：第一张发 10 → 仍待发 20 → 第二张从批号 B 发 20 → 报货单退出待发货。
  // 全程不建采购订单；市场批次价格取报货行快照、成本取所发总部批次。
  setSession(supplyChainSession())
  const directReq = await biz.createItemCompanyReplenishment({
    supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 30 }],
  })
  const [directReqItem] = await docItems(directReq.id)
  const { id: directPoId } = await biz.createPurchaseOrder({
    supplyChainLocationId: HQ_ORG,
    items: [{ sourceItemId: directReqItem.id, quantity: 30 }],
  })
  const [directPoItem] = await docItems(directPoId)
  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: directPoId, supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: directPoItem.id, quantity: 10, batchNo: 'LOT-A' }],
  })
  await biz.receiveSupplyChainPurchaseOrder({
    purchaseOrderId: directPoId, supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: directPoItem.id, quantity: 20, batchNo: 'LOT-B' }],
  })
  const hqLotsNow = await locationLots(HQ_ORG, SKU_SUPPLY)
  const lotA = hqLotsNow.find((lot) => lot.batch_no === 'LOT-A')
  const lotB = hqLotsNow.find((lot) => lot.batch_no === 'LOT-B')
  // 让两批总部成本与报货行档案价（800）不同，才验得出「成本取所发批次」而不是取报货快照
  await pgQuery('UPDATE inventory_stock_lots SET supply_chain_unit_cost = 777 WHERE id = $1', [lotA.id])
  await pgQuery('UPDATE inventory_stock_lots SET supply_chain_unit_cost = 666 WHERE id = $1', [lotB.id])

  setSession(storeA1Session())
  const { id: directDbhId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 30 }],
  })
  const [directDbhItem] = await docItems(directDbhId)
  setSession(marketASession())
  const { id: directMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [directDbhItem.id], purchaseQuantity: 30 }],
  })
  const [directMbhItem] = await docItems(directMbhId)

  setSession(supplyChainSession())
  const engine = await import(A('src', 'lib', 'inventory', 'engine.ts'))
  // 按单号检索：结果集只剩目标单，「看不到 / 已退出」的断言不会因为翻页截断而恒真
  const pendingIds = async () => (await engine.listInventoryCoreDocs({
    docTypes: ['市场报货'], pendingItemScope: 'company-shipment', keyword: directMbhId,
  })).data.map((row) => row.id)
  const candidateFor = async (marketId) => (await docs.listInventoryDocCandidates({
    purpose: 'company-shipment-source', sourceOrgNodeId: marketId, keyword: directMbhId,
  })).data.find((row) => row.id === directMbhId)
  check('按单号检索的候选能命中目标单（后面「看不到」断言的前提）',
    (await docs.listInventoryDocCandidates({ purpose: 'company-shipment-source', keyword: directMbhId }))
      .data.some((row) => row.id === directMbhId), '')
  check('报货单未进任何采购单即出现在待发货与发货候选(#336)',
    (await pendingIds()).includes(directMbhId) && (await candidateFor(MKA_ORG))?.progress?.done === 0,
    JSON.stringify((await candidateFor(MKA_ORG))?.progress ?? null))
  check('发货候选按收货市场收窄：市场B 看不到市场A 的报货单(#336)',
    (await candidateFor(MKB_ORG)) === undefined, '')

  const { id: directGfh1 } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: directMbhItem.id, lotId: lotA.id, quantity: 10 }],
  })
  const afterFirst = await candidateFor(MKA_ORG)
  check('第一张发 10 后仍待发 20（还有 20 件未发）(#336)',
    afterFirst?.progress?.done === 10 && afterFirst?.progress?.total === 30
      && (await pendingIds()).includes(directMbhId),
    JSON.stringify(afterFirst?.progress ?? null))
  await expectThrow('再发 21 超过未发 20 被拒并写明上限(#336)', /CONFLICT.*最多可发 20/, () =>
    biz.createItemCompanyShipment({
      marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
      items: [{ reportItemId: directMbhItem.id, lotId: lotB.id, quantity: 21 }],
    }))
  const { id: directGfh2 } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: directMbhItem.id, lotId: lotB.id, quantity: 20 }],
  })
  check('发满后报货单退出待发货段与默认候选(#336)',
    !(await pendingIds()).includes(directMbhId) && (await candidateFor(MKA_ORG)) === undefined, '')

  // 市场账号：发货单详情能看到并跳到原始报货单
  setSession(marketASession())
  const gfh1AsMarket = await docs.getInventoryCoreDocById(directGfh1)
  check('市场账号在发货单上看到原始报货单号(#336)',
    gfh1AsMarket?.lineage?.some((row) => row.docId === directMbhId && row.relationType === '市场报货发货' && row.direction === '上游'),
    JSON.stringify(gfh1AsMarket?.lineage ?? null))

  // 两条收货路径各验一次：逐行「去收货」与一键收货
  const gfh1Items = await docItems(directGfh1)
  const { id: directMrk1 } = await biz.receiveItemCompanyShipment({
    shipmentId: directGfh1,
    items: gfh1Items.map((item) => ({ shipmentItemId: item.id, receivedQuantity: num(item.quantity) })),
  })
  const { id: directMrk2 } = await biz.receiveItemCompanyShipmentInFull({ shipmentId: directGfh2 })
  for (const [label, inboundId] of [['去收货', directMrk1], ['一键收货', directMrk2]]) {
    const inbound = await docs.getInventoryCoreDocById(inboundId)
    check(`市场采购入库（${label}）详情带出原始报货单(#336)`,
      inbound?.lineage?.some((row) => row.docId === directMbhId && row.relationType === '原始报货单（经品项公司发货）'),
      JSON.stringify(inbound?.lineage?.map((row) => [row.relationType, row.docId]) ?? null))
  }
  const directMarketLots = (await locationLots(MKA_ORG, SKU_SUPPLY))
    .filter((lot) => lot.batch_no === 'LOT-A' || lot.batch_no === 'LOT-B')
  const marketLotA = directMarketLots.find((lot) => lot.batch_no === 'LOT-A')
  const marketLotB = directMarketLots.find((lot) => lot.batch_no === 'LOT-B')
  check('不经采购单的市场批次：市场实际单价 = 报货行快照，供应链成本 = 所发总部批次成本(#336 SQL)',
    num(marketLotA?.market_actual_unit_price) === num(directMbhItem.market_actual_unit_price)
      && num(marketLotB?.market_actual_unit_price) === num(directMbhItem.market_actual_unit_price)
      && num(marketLotA?.supply_chain_unit_cost) === 777 && num(marketLotB?.supply_chain_unit_cost) === 666,
    JSON.stringify(directMarketLots.map((lot) => [lot.batch_no, lot.market_actual_unit_price, lot.supply_chain_unit_cost])))

  const directProgress = (await docs.getInventoryCoreDocById(directMbhId))?.fulfillmentProgress?.items?.[0]
  const [directShippedSql] = await pgQuery(
    `SELECT COALESCE(SUM(l.quantity), 0) AS shipped FROM inventory_doc_links l
       JOIN inventory_docs d ON d.id = l.to_doc_id
      WHERE l.from_item_id = $1 AND l.relation_type = '市场报货发货' AND d.status <> '已取消'`, [directMbhItem.id])
  check('报货单已发 / 已收按直连血缘累计，整数不出小数，且 = SQL 直连发货量之和(#336)',
    directProgress?.normalFulfilledQuantity === 30 && directProgress?.normalReceivedQuantity === 30
      && num(directShippedSql?.shipped) === directProgress?.normalFulfilledQuantity
      && directProgress?.orderedQuantity === 0,
    JSON.stringify({ progress: directProgress, sql: directShippedSql?.shipped }))

  // ════ 阶段 12：赠送不对等（#336）════
  // 「报 1 送 2」、多次发货累计赠送超过报货量都能保存（此前被 0043 链接守卫 RAISE）。
  setSession(storeA1Session())
  const { id: giftDbhId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
  })
  const [giftDbhItem] = await docItems(giftDbhId)
  setSession(marketASession())
  const { id: giftMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [giftDbhItem.id], purchaseQuantity: 1 }],
  })
  const [giftMbhItem] = await docItems(giftMbhId)
  setSession(supplyChainSession())
  const { id: giftGfh1 } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: giftMbhItem.id, lotId: hqLot.id, quantity: 1 }],
    giftItems: [{ reportItemId: giftMbhItem.id, lotId: hqLot.id, quantity: 2 }],
  })
  // 赠送行单独选批次：与正常行来自不同总部批次（LOT-A / LOT-B 已在阶段 11 发完，挑另一个有货的批次）
  const altLot = (await locationLots(HQ_ORG, SKU_SUPPLY))
    .find((lot) => Number(lot.id) !== Number(hqLot.id) && num(lot.quantity_on_hand) >= 3)
  const { id: giftGfh2 } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [],
    giftItems: [{ reportItemId: giftMbhItem.id, lotId: altLot.id, quantity: 3 }],
  })
  const giftProgress = (await docs.getInventoryCoreDocById(giftMbhId))?.fulfillmentProgress?.items?.[0]
  check('报 1 送 2、再单独补送 3：累计赠送 5 > 报货 1 仍能保存(#336)',
    giftProgress?.normalFulfilledQuantity === 1 && giftProgress?.giftFulfilledQuantity === 5,
    JSON.stringify(giftProgress ?? null))
  const giftGfh2Items = await docItems(giftGfh2)
  check('单独补送的赠送行：独立批号、来源为另一总部批次(#336/#345)',
    giftGfh2Items.length === 1 && giftGfh2Items[0].is_gift
      && Number(giftGfh2Items[0].lot_id) === Number(altLot.id)
      && giftGfh2Items[0].batch_no === expectedLineBatchNo(giftGfh2, giftGfh2Items, giftGfh2Items[0]),
    JSON.stringify(giftGfh2Items.map((item) => [item.lot_id, item.batch_no, item.is_gift])))
  await expectThrow('正常行与赠送行都为空时被拒', /INVALID_PARAMS/, () =>
    biz.createItemCompanyShipment({ marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG, items: [], giftItems: [] }))
  void giftGfh1

  // 门店报货赠送配货同样不再被封顶在门店报货行数量（拍板 A）
  setSession(marketASession())
  const giftMarketLot = (await locationLots(MKA_ORG, SKU_SUPPLY)).find((lot) => lot.batch_no === 'LOT-B')
  const { id: giftFphId } = await biz.createStoreAllocation({
    storeRequestId: giftDbhId,
    sourceMarketId: MKA_ORG,
    items: [{ requestItemId: giftDbhItem.id, lotId: giftMarketLot.id, quantity: 1, giftQuantity: 3 }],
  })
  const giftFphLinks = await pgQuery(
    `SELECT relation_type, quantity FROM inventory_doc_links WHERE to_doc_id = $1 ORDER BY relation_type`, [giftFphId])
  check('门店报货 1、配货正常 1 + 赠送 3 能保存（DB 守卫不再对赠送配货累计封顶）(#336)',
    giftFphLinks.some((link) => link.relation_type === '门店报货赠送配货' && num(link.quantity) === 3),
    JSON.stringify(giftFphLinks))
  // ════ 阶段 13：批次合并时入库明细仍记本次报货快照（#336 评审 codex round-1 P1）════
  // 市场批次身份只含实际价：标准价 / 优惠不同、实际价相同的报货，从同一总部批次发出后会并进同一市场批次。
  // 批次上留第一次的快照没关系，但这次入库明细的 market_* 三列必须是这张报货行的快照。
  setSession(storeA1Session())
  const { id: snapDbhId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
  })
  const [snapDbhItem] = await docItems(snapDbhId)
  setSession(marketASession())
  const { id: snapMbhId } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, sourceRequestItemIds: [snapDbhItem.id], purchaseQuantity: 1 }],
  })
  const [snapMbhItem] = await docItems(snapMbhId)
  await pgQuery(
    `UPDATE inventory_doc_items
        SET market_standard_unit_price = 1100, market_unit_discount = 150, market_actual_unit_price = 950,
            store_standard_unit_price = 1300, store_unit_discount = 100, store_actual_unit_price = 1200
      WHERE id = $1`, [snapMbhItem.id])
  setSession(supplyChainSession())
  const { id: snapGfhId } = await biz.createItemCompanyShipment({
    marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: snapMbhItem.id, lotId: hqLot.id, quantity: 1 }],
  })
  setSession(marketASession())
  const { id: snapMrkId } = await biz.receiveItemCompanyShipmentInFull({ shipmentId: snapGfhId })
  // docItems() 不带 market_standard / market_discount 两列，这里直接查
  const [snapMrkItem] = await pgQuery(
    `SELECT lot_id, standard_unit_price, unit_discount,
            market_standard_unit_price, market_unit_discount, market_actual_unit_price,
            store_standard_unit_price, store_unit_discount, store_actual_unit_price
       FROM inventory_doc_items WHERE doc_id = $1`, [snapMrkId])
  const snapMarketLot = (await locationLots(MKA_ORG, SKU_SUPPLY)).find((lot) => Number(lot.id) === Number(snapMrkItem?.lot_id))
  check('标准价 / 优惠不同、实际价相同：并进已有市场批次，入库明细仍记本次报货快照（市场 1100/150/950、门店 1300/100/1200）',
    num(snapMarketLot?.market_standard_unit_price) === 1000
      && num(snapMarketLot?.store_standard_unit_price) === 1200
      && num(snapMrkItem?.store_standard_unit_price) === 1300 && num(snapMrkItem?.store_unit_discount) === 100
      && num(snapMrkItem?.store_actual_unit_price) === 1200
      && num(snapMrkItem?.market_standard_unit_price) === 1100 && num(snapMrkItem?.market_unit_discount) === 150
      && num(snapMrkItem?.market_actual_unit_price) === 950
      && num(snapMrkItem?.standard_unit_price) === 1100 && num(snapMrkItem?.unit_discount) === 150,
    JSON.stringify({
      lot: [snapMarketLot?.market_standard_unit_price, snapMarketLot?.market_unit_discount],
      item: [snapMrkItem?.market_standard_unit_price, snapMrkItem?.market_unit_discount, snapMrkItem?.market_actual_unit_price],
      store: [snapMarketLot?.store_standard_unit_price, snapMrkItem?.store_standard_unit_price, snapMrkItem?.store_unit_discount, snapMrkItem?.store_actual_unit_price],
    }))

  // ════ #337 分院配货不引用门店报货（市场直接配货）：纯自选 / 混合 ════
  // 门店A1 另提一张未配报货（供应链品 3 件），用来断言自选配货不动报货进度与汇总待配量
  setSession(storeA1Session())
  const { id: dbh337Id } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG,
    items: [{ skuId: SKU_SUPPLY, quantity: 3 }],
  })
  const [dbh337Item] = await docItems(dbh337Id)
  setSession(marketASession())
  const selfLotId = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SELF, skuName: `${SKU_SELF}_名`, quantity: 10, batchNo: 'SELF-337',
    marketStandardUnitPrice: 30, marketUnitDiscount: 0, marketActualUnitPrice: 30,
  })
  const supplyLotId = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SUPPLY, skuName: `${SKU_SUPPLY}_名`, quantity: 10, batchNo: 'SC-337',
    supplyChainUnitCost: 800, marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
  })
  const settlementStoreRow = async () => {
    const settlements = await import(A('src', 'actions', 'inventory', 'settlements.ts'))
    const report = await settlements.listInventorySettlements({})
    return report.storeRows.find((row) => row.sourceOrgNodeId === MKA_ORG && row.targetOrgNodeId === STA1_ORG)
      ?? { docCount: 0, payableAmount: 0 }
  }
  const pendingOf = async () => (await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG }))
    .items.find((line) => line.skuId === SKU_SUPPLY)?.outstandingQuantity ?? 0
  const requestLinkCount = async () => Number((await pgQuery(
    `SELECT count(*)::int AS n FROM inventory_doc_links WHERE from_doc_id = $1`, [dbh337Id],
  ))[0].n)
  const requestReservationCount = async () => Number((await pgQuery(
    `SELECT count(*)::int AS n FROM inventory_stock_reservations WHERE request_doc_id = $1`, [dbh337Id],
  ))[0].n)
  const pendingBefore = await pendingOf()
  const settlementBefore = await settlementStoreRow()
  const hints = await docs.listStoreUnallocatedRequestSkus({ storeOrgNodeId: STA1_ORG, marketId: MKA_ORG })
  const supplyHint = hints.find((hint) => hint.skuId === SKU_SUPPLY)
  check('#337 未配提示：门店A1 对供应链品仍有未配报货（含新报货单）',
    Boolean(supplyHint?.docIds.includes(dbh337Id)) && (supplyHint?.remainingQuantity ?? 0) >= 3,
    JSON.stringify(supplyHint ?? null))

  // 纯自选：不选报货单，含一个该门店有未配报货的 SKU（拍板 A：提示不拦截）
  const { id: fphSelfId } = await biz.createStoreAllocation({
    targetStoreId: STA1_ORG,
    sourceMarketId: MKA_ORG,
    items: [
      { skuId: SKU_SELF, lotId: selfLotId, quantity: 4, giftQuantity: 1, storeUnitDiscount: 5 },
      { skuId: SKU_SUPPLY, lotId: supplyLotId, quantity: 2 },
    ],
  })
  const fphSelfHead = await docHeader(fphSelfId)
  const fphSelfItems = await docItems(fphSelfId)
  const selfNormal = fphSelfItems.find((item) => item.sku_id === SKU_SELF && !item.is_gift)
  check('#337 纯自选建单：待收货、收货门店=门店A1、金额 (40-5)×4 + 1200×2 = 2540',
    fphSelfHead?.status === '待收货' && fphSelfHead?.target_org_node_id === STA1_ORG
      && num(selfNormal?.actual_unit_price) === 35 && num(fphSelfHead?.total_amount) === 2540
      && fphSelfItems.length === 3 && fphSelfItems.every((item) => item.request_quantity === null),
    JSON.stringify({ status: fphSelfHead?.status, target: fphSelfHead?.target_org_node_id, total: fphSelfHead?.total_amount, n: fphSelfItems.length }))
  const selfLinks = await pgQuery(
    `SELECT count(*)::int AS n FROM inventory_doc_links WHERE to_doc_id = $1`, [fphSelfId],
  )
  check('#337 纯自选：配货单没有任何入向血缘', Number(selfLinks[0].n) === 0, `links=${selfLinks[0].n}`)
  check('#337 纯自选：批次流水正确（自选品 10→5、供应链品 10→8）',
    (await lotQuantity(selfLotId)) === 5 && (await lotQuantity(supplyLotId)) === 8,
    `${await lotQuantity(selfLotId)} / ${await lotQuantity(supplyLotId)}`)
  const dbh337AfterSelf = (await docItems(dbh337Id))[0]
  check('#337 SQL 断言：自选配货后门店报货 fulfilled_quantity / 血缘 / 预留 / 汇总待配量均不变',
    num(dbh337AfterSelf?.fulfilled_quantity) === 0 && (await requestLinkCount()) === 0
      && (await requestReservationCount()) === 0 && (await pendingOf()) === pendingBefore,
    JSON.stringify({ fulfilled: dbh337AfterSelf?.fulfilled_quantity, pendingBefore, pendingAfter: await pendingOf() }))
  const settlementAfterSelf = await settlementStoreRow()
  check('#337 分院货款结算统计到自选配货单（待收货即计）',
    settlementAfterSelf.docCount === settlementBefore.docCount + 1
      && Math.abs(settlementAfterSelf.payableAmount - settlementBefore.payableAmount - 2540) < 0.001,
    JSON.stringify({ before: settlementBefore, after: settlementAfterSelf }))

  setSession(storeA1Session())
  const storeSelfBefore = (await locationLots(STA1_ID, SKU_SELF)).reduce((sum, lot) => sum + Number(lot.quantity_on_hand), 0)
  const { id: yrkSelfId } = await biz.receiveStoreAllocationInFull({ shipmentId: fphSelfId })
  const storeSelfAfter = (await locationLots(STA1_ID, SKU_SELF)).reduce((sum, lot) => sum + Number(lot.quantity_on_hand), 0)
  check('#337 纯自选 → 门店收货：配货单完结，门店自选品 +5（含赠送 1），院入库金额 2540',
    (await docHeader(fphSelfId))?.status === '已完成' && storeSelfAfter - storeSelfBefore === 5
      && num((await docHeader(yrkSelfId))?.total_amount) === 2540,
    JSON.stringify({ storeSelfBefore, storeSelfAfter }))

  // 同一批次跨两条自选行（第二行带赠送）：真 0009 触发器下流水 before/after 必须首尾相接
  setSession(marketASession())
  const selfLotBeforeSame = await lotQuantity(selfLotId)
  const { id: fphSameLotId } = await biz.createStoreAllocation({
    targetStoreId: STA1_ORG,
    sourceMarketId: MKA_ORG,
    items: [
      { skuId: SKU_SELF, lotId: selfLotId, quantity: 1 },
      { skuId: SKU_SELF, lotId: selfLotId, quantity: 1, giftQuantity: 1 },
    ],
  })
  const sameLotMovements = await pgQuery(
    `SELECT quantity_before, quantity_after FROM inventory_movements WHERE doc_id = $1 ORDER BY id`, [fphSameLotId],
  )
  const chain = sameLotMovements.map((row) => [num(row.quantity_before), num(row.quantity_after)])
  check('#337 同批次两条自选行：共享快照，流水 before/after 首尾相接、批次扣 3',
    JSON.stringify(chain) === JSON.stringify([
      [selfLotBeforeSame, selfLotBeforeSame - 1],
      [selfLotBeforeSame - 1, selfLotBeforeSame - 2],
      [selfLotBeforeSame - 2, selfLotBeforeSame - 3],
    ]) && (await lotQuantity(selfLotId)) === selfLotBeforeSame - 3,
    JSON.stringify(chain))
  await expectThrow('#337 同批次跨行累计超出可用量被拒', /库存不足/, () =>
    biz.createStoreAllocation({
      targetStoreId: STA1_ORG,
      sourceMarketId: MKA_ORG,
      items: [
        { skuId: SKU_SELF, lotId: selfLotId, quantity: selfLotBeforeSame - 3 },
        { skuId: SKU_SELF, lotId: selfLotId, quantity: 1 },
      ],
    }))
  // 把余下的自选品留给混合段：刚才的累计超量单整笔回滚，批次数量不变
  check('#337 累计超量被拒后批次数量不变', (await lotQuantity(selfLotId)) === selfLotBeforeSame - 3, '')

  // 混合：引用 dbh337 配 2 件 + 追加自选品 1 件
  setSession(marketASession())
  await expectThrow('#337 引用单里已有的 SKU 不能再以自选行追加', /已在引用的门店报货单中/, () =>
    biz.createStoreAllocation({
      storeRequestId: dbh337Id, targetStoreId: STA1_ORG, sourceMarketId: MKA_ORG,
      items: [
        { requestItemId: dbh337Item.id, lotId: supplyLotId, quantity: 1 },
        { skuId: SKU_SUPPLY, lotId: supplyLotId, quantity: 1 },
      ],
    }))
  await expectThrow('#337 收货门店与报货主体不一致被拒', /收货门店与门店报货单的报货门店不一致/, () =>
    biz.createStoreAllocation({
      storeRequestId: dbh337Id, targetStoreId: STA2_ORG, sourceMarketId: MKA_ORG,
      items: [{ requestItemId: dbh337Item.id, lotId: supplyLotId, quantity: 1 }],
    }))
  const { id: fphMixId } = await biz.createStoreAllocation({
    storeRequestId: dbh337Id,
    targetStoreId: STA1_ORG,
    sourceMarketId: MKA_ORG,
    items: [
      { requestItemId: dbh337Item.id, lotId: supplyLotId, quantity: 2 },
      { skuId: SKU_SELF, lotId: selfLotId, quantity: 1 },
    ],
  })
  const fphMixItems = await docItems(fphMixId)
  const mixRef = fphMixItems.find((item) => item.sku_id === SKU_SUPPLY)
  const mixSelf = fphMixItems.find((item) => item.sku_id === SKU_SELF)
  const mixLinks = await pgQuery(
    `SELECT to_item_id, relation_type, quantity FROM inventory_doc_links WHERE to_doc_id = $1`, [fphMixId],
  )
  check('#337 混合：只有引用行写「门店报货配货」血缘，自选行没有',
    mixLinks.length === 1 && Number(mixLinks[0].to_item_id) === Number(mixRef?.id)
      && mixLinks[0].relation_type === '门店报货配货' && num(mixLinks[0].quantity) === 2
      && !mixLinks.some((link) => Number(link.to_item_id) === Number(mixSelf?.id)),
    JSON.stringify(mixLinks))
  const dbh337AfterMix = (await docItems(dbh337Id))[0]
  check('#337 混合：报货明细 fulfilled_quantity 只加引用行的 2，预留 1 条，汇总待配量减 2',
    num(dbh337AfterMix?.fulfilled_quantity) === 2 && (await requestReservationCount()) === 1
      && (await pendingOf()) === pendingBefore - 2,
    JSON.stringify({ fulfilled: dbh337AfterMix?.fulfilled_quantity, pending: await pendingOf(), pendingBefore }))
  setSession(storeA1Session())
  await biz.receiveStoreAllocationInFull({ shipmentId: fphMixId })
  const dbh337Progress = (await docs.getInventoryCoreDocById(dbh337Id))?.fulfillmentProgress?.items?.[0]
  check('#337 混合 → 门店收货：配货单完结，报货进度只计引用行（配 2 收 2）',
    (await docHeader(fphMixId))?.status === '已完成'
      && dbh337Progress?.normalFulfilledQuantity === 2 && dbh337Progress?.normalReceivedQuantity === 2,
    JSON.stringify(dbh337Progress ?? null))

  // ════ #359：分院配货赠送数量单独选赠送批次 ════
  setSession(storeA1Session())
  const { id: dbh359Id } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG, items: [{ skuId: SKU_SUPPLY, quantity: 3 }],
  })
  const [dbh359Item] = await docItems(dbh359Id)
  const normalLot359 = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SUPPLY, skuName: `${SKU_SUPPLY}_名`, quantity: 5, batchNo: 'SC-359',
    supplyChainUnitCost: 800, marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
  })
  const giftLot359 = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SUPPLY, skuName: `${SKU_SUPPLY}_名`, quantity: 2, batchNo: 'GIFT-359', isGift: true,
    supplyChainUnitCost: 0, marketStandardUnitPrice: 0, marketUnitDiscount: 0, marketActualUnitPrice: 0,
  })
  setSession(marketASession())
  const lotOptions359 = await (await import(A('src', 'actions', 'inventory', 'stocks.ts'))).listInventoryLotOptions(MKA_ORG, SKU_SUPPLY)
  const giftOption359 = lotOptions359.find((lot) => lot.id === giftLot359)
  check('#359 批次选项下发赠送标记与参考进价（市场价格档可见）',
    giftOption359?.isGift === true && giftOption359?.marketActualUnitPrice === 0
      && lotOptions359.find((lot) => lot.id === normalLot359)?.marketActualUnitPrice === 950,
    JSON.stringify(lotOptions359.filter((lot) => [normalLot359, giftLot359].includes(lot.id))
      .map((lot) => ({ id: lot.id, isGift: lot.isGift, price: lot.marketActualUnitPrice }))))
  const { id: fph359Id } = await biz.createStoreAllocation({
    storeRequestId: dbh359Id, sourceMarketId: MKA_ORG,
    items: [{ requestItemId: dbh359Item.id, lotId: normalLot359, quantity: 3, giftQuantity: 2, giftLotId: giftLot359 }],
  })
  const fph359Items = await docItems(fph359Id)
  const fph359Normal = fph359Items.find((item) => !item.is_gift)
  const fph359Gift = fph359Items.find((item) => item.is_gift)
  check('#359 正常行出普通批次、赠送行出赠送批次，赠送行金额 0',
    Number(fph359Normal?.lot_id) === normalLot359 && num(fph359Normal?.quantity) === 3
      && Number(fph359Gift?.lot_id) === giftLot359 && num(fph359Gift?.quantity) === 2 && num(fph359Gift?.amount) === 0,
    JSON.stringify(fph359Items.map((item) => ({ lot: item.lot_id, gift: item.is_gift, qty: item.quantity, amount: item.amount }))))
  check('#359 两个批次各自扣减（普通 5→2、赠送 2→0）',
    (await lotQuantity(normalLot359)) === 2 && (await lotQuantity(giftLot359)) === 0,
    `${await lotQuantity(normalLot359)} / ${await lotQuantity(giftLot359)}`)
  const fph359Links = await pgQuery(
    `SELECT relation_type, quantity FROM inventory_doc_links WHERE to_doc_id = $1 ORDER BY relation_type`, [fph359Id],
  )
  check('#359 血缘照旧：门店报货配货 3 + 门店报货赠送配货 2',
    JSON.stringify(fph359Links.map((link) => [link.relation_type, num(link.quantity)]))
      === JSON.stringify([['门店报货赠送配货', 2], ['门店报货配货', 3]]),
    JSON.stringify(fph359Links))

  // ════ #362：采购覆盖门店与实际配货门店错位时，待配 / 建议采购按在途封顶 ════
  // 独立 SKU（复制 SKU_SUPPLY 的档案），不受前面各段遗留的需求 / 在途影响；TE2AI 前缀随退场清理。
  const SKU_362 = `${SKU_SUPPLY}_362`
  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, source_type, supplier, supplier_id,
       retail_price, accounting_price, market_purchase_discount, market_purchase_price, market_purchase_price_mode,
       supply_chain_purchase_price, store_purchase_price, market_staff_purchase_price, item_company_purchase_price,
       is_reportable, is_active
     )
     SELECT $1, product_code || '-362', product_name || '_362', spec_name, source_type, supplier, supplier_id,
            retail_price, accounting_price, market_purchase_discount, market_purchase_price, market_purchase_price_mode,
            supply_chain_purchase_price, store_purchase_price, market_staff_purchase_price, item_company_purchase_price,
            is_reportable, is_active
       FROM inventory_skus WHERE sku_id = $2
     ON CONFLICT (sku_id) DO NOTHING`,
    [SKU_362, SKU_SUPPLY],
  )
  // 门店 A 先报（明细 id 小）10，门店 B 后报 6；市场现货 6
  setSession(storeA1Session())
  const { id: req362A } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG, items: [{ skuId: SKU_362, quantity: 10 }],
  })
  setSession(storeA2Session())
  const { id: req362B } = await biz.createStoreReplenishmentRequest({
    storeId: STA2_ID, marketId: MKA_ORG, items: [{ skuId: SKU_362, quantity: 6 }],
  })
  const [item362A] = await docItems(req362A)
  const [item362B] = await docItems(req362B)
  const lot362 = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_362, skuName: `${SKU_362}_名`, quantity: 6, batchNo: 'SEED-362',
    supplyChainUnitCost: 800, marketStandardUnitPrice: 1000, marketUnitDiscount: 0, marketActualUnitPrice: 1000,
  })
  setSession(marketASession())
  const line362 = async () => (await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG }))
    .items.find((line) => line.skuId === SKU_362) ?? null
  const shape = (line) => line && {
    outstanding: line.outstandingQuantity, available: line.availableQuantity,
    inTransit: line.inTransitQuantity, covered: line.inTransitCoveredQuantity, suggested: line.suggestedPurchaseQuantity,
  }
  const start362 = await line362()
  check('#362 起点：待配 16、可用 6、在途 0、建议采购 10（与改造前同口径）',
    JSON.stringify(shape(start362)) === JSON.stringify({ outstanding: 16, available: 6, inTransit: 0, covered: 0, suggested: 10 }),
    JSON.stringify(shape(start362)))
  // 市场报货实际采购 10，血缘按明细 id 升序全部挂在 A
  const { id: mbh362Id } = await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_362, sourceRequestItemIds: [item362A.id, item362B.id], purchaseQuantity: 10 }],
  })
  const links362 = await pgQuery(
    `SELECT from_item_id, quantity FROM inventory_doc_links WHERE to_doc_id = $1 AND relation_type = '门店报货汇总'`,
    [mbh362Id],
  )
  check('#362 采购 10 的汇总血缘全挂在 A（复现前提）',
    links362.length === 1 && Number(links362[0].from_item_id) === Number(item362A.id) && num(links362[0].quantity) === 10,
    JSON.stringify(links362))
  const afterReport362 = await line362()
  check('#362 报货后：B 待配 6、在途 10、现货 6 够 B → 建议采购 0',
    JSON.stringify(shape(afterReport362)) === JSON.stringify({ outstanding: 6, available: 6, inTransit: 10, covered: 0, suggested: 0 }),
    JSON.stringify(shape(afterReport362)))
  // 到货前市场把现货 6 配给 A（A 的已配 0，上限检查放行）
  await biz.createStoreAllocation({
    storeRequestId: req362A, sourceMarketId: MKA_ORG,
    items: [{ requestItemId: item362A.id, lotId: lot362, quantity: 6 }],
  })
  const afterMisaligned362 = await line362()
  // 改造前：A 截断为 0、B 6、可用 0 → 待配 6、建议采购 6（误导再采 6）
  check('#362 错位配货后：16 已被现货 6 + 在途 10 覆盖 → 待配 0、建议采购 0，在途 10 亮出来',
    JSON.stringify(shape(afterMisaligned362)) === JSON.stringify({ outstanding: 0, available: 0, inTransit: 10, covered: 6, suggested: 0 }),
    JSON.stringify(shape(afterMisaligned362)))
  check('#362 B 的明细仍可被下次市场报货引用（只调显示口径，不改血缘）',
    afterMisaligned362?.requestItemIds.includes(Number(item362B.id)) === true
      && !afterMisaligned362?.requestItemIds.includes(Number(item362A.id)),
    JSON.stringify(afterMisaligned362?.requestItemIds ?? null))

  // 市场自采商品的市场报货进不了供应链采购、也不会有发货收货血缘：不计在途（否则永远核销不掉）
  setSession(storeA1Session())
  const { id: reqSelf362 } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG, items: [{ skuId: SKU_SELF, quantity: 4 }],
  })
  const [itemSelf362] = await docItems(reqSelf362)
  setSession(marketASession())
  await biz.createMarketReplenishment({
    marketId: MKA_ORG, supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SELF, sourceRequestItemIds: [itemSelf362.id], purchaseQuantity: 2 }],
  })
  const selfLine362 = (await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG }))
    .items.find((line) => line.skuId === SKU_SELF)
  check('#362 自采商品的市场报货不计在途：剩余 2 照常待配',
    selfLine362?.inTransitQuantity === 0 && selfLine362?.outstandingQuantity === 2,
    JSON.stringify(shape(selfLine362 ?? null)))

  // 在途的「已收货」口径对账：SKU_SUPPLY 在前面各段真实走过发货 → 市场收货，
  // 汇总里的在途必须等于各市场报货单履约进度（engine）的 Σ(报货 − 正常已收)。
  setSession(storeA1Session())
  await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID, marketId: MKA_ORG, items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
  })
  setSession(marketASession())
  const supplyLine = (await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG }))
    .items.find((line) => line.skuId === SKU_SUPPLY)
  const mkaReports = await pgQuery(
    `SELECT id FROM inventory_docs WHERE doc_type = '市场报货' AND status = '已完成' AND market_id = $1`, [MKA_ORG],
  )
  let expectedInTransit = 0
  let receivedTotal = 0
  for (const { id } of mkaReports) {
    const detail = await docs.getInventoryCoreDocById(id)
    const skuItemIds = new Set(detail.items.filter((item) => item.skuId === SKU_SUPPLY).map((item) => Number(item.id)))
    for (const progress of detail.fulfillmentProgress?.items ?? []) {
      if (!skuItemIds.has(Number(progress.itemId))) continue
      expectedInTransit += Math.max(progress.normalDemandQuantity - progress.normalReceivedQuantity, 0)
      receivedTotal += progress.normalReceivedQuantity
    }
  }
  check('#362 在途 = Σ(市场报货 − engine 正常已收)，且样本里确有已收货（非空集对账）',
    receivedTotal > 0 && supplyLine?.inTransitQuantity === expectedInTransit,
    JSON.stringify({ inTransit: supplyLine?.inTransitQuantity, expectedInTransit, receivedTotal, reports: mkaReports.length }))
} catch (e) {
  check('冒烟整体', false, '致命错误：' + (e?.stack || e?.message || String(e)))
} finally {
  try {
    await cleanupInventoryFixture()
  } catch (e) {
    check('退场清理', false, e?.message ?? String(e))
  }
  await closePool()
}

console.log('\n──────── 进销存正向全链冒烟报告 ────────')
for (const line of report) console.log(line)
console.log(`────────────────────────────────────\n${failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌'}`)
process.exit(failed === 0 ? 0 : 1)
