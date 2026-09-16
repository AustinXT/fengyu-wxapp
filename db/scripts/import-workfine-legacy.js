#!/usr/bin/env node
/**
 * @deprecated 2026-05-19 — 改用 admin /legacy-orders 的 manual pull 工作流（按顾客拉取）。
 * 此脚本保留作为 fallback / 紧急批量回填用途；新流程见
 * fengyu-admin/src/actions/legacy-orders.ts 的 importWorkfineOrdersByCustomer。
 *
 * import-workfine-legacy.js — 一次性抓 WorkFine 历史订单 4 字段进 sale_orders.status='未审核'
 *
 * 取代 migrate-history-orders.js（已 DEPRECATED）。设计原则："抓的多就错的多"：
 *   - 只抓 phone / store_name / amount / order_date 四字段
 *   - 不抓品项明细（变体上千个）
 *   - 不抓次数（错的多）
 *   - status='未审核'，不进入任何统计/cron 聚合
 *   - 顾客到店后，店员在 admin /legacy-orders 按手机号筛 → 核对 4 字段 → 通过 → 触发标签重算
 *
 * WorkFine 表 → PG 字段映射：
 *   UDT_S_209.UDF_S_372  → sale_order_id（PK，原 WF 单号直接用）
 *   UDT_S_209.UDF_S_350  → sale_order_datetime
 *   UDT_S_209.UDF_S_348  → market_name
 *   UDT_S_209.UDF_S_349  → store_name → 反查 stores.store_id（未匹配跳过）
 *   UDT_S_209.UDF_S_1485 → legacy_customer_id（WF 顾客编号）
 *   UDT_S_209.UDF_S_370  → customer_name（快照）
 *   UDT_S_209.UDF_S_507  → total_amount = payable_amount
 *   UDT_S_311.UDF_S_1478 → client_phone（通过 customer_id JOIN UDT_S_311）
 *
 * 用法：
 *   MSSQL_USER=admin MSSQL_PASSWORD=Se1Qimoh node db/scripts/import-workfine-legacy.js --dry-run
 *   MSSQL_USER=admin MSSQL_PASSWORD=Se1Qimoh node db/scripts/import-workfine-legacy.js
 *   ... --since 2020-01-01            # 时间窗起点（默认 2020-01-01）
 */

const mssql = require('mssql')
const { Pool } = require('pg')

const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER || 'admin',
  password: process.env.MSSQL_PASSWORD || 'Se1Qimoh',
  database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: process.env.MSSQL_SERVER || '47.96.87.33',
  port: parseInt(process.env.MSSQL_PORT) || 1433,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 600000,
}

// DATABASE_URL 必填且必须精确指向业务库（db/CLAUDE.md 硬规则：显式传值 + 断言 host/port/dbname）。
// 实现见 _lib/assert-db-target.js —— 它同时挡住 `?host=` 与 `?%68ost=`（百分号编码）两层 query 覆盖绕过。
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
const { assertDbTargetOrExit } = require('./_lib/assert-db-target')
if (require.main === module) assertDbTargetOrExit(process.env.DATABASE_URL)

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL?.trim(),
  max: 5,
}

const BATCH_SIZE = 500

function trim(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function workfineWallParts(v) {
  if (!v) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return {
      year: String(v.getUTCFullYear()).padStart(4, '0'),
      month: String(v.getUTCMonth() + 1).padStart(2, '0'),
      day: String(v.getUTCDate()).padStart(2, '0'),
      hour: String(v.getUTCHours()).padStart(2, '0'),
      minute: String(v.getUTCMinutes()).padStart(2, '0'),
      second: String(v.getUTCSeconds()).padStart(2, '0'),
      millisecond: String(v.getUTCMilliseconds()).padStart(3, '0'),
    }
  }

  const text = String(v).trim()
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/,
  )
  if (!match) return null
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || '00',
    minute: match[5] || '00',
    second: match[6] || '00',
    millisecond: (match[7] || '0').padEnd(3, '0'),
  }
}

function toTimestamp(v) {
  const parts = workfineWallParts(v)
  if (!parts) return v ? String(v) : null
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.millisecond}+08:00`
}

function toWorkfineBusinessDate(v) {
  const parts = workfineWallParts(v)
  if (!parts) return v ? String(v).slice(0, 10) : null
  return `${parts.year}-${parts.month}-${parts.day}`
}

function log(msg) {
  console.log(`[LEGACY] ${msg}`)
}

async function queryWorkfine(mssqlPool, since) {
  log(`查询 WorkFine 历史订单（>= ${since}）...`)
  const { recordset } = await mssqlPool.request().query(`
    SELECT
      RTRIM(s.UDF_S_372)  AS legacy_order_no,
      CONVERT(varchar(23), s.UDF_S_350, 121) AS sale_date,
      RTRIM(s.UDF_S_348)  AS market_name,
      RTRIM(s.UDF_S_349)  AS store_name,
      RTRIM(s.UDF_S_1485) AS legacy_customer_id,
      RTRIM(s.UDF_S_370)  AS customer_name,
      s.UDF_S_507          AS amount,
      RTRIM(k.UDF_S_1478) AS phone
    FROM UDT_S_209 s
    LEFT JOIN UDT_S_311 k ON RTRIM(s.UDF_S_1485) = RTRIM(k.UDF_S_1475)
    WHERE s.UDF_S_350 >= '${since}'
      AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
    ORDER BY s.UDF_S_350
  `)
  log(`WorkFine 返回 ${recordset.length} 行`)
  return recordset
}

async function loadPgLookups(pgPool) {
  log('加载 PG 查找表（stores / client_wechat_users / 已存在订单）...')
  const storesRes = await pgPool.query('SELECT store_id, store_name FROM stores')
  const storeMap = {}
  for (const r of storesRes.rows) storeMap[r.store_name] = r.store_id
  log(`  stores: ${storesRes.rows.length}`)

  const phoneRes = await pgPool.query(
    'SELECT user_id, phone FROM client_wechat_users WHERE phone IS NOT NULL',
  )
  const phoneMap = {}
  for (const r of phoneRes.rows) phoneMap[r.phone] = r.user_id
  log(`  client_wechat_users (phone-indexed): ${phoneRes.rows.length}`)

  const custIdRes = await pgPool.query(
    "SELECT user_id, customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL",
  )
  const customerIdMap = {}
  for (const r of custIdRes.rows) customerIdMap[r.customer_id] = r.user_id
  log(`  client_wechat_users (customer_id-indexed): ${custIdRes.rows.length}`)

  const existingRes = await pgPool.query("SELECT sale_order_id FROM sale_orders")
  const existingIds = new Set(existingRes.rows.map((r) => r.sale_order_id))
  log(`  已存在 sale_orders: ${existingIds.size}`)

  return { storeMap, phoneMap, customerIdMap, existingIds }
}

function processRows(rows, lookups) {
  const out = []
  const stats = {
    total: rows.length,
    skippedAlreadyExist: 0,
    skippedNoStore: 0,
    skippedTooLongPk: 0,
    skippedNoOrderNo: 0,
    phoneMatched: 0,
    customerIdMatched: 0,
    phoneNullRows: 0,
  }
  const skippedStores = new Map()

  for (const row of rows) {
    const legacyOrderNo = trim(row.legacy_order_no)
    if (!legacyOrderNo) {
      stats.skippedNoOrderNo++
      continue
    }
    if (legacyOrderNo.length > 30) {
      stats.skippedTooLongPk++
      console.warn(`[WARN] sale_order_id 超长 (${legacyOrderNo.length}): ${legacyOrderNo}`)
      continue
    }
    if (lookups.existingIds.has(legacyOrderNo)) {
      stats.skippedAlreadyExist++
      continue
    }

    const storeName = trim(row.store_name)
    const storeId = storeName ? lookups.storeMap[storeName] : null
    if (!storeId) {
      stats.skippedNoStore++
      skippedStores.set(storeName || '<NULL>', (skippedStores.get(storeName || '<NULL>') || 0) + 1)
      continue
    }

    const phone = trim(row.phone)
    if (!phone) stats.phoneNullRows++

    const legacyCustomerId = trim(row.legacy_customer_id)
    let clientUserId = null
    if (phone && lookups.phoneMap[phone]) {
      clientUserId = lookups.phoneMap[phone]
      stats.phoneMatched++
    } else if (legacyCustomerId && lookups.customerIdMap[legacyCustomerId]) {
      clientUserId = lookups.customerIdMap[legacyCustomerId]
      stats.customerIdMatched++
    }

    const amount = parseFloat(row.amount) || 0
    const marketName = trim(row.market_name) || '未知市场'
    const customerName = trim(row.customer_name)
    const saleDate = toTimestamp(row.sale_date) || new Date().toISOString()

    const snapshot = {
      legacy_order_no: legacyOrderNo,
      phone,
      store_name: storeName,
      amount,
      sale_date: saleDate,
      customer_id: legacyCustomerId,
      customer_name: customerName,
    }

    out.push({
      saleOrderId: legacyOrderNo,
      marketName,
      storeId,
      saleOrderDatetime: saleDate,
      performanceAttributionDate: toWorkfineBusinessDate(row.sale_date),
      clientUserId,
      clientPhone: phone,
      customerName,
      totalAmount: amount.toFixed(2),
      legacyCustomerId,
      snapshotJson: JSON.stringify(snapshot),
    })
  }

  return { rowsToInsert: out, stats, skippedStores }
}

function buildMultiRowValues(rows, colCount) {
  const values = []
  const placeholders = []
  let idx = 1
  for (const row of rows) {
    const ph = []
    for (let i = 0; i < colCount; i++) {
      ph.push(`$${idx++}`)
      values.push(row[i])
    }
    placeholders.push(`(${ph.join(',')})`)
  }
  return { placeholders: placeholders.join(','), values }
}

async function batchInsert(pgPool, rows, dryRun) {
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE)
  log(`准备 INSERT ${rows.length} 行，分 ${totalBatches} 批 × ${BATCH_SIZE}`)

  if (dryRun) return rows.length

  let inserted = 0
  const COLS_PER_ROW = 17

  for (let b = 0; b < totalBatches; b++) {
    const slice = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE)
    const tuples = slice.map((r) => [
      r.saleOrderId,
      '未审核',                // status
      '销售单',                 // sale_order_type
      r.marketName,
      r.storeId,
      r.saleOrderDatetime,
      r.performanceAttributionDate,
      r.clientUserId,
      r.clientPhone,
      r.customerName,
      r.totalAmount,            // total_amount
      r.totalAmount,            // payable_amount
      '0',                      // received
      '无',                     // payment_method
      'workfine',               // legacy_source
      r.legacyCustomerId,
      r.snapshotJson,
    ])
    const mv = buildMultiRowValues(tuples, COLS_PER_ROW)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const res = await client.query(
        `
        INSERT INTO sale_orders (
          sale_order_id, status, sale_order_type, market_name, store_id,
          sale_order_datetime, performance_attribution_date, client_user_id, client_phone, customer_name,
          total_amount, payable_amount, received, payment_method,
          legacy_source, legacy_customer_id, legacy_raw_snapshot
        ) VALUES ${mv.placeholders}
        ON CONFLICT (sale_order_id) DO NOTHING
        `,
        mv.values,
      )
      inserted += res.rowCount
      await client.query('COMMIT')
      if ((b + 1) % 10 === 0 || b === totalBatches - 1) {
        log(`  批次 ${b + 1}/${totalBatches} 累计 ${inserted}`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return inserted
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const sinceIdx = args.indexOf('--since')
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '2020-01-01'

  console.log('=== WorkFine 历史订单 → PG (未审核) 一次性导入 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : '正式执行'}`)
  console.log(`时间窗起点: ${since}\n`)

  let mssqlPool = null
  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    const wfRows = await queryWorkfine(mssqlPool, since)
    const lookups = await loadPgLookups(pgPool)
    const { rowsToInsert, stats, skippedStores } = processRows(wfRows, lookups)

    console.log('\n=== 抓取统计 ===')
    console.log(`WorkFine 总订单: ${stats.total}`)
    console.log(`跳过 (单号空): ${stats.skippedNoOrderNo}`)
    console.log(`跳过 (PK 超长): ${stats.skippedTooLongPk}`)
    console.log(`跳过 (门店未匹配): ${stats.skippedNoStore}`)
    console.log(`跳过 (PG 已存在): ${stats.skippedAlreadyExist}`)
    console.log(`将导入: ${rowsToInsert.length}`)
    console.log(`  手机号匹配命中: ${stats.phoneMatched}`)
    console.log(`  customer_id 反查命中: ${stats.customerIdMatched}`)
    console.log(`  client_user_id 总命中: ${stats.phoneMatched + stats.customerIdMatched}`)
    console.log(`  无手机号 (NULL): ${stats.phoneNullRows}`)

    if (skippedStores.size > 0) {
      console.log('\n门店未匹配 TOP 10：')
      const top = [...skippedStores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      for (const [name, cnt] of top) console.log(`  ${name}: ${cnt}`)
    }

    const inserted = await batchInsert(pgPool, rowsToInsert, dryRun)

    console.log('\n=== 完成 ===')
    if (dryRun) {
      console.log(`[DRY-RUN] 将插入 ${inserted} 行（未实际写入）`)
    } else {
      console.log(`实际插入: ${inserted}`)
      const verify = await pgPool.query(
        "SELECT COUNT(*)::int AS cnt FROM sale_orders WHERE legacy_source='workfine'",
      )
      console.log(`PG 现有 legacy_source='workfine' 总数: ${verify.rows[0].cnt}`)
    }
  } catch (err) {
    console.error('\n❌ 失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    await pgPool.end()
  }
}

if (require.main === module) main()

module.exports = {
  processRows,
  toTimestamp,
  toWorkfineBusinessDate,
  workfineWallParts,
}
