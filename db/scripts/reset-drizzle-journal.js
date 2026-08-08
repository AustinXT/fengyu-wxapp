#!/usr/bin/env node
/**
 * reset-drizzle-journal.js
 *
 * 一次性脚本：把一个 PostgreSQL 库的 drizzle.__drizzle_migrations 表重置为
 * 只包含 migrations/0000_baseline.sql 的一条记录。用于 2026-08-06 的 baseline
 * reset 收尾——让 drizzle-kit migrate 认为"已经到最新"，未来只 apply 增量。
 *
 * 使用方式：
 *   # dry-run（默认，只打印将执行的 SQL）
 *   DATABASE_URL="postgresql://..." node db/scripts/reset-drizzle-journal.js
 *
 *   # 真实执行
 *   DATABASE_URL="postgresql://..." node db/scripts/reset-drizzle-journal.js --yes
 *
 * 本脚本只转换已完整应用归档 migration 的业务库。空库必须直接运行
 * `npm run db:migrate`，不可用本脚本伪造 baseline 记录。
 *
 * 算法（和 drizzle-orm migrator.js 内部实现字节级一致）：
 *   hash = sha256(整个 0000_baseline.sql 字节内容).digest('hex')
 *   created_at = _journal.json 里 entries[0].when（毫秒时间戳 bigint）
 *
 * 活动 journal 可以已追加增量 migration；本脚本始终以 entries[0] 的 baseline
 * 写入目标库。目标库仍必须保持 `_archive_pre_baseline_20260806` 的完整旧 journal；
 * 已含新 baseline 后续增量的目标库会被拒绝，之后应使用标准 `npm run db:migrate`。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Client } = require('pg')

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta/_journal.json')
const LEGACY_ARCHIVE_DIR = path.join(MIGRATIONS_DIR, '_archive_pre_baseline_20260806')
const LEGACY_JOURNAL_PATH = path.join(LEGACY_ARCHIVE_DIR, '_journal.json')
const LEGACY_BASELINE_SQL_PATH = path.join(LEGACY_ARCHIVE_DIR, 'sql/0000_baseline.sql')

async function main() {
  const dryRun = !process.argv.includes('--yes')

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var not set.')
    process.exit(2)
  }

  // 1. 读活动 journal，并确认第一条仍是本次 baseline。
  if (!fs.existsSync(JOURNAL_PATH)) {
    throw new Error(`Journal not found: ${JOURNAL_PATH}`)
  }
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'))
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error(
      `Expected an active journal beginning with 0000_baseline, got ${journal.entries?.length ?? 'none'} entries.`,
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
  const hash = hashFile(sqlPath)
  const createdAt = String(entry.when) // bigint 兼容

  // 3. 读取归档 journal，作为旧库可安全转换的身份标识。
  if (!fs.existsSync(LEGACY_JOURNAL_PATH) || !fs.existsSync(LEGACY_BASELINE_SQL_PATH)) {
    throw new Error(
      `Legacy baseline archive is incomplete under ${LEGACY_ARCHIVE_DIR}; refusing to reset a database journal.`,
    )
  }
  const legacyJournal = JSON.parse(fs.readFileSync(LEGACY_JOURNAL_PATH, 'utf8'))
  const legacyEntries = legacyJournal.entries
  if (!Array.isArray(legacyEntries)) {
    throw new Error(`Legacy journal is invalid: ${LEGACY_JOURNAL_PATH}`)
  }
  const legacyBaselineEntry = legacyEntries.find(item => item.tag === '0000_baseline')
  if (!legacyBaselineEntry) throw new Error(`Legacy baseline entry is missing: ${LEGACY_JOURNAL_PATH}`)
  const legacyBaselineHash = hashFile(LEGACY_BASELINE_SQL_PATH)

  console.log('========================================')
  console.log('reset-drizzle-journal.js')
  console.log('========================================')
  console.log(`DATABASE_URL:  ${maskUrl(process.env.DATABASE_URL)}`)
  console.log(`Baseline tag:  ${entry.tag}`)
  console.log(`Baseline hash: ${hash}`)
  console.log(`created_at:    ${createdAt} (${new Date(Number(createdAt)).toISOString()})`)
  console.log(`Mode:          ${dryRun ? 'DRY RUN (pass --yes to execute)' : 'LIVE (--yes passed)'}`)
  console.log()

  // 4. 连库
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // 5. 空库必须走正常 migration，不允许借 reset 跳过 DDL。
    const { rows: schemaCheck } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='drizzle') AS exists
    `)
    console.log(`drizzle schema exists: ${schemaCheck[0].exists}`)

    const { rows: tableCheck } = await client.query(`
      SELECT to_regclass('drizzle.__drizzle_migrations') AS tbl
    `)
    console.log(`drizzle.__drizzle_migrations exists: ${tableCheck[0].tbl ? 'YES' : 'NO'}`)
    if (!tableCheck[0].tbl) {
      throw new Error(
        'Migration journal does not exist. This is a new/empty database; run `npm run db:migrate` instead of resetting the journal.',
      )
    }

    // 6. 读现状并确认目标是已完整应用旧历史的业务库。
    const res = await client.query(`
      SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
    `)
    const current = res.rows
    console.log(`\nCurrent __drizzle_migrations rows: ${current.length}`)
    for (const r of current) {
      console.log(`  id=${r.id} hash=${r.hash.slice(0, 16)}... created_at=${r.created_at}`)
    }

    const alreadyAligned =
      current.length === 1 && current[0].hash === hash && String(current[0].created_at) === createdAt
    if (alreadyAligned) {
      console.log('\nOK: journal already matches the active baseline; no changes made.')
      return
    }

    if (current.some(row => row.hash === hash)) {
      throw new Error(
        'Active baseline hash already exists with additional migration rows. Refusing to discard incremental migration history.',
      )
    }

    if (!current.some(row => row.hash === legacyBaselineHash)) {
      throw new Error(
        'Legacy baseline hash is absent. Refusing to reset a journal that is not from the archived pre-2026-08-06 migration chain.',
      )
    }

    if (current.length !== legacyEntries.length) {
      throw new Error(
        `Expected ${legacyEntries.length} archived migration rows before reset, found ${current.length}. ` +
          'Verify this database is fully migrated before retrying; do not reset a partial journal.',
      )
    }

    if (dryRun) {
      console.log('\n--- PLANNED SQL (dry run, not executed) ---')
      console.log(`BEGIN;`)
      console.log(`TRUNCATE drizzle.__drizzle_migrations RESTART IDENTITY;`)
      console.log(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)`)
      console.log(`VALUES ('${hash}', ${createdAt});`)
      console.log(`COMMIT;`)
      console.log('\nPass --yes to execute.')
      return
    }

    // 7. 真实执行
    console.log('\n--- EXECUTING ---')
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

    // 8. 后置校验
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

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf8')).digest('hex')
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
