#!/usr/bin/env bun
// #548：真实action入口、审批CAS、旧资产/新增现金分离与退款后补款。
import './setup.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const cloudRequire = createRequire(import.meta.url)
const pg = cloudRequire(`${REPO_ROOT}/fengyu-staff/cloudfunctions/staffApi/db/pg.js`)
const { settlePointsForOrder } = cloudRequire(`${REPO_ROOT}/fengyu-staff/cloudfunctions/staffApi/utils/points.js`)
import { REPO_ROOT, NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool } from './setup.mjs'
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
  await pg.transaction(c=>settlePointsForOrder(c,id))
  const conv=await call('order.createConversion',{clientUserId:TEST_CLIENT_USER_ID,convertOutSaleItemIds:[source.saleItemId],convertInItems:[{skuId:targetSku.skuId,quantity:two?2:1}],paymentMethod:'线下',receivedAmount:cash})
  if(cash>0) await call('order.confirmOffline',{saleOrderId:conv.saleOrderId,confirmAmount:cash})
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
  const originalPoints=await pgQuery('SELECT * FROM point_transactions WHERE ref_order_id=$1',[one.source.saleOrderId || `${NS}_548_FULL`])
  const first=await apply(one.orderId,one.items[0].sale_item_id)
  assert.equal(first.finalRefundAmount,1000)
  const results=await Promise.all([invokeStaffApi('order.approveRefund',{...auth,paymentId:first.paymentId}),invokeStaffApi('order.approveRefund',{...auth,paymentId:first.paymentId})])
  assert.equal(results.filter(r=>r.code===0).length,1,'并发重复审批只生效一次')
  const final=(await pgQuery('SELECT * FROM sale_orders WHERE sale_order_id=$1',[one.orderId]))[0]
  assert.equal(final.status,'已退款');assert.equal(Number(final.refunded_amount),1000);assert.equal(Number(final.received),200)
  assert.equal((await pgQuery('SELECT remaining_sessions FROM sale_items WHERE sale_item_id=$1',[one.source.saleItemId]))[0].remaining_sessions,0)
  assert.deepEqual(await pgQuery('SELECT * FROM point_transactions WHERE ref_order_id=$1',[`${NS}_548_FULL`]),originalPoints,'旧积分流水不因转换退款改变')
  assert.equal(Number((await pgQuery("SELECT amount FROM point_transactions WHERE ref_order_id=$1 AND type='消费冲销'",[one.orderId]))[0].amount),-10,'旧8+补款2全部在转换单冲')
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
  const zero=await scenario('ZEROCASH',{cash:0,two:true})
  assert.equal((await pgQuery('SELECT status FROM sale_orders WHERE sale_order_id=$1',[zero.orderId]))[0].status,'待支付','零补款保留原补款流程，商品折抵价值可退款')
  for(const item of zero.items) {
    assert.equal(Number(item.received),400)
    const r=await apply(zero.orderId,item.sale_item_id);assert.equal(r.finalRefundAmount,400)
    assert.equal((await invokeStaffApi('order.close',{...auth,saleOrderId:zero.orderId})).code,-409,'退款期间不能撤销转换')
    await call('order.approveRefund',{paymentId:r.paymentId})
  }
  assert.equal((await pgQuery('SELECT status FROM sale_orders WHERE sale_order_id=$1',[zero.orderId]))[0].status,'已退款')
  const owed=await scenario('COURSEDEBT',{cash:100,two:true});
  // A有9次已付，已用6次，退当前剩余3次，但仍有1次未付50元。
  await pgQuery('UPDATE sale_items SET remaining_sessions=4 WHERE sale_item_id=$1',[owed.items[0].sale_item_id]);
  await pgQuery('UPDATE sale_items SET remaining_sessions=1 WHERE sale_item_id=$1',[owed.items[1].sale_item_id]);
  const owedRefund=await apply(owed.orderId,owed.items[0].sale_item_id);
  assert.equal(owedRefund.finalRefundAmount,150);
  await call('order.approveRefund',{paymentId:owedRefund.paymentId});
  assert.equal((await pgQuery('SELECT status FROM sale_orders WHERE sale_order_id=$1',[owed.orderId]))[0].status,'部分支付');
  assert.equal(Number((await call('order.detail',{saleOrderId:owed.orderId})).order.conversion_remaining_payable),100);
  await call('order.createRepayment',{refSaleOrderId:owed.orderId,repayAmount:100,paymentMethod:'线下'});
  assert.equal((await pgQuery('SELECT paid_sessions FROM sale_items WHERE sale_item_id=$1',[owed.items[0].sale_item_id]))[0].paid_sessions,7);
  // 家居部分退后只补未退4件；现金码上限须扣待结算储值卡。
  const homeSourceSku=await createTestProduct({suffix:'HOMESRC',productKind:'护理项目',productType:'疗程卡',salesCategory:'他销自耗',price:400,sessionCount:1})
  const homeTargetSku=await createTestProduct({suffix:'HOMETGT',productKind:'家居产品',productType:'家居产品',salesCategory:'他销自耗',price:200,sessionCount:null})
  const homeSourceId=`${NS}_548_HOME`
  const homeSource=await createTestSaleOrder({saleOrderId:homeSourceId,clientUserId:TEST_CLIENT_USER_ID,skuId:homeSourceSku.skuId,totalAmount:400,sessionCount:1,status:'已支付',salesCategory:'他销自耗'})
  await pgQuery('UPDATE sale_orders SET received=400 WHERE sale_order_id=$1',[homeSourceId])
  await createPaidPayment(homeSourceId,{amount:400,items:[{saleItemId:homeSource.saleItemId,amount:400,salesCategory:'他销自耗'}]})
  const home=await call('order.createConversion',{clientUserId:TEST_CLIENT_USER_ID,convertOutSaleItemIds:[homeSource.saleItemId],convertInItems:[{skuId:homeTargetSku.skuId,quantity:5}],paymentMethod:'线下',receivedAmount:200})
  await call('order.confirmOffline',{saleOrderId:home.saleOrderId,confirmAmount:200})
  const homeItem=(await pgQuery("SELECT * FROM sale_items WHERE sale_order_id=$1 AND item_direction='转入'",[home.saleOrderId]))[0]
  const homeFirst=await call('order.createRefund',{refSaleOrderId:home.saleOrderId,items:[{saleItemId:homeItem.sale_item_id,refundQuantity:1}],refundReason:'只退1件'})
  assert.equal(homeFirst.finalRefundAmount,200)
  await call('order.approveRefund',{paymentId:homeFirst.paymentId})
  assert.equal(Number((await call('order.detail',{saleOrderId:home.saleOrderId})).order.conversion_remaining_payable),400)
  await pgQuery('UPDATE sale_orders SET pending_prepaid_card_amount=100 WHERE sale_order_id=$1',[home.saleOrderId])
  const qrOver=await invokeStaffApi('order.qrcode',{...auth,saleOrderId:home.saleOrderId,paymentAmount:400})
  assert.equal(qrOver.code,-400,'待扣100元时现金码只能冻结最多300元')
  await pgQuery('UPDATE sale_orders SET pending_prepaid_card_amount=0 WHERE sale_order_id=$1',[home.saleOrderId])
  await call('order.createRepayment',{refSaleOrderId:home.saleOrderId,repayAmount:400,paymentMethod:'线下'})
  const homePaid=(await pgQuery('SELECT * FROM sale_items WHERE sale_item_id=$1',[homeItem.sale_item_id]))[0]
  assert.equal(Number(homePaid.received),800)
  assert.equal(homePaid.refunded_quantity,1)
  assert.equal(homePaid.conversion_value_snapshot.valueCents,80000)
  const homeLast=await call('order.createRefund',{refSaleOrderId:home.saleOrderId,items:[{saleItemId:homeItem.sale_item_id,refundQuantity:4}],refundReason:'退余下4件'})
  assert.equal(homeLast.finalRefundAmount,800)
  await call('order.approveRefund',{paymentId:homeLast.paymentId})
  assert.equal((await pgQuery('SELECT status FROM sale_orders WHERE sale_order_id=$1',[home.saleOrderId]))[0].status,'已退款')
  const tier = await scenario('TIER', {old:5000,cash:1000})
  assert.equal((await pgQuery('SELECT spending_tier FROM client_wechat_users WHERE user_id=$1',[TEST_CLIENT_USER_ID]))[0].spending_tier,'1990-1W')
  const tierRefund = await apply(tier.orderId,tier.items[0].sale_item_id)
  assert.equal(tierRefund.finalRefundAmount,6000)
  await call('order.approveRefund',{paymentId:tierRefund.paymentId})
  assert.equal((await pgQuery('SELECT spending_tier FROM client_wechat_users WHERE user_id=$1',[TEST_CLIENT_USER_ID]))[0].spending_tier,'<1990','退款态转换负额必须参与实时消费档位')
  console.log('PASS #548 1000元退款、逐项/驳回/并发审批/后续补款/源权益不恢复')
}
try{await main()}finally{await cleanupTestData(NS);await closePool()}
