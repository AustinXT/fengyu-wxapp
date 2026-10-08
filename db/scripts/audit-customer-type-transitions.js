#!/usr/bin/env node
'use strict'
// #257：同一只读快照上调用真实分类 SQL；名单仅在显式 --out 路径落盘。
const { Pool } = require('pg')
const { writeFileSync, realpathSync, existsSync } = require('node:fs')
const { resolve, dirname, basename, join } = require('node:path')
const { BUILD_TARGET_TABLE_SQL, FETCH_THRESHOLD_SQL } = require('./recalc-all-customer-types')
const rank = { 流量客: 0, 体验客: 1, 小美客: 2, 会员客: 3 }
const TARGET_SELECT = BUILD_TARGET_TABLE_SQL.replace(/^\s*CREATE TEMP TABLE _recalc_target ON COMMIT DROP AS\s*/, '')
const AUDIT_SQL = `WITH target AS (${TARGET_SELECT})
SELECT t.user_id, u.name, u.phone, t.old_type, t.new_type, t.computed_type,
       t.old_became, t.first_qualified_at, t.first_qualified_order,
       first_order.sale_order_type AS qualifying_order_type,
       first_order.status AS qualifying_order_status,
       first_order.is_membership_upgrade AS qualifying_order_flag,
       CASE WHEN t.new_type = '会员客' THEN
         CASE WHEN first_order.sale_order_type = '转换单' THEN '转换单新增非体验实收达标'
              WHEN first_order.status = '部分支付' THEN '部分支付单非体验实收达标'
              ELSE '销售单非体验实收达标' END
         WHEN t.new_type = '小美客' THEN '单笔未达阈值，存在非体验实收'
         WHEN t.new_type = '体验客' THEN '仅存在体验实收'
         ELSE '无有效实收' END AS reason,
       t.new_type = '会员客' AND t.first_qualified_at IS NULL AS missing_qualification_time,
       EXISTS (SELECT 1 FROM sale_orders o WHERE o.client_user_id = t.user_id
         AND o.created_at >= NOW() - INTERVAL '30 days') AS ordered_30d
  FROM target t JOIN client_wechat_users u USING (user_id)
  LEFT JOIN sale_orders first_order ON first_order.sale_order_id = t.first_qualified_order
 ORDER BY t.user_id`
function summarize(rows) {
  const transitions = new Map()
  const protectedByMonotonic = new Map()
  let changed = 0, down = 0, recentDown = 0, protectedCount = 0
  for (const r of rows) {
    if (!Object.hasOwn(rank, r.old_type) || !Object.hasOwn(rank, r.new_type) || !Object.hasOwn(rank, r.computed_type)) throw new Error('未知顾客档位，拒绝输出不完整审计')
    // #545：只升不降下 changed 恒为升级；「计算档位低于现值、被单调门挡住」的人单列。
    // 不列出来的话，口径反转后这份审计只剩一个恒 0 的 downgrades，看不出保护了多少人。
    if (r.old_type !== r.computed_type && r.new_type === r.old_type) {
      protectedCount++
      const key = `${r.old_type}（计算 ${r.computed_type}）`
      const item = protectedByMonotonic.get(key) || { level: r.old_type, computed: r.computed_type, count: 0, ordered30d: 0 }
      item.count++; if (r.ordered_30d) item.ordered30d++
      protectedByMonotonic.set(key, item)
    }
    if (r.old_type === r.new_type) continue
    changed++
    const key = `${r.old_type} → ${r.new_type}`
    const item = transitions.get(key) || { from: r.old_type, to: r.new_type, count: 0, ordered30d: 0 }
    item.count++; if (r.ordered_30d) item.ordered30d++
    transitions.set(key, item)
    if (rank[r.old_type] > rank[r.new_type]) { down++; if (r.ordered_30d) recentDown++ }
  }
  return { scope: rows.length, changed, unchanged: rows.length - changed, downgrades: down,
    downgradesOrdered30d: recentDown, transitions: [...transitions.values()],
    protectedByMonotonic: protectedCount, protectedBreakdown: [...protectedByMonotonic.values()] }
}
// 真实父目录检查可挡住把备份路径软链进仓库；wx+0600保护旧证据和文件权限。
function writePrivateReport(outPath, report) {
  const target = resolve(outPath)
  const parent = realpathSync(dirname(target))
  for (let dir = parent; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) throw new Error('禁止把个人信息审计名单写入Git仓库')
    if (dir === dirname(dir)) break
  }
  writeFileSync(join(parent, basename(target)), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
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
    if (args[1]) writePrivateReport(args[1], { snapshot: new Date().toISOString(), threshold, summary, rows })
    await client.query('ROLLBACK')
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    await pool.end()
  }
}
if (require.main === module) main().catch(e => { console.error('分类审计失败:', e.code || e.message); process.exitCode = 1 })
module.exports = { AUDIT_SQL, summarize, writePrivateReport }
