import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const require = createRequire(new URL('../../fengyu-admin/package.json', import.meta.url))
const { Client } = require('pg')
const url = new URL(process.env.DATABASE_URL || '')
if (url.hostname !== '127.0.0.1' || url.port !== '58096' || url.pathname !== '/lxcoding_demo' || url.username !== 'lxcoding_demo' || url.search || url.hash) {
  throw Error('只允许通过专用隧道初始化 lxcoding_demo，不接受业务库连接')
}
let client
for (let attempt=0; ; attempt++) {
  client = new Client({ connectionString: url.toString() })
  try { await client.connect(); break } catch (error) {
    await client.end().catch(() => {})
    if (attempt < 5) { await new Promise(r => setTimeout(r, 1000)); continue }
    throw error
  }
}
const root = resolve(import.meta.dirname, '../../db/migrations')
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)')
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8'))
  for (const entry of journal.entries) {
    const sql = readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8')
    const hash = createHash('sha256').update(sql).digest('hex')
    const existing = await client.query('SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=$1', [entry.when])
    if (existing.rows.length) {
      if (existing.rows[0].hash !== hash) throw Error(`迁移漂移：${entry.tag}`)
      continue
    }
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [hash,entry.when])
      await client.query('COMMIT')
      console.log(`演示库迁移完成：${entry.tag}`)
    } catch (error) { await client.query('ROLLBACK'); throw error }
  }
  console.log(`演示库迁移核验：${journal.entries.length} 条`)
} finally { await client.end() }
