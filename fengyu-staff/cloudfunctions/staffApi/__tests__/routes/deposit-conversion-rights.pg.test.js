/** Run against a disposable database with CONVERSION_RIGHTS_PG_URL. */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const { retainedRefundFeeSql } = require('../../utils/refund-fee-sql')
const orderRoutes = require('../../routes/order')
const { createManagerCtx } = require('../helpers')
const pg = globalThis.__mocks__.pg
const url = process.env.CONVERSION_RIGHTS_PG_URL

describe.skipIf(!url)('寄存退款后的转换：真实 PostgreSQL 复算', () => {
  let client, deductibleSql
  beforeAll(async () => {
    const target = new URL(url)
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/conversion_test') {
      throw new Error('本测试只允许本机独立 conversion_test 数据库')
    }
    client = new Client({ connectionString: url })
    await client.connect()
    const source = fs.readFileSync(path.resolve(__dirname, '../../routes/order.js'), 'utf8')
    const template = source.match(/const deductibleResult = await tx\.query\(\s*`([\s\S]*?)`,\s*\[convertOutSaleItemIds\]/)?.[1]
    expect(template).toBeTruthy()
    deductibleSql = new Function('retainedRefundFeeSql', 'return `' + template + '`')(retainedRefundFeeSql)
    await client.query(`
      CREATE OR REPLACE FUNCTION public.try_jsonb(text) RETURNS jsonb LANGUAGE sql AS 'SELECT $1::jsonb';
      CREATE OR REPLACE FUNCTION public.try_numeric(text) RETURNS numeric LANGUAGE sql AS 'SELECT $1::numeric';
      CREATE TEMP TABLE sale_orders (sale_order_id text PRIMARY KEY, sale_order_type text, status text);
      CREATE TEMP TABLE sale_items (
        sale_item_id text PRIMARY KEY, sale_order_id text, ref_sale_item_id text,
        item_direction text DEFAULT '购买', product_type text DEFAULT '疗程卡',
        session_count integer, remaining_sessions integer, paid_sessions integer,
        quantity numeric DEFAULT 1, picked_up_quantity numeric DEFAULT 0,
        refunded_quantity numeric DEFAULT 0, converted_quantity numeric DEFAULT 0,
        unit_real_price numeric DEFAULT 80, sale_amount numeric DEFAULT 480, received numeric DEFAULT 480
      );
      CREATE TEMP TABLE sale_order_payments (sale_order_id text, status text, change_type text, note text);
    `)
  })
  afterAll(async () => { await client?.end() })
  beforeEach(async () => {
    await client.query('TRUNCATE sale_items, sale_orders, sale_order_payments')
    await client.query("INSERT INTO sale_orders VALUES ('deposit', '寄存单', '已支付')")
    await client.query("INSERT INTO sale_items (sale_item_id, sale_order_id, session_count, remaining_sessions, paid_sessions) VALUES ('B', 'deposit', 6, 6, 6)")
  })
  async function seed(remaining, paid) {
    await client.query('INSERT INTO sale_items (sale_item_id, sale_order_id, session_count, remaining_sessions, paid_sessions) VALUES ($1, $2, 6, $3, $4)', ['A', 'deposit', remaining, paid])
  }
  test.each([[2, 4, 0], [5, 4, 3], [5, 6, 5], [5, null, 5]])('remaining=%s paid=%s ⇒ quantity=%s', async (remaining, paid, expected) => {
    await seed(remaining, paid)
    const { rows: [row] } = await client.query(deductibleSql, [['A']])
    expect(Number(row.deductible_quantity)).toBe(expected)
    expect(Number(row.deductible_amount)).toBe(expected * 80)
    if (expected > 0) {
      await client.query('UPDATE sale_items SET remaining_sessions = remaining_sessions - $2 WHERE sale_item_id = $1', ['A', expected])
      const { rows: [after] } = await client.query("SELECT session_count, remaining_sessions, paid_sessions FROM sale_items WHERE sale_item_id = 'A'")
      expect(after.session_count - after.remaining_sessions).toBeLessThanOrEqual(paid ?? 6)
      const { rows: [again] } = await client.query(deductibleSql, [['A']])
      expect(Number(again.deductible_quantity)).toBe(0)
    }
  })
  test('直接提交已退光行：真实复算后拒绝，事务未写订单、权益或余额', async () => {
    await seed(2, 4)
    pg.query.mockResolvedValueOnce([{ user_id: 'cu-001', phone: '138', name: '顾客', customer_type: '会员客', bound_store_id: 'store-001' }])
    const writes = []
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: async (sql, params) => {
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(sql)) writes.push(sql)
      if (sql.includes('deductible_quantity')) return client.query(sql, params)
      if (sql.includes('FOR UPDATE OF si')) return { rows: [{ sale_item_id: 'A', sale_order_id: 'deposit', client_user_id: 'cu-001', store_id: 'store-001', item_direction: '购买', sale_order_type: '寄存单', order_status: '已支付', product_type: '疗程卡', session_count: 6, remaining_sessions: 2, paid_sessions: 4, unit_real_price: '80' }] }
      return { rows: [], rowCount: 0 }
    } }))
    const ctx = createManagerCtx({ clientUserId: 'cu-001', convertOutSaleItemIds: ['A'], convertInItems: [{ skuId: 'new', quantity: 1 }], paymentMethod: '线下' })
    await expect(orderRoutes.createConversion(ctx)).rejects.toThrow('DEDUCTIBLE_EMPTY')
    expect(writes).toEqual([])
  })
})
