#!/usr/bin/env node
/**
 * reset-drizzle-journal.js
 *
 * 一次性脚本：把一个 PostgreSQL 库的 drizzle.__drizzle_migrations 表重置为
 * 只包含 migrations/0000_baseline.sql 的一条记录。用于 2026-04-10 的 baseline
 * reset 收尾——让 drizzle-kit migrate 认为"已经到最新"，未来只 apply 增量。
 *
 * 使用方式：
 *   # dry-run（默认，只打印将执行的 SQL）
 *   DATABASE_URL="postgresql://..." node db/scripts/reset-drizzle-journal.js
 *
 *   # 真实执行
 *   DATABASE_URL="postgresql://..." node db/scripts/reset-drizzle-journal.js --yes
 *
 * 算法（和 drizzle-orm migrator.js 内部实现字节级一致）：
 *   hash = sha256(整个 0000_baseline.sql 字节内容).digest('hex')
 *   created_at = _journal.json 里 entries[0].when（毫秒时间戳 bigint）
 *
 * 本脚本仅适用于 baseline 只有一条 entry 的情况。之后任何增量 migration
 * 都不应再用本脚本——用标准 `npm run db:migrate` 即可。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Client } = require('pg')

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta/_journal.json')

async function main() {
  const dryRun = !process.argv.includes('--yes')

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var not set.')
    process.exit(2)
  }

  // 1. 读 journal 并断言只有 baseline 一条
  if (!fs.existsSync(JOURNAL_PATH)) {
    throw new Error(`Journal not found: ${JOURNAL_PATH}`)
  }
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'))
  if (!Array.isArray(journal.entries) || journal.entries.length !== 1) {
    throw new Error(
      `Expected exactly 1 journal entry (baseline only), got ${journal.entries?.length ?? 'none'}. ` +
      `This script must run immediately after baseline generation, before any incremental migration is added.`
    )
  }
  const entry = journal.entries[0]
  if (entry.tag !== '0000_baseline') {
    throw new Error(`Expected tag=0000_baseline, got tag=${entry.tag}`)
  }

  // 2. 读 baseline .sql 算 hash
  const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Baseline SQL not found: ${sqlPath}`)
  }
  const sqlContent = fs.readFileSync(sqlPath, 'utf8')
  const hash = crypto.createHash('sha256').update(sqlContent).digest('hex')
  const createdAt = String(entry.when) // bigint 兼容

  console.log('========================================')
  console.log('reset-drizzle-journal.js')
  console.log('========================================')
  console.log(`DATABASE_URL:  ${maskUrl(process.env.DATABASE_URL)}`)
  console.log(`Baseline tag:  ${entry.tag}`)
  console.log(`Baseline hash: ${hash}`)
  console.log(`created_at:    ${createdAt} (${new Date(Number(createdAt)).toISOString()})`)
  console.log(`Mode:          ${dryRun ? 'DRY RUN (pass --yes to execute)' : 'LIVE (--yes passed)'}`)
  console.log()

  // 3. 连库
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // 4. 确保 drizzle schema 和 __drizzle_migrations 表存在
    //    （drizzle-kit migrate 首次运行时会自动创建，如果从未运行则需要手动建）
    const { rows: schemaCheck } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='drizzle') AS exists
    `)
    console.log(`drizzle schema exists: ${schemaCheck[0].exists}`)

    const { rows: tableCheck } = await client.query(`
      SELECT to_regclass('drizzle.__drizzle_migrations') AS tbl
    `)
    console.log(`drizzle.__drizzle_migrations exists: ${tableCheck[0].tbl ? 'YES' : 'NO'}`)

    // 5. 读现状
    let current = []
    if (tableCheck[0].tbl) {
      const res = await client.query(`
        SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
      `)
      current = res.rows
    }
    console.log(`\nCurrent __drizzle_migrations rows: ${current.length}`)
    for (const r of current) {
      console.log(`  id=${r.id} hash=${r.hash.slice(0, 16)}... created_at=${r.created_at}`)
    }

    if (dryRun) {
      console.log('\n--- PLANNED SQL (dry run, not executed) ---')
      console.log(`CREATE SCHEMA IF NOT EXISTS drizzle;`)
      console.log(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (`)
      console.log(`  id SERIAL PRIMARY KEY,`)
      console.log(`  hash text NOT NULL,`)
      console.log(`  created_at bigint`)
      console.log(`);`)
      console.log(`BEGIN;`)
      console.log(`TRUNCATE drizzle.__drizzle_migrations RESTART IDENTITY;`)
      console.log(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)`)
      console.log(`VALUES ('${hash}', ${createdAt});`)
      console.log(`COMMIT;`)
      console.log('\nPass --yes to execute.')
      return
    }

    // 6. 真实执行
    console.log('\n--- EXECUTING ---')
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `)
    await client.query('BEGIN')
    try {
      await client.query('TRUNCATE drizzle.__drizzle_migrations RESTART IDENTITY')
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [hash, createdAt]
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }

    // 7. 后置校验
    const { rows: after } = await client.query(`
      SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
    `)
    console.log(`\nAfter reset: ${after.length} rows`)
    for (const r of after) {
      console.log(`  id=${r.id} hash=${r.hash.slice(0, 16)}... created_at=${r.created_at}`)
    }
    if (after.length !== 1 || after[0].hash !== hash || String(after[0].created_at) !== createdAt) {
      throw new Error('Post-condition failed: row count/hash/created_at mismatch')
    }
    console.log('\nOK: journal reset complete.')
  } finally {
    await client.end()
  }
}

function maskUrl(url) {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url.replace(/:[^:@]+@/, ':***@')
  }
}

main().catch(e => {
  console.error('\nERROR:', e.message || e)
  process.exit(1)
})
