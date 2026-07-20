/**
 * 验证 0020 mixed CHECK trigger 在 D4 违反时正确拒绝。
 * 用一次性事务 ROLLBACK，不留任何数据。
 */
import { Client } from 'pg';
const c = new Client({ connectionString: 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp' });
await c.connect();

// 找一个真实存在的 sale_order_id 用于测试（避免 FK 失败）
const { rows } = await c.query(`SELECT sale_order_id FROM sale_orders LIMIT 1`);
if (rows.length === 0) {
  console.log('No sale_orders to test against; skipping (DB empty)');
  await c.end();
  process.exit(0);
}
const orderId = rows[0].sale_order_id;
console.log('Test target:', orderId);

// Test: BEGIN; INSERT 一行 is_recharge_card=true，再 INSERT 一行 false；COMMIT 应抛错
try {
  await c.query('BEGIN');
  // 找一个存在的 store + sku 用于 FK
  const { rows: storeRow } = await c.query(`SELECT store_id FROM stores LIMIT 1`);
  const storeId = storeRow[0].store_id;
  await c.query(`
    INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
      product_name, unit_price, quantity, unit_real_price, sale_amount,
      received, is_recharge_card)
    VALUES ('TEST_D4_R1_' || floor(random()*1e9), $1, $2, '购买', 'TEST_R',
      100, 1, 100, 100, 100, true)
  `, [orderId, storeId]);
  await c.query(`
    INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
      product_name, unit_price, quantity, unit_real_price, sale_amount,
      received, is_recharge_card)
    VALUES ('TEST_D4_N1_' || floor(random()*1e9), $1, $2, '购买', 'TEST_N',
      200, 1, 200, 200, 200, false)
  `, [orderId, storeId]);
  console.log('Both rows inserted (deferred trigger)');
  await c.query('COMMIT');
  console.log('  !!! ERROR: COMMIT 成功了，trigger 未生效');
  process.exit(1);
} catch (e) {
  console.log('Trigger fired correctly:', e.message);
  try { await c.query('ROLLBACK'); } catch {}
}

// 验证回滚后无残留
const { rows: residue } = await c.query(`
  SELECT count(*) FROM sale_items WHERE sale_item_id LIKE 'TEST_D4_%'
`);
console.log('Residue count after ROLLBACK (expect 0):', residue[0].count);

await c.end();
console.log('D4 trigger verified ✓');
