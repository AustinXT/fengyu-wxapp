/**
 * 修补脚本：5434 上的 0018 半 apply 状态。
 *
 * 问题：drizzle migrate 跑到 0018 第 25 步 `DROP TYPE sale_order_type` 失败，因为
 * sale_orders.sale_order_type 列的 DEFAULT 仍引用旧 enum（drizzle-kit 缺生成 DROP DEFAULT）。
 *
 * 修补思路：
 *   1) 检查是否有 sale_order_type IN ('回款单','退款单') 的数据（0018 缩窄 enum 后无法转回）
 *   2) DROP DEFAULT
 *   3) 跑完 0018 剩余 3 步（DROP TYPE / CREATE TYPE / SET DATA TYPE）
 *   4) SET DEFAULT 回 '销售单'
 *   5) INSERT 0018 hash 到 drizzle.__drizzle_migrations
 *
 * 之后再跑 apply-pending-migrations.js apply 0019。
 */
import { Client } from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';

const c = new Client({ connectionString: 'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu' });
await c.connect();

// Step 1: 检查历史数据
const dataCheck = await c.query(`
  SELECT sale_order_type, COUNT(*) FROM sale_orders
  WHERE sale_order_type IN ('回款单','退款单')
  GROUP BY sale_order_type
`);
console.log('Pre-existing data with retired enum values:', dataCheck.rows);
if (dataCheck.rows.length > 0) {
  console.error('!!! 存在 回款单/退款单 历史数据；缩窄 enum 会导致 cast 失败');
  console.error('!!! 需要先迁移这些数据（合并到销售单或单独处理），再跑本脚本');
  await c.end();
  process.exit(1);
}

// Step 2-4: 修补 + 跑 0018 剩余步骤
const statements = [
  // 补 DROP DEFAULT（drizzle 漏生成）
  `ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" DROP DEFAULT`,
  // 0018 第 25 步
  `DROP TYPE "public"."sale_order_type"`,
  // 0018 第 26 步
  `CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '转换单')`,
  // 0018 第 27 步
  `ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE "public"."sale_order_type" USING "sale_order_type"::"public"."sale_order_type"`,
  // 补 SET DEFAULT
  `ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '销售单'`,
];

for (const stmt of statements) {
  console.log('RUN:', stmt.slice(0, 100));
  await c.query(stmt);
  console.log('  OK');
}

// Step 5: 注册 0018 hash
const sql = fs.readFileSync('migrations/0018_black_madrox.sql', 'utf8');
const hash = crypto.createHash('sha256').update(sql).digest('hex');
const journal = JSON.parse(fs.readFileSync('migrations/meta/_journal.json', 'utf8'));
const entry0018 = journal.entries.find(e => e.tag === '0018_black_madrox');
const exists = await c.query('SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = $1', [hash]);
if (exists.rows[0].count == 0) {
  await c.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
    [hash, entry0018.when]
  );
  console.log('Registered 0018 hash:', hash.slice(0, 16) + '...');
} else {
  console.log('0018 hash already registered');
}

const cnt = await c.query('SELECT count(*) FROM drizzle.__drizzle_migrations');
console.log('Migration count after:', cnt.rows[0].count);

await c.end();
console.log('Done. Now run: DATABASE_URL=... node scripts/apply-pending-migrations.js');
