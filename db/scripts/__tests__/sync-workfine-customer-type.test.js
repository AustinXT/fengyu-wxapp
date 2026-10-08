'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { recalcCustomerTypesInTransaction } = require('../recalc-all-customer-types')
const { syncCustomers } = require('../sync-workfine')

function fakeClient(threshold = '3000', failBuild = false) {
  const calls = []
  let released = false
  return {
    calls,
    get released() { return released },
    release() { released = true },
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes("WHERE key = 'new_member_threshold'")) {
        return { rows: threshold === undefined ? [] : [{ v: threshold }], rowCount: 1 }
      }
      if (sql.includes('AS member_no_became')) return { rows: [{ member_no_became: 0, nonmember_with_level: 0 }] }
      if (failBuild && sql.includes('CREATE TEMP TABLE _recalc_target')) throw new Error('补算故障')
      return { rows: [], rowCount: sql.trimStart().startsWith('UPDATE client_wechat_users u') ? 1 : 0 }
    },
  }
}
const mssql = { request: () => ({ query: async () => ({ recordset: [] }) }) }

test('require 重算脚本不连接数据库；入口使用同一套参数化SQL且不自行提交', async () => {
  const client = fakeClient()
  assert.deepEqual(await recalcCustomerTypesInTransaction(client), { typeCount: 1, levelCount: 1, becameCount: 1, selfCheck: { member_no_became: 0, nonmember_with_level: 0 } })
  assert.deepEqual(client.calls[1].params, [3000])
  assert.equal(client.calls.filter(c => c.sql.trimStart().startsWith('UPDATE client_wechat_users u')).length, 3)
  assert.ok(!client.calls.some(c => ['BEGIN', 'COMMIT'].includes(c.sql)))
})

for (const threshold of [null, '', '0', '-1', 'NaN', 'Infinity']) {
  test(`非法阈值 ${threshold} 拒绝所有写入`, async () => {
    const client = fakeClient(threshold)
    await assert.rejects(recalcCustomerTypesInTransaction(client), /阈值|new_member_threshold/)
    assert.equal(client.calls.length, 1)
  })
}

test('顾客同步在提交前补算，同事务成功并释放连接', async () => {
  const client = fakeClient()
  await syncCustomers(mssql, { options: { connectionString: 'postgres://test:test@127.0.0.1:54416/issue256schema' }, connect: async () => client }, false)
  const sqls = client.calls.map(c => c.sql)
  assert.equal(sqls[0], 'BEGIN')
  assert.equal(sqls.at(-1), 'COMMIT')
  assert.ok(sqls.findIndex(s => s.includes('CREATE TEMP TABLE _recalc_target')) > sqls.indexOf('DROP TABLE _cust_staging'))
  assert.equal(client.released, true)
})

test('补算失败时顾客同步回滚，不能显示成功提交', async () => {
  const client = fakeClient('3000', true)
  await assert.rejects(syncCustomers(mssql, { options: { connectionString: 'postgres://test:test@127.0.0.1:54416/issue256schema' }, connect: async () => client }, false), /补算故障/)
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!client.calls.some(c => c.sql === 'COMMIT'))
  assert.equal(client.released, true)
})

test('dry-run 不连接PG、不补算', async () => {
  await syncCustomers(mssql, { connect: () => { throw new Error('不应连接') } }, true)
})

const source = require('node:fs').readFileSync(require.resolve('../sync-workfine'), 'utf8')
test('顾客staging写入当前schema：显式枚举转换，不再写已移除category列', () => {
  const customer = source.slice(source.indexOf('async function syncCustomers'), source.indexOf('// ─── 5.'))
  assert.ok(!/\bcategory\b/.test(customer))
  assert.ok(customer.includes('member_level::member_level'))
  assert.ok(customer.includes('customer_source::customer_source'))
})

test('自动入口报告既有人工会员缺失入会时间，不阻断档案同步', async () => {
  const client = fakeClient()
  const query = client.query.bind(client)
  client.query = async (sql, params) => sql.includes('AS member_no_became')
    ? { rows: [{ member_no_became: 1 }] } : query(sql, params)
  await syncCustomers(mssql, { options: { connectionString: 'postgres://test:test@127.0.0.1:54416/issue256schema' }, connect: async () => client }, false)
  assert.equal(client.calls.at(-1).sql, 'COMMIT')
})
test('批量等级阈值与cron等级纯函数逐档一致', () => {
  const fs = require('node:fs'), path = require('node:path')
  const cron = fs.readFileSync(path.resolve(__dirname, '../../../fengyu-admin/src/cron/lib/member-level.ts'), 'utf8')
  const batch = fs.readFileSync(require.resolve('../recalc-all-customer-types'), 'utf8')
  const rules = [...cron.matchAll(/if \(spend >= (\d+)\) return '([^']+)'/g)]
  assert.equal(rules.length, 4)
  for (const [, amount, name] of rules) assert.ok(new RegExp(`>=\\s*${amount}\\s+THEN\\s+'${name}'`).test(batch))
  // 第 5 档（#545）：会员客等级下限 = 初钻 —— 批量 SQL 的内层 CASE 用 ELSE 兜底，
  // cron 纯函数的末分支同为 '初钻'。取「会员客内层 CASE」这一段（到它自己的 END 为止），
  // 外层 ELSE NULL 属于「非会员客一律 NULL」，不在本断言范围内。
  const start = batch.indexOf('WHEN spend >= 100000')
  const levelCase = batch.slice(start, batch.indexOf('END', start))
  assert.ok(levelCase.includes("ELSE '初钻'"))
  assert.ok(!levelCase.includes('NULL'))
})


test('导出的顾客同步入口也拒绝生产、query覆盖及未声明目标', async () => {
  for (const connectionString of [undefined, 'http://127.0.0.1:54416/issue256schema', 'postgres://test:test@118.178.196.26:5433/fengyu_wxapp', 'postgres://test:test@101.34.242.103:5433/fengyu_wxapp?host=118.178.196.26']) {
    let connected=false;
    await assert.rejects(syncCustomers(mssql,{options:{connectionString},connect:async()=>{connected=true;return fakeClient()}},false), /拒绝顾客同步/)
    assert.equal(connected,false)
  }
})

test('规范dev目标放行且调用真实顾客同步与补算（连接替身，不访问共享库）', async () => {
  const client = fakeClient()
  await syncCustomers(mssql, { options: { connectionString: 'postgres://test:test@101.34.242.103:5433/fengyu_wxapp' }, connect: async () => client }, false)
  assert.ok(client.calls.some(call => call.sql.includes('CREATE TEMP TABLE _recalc_target')))
  assert.equal(client.calls.at(-1).sql, 'COMMIT')
})

test('真实重算CLI拒绝旧库/未知目标/缺显式DATABASE_URL，require helper不触发门禁', () => {
  const { spawnSync } = require('node:child_process')
  const script = require.resolve('../recalc-all-customer-types')
  for (const target of [undefined, 'postgres://test:test@47.113.202.7:5433/fengyu_wxapp', 'postgres://test:test@127.0.0.1:54416/issue256schema']) {
    const env = { ...process.env, PG_CONNECTION_STRING:'postgres://test:test@101.34.242.103:5433/fengyu_wxapp' }
    delete env.DATABASE_URL
    if (target !== undefined) env.DATABASE_URL=target
    const result=spawnSync(process.execPath,[script,'--apply'],{env,encoding:'utf8',timeout:3000})
    assert.equal(result.status,1)
    assert.match(result.stderr,/DATABASE_URL 必须显式指向/)
    assert.doesNotMatch(result.stdout,/RECALC-CUSTOMER-TYPE/)
  }
})
