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
  test('preflight rejects a historical class mismatch without a live source collision', () => txn(async () => {
    const p = await seed(c, 'HISTORICAL_')
    await c.query('ALTER TABLE inventory_locations DISABLE TRIGGER trg_inventory_locations_guard_identity')
    await c.query('ALTER TABLE inventory_locations DISABLE TRIGGER trg_inventory_locations_validate_tree')
    await c.query("UPDATE inventory_locations SET location_type='门店',org_node_id=$2,store_id=NULL WHERE location_id=$1", [p + 'MKT', p + 'ORG'])
    assert.equal((await c.query("SELECT count(*)::int n FROM stores s JOIN org_nodes o ON o.id=s.store_id WHERE o.type IN ('总部','市场')")).rows[0].n, 0)
    const preflight = fs.readFileSync(path.resolve(__dirname, '../../migrations/0055_inventory_location_identity_guard.sql'), 'utf8').split('--> statement-breakpoint')[0]
    await conflict(() => c.query(preflight))
  }))
  test('0009 already refuses stocked-market reclassification and missing store mapping', () => txn(async () => {
    const p = await seed(c, 'LEGACY_GUARD_')
    for (const [query, params, pattern] of [
      ["UPDATE org_nodes SET type='门店' WHERE id=$1", [p + 'MKT'], /已作为库存主体/],
      ['INSERT INTO stores(store_id,store_name) VALUES ($1,$1)', [p + 'NULL_STORE'], /必须关联归属市场下的门店组织节点/],
    ]) {
      await c.query('SAVEPOINT legacy_guard')
      await assert.rejects(() => c.query(query, params), pattern)
      await c.query('ROLLBACK TO SAVEPOINT legacy_guard')
    }
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
  test('real DB collision passes through Drizzle/staff wrappers as CONFLICT -409', async () => {
    const postgres = require('../../../fengyu-admin/node_modules/postgres')
    const { drizzle } = require('../../../fengyu-admin/node_modules/drizzle-orm/postgres-js')
    const { sql } = require('../../../fengyu-admin/node_modules/drizzle-orm')
    const ts = require('../../../fengyu-admin/node_modules/typescript')
    const pgClient = postgres(url, { max: 1 })
    const actualDb = drizzle(pgClient)
    const api = {}
    const apiSource = fs.readFileSync(path.resolve(__dirname, '../../../fengyu-admin/src/lib/api-error.ts'), 'utf8')
    const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('exports', compile(apiSource))(api)
    const p = await seed(c, 'ERROR_PIPE_')
    // Real drift forces UPSERT; create a collision after the real probe to
    // reproduce its TOCTOU window, rather than injecting an artificial Error.
    await c.query('BEGIN')
    await c.query('ALTER TABLE org_nodes DISABLE TRIGGER trg_org_nodes_sync_inventory_locations')
    await c.query('UPDATE org_nodes SET name=$2 WHERE id=$1', [p + 'MKT', p + 'NEW_NAME'])
    await c.query('ALTER TABLE org_nodes ENABLE TRIGGER trg_org_nodes_sync_inventory_locations')
    await c.query('COMMIT')
    let staffPool
    try {
      let orgUpsert
      for (const [file, name] of [['engine.ts', 'syncInventoryLocations'], ['business.ts', 'syncLocations']]) {
        const source = fs.readFileSync(path.resolve(__dirname, '../../../fengyu-admin/src/lib/inventory', file), 'utf8')
        const start = source.indexOf('async function ' + name + '(')
        const fn = source.slice(start, source.indexOf('\n}', start) + 2)
        orgUpsert = fn.match(/INSERT INTO inventory_locations[\s\S]*?updated_at = NOW\(\)/)[0]
        let first = true
        const db = { execute: async query => {
          const result = await actualDb.execute(query)
          if (first) {
            first = false
            assert.equal(result[0].collided_id, null)
            assert.equal(result[0].drifted, true)
            await c.query('BEGIN')
            await c.query('ALTER TABLE stores DISABLE TRIGGER trg_stores_sync_inventory_locations')
            await store(c, p + 'MKT', p + 'ORG')
            await c.query('ALTER TABLE stores ENABLE TRIGGER trg_stores_sync_inventory_locations')
            await c.query('COMMIT')
          }
          return result
        } }
        const exports = {}
        new Function('exports', 'db', 'sql', 'ApiError', compile(fn + '\nexports.run = ' + name))(exports, db, sql, api.ApiError)
        const response = await api.runWithApiResponse('t270_real_' + name, exports.run)
        assert.equal(response.code, -409)
        assert.equal(response.errorType, 'CONFLICT')
        assert.match(response.message, new RegExp(p + 'MKT'))
        await c.query('DELETE FROM stores WHERE store_id=$1', [p + 'MKT'])
      }
      await c.query('BEGIN')
      await c.query('ALTER TABLE stores DISABLE TRIGGER trg_stores_sync_inventory_locations')
      await store(c, p + 'MKT', p + 'ORG')
      await c.query('ALTER TABLE stores ENABLE TRIGGER trg_stores_sync_inventory_locations')
      await c.query('COMMIT')
      const previousUrl = process.env.PG_CONNECTION_STRING
      process.env.PG_CONNECTION_STRING = url
      const staffPg = require('../../../fengyu-staff/cloudfunctions/staffApi/db/pg')
      const { buildErrorResponse } = require('../../../fengyu-staff/cloudfunctions/staffApi/utils/error-codes')
      staffPool = staffPg.getPool()
      if (previousUrl === undefined) delete process.env.PG_CONNECTION_STRING
      else process.env.PG_CONNECTION_STRING = previousUrl
      const error = await staffPg.transaction(client => client.query(orgUpsert)).then(() => null, err => err)
      assert.ok(error)
      const response = buildErrorResponse(error)
      assert.equal(response.code, -409)
      assert.equal(response.errorType, 'CONFLICT')
      assert.match(response.message, new RegExp(p + 'MKT'))
    } finally {
      await pgClient.end({ timeout: 0 })
      if (staffPool) await staffPool.end()
      await c.query('ROLLBACK')
      await c.query('DELETE FROM stores WHERE store_id=$1', [p + 'MKT'])
      await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'ORG'])
      await c.query('DELETE FROM inventory_locations WHERE location_id=$1', [p + 'MKT'])
      await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'MKT'])
      await c.query('DELETE FROM inventory_locations WHERE location_id=$1', [p + 'HQ'])
      await c.query('DELETE FROM org_nodes WHERE id=$1', [p + 'HQ'])
    }
  })
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
