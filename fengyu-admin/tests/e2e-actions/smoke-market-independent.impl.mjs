import assert from 'node:assert/strict'
import { closePool, pgQuery } from './setup.mjs'
import { HQ_ORG, MKA_ORG, MKB_ORG, SKU_SUPPLY, SKU_SELF, STA1_ID,
  ensureInventoryFixture, docHeader, docItems, marketASession,
  marketBSession, storeA1Session, supplyChainSession } from './helpers/inventory-fixtures.mjs'
const session = (value) => { globalThis.__INV_SESSION = value }
const biz = await import('../../src/actions/inventory/business.ts')
const docs = await import('../../src/actions/inventory/docs.ts')
const settlements = await import('../../src/actions/inventory/settlements.ts')
const input = { marketId: MKA_ORG, supplyChainLocationId: HQ_ORG }
const line = { skuId: SKU_SUPPLY, purchaseQuantity: 6, sourceRequestItemIds: [] }
const payable = async () => (await settlements.listInventorySettlements({})).marketRows.reduce((sum, row) => sum + row.payableAmount, 0)
try {
  await ensureInventoryFixture()
  assert.equal((await pgQuery("SELECT COUNT(*)::int AS n FROM inventory_docs WHERE doc_type='门店报货'"))[0].n, 0)
  session(storeA1Session())
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [line] }), /PERMISSION_DENIED/)
  session(marketBSession())
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [line] }), /PERMISSION_DENIED/)
  session(marketASession())
  for (const quantity of [0, -1, 0.001, 10000000000]) {
    await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [{ ...line, purchaseQuantity: quantity }] }), /INVALID_PARAMS/)
  }
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [line, line] }), /商品不能重复/)
  await pgQuery('UPDATE inventory_skus SET is_reportable=false WHERE sku_id=$1', [SKU_SUPPLY])
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [line] }), /NOT_FOUND/)
  await assert.rejects(() => biz.saveMarketReplenishmentDraft({ ...input, items: [line] }), /NOT_FOUND/)
  await pgQuery('UPDATE inventory_skus SET is_reportable=true WHERE sku_id=$1', [SKU_SUPPLY])
  await pgQuery('UPDATE inventory_skus SET owner_market_id=$2 WHERE sku_id=$1', [SKU_SELF, MKB_ORG])
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, items: [{ ...line, skuId: SKU_SELF }] }), /INVALID_STATE/)
  await pgQuery('UPDATE inventory_skus SET owner_market_id=$2 WHERE sku_id=$1', [SKU_SELF, MKA_ORG])
  const draftInput = { ...input, items: [{ skuId: SKU_SUPPLY, purchaseQuantity: 5, independent: true }] }
  const before = await payable()
  const draft = await biz.saveMarketReplenishmentDraft(draftInput)
  assert.equal(Number((await docItems(draft.id))[0].request_quantity), 0)
  assert.equal(await payable(), before)
  session(supplyChainSession())
  const pending = await biz.summarizeMarketReplenishmentRequests({ supplyChainLocationId: HQ_ORG })
  assert.equal(pending.items.length, 0)
  session(marketASession())
  const edited = await biz.saveMarketReplenishmentDraft({ ...draftInput, draftId: draft.id, expectedUpdatedAt: draft.updatedAt, items: [{ skuId: SKU_SUPPLY, purchaseQuantity: 6, independent: true }] })
  await assert.rejects(() => biz.createMarketReplenishment({ ...input, draftId: draft.id, expectedUpdatedAt: draft.updatedAt, items: [line] }), /CONFLICT/)
  const report = await biz.createMarketReplenishment({ ...input, draftId: draft.id, expectedUpdatedAt: edited.updatedAt,
    items: [{ ...line, actualUnitPrice: 1, marketUnitDiscount: 9999 }] })
  assert.equal(report.id, draft.id)
  const [reportItem] = await docItems(report.id)
  assert.equal((await docHeader(report.id)).status, '已完成')
  assert.equal(Number(reportItem.actual_unit_price), 950)
  assert.equal(Number(reportItem.request_quantity), 0)
  assert.equal((await pgQuery('SELECT COUNT(*)::int AS n FROM inventory_doc_links WHERE to_doc_id=$1', [report.id]))[0].n, 0)
  const detail = await docs.getInventoryCoreDocById(report.id)
  assert.ok(detail)
  assert.equal(detail.lineage.length, 0)
  const drop = await biz.saveMarketReplenishmentDraft(draftInput)
  await biz.deleteMarketReplenishmentDraft({ draftId: drop.id })
  assert.equal((await docHeader(drop.id)).status, '已取消')
  console.log('PASS 独立报货/草稿编辑删除提交/权限隔离/服务端价格/无门店血缘')

  // 独立报货不占用后来创建的门店需求，在途仍可覆盖建议采购。
  session(storeA1Session())
  const request = await biz.createStoreReplenishmentRequest({ storeId: STA1_ID, marketId: MKA_ORG, items: [{ skuId: SKU_SUPPLY, quantity: 8 }] })
  const [requestItem] = await docItems(request.id)
  session(marketASession())
  const summary = await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG })
  const demand = summary.items.find((item) => item.skuId === SKU_SUPPLY)
  assert.ok(demand.requestItemIds.map(Number).includes(Number(requestItem.id)))
  assert.equal(demand.inTransitQuantity, 6)
  assert.equal(demand.suggestedPurchaseQuantity, 2)
  assert.equal(Number((await docItems(request.id))[0].fulfilled_quantity), 0)
  session(supplyChainSession())
  const supplySummary = await biz.summarizeMarketReplenishmentRequests({ supplyChainLocationId: HQ_ORG })
  assert.ok(supplySummary.items.some((item) => item.requestItemIds.map(Number).includes(Number(reportItem.id))))
  const merged = await biz.createMarketReportSummary({ supplyChainLocationId: HQ_ORG,
    items: [{ skuId: SKU_SUPPLY, marketId: MKA_ORG, quantity: 6, sourceReportItemIds: [reportItem.id] }] })
  const [mergedItem] = await docItems(merged.id)
  const purchase = await biz.createPurchaseOrder({ supplyChainLocationId: HQ_ORG, items: [{ sourceItemId: mergedItem.id, quantity: 6 }] })
  assert.equal((await docHeader(purchase.id)).status, '待收货')
  const [purchaseItem] = await docItems(purchase.id)
  await biz.receiveSupplyChainPurchaseOrder({ purchaseOrderId: purchase.id, supplyChainLocationId: HQ_ORG,
    items: [{ purchaseOrderItemId: purchaseItem.id, quantity: 6, batchNo: 'I531' }] })
  const [lot] = await pgQuery('SELECT id FROM inventory_stock_lots WHERE location_id=$1 AND sku_id=$2 AND batch_no=$3', [HQ_ORG, SKU_SUPPLY, 'I531'])
  const shipment = await biz.createItemCompanyShipment({ marketId: MKA_ORG, sourceOrgNodeId: HQ_ORG,
    items: [{ reportItemId: reportItem.id, lotId: Number(lot.id), quantity: 6 }] })
  const [shipmentItem] = await docItems(shipment.id)
  session(marketASession())
  await biz.receiveItemCompanyShipment({ shipmentId: shipment.id,
    items: [{ shipmentItemId: shipmentItem.id, receivedQuantity: 6 }] })
  assert.equal((await docHeader(shipment.id)).status, '已完成')
  assert.equal(await payable() - before, 5700)
  const afterDemand = (await biz.summarizeStoreReplenishmentRequests({ marketId: MKA_ORG })).items.find((item) => item.skuId === SKU_SUPPLY)
  assert.equal(afterDemand.inTransitQuantity, 0)
  assert.equal(afterDemand.availableQuantity, 6)
  assert.equal(afterDemand.suggestedPurchaseQuantity, 2)
  console.log('PASS 独立报货→汇总→采购→总部入库→发货→市场收货→结算/在途核销')

  // 提取原流程保持：只占用实际采购量，且正常写门店血缘。
  const extracted = await biz.createMarketReplenishment({ ...input,
    items: [{ skuId: SKU_SUPPLY, purchaseQuantity: 2, sourceRequestItemIds: [requestItem.id] }] })
  const links = await pgQuery("SELECT quantity FROM inventory_doc_links WHERE to_doc_id=$1 AND relation_type='门店报货汇总'", [extracted.id])
  assert.equal(links.length, 1)
  assert.equal(Number(links[0].quantity), 2)
  await assert.rejects(() => biz.createMarketReplenishment({ ...input,
    items: [{ skuId: SKU_SELF, purchaseQuantity: 1, sourceRequestItemIds: [requestItem.id] }] }), /INVALID_STATE/)
  console.log('PASS 原提取流程血缘与来源校验')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally { await closePool() }
process.exit(process.exitCode ?? 0)
