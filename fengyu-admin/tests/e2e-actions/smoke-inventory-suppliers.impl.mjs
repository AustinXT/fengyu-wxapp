/** #365 私有库供应商 action 正负例；通过 _inv-smoke-preload.mjs 只替换认证/Next 副作用。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closePool, pgQuery } from './setup.mjs'
import {
  ensureInventoryFixture, marketASession, marketBSession, supplyChainSession,
  MKA_ORG, MKB_ORG, SKU_SELF,
} from './helpers/inventory-fixtures.mjs'

// 必须显式用本单私有库，不能借 setup 的业务库回退。
const target = new URL(process.env.E2E_DATABASE_URL ?? '')
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
assert.equal(target.port, '54405')
assert.equal(target.pathname, '/verify_365')
assert.equal([...target.searchParams].length, 0)
let checks = 0
function checked(name, fn) { fn(); checks++; console.log(`PASS #365 ${name}`) }
function session(value) { globalThis.__INV_SESSION = value }
try {
  await ensureInventoryFixture()
  const suppliers = await import('../../src/actions/inventory/suppliers.ts')
  const skus = await import('../../src/actions/inventory/skus.ts')
  const business = await import('../../src/actions/inventory/business.ts')
  const runId = randomUUID()
  const sameName = `TE2AI_365_${runId}_同名供应商`
  const renamedName = `TE2AI_365_${runId}_改名`
  session(supplyChainSession())
  const shared = await suppliers.createInventorySupplier({ name: sameName })
  session(marketASession())
  const ownA = await suppliers.createInventorySupplier({ name: sameName })
  session(marketBSession())
  const ownB = await suppliers.createInventorySupplier({ name: sameName })
  const stored = await pgQuery('SELECT supplier_id,owner_market_id FROM inventory_suppliers WHERE name=$1', [sameName])
  checked('共有/A/B 同名落库且归属正确', () => {
    assert.equal(stored.find((s) => s.supplier_id === shared.supplierId).owner_market_id, null)
    assert.equal(stored.find((s) => s.supplier_id === ownA.supplierId).owner_market_id, MKA_ORG)
    assert.equal(stored.find((s) => s.supplier_id === ownB.supplierId).owner_market_id, MKB_ORG)
  })
  for (const [account, expected] of [
    [supplyChainSession(), [shared.supplierId]],
    [marketASession(), [shared.supplierId, ownA.supplierId]],
    [marketBSession(), [shared.supplierId, ownB.supplierId]],
  ]) {
    session(account)
    const list = await suppliers.listInventorySuppliers({ keyword: sameName, pageSize: 20 })
    checked(`列表范围 ${account.name}`, () => {
      assert.deepEqual(list.data.map((s) => s.supplierId).sort(), expected.sort())
      assert.equal(list.total, expected.length)
    })
    const options = await suppliers.listInventorySupplierOptions()
    checked(`选项范围/后缀 ${account.name}`, () => {
      assert.deepEqual(options.filter((s) => [shared.supplierId, ownA.supplierId, ownB.supplierId].includes(s.supplierId)).map((s) => s.supplierId).sort(), expected.sort())
      assert.ok(options.find((s) => s.supplierId === shared.supplierId).name.endsWith('（供应链共有）'))
      if (expected.includes(ownA.supplierId)) assert.ok(options.find((s) => s.supplierId === ownA.supplierId).name.endsWith('（TE2AI_市场A）'))
      if (expected.includes(ownB.supplierId)) assert.ok(options.find((s) => s.supplierId === ownB.supplierId).name.endsWith('（TE2AI_市场B）'))
    })
  }
  session(marketASession())
  await assert.rejects(suppliers.createInventorySupplier({ name: '跨市场', ownerMarketId: MKB_ORG }), /PERMISSION_DENIED/); checks++
  await assert.rejects(suppliers.updateInventorySupplier(shared.supplierId, { name: '越权共有' }), /NOT_FOUND/); checks++
  await assert.rejects(suppliers.updateInventorySupplier(ownB.supplierId, { name: '越权B' }), /NOT_FOUND/); checks++
  await assert.rejects(suppliers.countInventorySkusBySupplier(ownB.supplierId), /NOT_FOUND/); checks++
  await assert.rejects(suppliers.createInventorySupplier({ name: sameName }), /CONFLICT/); checks++
  await assert.rejects(suppliers.updateInventorySupplier(ownA.supplierId, { ownerMarketId: MKB_ORG }), /PERMISSION_DENIED/); checks++
  await suppliers.updateInventorySupplier(ownA.supplierId, { phone: '00000000000' }); checks++
  await assert.rejects(skus.createInventorySku({
    productName: '跨市场关联', sourceType: '市场自采', ownerMarketId: MKA_ORG, supplierId: ownB.supplierId,
  }), /NOT_FOUND/); checks++
  await skus.updateInventorySku(SKU_SELF, { supplierId: ownA.supplierId }); checks++
  const { id } = await business.createSelfPurchasedReceipt({
    marketId: MKA_ORG, supplierId: null, items: [{ skuId: SKU_SELF, quantity: 2, marketActualUnitPrice: 30 }],
  })
  const [head] = await pgQuery('SELECT supplier_id,supplier_name,status,total_quantity,total_amount FROM inventory_docs WHERE id=$1', [id])
  const [item] = await pgQuery('SELECT supplier_id,supplier,lot_id FROM inventory_doc_items WHERE doc_id=$1', [id])
  const [lot] = await pgQuery('SELECT supplier_id,supplier,quantity_on_hand FROM inventory_stock_lots WHERE id=$1', [item.lot_id])
  checked('无供应商入库完成，单头/明细/批次为 NULL', () => {
    assert.equal(head.status, '已完成')
    assert.equal(Number(head.total_quantity), 2)
    assert.equal(Number(head.total_amount), 60)
    assert.equal(Number(lot.quantity_on_hand), 2)
    for (const row of [head, item, lot]) assert.equal(row.supplier_id, null)
    assert.equal(head.supplier_name, null)
    assert.equal(item.supplier, null)
    assert.equal(lot.supplier, null)
  })
  await assert.rejects(business.createSelfPurchasedReceipt({
    marketId: MKA_ORG, supplierId: ownB.supplierId, items: [{ skuId: SKU_SELF, quantity: 1 }],
  }), /NOT_FOUND/); checks++
  const selected = await business.createSelfPurchasedReceipt({
    marketId: MKA_ORG, supplierId: ownA.supplierId, items: [{ skuId: SKU_SELF, quantity: 1 }],
  })
  await suppliers.updateInventorySupplier(ownA.supplierId, { name: renamedName })
  const [renamedSku] = await pgQuery('SELECT supplier FROM inventory_skus WHERE sku_id=$1', [SKU_SELF])
  const [frozen] = await pgQuery('SELECT supplier_name FROM inventory_docs WHERE id=$1', [selected.id])
  const [frozenItem] = await pgQuery('SELECT supplier,supplier_id FROM inventory_doc_items WHERE doc_id=$1', [selected.id])
  checked('改名更新 SKU 主数据，历史入库快照不重写', () => {
    assert.equal(renamedSku.supplier, renamedName)
    assert.equal(frozen.supplier_name, sameName)
    assert.equal(frozenItem.supplier, sameName)
    assert.equal(frozenItem.supplier_id, ownA.supplierId)
  })
  const wrongSupply = marketASession()
  const supplyAction = 'inventory:supply_chain_master_data_manage'
  wrongSupply.permissions.actions = [supplyAction]
  wrongSupply.roles.forEach((role) => { role.actions = [supplyAction] })
  session(wrongSupply)
  await assert.rejects(suppliers.createInventorySupplier({ name: `TE2AI_365_${runId}_误授` }), /PERMISSION_DENIED/); checks++
  await assert.rejects(suppliers.updateInventorySupplier(shared.supplierId, { name: '误改共有' }), /NOT_FOUND/); checks++
  session(supplyChainSession())
  await assert.rejects(suppliers.updateInventorySupplier(ownA.supplierId, { phone: '111' }), /NOT_FOUND/); checks++
  console.log(`#365 private action smoke passed: ${checks} checks`)
} finally {
  await closePool()
  await globalThis.pgClient?.end({ timeout: 3 })
}
