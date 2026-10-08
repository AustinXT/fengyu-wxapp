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
  let client, deductibleSql, rollbackSql
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
    rollbackSql = source.slice(source.indexOf('async function rollbackPendingConversionOnClose')).match(/`(UPDATE sale_items\nSET paid_sessions = CASE[\s\S]*?)`,/)?.[1]
    expect(rollbackSql).toBeTruthy()
    await client.query(`
      CREATE OR REPLACE FUNCTION public.try_jsonb(text) RETURNS jsonb LANGUAGE sql AS 'SELECT $1::jsonb';
      CREATE OR REPLACE FUNCTION public.try_numeric(text) RETURNS numeric LANGUAGE sql AS 'SELECT $1::numeric';
      DROP SCHEMA IF EXISTS conversion_case CASCADE;
      CREATE SCHEMA conversion_case;
      SET search_path = conversion_case, public;
      CREATE TABLE sale_orders (sale_order_id text PRIMARY KEY, sale_order_type text, status text, total_amount numeric DEFAULT 0);
      CREATE TABLE sale_items (
        sale_item_id text PRIMARY KEY, sale_order_id text, ref_sale_item_id text,
        item_direction text DEFAULT '购买', product_type text DEFAULT '疗程卡',
        session_count integer, remaining_sessions integer, paid_sessions integer,
        quantity numeric DEFAULT 1, picked_up_quantity numeric DEFAULT 0,
        refunded_quantity numeric DEFAULT 0, converted_quantity numeric DEFAULT 0,
        updated_at timestamp, unit_real_price numeric DEFAULT 80, sale_amount numeric DEFAULT 480, received numeric DEFAULT 480
      );
      CREATE TABLE sale_order_payments (sale_order_id text, status text, change_type text, note text);
    `)
  })
  afterAll(async () => { if (client) { await client.query('DROP SCHEMA IF EXISTS conversion_case CASCADE'); await client.end() } })
  beforeEach(async () => {
    await client.query('TRUNCATE sale_items, sale_orders, sale_order_payments')
    await client.query("INSERT INTO sale_orders (sale_order_id, sale_order_type, status) VALUES ('deposit', '寄存单', '已支付')")
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
  test('部分退款→转换→关单：真实回滚重算不会恢复已退次数', async () => {
    await seed(2, 4)
    await client.query("INSERT INTO sale_orders (sale_order_id, sale_order_type, status) VALUES ('conversion', '转换单', '待支付')")
    await client.query("INSERT INTO sale_items (sale_item_id, sale_order_id, ref_sale_item_id, item_direction, quantity) VALUES ('out-A', 'conversion', 'A', '转出', 3)")
    // The close handler restores the actual converted quantity, then executes this production SQL.
    await client.query("UPDATE sale_items SET remaining_sessions = remaining_sessions + 3 WHERE sale_item_id = 'A'")
    await client.query(rollbackSql, ['conversion', 'deposit'])
    const { rows: [row] } = await client.query("SELECT paid_sessions FROM sale_items WHERE sale_item_id = 'A'")
    expect(row.paid_sessions).toBe(4)
    const { rows: [again] } = await client.query(deductibleSql, [['A']])
    expect(Number(again.deductible_quantity)).toBe(3)
    expect(Number(again.deductible_amount)).toBe(240)
  })
  test('退款旧快照与转换交错：真实订单锁等待后拒绝申请，无退款写入', async () => {
    await seed(5, 6)
    const conversion = new Client({ connectionString: url })
    await conversion.connect()
    try {
    await conversion.query('SET search_path = conversion_case, public')
    await conversion.query('BEGIN')
    await conversion.query("SELECT sale_order_id FROM sale_orders WHERE sale_order_id = 'deposit' FOR UPDATE")
    await conversion.query("UPDATE sale_items SET remaining_sessions = 0 WHERE sale_item_id = 'A'")
    let signalLock
    const lockAttempted = new Promise((resolve) => { signalLock = resolve })
    pg.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT store_id')) return [{ store_id: 'store-001' }]
      if (sql.includes('SELECT * FROM sale_orders')) return [{ sale_order_id: 'deposit', sale_order_type: '寄存单', status: '已支付', received: 960, refunded_amount: 0 }]
      if (sql.includes('SELECT si.*')) return (await client.query('SELECT * FROM sale_items')).rows.map((r) => ({ ...r, unit_price: 80, picked_quantity: 0, converted_amount: 0, converted_quantity: 0 }))
      if (sql.includes('AS net')) return [{ net: 960 }]
      return []
    })
    const writes = []
    pg.transaction.mockImplementationOnce(async (cb) => {
      await client.query('BEGIN')
      try { return await cb({ query: async (sql, params) => {
        // Peripheral writes are recorded, not sent to the minimal fixture schema.
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(sql)) { writes.push(sql); return { rows: [{ id: 1 }], rowCount: 1 } }
        if (sql.startsWith('SELECT status FROM sale_orders')) signalLock()
        return client.query(sql, params)
      } }) } finally { await client.query('ROLLBACK') }
    })
    const ctx = createManagerCtx({ refSaleOrderId: 'deposit', items: [{ saleItemId: 'A', refundQuantity: 5 }], refundReason: '退卡' })
    const operation = orderRoutes.createRefund(ctx)
    // Observe the exact lock attempt before committing the conversion actor, avoiding timing guesses.
    await Promise.race([lockAttempted, operation.then(() => { throw new Error('退款未等待原单锁') })])
    await conversion.query('COMMIT')
    await expect(operation).rejects.toThrow('寄存权益已变化')
    expect(writes).toEqual([])
    } finally { await conversion.query('ROLLBACK'); await conversion.end() }
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
