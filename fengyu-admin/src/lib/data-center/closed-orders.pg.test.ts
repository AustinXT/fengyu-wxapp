// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const { execute, session, range } = vi.hoisted(() => ({
  execute: vi.fn(),
  session: {
    employeeId: 'TEST', roles: [{ role: 'admin', scopeType: '总部', isSuperAdmin: true }],
    permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] },
  },
  range: { start: '2026-08-26', end: '2026-09-25' },
}))
vi.mock('@/db', () => ({ db: { execute } }))
vi.mock('@/lib/with-permission', () => ({
  withPermission: (_action: string, fn: (s: unknown, p: unknown) => unknown) =>
    (params: unknown) => fn(session, params),
}))
vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: async (s: unknown, p: { scope: unknown }) => ({
    scope: p.scope, meta: {}, enabled: false,
    comparison: { current: range, previous: null, lastYear: null },
  }),
}))

import { getSalesBoard } from '@/actions/data-center/sales'
import { getEfficiencyBoard } from '@/actions/data-center/efficiency'
import { dailyOverviewQueries, performanceTotalSql } from './daily-overview-sql'
import type { AuthSession } from '@/lib/types'

// 仅连接本地专用测试库；复用真实 action 生成的 SQL，非金额查询返回空行以隔离无关维度。
const testUrl = process.env.CLOSED_ORDER_TEST_URL
const dialect = new PgDialect()
const root = path.resolve(__dirname, '../../../..')
describe.skipIf(!testUrl)('数据中心关闭订单 PostgreSQL 回归', () => {
  let pg: Client
  const captured: Array<{ sql: string; params: unknown[]; rows: Record<string, unknown>[] }> = []
  const params = { scope: { type: 'store' as const, id: 'A' }, timeRange: { preset: 'month' as const }, withComparison: false }

  async function query(fragment: SQL) {
    const q = dialect.sqlToQuery(fragment)
    return (await pg.query(q.sql, q.params)).rows
  }

  beforeAll(async () => {
    const url = new URL(testUrl!)
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname)
    expect(url.pathname).toBe('/closed_order_test')
    expect([...url.searchParams.keys()]).toEqual([])
    pg = new Client({ connectionString: testUrl })
    await pg.connect()
    await pg.query(`
      CREATE TEMP TABLE org_nodes (id text PRIMARY KEY, parent_id text, type text, name text, is_active boolean);
      CREATE TEMP TABLE stores (store_id text PRIMARY KEY, org_node_id text, store_name text);
      CREATE TEMP TABLE sale_orders (
        sale_order_id text PRIMARY KEY, store_id text, sale_order_type text,
        status text, legacy_source text, client_user_id text DEFAULT 'C'
      );
      CREATE TEMP TABLE sale_order_payments (
        id bigserial PRIMARY KEY, sale_order_id text, change_type text, payment_method text DEFAULT '线下',
        status text DEFAULT '已支付', amount numeric(10,2), note text,
        performance_attribution_date date, paid_at timestamptz DEFAULT NOW(), created_at timestamptz DEFAULT NOW()
      );
      CREATE TEMP TABLE sale_items (sale_item_id text PRIMARY KEY, product_kind_at_sale text);
      CREATE TEMP TABLE sale_payment_item_receipts (sale_payment_id bigint, sale_item_id text, amount numeric);
      CREATE TEMP TABLE client_wechat_users (user_id text, customer_type text, became_member_at timestamptz);
      INSERT INTO org_nodes VALUES ('M',NULL,'市场','测试市场',true),('A','M','门店','A',true),('B','M','门店','B',true),('Z','M','门店','Z',true);
      INSERT INTO stores VALUES ('A','A','南昌锦城店'),('B','B','其他门店'),('Z','Z','仅关闭订单门店');
      INSERT INTO client_wechat_users VALUES ('C','会员客','2026-09-01');
      INSERT INTO sale_orders(sale_order_id,store_id,sale_order_type,status) VALUES
        ('sale','A','销售单','已支付'),('cancel','A','转换单','已关闭'),
        ('partial','B','销售单','部分支付'),('refunded','B','销售单','已退款'),
        ('closed-positive','B','销售单','已关闭'),('closed-recharge','B','充值单','已关闭'),
        ('only-closed','Z','转换单','已关闭');
      INSERT INTO sale_order_payments(sale_order_id,change_type,amount,performance_attribution_date) VALUES
        ('sale','首次支付',106692,'2026-09-22'),
        ('cancel','储值卡抵扣',200,'2026-08-13'),('cancel','退款',-200,'2026-08-26'),
        ('partial','首次支付',300,'2026-09-02'),
        ('refunded','首次支付',500,'2026-09-02'),('refunded','退款',-500,'2026-09-03'),
        ('closed-positive','首次支付',1000,'2026-09-01'),('closed-positive','回款',200,'2026-09-02'),
        ('closed-positive','退款',-100,'2026-09-03'),
        ('closed-recharge','首次支付',5000,'2026-09-01'),('only-closed','退款',-200,'2026-09-01');
    `)
    // 重放实际迁移中的款项视图，保留款项状态、拓客及充值判定。
    for (const [file, view] of [
      ['0041_bizarre_wolfpack.sql', 'sale_order_performance_events'],
      ['0057_oval_calypso.sql', 'sale_reportable_payment_events'],
    ]) {
      const source = fs.readFileSync(path.join(root, 'db/migrations', file), 'utf8')
      const ddl = source.match(new RegExp(`CREATE VIEW "public"\\."${view}" AS \\([\\s\\S]*?\\n\\);`))?.[0]
      expect(ddl).toBeTruthy()
      await pg.query(ddl!.replace('CREATE VIEW "public".', 'CREATE TEMP VIEW '))
    }
    execute.mockImplementation(async (fragment: SQL) => {
      const q = dialect.sqlToQuery(fragment)
      // 所有组织/客型业绩及门店排行均执行实际 SQL；技师/服务等不属于本回归的查询保持空集。
      if (!/SUM\(spe\.performance_amount::numeric\)/.test(q.sql)) return []
      const rows = (await pg.query(q.sql, q.params)).rows
      captured.push({ ...q, rows })
      return rows
    })
  })
  afterAll(async () => { await pg?.end() })

  it('复现 106492 与 106692 差额，销售 KPI 排除关闭单的 -200', async () => {
    const old = await pg.query(`SELECT SUM(performance_amount) AS v FROM sale_reportable_payment_events
      WHERE store_id='A' AND performance_date BETWEEN $1 AND $2`, [range.start, range.end])
    expect(Number(old.rows[0].v)).toBe(106492)
    const board = await getSalesBoard(params)
    expect(board.kpis.storeRevenue.value).toBe(106692)
    expect(board.kpis.newCustomerRevenue.value).toBe(106692)
  })

  it('同一门店明细与总业绩使用相同有效款项，正常部分支付和退款仍计入', async () => {
    captured.length = 0
    const board = await getSalesBoard({ ...params, scope: { type: 'store', id: 'B' } })
    expect(board.kpis.storeRevenue.value).toBe(300)
    const detail = captured.find((q) => /GROUP BY spe\.store_id/.test(q.sql))
    expect(detail?.rows.map((r) => [r.store_id, Number(r.v)])).toEqual([['B', 300]])
    // 已退款订单仍保留实际退款；只查退款当天应为负数，而非被状态白名单删掉。
    const refund = await query(performanceTotalSql(session as unknown as AuthSession, { type: 'store', id: 'B' }, {
      start: '2026-09-03', end: '2026-09-03',
    }))
    expect(Number(refund[0].v)).toBe(-500)
  })

  it('经营报表总业绩与销售 KPI 一致，关闭的充值单也不计入', async () => {
    const total = await query(performanceTotalSql(session as unknown as AuthSession, params.scope, range))
    expect(Number(total[0].v)).toBe(106692)
    const recharge = await query(dailyOverviewQueries(session as unknown as AuthSession, { type: 'store', id: 'B' }, range).recharge)
    expect(recharge).toEqual([])
  })

  it('人效合计与门店榜一致，只有关闭订单的门店保留为零', async () => {
    captured.length = 0
    await getEfficiencyBoard({ ...params, scope: { type: 'all' } })
    const total = captured.find((q) => !/GROUP BY|LEFT JOIN sale_reportable/.test(q.sql) && /AS v/.test(q.sql))
    const ranking = captured.find((q) => /LEFT JOIN sale_reportable_payment_events/.test(q.sql))
    expect(Number(total?.rows[0].v)).toBe(106992)
    expect(ranking?.rows.map((r) => [r.store_id, Number(r.value)])).toEqual([['A', 106692], ['B', 300], ['Z', 0]])
  })
})
