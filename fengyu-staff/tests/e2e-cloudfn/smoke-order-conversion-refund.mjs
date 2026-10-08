#!/usr/bin/env bun
// #548：真实action入口、审批CAS、旧资产/新增现金分离与退款后补款。
import './setup.mjs'
import assert from 'node:assert/strict'
import { NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestOrg, createTestStaff, createTestClient, createTestProduct, createTestSaleOrder, createPaidPayment, cleanupTestData } from './helpers/fixtures.mjs'
const auth={_testOpenid:TEST_MANAGER_OPENID}
async function call(action,payload){const r=await invokeStaffApi(action,{...auth,...payload});assert.equal(r.code,0,`${action}: ${r.message}`);return r.data}
async function scenario(suffix,{cash=200,two=false,old=800}={}){
  const sourceSku=await createTestProduct({suffix:`${suffix}SRC`,productKind:'护理项目',productType:'疗程卡',salesCategory:'他销自耗',price:old,sessionCount:1})
  const targetSku=await createTestProduct({suffix:`${suffix}TGT`,productKind:'护理项目',productType:'疗程卡',salesCategory:'他销自耗',price:two?500:old+cash,sessionCount:two?10:1})
  const id=`${NS}_548_${suffix}`
  const source=await createTestSaleOrder({saleOrderId:id,clientUserId:TEST_CLIENT_USER_ID,skuId:sourceSku.skuId,totalAmount:old,sessionCount:1,status:'已支付',salesCategory:'他销自耗'})
  await pgQuery('UPDATE sale_orders SET received=$2 WHERE sale_order_id=$1',[id,old])
  await createPaidPayment(id,{amount:old,items:[{saleItemId:source.saleItemId,amount:old,salesCategory:'他销自耗'}]})
  const conv=await call('order.createConversion',{clientUserId:TEST_CLIENT_USER_ID,convertOutSaleItemIds:[source.saleItemId],convertInItems:[{skuId:targetSku.skuId,quantity:two?2:1}],paymentMethod:'线下',receivedAmount:cash})
  await call('order.confirmOffline',{saleOrderId:conv.saleOrderId,confirmAmount:cash})
  const items=await pgQuery("SELECT * FROM sale_items WHERE sale_order_id=$1 AND item_direction='转入' ORDER BY sale_item_id",[conv.saleOrderId])
  return {orderId:conv.saleOrderId,source,items}
}
async function apply(orderId,itemId){return call('order.createRefund',{refSaleOrderId:orderId,items:[{saleItemId:itemId}],refundReason:'逐项退款'})}
async function main(){
  await cleanupTestData(NS);await ensureTestStore();await createTestOrg({markets:['A'],stores:['A2']});await createTestStaff();await createTestClient()
  const one=await scenario('FULL')
  assert.equal(Number(one.items[0].received),1000)
  const invalid=await invokeStaffApi('order.createRefund',{...auth,refSaleOrderId:one.orderId,items:[{saleItemId:one.source.saleItemId}],refundReason:'跨单'})
  assert.notEqual(invalid.code,0)
  const first=await apply(one.orderId,one.items[0].sale_item_id)
  assert.equal(first.finalRefundAmount,1000)
  const results=await Promise.all([invokeStaffApi('order.approveRefund',{...auth,paymentId:first.paymentId}),invokeStaffApi('order.approveRefund',{...auth,paymentId:first.paymentId})])
  assert.equal(results.filter(r=>r.code===0).length,1,'并发重复审批只生效一次')
  const final=(await pgQuery('SELECT * FROM sale_orders WHERE sale_order_id=$1',[one.orderId]))[0]
  assert.equal(final.status,'已退款');assert.equal(Number(final.refunded_amount),1000);assert.equal(Number(final.received),200)
  assert.equal((await pgQuery('SELECT remaining_sessions FROM sale_items WHERE sale_item_id=$1',[one.source.saleItemId]))[0].remaining_sessions,0)
  const mixed=await scenario('PART',{cash:100,two:true})
  const [a,b]=mixed.items
  const pending=await apply(mixed.orderId,a.sale_item_id)
  await call('order.rejectRefund',{paymentId:pending.paymentId,auditRemark:'驳回测试'})
  assert.equal(Number((await pgQuery('SELECT received FROM sale_items WHERE sale_item_id=$1',[a.sale_item_id]))[0].received),450)
  const refund=await apply(mixed.orderId,a.sale_item_id)
  await call('order.approveRefund',{paymentId:refund.paymentId})
  assert.equal(Number((await pgQuery('SELECT received FROM sale_items WHERE sale_item_id=$1',[b.sale_item_id]))[0].received),450)
  const detail=await call('order.detail',{saleOrderId:mixed.orderId})
  assert.equal(Number(detail.order.conversion_remaining_payable),50,'未退B只欠50')
  await call('order.createRepayment',{refSaleOrderId:mixed.orderId,repayAmount:50,paymentMethod:'线下'})
  const after=await pgQuery("SELECT * FROM sale_items WHERE sale_order_id=$1 AND item_direction='转入' ORDER BY sale_item_id",[mixed.orderId])
  assert.equal(after[0].paid_sessions,0);assert.equal(Number(after[1].received),500)
  const last=await apply(mixed.orderId,b.sale_item_id);await call('order.approveRefund',{paymentId:last.paymentId})
  assert.equal((await pgQuery('SELECT status FROM sale_orders WHERE sale_order_id=$1',[mixed.orderId]))[0].status,'已退款')
  const tier = await scenario('TIER', {old:5000,cash:1000})
  assert.equal((await pgQuery('SELECT spending_tier FROM client_wechat_users WHERE user_id=$1',[TEST_CLIENT_USER_ID]))[0].spending_tier,'1990-1W')
  const tierRefund = await apply(tier.orderId,tier.items[0].sale_item_id)
  assert.equal(tierRefund.finalRefundAmount,6000)
  await call('order.approveRefund',{paymentId:tierRefund.paymentId})
  assert.equal((await pgQuery('SELECT spending_tier FROM client_wechat_users WHERE user_id=$1',[TEST_CLIENT_USER_ID]))[0].spending_tier,'<1990','退款态转换负额必须参与实时消费档位')
  console.log('PASS #548 1000元退款、逐项/驳回/并发审批/后续补款/源权益不恢复')
}
try{await main()}finally{await cleanupTestData(NS);await closePool()}
