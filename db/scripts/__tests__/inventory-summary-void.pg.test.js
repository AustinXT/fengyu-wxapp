/** #356 作废汇总：真 PG 状态机/EXISTS 守卫，仅私有验证库，事务回滚。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const url = process.env.INVENTORY_PG_TEST_URL
if (!url) {
  test('#356 汇总作废 PG 守卫（未设 INVENTORY_PG_TEST_URL）', { skip: true }, () => {})
} else {
  const client = new Client({ connectionString: url })
  test.before(async () => {
    await client.connect()
    const { rows } = await client.query('SELECT current_database() AS db')
    if (['fengyu_wxapp', 'fengyu_e2e', 'fengyu'].includes(rows[0].db)) throw new Error('禁止使用业务库')
  })
  test.after(async () => { await client.end() })
  async function fixture(fn) {
    await client.query('BEGIN')
    try {
      await client.query("INSERT INTO staff_wechat_users (employee_id) VALUES ('T356PG_EMP')")
      await client.query("INSERT INTO org_nodes (id,name,type) VALUES ('T356PG_HQ','验证总部','总部')")
      await client.query("INSERT INTO inventory_skus (sku_id,product_code,product_name,source_type) VALUES ('T356PG_SKU','T356PG_SKU','验证商品','市场自采')")
      for (const [id, type] of [['SUM','市场报货汇总'],['PO','采购订单'],['OTHER','品项公司报货需求']]) {
        await client.query(`INSERT INTO inventory_docs (id,doc_type,status,target_org_node_id,doc_date,created_by)
          VALUES ($1,$2,'草稿','T356PG_HQ',CURRENT_DATE,'T356PG_EMP')`, ['T356PG_'+id,type])
      }
      const items = {}
      for (const id of ['SUM','PO']) {
        const { rows } = await client.query(`INSERT INTO inventory_doc_items (doc_id,sku_id,sku_name,quantity,fulfilled_quantity)
          VALUES ($1,'T356PG_SKU','验证商品',10,0) RETURNING id`, ['T356PG_'+id])
        items[id] = rows[0].id
      }
      await client.query("UPDATE inventory_docs SET status='已完成' WHERE id IN ('T356PG_SUM','T356PG_OTHER')")
      await client.query("UPDATE inventory_docs SET status='待收货' WHERE id='T356PG_PO'")
      await fn(items)
    } finally { await client.query('ROLLBACK') }
  }
  const cancel = (id='SUM', reason='汇总范围有误') => client.query(`UPDATE inventory_docs SET status='已取消',cancellation_reason=$2,cancelled_by='T356PG_EMP',cancelled_at=NOW() WHERE id=$1`, ['T356PG_'+id, reason])
  async function rejects(fn, pattern) {
    await client.query('SAVEPOINT expected_rejection')
    await assert.rejects(fn, pattern)
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection')
  }
  const link = (items) => client.query(`INSERT INTO inventory_doc_links (from_doc_id,to_doc_id,relation_type,from_item_id,to_item_id,quantity)
    VALUES ('T356PG_SUM','T356PG_PO','报货汇总采购订单',$1,$2,10)`, [items.SUM,items.PO])
  test('无引用且零履约允许作废；审计字段写入，明细保留', async () => fixture(async () => {
    await cancel()
    const { rows } = await client.query("SELECT status,cancellation_reason,cancelled_by,cancelled_at FROM inventory_docs WHERE id='T356PG_SUM'")
    assert.equal(rows[0].status,'已取消'); assert.equal(rows[0].cancelled_by,'T356PG_EMP'); assert.ok(rows[0].cancelled_at)
    const { rows: lines } = await client.query("SELECT count(*)::int AS count FROM inventory_doc_items WHERE doc_id='T356PG_SUM'")
    assert.equal(lines[0].count,1)
  }))
  test('其它类型已完成→已取消仍拒绝', async () => fixture(async () => rejects(() => cancel('OTHER'), /非法库存单据状态转换/)))
  test('已取消→已完成不可恢复', async () => fixture(async () => {
    await cancel()
    await rejects(() => client.query("UPDATE inventory_docs SET status='已完成' WHERE id='T356PG_SUM'"), /非法库存单据状态转换/)
  }))
  test('未取消采购引用：即使 fulfilled=0 也由 EXISTS 拒绝', async () => fixture(async (items) => {
    await link(items)
    await rejects(() => cancel(), /未取消的采购订单引用/)
  }))
  test('采购全部取消且零履约允许作废，原血缘保留', async () => fixture(async (items) => {
    await link(items)
    await cancel('PO')
    await cancel()
    const { rows } = await client.query("SELECT count(*)::int AS count FROM inventory_doc_links WHERE from_doc_id='T356PG_SUM'")
    assert.equal(rows[0].count,1)
  }))
  test('采购取消但已有0.01履约仍拒绝', async () => fixture(async (items) => {
    await link(items); await cancel('PO')
    await client.query('UPDATE inventory_doc_items SET fulfilled_quantity=0.01 WHERE id=$1',[items.SUM])
    await rejects(() => cancel(), /已有履约数量/)
  }))
  test('无引用但有履约仍拒绝', async () => fixture(async (items) => {
    await client.query('UPDATE inventory_doc_items SET fulfilled_quantity=1 WHERE id=$1',[items.SUM])
    await rejects(() => cancel(), /已有履约数量/)
  }))
  for (const reason of [null,'','   ']) test(`作废原因必填：${JSON.stringify(reason)}`, async () => fixture(async () => rejects(() => cancel('SUM',reason), /作废原因不能为空/)))
}
