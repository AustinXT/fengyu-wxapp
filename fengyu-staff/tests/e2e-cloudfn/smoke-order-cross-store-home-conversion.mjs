#!/usr/bin/env bun
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_STORES_MULTI, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestOrg, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let passed = false
try {
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestOrg({ markets: ['A'], stores: ['A2'] })
  await createTestStaff()
  await createTestClient()
  const sourceStoreId = TEST_STORES_MULTI.A2.storeId
  const home = await createTestProduct({
    suffix: 'XHOME', productKind: '家居产品', productType: '家居产品',
    salesCategory: '他销他耗', price: 100, sessionCount: null,
  })
  const target = await createTestProduct({
    suffix: 'XTGT', productKind: '护理项目', productType: '疗程卡',
    salesCategory: '他销自耗', price: 50, sessionCount: 1,
  })
  const sourceOrderId = `${NS}_XHOME_SRC`
  const source = await createTestSaleOrder({
    saleOrderId: sourceOrderId, clientUserId: TEST_CLIENT_USER_ID,
    storeId: sourceStoreId, skuId: home.skuId, productName: home.specName,
    productType: '家居产品', quantity: 2, totalAmount: 200, status: '已支付',
    salesCategory: '他销他耗',
  })

  const candidates = await invokeStaffApi('order.customerHeldCards', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  const card = candidates.data?.cards?.find((item) => item.saleItemId === source.saleItemId)
  if (candidates.code !== 0 || !card || card.storeId !== sourceStoreId
    || Number(card.deductibleAmount) !== 200) {
    throw new Error('原店未提货家居产品未按 ¥200 进入现店转换候选')
  }

  const created = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [source.saleItemId],
    convertInItems: [{ skuId: target.skuId, quantity: 1 }],
    paymentMethod: '线下', remark: 'e2e-cross-store-home',
  })
  if (created.code !== 0 || Number(created.data.priceDiff) !== -150) {
    throw new Error(`跨店家居转换失败：${created.message}`)
  }
  const orderId = created.data.saleOrderId
  const orders = await pgQuery(
    `SELECT sale_order_id, store_id FROM sale_orders WHERE sale_order_id = ANY($1)`,
    [[sourceOrderId, orderId]],
  )
  if (orders.find((order) => order.sale_order_id === sourceOrderId)?.store_id !== sourceStoreId
    || orders.find((order) => order.sale_order_id === orderId)?.store_id !== TEST_STORE_ID) {
    throw new Error('原单或新转换单的门店归属错误')
  }
  const after = await pgQuery(
    `SELECT store_id, converted_quantity FROM sale_items WHERE sale_item_id = $1`,
    [source.saleItemId],
  )
  if (after[0]?.store_id !== sourceStoreId || Number(after[0]?.converted_quantity) !== 2) {
    throw new Error('原店家居来源行未按两件完成转换')
  }

  await pgQuery(`UPDATE sale_orders SET status = '待支付' WHERE sale_order_id = $1`, [orderId])
  const closed = await invokeStaffApi('order.close', {
    _testOpenid: TEST_MANAGER_OPENID, saleOrderId: orderId,
  })
  const restored = await pgQuery(
    `SELECT store_id, converted_quantity FROM sale_items WHERE sale_item_id = $1`,
    [source.saleItemId],
  )
  if (closed.code !== 0 || restored[0]?.store_id !== sourceStoreId
    || Number(restored[0]?.converted_quantity) !== 0) {
    throw new Error(`跨店家居转换关单回滚失败：${closed.message}`)
  }
  passed = true
  console.log('PASS — 跨店未提货家居：候选、折抵、原新单归属、关单回滚')
} catch (err) {
  console.error('FAIL —', err)
} finally {
  try { await cleanupTestData(NS) } catch (err) { console.error('cleanup failed:', err) }
  await closePool()
  process.exit(passed ? 0 : 1)
}
