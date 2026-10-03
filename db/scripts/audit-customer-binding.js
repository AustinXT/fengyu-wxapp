#!/usr/bin/env node
'use strict'
// #301 阶段1：只读调查与候选比较；任何候选都不自动成为绑定关系。
const { Pool } = require('pg')
const { writeFileSync } = require('node:fs')
const COVERAGE_SQL = `SELECT to_char(became_member_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS cohort,
 count(*)::int total, count(nullif(btrim(bound_employee_id),''))::int bound,
 round(100.0*count(nullif(btrim(bound_employee_id),''))/count(*),1) pct
 FROM client_wechat_users WHERE customer_type='会员客' AND became_member_at >= $1::timestamptz
 GROUP BY 1 ORDER BY 1`
const CLEARS_SQL = `WITH x AS (SELECT target_id,created_at,source,detail->'changes'->'boundEmployeeId' ch
 FROM operation_logs WHERE action='customer.update' AND created_at >= $1::timestamptz)
 SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS cohort,source,
 count(*)::int changes, count(*) FILTER(WHERE ch->>'from' IS NOT NULL AND nullif(ch->>'to','') IS NULL)::int clears
 FROM x WHERE ch IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`
const SHAPE_SQL = `SELECT count(*)::int total,
 count(*) FILTER(WHERE bound_employee_id IS NULL)::int null_count,
 count(*) FILTER(WHERE bound_employee_id='')::int empty,
 count(*) FILTER(WHERE bound_employee_id IS DISTINCT FROM btrim(bound_employee_id))::int whitespace,
 count(*) FILTER(WHERE nullif(btrim(bound_employee_id),'') IS NOT NULL AND e.employee_id IS NULL)::int missing_employee,
 count(*) FILTER(WHERE e.employee_id IS NOT NULL AND e.store_id IS DISTINCT FROM u.bound_store_id)::int different_store,
 count(*) FILTER(WHERE e.is_resigned)::int resigned
 FROM client_wechat_users u LEFT JOIN staff_wechat_users e ON e.employee_id=btrim(u.bound_employee_id)`
const CANDIDATE_SQL = `WITH f AS (
 SELECT DISTINCT ON(client_user_id) client_user_id,opened_by FROM sale_orders
 WHERE sale_order_type='销售单' AND status IN('已支付','已完成')
 ORDER BY client_user_id,COALESCE(paid_at,created_at),sale_order_id
), first_service AS (
 SELECT DISTINCT ON(client_user_id) client_user_id,service_order_id FROM service_orders WHERE status='已完成'
 ORDER BY client_user_id,service_date,created_at,service_order_id
), s AS (
 SELECT so.client_user_id,array_agg(DISTINCT si.employee_id) AS employees
 FROM first_service so JOIN service_items si USING(service_order_id) GROUP BY 1
)
SELECT u.user_id,u.phone,u.customer_id,u.customer_type,u.bound_store_id,
 to_char(u.became_member_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS cohort,
 f.opened_by,s.employees,
 EXISTS(SELECT 1 FROM operation_logs l WHERE l.target_id=u.user_id AND l.action='customer.assign') AS assigned_log,
 EXISTS(SELECT 1 FROM operation_logs l WHERE l.target_id=u.user_id AND l.detail->'changes'->'boundEmployeeId'->>'from' IS NOT NULL) AS previous_binding_log
 FROM client_wechat_users u LEFT JOIN f ON f.client_user_id=u.user_id LEFT JOIN s ON s.client_user_id=u.user_id
 WHERE nullif(btrim(u.bound_employee_id),'') IS NULL`
const STAFF_SQL = `SELECT e.employee_id,e.name,e.store_id,e.is_resigned,s.store_name
 FROM staff_wechat_users e LEFT JOIN stores s ON s.store_id=e.store_id`
const WORKFINE_SQL = `SELECT RTRIM(UDF_S_1475) customer_id,RTRIM(UDF_S_1478) phone,
 RTRIM(UDF_S_6444) employee_id,RTRIM(UDF_S_6443) store_name FROM UDT_S_311 WHERE UDF_S_1475 IS NOT NULL`
function workfineConfig(value) {
  const parts = Object.fromEntries(value.split(';').filter(x => x.includes('=')).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1)]
  }))
  const [server, port = '1433'] = (parts.server || '').split(',')
  if (!server || !parts.database || !parts['user id'] || !parts.password || !/^\d+$/.test(port)) throw new Error('WorkFine连接参数不完整')
  return { server, port: Number(port), database: parts.database, user: parts['user id'], password: parts.password,
    options: { encrypt: false, trustServerCertificate: true }, connectionTimeout: 10000, requestTimeout: 60000 }
}
function compareCandidates(users, staff, source) {
  const byId = new Map(staff.map(e => [e.employee_id, e]))
  const names = new Map(), phones = new Map(), customers = new Map()
  for (const e of staff) {
    const key = JSON.stringify([e.name, e.store_name])
    if (!names.has(key)) names.set(key, new Set())
    names.get(key).add(e.employee_id)
  }
  // 同名员工不猜；同时保留所有候选以体现源头/映射歧义。
  const sourceShape = { rows: source?.length ?? null, rawBindings: 0, unmapped: 0, ambiguousNames: 0 }
  for (const row of source || []) {
    const raw = row.employee_id?.trim()
    if (!raw) continue
    sourceShape.rawBindings++
    const ids = byId.has(raw) ? new Set([raw]) : (names.get(JSON.stringify([raw, row.store_name?.trim()])) || new Set())
    if (!ids.size) sourceShape.unmapped++
    if (ids.size > 1) sourceShape.ambiguousNames++
    for (const [map, key] of [[phones, row.phone?.trim()], [customers, row.customer_id?.trim()]]) {
      if (!key) continue
      if (!map.has(key)) map.set(key, new Set())
      for (const id of ids) map.get(key).add(id)
    }
  }
  const groups = {}, details = []
  for (const u of users) {
    const candidates = { order: u.opened_by ? [u.opened_by] : [], service: [...new Set(u.employees || [])],
      workfine: source ? [...(u.customer_id ? customers.get(u.customer_id) : phones.get(u.phone)) || []] : null }
    details.push({ ...u, candidates })
    const keys = ['all']
    if (u.customer_type === '会员客') keys.push('members', `member-${u.cohort || 'unknown'}`)
    for (const key of keys) {
      const g = groups[key] ||= { missing: 0, assignedLog: 0, previousBindingLog: 0, conflict: 0, threeUnique: 0, threeConflict: 0,
        order: { any: 0, unique: 0, active: 0, ambiguous: 0 }, service: { any: 0, unique: 0, active: 0, ambiguous: 0 },
        workfine: source ? { any: 0, unique: 0, active: 0, ambiguous: 0 } : null }
      g.missing++; if (u.assigned_log) g.assignedLog++; if (u.previous_binding_log) g.previousBindingLog++
      const unique = []
      for (const [tag, ids] of Object.entries(candidates)) {
        if (!ids) continue
        if (ids.length) g[tag].any++
        if (ids.length > 1) g[tag].ambiguous++
        if (ids.length === 1) { g[tag].unique++; unique.push(ids[0]); if (byId.has(ids[0]) && !byId.get(ids[0]).is_resigned) g[tag].active++ }
      }
      if (unique.length > 1 && new Set(unique).size > 1) g.conflict++
      if (unique.length === 3) { g.threeUnique++; if (new Set(unique).size > 1) g.threeConflict++ }
    }
  }
  return { summary: { workfineAvailable: source !== null, sourceShape, groups }, details }
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--out' && args[1])) throw new Error('用法：node db/scripts/audit-customer-binding.js [--out 私有JSON路径]')
  if (!process.env.DATABASE_URL) throw new Error('须显式设置DATABASE_URL；本脚本不支持apply')
  // 两库无法同一快照：先固定源数据，再开 PG 只读一致性快照，记录各自采样时刻。
  let source = null, sourceAt = null
  if (process.env.MSSQL_CONNECTION_STRING) {
    const { ConnectionPool } = require('mssql')
    const wf = new ConnectionPool(workfineConfig(process.env.MSSQL_CONNECTION_STRING))
    try { await wf.connect(); source = (await wf.request().query(WORKFINE_SQL)).recordset; sourceAt = new Date().toISOString() }
    finally { await wf.close() }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  let c
  try {
    c = await pool.connect()
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await c.query("SET LOCAL statement_timeout = '60s'")
    const coverage = (await c.query(COVERAGE_SQL, ['2026-01-01T00:00:00+08:00'])).rows
    const clears = (await c.query(CLEARS_SQL, ['2026-07-01T00:00:00+08:00'])).rows
    const shape = (await c.query(SHAPE_SQL)).rows[0]
    const users = (await c.query(CANDIDATE_SQL)).rows, staff = (await c.query(STAFF_SQL)).rows
    const report = compareCandidates(users, staff, source)
    const summary = { sampledAt: new Date().toISOString(), sourceAt, coverage, clears, shape, ...report.summary }
    if (args[1]) writeFileSync(args[1], JSON.stringify({ summary, candidates: report.details }, null, 2), { flag: 'wx', mode: 0o600 })
    await c.query('ROLLBACK')
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    if (c) { await c.query('ROLLBACK').catch(() => {}); c.release() }
    await pool.end()
  }
}
if (require.main === module) main().catch(e => { console.error('绑定调查失败:', e.code || e.message); process.exitCode = 1 })
module.exports = { COVERAGE_SQL, CLEARS_SQL, SHAPE_SQL, CANDIDATE_SQL, STAFF_SQL, WORKFINE_SQL, compareCandidates }
