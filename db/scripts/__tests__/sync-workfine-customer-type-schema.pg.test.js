'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { syncCustomers } = require('../sync-workfine')
const url = process.env.CUSTOMER_TYPE_SCHEMA_PG_TEST_URL
// 私有库先按journal重放完整迁移，再显式运行本用例；不使用手写影子schema。
test('完整迁移schema上的真实顾客同步路径（手机号/无手机号、枚举、分类补算与回滚）', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, '54416'); assert.equal(parsed.pathname, '/issue256schema')
  const db = new Client({ connectionString: url }); await db.connect()
  const ids = ['WF256-schema-phone', 'WF256-schema-no-phone', 'WF256-schema-bad']
  try {
    await db.query("INSERT INTO system_configs(key,value) VALUES('new_member_threshold','3000') ON CONFLICT(key) DO UPDATE SET value='3000'")
    const pool = { connect: async () => ({ query: db.query.bind(db), release() {} }) }
    const source = rows => ({ request: () => ({ query: async () => ({ recordset: rows }) }) })
    await syncCustomers(source([{ customer_id: ids[0], phone: '19990002656', member_level: '初钻' }, { customer_id: ids[1] }]), pool, false)
    const rows = (await db.query('SELECT customer_id, customer_type FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])).rows
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.customer_type === '流量客'))
    await syncCustomers(source([{ customer_id: ids[0], phone: '19990002656' }, { customer_id: ids[1] }]), pool, false)
    assert.equal((await db.query('SELECT count(*)::int AS cnt FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])).rows[0].cnt, 2)
    await assert.rejects(syncCustomers(source([{ customer_id: ids[2], member_level: '非法等级' }]), pool, false))
    assert.equal((await db.query('SELECT count(*)::int AS cnt FROM client_wechat_users WHERE customer_id = $1', [ids[2]])).rows[0].cnt, 0)
  } finally {
    await db.query('ROLLBACK').catch(() => {})
    await db.query('DELETE FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])
    await db.end()
  }
})
