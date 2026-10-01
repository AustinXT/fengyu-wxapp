const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const { upsertSku } = require('../workfine-inventory-common')
const url = process.env.SUPPLIER_OWNER_TEST_DATABASE_URL

// 候选结构验证必须使用本单私有库，绝不回退业务连接串。
test('#365 候选迁移保留存量共有并实现两种名称唯一', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  assert.equal(target.port, '54405')
  assert.equal(target.pathname, '/verify_365')
  assert.equal([...target.searchParams].length, 0)
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const before = await client.query(`INSERT INTO inventory_suppliers
      (supplier_id,name,is_active,created_at,updated_at) VALUES
      ('VERIFY365-OLD-ON','VERIFY365-存量共有',true,'2026-01-01','2026-01-02'),
      ('VERIFY365-OLD-OFF','VERIFY365-停用共有',false,'2026-01-01','2026-01-02') RETURNING *`)
    await client.query(fs.readFileSync(path.resolve(__dirname, '../../rollout/requests/issue-365.sql'), 'utf8'))
    const after = await client.query(`SELECT * FROM inventory_suppliers WHERE supplier_id LIKE 'VERIFY365-OLD-%' ORDER BY supplier_id`)
    assert.equal(after.rows.length, 2)
    for (const row of after.rows) {
      assert.equal(row.owner_market_id, null)
      const old = before.rows.find((item) => item.supplier_id === row.supplier_id)
      delete row.owner_market_id
      assert.deepEqual(row, old)
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
  } finally { await client.end() }
})
