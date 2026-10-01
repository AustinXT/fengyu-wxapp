#!/usr/bin/env bun
/** #182 专项 L2：必须显式连本机私有PG；沿用fixtures/真实action，不部署。
 * PG_CONNECTION_STRING=postgresql://postgres:test@127.0.0.1:54406/issue182 bun <本文件>
 */
import './setup.mjs'
import assert from 'node:assert/strict'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool } from './setup.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestProduct, createTestSaleOrder, cleanupTestData } from './helpers/fixtures.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'

const url = new URL(process.env.PG_CONNECTION_STRING)
assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '54406', '#182专项只能运行在54406私有库')
const auth = { _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID }
const call = async (action, payload) => {
  const result = await invokeStaffApi(action, { ...auth, ...payload })
  assert.equal(result.code, 0, `${action}: ${result.message}`)
  return result.data
}
let serial = 0
async function source(sku, { received, amount, remaining, quantity = 1, home = false }) {
  const saleOrderId = `${NS}_182_${++serial}`
  const row = await createTestSaleOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID,
    skuId: sku.skuId, productName: sku.specName, productType: home ? '家居产品' : '疗程卡',
    quantity, sessionCount: home ? null : 7, totalAmount: amount, status: '已支付', salesCategory: '自销自耗' })
  await pgQuery(`UPDATE sale_orders SET received=$2, status=$3 WHERE sale_order_id=$1`, [saleOrderId, received, received < amount ? '部分支付' : '已支付'])
  await pgQuery(`UPDATE sale_items SET received=$2, pending_received=0, remaining_sessions=$3,
    paid_sessions=CASE WHEN session_count IS NULL THEN NULL ELSE LEAST(session_count,FLOOR($2::numeric*session_count/sale_amount)::int) END WHERE sale_item_id=$1`,
    [row.saleItemId, received, remaining])
  return { ...row, saleOrderId }
}
async function main() {
  await cleanupTestData(NS)
  await ensureTestStore(); await createTestStaff(); await createTestClient()
  const card = await createTestProduct({ suffix: '182CARD', productType: '疗程卡', productKind: '护理项目', price: 398, sessionCount: 7, salesCategory: '自销自耗' })
  const home = await createTestProduct({ suffix: '182HOME', productType: '家居产品', productKind: '家居产品', price: 680, salesCategory: '自销自耗' })
  const target = await createTestProduct({ suffix: '182TARGET', productType: '疗程卡', productKind: '护理项目', price: 4000, sessionCount: 1, salesCategory: '自销自耗' })
  // 三维候选矩阵：从真实enum取所有订单类型，合法状态与已审批退款的正负例。
  const [{ types }] = await pgQuery('SELECT enum_range(NULL::sale_order_type)::text[] AS types')
  const states = ['已支付', '部分支付', '已完成', '待支付', '已关闭']
  let cases = 0
  for (const type of types) for (const status of states) for (const approved of [false, true]) {
    const row = await source(card, { amount: 2786, received: 3000, remaining: 0 })
    await pgQuery(`UPDATE sale_orders SET sale_order_type=$2, status=$3 WHERE sale_order_id=$1`, [row.saleOrderId, type, status])
    if (approved) await pgQuery(`INSERT INTO sale_order_payments(sale_order_id,change_type,status,amount,payment_method,source_end) VALUES($1,'退款','已支付',-1,'线下','staff')`, [row.saleOrderId])
    const candidates = await call('order.customerHeldCards', {})
    const included = candidates.cards.some(c => c.saleItemId === row.saleItemId)
    const expected = ['已支付','部分支付','已完成'].includes(status) && type !== '寄存单' && !approved
    assert.equal(included, expected, `${type}/${status}/approved=${approved}`)
    cases++
  }
  console.log(`PASS 三维候选矩阵 ${cases} 组合（type×status×approved refund）`)
  // overpay权益0 + 不足一件混选：实际转出金额/数量、毛额钉住、欠款归零、退款互斥。
  const a = await source(card, { amount: 2786, received: 3000, remaining: 0 })
  const b = await source(home, { amount: 680, received: 594, remaining: null, home: true })
  const candidates = await call('order.customerHeldCards', {})
  assert.equal(candidates.cards.find(c => c.saleItemId === a.saleItemId).deductibleAmount, '214.00')
  assert.equal(candidates.cards.find(c => c.saleItemId === b.saleItemId).deductibleAmount, '594.00')
  const converted = await call('order.createConversion', { convertOutSaleItemIds: [a.saleItemId, b.saleItemId], convertInItems: [{ skuId: target.skuId, quantity: 1 }], paymentMethod: '线下' })
  assert.equal(Number(converted.totalOut), 808); assert.equal(Number(converted.priceDiff), 3192)
  const outs = await pgQuery(`SELECT ref_sale_item_id,quantity,received FROM sale_items WHERE sale_order_id=$1 AND item_direction='转出'`, [converted.saleOrderId])
  assert.equal(Number(outs.find(r => r.ref_sale_item_id === a.saleItemId).quantity), 0)
  assert.equal(Number(outs.find(r => r.ref_sale_item_id === b.saleItemId).quantity), 1)
  const detail = await call('order.detail', { saleOrderId: converted.saleOrderId })
  assert.equal(Number(detail.items.find(r=>r.ref_sale_item_id===a.saleItemId).quantity),0)
  assert.equal(Number(detail.items.find(r=>r.ref_sale_item_id===b.saleItemId).quantity),1)
  const folded = await pgQuery(`SELECT sale_item_id,sale_amount,pending_received,converted_quantity,paid_sessions FROM sale_items WHERE sale_item_id=ANY($1::text[])`, [[a.saleItemId,b.saleItemId]])
  assert.equal(Number(folded.find(r=>r.sale_item_id===a.saleItemId).pending_received),3000)
  assert.equal(Number(folded.find(r=>r.sale_item_id===b.saleItemId).sale_amount),594)
  const { computeItemOverpayRemainders } = await import('../../cloudfunctions/staffApi/utils/refund.js')
  const paid = await pgQuery(`SELECT si.*, COALESCE((SELECT SUM(GREATEST(0,-o.received)) FROM sale_items o JOIN sale_orders so ON so.sale_order_id=o.sale_order_id WHERE o.ref_sale_item_id=si.sale_item_id AND o.item_direction='转出' AND so.status<>'已关闭'),0) AS converted_amount,
    (SELECT COALESCE(SUM(pickup_quantity),0) FROM pickup_records p WHERE p.sale_item_id=si.sale_item_id) AS picked_quantity FROM sale_items si WHERE si.sale_item_id=ANY($1::text[])`, [[a.saleItemId,b.saleItemId]])
  for (const amount of computeItemOverpayRemainders(paid).values()) assert.equal(amount,0)
  const after = await call('order.customerHeldCards', {})
  assert(!after.cards.some(c=>[a.saleItemId,b.saleItemId].includes(c.saleItemId)))
  const pickup = await call('order.availablePickupItems', {})
  assert(!(pickup.items || []).some(c=>c.saleItemId===b.saleItemId))
  await call('order.close', { saleOrderId: converted.saleOrderId })
  const restored = await pgQuery(`SELECT sale_item_id,sale_amount,pending_received,converted_quantity FROM sale_items WHERE sale_item_id=ANY($1::text[])`, [[a.saleItemId,b.saleItemId]])
  assert.equal(Number(restored.find(r=>r.sale_item_id===a.saleItemId).pending_received),0)
  assert.equal(Number(restored.find(r=>r.sale_item_id===b.saleItemId).pending_received),0)
  assert.equal(Number(restored.find(r=>r.sale_item_id===b.saleItemId).sale_amount),680)
  assert.equal(Number(restored.find(r=>r.sale_item_id===b.saleItemId).converted_quantity),0)
  console.log('PASS 混选金额808/数量0+1/退款互斥/候选与提货退出/Δ=0及有欠款关单回滚')
  // 并发同一余数：真实事务锁后重读，只能一个转换成功。
  const c = await source(card, { amount:2786, received:3000, remaining:0 })
  const payload = { ...auth, convertOutSaleItemIds:[c.saleItemId], convertInItems:[{skuId:target.skuId,quantity:1}], paymentMethod:'线下' }
  const concurrent = await Promise.all([invokeStaffApi('order.createConversion',payload),invokeStaffApi('order.createConversion',payload)])
  assert.equal(concurrent.filter(r=>r.code===0).length,1,JSON.stringify(concurrent))
  await call('order.close',{saleOrderId:concurrent.find(r=>r.code===0).data.saleOrderId})
  console.log('PASS 并发同一214余数仅一笔成功')
  const gift = await source(home,{amount:0,received:0,remaining:null,home:true})
  const giftConversion = await call('order.createConversion',{convertOutSaleItemIds:[gift.saleItemId],convertInItems:[{skuId:target.skuId,quantity:1}],paymentMethod:'线下'})
  await call('order.close',{saleOrderId:giftConversion.saleOrderId})
  console.log('PASS 0元赠品转出关单不要求正金额源行重算')

}
try { await main() } finally {
  await cleanupTestData(NS); await closePool()
}
