import { Client } from 'pg';
const c = new Client({ connectionString: 'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu' });
await c.connect();
const r = await c.query(`
  SELECT column_name, data_type, udt_name, column_default
  FROM information_schema.columns
  WHERE table_name = 'sale_orders' AND column_name = 'sale_order_type'
`);
console.log('sale_orders.sale_order_type column:', r.rows);

const r2 = await c.query(`
  SELECT cl.relname AS table_name, a.attname AS column_name
  FROM pg_attribute a
  JOIN pg_class cl ON a.attrelid = cl.oid
  JOIN pg_type t ON a.atttypid = t.oid
  WHERE t.typname = 'sale_order_type' AND a.attnum > 0
`);
console.log('Columns using sale_order_type:', r2.rows);

await c.end();
