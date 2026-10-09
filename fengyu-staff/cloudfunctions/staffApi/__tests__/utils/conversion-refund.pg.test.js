const { initializeConversionSources, rollbackConversionPointTransfers, recordConversionRefundSources } = require('../../utils/conversion-sources')
// 仅一次性本地库；显式环境变量，禁止使用业务 PG_CONNECTION_STRING。
const { Client } = require('pg')
const { recalcPaidSessionsForOrder } = require('../../utils/paid-sessions')
const { CONVERSION_RECEIPT_SQL, getConversionDebt } = require('../../utils/conversion-value')
const { cascadeRefund } = require('../../helpers/refund-cascade')
const { grantPointBatch, settlePointsForOrder } = require('../../utils/points')
const { buildRefundDetails, calculateUnusedQuantity } = require('../../utils/refund')
const { allocateRefundAccounting } = require('../../utils/refund-accounting')
const run = process.env.ISSUE548_PG_URL ? describe : describe.skip
run('#548 隔离 PG 转换退款（真实级联与权益重算）', () => {
  let c
  beforeAll(async () => {
    const url = new URL(process.env.ISSUE548_PG_URL)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('只允许一次性本地PG')
    c = new Client({ connectionString: url.toString() }); await c.connect()
  })
  afterAll(async () => { if (c) await c.end() })
  beforeEach(async () => {
    await c.query('BEGIN')
    await c.query("INSERT INTO org_nodes(id,name,type) VALUES('H548','测试总部','总部')")
    await c.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES('M548','测试市场','市场','H548')")
    await c.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES('S548','测试门店','门店','M548')")
    await c.query("INSERT INTO stores(store_id,store_name,org_node_id) VALUES('T548','测试','S548')")
    await c.query("INSERT INTO client_wechat_users(user_id) VALUES('T548') ON CONFLICT DO NOTHING")
  })
  afterEach(async () => { await c.query('ROLLBACK') })
  async function cloneItem(sourceId, overrides) {
    const columns=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='sale_items' AND is_generated='NEVER' ORDER BY ordinal_position")).rows.map(r=>r.column_name)
    const names=columns.map(name=>'"'+name+'"').join(',')
    await c.query(`INSERT INTO sale_items(${names}) SELECT ${columns.map(name=>'copy."'+name+'"').join(',')} FROM sale_items si CROSS JOIN LATERAL jsonb_populate_record(NULL::sale_items,to_jsonb(si)||$2::jsonb) copy WHERE si.sale_item_id=$1`,[sourceId,JSON.stringify(overrides)])
  }
  async function setup({ old = 800, cash = 200, amounts = [1000], home = false, used = 0, linked = false, awardOld = true, beforeTransfer, afterTransfer } = {}) {
    for (const [id, total, received, type] of [['O548', old, old, '销售单'], ['C548', Math.max(0, amounts.reduce((a,b)=>a+b,0)-old), cash, '转换单']]) {
      await c.query(`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,total_amount,payment_method,received,status,sale_order_type,client_user_id,paid_at)
        VALUES($1,'测试','T548',NOW(),$2,'线下',$3,'已支付',$4,'T548',NOW())`, [id,total,received,type])
    }
    if(linked) await c.query("UPDATE sale_orders SET ref_sale_order_id='O548' WHERE sale_order_id='C548'")
    await c.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,received,quantity,session_count,remaining_sessions,paid_sessions,product_type,item_direction)
      VALUES('OLD548','O548','T548',$1,$1,$1,$1,1,1,0,1,'疗程卡','购买'),('OUT548','C548','T548',$1,$1,-$1,-$1,1,1,0,1,'疗程卡','转出')`, [old])
    await c.query("UPDATE sale_items SET ref_sale_item_id='OLD548' WHERE sale_item_id='OUT548'")
    for (const [i,amount] of amounts.entries()) {
      await c.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,received,quantity,session_count,remaining_sessions,paid_sessions,product_type,item_direction)
        VALUES($1,'C548','T548',$2,$3,$2,$2,$4,$5,$6,$5,$7,'转入')`, [`IN548-${i}`,amount,amount/(home?5:10),home?5:1,home?null:10,home?null:10-used,home?'家居产品':'疗程卡'])
    }
    if(cash>0) await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end) VALUES('C548','首次支付',$1,'线下','已支付','staff')",[cash])
    if (awardOld) await settlePointsForOrder(c,'O548')
    if (beforeTransfer) await beforeTransfer(c)
    await initializeConversionSources(async (text,params)=>(await c.query(text,params)).rows,'C548')
    if (afterTransfer) await afterTransfer(c)
    await recalcPaidSessionsForOrder(c,'C548')
    await settlePointsForOrder(c,'C548')
    return (await c.query("SELECT * FROM sale_items WHERE sale_order_id='C548' AND item_direction='转入' ORDER BY sale_item_id")).rows
  }
  async function refund(row, quantity, fee = 0, orderId = 'C548') {
    const built=buildRefundDetails([{...row,picked_quantity:Number(row.picked_up_quantity||0),converted_amount:0,converted_quantity:0}], [{saleItemId:row.sale_item_id,refundQuantity:quantity}])
    const items=allocateRefundAccounting(built.refundDetails,new Map([[row.sale_item_id,Number(row.received)]]),fee)
    const note={conversionRefund:true,refundAccountingVersion:2,handlingFee:fee,items}
    const res=await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,note,ref_sale_item_id,session_count,source_end) VALUES($5,'退款',$1,'线下','已支付',$2,$3,$4,'staff') RETURNING id",[-(built.totalRefund-fee),JSON.stringify(note),row.sale_item_id,items[0].quantity,orderId])
    await c.query("UPDATE sale_orders SET refunded_amount=(SELECT -SUM(amount) FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款' AND status='已支付') WHERE sale_order_id=$1", [orderId])
    await recordConversionRefundSources(async (text, params) => (await c.query(text, params)).rows, orderId, res.rows[0].id)
    await cascadeRefund(c,{saleOrderId:orderId,refundPaymentId:res.rows[0].id,items:items.map(it=>({saleItemId:it.refSaleItemId,sessionCount:it.quantity,refundAmount:it.refundAmount,isFullItemRefund:it.isFullItemRefund})),isWholeOrderRefund:false,refundReason:'测试'})
    await recalcPaidSessionsForOrder(c,orderId)
    return built.totalRefund
  }
  test('800折抵+200现金退1000；负receipt，不伪造收款，不恢复旧卡，重算不复活',async()=>{
    const [row]=await setup(); expect(Number(row.received)).toBe(1000)
    expect(await refund(row)).toBe(1000)
    const saved=(await c.query("SELECT public.try_jsonb(note) AS note FROM sale_order_payments WHERE sale_order_id='C548' AND change_type='退款' AND status='已支付'")).rows[0].note
    expect(saved.items[0].conversionSources.reduce((sum,x)=>sum+x.valueCents,0)).toBe(100000)
    await recalcPaidSessionsForOrder(c,'C548')
    const [after]=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows
    expect(Number(after.received)).toBe(0); expect(after.paid_sessions).toBe(0)
    expect((await c.query("SELECT remaining_sessions FROM sale_items WHERE sale_item_id='OLD548'")).rows[0].remaining_sessions).toBe(0)
    const net=(await c.query("SELECT SUM(received-refunded_amount) AS net FROM sale_orders WHERE client_user_id='T548'")).rows[0]
    expect(Number(net.net)).toBe(0)
    const receipts=(await c.query("SELECT amount FROM sale_payment_item_receipts WHERE sale_order_id='C548'")).rows
    expect(receipts.map(r=>Number(r.amount))).toEqual([-1000])
  })
  test.each([0,100,200])('A/B分退：现金%s，不摊减B；后续补款不复活A',async cash=>{
    const [a,b]=await setup({cash,amounts:[500,500]});const bBefore=Number(b.received)
    await refund(a)
    expect(Number((await c.query("SELECT received FROM sale_items WHERE sale_item_id=$1",[b.sale_item_id])).rows[0].received)).toBe(bBefore)
    const debt=await getConversionDebt(c,'C548');expect(debt).toBe(500-bBefore)
    if(debt>0){const deltas=await repay(debt);expect(deltas.map(r=>[r.sale_item_id,Number(r.amount)])).toEqual([[b.sale_item_id,debt]])}
    await recalcPaidSessionsForOrder(c,'C548')
    const after=(await c.query("SELECT * FROM sale_items WHERE item_direction='转入' AND sale_order_id='C548' ORDER BY sale_item_id")).rows
    expect(calculateUnusedQuantity(after[0])).toBe(0);expect(Number(after[1].received)).toBe(500)
    expect(await refund(after[1])).toBe(500);expect(await getConversionDebt(c,'C548')).toBe(0)
  })
  test.each([{old:1000,cash:0,amounts:[800]},{old:800,cash:0,amounts:[800]}])('负/零补差或体验重定价不退面值以外的钱：%j',async opts=>{
    const [row]=await setup(opts);expect(Number(row.received)).toBe(800);expect(await refund(row)).toBe(800)
  })
  test('部分使用疗程只退未用，D3守住',async()=>{
    const [row]=await setup({used:6});expect(await refund(row)).toBe(400)
    const after=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0]
    expect(after.paid_sessions).toBe(6);expect(calculateUnusedQuantity(after)).toBe(0)
  })
  test('家居逐件、多次退款，数量独立累加不复活',async()=>{
    const [row]=await setup({home:true});expect(await refund(row,2)).toBe(400)
    const next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0]
    expect(next.refunded_quantity).toBe(2);expect(Number(next.received)).toBe(600)
    expect(await refund(next,3)).toBe(600)
    const after=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0]
    expect(after.refunded_quantity).toBe(5);expect(Number(after.received)).toBe(0)
  })
  test('手续费留现金但不留已退权益，不摊减未选项',async()=>{
    const [a,b]=await setup({amounts:[500,500]});await refund(a,undefined,49)
    await recalcPaidSessionsForOrder(c,'C548')
    const rows=(await c.query("SELECT * FROM sale_items WHERE item_direction='转入' AND sale_order_id='C548' ORDER BY sale_item_id")).rows
    expect(Number(rows[0].received)).toBe(49);expect(rows[0].paid_sessions).toBe(0)
    expect(Number(rows[1].received)).toBe(500)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(451)
    expect(Number((await c.query("SELECT amount FROM sale_payment_item_receipts WHERE sale_order_id='C548'")).rows[0].amount)).toBe(-451)
  })
  test('四项两分分摊无负尾差且合计守恒',async()=>{
    const rows=await setup({old:0.02,cash:0,amounts:[1,1,1,1]});expect(rows.map(r=>Number(r.received))).toEqual([0.01,0,0.01,0]);expect(rows.reduce((n,r)=>n+Number(r.received),0)).toBe(0.02)
  })
  test('普通销售单异常转入行不能增加旧OVERPAY退款容量', async () => {
    await setup()
    await cloneItem('OLD548', {sale_item_id:'OVER548',sale_amount:100,received:200,unit_price:100,unit_real_price:100,product_type:'家居产品',session_count:null,remaining_sessions:null,paid_sessions:null,picked_up_quantity:1})
    await cloneItem('OVER548', {sale_item_id:'BAD548',item_direction:'转入'})
    await c.query("UPDATE sale_orders SET received=1000 WHERE sale_order_id='O548'")
    const note={items:[{refSaleItemId:'OVERPAY',refundAmount:150,overpayAmount:150,isOverpay:true,quantity:0}],handlingFee:0}
    const rows=(await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,note,source_end) VALUES('O548','退款',-150,'线下','已支付',$1,'staff') RETURNING id",[JSON.stringify(note)])).rows
    await expect(cascadeRefund(c,{saleOrderId:'O548',refundPaymentId:rows[0].id,items:[{saleItemId:'OVERPAY',refundAmount:150,isOverpay:true}],isWholeOrderRefund:false})).rejects.toThrow('可退余数已变化')
    expect((await c.query("SELECT 1 FROM sale_payment_item_receipts WHERE sale_order_id='O548'")).rows).toHaveLength(0)
  })

  async function repay(amount) {
    await c.query("UPDATE sale_orders SET received=received+$1 WHERE sale_order_id='C548'", [amount])
    const id=(await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end) VALUES('C548','回款',$1,'线下','已支付','staff') RETURNING id",[amount])).rows[0].id
    const deltas=(await c.query(CONVERSION_RECEIPT_SQL,['C548',amount])).rows.filter(r=>Number(r.amount)!==0)
    for(const row of deltas) await c.query("INSERT INTO sale_payment_item_receipts(sale_order_id,sale_payment_id,sale_item_id,amount,sales_category) VALUES('C548',$1,$2,$3,$4)",[id,row.sale_item_id,row.amount,row.sales_category])
    await recalcPaidSessionsForOrder(c,'C548')
    return deltas
  }
  test('部分付款家居退1件后，未退余件可补款，已退数量不复活', async () => {
    const [row]=await setup({old:400,cash:200,home:true})
    expect(calculateUnusedQuantity({...row,picked_quantity:0,converted_amount:0})).toBe(3)
    await refund(row,1)
    let next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0]
    expect(calculateUnusedQuantity({...next,picked_quantity:0,converted_amount:0})).toBe(2)
    expect(Number(next.received)).toBe(400)
    expect(await getConversionDebt(c,'C548')).toBe(400)
    expect((await repay(400)).map(r=>Number(r.amount))).toEqual([400])
    await recalcPaidSessionsForOrder(c,'C548')
    next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0]
    expect(Number(next.received)).toBe(800)
    expect(next.conversion_value_snapshot.valueCents).toBe(80000)
    expect(calculateUnusedQuantity({...next,picked_quantity:0,converted_amount:0})).toBe(4)
    expect(next.refunded_quantity).toBe(1)
    expect(await getConversionDebt(c,'C548')).toBe(0)
    expect(await refund(next,4)).toBe(800)
  })
  test('A部分退款再补款，不移动B原已付价值；尾差、来源及现金只进未退余量', async () => {
    const [a,b]=await setup({old:800,cash:100,home:true,amounts:[500,500]})
    await refund(a,1)
    const current=(await c.query("SELECT * FROM sale_items WHERE sale_order_id='C548' AND item_direction='转入' ORDER BY sale_item_id")).rows
    expect(current.map(r=>Number(r.received))).toEqual([350,450])
    expect(await getConversionDebt(c,'C548')).toBe(100)
    expect((await repay(100)).map(r=>Number(r.amount))).toEqual([50,50])
    await recalcPaidSessionsForOrder(c,'C548')
    const paid=(await c.query("SELECT * FROM sale_items WHERE sale_order_id='C548' AND item_direction='转入' ORDER BY sale_item_id")).rows
    expect(paid.map(r=>Number(r.received))).toEqual([400,500])
    expect(paid.map(r=>r.conversion_value_snapshot.valueCents)).toEqual([40000,50000])
    expect(paid[0].refunded_quantity).toBe(1)
    expect(await refund(paid[0],4)).toBe(400)
    expect(await refund(paid[1],5)).toBe(500)
    expect(await getConversionDebt(c,'C548')).toBe(0)
  })

  test('1分新到账不能移动旧1分，received增量必须逐项等于真实receipt且重复重算幂等', async () => {
    const before=await setup({old:0.02,cash:0,amounts:[10,20,30]})
    expect(before.map(r=>Number(r.received))).toEqual([0,0.01,0.01])
    const deltas=await repay(0.01)
    expect(deltas.map(r=>[r.sale_item_id,Number(r.amount)])).toEqual([['IN548-1',0.01]])
    await recalcPaidSessionsForOrder(c,'C548')
    const after=(await c.query("SELECT * FROM sale_items WHERE sale_order_id='C548' AND item_direction='转入' ORDER BY sale_item_id")).rows
    expect(after.map(r=>Number(r.received))).toEqual([0,0.02,0.01])
    expect(after.map(r=>r.conversion_value_snapshot.valueCents)).toEqual([0,2,1])
  })


  test.each([false,true])('旧8+新2只冲本单，旧单数据不变、关联指针不重复赠点：linked=%s', async linked => {
    const [row]=await setup({linked})
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(10)
    const before=(await c.query("SELECT to_jsonb(o) AS value FROM sale_orders o WHERE sale_order_id='O548'")).rows[0].value
    const oldLedger=(await c.query("SELECT to_jsonb(p) AS value FROM point_transactions p WHERE ref_order_id='O548'")).rows
    await refund(row)
    expect((await c.query("SELECT to_jsonb(o) AS value FROM sale_orders o WHERE sale_order_id='O548'")).rows[0].value).toEqual(before)
    expect((await c.query("SELECT to_jsonb(p) AS value FROM point_transactions p WHERE ref_order_id='O548'")).rows).toEqual(oldLedger)
    expect((await c.query("SELECT ref_order_id,amount FROM point_transactions WHERE type='消费冲销'")).rows.map(r=>[r.ref_order_id,Number(r.amount)])).toEqual([['C548',-10]])
    for(const file of ['../../utils/points','../../../../../fengyu-client/cloudfunctions/clientApi/utils/points','../../../../../fengyu-client/cloudfunctions/payNotify/points']) {
      expect((await require(file).settlePointsForOrder(c,'O548')).delta).toBe(0)
      expect((await require(file).settlePointsForOrder(c,'C548')).delta).toBe(0)
    }
    await c.query("UPDATE sale_orders SET received=received+100 WHERE sale_order_id='O548'")
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(1)
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(1)
  })
  test('原积分未发则不补造旧折抵积分，只冲补款2分',async()=>{
    const [row]=await setup({awardOld:false})
    expect((await c.query('SELECT transferred_points FROM conversion_point_transfers')).rows.map(r=>Number(r.transferred_points))).toEqual([0])
    await refund(row)
    expect((await c.query("SELECT ref_order_id,amount FROM point_transactions WHERE type='消费冲销'")).rows.map(r=>[r.ref_order_id,Number(r.amount)])).toEqual([['C548',-2]])
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
  })
  test.each(['used','expired'])('交接保留已用/原到期，不复活、不消耗其它订单批次：%s',async state=>{
    let original
    const [row]=await setup({beforeTransfer:async()=>{
      if(state==='used') await c.query("UPDATE point_batches SET remaining_amount=2 WHERE ref_order_id='O548'")
      else await c.query("UPDATE point_batches SET earned_at=NOW()-INTERVAL '400 days',expire_at=NOW()-INTERVAL '35 days',expired_at=NOW()-INTERVAL '35 days' WHERE ref_order_id='O548'")
      original=(await c.query("SELECT earned_at,expire_at,expired_at,remaining_amount FROM point_batches WHERE ref_order_id='O548'")).rows[0]
    }})
    const inherited=(await c.query("SELECT earned_at,expire_at,expired_at,remaining_amount FROM point_batches WHERE ref_order_id='C548' AND source_transaction_id=(SELECT id FROM point_transactions WHERE ref_order_id='O548' AND type='消费赠送')")).rows[0]
    expect(inherited).toEqual(original)
    const extra=(await c.query("INSERT INTO point_transactions(user_id,type,amount) VALUES('T548','获取',50) RETURNING id")).rows[0]
    await grantPointBatch(c,{userId:'T548',pointTransactionId:extra.id,type:'获取',amount:50})
    const unrelated=(await c.query('SELECT * FROM point_batches WHERE source_transaction_id=$1',[extra.id])).rows
    await refund(row)
    expect((await c.query('SELECT * FROM point_batches WHERE source_transaction_id=$1',[extra.id])).rows).toEqual(unrelated)
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(50)
  })
  test('连续转换只交接一次，末代退款冲12，前两单没有冲销',async()=>{
    const [first]=await setup()
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"C548B\"}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem('OUT548',{sale_item_id:'OUT548B',sale_order_id:'C548B',ref_sale_item_id:first.sale_item_id,received:-1000,sale_amount:-1000,conversion_value_snapshot:null})
    await cloneItem(first.sale_item_id,{sale_item_id:'IN548B',sale_order_id:'C548B',received:1200,sale_amount:1200,unit_real_price:120,conversion_value_snapshot:null})
    await c.query("UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id=$1",[first.sale_item_id])
    const query=async(text,params)=>(await c.query(text,params)).rows
    await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end) VALUES('C548B','首次支付',200,'线下','已支付','staff')")
    await initializeConversionSources(query,'C548B'); await initializeConversionSources(query,'C548B')
    await recalcPaidSessionsForOrder(c,'C548B');expect((await settlePointsForOrder(c,'C548B')).delta).toBe(2)
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
    const next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548B'")).rows[0]
    await refund(next,undefined,0,'C548B')
    expect((await c.query("SELECT ref_order_id,amount FROM point_transactions WHERE type='消费冲销'")).rows.map(r=>[r.ref_order_id,Number(r.amount)])).toEqual([['C548B',-12]])
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
  })
  test('真正撤销转换恢复交接；逐项退款不恢复来源',async()=>{
    await setup({cash:0})
    const query=async(text,params)=>(await c.query(text,params)).rows
    await rollbackConversionPointTransfers(query,'C548'); await rollbackConversionPointTransfers(query,'C548')
    expect((await c.query('SELECT * FROM conversion_point_transfers')).rows).toHaveLength(0)
    expect((await c.query("SELECT ref_order_id,remaining_amount FROM point_batches WHERE ref_order_id='O548'")).rows.map(r=>Number(r.remaining_amount))).toEqual([8])
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
  })
  test('历史责任缺失只拒绝本单退款，不在退款时前追或猜算',async()=>{
    const [row]=await setup()
    await c.query("UPDATE sale_items SET conversion_value_snapshot=NULL WHERE sale_order_id='C548'")
    await c.query('SAVEPOINT unknown_responsibility')
    await expect(refund(row)).rejects.toThrow('责任尚未交接')
    await c.query('ROLLBACK TO SAVEPOINT unknown_responsibility')
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(0)
  })

  test('旧员工80提成保留，仅反冲转换补款员工20，退款查询不绑定旧单或旧明细',async()=>{
    const [row]=await setup()
    await c.query("INSERT INTO staff_wechat_users(employee_id,name) VALUES('EMP548A','旧员工'),('EMP548B','本单员工')")
    const oldPay=(await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end) VALUES('O548','首次支付',800,'线下','已支付','staff') RETURNING id")).rows[0].id
    const cashPay=(await c.query("SELECT id FROM sale_order_payments WHERE sale_order_id='C548' AND change_type='首次支付'")).rows[0].id
    for(const [order,item,payment,employee,amount,commission] of [['O548','OLD548',oldPay,'EMP548A',800,80],['C548',row.sale_item_id,cashPay,'EMP548B',200,20]]) {
      const receipt=(await c.query("INSERT INTO sale_payment_item_receipts(sale_order_id,sale_payment_id,sale_item_id,amount) VALUES($1,$2,$3,$4) RETURNING id",[order,payment,item,amount])).rows[0].id
      await c.query("INSERT INTO sale_payment_item_allocations(sale_payment_item_receipt_id,employee_id,role_type,allocation_ratio,allocated_amount,commission_rate,commission_amount) VALUES($1,$2,'美容师',1,$3,.1,$4)",[receipt,employee,amount,commission])
    }
    // 初始现金已进入快照，新增的真实receipt不应再次增加现金。
    await c.query("UPDATE sale_items SET conversion_value_snapshot=jsonb_set(conversion_value_snapshot,'{lastCashPaymentId}',to_jsonb($1::bigint)) WHERE sale_order_id='C548' AND item_direction='转入'",[cashPay])
    const before=(await c.query("SELECT to_jsonb(a) AS value FROM sale_payment_item_allocations a WHERE employee_id='EMP548A'")).rows
    const sourceItem=(await c.query("SELECT to_jsonb(i) AS value FROM sale_items i WHERE sale_item_id='OLD548'")).rows[0].value
    const calls=[],originalQuery=c.query.bind(c)
    c.query=async(text,params)=>{calls.push({text:String(text),params});return originalQuery(text,params)}
    try { await refund(row) } finally { c.query=originalQuery }
    expect(calls.some(q=>(q.params || []).some(p=>p==='O548' || p==='OLD548'))).toBe(false)
    expect((await c.query("SELECT to_jsonb(a) AS value FROM sale_payment_item_allocations a WHERE employee_id='EMP548A'")).rows).toEqual(before)
    expect((await c.query("SELECT to_jsonb(i) AS value FROM sale_items i WHERE sale_item_id='OLD548'")).rows[0].value).toEqual(sourceItem)
    const reversed=(await c.query("SELECT allocated_amount,commission_amount FROM sale_payment_item_allocations WHERE employee_id='EMP548B' AND allocated_amount<0")).rows
    expect(reversed.map(r=>[Number(r.allocated_amount),Number(r.commission_amount)])).toEqual([[-200,-20]])
  })
  test('停用/积分故障隔离保留本单冲销责任，恢复后只结本单',async()=>{
    const [row]=await setup()
    const prior=process.env.POINTS_ACCRUAL_ENABLED; process.env.POINTS_ACCRUAL_ENABLED='false'
    try { await refund(row) } finally { if(prior===undefined) delete process.env.POINTS_ACCRUAL_ENABLED; else process.env.POINTS_ACCRUAL_ENABLED=prior }
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(-10)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
  })

  test('来源有已冲销空批次时，新赠积分的有效余额仍正确交接',async()=>{
    const [first]=await setup()
    // 构造同账户旧空批次，不能让它承接本次责任而把实际可用余额留在来源。
    const tx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='C548' AND type='消费赠送'")).rows[0].id
    await c.query("INSERT INTO point_batches(user_id,source_transaction_id,source_type,ref_order_id,original_amount,remaining_amount,earned_at,expire_at) SELECT user_id,$1,'消费赠送','C548',50,0,NOW()-INTERVAL '300 days',NOW()+INTERVAL '65 days' FROM client_wechat_users WHERE user_id='T548'",[tx])
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"C548B\"}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem('OUT548',{sale_item_id:'OUT548B',sale_order_id:'C548B',ref_sale_item_id:first.sale_item_id,received:-1000,sale_amount:-1000,conversion_value_snapshot:null})
    await cloneItem(first.sale_item_id,{sale_item_id:'IN548B',sale_order_id:'C548B',received:1200,sale_amount:1200,unit_real_price:120,conversion_value_snapshot:null})
    await c.query("UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id=$1",[first.sale_item_id])
    await initializeConversionSources(async(text,params)=>(await c.query(text,params)).rows,'C548B')
    expect(Number((await c.query("SELECT COALESCE(SUM(remaining_amount),0) AS balance FROM point_batches WHERE ref_order_id='C548' AND expire_at>NOW()")).rows[0].balance)).toBe(0)
    expect(Number((await c.query("SELECT COALESCE(SUM(remaining_amount),0) AS balance FROM point_batches WHERE ref_order_id='C548B' AND expire_at>NOW()")).rows[0].balance)).toBe(10)
  })

  test('转换交接本身不增余额或新赠流水，重复初始化不重复交接',async()=>{
    let balance,batches,transactions
    await setup({beforeTransfer:async()=>{
      balance=(await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows
      batches=Number((await c.query("SELECT SUM(remaining_amount) AS n FROM point_batches WHERE user_id='T548'")).rows[0].n)
      transactions=(await c.query("SELECT * FROM point_transactions WHERE user_id='T548' ORDER BY id")).rows
    },afterTransfer:async()=>{
      await initializeConversionSources(async(text,params)=>(await c.query(text,params)).rows,'C548')
      expect((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows).toEqual(balance)
      expect(Number((await c.query("SELECT SUM(remaining_amount) AS n FROM point_batches WHERE user_id='T548'")).rows[0].n)).toBe(batches)
      expect((await c.query("SELECT * FROM point_transactions WHERE user_id='T548' ORDER BY id")).rows).toEqual(transactions)
      expect((await c.query("SELECT * FROM conversion_point_transfers WHERE to_order_id='C548'")).rows).toHaveLength(1)
    }})
  })
  test('本单积分写入故障只隔离积分，资金和责任保留；旧单流水未触碰',async()=>{
    const [row]=await setup()
    await c.query("CREATE FUNCTION pg_temp.reject548() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '548 points injected failure'; END $$")
    await c.query("CREATE TRIGGER reject548 BEFORE INSERT OR UPDATE ON point_transactions FOR EACH ROW EXECUTE FUNCTION pg_temp.reject548()")
    await refund(row)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(1000)
    expect((await c.query("SELECT 1 FROM operation_logs WHERE action='points.settleFailed' AND target_id='C548'")).rows).toHaveLength(1)
    await c.query('DROP TRIGGER reject548 ON point_transactions')
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(-10)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
  })
  test('本单交接台账丢失则拒绝退款，由本单审计定位，不回查原单',async()=>{
    const [row]=await setup()
    await c.query("DELETE FROM conversion_point_transfers WHERE to_order_id='C548'")
    const { CONVERSION_SOURCE_AUDIT_SQL }=require('../../utils/conversion-sources')
    expect((await c.query(CONVERSION_SOURCE_AUDIT_SQL)).rows.some(r=>r.sale_item_id==='OUT548')).toBe(true)
    await c.query('SAVEPOINT missing_journal')
    await expect(refund(row)).rejects.toThrow('交接凭据不完整')
    await c.query('ROLLBACK TO SAVEPOINT missing_journal')
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(0)
  })

  test('多个原单只在转换时交接，两项退款全部在本单冲14分',async()=>{
    const [a,b]=await setup({amounts:[700,700],beforeTransfer:async()=>{
      await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"O548B\",\"total_amount\":400,\"received\":400}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='O548'")
      await cloneItem('OLD548',{sale_item_id:'OLD548B',sale_order_id:'O548B',sale_amount:400,received:400,unit_price:400,unit_real_price:400})
      await cloneItem('OUT548',{sale_item_id:'OUT548B',ref_sale_item_id:'OLD548B',sale_amount:-400,received:-400,unit_price:400,unit_real_price:400})
      await c.query("UPDATE sale_orders SET total_amount=200 WHERE sale_order_id='C548'")
      await settlePointsForOrder(c,'O548B')
    }})
    expect((await c.query("SELECT from_order_id,transferred_points FROM conversion_point_transfers ORDER BY from_order_id")).rows.map(r=>[r.from_order_id,Number(r.transferred_points)])).toEqual([['O548',8],['O548B',4]])
    await refund(a); await refund(b)
    expect(Number((await c.query("SELECT amount FROM point_transactions WHERE ref_order_id='C548' AND type='消费冲销'")).rows[0].amount)).toBe(-14)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
    expect((await settlePointsForOrder(c,'O548B')).delta).toBe(0)
  })
  test('来源有未确定旧积分类型时拒绝猜算，交接和批次没有写入',async()=>{
    await expect(setup({beforeTransfer:async()=>{
      await c.query("INSERT INTO point_transactions(user_id,ref_order_id,type,amount) VALUES('T548','O548','获取',2)")
    }})).rejects.toThrow('历史积分类型责任需离线核查')
    expect((await c.query('SELECT * FROM conversion_point_transfers')).rows).toHaveLength(0)
    expect((await c.query("SELECT ref_order_id FROM point_batches WHERE user_id='T548'")).rows.map(r=>r.ref_order_id)).toEqual(['O548'])
  })

  test('补款未赠点再部分转换，只移旧4分，不借旧责任补造现金积分',async()=>{
    const [a]=await setup({amounts:[500,500]})
    // 模拟补款入账已完成，但补款赠点尚未成功：旧8分已交接、新2分未发。
    const tx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='C548' AND type='消费赠送'")).rows[0].id
    await c.query('DELETE FROM point_batches WHERE source_transaction_id=$1',[tx])
    await c.query('DELETE FROM point_transactions WHERE id=$1',[tx])
    await c.query("UPDATE client_wechat_users SET points_balance=8 WHERE user_id='T548'")
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"C548B\",\"total_amount\":0,\"received\":0}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem('OUT548',{sale_item_id:'OUT548B',sale_order_id:'C548B',ref_sale_item_id:a.sale_item_id,received:-500,sale_amount:-500,conversion_value_snapshot:null})
    await cloneItem(a.sale_item_id,{sale_item_id:'IN548B',sale_order_id:'C548B',conversion_value_snapshot:null})
    await c.query('UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id=$1',[a.sale_item_id])
    await initializeConversionSources(async(text,params)=>(await c.query(text,params)).rows,'C548B')
    expect(Number((await c.query("SELECT transferred_points FROM conversion_point_transfers WHERE to_order_id='C548B'")).rows[0].transferred_points)).toBe(4)
    expect((await settlePointsForOrder(c,'C548B')).delta).toBe(0)
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(1)
  })

  test('再次转换分别交接旧过期责任和本单有效补款积分，不挪走未选项赠点',async()=>{
    const [a]=await setup({amounts:[500,500],beforeTransfer:async()=>{
      await c.query("UPDATE point_batches SET earned_at=NOW()-INTERVAL '400 days',expire_at=NOW()-INTERVAL '35 days',expired_at=NOW()-INTERVAL '35 days' WHERE ref_order_id='O548'")
    }})
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"C548B\",\"total_amount\":0,\"received\":0}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem('OUT548',{sale_item_id:'OUT548B',sale_order_id:'C548B',ref_sale_item_id:a.sale_item_id,received:-500,sale_amount:-500,conversion_value_snapshot:null})
    await cloneItem(a.sale_item_id,{sale_item_id:'IN548B',sale_order_id:'C548B',conversion_value_snapshot:null})
    await c.query('UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id=$1',[a.sale_item_id])
    await initializeConversionSources(async(text,params)=>(await c.query(text,params)).rows,'C548B')
    const balances=await c.query("SELECT ref_order_id,SUM(remaining_amount) AS available FROM point_batches WHERE expire_at>NOW() GROUP BY ref_order_id ORDER BY ref_order_id")
    expect(balances.rows.map(r=>[r.ref_order_id,Number(r.available)])).toEqual([['C548',1],['C548B',1]])
    const next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548B'")).rows[0]
    await refund(next,undefined,0,'C548B')
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(1)
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
  })

  test('部分退款只冲本单现金批次，旧责任期限保留；再次转换没有遗留现金积分',async()=>{
    const [a,b]=await setup({cash:100,home:true,amounts:[500,500]})
    await refund(a,1)
    const tx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='C548' AND type='消费赠送'")).rows[0].id
    expect(Number((await c.query('SELECT SUM(remaining_amount) AS n FROM point_batches WHERE source_transaction_id=$1',[tx])).rows[0].n)).toBe(0)
    expect(Number((await c.query("SELECT SUM(remaining_amount) AS n FROM point_batches WHERE ref_order_id='C548' AND source_transaction_id<>$1",[tx])).rows[0].n)).toBe(8)
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders,to_jsonb(o)||'{\"sale_order_id\":\"C548B\",\"total_amount\":0,\"received\":0}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem('OUT548',{sale_item_id:'OUT548B',sale_order_id:'C548B',ref_sale_item_id:b.sale_item_id,received:-450,sale_amount:-450,conversion_value_snapshot:null})
    await cloneItem(b.sale_item_id,{sale_item_id:'IN548B',sale_order_id:'C548B',sale_amount:450,received:450,unit_real_price:90,conversion_value_snapshot:null})
    await c.query('UPDATE sale_items SET converted_quantity=5 WHERE sale_item_id=$1',[b.sale_item_id])
    await initializeConversionSources(async(text,params)=>(await c.query(text,params)).rows,'C548B')
    const next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548B'")).rows[0]
    await refund(next,5,0,'C548B')
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
  })
  test('净差额零也分别补发真实未退现金1分、冲旧责任1分，保持两类到期',async()=>{
    const [row]=await setup({home:true})
    const tx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='C548' AND type='消费赠送'")).rows[0].id
    await c.query('DELETE FROM point_batches WHERE source_transaction_id=$1',[tx]);await c.query('DELETE FROM point_transactions WHERE id=$1',[tx])
    await refund(row,1)
    const ledger=(await c.query("SELECT type,amount FROM point_transactions WHERE ref_order_id='C548' ORDER BY type")).rows
    expect(ledger.map(r=>[r.type,Number(r.amount)])).toEqual([['消费冲销',-1],['消费赠送',1]])
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(8)
  })

  test('有确凿历史补款已赠映射，归属更正不重赠或改期，本单全冲10而原账不动',async()=>{
    const [row]=await setup({linked:true})
    const oldTx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='O548' AND type='消费赠送'")).rows[0].id
    const cashTx=(await c.query("SELECT id FROM point_transactions WHERE ref_order_id='C548' AND type='消费赠送'")).rows[0].id
    const cashBatch=(await c.query('SELECT * FROM point_batches WHERE source_transaction_id=$1',[cashTx])).rows[0]
    // 构造旧规则起点：补款2已发在原链聚合行；本单赠点行不存在，批次日期/余额不变。
    await c.query("UPDATE point_transactions SET amount=10 WHERE id=$1",[oldTx])
    await c.query('UPDATE point_batches SET source_transaction_id=$2 WHERE id=$1',[cashBatch.id,oldTx])
    await c.query('DELETE FROM point_transactions WHERE id=$1',[cashTx])
    const journal=(await c.query("SELECT batch_snapshot FROM conversion_point_transfers WHERE to_order_id='C548'")).rows[0].batch_snapshot
    journal.ownCashPoints=2;journal.batches.push({toBatchId:Number(cashBatch.id),points:2,remaining:2,ownCash:true,earnedAt:cashBatch.earned_at,expireAt:cashBatch.expire_at,expiredAt:cashBatch.expired_at})
    await c.query("UPDATE conversion_point_transfers SET transferred_points=10,batch_snapshot=$1::jsonb WHERE to_order_id='C548'",[JSON.stringify(journal)])
    const original=(await c.query("SELECT * FROM point_transactions WHERE ref_order_id='O548'")).rows
    expect((await settlePointsForOrder(c,'C548')).delta).toBe(0)
    expect((await c.query('SELECT earned_at,expire_at FROM point_batches WHERE id=$1',[cashBatch.id])).rows[0]).toEqual({earned_at:cashBatch.earned_at,expire_at:cashBatch.expire_at})
    await refund(row)
    expect((await c.query("SELECT * FROM point_transactions WHERE ref_order_id='O548'")).rows).toEqual(original)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
    expect((await c.query("SELECT type,amount FROM point_transactions WHERE ref_order_id='C548'")).rows.map(r=>[r.type,Number(r.amount)])).toEqual([['消费冲销',-10]])
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(0)
  })

  test('统一批次锁序后普通销售冲销仍优先本单，较早到期的其他单余额保持',async()=>{
    await setup({beforeTransfer:async()=>{
      await c.query("UPDATE point_batches SET earned_at=NOW()-INTERVAL '200 days',expire_at=NOW()+INTERVAL '165 days' WHERE ref_order_id='O548'")
    }})
    const tx=(await c.query("INSERT INTO point_transactions(user_id,ref_order_id,type,amount) VALUES('T548','O548','获取',50) RETURNING id")).rows[0].id
    await grantPointBatch(c,{userId:'T548',pointTransactionId:tx,type:'获取',amount:50,refOrderId:'O548'})
    const {consumePointBatches}=require('../../utils/points')
    await consumePointBatches(c,{userId:'T548',amount:-3,refOrderId:'O548'})
    expect(Number((await c.query("SELECT SUM(remaining_amount) AS n FROM point_batches WHERE ref_order_id='O548'")).rows[0].n)).toBe(47)
    expect(Number((await c.query("SELECT SUM(remaining_amount) AS n FROM point_batches WHERE ref_order_id='C548'")).rows[0].n)).toBe(10)
  })

})
