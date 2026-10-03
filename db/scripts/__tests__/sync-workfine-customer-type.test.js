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
      if (failBuild && sql.includes('CREATE TEMP TABLE _recalc_target')) throw new Error('补算故障')
      return { rows: [], rowCount: sql.trimStart().startsWith('UPDATE client_wechat_users u') ? 1 : 0 }
    },
  }
}
const mssql = { request: () => ({ query: async () => ({ recordset: [] }) }) }

test('require 重算脚本不连接数据库；入口使用同一套参数化SQL且不自行提交', async () => {
  const client = fakeClient()
  assert.deepEqual(await recalcCustomerTypesInTransaction(client), { typeCount: 1, levelCount: 1, becameCount: 1 })
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
  await syncCustomers(mssql, { connect: async () => client }, false)
  const sqls = client.calls.map(c => c.sql)
  assert.equal(sqls[0], 'BEGIN')
  assert.equal(sqls.at(-1), 'COMMIT')
  assert.ok(sqls.findIndex(s => s.includes('CREATE TEMP TABLE _recalc_target')) > sqls.indexOf('DROP TABLE _cust_staging'))
  assert.equal(client.released, true)
})

test('补算失败时顾客同步回滚，不能显示成功提交', async () => {
  const client = fakeClient('3000', true)
  await assert.rejects(syncCustomers(mssql, { connect: async () => client }, false), /补算故障/)
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!client.calls.some(c => c.sql === 'COMMIT'))
  assert.equal(client.released, true)
})

test('dry-run 不连接PG、不补算', async () => {
  await syncCustomers(mssql, { connect: () => { throw new Error('不应连接') } }, true)
})
