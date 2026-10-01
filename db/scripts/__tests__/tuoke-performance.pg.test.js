/** #494：只在本地隔离 PostgreSQL 运行；每例事务回滚。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')

const url = process.env.TUOKE_PG_TEST_URL
if (!url) {
  test('拓客业绩视图（未设 TUOKE_PG_TEST_URL）', { skip: true }, () => {})
} else {
  let db
  test.before(async () => {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    db = new Client({ connectionString: url })
    await db.connect()
    const { rows } = await db.query('SELECT current_database() AS name')
    assert.ok(!['fengyu_wxapp', 'fengyu_e2e'].includes(rows[0].name))
  })
  test.after(async () => { if (db) await db.end() })
  test.beforeEach(async () => {
    await db.query('BEGIN')
    await db.query("INSERT INTO org_nodes(id,name,type) VALUES ('T494_HQ','测试总部','总部')")
    await db.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('T494_MK','测试市场','市场','T494_HQ')")
    await db.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('T494_ORG','测试门店','门店','T494_MK')")
    await db.query("INSERT INTO stores(store_id,store_name,org_node_id,opening_date) VALUES ('T494_ST','测试门店','T494_ORG','2026-01-01')")
    await db.query(`INSERT INTO product_categories(category_id,category_name,product_kind) VALUES
      ('T494_T','地推拓客卡','拓客引流卡'),('T494_N','正常项目','王牌')`)
    await db.query(`INSERT INTO product_skus(sku_id,category_id,product_type,spec_name,price,session_count,is_shengmei) VALUES
      ('T494_SK_T','T494_T','疗程卡','拓客卡',68,1,true),
      ('T494_SK_N','T494_N','疗程卡','普通项目',100,1,true)`)
  })
  test.afterEach(async () => { await db.query('ROLLBACK') })

  async function order(id, amount, type = '销售单') {
    await db.query(`INSERT INTO sale_orders
      (sale_order_id,market_name,store_id,sale_order_datetime,total_amount,received,
       payment_method,status,sale_order_type,performance_attribution_date)
      VALUES ($1,'测试市场','T494_ST','2026-09-08 12:00:00+08',$2,$2,'线下','已支付',$3,'2026-09-08')`, [id, amount, type])
  }
  async function item(id, orderId, sku, amount) {
    await db.query(`INSERT INTO sale_items
      (sale_item_id,sale_order_id,store_id,sku_id,product_type,item_direction,
       unit_price,unit_real_price,sale_amount,received,is_shengmei)
      VALUES ($1,$2,'T494_ST',$3,'疗程卡',$4,ABS($5::numeric),ABS($5::numeric),$5,$5,true)`,
    [id, orderId, sku, amount < 0 ? '转出' : '购买', amount])
  }
  async function payment(orderId, amount, changeType = '首次支付', date = '2026-09-08', method = '线下') {
    const { rows } = await db.query(`INSERT INTO sale_order_payments
      (sale_order_id,change_type,amount,payment_method,status,source_end,paid_at)
      VALUES ($1,$2,$3,$5,'已支付','staff',$4::date + TIME '12:00:00') RETURNING id`,
    [orderId, changeType, amount, date, method])
    return rows[0].id
  }
  async function receipt(paymentId, orderId, itemId, amount) {
    await db.query(`INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount)
      VALUES ($1,$2,$3,$4)`, [paymentId, orderId, itemId, amount])
  }
  async function amounts(paymentId) {
    const p = (await db.query(`SELECT amount::text,performance_amount::text,attribution_mode,performance_date::text
      FROM sale_reportable_payment_events WHERE sale_payment_id=$1`, [paymentId])).rows[0]
    const items = (await db.query(`SELECT sale_item_id,amount::text,performance_amount::text,product_kind_at_sale
      FROM sale_reportable_item_events WHERE sale_payment_id=$1 ORDER BY sale_item_id`, [paymentId])).rows
    return { p, items }
  }

  test('纯拓客及其退款为零；普通销售与退款保留有符号净额', async () => {
    await order('T494_SO_T', 68); await item('T494_IT_T', 'T494_SO_T', 'T494_SK_T', 68)
    const t = await payment('T494_SO_T', 68); await receipt(t, 'T494_SO_T', 'T494_IT_T', 68)
    assert.equal((await amounts(t)).p.performance_amount, '0.00')
    const tr = await payment('T494_SO_T', -68, '退款', '2026-10-02')
    await receipt(tr, 'T494_SO_T', 'T494_IT_T', -68)
    assert.equal((await amounts(tr)).p.performance_amount, '0.00')

    await order('T494_SO_N', 100); await item('T494_IT_N', 'T494_SO_N', 'T494_SK_N', 100)
    const n = await payment('T494_SO_N', 100); await receipt(n, 'T494_SO_N', 'T494_IT_N', 100)
    assert.equal((await amounts(n)).p.performance_amount, '100.00')
    const nr = await payment('T494_SO_N', -40, '退款', '2026-10-02')
    await receipt(nr, 'T494_SO_N', 'T494_IT_N', -40)
    assert.equal((await amounts(nr)).p.performance_amount, '-40.00')
    assert.equal((await amounts(nr)).items[0].performance_amount, '-40.00')
  })

  test('负拓客转换款 5000 封顶，普通子项逐分相加为 5000', async () => {
    await order('T494_SO_M', 5000, '转换单')
    await item('T494_IT_T', 'T494_SO_M', 'T494_SK_T', -168)
    const normals = [2980, 1490, 298, 200, 200]
    for (let i = 0; i < normals.length; i++) await item(`T494_IT_N${i}`, 'T494_SO_M', 'T494_SK_N', normals[i])
    const id = await payment('T494_SO_M', 5000)
    await receipt(id, 'T494_SO_M', 'T494_IT_T', -168)
    for (let i = 0; i < normals.length; i++) await receipt(id, 'T494_SO_M', `T494_IT_N${i}`, normals[i])
    const result = await amounts(id)
    assert.equal(result.p.performance_amount, '5000.00')
    assert.equal(result.items.find(r => r.sale_item_id === 'T494_IT_T').performance_amount, '0.00')
    assert.equal(Math.round(result.items.reduce((sum, r) => sum + Number(r.performance_amount), 0) * 100), 500000)
  })

  test('正向混合只计普通份额；款项与 receipt 金额不等时仍按实收封顶', async () => {
    await order('T494_SO_A', 1000)
    await item('T494_IT_A_N', 'T494_SO_A', 'T494_SK_N', 900)
    await item('T494_IT_A_T', 'T494_SO_A', 'T494_SK_T', 100)
    const mixed = await payment('T494_SO_A', 1000)
    await receipt(mixed, 'T494_SO_A', 'T494_IT_A_N', 900)
    await receipt(mixed, 'T494_SO_A', 'T494_IT_A_T', 100)
    assert.equal((await amounts(mixed)).p.performance_amount, '900.00')

    await order('T494_SO_B', 4300)
    await item('T494_IT_B', 'T494_SO_B', 'T494_SK_N', 9800)
    const mismatch = await payment('T494_SO_B', 4300)
    await receipt(mismatch, 'T494_SO_B', 'T494_IT_B', 9800)
    const result = await amounts(mismatch)
    assert.equal(result.p.performance_amount, '4300.00')
    assert.equal(result.items[0].performance_amount, '4300.00')
  })

  test('receipt 缺口与历史残差并存时不把同一金额算两次', async () => {
    await order('T494_SO_RES', 1000)
    await item('T494_IT_RES', 'T494_SO_RES', 'T494_SK_N', 1000)
    const id = await payment('T494_SO_RES', 1000)
    await receipt(id, 'T494_SO_RES', 'T494_IT_RES', 900)
    const { rows } = await db.query(`SELECT is_legacy_residual, amount::text, performance_amount::text
      FROM sale_reportable_item_events WHERE sale_order_id='T494_SO_RES'
      ORDER BY is_legacy_residual`)
    assert.deepEqual(rows.map(r => [r.is_legacy_residual, r.amount, r.performance_amount]), [
      [false, '900.00', '900.00'], [true, '100.00', '100.00'],
    ])
    assert.equal((await amounts(id)).p.performance_amount, '1000.00')

    await order('T494_SO_RES_NEG', -1000)
    await item('T494_IT_RES_NEG', 'T494_SO_RES_NEG', 'T494_SK_N', -1000)
    const refund = await payment('T494_SO_RES_NEG', -1000, '退款')
    await receipt(refund, 'T494_SO_RES_NEG', 'T494_IT_RES_NEG', -900)
    const { rows: negativeRows } = await db.query(`SELECT is_legacy_residual, performance_amount::text
      FROM sale_reportable_item_events WHERE sale_order_id='T494_SO_RES_NEG'
      ORDER BY is_legacy_residual`)
    assert.deepEqual(negativeRows.map(r => [r.is_legacy_residual, r.performance_amount]), [
      [false, '-900.00'], [true, '-100.00'],
    ])
    assert.equal((await amounts(refund)).p.performance_amount, '-1000.00')
  })

  test('储值卡抵扣只进普通子项，不进组织现金业绩；拓客卡抵扣仍为零', async () => {
    await order('T494_SO_CARD', 120)
    await item('T494_IT_CARD_N', 'T494_SO_CARD', 'T494_SK_N', 120)
    const card = await payment('T494_SO_CARD', 30, '储值卡抵扣', '2026-09-08', '储值卡')
    await receipt(card, 'T494_SO_CARD', 'T494_IT_CARD_N', 30)
    const cardResult = await amounts(card)
    assert.equal(cardResult.p.performance_amount, '0.00')
    assert.equal(cardResult.items[0].performance_amount, '30.00')
    const cash = await payment('T494_SO_CARD', 90)
    await receipt(cash, 'T494_SO_CARD', 'T494_IT_CARD_N', 90)
    assert.equal((await amounts(cash)).p.performance_amount, '90.00')
    assert.equal((await amounts(cash)).items[0].performance_amount, '90.00')

    await order('T494_SO_CARD_T', 20)
    await item('T494_IT_CARD_T', 'T494_SO_CARD_T', 'T494_SK_T', 20)
    const tuokeCard = await payment('T494_SO_CARD_T', 20, '储值卡抵扣', '2026-09-08', '储值卡')
    await receipt(tuokeCard, 'T494_SO_CARD_T', 'T494_IT_CARD_T', 20)
    assert.equal((await amounts(tuokeCard)).p.performance_amount, '0.00')
    assert.equal((await amounts(tuokeCard)).items[0].performance_amount, '0.00')

    await order('T494_SO_CARD_M', 100, '转换单')
    await item('T494_IT_CARD_MN', 'T494_SO_CARD_M', 'T494_SK_N', 120)
    await item('T494_IT_CARD_MT', 'T494_SO_CARD_M', 'T494_SK_T', -20)
    const mixedCard = await payment('T494_SO_CARD_M', 100, '储值卡抵扣', '2026-09-08', '储值卡')
    await receipt(mixedCard, 'T494_SO_CARD_M', 'T494_IT_CARD_MN', 120)
    await receipt(mixedCard, 'T494_SO_CARD_M', 'T494_IT_CARD_MT', -20)
    const mixed = await amounts(mixedCard)
    assert.equal(mixed.p.performance_amount, '0.00')
    assert.equal(mixed.items.find(row => row.sale_item_id === 'T494_IT_CARD_MN').performance_amount, '100.00')
    assert.equal(mixed.items.find(row => row.sale_item_id === 'T494_IT_CARD_MT').performance_amount, '0.00')
  })

  test('缺失一级品项按未分类保留实收；零分母差额显式归未分类', async () => {
    await db.query("INSERT INTO product_categories(category_id,category_name,product_kind) VALUES ('T494_U','待归类',NULL)")
    await db.query("INSERT INTO product_skus(sku_id,category_id,product_type,spec_name,price,session_count) VALUES ('T494_SK_U','T494_U','疗程卡','待归类',50,1)")
    await order('T494_SO_U', 50)
    await item('T494_IT_U', 'T494_SO_U', 'T494_SK_U', 50)
    const id = await payment('T494_SO_U', 50)
    await receipt(id, 'T494_SO_U', 'T494_IT_U', 50)
    const result = await amounts(id)
    assert.equal(result.p.attribution_mode, 'missing_category')
    assert.equal(result.p.performance_amount, '50.00')
    assert.equal(result.items[0].performance_amount, '50.00')
    assert.equal(result.items[0].product_kind_at_sale, null)
  })

  test('充值及无明细款项显式兜底；零分母不会静默丢款', async () => {
    await order('T494_SO_C', 2000, '充值单')
    const recharge = await payment('T494_SO_C', 2000)
    assert.deepEqual((await amounts(recharge)).p.attribution_mode, 'recharge')
    assert.equal((await amounts(recharge)).p.performance_amount, '2000.00')
    await order('T494_SO_D', 50)
    const noReceipt = await payment('T494_SO_D', 50)
    assert.equal((await amounts(noReceipt)).p.attribution_mode, 'no_receipt')
    assert.equal((await amounts(noReceipt)).p.performance_amount, '50.00')
    await order('T494_SO_E', 50)
    await item('T494_IT_E1', 'T494_SO_E', 'T494_SK_N', 100)
    await item('T494_IT_E2', 'T494_SO_E', 'T494_SK_N', -100)
    const zero = await payment('T494_SO_E', 50)
    await receipt(zero, 'T494_SO_E', 'T494_IT_E1', 100)
    await receipt(zero, 'T494_SO_E', 'T494_IT_E2', -100)
    assert.equal((await amounts(zero)).p.attribution_mode, 'zero_denominator')
    assert.equal((await amounts(zero)).p.performance_amount, '50.00')
    const classified = (await amounts(zero)).items.reduce((sum, row) => sum + Number(row.performance_amount), 0)
    assert.equal(classified, 0)
    assert.equal(Number((await amounts(zero)).p.performance_amount) - classified, 50)
  })

  test('下单品项冻结；分类后来调整不改历史，归属日期按款项走', async () => {
    await order('T494_SO_F', 68)
    await item('T494_IT_F', 'T494_SO_F', 'T494_SK_T', 68)
    const first = await payment('T494_SO_F', 68)
    await receipt(first, 'T494_SO_F', 'T494_IT_F', 68)
    await db.query("UPDATE product_categories SET product_kind='王牌' WHERE category_id='T494_T'")
    await db.query("UPDATE sale_items SET sku_id=sku_id WHERE sale_item_id='T494_IT_F'")
    assert.equal((await amounts(first)).p.performance_amount, '0.00')
    assert.equal((await amounts(first)).items[0].product_kind_at_sale, '拓客引流卡')
    const refund = await payment('T494_SO_F', -68, '退款', '2026-10-02')
    await receipt(refund, 'T494_SO_F', 'T494_IT_F', -68)
    assert.equal((await amounts(refund)).p.performance_date, '2026-10-02')
    assert.equal((await amounts(refund)).p.performance_amount, '0.00')
  })
}
