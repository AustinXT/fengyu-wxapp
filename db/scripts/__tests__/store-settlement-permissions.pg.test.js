/** #364：正式 SQL 在私有 PG / CI service 验证授权边界、镜像与幂等。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const url = process.env.INVENTORY_PG_TEST_URL

test('#364 结算权限仅追加给指定角色，镜像一致且重放幂等', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  assert.equal([...target.searchParams].length, 0)
  const privateTarget = target.port === '54406' && ['/verify_356_364', '/verify_356_364_empty'].includes(target.pathname)
  const ciTarget = process.env.CI === 'true' && target.port === '5432' && target.pathname === '/test'
  assert.ok(privateTarget || ciTarget, '禁止连接业务库')
  const client = new Client({ connectionString: url })
  await client.connect()
  const sql = fs.readFileSync(path.join(__dirname, '../../migrations/0060_summary_void_store_settlement.sql'), 'utf8')
  try {
    assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db, target.pathname.slice(1))
    await client.query('BEGIN')
    // manager 为存量内置 key；其它角色覆盖自定义角色、同角色同时持权与拆权反例。
    await client.query("UPDATE permission_role_definitions SET actions=ARRAY['existing:manager'], allowed_scope_types=ARRAY['门店'] WHERE role_key='manager'")
    const cases = [
      ['T364_super', ['existing:super'], true, true],
      ['T364_supply', ['inventory:list','inventory:supply_chain_price_view'], false, true],
      ['T364_market', ['inventory:market_price_view','inventory:list','inventory:list'], false, true],
      ['T364_list_only', ['inventory:list'], false, false],
      ['T364_price_only', ['inventory:market_price_view'], false, false],
      ['T364_custom', ['existing:custom'], false, false],
      ['T364_existing', ['inventory:store_settlement_view','existing:keep'], false, false],
    ]
    for (const [key, actions, superAdmin] of cases) {
      await client.query(`INSERT INTO permission_role_definitions
        (role_key,name,actions,is_super_admin,allowed_scope_types,can_access_admin,is_store_manager,updated_by)
        VALUES ($1,$1,$2,$3,$4,false,false,'before')`, [key, actions, superAdmin, key === 'T364_supply' ? ['总部'] : ['市场']])
    }
    const keys = ['manager', ...cases.map(([key]) => key)]
    const before = (await client.query('SELECT * FROM permission_role_definitions WHERE role_key=ANY($1) ORDER BY role_key',[keys])).rows
    for (const statement of sql.split('--> statement-breakpoint')) await client.query(statement)
    const after = (await client.query('SELECT * FROM permission_role_definitions WHERE role_key=ANY($1) ORDER BY role_key',[keys])).rows
    for (const old of before) {
      const row = after.find((r) => r.role_key === old.role_key)
      const qualifies = old.role_key === 'manager' || cases.find(([key]) => key === old.role_key)[3]
      const expected = qualifies ? [...new Set([...old.actions,'inventory:store_settlement_view'])].sort() : old.actions
      assert.deepEqual(row.actions, expected, old.role_key)
      for (const field of Object.keys(old).filter((k) => !['actions','updated_by','updated_at'].includes(k))) {
        assert.deepEqual(row[field], old[field], `${old.role_key}.${field}`)
      }
      if (!qualifies) assert.deepEqual(row, old, '非目标/已持权角色不得改动')
    }
    const mirror = JSON.parse((await client.query("SELECT value FROM system_configs WHERE key='permission_matrix'")).rows[0].value)
    const definitions = (await client.query('SELECT role_key,actions FROM permission_role_definitions')).rows
    assert.deepEqual(mirror, Object.fromEntries(definitions.map((r) => [r.role_key,r.actions])))
    for (const statement of sql.split('--> statement-breakpoint')) await client.query(statement)
    assert.deepEqual((await client.query('SELECT * FROM permission_role_definitions WHERE role_key=ANY($1) ORDER BY role_key',[keys])).rows,after)
    assert.deepEqual(JSON.parse((await client.query("SELECT value FROM system_configs WHERE key='permission_matrix'")).rows[0].value),mirror)
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
