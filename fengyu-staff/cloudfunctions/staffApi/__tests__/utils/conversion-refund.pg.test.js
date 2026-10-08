// 仅一次性本地库；显式环境变量，禁止使用业务 PG_CONNECTION_STRING。
const { Client } = require('pg')
const { recalcPaidSessionsForOrder } = require('../../utils/paid-sessions')
const { CONVERSION_RECEIPT_SQL, getConversionDebt } = require('../../utils/conversion-value')
const { cascadeRefund } = require('../../helpers/refund-cascade')
const { grantPointBatch } = require('../../utils/points')
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
  async function setup({ old = 800, cash = 200, amounts = [1000], home = false, used = 0 } = {}) {
    for (const [id, total, received, type] of [['O548', old, old, '销售单'], ['C548', Math.max(0, amounts.reduce((a,b)=>a+b,0)-old), cash, '转换单']]) {
      await c.query(`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,total_amount,payment_method,received,status,sale_order_type,client_user_id,paid_at)
        VALUES($1,'测试','T548',NOW(),$2,'线下',$3,'已支付',$4,'T548',NOW())`, [id,total,received,type])
    }
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
  async function refund(row, quantity, fee = 0) {
    const built=buildRefundDetails([{...row,picked_quantity:Number(row.picked_up_quantity||0),converted_amount:0,converted_quantity:0}], [{saleItemId:row.sale_item_id,refundQuantity:quantity}])
    const items=allocateRefundAccounting(built.refundDetails,new Map([[row.sale_item_id,Number(row.received)]]),fee)
    const note={conversionRefund:true,refundAccountingVersion:2,handlingFee:fee,items}
    const res=await c.query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,note,ref_sale_item_id,session_count,source_end) VALUES('C548','退款',$1,'线下','已支付',$2,$3,$4,'staff') RETURNING id",[-(built.totalRefund-fee),JSON.stringify(note),row.sale_item_id,items[0].quantity])
    await c.query("UPDATE sale_orders SET refunded_amount=(SELECT -SUM(amount) FROM sale_order_payments WHERE sale_order_id='C548' AND change_type='退款' AND status='已支付') WHERE sale_order_id='C548'")
    await cascadeRefund(c,{saleOrderId:'C548',refundPaymentId:res.rows[0].id,items:items.map(it=>({saleItemId:it.refSaleItemId,sessionCount:it.quantity,refundAmount:it.refundAmount,isFullItemRefund:it.isFullItemRefund})),isWholeOrderRefund:false,refundReason:'测试'})
    await recalcPaidSessionsForOrder(c,'C548')
    return built.totalRefund
  }
  test('800折抵+200现金退1000；负receipt，不伪造收款，不恢复旧卡，重算不复活',async()=>{
    const [row]=await setup(); expect(Number(row.received)).toBe(1000)
    expect(await refund(row)).toBe(1000)
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
    if(debt>0){await c.query("UPDATE sale_orders SET received=received+$1 WHERE sale_order_id='C548'",[debt]);const deltas=await c.query(CONVERSION_RECEIPT_SQL,['C548',debt]);expect(deltas.rows.map(r=>[r.sale_item_id,Number(r.amount)])).toEqual([[b.sale_item_id,debt]])}
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
})
