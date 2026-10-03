#!/usr/bin/env node
'use strict'
// #257：同一只读快照上调用真实分类 SQL；名单仅在显式 --out 路径落盘。
const { Pool } = require('pg')
const { writeFileSync } = require('node:fs')
const { BUILD_TARGET_TABLE_SQL, FETCH_THRESHOLD_SQL } = require('./recalc-all-customer-types')
const rank = { 流量客: 0, 体验客: 1, 小美客: 2, 会员客: 3 }
const TARGET_SELECT = BUILD_TARGET_TABLE_SQL.replace(/^\s*CREATE TEMP TABLE _recalc_target ON COMMIT DROP AS\s*/, '')
const AUDIT_SQL = `WITH target AS (${TARGET_SELECT})
SELECT t.user_id, u.name, u.phone, t.old_type, t.new_type,
       EXISTS (SELECT 1 FROM sale_orders o WHERE o.client_user_id = t.user_id
         AND o.created_at >= NOW() - INTERVAL '30 days') AS ordered_30d
  FROM target t JOIN client_wechat_users u USING (user_id)
 ORDER BY t.user_id`
function summarize(rows) {
  const transitions = new Map()
  let changed = 0, down = 0, recentDown = 0
  for (const r of rows) {
    if (!(r.old_type in rank) || !(r.new_type in rank)) throw new Error('未知顾客档位，拒绝输出不完整审计')
    if (r.old_type === r.new_type) continue
    changed++
    const key = `${r.old_type} → ${r.new_type}`
    const item = transitions.get(key) || { from: r.old_type, to: r.new_type, count: 0, ordered30d: 0 }
    item.count++; if (r.ordered_30d) item.ordered30d++
    transitions.set(key, item)
    if (rank[r.old_type] > rank[r.new_type]) { down++; if (r.ordered_30d) recentDown++ }
  }
  return { scope: rows.length, changed, unchanged: rows.length - changed, downgrades: down,
    downgradesOrdered30d: recentDown, transitions: [...transitions.values()] }
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--out' && args[1])) throw new Error('用法：node db/scripts/audit-customer-type-transitions.js [--out 私有JSON路径]')
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('须显式设置 DATABASE_URL；不读取默认环境、不支持 --apply')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 })
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '60s'")
    const threshold = Number((await client.query(FETCH_THRESHOLD_SQL)).rows[0]?.v)
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('会员阈值缺失或非法')
    const rows = (await client.query(AUDIT_SQL, [threshold])).rows
    const summary = summarize(rows)
    if (args[1]) writeFileSync(args[1], JSON.stringify({ snapshot: new Date().toISOString(), threshold, summary, rows }, null, 2), { mode: 0o600, flag: 'wx' })
    await client.query('ROLLBACK')
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    await pool.end()
  }
}
if (require.main === module) main().catch(e => { console.error('分类审计失败:', e.code || e.message); process.exitCode = 1 })
module.exports = { AUDIT_SQL, summarize }
