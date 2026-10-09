const { recordConversionRefundSources } = require('../../utils/conversion-sources')
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
  async function setup({ old = 800, cash = 200, amounts = [1000], home = false, used = 0, linked = false } = {}) {
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
    await recalcPaidSessionsForOrder(c,'C548')
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
  test('全部退款后原已发消费积分冲销，旧单现金和权益仍不回滚',async()=>{
    const [row]=await setup()
    const tx=(await c.query("INSERT INTO point_transactions(user_id,ref_order_id,type,amount) VALUES('T548','O548','消费赠送',8) RETURNING id")).rows[0]
    await grantPointBatch(c,{userId:'T548',pointTransactionId:tx.id,type:'消费赠送',amount:8,refOrderId:'O548'})
    await refund(row)
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(0)
    expect(Number((await c.query("SELECT SUM(amount) AS net FROM point_transactions WHERE user_id='T548' AND type IN ('消费赠送','消费冲销')")).rows[0].net)).toBe(0)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='O548'")).rows[0].refunded_amount)).toBe(0)
  })
  test('四项两分分摊无负尾差且合计守恒',async()=>{
    const rows=await setup({old:0.02,cash:0,amounts:[1,1,1,1]});expect(rows.map(r=>Number(r.received))).toEqual([0.01,0,0.01,0]);expect(rows.reduce((n,r)=>n+Number(r.received),0)).toBe(0.02)
  })
  test('原订单链重复结算不复发，后续真实回款只新增对应积分', async () => {
    const [row] = await setup()
    expect((await settlePointsForOrder(c, 'O548')).delta).toBe(8)
    await refund(row)
    for (const file of ['../../utils/points', '../../../../../fengyu-client/cloudfunctions/clientApi/utils/points', '../../../../../fengyu-client/cloudfunctions/payNotify/points']) {
      expect((await require(file).settlePointsForOrder(c, 'O548')).delta).toBe(0)
    }
    await c.query("UPDATE sale_orders SET received=received+100 WHERE sale_order_id='O548'")
    expect((await settlePointsForOrder(c, 'O548')).delta).toBe(1)
    const ledger = (await c.query("SELECT ref_order_id, SUM(amount) AS points FROM point_transactions GROUP BY ref_order_id")).rows
    expect(ledger.filter(r => r.ref_order_id === 'O548').map(r => Number(r.points))).toEqual([1])
    expect(ledger.some(r => r.ref_order_id === 'C548')).toBe(false)
  })
  test('多原单来源，A/B各退500按两条原链分别冲，不改变现金归属', async () => {
    const [a] = await setup({old:800,cash:200,amounts:[500,500]})
    await c.query("UPDATE sale_orders SET total_amount=400,received=400 WHERE sale_order_id='O548'")
    await c.query("UPDATE sale_items SET sale_amount=400,received=400 WHERE sale_item_id='OLD548'")
    await c.query("UPDATE sale_items SET sale_amount=-400,received=-400,conversion_value_snapshot=NULL WHERE sale_item_id='OUT548'")
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders, to_jsonb(o) || '{\"sale_order_id\":\"O548B\"}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='O548'")
    await cloneItem("OLD548", {"sale_item_id":"OLD548B","sale_order_id":"O548B"})
    await cloneItem("OUT548", {"sale_item_id":"OUT548B","ref_sale_item_id":"OLD548B"})
    await c.query("UPDATE sale_items SET conversion_value_snapshot=NULL WHERE sale_order_id='C548' AND item_direction='转入'")
    await recalcPaidSessionsForOrder(c, 'C548')
    await settlePointsForOrder(c, 'O548'); await settlePointsForOrder(c, 'O548B')
    await refund(a)
    for (const root of ['O548','O548B']) expect((await settlePointsForOrder(c,root)).expected).toBe(2)
    const b = (await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548-1'")).rows[0]
    await refund(b)
    for (const root of ['O548','O548B']) expect((await settlePointsForOrder(c,root)).expected).toBe(0)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(1000)
    expect(Number((await c.query("SELECT SUM(refunded_amount) AS amount FROM sale_orders WHERE sale_order_id IN ('O548','O548B')")).rows[0].amount)).toBe(0)
  })
  test('两代转换继承来源，第二代补款200退1200，原链只冲800', async () => {
    const [first] = await setup()
    await settlePointsForOrder(c,'O548')
    await c.query("INSERT INTO sale_orders SELECT (jsonb_populate_record(NULL::sale_orders, to_jsonb(o) || '{\"sale_order_id\":\"C548B\"}'::jsonb)).* FROM sale_orders o WHERE sale_order_id='C548'")
    await cloneItem("OUT548", {"sale_item_id":"OUT548C","sale_order_id":"C548B","item_direction":"转出","ref_sale_item_id":"IN548-0","received":-1000,"sale_amount":-1000,"conversion_value_snapshot":null})
    await cloneItem("IN548-0", {"sale_item_id":"IN548C","sale_order_id":"C548B","received":1200,"sale_amount":1200,"unit_real_price":120,"conversion_value_snapshot":null})
    await c.query("UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id=$1", [first.sale_item_id])
    await recalcPaidSessionsForOrder(c,'C548B')
    const next=(await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548C'")).rows[0]
    expect(next.conversion_value_snapshot.valueCents).toBe(120000)
    expect(next.conversion_value_snapshot.sources.filter(s=>s.pointOrderId==='O548').reduce((sum,s)=>sum+s.valueCents,0)).toBe(80000)
    await refund(next,undefined,0,'C548B')
    expect((await settlePointsForOrder(c,'O548')).expected).toBe(0)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(0)
  })
  test('停用积分时资金照常，恢复后沿原链补冲销', async () => {
    const [row]=await setup(); await settlePointsForOrder(c,'O548')
    const previous=process.env.POINTS_ACCRUAL_ENABLED
    process.env.POINTS_ACCRUAL_ENABLED='false'
    try { await refund(row) } finally { if(previous===undefined) delete process.env.POINTS_ACCRUAL_ENABLED; else process.env.POINTS_ACCRUAL_ENABLED=previous }
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(8)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(-8)
  })
  test('积分故障由SAVEPOINT隔离，现金退款与来源扣减保留供重算', async () => {
    const [row]=await setup(); await settlePointsForOrder(c,'O548')
    await c.query("CREATE FUNCTION pg_temp.reject548() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '548 points injected failure'; END $$")
    await c.query("CREATE TRIGGER reject548 BEFORE INSERT OR UPDATE ON point_transactions FOR EACH ROW EXECUTE FUNCTION pg_temp.reject548()")
    await refund(row)
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(1000)
    expect((await c.query("SELECT 1 FROM operation_logs WHERE action='points.settleFailed' AND target_id='O548'")).rows).toHaveLength(1)
    await c.query('DROP TRIGGER reject548 ON point_transactions')
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(-8)
  })

  test('历史多代来源缺失时拒绝退款，不以标价伪填', async () => {
    await setup()
    await c.query("UPDATE sale_items SET conversion_value_snapshot=NULL WHERE sale_order_id='C548'")
    await c.query("UPDATE sale_orders SET sale_order_type='转换单' WHERE sale_order_id='O548'")
    await recalcPaidSessionsForOrder(c,'C548')
    const row=(await c.query("SELECT * FROM sale_items WHERE sale_item_id='IN548-0'")).rows[0]
    expect(row.conversion_value_snapshot).toBeNull()
    await c.query('SAVEPOINT unknown_source')
    await expect(refund(row)).rejects.toThrow('来源尚未确认')
    await c.query('ROLLBACK TO SAVEPOINT unknown_source')
    expect(Number((await c.query("SELECT refunded_amount FROM sale_orders WHERE sale_order_id='C548'")).rows[0].refunded_amount)).toBe(0)
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

  test('带ref_sale_order_id的800折抵+200实收转换，原链10点全冲且不复发', async () => {
    const [row]=await setup({linked:true})
    await recalcPaidSessionsForOrder(c,'C548')
    const value=(await c.query("SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id=$1",[row.sale_item_id])).rows[0].conversion_value_snapshot
    expect(value.sources.filter(s=>s.pointOrderId==='O548').reduce((sum,s)=>sum+s.valueCents,0)).toBe(100000)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(10)
    await refund(row)
    expect((await settlePointsForOrder(c,'O548')).expected).toBe(0)
    expect((await settlePointsForOrder(c,'O548')).delta).toBe(0)
    expect(Number((await c.query("SELECT received FROM sale_orders WHERE sale_order_id='C548'")).rows[0].received)).toBe(200)
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

  test('来源凭据丢失时拒绝积分复发，已有快照差额由只读审计发现', async () => {
    const [row]=await setup({linked:true}); await settlePointsForOrder(c,'O548'); await refund(row);
    const {CONVERSION_SOURCE_AUDIT_SQL}=require('../../utils/conversion-sources');
    expect((await c.query(CONVERSION_SOURCE_AUDIT_SQL)).rows).toHaveLength(0);
    await c.query("UPDATE sale_order_payments SET note=(public.try_jsonb(note) #- '{items,0,conversionSources}')::text WHERE sale_order_id='C548' AND change_type='退款'");
    await c.query('SAVEPOINT bad_source');
    await expect(settlePointsForOrder(c,'O548')).rejects.toThrow('积分来源不完整');
    await c.query('ROLLBACK TO SAVEPOINT bad_source');
    expect((await c.query(CONVERSION_SOURCE_AUDIT_SQL)).rows.some(r=>r.reason==='refund-source-evidence-incomplete')).toBe(true);
    await c.query("UPDATE sale_items SET conversion_value_snapshot=jsonb_set(conversion_value_snapshot,'{valueCents}','1'::jsonb) WHERE sale_item_id='IN548-0'");
    expect((await c.query(CONVERSION_SOURCE_AUDIT_SQL)).rows.some(r=>r.reason==='snapshot-invalid-or-money-mismatch')).toBe(true);
    expect(Number((await c.query("SELECT points_balance FROM client_wechat_users WHERE user_id='T548'")).rows[0].points_balance)).toBe(0);
  })
  test('快照本金被改坏时退款拒绝，而诊断记录不回滚正常资金', async () => {
    const [row]=await setup();
    await c.query("UPDATE sale_items SET conversion_value_snapshot=jsonb_set(conversion_value_snapshot,'{valueCents}','90000'::jsonb)||jsonb_build_object('sources',jsonb_build_array(jsonb_build_object('sourceOrderId','O548','pointOrderId','O548','valueCents',90000))) WHERE sale_item_id='IN548-0'");
    await c.query('SAVEPOINT bad_value');
    await expect(refund(row)).rejects.toThrow('本金与已付金额不一致');
    await c.query('ROLLBACK TO SAVEPOINT bad_value');
  })

})
