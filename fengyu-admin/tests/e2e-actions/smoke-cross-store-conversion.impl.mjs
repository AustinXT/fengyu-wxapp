import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '../../..')
const staffTests = path.join(root, 'fengyu-staff/tests/e2e-cloudfn')
const setup = await import(path.join(staffTests, 'setup.mjs'))
const fixtures = await import(path.join(staffTests, 'helpers/fixtures.mjs'))
const {
  NS, TEST_STORE_ID, TEST_STORES_MULTI, TEST_CLIENT_USER_ID, pgQuery, closePool,
} = setup
const {
  ensureTestStore, createTestOrg, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData,
} = fixtures

let passed = false
try {
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestOrg({ markets: ['B'], stores: ['B1'] })
  await createTestStaff()
  await createTestClient()
  const sourceStoreId = TEST_STORES_MULTI.B1.storeId
  const home = await createTestProduct({
    suffix: 'ACONVHOME', productKind: '家居产品', productType: '家居产品',
    salesCategory: '他销他耗', price: 100, sessionCount: null,
  })
  const target = await createTestProduct({
    suffix: 'ACONVTGT', productKind: '护理项目', productType: '疗程卡',
    salesCategory: '他销自耗', price: 150, sessionCount: 1,
  })
  const sourceId = `${NS}_ACONV_SRC`
  const source = await createTestSaleOrder({
    saleOrderId: sourceId, clientUserId: TEST_CLIENT_USER_ID,
    storeId: sourceStoreId, skuId: home.skuId, productName: home.specName,
    productType: '家居产品', quantity: 1, totalAmount: 100, status: '已支付',
    salesCategory: '他销他耗',
  })
  const { getCustomerHeldCards } = await import(path.join(root, 'fengyu-admin/src/actions/cards.ts'))
  const { createConversionOrder, closeOrder } = await import(path.join(root, 'fengyu-admin/src/actions/orders.ts'))
  const cards = await getCustomerHeldCards(TEST_CLIENT_USER_ID, TEST_STORE_ID)
  const card = cards.find((row) => row.saleItemId === source.saleItemId)
  if (!card || card.storeId !== sourceStoreId || Number(card.deductibleAmount) !== 100) {
    throw new Error('admin 跨店候选未返回原店家居 ¥100')
  }
  const input = {
    storeId: TEST_STORE_ID, marketName: `${NS}_华东`, clientUserId: TEST_CLIENT_USER_ID,
    paymentMethod: '线下', convertOutSaleItemIds: [source.saleItemId],
    convertInItems: [{
      skuId: target.skuId, productName: target.specName, productType: '疗程卡',
      sessionCount: 1, unitPrice: '150', quantity: 1,
    }],
  }
  const created = await createConversionOrder(input)
  if (!created.success || Number(created.priceDiff) !== 50 || created.status !== '待支付') {
    throw new Error(`admin 跨店转换创建失败：${created.message}`)
  }
  const orders = await pgQuery(
    'SELECT sale_order_id, store_id FROM sale_orders WHERE sale_order_id = ANY($1)',
    [[sourceId, created.saleOrderId]],
  )
  const sourceRow = await pgQuery(
    'SELECT store_id, converted_quantity FROM sale_items WHERE sale_item_id = $1',
    [source.saleItemId],
  )
  const transferNet = await pgQuery(
    'SELECT COALESCE(SUM(received), 0) AS net FROM sale_items WHERE sale_order_id = $1',
    [created.saleOrderId],
  )
  if (orders.find((row) => row.sale_order_id === sourceId)?.store_id !== sourceStoreId
    || orders.find((row) => row.sale_order_id === created.saleOrderId)?.store_id !== TEST_STORE_ID
    || sourceRow[0]?.store_id !== sourceStoreId || Number(sourceRow[0]?.converted_quantity) !== 1
    || Number(transferNet[0]?.net) !== 0) {
    throw new Error(`admin 跨店转换归属/扣减/镜像净额错误：source=${sourceRow[0]?.store_id}/${sourceRow[0]?.converted_quantity} new=${orders.find((row) => row.sale_order_id === created.saleOrderId)?.store_id} net=${transferNet[0]?.net}`)
  }
  const closed = await closeOrder(created.saleOrderId)
  const restored = await pgQuery(
    'SELECT store_id, converted_quantity FROM sale_items WHERE sale_item_id = $1',
    [source.saleItemId],
  )
  if (!closed.success || restored[0]?.store_id !== sourceStoreId
    || Number(restored[0]?.converted_quantity) !== 0) {
    throw new Error(`admin 跨店转换关单回滚失败：${closed.message}`)
  }
  await pgQuery('UPDATE client_wechat_users SET bound_store_id = $1 WHERE user_id = $2',
    [sourceStoreId, TEST_CLIENT_USER_ID])
  const deniedCards = await getCustomerHeldCards(TEST_CLIENT_USER_ID, TEST_STORE_ID)
  const deniedCreate = await createConversionOrder(input)
  if (deniedCards.some((row) => row.saleItemId === source.saleItemId) || deniedCreate.success) {
    throw new Error('admin 未归属当前店顾客绕过候选或提交守卫')
  }
  passed = true
  console.log('PASS — admin 真实 PG 跨店候选、创建、当前店新单、原店扣减/回滚及归属拒绝')
} catch (err) {
  console.error('FAIL — admin 跨店转换', err)
} finally {
  try { await cleanupTestData(NS) } catch (err) { console.error('cleanup failed:', err) }
  await closePool()
  process.exit(passed ? 0 : 1)
}
