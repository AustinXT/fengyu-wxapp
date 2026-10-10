// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgDialect, getViewConfig } from 'drizzle-orm/pg-core'
import { saleReportablePaymentEvents } from '@db/order'
import { Client } from 'pg'
import type { SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import { excludeLegacyPrepaidInflowSql } from './prepaid-performance-filter'
import { dailyOverviewQueries, performanceTotalSql } from './daily-overview-sql'

const root = path.resolve(__dirname, '../../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const require = createRequire(import.meta.url)
const staff = require(path.join(root, 'fengyu-staff/cloudfunctions/staffApi/utils/prepaid-performance-filter.js'))
const dialect = new PgDialect()

describe('旧储值转入排除口径', () => {
  it.each(['spe', 'so', 'o'])('两端 %s 别名的 SQL 逐字一致', (alias) => {
    const query = dialect.sqlToQuery(excludeLegacyPrepaidInflowSql(alias))
    expect(query.sql).toBe(staff.excludeLegacyPrepaidInflowSql(alias))
    expect(query.params).toEqual([])
  })

  it('只允许代码内的表别名，拒绝 SQL 注入', () => {
    for (const alias of ['spe; DROP TABLE sale_orders', 'spe.id', '']) {
      expect(() => excludeLegacyPrepaidInflowSql(alias)).toThrow('无效的业绩表别名')
      expect(() => staff.excludeLegacyPrepaidInflowSql(alias)).toThrow('无效的业绩表别名')
    }
  })

  it.each([
    ['fengyu-admin/src/actions/dashboard.ts', 1],
    ['fengyu-admin/src/actions/data-center/sales.ts', 6],
    ['fengyu-admin/src/actions/data-center/efficiency.ts', 3],
    ['fengyu-admin/src/actions/data-center/operating-master.ts', 1],
    ['fengyu-admin/src/lib/data-center/daily-overview-sql.ts', 2],
    ['fengyu-admin/src/lib/data-center/customer-frequency-query.ts', 1],
    ['fengyu-admin/src/lib/data-center/data-start-query.ts', 1],
    ['fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js', 4],
    ['fengyu-staff/cloudfunctions/staffApi/routes/staff.js', 3],
  ] as const)('%s 含充值的业绩查询全部接入过滤', (file, count) => {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
    expect(source.match(/excludeLegacyPrepaidInflowSql\('/g)).toHaveLength(count)
    if (!file.endsWith('/actions/dashboard.ts')) {
      // 每个接受充值单的查询都必须紧接相同订单别名的过滤；新查询漏接也会失败。
      const clauses = [...source.matchAll(/AND (\w+)\.sale_order_type (?:IN \('销售单', '转换单', '充值单'\)|= '充值单')\s+([^\n]+)/g)]
      expect(clauses).toHaveLength(count)
      for (const [, alias, next] of clauses) {
        expect(next.trim()).toBe(`AND \${excludeLegacyPrepaidInflowSql('${alias}')}`)
      }
    }
  })

  it('识别标记与两端转入写入端一致，允许标准标记后附用户备注', () => {
    const sql = dialect.sqlToQuery(excludeLegacyPrepaidInflowSql()).sql
    for (const file of ['fengyu-admin/src/actions/orders.ts', 'fengyu-staff/cloudfunctions/staffApi/routes/card.js']) {
      const marker = read(file).match(/const LEGACY_INFLOW_NOTE = '([^']+)'/)?.[1]
      expect(marker).toBe('旧系统充值金转入')
      expect(sql).toContain(`legacy_inflow.note = '${marker}'`)
      expect(sql).toContain(`legacy_inflow.note LIKE '${marker}｜%'`)
    }
  })
})

// 可选真库回归，仅允许本地专用测试库；不读取项目业务库连接串。
// PREPAID_PERFORMANCE_TEST_URL=postgresql://postgres@127.0.0.1:<port>/prepaid_performance_test \
//   bun run test src/lib/data-center/prepaid-performance-filter.test.ts
const testUrl = process.env.PREPAID_PERFORMANCE_TEST_URL
describe.skipIf(!testUrl)('旧储值业绩 PostgreSQL 回归', () => {
  let db: Client
  const session = {
    roles: [{ role: 'admin', scopeType: '总部', isSuperAdmin: true }],
    permissions: { scopeStoreIds: [] },
  } as unknown as AuthSession

  beforeAll(async () => {
    const url = new URL(testUrl!)
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname)
    expect(url.pathname).toBe('/prepaid_performance_test')
    db = new Client({ connectionString: testUrl })
    await db.connect()
    await db.query(`
      CREATE TEMP TABLE org_nodes (id text, type text, is_active boolean);
      CREATE TEMP TABLE stores (store_id text, org_node_id text);
      CREATE TEMP TABLE sale_orders (
        sale_order_id text PRIMARY KEY, store_id text, sale_order_type text,
        legacy_source text, remark text, client_user_id text DEFAULT '同一顾客', status text DEFAULT '已支付'
      );
      CREATE TEMP TABLE sale_order_payments (
        id bigserial PRIMARY KEY, sale_order_id text, change_type text, payment_method text DEFAULT '线下',
        status text DEFAULT '已支付', amount numeric(10,2), note text,
        performance_attribution_date date, paid_at timestamptz DEFAULT NOW(), created_at timestamptz DEFAULT NOW()
      );
      CREATE INDEX ON sale_order_payments(sale_order_id);
      CREATE TEMP TABLE sale_items (sale_item_id text, product_kind_at_sale text, is_experience boolean NOT NULL DEFAULT false);
      CREATE TEMP TABLE sale_payment_item_receipts (sale_payment_id bigint, sale_item_id text, amount numeric);
      INSERT INTO org_nodes VALUES ('A','门店',true),('B','门店',true),('Z','门店',true);
      INSERT INTO stores VALUES ('A','A'),('B','B'),('Z','Z');
    `)
    // 重放真正的已发布款项视图定义，避免手写简化视图掩盖退款/储值卡口径。
    for (const [file, view] of [
      ['db/migrations/0041_bizarre_wolfpack.sql', 'sale_order_performance_events'],
    ]) {
      const ddl = read(file).match(new RegExp(`CREATE VIEW "public"\\."${view}" AS \\([\\s\\S]*?\\n\\);`))?.[0]
      expect(ddl, view).toBeTruthy()
      await db.query(ddl!.replace('CREATE VIEW "public".', 'CREATE TEMP VIEW '))
    }
    // #553：既有资金视图保持不变，资格使用当前 schema，不能继续只测旧 0057。
    const reportable = dialect.sqlToQuery(getViewConfig(saleReportablePaymentEvents).query!)
    expect(reportable.params).toEqual([])
    await db.query(`CREATE TEMP VIEW sale_reportable_payment_events AS (${reportable.sql})`)
    await db.query(`
      INSERT INTO sale_orders(sale_order_id,store_id,sale_order_type,legacy_source,remark) VALUES
        ('old-aug','A','充值单',NULL,'已修改订单备注'),
        ('old-oct','A','充值单',NULL,NULL),
        ('new-oct','A','充值单',NULL,NULL),
        ('new-aug','A','充值单',NULL,NULL),
        ('new-nov','A','充值单',NULL,NULL),
        ('normal-note','A','充值单',NULL,NULL),
        ('workfine','A','充值单','workfine',NULL),
        ('sale','A','销售单',NULL,NULL),
        ('unpaid','A','充值单',NULL,NULL),
        ('other-store','B','充值单',NULL,NULL),
        ('old-only-store','Z','充值单',NULL,NULL);
      INSERT INTO sale_order_payments(sale_order_id,change_type,amount,note,performance_attribution_date) VALUES
        ('old-aug','首次支付',1000,'旧系统充值金转入','2026-08-10'),
        ('old-aug','退款',-100,'普通退款备注','2026-10-03'),
        ('old-oct','首次支付',500,'旧系统充值金转入｜补录旧余额','2026-10-02'),
        ('old-oct','退款',-50,NULL,'2026-11-02'),
        ('new-oct','首次支付',2000,NULL,'2026-10-01'),
        ('new-oct','退款',-200,NULL,'2026-10-04'),
        ('new-oct','退款',-100,NULL,'2026-11-03'),
        ('new-aug','首次支付',300,NULL,'2026-08-11'),
        ('new-nov','首次支付',400,NULL,'2026-11-01'),
        ('normal-note','首次支付',50,'旧系统充值金转入后另行新充值','2026-10-01'),
        ('workfine','首次支付',700,NULL,'2026-10-01'),
        ('sale','首次支付',300,'旧系统充值金转入','2026-10-01'),
        ('sale','储值卡抵扣',100,NULL,'2026-10-01'),
        ('other-store','首次支付',300,NULL,'2026-10-01'),
        ('old-only-store','首次支付',2000,'旧系统充值金转入','2026-10-01');
      INSERT INTO sale_order_payments(sale_order_id,change_type,amount,status,performance_attribution_date)
        VALUES ('unpaid','首次支付',1000,'待支付','2026-10-01');
    `)
  })

  afterAll(async () => { await db?.end() })

  async function execute(query: SQL) {
    const rendered = dialect.sqlToQuery(query)
    return (await db.query(rendered.sql, rendered.params)).rows
  }
  async function total(month: string, store = 'A') {
    const rows = await execute(performanceTotalSql(session, { type: 'store', id: store }, {
      start: `${month}-01`, end: `${month}-${month.endsWith('11') ? '30' : '31'}`,
    }))
    return Number(rows[0].v)
  }

  it('同一顾客旧余额转入及退款不计，老卡新充值和销售现付照常计入', async () => {
    // 2000 新充值 - 200 退款 + 50 真实充值 + 300 现付；旧余额、刷卡、未支付和 WorkFine 均排除。
    expect(await total('2026-10')).toBe(2150)
  })

  it('按款项归属月份统计，跨月退款只冲减真实充值；上月充值不重计', async () => {
    expect(await total('2026-08')).toBe(300)
    expect(await total('2026-11')).toBe(300)
  })

  it('日常一览表充值列与总业绩同源，只少销售单现付', async () => {
    const rows = await execute(dailyOverviewQueries(session, { type: 'store', id: 'A' }, {
      start: '2026-10-01', end: '2026-10-31',
    }).recharge)
    expect(Number(rows[0].amount)).toBe(1850)
  })

  it('员工端独立 SQL 与后台实际查询结果一致', async () => {
    const rows = await db.query(`
      SELECT COALESCE(SUM(spe.performance_amount),0) AS v
      FROM sale_reportable_payment_events spe
      WHERE spe.store_id = $1 AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付','回款','退款')
        AND spe.sale_order_type IN ('销售单','转换单','充值单')
        AND ${staff.excludeLegacyPrepaidInflowSql('spe')}
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN $2 AND $3
    `, ['A', '2026-10-01', '2026-10-31'])
    expect(Number(rows.rows[0].v)).toBe(await total('2026-10'))
  })

  it('门店过滤继续生效，只有旧余额的门店业绩为零', async () => {
    expect(await total('2026-10', 'B')).toBe(300)
    expect(await total('2026-10', 'Z')).toBe(0)
  })

  it('门店排名的 LEFT JOIN 保留只有旧余额或没有本月款项的门店', async () => {
    const { rows } = await db.query(`
      SELECT s.store_id, COALESCE(SUM(spe.performance_amount),0)::text AS v
      FROM stores s LEFT JOIN sale_reportable_payment_events spe
        ON spe.store_id=s.store_id AND spe.status='已支付'
        AND spe.change_type IN ('首次支付','回款','退款')
        AND spe.sale_order_type IN ('销售单','转换单','充值单')
        AND ${staff.excludeLegacyPrepaidInflowSql('spe')}
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN $1 AND $2
      GROUP BY s.store_id ORDER BY s.store_id
    `, ['2026-10-01', '2026-10-31'])
    expect(rows.map((r) => [r.store_id, Number(r.v)])).toEqual([['A', 2150], ['B', 300], ['Z', 0]])
  })
})
