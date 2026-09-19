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
  HQ_ORG, MKA_ORG, MKB_ORG, STA1_ID, STA1_ORG,
  SKU_SUPPLY, SUPPLIER_ID, PROMO_ID,
  cleanupInventoryFixture, ensureInventoryFixture,
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
  check('采购订单继承市场报货福利价并核算金额',
    num(cgdHead?.total_amount) === 5700 && num(cgdItem?.actual_unit_price) === 950,
    `total=${cgdHead?.total_amount}`)
  check('市场行带市场归属（据此分流到品项公司发货）', cgdItem?.market_id === MKA_ORG, `${cgdItem?.market_id}`)
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

  // ════ 阶段 5：品项公司发货（§5.2 赠送 / §5.3 无金额）════
  await expectThrow('正常发货数量超过采购订单被拒(CONFLICT)', /CONFLICT/, () =>
    biz.createItemCompanyShipment({
      purchaseOrderId: cgdId,
      sourceOrgNodeId: HQ_ORG,
      items: [{ purchaseOrderItemId: cgdItem.id, lotId: hqLot.id, quantity: 7 }],
    }))
  const { id: gfhId } = await biz.createItemCompanyShipment({
    purchaseOrderId: cgdId,
    sourceOrgNodeId: HQ_ORG,
    items: [{ purchaseOrderItemId: cgdItem.id, lotId: hqLot.id, quantity: 6, giftQuantity: 2 }],
  })
  const gfhHead = await docHeader(gfhId)
  const gfhItems = await docItems(gfhId)
  const gfhNormal = gfhItems.find((item) => !item.is_gift)
  const gfhGift = gfhItems.find((item) => item.is_gift)
  check('品项公司发货：正常+赠送两行且总量可大于报货(§5.2)',
    gfhItems.length === 2 && num(gfhNormal?.quantity) === 6 && num(gfhGift?.quantity) === 2,
    `items=${gfhItems.length}`)
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
  check('市场批次价格快照（真实单价 950 / 门店标准价 1200 / 成本 800）',
    num(mkaNormalLot?.quantity_on_hand) === 6
      && num(mkaNormalLot?.market_actual_unit_price) === 950
      && num(mkaNormalLot?.store_standard_unit_price) === 1200
      && num(mkaNormalLot?.supply_chain_unit_cost) === 800
      && num(mkaGiftLot?.quantity_on_hand) === 2,
    JSON.stringify({ normal: mkaNormalLot?.quantity_on_hand, gift: mkaGiftLot?.quantity_on_hand }))

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
    purchaseOrderId: cgd2Id,
    sourceOrgNodeId: HQ_ORG,
    items: [{ purchaseOrderItemId: cgd2Item.id, lotId: hqLot.id, quantity: 3 }],
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
  await biz.approveItemCompanyShipmentCancellation({ shipmentId: gfh2Id, auditRemark: '同意撤回' })
  const gfh2Head = await docHeader(gfh2Id)
  const [cgd2ItemAfter] = await docItems(cgd2Id)
  check('供应链审批撤回：单据取消 + 总部库存回滚 + 采购订单履约回退(§6.2)',
    gfh2Head?.status === '已取消'
      && num((await locationLots(HQ_ORG, SKU_SUPPLY))[0]?.quantity_on_hand) === 92
      && num(cgd2ItemAfter?.fulfilled_quantity) === 0,
    `status=${gfh2Head?.status} fulfilled=${cgd2ItemAfter?.fulfilled_quantity}`)
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
  check('回退后该汇总行可以重新下单',
    (await biz.createPurchaseOrder({
      supplyChainLocationId: HQ_ORG,
      items: [{ sourceItemId: mixMhzItem.id, quantity: 2 }],
    })).id.length > 0, '')
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
