/** #353 真 PG 回归；仅 54405 私有库或 CI 5432/test，逐例事务回滚。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { randomUUID } = require('node:crypto')

const connectionString = process.env.STORE_SURPLUS_PG_TEST_URL
if (!connectionString) {
  test('#353 迁移真 PG（未设 STORE_SURPLUS_PG_TEST_URL）', { skip: true }, () => {})
} else {
  const url = new URL(connectionString)
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname))
  const privateTarget = url.port === '54405' && ['/verify_353_handoff', '/verify_353_empty'].includes(url.pathname)
  const ciTarget = process.env.CI === 'true' && url.port === '5432' && url.pathname === '/test'
  assert.ok(privateTarget || ciTarget, '仅接受本会话私有库或 CI service 测试库')
  assert.equal(url.search, '')
  const client = new Client({ connectionString })
  test.before(async () => {
    await client.connect()
    const { rows } = await client.query('SELECT current_database() AS db')
    assert.equal(rows[0].db, url.pathname.slice(1))
  })
  test.after(() => client.end())

  async function fixture(fn) {
    const p = `T353_${randomUUID().slice(0, 8)}_`
    await client.query('BEGIN')
    try {
      await client.query('INSERT INTO staff_wechat_users (employee_id) VALUES ($1)', [p + 'EMP'])
      await client.query(`INSERT INTO org_nodes (id, name, type) VALUES ($1, $1, '总部')`, [p + 'HQ'])
      await client.query(`INSERT INTO org_nodes (id, name, type, parent_id)
        VALUES ($1, $1, '市场', $3), ($2, $2, '市场', $3)`, [p + 'M1', p + 'M2', p + 'HQ'])
      await client.query(`INSERT INTO org_nodes (id, name, type, parent_id)
        VALUES ($1, $1, '门店', $2)`, [p + 'ST', p + 'M1'])
      await client.query('INSERT INTO stores (store_id, store_name, org_node_id) VALUES ($1, $1, $1)', [p + 'ST'])
      await client.query(`INSERT INTO inventory_skus (sku_id, product_code, product_name, market_purchase_price_mode)
        VALUES ($1, $1, $1, '公式'), ($2, $2, $2, '公式')`, [p + 'SKU', p + 'OTHER'])
      let seq = 0
      async function doc(type, { node = p + 'M1', status = '已完成' } = {}) {
        const id = p + (++seq)
        await client.query(`INSERT INTO inventory_docs
          (id, doc_type, status, source_org_node_id, target_org_node_id, doc_date, created_by)
          VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, $5)`, [id, type, status, node, p + 'EMP'])
        return id
      }
      async function item(docId, qty, { snapshot = null, sku = p + 'SKU', price = null, actual = null } = {}) {
        const { rows } = await client.query(`INSERT INTO inventory_doc_items
          (doc_id, sku_id, sku_name, quantity, stock_snapshot, standard_unit_price, actual_unit_price)
          VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING id, amount::text AS amount`,
        [docId, sku, qty, snapshot, price, actual])
        return { ...rows[0], docId }
      }
      const link = (from, to, qty) => client.query(`INSERT INTO inventory_doc_links
        (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
        VALUES ($1, $2, '盘点盘溢', $3, $4, $5) RETURNING id`, [from.docId, to.docId, from.id, to.id, qty])
      async function reject(fn, predicate) {
        await client.query('SAVEPOINT expected_failure')
        try { await assert.rejects(fn, predicate) }
        finally { await client.query('ROLLBACK TO SAVEPOINT expected_failure') }
      }
      await fn({ p, doc, item, link, reject })
    } finally { await client.query('ROLLBACK') }
  }

  test('标准价允许 NULL/0/正数，拒绝负数和 NaN；不回填老价格', () => fixture(async ({ p, reject }) => {
    const { rows } = await client.query('SELECT standard_price FROM inventory_skus WHERE sku_id=$1', [p + 'SKU'])
    assert.equal(rows[0].standard_price, null)
    for (const price of [0, 18.25, null]) {
      await client.query('UPDATE inventory_skus SET standard_price=$1 WHERE sku_id=$2', [price, p + 'SKU'])
    }
    for (const price of [-1, 'NaN']) {
      await reject(() => client.query('UPDATE inventory_skus SET standard_price=$1 WHERE sku_id=$2', [price, p + 'SKU']),
        err => err.code === '23514' && err.constraint === 'chk_inventory_skus_prices_nonnegative')
    }
  }))

  for (const [sourceType, targetType, nodeSuffix] of [
    ['市场库存盘点', '市场产品盘溢', 'M1'], ['分院库存盘点', '院产品盘溢', 'ST'],
  ]) {
    test(`${targetType}：同主体完成盘点、正差异分批关联，累计不能超过差异`, () => fixture(async ({ p, doc, item, link, reject }) => {
      const source = await item(await doc(sourceType, { node: p + nodeSuffix }), 15, { snapshot: 10 })
      const a = await item(await doc(targetType, { node: p + nodeSuffix }), 3, { price: 12.5 })
      assert.equal(a.amount, '37.50')
      await link(source, a, 3)
      const b = await item(await doc(targetType, { node: p + nodeSuffix }), 2, { price: 12.5 })
      const { rows } = await link(source, b, 2)
      // 已累计5：若UPDATE未排除本条，重验时会误算成7；不是无判别力的同值操作。
      await client.query('UPDATE inventory_doc_links SET quantity=2 WHERE id=$1', [rows[0].id])
      await reject(() => client.query('UPDATE inventory_doc_links SET quantity=1 WHERE id=$1', [rows[0].id]), /INVALID_PARAMS: 盘点盘溢来源/)
      const extra = await item(await doc(targetType, { node: p + nodeSuffix }), 1)
      await reject(() => link(source, extra, 1), /CONFLICT: 盘溢数量超出/)
    }))
  }

  test('盘点血缘拒绝草稿来源、跨主体、不同 SKU、无快照和非正差异', () => fixture(async ({ p, doc, item, link, reject }) => {
    for (const invalid of ['draft', 'other-node', 'other-sku', 'no-snapshot', 'no-surplus', 'NaN-snapshot']) {
      const source = await item(await doc('市场库存盘点', { status: invalid === 'draft' ? '草稿' : '已完成' }),
        invalid === 'no-surplus' ? 10 : 15, { snapshot: invalid === 'no-snapshot' ? null : invalid === 'NaN-snapshot' ? 'NaN' : 10 })
      const target = await item(await doc('市场产品盘溢', { node: invalid === 'other-node' ? p + 'M2' : p + 'M1' }), 2,
        { sku: invalid === 'other-sku' ? p + 'OTHER' : p + 'SKU' })
      await reject(() => link(source, target, 2), /INVALID_PARAMS: 盘点盘溢来源/)
    }
  }))

  test('拒绝类型错配、关联数不等于目标明细、NaN 关联数；缺实际价用标准价，0 实际价保留', () => fixture(async ({ doc, item, link, reject }) => {
    const source = await item(await doc('市场库存盘点'), 15, { snapshot: 10 })
    const storeTarget = await item(await doc('院产品盘溢'), 2)
    await reject(() => link(source, storeTarget, 2), /INVALID_PARAMS: 盘点盘溢来源/)
    const target = await item(await doc('市场产品盘溢'), 2, { price: 18.25 })
    assert.equal(target.amount, '36.50')
    await reject(() => link(source, target, 1), /INVALID_PARAMS: 盘点盘溢来源/)
    await reject(() => link(source, target, 'NaN'), /INVALID_PARAMS: 盘点盘溢来源/)
    const zeroActual = await item(await doc('院产品盘溢'), 2, { price: 18.25, actual: 0 })
    assert.equal(zeroActual.amount, '0.00')
  }))

  test('既有采购订单金额分支仍使用供应链成本价', () => fixture(async ({ doc, item }) => {
    const row = await item(await doc('采购订单'), 2, { price: 18.25 })
    await client.query('UPDATE inventory_doc_items SET supply_chain_unit_cost=7 WHERE id=$1', [row.id])
    const { rows } = await client.query('SELECT amount::text AS amount FROM inventory_doc_items WHERE id=$1', [row.id])
    assert.equal(rows[0].amount, '14.00')
  }))

  test('数据库先行时旧市场盘溢的明确实际价仍优先；旧价格全空仍为 NULL', () => fixture(async ({ doc, item }) => {
    // 当前 dev 的通用建单会从批次算出实际价并明确写 actual_unit_price。
    const oldStyle = await item(await doc('市场产品盘溢'), 2, { price: 18.25, actual: 12.5 })
    assert.equal(oldStyle.amount, '25.00')
    const missingPrice = await item(await doc('市场产品盘溢'), 2)
    assert.equal(missingPrice.amount, null)
  }))
}
