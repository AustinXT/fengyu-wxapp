/**
 * 进销存调货闭环 + 自采链冒烟（impl）。由 smoke-inventory-transfer.mjs 以
 * `bun --preload _inv-smoke-preload.mjs` 启动。
 *
 * 断言核心：
 *   §8.2 同市场门店才可调货（约束存在性验证）；
 *   §10.3 市场间调货出库归来源市场、入库归目标市场，调用端传 marketId 不改变归属；
 *   自采 SKU 仅可在归属市场业务链中流转（含跨市场调货拦截）；
 *   §4 自采入库 → 配货给门店并核算门店货款；
 *   #200 通用建单的端点口径（入库类 target 越权 / 多余端点）在**落库之前**就被拒。
 *
 * ⚠️ 本文件的三条调货正向/文案断言（STA1→STA2 成功、STA1→STB1 报「同市场」、
 *    MKA→MKB 成功）是「不要给调货单 target 加建单期 scope 校验」的硬证据（#200 S10-1）：
 *    任何给 transfer target 加 guard 的实现都会在这里红，别顺手改成 PERMISSION_DENIED。
 */
import path from 'node:path'
import { closePool, pgQuery } from './setup.mjs'
import {
  INS, HQ_ORG,
  MKA_ORG, MKB_ORG, STA1_ID, STA1_ORG, STA2_ID, STA2_ORG, STB1_ID, STB1_ORG,
  SKU_SELF, SKU_SUPPLY, SUPPLIER_ID,
  cleanupInventoryFixture, ensureInventoryFixture, insertSeedLot,
  docHeader, docItems, locationLots, lotQuantity,
  marketASession, marketBSession, storeA1Session, storeA2Session, storeB1Session, supplyChainSession,
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
/**
 * TE2AI 命名空间内的 inventory_docs 行数（可选按 doc_type 收窄）。
 *
 * 按命名空间过滤而不是全表 COUNT(*)：INV_E2E_DATABASE_URL 允许把冒烟指到共享库，
 * 那里别人的单据会让全表计数漂移，把「没落单」的断言变成不确定性假红。
 * 被拒的建单即便落了库也一定命中本命名空间（endpoint 与 created_by 都是 TE2AI%）。
 */
async function inventoryDocCount(docType = null) {
  const rows = await pgQuery(
    `SELECT COUNT(*)::int AS n
       FROM inventory_docs
      WHERE (source_org_node_id LIKE $1 OR target_org_node_id LIKE $1 OR created_by LIKE $1)
        AND ($2::text IS NULL OR doc_type = $2::text)`,
    [`${INS}%`, docType],
  )
  return Number(rows[0].n)
}
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

  // 种子库存：门店A1 供应链品批次（真实单价 1100）、市场A 供应链品批次、市场A 自采品批次
  const storeLotId = await insertSeedLot({
    locationId: STA1_ID, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品',
    quantity: 10, batchNo: 'TSEED-S',
    supplyChainUnitCost: 800,
    marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
    storeStandardUnitPrice: 1200, storeUnitDiscount: 100, storeActualUnitPrice: 1100,
  })
  const marketLotId = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品',
    quantity: 8, batchNo: 'TSEED-M',
    supplyChainUnitCost: 800,
    marketStandardUnitPrice: 1000, marketUnitDiscount: 50, marketActualUnitPrice: 950,
    storeStandardUnitPrice: 1200, storeUnitDiscount: 0, storeActualUnitPrice: 1200,
  })
  const selfSeedLotId = await insertSeedLot({
    locationId: MKA_ORG, skuId: SKU_SELF, skuName: 'TE2AI_市场A自采品',
    quantity: 6, batchNo: 'TSEED-SELF',
    marketStandardUnitPrice: 30, marketUnitDiscount: 0, marketActualUnitPrice: 30,
    storeStandardUnitPrice: 40, storeUnitDiscount: 0, storeActualUnitPrice: 40,
  })

  // ════ #200 通用建单端点口径（负向：真 PG 证「库里没落单」）════
  //
  // 单测的 mock db 只能证明「函数抛了错」，证不了拒绝发生在 `db.transaction` **之前**。
  // 这件事必须在真库上钉：一旦拒绝晚于单头 insert，migration 0039 的
  // inventory_set_doc_market_id 触发器（BEFORE INSERT）就已经按
  // COALESCE(source_market, target_market) 把这张伪造单归进伪造方的市场，
  // 而 listInventoryCoreDocs 的 source/target 任一在 scope 即可见也随之放行。
  setSession(storeA1Session())
  const docsBefore = await inventoryDocCount()
  // (a) issue 原文的攻击载荷：拿本店（有权）的 source 去换一个 scope 外的 target。
  //     改前服务端按 `source ?? target` 判权威主体，用有权的 source 就把货退进了别人家。
  //     改后鉴权端固定落在 target（入库类真正被改动的那一端），所以这里被 scope 闸直接拒掉。
  //     ⚠️ 断的是 PERMISSION_DENIED 而不是形状错 —— 服务端的顺序是「scope 先于单边规则」，
  //     target 越权时根本走不到「不接受出库主体」那一句。要单独验单边规则见 (a2)。
  await expectThrow('#200 院顾客退货攻击载荷被拒(AC1/AC6)', /PERMISSION_DENIED.*无权操作该组织节点单据/, () =>
    docs.createInventoryCoreDoc({
      docType: '院顾客退货',
      sourceOrgNodeId: STA1_ORG,
      targetOrgNodeId: STA2_ORG,
      items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
    }))
  // (a2) AC5：单边单据夹带另一端时必须拒单、而不是静默忽略。
  //      两端都填本店（都在 scope 内）才能越过上面那道 scope 闸，真正把单边规则测到 ——
  //      若写成一个 scope 外的 target，拿到的就只是 (a) 那条 PERMISSION_DENIED，规则本身没被覆盖。
  //      静默忽略的危害不止于少个报错：残留的 source 会被 0039 的 inventory_set_doc_market_id
  //      按 COALESCE(source_market, target_market) 归错市场。
  await expectThrow('#200 院顾客退货夹带出库主体被拒(AC5)', /INVALID_PARAMS.*不接受出库主体/, () =>
    docs.createInventoryCoreDoc({
      docType: '院顾客退货',
      sourceOrgNodeId: STA1_ORG,
      targetOrgNodeId: STA1_ORG,
      items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
    }))
  // (b) AC6：连 source 都不传，鉴权端只可能是 target —— 排除「靠 source 侥幸过闸」的解释。
  //     文案一起断：层级 action 闸拒的是「缺少…库存操作权限」，这里断「无权操作该组织节点单据」，
  //     才能证明拒绝来自 assertOrgNodeVisible。
  await expectThrow('#200 院顾客退货 target 越权被拒(AC6)', /PERMISSION_DENIED.*无权操作该组织节点单据/, () =>
    docs.createInventoryCoreDoc({
      docType: '院顾客退货',
      targetOrgNodeId: STB1_ORG,
      items: [{ skuId: SKU_SUPPLY, quantity: 1 }],
    }))
  const docsAfter = await inventoryDocCount()
  const returnDocs = await inventoryDocCount('院顾客退货')
  check('#200 三次非法建单都没落库(inventory_docs 行数不变)',
    docsAfter === docsBefore && returnDocs === 0,
    `before=${docsBefore} after=${docsAfter} 院顾客退货=${returnDocs}`)

  // ════ 分院间调货（§8.2 限同市场）════
  setSession(storeA1Session())
  await expectThrow('跨市场门店调货被拒(§8.2)', /INVALID_PARAMS.*同市场/, () =>
    docs.createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceOrgNodeId: STA1_ORG,
      targetOrgNodeId: STB1_ORG,
      items: [{ lotId: storeLotId, quantity: 1 }],
    }))
  await expectThrow('门店与市场之间不能走分院调货(§8.2)', /INVALID_PARAMS/, () =>
    docs.createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceOrgNodeId: STA1_ORG,
      targetOrgNodeId: MKA_ORG,
      items: [{ lotId: storeLotId, quantity: 1 }],
    }))

  const { id: dtoId } = await docs.createInventoryCoreDoc({
    docType: '分院调货出库',
    sourceOrgNodeId: STA1_ORG,
    targetOrgNodeId: STA2_ORG,
    items: [{ lotId: storeLotId, quantity: 4 }],
  })
  const dtoHead = await docHeader(dtoId)
  check('分院调货出库：待收货 + 出库扣减 + 归属本市场',
    dtoHead?.status === '待收货' && dtoHead?.market_id === MKA_ORG
      && (await lotQuantity(storeLotId)) === 6,
    `${dtoId} market_id=${dtoHead?.market_id} storeA1=${await lotQuantity(storeLotId)}`)

  await expectThrow('非目标门店不能收货确认', /PERMISSION_DENIED/, () =>
    docs.confirmInventoryCoreReceive(dtoId))
  setSession(storeA2Session())
  const { inboundDocId: dtiId } = await docs.confirmInventoryCoreReceive(dtoId)
  const dtiHead = await docHeader(dtiId)
  const storeA2Lots = await locationLots(STA2_ID, SKU_SUPPLY)
  check('目标门店收货生成分院调货入库并延续真实单价(§7.3)',
    dtiHead?.doc_type === '分院调货入库' && dtiHead?.status === '已完成'
      && dtiHead?.market_id === MKA_ORG
      && storeA2Lots.length === 1 && num(storeA2Lots[0]?.quantity_on_hand) === 4
      && num(storeA2Lots[0]?.store_actual_unit_price) === 1100
      && (await docHeader(dtoId))?.status === '已完成',
    JSON.stringify({ dti: dtiId, qty: storeA2Lots[0]?.quantity_on_hand, act: storeA2Lots[0]?.store_actual_unit_price }))

  // ════ 市场间调货（§10.3 归属与可见性）════
  setSession(marketASession())
  await expectThrow('自采 SKU 不得跨市场调出（仅归属市场使用）', /INVALID_STATE/, () =>
    docs.createInventoryCoreDoc({
      docType: '市场间调货出库',
      sourceOrgNodeId: MKA_ORG,
      targetOrgNodeId: MKB_ORG,
      items: [{ lotId: selfSeedLotId, quantity: 1 }],
    }))
  // 故意传目标市场 marketId：派生归属不能被调用端改变（§10.3）
  const { id: mtoId } = await docs.createInventoryCoreDoc({
    docType: '市场间调货出库',
    sourceOrgNodeId: MKA_ORG,
    targetOrgNodeId: MKB_ORG,
    marketId: MKB_ORG,
    items: [{ lotId: marketLotId, quantity: 3 }],
  })
  const mtoHead = await docHeader(mtoId)
  check('市场间调货出库归来源市场(§10.3，调用端传值被忽略)',
    mtoHead?.market_id === MKA_ORG && (await lotQuantity(marketLotId)) === 5,
    `${mtoId} market_id=${mtoHead?.market_id}`)

  setSession(supplyChainSession())
  check('总部不因父级关系看到市场间调货单(§9.4)',
    (await docs.getInventoryCoreDocById(mtoId)) === null, mtoId)
  setSession(marketBSession())
  check('目标市场可见这张与己相关的出库单', (await docs.getInventoryCoreDocById(mtoId)) !== null, mtoId)
  check('目标市场看不到来源市场的其他单据(§9.4)',
    (await docs.getInventoryCoreDocById(dtoId)) === null, dtoId)

  const { inboundDocId: mtiId } = await docs.confirmInventoryCoreReceive(mtoId)
  const mtiHead = await docHeader(mtiId)
  const mkbLots = await locationLots(MKB_ORG, SKU_SUPPLY)
  check('市场间调货入库归目标市场(§10.3)',
    mtiHead?.doc_type === '市场间调货入库' && mtiHead?.market_id === MKB_ORG
      && mkbLots.length === 1 && num(mkbLots[0]?.quantity_on_hand) === 3
      && num(mkbLots[0]?.market_actual_unit_price) === 950,
    `${mtiId} market_id=${mtiHead?.market_id} qty=${mkbLots[0]?.quantity_on_hand}`)
  setSession(marketASession())
  check('来源市场可见入库单（与己相关）', (await docs.getInventoryCoreDocById(mtiId)) !== null, mtiId)

  // ════ 自采链（§4）════
  setSession(marketBSession())
  await expectThrow('他市场不能对归属市场A 的自采 SKU 做自采入库', /INVALID_STATE/, () =>
    biz.createSelfPurchasedReceipt({
      marketId: MKB_ORG,
      supplierId: SUPPLIER_ID,
      items: [{ skuId: SKU_SELF, quantity: 5 }],
    }))
  setSession(storeB1Session())
  await expectThrow('他市场门店不能报货归属市场A 的自采 SKU', /INVALID_STATE/, () =>
    biz.createStoreReplenishmentRequest({
      storeId: STB1_ID,
      marketId: MKB_ORG,
      items: [{ skuId: SKU_SELF, quantity: 1 }],
    }))

  setSession(marketASession())
  const { id: zrkId } = await biz.createSelfPurchasedReceipt({
    marketId: MKA_ORG,
    supplierId: SUPPLIER_ID,
    items: [{ skuId: SKU_SELF, quantity: 20, batchNo: 'SELF-B1', marketActualUnitPrice: 28, storeUnitDiscount: 5 }],
  })
  const zrkHead = await docHeader(zrkId)
  const selfLots = (await locationLots(MKA_ORG, SKU_SELF)).filter((lot) => lot.batch_no === 'SELF-B1')
  const selfLot = selfLots[0]
  check('自采产品入库：市场财务完成 + 金额=20×28(触发器)',
    zrkHead?.doc_type === '自采产品入库' && zrkHead?.status === '已完成'
      && zrkHead?.market_id === MKA_ORG && num(zrkHead?.total_amount) === 560
      && num(selfLot?.quantity_on_hand) === 20,
    `${zrkId} total=${zrkHead?.total_amount} qty=${selfLot?.quantity_on_hand}`)
  check('自采批次价格快照：市场实际 28 / 门店标准 40-5=35',
    num(selfLot?.market_actual_unit_price) === 28
      && num(selfLot?.store_standard_unit_price) === 40
      && num(selfLot?.store_actual_unit_price) === 35,
    JSON.stringify({ act: selfLot?.market_actual_unit_price, storeAct: selfLot?.store_actual_unit_price }))

  // 自采品像正常产品一样配货给门店并核算货款（§4）
  setSession(storeA1Session())
  const { id: dbhSelfId } = await biz.createStoreReplenishmentRequest({
    storeId: STA1_ID,
    marketId: MKA_ORG,
    items: [{ skuId: SKU_SELF, quantity: 5 }],
  })
  const [dbhSelfItem] = await docItems(dbhSelfId)
  setSession(marketASession())
  const { id: fphSelfId } = await biz.createStoreAllocation({
    storeRequestId: dbhSelfId,
    sourceMarketId: MKA_ORG,
    items: [{ requestItemId: dbhSelfItem.id, lotId: selfLot.id, quantity: 5, storeUnitDiscount: 5 }],
  })
  const fphSelfHead = await docHeader(fphSelfId)
  const [fphSelfItem] = await docItems(fphSelfId)
  check('自采品分院配货核算门店货款：40-5=35×5=175(§4/§7.3)',
    num(fphSelfItem?.standard_unit_price) === 40 && num(fphSelfItem?.unit_discount) === 5
      && num(fphSelfItem?.actual_unit_price) === 35 && num(fphSelfHead?.total_amount) === 175,
    JSON.stringify({ std: fphSelfItem?.standard_unit_price, act: fphSelfItem?.actual_unit_price, total: fphSelfHead?.total_amount }))
  setSession(storeA1Session())
  const { id: yrkSelfId } = await biz.receiveStoreAllocation({
    shipmentId: fphSelfId,
    items: [{ shipmentItemId: fphSelfItem.id, receivedQuantity: 5 }],
  })
  const storeSelfLots = await locationLots(STA1_ID, SKU_SELF)
  check('门店收货自采品：批次落门店并锁定真实单价 35',
    (await docHeader(yrkSelfId))?.status === '已完成'
      && storeSelfLots.length === 1 && num(storeSelfLots[0]?.quantity_on_hand) === 5
      && num(storeSelfLots[0]?.store_actual_unit_price) === 35,
    JSON.stringify({ qty: storeSelfLots[0]?.quantity_on_hand, act: storeSelfLots[0]?.store_actual_unit_price }))

  // ════ #343 库存转换仅供应链可做 ════
  // 正向：供应链账号对总部批次转换，产出出库 + 入库两张单、双向流水与转换血缘；
  // 反向：市场账号被权限闸拒、供应链账号传市场主体被拒、自建商品不能作转换目标。
  const SKU_SUPPLY2 = `${INS}_SKU_SC2`
  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, source_type, supplier, supplier_id,
       accounting_price, market_purchase_discount, market_purchase_price, market_purchase_price_mode,
       supply_chain_purchase_price, store_purchase_price, is_reportable, is_active
     ) VALUES ($1, $2, $3, '瓶', '供应链', $5, $4, 4000, 0.25, 1000, '公式', 800, 1200, true, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_active = true`,
    [SKU_SUPPLY2, `${INS}-SC-002`, `${INS}_供应链产品2`, SUPPLIER_ID, `${INS}_供应商1`],
  )
  const hqConvLotId = await insertSeedLot({
    locationId: HQ_ORG, skuId: SKU_SUPPLY, skuName: 'TE2AI_供应链产品',
    quantity: 5, batchNo: 'TSEED-HQ-CONV', supplyChainUnitCost: 800,
  })
  setSession(marketASession())
  await expectThrow('#343 市场账号不能做库存转换(PERMISSION_DENIED)', /PERMISSION_DENIED/, () =>
    biz.createInventoryConversion({
      locationId: MKA_ORG,
      items: [{ sourceLotId: marketLotId, sourceQuantity: 1, targetSkuId: SKU_SUPPLY2, targetQuantity: 1 }],
    }))
  setSession(supplyChainSession())
  // 只认主体类型文案：删掉 assertType 的话 scope 闸会报 PERMISSION_DENIED，这里必须转红
  await expectThrow('#343 供应链账号传市场主体被拒（主体类型闸）', /INVALID_PARAMS.*库存转换主体必须是总部库存主体/, () =>
    biz.createInventoryConversion({
      locationId: MKA_ORG,
      items: [{ sourceLotId: marketLotId, sourceQuantity: 1, targetSkuId: SKU_SUPPLY2, targetQuantity: 1 }],
    }))
  await expectThrow('#343 自建商品不能作转换目标', /自建商品不能转换/, () =>
    biz.createInventoryConversion({
      locationId: HQ_ORG,
      items: [{ sourceLotId: hqConvLotId, sourceQuantity: 1, targetSkuId: SKU_SELF, targetQuantity: 1 }],
    }))
  const conversion = await biz.createInventoryConversion({
    locationId: HQ_ORG,
    items: [{ sourceLotId: hqConvLotId, sourceQuantity: 2, targetSkuId: SKU_SUPPLY2, targetQuantity: 2, targetBatchNo: 'CONV-1' }],
  })
  const convLinks = await pgQuery(
    `SELECT relation_type FROM inventory_doc_links WHERE from_doc_id = $1 AND to_doc_id = $2`,
    [conversion.outboundId, conversion.inboundId])
  const convTargetLots = await locationLots(HQ_ORG, SKU_SUPPLY2)
  const convMovements = await pgQuery(
    `SELECT doc_id, direction, quantity_delta FROM inventory_movements WHERE doc_id IN ($1, $2) ORDER BY doc_id`,
    [conversion.outboundId, conversion.inboundId])
  check('#343 供应链账号总部转换成功：出/入库两单 + 来源扣 2 + 目标入 2 + 转换血缘',
    (await docHeader(conversion.outboundId))?.doc_type === '库存转换出库'
      && (await docHeader(conversion.inboundId))?.doc_type === '库存转换入库'
      && (await lotQuantity(hqConvLotId)) === 3
      && convTargetLots.length === 1 && num(convTargetLots[0]?.quantity_on_hand) === 2
      && convLinks.some((link) => link.relation_type === '库存转换')
      && convMovements.some((m) => m.doc_id === conversion.outboundId && m.direction === '出库' && num(m.quantity_delta) === -2)
      && convMovements.some((m) => m.doc_id === conversion.inboundId && m.direction === '入库' && num(m.quantity_delta) === 2),
    JSON.stringify({ conversion, links: convLinks, movements: convMovements, target: convTargetLots.map((lot) => lot.quantity_on_hand) }))
  check('转换手填目标批号原样保存(#345)', convTargetLots[0]?.batch_no === 'CONV-1', `${convTargetLots[0]?.batch_no}`)

  // ════ #345 批号留空自动生成：库存转换 / 自采产品入库 ════
  const autoConversion = await biz.createInventoryConversion({
    locationId: HQ_ORG,
    items: [{ sourceLotId: hqConvLotId, sourceQuantity: 1, targetSkuId: SKU_SUPPLY2, targetQuantity: 1 }],
  })
  const [autoConvInItem] = await docItems(autoConversion.inboundId)
  const autoConvLot = (await locationLots(HQ_ORG, SKU_SUPPLY2)).find((lot) => lot.batch_no === `${autoConversion.inboundId}-01`)
  check('转换目标批号留空：按「转换入库单号-行号」生成新批号，不沿用来源批号(#345)',
    autoConvInItem?.batch_no === `${autoConversion.inboundId}-01`
      && autoConvInItem.batch_no !== 'TSEED-HQ-CONV'
      && num(autoConvLot?.quantity_on_hand) === 1,
    JSON.stringify({ item: autoConvInItem?.batch_no, lot: autoConvLot?.batch_no }))

  setSession(marketASession())
  const autoSelfIds = []
  for (const isGift of [false, true, false]) {
    const { id } = await biz.createSelfPurchasedReceipt({
      marketId: MKA_ORG,
      supplierId: SUPPLIER_ID,
      items: [{ skuId: SKU_SELF, quantity: 1, isGift, marketActualUnitPrice: 28, storeUnitDiscount: 0 }],
    })
    autoSelfIds.push(id)
  }
  const autoSelfItems = (await Promise.all(autoSelfIds.map((id) => docItems(id)))).flat()
  const autoSelfLots = (await locationLots(MKA_ORG, SKU_SELF)).filter((lot) => autoSelfIds.some((id) => lot.batch_no === `${id}-01`))
  check('自采入库批号留空：同日三次入库（含赠送）各按「入库单号-行号」生成且互不相同(#345)',
    autoSelfItems.length === 3
      && autoSelfItems.every((item, index) => item.batch_no === `${autoSelfIds[index]}-01`)
      && new Set(autoSelfItems.map((item) => item.batch_no)).size === 3
      && autoSelfLots.length === 3
      && autoSelfLots.filter((lot) => lot.is_gift).length === 1,
    JSON.stringify({ items: autoSelfItems.map((item) => item.batch_no), lots: autoSelfLots.map((lot) => [lot.batch_no, lot.is_gift]) }))

  // 并发：两个市场各自自采入库，不共享主体 / 单据行锁。进销存写入统一先取 cutover 状态行
  // FOR UPDATE（cutover.ts assertInventoryBusinessWritable），再在 generateDocId 取 advisory lock，
  // 最后由 inventory_docs 主键兜底 —— 单号唯一有三道保证，批号 = 单号-行号随之唯一（#345）。
  // 本用例钉的是「并发提交两单都成功且批号互异」这一结果，不单独证明 advisory lock（它被 cutover 行锁遮住）。
  const SKU_SELF_B = `${INS}_SKU_SELF_B`
  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, source_type, owner_market_id,
       supplier, supplier_id, market_purchase_price, store_purchase_price, is_reportable, is_active
     ) VALUES ($1, $2, $3, '件', '市场自采', $4, $6, $5, 30, 40, true, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_active = true, owner_market_id = $4`,
    [SKU_SELF_B, `${INS}-SELF-B-001`, `${INS}_市场B自采品`, MKB_ORG, SUPPLIER_ID, `${INS}_供应商1`],
  )
  const bothMarkets = marketASession()
  const marketB = marketBSession()
  bothMarkets.roles.push(...marketB.roles)
  bothMarkets.permissions.scopeStoreIds.push(...marketB.permissions.scopeStoreIds)
  bothMarkets.permissions.scopeOrgNodeIds.push(...marketB.permissions.scopeOrgNodeIds)
  setSession(bothMarkets)
  const concurrentSelf = await Promise.allSettled([
    biz.createSelfPurchasedReceipt({
      marketId: MKA_ORG, supplierId: SUPPLIER_ID,
      items: [{ skuId: SKU_SELF, quantity: 1, marketActualUnitPrice: 28, storeUnitDiscount: 0 }],
    }),
    biz.createSelfPurchasedReceipt({
      marketId: MKB_ORG, supplierId: SUPPLIER_ID,
      items: [{ skuId: SKU_SELF_B, quantity: 1, marketActualUnitPrice: 28, storeUnitDiscount: 0 }],
    }),
  ])
  const concurrentIds = concurrentSelf.map((result) => (result.status === 'fulfilled' ? result.value.id : null))
  const concurrentBatchNos = (await Promise.all(concurrentIds.map((id) => (id ? docItems(id) : [])))).flat().map((item) => item.batch_no)
  check('两市场并发自采入库：两单都成功，单号、批号互不相同(#345)',
    concurrentIds.every(Boolean) && concurrentIds[0] !== concurrentIds[1]
      && concurrentBatchNos.length === 2
      && concurrentBatchNos.every((batchNo, index) => batchNo === `${concurrentIds[index]}-01`)
      && concurrentBatchNos[0] !== concurrentBatchNos[1],
    JSON.stringify({ results: concurrentSelf.map((result) => result.status === 'fulfilled' ? result.value.id : String(result.reason?.message ?? result.reason)), batchNos: concurrentBatchNos }))
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

console.log('\n──────── 进销存调货 + 自采链冒烟报告 ────────')
for (const line of report) console.log(line)
console.log(`────────────────────────────────────\n${failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌'}`)
process.exit(failed === 0 ? 0 : 1)
