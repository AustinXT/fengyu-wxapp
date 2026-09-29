/** #291 真连接探针：仅由 session-timezone.integration.mjs 的隔离子进程调用。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const [target, mode] = process.argv.slice(2)
const root = resolve(import.meta.dir, '../..')
const files: Record<string, string> = {
  staff: 'fengyu-staff/cloudfunctions/staffApi/db/pg.js',
  client: 'fengyu-client/cloudfunctions/clientApi/db/pg.js',
  pay: 'fengyu-client/cloudfunctions/payNotify/index.js',
}
const sampleSql = `CREATE TEMP TABLE client_wechat_users (became_member_at timestamptz);
INSERT INTO client_wechat_users VALUES ('2026-09-01 00:00:00+08')`

async function checkMemberQueries(execute: (text: string, params?: unknown[]) => Promise<any>) {
  // 原函数全文取自当前源码，不另写一份业务谓词；只注入全范围 scope 与固定测试区间。
  const adminRequire = createRequire(resolve(root, 'fengyu-admin/package.json'))
  const ts = adminRequire('typescript')
  const { sql } = adminRequire('drizzle-orm')
  const { PgDialect } = adminRequire('drizzle-orm/pg-core')
  const source = readFileSync(resolve(root, 'fengyu-admin/src/actions/data-center/customer.ts'), 'utf8')
  const fn = source.match(/async function queryNewMemberCount\([\s\S]*?\n\}/)?.[0]
  assert.ok(fn)
  const js = ts.transpile(fn, { target: ts.ScriptTarget.ES2020 })
  const queryAdmin = new Function('db', 'sql', 'scopeFilterSql', 'num', 'first', `${js}; return queryNewMemberCount`)(
    { execute: (query: any) => { const q = new PgDialect().sqlToQuery(query); return execute(q.sql, q.params) } },
    sql, () => sql`TRUE`, Number, (rows: any[]) => rows[0],
  )
  const staffSource = readFileSync(resolve(root, 'fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js'), 'utf8')
  const staffFn = staffSource.match(/async function queryNewMemberCount\([\s\S]*?\n\}/)?.[0]
  assert.ok(staffFn)
  let day = '2026-09-01'
  const queryStaff = new Function('pg', 'buildClientScope', 'startDateExpr', 'endDateExpr', `${staffFn}; return queryNewMemberCount`)(
    { query: execute }, () => ({ sql: 'TRUE', params: [] }), () => `'${day}'::date`, () => `'${day}'::date`,
  )
  for (const [date, expected] of [['2026-09-01', 1], ['2026-08-31', 0]] as const) {
    day = date
    assert.equal(await queryAdmin({}, {}, { start: date, end: date }), expected)
    assert.equal(await queryStaff('all', null, 'month'), expected)
  }
}

if (target === 'admin' || target === 'analyst') {
  const { db, initializeDatabase } = await import(resolve(root, `fengyu-${target}/src/db/index.ts`))
  if (mode === 'startup') {
    process.env.NEXT_RUNTIME = 'nodejs'
    const { register } = await import(resolve(root, `fengyu-${target}/src/instrumentation.ts`))
    await register()
  } else {
    await initializeDatabase()
    const require = createRequire(resolve(root, `fengyu-${target}/package.json`))
    const { sql } = require('drizzle-orm')
    const rows = await db.execute(sql`SHOW TimeZone`)
    assert.equal(rows[0].TimeZone, 'Asia/Shanghai')
    if (target === 'admin') {
      await db.transaction(async (tx: any) => {
        for (const text of sampleSql.split(';')) await tx.execute(sql.raw(text))
        await checkMemberQueries((text, params = []) => {
          const query = sql.empty()
          for (const part of text.split(/(\$\d+)/)) {
            query.append(/^\$\d+$/.test(part) ? sql`${params[Number(part.slice(1)) - 1]}` : sql.raw(part))
          }
          return tx.execute(query)
        })
        // 固定北京时间 03:00，验证 cron 原 SQL 中的全部日期窗口；不修改生产 SQL/系统时钟。
        const { UPDATE_CUSTOMER_STATUS_SQL } = await import(resolve(root, 'fengyu-admin/src/cron/steps/refresh-customer-status.ts'))
        const { shanghaiToday } = await import(resolve(root, 'fengyu-admin/src/lib/data-center/time-range.ts'))
        const current = await tx.execute(sql`SELECT CURRENT_DATE::text AS day`)
        assert.equal(current[0].day, shanghaiToday())
        const instant = '2026-09-01T03:00:00+08:00'
        const today = shanghaiToday(new Date(instant))
        const windows = [...UPDATE_CUSTOMER_STATUS_SQL.matchAll(/CURRENT_DATE - INTERVAL '([^']+)'/g)].map((m: RegExpMatchArray) => m[1])
        assert.ok(windows.includes('90 days') && windows.includes('6 months') && windows.includes('12 months'))
        for (const interval of windows) {
          const result = await tx.execute(sql`SELECT (${instant}::timestamptz)::date - ${interval}::interval AS actual,
            ${today}::date - ${interval}::interval AS expected`)
          assert.equal(String(result[0].actual), String(result[0].expected))
        }
      })
    }
  }
  console.log('PASS', target, mode)
  process.exit(0)
} else {
  const path = resolve(root, files[target])
  const require = createRequire(path)
  let source = readFileSync(path, 'utf8')
  if (mode === 'wrong-options') source = source.replace("options: '-c TimeZone=Asia/Shanghai'", "options: '-c TimeZone=UTC'")
  let pool: any
  if (target === 'pay') {
    const init = source.slice(source.indexOf('let pgPool = null'), source.indexOf('\n/**', source.indexOf('let pgPool = null')))
    pool = new Function('require', `${init}; return getPg()`)(require)
  } else {
    const module = { exports: {} as any }
    new Function('require', 'module', 'exports', source)(require, module, module.exports)
    pool = module.exports.getPool()
  }
  const client = await pool.connect()
  try {
    assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone, 'Asia/Shanghai')
    await client.query(sampleSql)
    await checkMemberQueries(async (text, params) => (await client.query(text, params)).rows)
  } finally {
    client.release()
    await pool.end()
  }
  console.log('PASS', target, mode)
}
