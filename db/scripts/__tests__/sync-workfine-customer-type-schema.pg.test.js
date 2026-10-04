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
  const ids = ['WF256-schema-phone', 'WF256-schema-no-phone', 'WF256-schema-bad', 'WF256-schema-unrelated']
  try {
    await db.query("INSERT INTO system_configs(key,value) VALUES('new_member_threshold','3000') ON CONFLICT(key) DO UPDATE SET value='3000'")
    const pool = { options: { connectionString: url }, connect: async () => ({ query: db.query.bind(db), release() {} }) }
    const source = rows => ({ request: () => ({ query: async () => ({ recordset: rows }) }) })
    await syncCustomers(source([{ customer_id: ids[0], phone: '19990002656', member_level: '初钻' }, { customer_id: ids[1] }]), pool, false)
    const rows = (await db.query('SELECT customer_id, customer_type, updated_at FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])).rows
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.customer_type === '流量客'))
    await new Promise(resolve => setTimeout(resolve, 20))
    await syncCustomers(source([{ customer_id: ids[0], phone: '19990002656', member_level: '初钻' }, { customer_id: ids[1] }]), pool, false)
    const repeated = (await db.query('SELECT customer_id, customer_type, updated_at FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])).rows
    assert.deepEqual(repeated, rows, '相同档案同步不更新updated_at')
    assert.equal((await db.query('SELECT count(*)::int AS cnt FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])).rows[0].cnt, 2)
    const user = (await db.query('SELECT user_id FROM client_wechat_users WHERE customer_id=$1', [ids[0]])).rows[0].user_id
    await db.query("INSERT INTO org_nodes(id,name,type,parent_id) VALUES('WF256-hq','合成总部','总部',NULL),('WF256-market','合成市场','市场','WF256-hq'),('WF256-node','合成测试店','门店','WF256-market')")
    await db.query("INSERT INTO stores(store_id,store_name,org_node_id) VALUES('WF256-store','合成测试店','WF256-node')")
    await db.query('INSERT INTO client_wechat_users(user_id,customer_id) VALUES($1,$2)', ['WF256-unrelated', ids[3]])
    await db.query(`INSERT INTO sale_orders(sale_order_id,client_user_id,market_name,store_id,sale_order_datetime,total_amount,received,payment_method,status,paid_at)
      VALUES('WF256-order', $1,'合成市场','WF256-store',now()-interval '4 days',3300,3300,'线下','已支付',now()-interval '4 days'),
      ('WF256-order-unrelated','WF256-unrelated','合成市场','WF256-store',now()-interval '4 days',3300,3300,'线下','已支付',now()-interval '4 days')`, [user])
    await syncCustomers(source([{ customer_id: ids[0], phone: '19990002656', member_level: '初钻' }]), pool, false)
    const upgraded = (await db.query('SELECT customer_type, became_member_at, member_level_upgraded_at FROM client_wechat_users WHERE user_id=$1', [user])).rows[0]
    assert.equal(upgraded.customer_type, '会员客'); assert.ok(upgraded.became_member_at); assert.equal(upgraded.member_level_upgraded_at, null)
    assert.equal((await db.query("SELECT customer_type FROM client_wechat_users WHERE user_id='WF256-unrelated'")).rows[0].customer_type, '流量客', '自动补算不碰本批之外顾客')
    // 实际同步完成档案UPDATE/补算后仍持事务：父行非键锁不应挡FK写入，仍应挡并发UPDATE。
    const peer = new Client({ connectionString: url }); await peer.connect()
    let releaseSync, enterSync
    const held = new Promise(resolve => { enterSync = resolve })
    const release = new Promise(resolve => { releaseSync = resolve })
    let syncTask
    try {
      await peer.query('CREATE TABLE wf256_fk_probe(client_user_id text REFERENCES client_wechat_users(user_id))')
      const pausedPool = { options: { connectionString: url }, connect: async () => ({
        query: async (sql, params) => {
          if (sql === 'COMMIT') { enterSync(); await release }
          return db.query(sql, params)
        }, release() {},
      }) }
      syncTask = syncCustomers(source([{ customer_id: ids[0], phone: '19990002656', name: '更新合成档案' }]), pausedPool, false)
      // 为拒绝立即登记处理，避免测试进程unhandled rejection；仍由await真正验证结果。
      syncTask.catch(() => {})
      await Promise.race([held, syncTask.then(() => { throw Error('未进入COMMIT前交错点') })])
      await peer.query('BEGIN')
      await peer.query("SET LOCAL lock_timeout='300ms'")
      await peer.query('INSERT INTO wf256_fk_probe VALUES($1)', [user])
      await peer.query('COMMIT')
      await peer.query('BEGIN')
      await peer.query("SET LOCAL lock_timeout='300ms'")
      await assert.rejects(peer.query('UPDATE client_wechat_users SET points_balance=points_balance+1 WHERE user_id=$1', [user]), error => error.code === '55P03')
      await peer.query('ROLLBACK')
      releaseSync(); await syncTask
      assert.equal((await db.query('SELECT name FROM client_wechat_users WHERE user_id=$1', [user])).rows[0].name, '更新合成档案')
    } finally { releaseSync(); await syncTask?.catch(() => {}); await peer.query('ROLLBACK').catch(() => {}); await peer.query('DROP TABLE IF EXISTS wf256_fk_probe'); await peer.end() }
    const blocker = new Client({ connectionString: url }); await blocker.connect()
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT user_id FROM client_wechat_users WHERE user_id=$1 FOR UPDATE', [user])
      await assert.rejects(syncCustomers(source([{ customer_id: ids[0], phone: '19990002656' }]), pool, false), error => error.code === '55P03')
    } finally { await blocker.query('ROLLBACK'); await blocker.end() }
    await assert.rejects(syncCustomers(source([{ customer_id: ids[2], member_level: '非法等级' }]), pool, false))
    assert.equal((await db.query('SELECT count(*)::int AS cnt FROM client_wechat_users WHERE customer_id = $1', [ids[2]])).rows[0].cnt, 0)
  } finally {
    try {
    await db.query('ROLLBACK').catch(() => {})
    await db.query("DELETE FROM sale_orders WHERE sale_order_id LIKE 'WF256-order%'")
    await db.query("DELETE FROM inventory_locations WHERE org_node_id LIKE 'WF256-%'")
    await db.query("DELETE FROM stores WHERE store_id='WF256-store'")
    await db.query("DELETE FROM org_nodes WHERE id LIKE 'WF256-%'")
    await db.query('DELETE FROM client_wechat_users WHERE customer_id = ANY($1)', [ids])
    } finally { await db.end() }
  }
})
