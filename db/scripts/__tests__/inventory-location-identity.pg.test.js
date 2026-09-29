/** #270 private-PG identity guard, including a real concurrent ON CONFLICT path. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const url = process.env.INVENTORY_PG_TEST_URL
const prefix = 'T270PG_'
if (!url) {
  test('#270 private PG (INVENTORY_PG_TEST_URL required)', { skip: true }, () => {})
} else {
  const c = new Client({ connectionString: url, statement_timeout: 5000 })
  test.before(async () => {
    await c.connect()
    const [{ db }] = (await c.query('SELECT current_database() AS db')).rows
    assert.equal(db, 'verify270', 'only the C4 private database is allowed')
  })
  test.after(() => c.end())
  async function seed(client, suffix) {
    const p = prefix + suffix
    await client.query('INSERT INTO org_nodes(id,name,type) VALUES ($1,$1,\'总部\')', [p + 'HQ'])
    await client.query('INSERT INTO org_nodes(id,name,type,parent_id) VALUES ($1,$1,\'市场\',$2)', [p + 'MKT', p + 'HQ'])
    await client.query('INSERT INTO org_nodes(id,name,type,parent_id) VALUES ($1,$1,\'门店\',$2)', [p + 'ORG', p + 'MKT'])
    return p
  }
  async function txn(fn) {
    await c.query('BEGIN')
    try { await fn() } finally { await c.query('ROLLBACK') }
  }
  const store = (client, id, org) => client.query('INSERT INTO stores(store_id,store_name,org_node_id) VALUES ($1,$1,$2)', [id, org])
  const market = (client, id, hq) => client.query('INSERT INTO org_nodes(id,name,type,parent_id) VALUES ($1,$1,\'市场\',$2)', [id, hq])
  async function conflict(fn) {
    await c.query('SAVEPOINT conflict')
    await assert.rejects(fn, /CONFLICT: LOCATION_ID_AMBIGUOUS/)
    await c.query('ROLLBACK TO SAVEPOINT conflict')
  }
  test('headquarters/market first: a store cannot replace it', () => txn(async () => {
    const p = await seed(c, 'FIRST_')
    for (const id of [p + 'HQ', p + 'MKT']) {
      await conflict(() => store(c, id, p + 'ORG'))
      assert.equal((await c.query('SELECT store_id FROM stores WHERE store_id=$1', [id])).rowCount, 0)
      const row = (await c.query('SELECT location_type,org_node_id,store_id FROM inventory_locations WHERE location_id=$1', [id])).rows[0]
      assert.notEqual(row.location_type, '门店'); assert.equal(row.org_node_id, id); assert.equal(row.store_id, null)
    }
  }))
  test('store first: a later market cannot replace it', () => txn(async () => {
    const p = await seed(c, 'REVERSE_'), id = p + 'NEW'
    await store(c, id, p + 'ORG')
    await conflict(() => market(c, id, p + 'HQ'))
    assert.equal((await c.query('SELECT location_type FROM inventory_locations WHERE location_id=$1', [id])).rows[0].location_type, '门店')
  }))
  test('ordinary rename/status sync still works', () => txn(async () => {
    const p = await seed(c, 'NORMAL_'), id = p + 'STORE'
    await store(c, id, p + 'ORG')
    await c.query('UPDATE stores SET store_name=$2 WHERE store_id=$1', [id, p + 'RENAMED'])
    assert.equal((await c.query('SELECT name FROM inventory_locations WHERE location_id=$1', [id])).rows[0].name, p + 'RENAMED')
  }))
  test('migration preflight rejects populated collision without repairing it', () => txn(async () => {
    const p = await seed(c, 'PREFLIGHT_')
    await c.query('ALTER TABLE stores DISABLE TRIGGER trg_stores_sync_inventory_locations')
    await store(c, p + 'MKT', p + 'ORG')
    const preflight = fs.readFileSync(path.resolve(__dirname, '../../migrations/0055_inventory_location_identity_guard.sql'), 'utf8').split('--> statement-breakpoint')[0]
    await conflict(() => c.query(preflight))
    assert.equal((await c.query('SELECT location_type FROM inventory_locations WHERE location_id=$1', [p + 'MKT'])).rows[0].location_type, '市场')
  }))
  test('runtime probe and UPSERT SQL compile and execute against real PG', () => txn(async () => {
    const p = await seed(c, 'RUNTIME_')
    const source = fs.readFileSync(path.resolve(__dirname, '../../../fengyu-admin/src/lib/inventory/engine.ts'), 'utf8')
    const body = source.slice(source.indexOf('export async function syncInventoryLocations'))
    const probe = body.match(/SELECT EXISTS \([\s\S]*?AS collided_id/)[0]
    await c.query('PREPARE t270_probe AS ' + probe)
    assert.equal((await c.query('EXECUTE t270_probe')).rows[0].collided_id, null)
    const inserts = [...body.matchAll(/INSERT INTO inventory_locations[\s\S]*?updated_at = NOW\(\)/g)].slice(0, 2)
    for (let i = 0; i < inserts.length; i++) {
      await c.query(`PREPARE t270_upsert_${i} AS ` + inserts[i][0])
      await c.query(`EXECUTE t270_upsert_${i}`)
      await c.query(`DEALLOCATE t270_upsert_${i}`)
    }
    await c.query('ALTER TABLE stores DISABLE TRIGGER trg_stores_sync_inventory_locations')
    await store(c, p + 'MKT', p + 'ORG')
    assert.equal((await c.query('EXECUTE t270_probe')).rows[0].collided_id, p + 'MKT')
    await c.query('DEALLOCATE t270_probe')
  }))
  test('negative control: disabling only the new guard reproduces silent replacement', () => txn(async () => {
    const p = await seed(c, 'CONTROL_')
    await market(c, p + 'OTHER', p + 'HQ')
    await c.query('ALTER TABLE inventory_locations DISABLE TRIGGER trg_inventory_locations_guard_identity')
    await store(c, p + 'OTHER', p + 'ORG')
    assert.equal((await c.query('SELECT location_type FROM inventory_locations WHERE location_id=$1', [p + 'OTHER'])).rows[0].location_type, '门店')
  }))
  for (const storeFirst of [false, true]) {
    test(`concurrent source inserts (storeFirst=${storeFirst}) cannot replace the winning identity`, async () => {
      const other = new Client({ connectionString: url, statement_timeout: 5000 })
      await other.connect()
      const p = await seed(c, storeFirst ? 'CONCURRENT_STORE_' : 'CONCURRENT_MARKET_'), id = p + 'NEW'
      try {
        await c.query('BEGIN'); await other.query('BEGIN')
        await (storeFirst ? store(c, id, p + 'ORG') : market(c, id, p + 'HQ'))
        const pending = (storeFirst ? market(other, id, p + 'HQ') : store(other, id, p + 'ORG')).then(() => null, err => err)
        // Prove the loser actually waited on the concurrent transaction, rather than
        // testing two sequential inserts and claiming concurrency coverage.
        let waiting = false
        for (let i = 0; i < 100; i++) {
          const res = await c.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [other.processID])
          if (res.rows[0]?.wait_event_type === 'Lock') { waiting = true; break }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(waiting, true, 'loser must wait on a real PG lock')
        await c.query('COMMIT')
        const err = await pending
        assert.ok(err); assert.match(err.message, /CONFLICT: LOCATION_ID_AMBIGUOUS/)
        await other.query('ROLLBACK')
        assert.equal((await c.query('SELECT location_type FROM inventory_locations WHERE location_id=$1', [id])).rows[0].location_type, storeFirst ? '门店' : '市场')
      } finally {
        await c.query('ROLLBACK'); await other.query('ROLLBACK'); await other.end()
        // Only this suite's fixture IDs; leaf-first deletion keeps existing FKs valid.
        await c.query('DELETE FROM inventory_locations WHERE location_id=$1 OR location_id=$2', [id, p + 'MKT'])
        await c.query('DELETE FROM stores WHERE store_id=$1', [id])
        await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'ORG'])
        await c.query('DELETE FROM org_nodes WHERE id=$1', [id])
        await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'MKT'])
        await c.query('DELETE FROM inventory_locations WHERE location_id=$1', [p + 'HQ'])
        await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'HQ'])
      }
    })
  }
}
