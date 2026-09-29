/** #300：对真实款项视图及生产写入 helper 验证历史月份冻结。
 * SHENGMEI_PG_TEST_URL 仅允许本地独立测试库；每例事务回滚。
 * node --test db/scripts/__tests__/shengmei-freeze.pg.test.js
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const { capturePaymentAllocatables } = require('../../../fengyu-staff/cloudfunctions/staffApi/utils/payment-allocatable')
const { recalcPaidSessionsForOrder } = require('../../../fengyu-staff/cloudfunctions/staffApi/utils/paid-sessions')
const url = process.env.SHENGMEI_PG_TEST_URL
const root = path.resolve(__dirname, '../../..')
const src = fs.readFileSync(path.join(root, 'fengyu-admin/src/actions/data-center/sales.ts'), 'utf8')
const block = src.slice(src.indexOf('const runShengmeiRevenue'), src.indexOf('const runStoreConsume'))
const sql = block.match(/sql`([\s\S]*?)`/)[1]
  .replace(/\$\{scopeFilterSql\([^}]+\)\}/, "so.store_id = 'T300_ST'")
  .replace(/\$\{range.start\}/g, '$1').replace(/\$\{range.end\}/g, '$2')

if (!url) test('生美历史月份冻结（未设 SHENGMEI_PG_TEST_URL）', { skip: true }, () => {})
else {
  let db
  test.before(async () => {
    const host = new URL(url).hostname
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(host), '只允许本地测试库')
    db = new Client({ connectionString: url }); await db.connect()
    const { rows } = await db.query('SELECT current_database() AS name')
    assert.ok(!['fengyu_wxapp','fengyu_e2e'].includes(rows[0].name), '拒绝业务库和共享 e2e 库')
  })
  test.after(async () => { if (db) await db.end() })
  test.beforeEach(async () => {
    await db.query('BEGIN')
    await db.query("INSERT INTO org_nodes(id,name,type) VALUES ('T300_HQ','测试总部','总部')")
    await db.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('T300_MK','测试市场','市场','T300_HQ')")
    await db.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('T300_ORG','测试门店','门店','T300_MK')")
    await db.query("INSERT INTO stores(store_id,store_name,org_node_id,opening_date) VALUES ('T300_ST','测试门店','T300_ORG','2026-01-01')")
  })
  test.afterEach(async () => { await db.query('ROLLBACK') })
  async function order(type = '销售单') {
    await db.query(`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,total_amount,received,payment_method,status,sale_order_type,performance_attribution_date)
      VALUES ('T300_SO','测试市场','T300_ST','2026-07-10 12:00:00+08',1000,400,'线下','部分支付',$1,'2026-07-10')`, [type])
  }
  async function item(id, direction, price, received, shengmei) {
    await db.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,item_direction,unit_price,unit_real_price,sale_amount,received,is_shengmei)
      VALUES ($1,'T300_SO','T300_ST',$2,ABS($3::numeric),ABS($3::numeric),$3,$4,$5)`, [id,direction,price,received,shengmei])
  }
  async function payment(type, amount, month) {
    const { rows } = await db.query(`INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end,paid_at)
      VALUES ('T300_SO',$1,$2,'线下','已支付','staff',$3) RETURNING id`, [type,amount,`2026-${month}-10 12:00:00+08`])
    return rows[0].id
  }
  async function capture(type, amount, month) {
    const id = await payment(type, amount, month)
    await capturePaymentAllocatables(db, { saleOrderId:'T300_SO',salePaymentId:id,eventAmount:amount })
    await recalcPaidSessionsForOrder(db, 'T300_SO')
    return id
  }
  const month = async (m) => (await db.query(sql, [`2026-${m}-01`,`2026-${m}-31`])).rows[0].v
  test('部分支付销售单 M+1 回款结清不补入 M 月', async () => {
    await order(); await item('T300_BUY','购买',1000,400,true)
    await capture('首次支付',400,'07')
    const before = await month('07'); assert.equal(before,'400.00')
    await db.query("UPDATE sale_orders SET received=1000,status='已支付' WHERE sale_order_id='T300_SO'")
    await capture('回款',600,'08')
    assert.equal(await month('07'),before); assert.equal(await month('08'),'600.00')
  })
  test('整单退款只在退款月记负数，原月正数不消失', async () => {
    await order(); await item('T300_BUY','购买',1000,1000,true)
    await db.query("UPDATE sale_orders SET received=1000,status='已支付' WHERE sale_order_id='T300_SO'")
    await capture('首次支付',1000,'07'); const before = await month('07')
    await db.query("UPDATE sale_orders SET refunded_amount=1000,status='已退款' WHERE sale_order_id='T300_SO'")
    const id = await payment('退款',-1000,'08')
    await db.query("INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount) VALUES ($1,'T300_SO','T300_BUY',-1000)", [id])
    await recalcPaidSessionsForOrder(db,'T300_SO')
    assert.equal(await month('07'),before); assert.equal(await month('08'),'-1000.00')
  })
  test('部分支付转换单后续回款：生美转入、非生美转出残差不跳月', async () => {
    await order('转换单')
    await item('T300_OUT','转出',-1000,-1000,false)
    await item('T300_IN','转入',2000,1400,true)
    await capture('首次支付',400,'07')
    const before = await month('07'); assert.equal(before,'1400.00')
    await db.query("UPDATE sale_orders SET received=1000,status='已支付' WHERE sale_order_id='T300_SO'")
    await capture('回款',600,'08')
    assert.equal(await month('07'),before); assert.equal(await month('08'),'600.00')
  })
  test('已关闭残差排除，但已落账 receipt 不受父单关闭影响', async () => {
    await order('转换单'); await item('T300_IN','转入',2000,1400,true)
    await db.query("UPDATE sale_orders SET status='已关闭' WHERE sale_order_id='T300_SO'")
    assert.equal(await month('07'),'0')
    const id = await payment('首次支付',400,'07')
    await db.query("INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount) VALUES ($1,'T300_SO','T300_IN',400)", [id])
    assert.equal(await month('07'),'400.00')
  })
}
