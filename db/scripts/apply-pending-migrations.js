#!/usr/bin/env node
/**
 * 自定义 migrator：绕过 drizzle migrator 的单事务包装。
 *
 * 背景：drizzle-orm 把整个 migration 文件包在一个 transaction 里执行，
 * 导致 `ALTER TYPE ADD VALUE` + 后续引用新值的语句 (CREATE INDEX ... WHERE col=新值)
 * 触发 PG 报错 `unsafe use of new value`（PG 要求新枚举值 commit 后才能使用）。
 *
 * 本脚本按 `--> statement-breakpoint` 切分每条 SQL，独立 autocommit 执行。
 * 失败回滚仅限单条；ENUM ADD VALUE 不在事务内可避免新值引用问题。
 *
 * 使用：DATABASE_URL=postgresql://... node scripts/apply-pending-migrations.js
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'pg';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL required'); process.exit(1); }

const MIGRATIONS_DIR = path.resolve('migrations');
const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));

const client = new Client({ connectionString: DB_URL });
await client.connect();

// 创建 migration 表（与 drizzle 兼容）
await client.query(`
  CREATE SCHEMA IF NOT EXISTS drizzle;
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at BIGINT
  );
`);

// 已 apply 的 hash 集合
const { rows: applied } = await client.query('SELECT hash FROM drizzle.__drizzle_migrations');
const appliedHashes = new Set(applied.map(r => r.hash));

let appliedCount = 0;
for (const entry of journal.entries) {
  const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');
  if (appliedHashes.has(hash)) {
    console.log(`SKIP ${entry.tag} (already applied)`);
    continue;
  }
  console.log(`APPLY ${entry.tag} ...`);

  // 按 statement-breakpoint 切分
  const stmts = sql.split('--> statement-breakpoint')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 100);
    try {
      await client.query(stmt);
      console.log(`  OK [${i + 1}/${stmts.length}] ${preview}`);
    } catch (e) {
      console.error(`  FAIL [${i + 1}/${stmts.length}] ${preview}`);
      console.error(`    ${e.message}`);
      throw e;
    }
  }

  // 记录到 drizzle migrations 表
  await client.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
    [hash, entry.when]
  );
  appliedCount++;
  console.log(`DONE ${entry.tag}`);
}

console.log(`\nApplied ${appliedCount} migration(s).`);
await client.end();
