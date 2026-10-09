#!/usr/bin/env node
// 只读来源缺口审计，不生成已付价值，不写库；显式 DATABASE_URL，无远程默认值。
const { Client } = require('pg')
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('请显式提供 DATABASE_URL')
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const result = await client.query(`SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
      CASE WHEN si.item_direction = '转出' AND ref.sale_item_id IS NULL THEN 'missing-source-item'
           WHEN ref_order.sale_order_type = '转换单' AND ref.conversion_value_snapshot IS NULL THEN 'missing-prior-generation'
           WHEN EXISTS (SELECT 1 FROM sale_order_payments p WHERE p.sale_order_id = si.sale_order_id AND p.change_type = '退款' AND p.status = '已支付') THEN 'legacy-refund-needs-reconciliation'
           ELSE 'candidate-for-locked-runtime-reconstruction' END AS source_status
      FROM sale_items si JOIN sale_orders so USING (sale_order_id)
      LEFT JOIN sale_items ref ON ref.sale_item_id = si.ref_sale_item_id
      LEFT JOIN sale_orders ref_order ON ref_order.sale_order_id = ref.sale_order_id
      WHERE so.sale_order_type = '转换单' AND so.status <> '已关闭'
        AND si.conversion_value_snapshot IS NULL
      ORDER BY si.sale_order_id, si.sale_item_id`)
    console.log(JSON.stringify({ missingCount: result.rows.length, items: result.rows }, null, 2))
    await client.query('ROLLBACK')
  } finally { await client.end() }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
