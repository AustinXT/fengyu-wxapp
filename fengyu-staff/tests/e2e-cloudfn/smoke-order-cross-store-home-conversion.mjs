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
  const localOrderId = `${NS}_XHOME_LOCAL`
  const local = await createTestSaleOrder({
    saleOrderId: localOrderId, clientUserId: TEST_CLIENT_USER_ID,
    storeId: TEST_STORE_ID, skuId: home.skuId, productName: home.specName,
    productType: '家居产品', quantity: 1, totalAmount: 100, status: '已支付',
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
  if (!candidates.data?.cards?.some((item) => item.saleItemId === local.saleItemId
    && item.storeId === TEST_STORE_ID)) {
    throw new Error('本店权益未与跨店权益同时进入转换候选')
  }

  const created = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [source.saleItemId, local.saleItemId],
    convertInItems: [{ skuId: target.skuId, quantity: 1 }],
    paymentMethod: '线下', remark: 'e2e-cross-store-home',
  })
  if (created.code !== 0 || Number(created.data.priceDiff) !== -250) {
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
  const localAfter = await pgQuery(
    `SELECT store_id, converted_quantity FROM sale_items WHERE sale_item_id = $1`,
    [local.saleItemId],
  )
  if (localAfter[0]?.store_id !== TEST_STORE_ID || Number(localAfter[0]?.converted_quantity) !== 1) {
    throw new Error('本店权益与跨店权益混选后未正确扣减')
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
  const localRestored = await pgQuery(
    `SELECT converted_quantity FROM sale_items WHERE sale_item_id = $1`, [local.saleItemId])
  if (Number(localRestored[0]?.converted_quantity) !== 0) {
    throw new Error('混选转换关单后本店权益未恢复')
  }

  // 仅付 ¥50、未达单件 ¥100 的权益仍要按已付余额折抵。
  const partialOrderId = `${NS}_XHOME_PART`
  const partial = await createTestSaleOrder({
    saleOrderId: partialOrderId, clientUserId: TEST_CLIENT_USER_ID,
    storeId: sourceStoreId, skuId: home.skuId, productName: home.specName,
    productType: '家居产品', quantity: 1, totalAmount: 100, status: '部分支付',
    salesCategory: '他销他耗',
  })
  await pgQuery(`UPDATE sale_items SET received = 50 WHERE sale_item_id = $1`, [partial.saleItemId])
  await pgQuery(`UPDATE sale_orders SET received = 50 WHERE sale_order_id = $1`, [partialOrderId])
  await pgQuery(
    `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at)
     VALUES ($1, '首次支付', 50, '线下', '已支付', 'staff', NOW(), NOW())`,
    [partialOrderId],
  )
  const partialCandidates = await invokeStaffApi('order.customerHeldCards', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
  })
  const partialCard = partialCandidates.data?.cards?.find((item) => item.saleItemId === partial.saleItemId)
  if (partialCandidates.code !== 0 || Number(partialCard?.deductibleAmount) !== 50) {
    throw new Error('不足一件单价的原店已付 ¥50 未进入折抵候选')
  }
  const partialConversion = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [partial.saleItemId],
    convertInItems: [{ skuId: target.skuId, quantity: 1 }],
    paymentMethod: '线下', remark: 'e2e-cross-store-subunit',
  })
  if (partialConversion.code !== 0 || Number(partialConversion.data.priceDiff) !== 0) {
    throw new Error(`不足单件单价的已付余额转换失败：${partialConversion.message}`)
  }
  passed = true
  console.log('PASS — 跨店未提货家居：本店混选、原新单归属、关单回滚、不足单价的已付余额')
} catch (err) {
  console.error('FAIL —', err)
} finally {
  try { await cleanupTestData(NS) } catch (err) { console.error('cleanup failed:', err) }
  await closePool()
  process.exit(passed ? 0 : 1)
}
