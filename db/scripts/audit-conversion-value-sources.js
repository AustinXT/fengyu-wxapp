#!/usr/bin/env node
// 只读来源缺口审计，不生成已付价值，不写库；显式 DATABASE_URL，无远程默认值。
const { Client } = require('pg')
const { CONVERSION_SOURCE_AUDIT_SQL } = require('../../fengyu-staff/cloudfunctions/staffApi/utils/conversion-sources')
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('请显式提供 DATABASE_URL')
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const result = await client.query(`SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
      CASE WHEN si.item_direction = '转入' AND EXISTS (SELECT 1 FROM sale_items oi JOIN sale_orders co ON co.sale_order_id = oi.sale_order_id WHERE oi.ref_sale_item_id = si.sale_item_id AND oi.item_direction = '转出' AND co.status <> '已关闭') AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions,0)=0 ELSE COALESCE(si.picked_up_quantity,0)+COALESCE(si.refunded_quantity,0)+COALESCE(si.converted_quantity,0)>=si.quantity END THEN 'exited-input-needs-reconciliation'
           WHEN si.item_direction = '转出' AND ref.sale_item_id IS NULL THEN 'missing-source-item'
           WHEN ref_order.sale_order_type = '转换单' AND ref.conversion_value_snapshot IS NULL THEN 'missing-prior-generation'
           WHEN EXISTS (SELECT 1 FROM sale_order_payments p WHERE p.sale_order_id = si.sale_order_id AND p.change_type = '退款' AND p.status = '已支付') THEN 'legacy-refund-needs-reconciliation'
           ELSE 'legacy-responsibility-needs-offline-evidence' END AS source_status
      FROM sale_items si JOIN sale_orders so USING (sale_order_id)
      LEFT JOIN sale_items ref ON ref.sale_item_id = si.ref_sale_item_id
      LEFT JOIN sale_orders ref_order ON ref_order.sale_order_id = ref.sale_order_id
      WHERE so.sale_order_type = '转换单' AND so.status <> '已关闭'
        AND COALESCE(si.conversion_value_snapshot->>'version','') <> '2'
      ORDER BY si.sale_order_id, si.sale_item_id`)
    const integrity = await client.query(CONVERSION_SOURCE_AUDIT_SQL)
    console.log(JSON.stringify({ integrityViolations: integrity.rows, missingCount: result.rows.length, items: result.rows }, null, 2))
    await client.query('ROLLBACK')
  } finally { await client.end() }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
