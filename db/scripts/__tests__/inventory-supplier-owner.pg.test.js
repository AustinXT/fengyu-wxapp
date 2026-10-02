const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Client } = require('pg')
const { upsertSku } = require('../workfine-inventory-common')
const url = process.env.SUPPLIER_OWNER_TEST_DATABASE_URL

// 仅允许本单私有库或 GitHub Actions 的临时 PG service，绝不回退业务连接串。
test('#365 正式迁移保留存量共有并实现两种名称唯一', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  const privateTarget = target.port === '54405' && ['/verify_365', '/verify_365_empty'].includes(target.pathname)
  const ciTarget = process.env.CI === 'true' && target.port === '5432' && target.pathname === '/test'
  assert.ok(privateTarget || ciTarget, '拒绝非本单私有库或 CI service')
  assert.equal([...target.searchParams].length, 0)
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, target.pathname.slice(1))
    const before = await client.query(`INSERT INTO inventory_suppliers
      (supplier_id,name,is_active,created_at,updated_at) VALUES
      ('VERIFY365-OLD-ON','VERIFY365-存量共有',true,'2026-01-01','2026-01-02'),
      ('VERIFY365-OLD-OFF','VERIFY365-停用共有',false,'2026-01-01','2026-01-02') RETURNING *`)
    const dbDir = path.resolve(__dirname, '../..')
    const { rows: columns } = await client.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='inventory_suppliers' AND column_name='owner_market_id'`)
    if (columns.length === 0) {
      // 带旧存量的私有基线走真实 Drizzle 入口，不能只验证候选 SQL。
      execFileSync(process.execPath, [path.join(dbDir, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], {
        cwd: dbDir, env: { ...process.env, DATABASE_URL: url, PGOPTIONS: '-c lock_timeout=3s' }, stdio: 'pipe',
      })
    }
    const journal = JSON.parse(fs.readFileSync(path.join(dbDir, 'migrations/meta/_journal.json'), 'utf8'))
    const entry = journal.entries.find((item) => item.tag.endsWith('_market_supplier_owner'))
    assert.ok(entry, '正式迁移必须登记 journal')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dbDir, 'migrations', `${entry.tag}.sql`))).digest('hex')
    const applied = await client.query('SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=$1', [entry.when])
    assert.deepEqual(applied.rows, [{ hash }])
    const after = await client.query(`SELECT * FROM inventory_suppliers WHERE supplier_id LIKE 'VERIFY365-OLD-%' ORDER BY supplier_id`)
    assert.equal(after.rows.length, 2)
    for (const row of after.rows) {
      assert.equal(row.owner_market_id, null)
      const old = before.rows.find((item) => item.supplier_id === row.supplier_id)
      const comparable = { ...row }
      if (!Object.hasOwn(old, 'owner_market_id')) delete comparable.owner_market_id
      assert.deepEqual(comparable, old)
    }
    await client.query(`INSERT INTO org_nodes (id,name,type) VALUES ('VERIFY365-HQ','VERIFY365-总部','总部')`)
    await client.query(`INSERT INTO org_nodes (id,name,type,parent_id) VALUES
      ('VERIFY365-M1','VERIFY365-市场一','市场','VERIFY365-HQ'),
      ('VERIFY365-M2','VERIFY365-市场二','市场','VERIFY365-HQ')`)
    await client.query(`INSERT INTO inventory_suppliers (supplier_id,name,owner_market_id) VALUES
      ('VERIFY365-SHARED','VERIFY365-同名',NULL),
      ('VERIFY365-OWN1','VERIFY365-同名','VERIFY365-M1'),
      ('VERIFY365-OWN2','VERIFY365-同名','VERIFY365-M2')`)
    await assert.rejects(client.query(`INSERT INTO inventory_suppliers (supplier_id,name,is_active) VALUES
      ('VERIFY365-DUP-SHARED','VERIFY365-同名',false)`), (e) => e.code === '23505' && e.constraint === 'uq_inventory_suppliers_shared_name')
    await assert.rejects(client.query(`INSERT INTO inventory_suppliers (supplier_id,name,owner_market_id,is_active) VALUES
      ('VERIFY365-DUP-M1','VERIFY365-同名','VERIFY365-M1',false)`), (e) => e.code === '23505' && e.constraint === 'uq_inventory_suppliers_market_name')
    await assert.rejects(client.query(`INSERT INTO inventory_suppliers (supplier_id,name,owner_market_id) VALUES
      ('VERIFY365-BAD-OWNER','VERIFY365-未知','VERIFY365-MISSING')`), (e) => e.code === '23503')
    const { rows: indexes } = await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='inventory_suppliers'`)
    assert.ok(!indexes.some((row) => row.indexname === 'uq_inventory_suppliers_name'))
    assert.match(indexes.find((row) => row.indexname === 'uq_inventory_suppliers_shared_name').indexdef, /UNIQUE.+\(name\).+owner_market_id IS NULL/)
    assert.match(indexes.find((row) => row.indexname === 'uq_inventory_suppliers_market_name').indexdef, /UNIQUE.+\(owner_market_id, name\).+owner_market_id IS NOT NULL/)
    assert.ok(indexes.some((row) => row.indexname === 'idx_inventory_suppliers_owner_market'))
    const importRow = {
      productCode: 'VERIFY365-LINK', productName: 'VERIFY365-导入测试', supplier: 'VERIFY365-同名',
      sourceType: '市场自采', marketId: 'VERIFY365-M1', isReportable: false, isActive: true,
    }
    for (let i = 0; i < 10; i++) {
      const skuId = await upsertSku(client, importRow)
      const { rows: [sku] } = await client.query('SELECT supplier_id FROM inventory_skus WHERE sku_id=$1', [skuId])
      assert.equal(sku.supplier_id, 'VERIFY365-OWN1')
      await client.query('UPDATE inventory_skus SET supplier_id=NULL WHERE sku_id=$1', [skuId])
    }
    console.log('#365 PG：存量启用/停用无损，跨归属同名通过，两条唯一/FK拒绝正例通过')
  } finally {
    try {
      await client.query(`DELETE FROM inventory_skus WHERE product_code='VERIFY365-LINK'`)
      await client.query(`DELETE FROM inventory_suppliers WHERE supplier_id LIKE 'VERIFY365-%'`)
      await client.query(`DELETE FROM inventory_locations WHERE org_node_id IN ('VERIFY365-M1','VERIFY365-M2','VERIFY365-HQ')`)
      await client.query(`DELETE FROM org_nodes WHERE id IN ('VERIFY365-M1','VERIFY365-M2')`)
      await client.query(`DELETE FROM org_nodes WHERE id='VERIFY365-HQ'`)
    } finally { await client.end() }
  }
})
