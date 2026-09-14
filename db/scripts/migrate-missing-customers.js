#!/usr/bin/env node
/**
 * migrate-missing-customers.js — 补录被订单引用但 PG 中缺失的顾客
 *
 * 问题：migrate-history-orders.js 和 migrate-active-cards.js 跳过了
 * ~2,710 个订单因为 customer_id 在 PG client_wechat_users 中不存在。
 *
 * 根因：
 *   A) 1,657 个 customer_id 在 WorkFine 顾客表(UDT_S_311)中不存在（历史遗留/删除）
 *      → 从订单数据(UDT_S_209)创建合成顾客记录
 *   B) 1,053 个 customer_id 在顾客表中存在，但手机号与 PG 已有记录冲突
 *      → 导入完整档案字段，phone 设为 NULL 避免冲突
 *
 * 用法：
 *   node scripts/migrate-missing-customers.js              # 正式执行
 *   node scripts/migrate-missing-customers.js --dry-run     # 预览模式
 *   node scripts/migrate-missing-customers.js --verify      # 仅验证
 *
 * 幂等设计：ON CONFLICT (customer_id) DO NOTHING
 */

const mssql = require('mssql')
const { Pool } = require('pg')
const crypto = require('crypto')

const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER || 'SD',
  password: process.env.MSSQL_PASSWORD || 'Se4Qimoh',
  database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: process.env.MSSQL_SERVER || '47.96.87.33',
  port: parseInt(process.env.MSSQL_PORT) || 1433,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 300000,
}

// DATABASE_URL 必填：不提供默认值，避免忘传时静默连到已弃用的旧 dev 库（见 db/CLAUDE.md）
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
if (require.main === module && !process.env.DATABASE_URL) {
  console.error('✗ 必须显式传 DATABASE_URL（dev=101.34.242.103:5433/fengyu_wxapp / prod=118.178.196.26:5433/fengyu_wxapp）')
  process.exit(1)
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  max: 5,
}

function trim(val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  return s === '' ? null : s
}

const CUSTOMER_SOURCE_ALIASES = {
  推带新: '推广部',
  地推卡: '全员地推',
  拓客卡: '外请团队拓客',
  内部员工或家属: '员工或家属',
}

function normalizeCustomerSource(val) {
  const source = trim(val)
  return source ? (CUSTOMER_SOURCE_ALIASES[source] || source) : null
}

function toBool(val) {
  if (val === null || val === undefined) return false
  return String(val).trim() === '是'
}

function toDateStr(val) {
  if (!val) return null
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(val).substring(0, 10)
}

function log(msg) { console.log(`[MISSING-CUST] ${msg}`) }

/**
 * 创建顾客 user_id：FYGK-{YYYYMMDD}-{5位序号}
 */
function createIdGenerator() {
  let seq = 0
  let prefix = ''
  return {
    async init(client) {
      const now = new Date()
      const yyyy = String(now.getFullYear())
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      prefix = `FYGK-${yyyy}${mm}${dd}-`
      const { rows } = await client.query(
        "SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 ORDER BY user_id DESC LIMIT 1",
        [prefix + '%']
      )
      seq = rows.length > 0 ? parseInt(rows[0].user_id.slice(prefix.length), 10) : 0
    },
    next() {
      seq++
      return prefix + String(seq).padStart(5, '0')
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== 补录缺失顾客 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  let mssqlPool = null
  let pgPool = null

  try {
    pgPool = new Pool(PG_CONFIG)
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // ─── 1. 找出 PG 中缺失的 customer_id ─────────────────
    log('查找缺失顾客...')

    // 从 WorkFine 订单表获取所有被引用的 customer_id
    const { recordset: wfOrderCusts } = await mssqlPool.request().query(`
      SELECT DISTINCT
        RTRIM(UDF_S_1485) AS customer_id,
        RTRIM(UDF_S_370)  AS customer_name,
        RTRIM(UDF_S_349)  AS store_name
      FROM UDT_S_209
      WHERE UDF_S_1485 IS NOT NULL AND RTRIM(UDF_S_1485) != ''
    `)

    // 加上活跃卡中引用的顾客 (UDT_M_213 → UDT_S_209 through order)
    // 已包含在上面的查询中

    // PG 中已有的 customer_id
    const { rows: pgCusts } = await pgPool.query(
      'SELECT customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL'
    )
    const pgCustSet = new Set(pgCusts.map(r => r.customer_id))

    const missingFromOrders = wfOrderCusts.filter(r => r.customer_id && !pgCustSet.has(r.customer_id))
    log(`订单引用的唯一顾客: ${wfOrderCusts.length}, PG 中缺失: ${missingFromOrders.length}`)

    // ─── 2. 查找 WorkFine 顾客表中的详细信息 ──────────────
    const missingIds = missingFromOrders.map(r => r.customer_id)
    const custDetails = new Map() // customer_id → full details from UDT_S_311

    // 批量查询
    const BATCH = 200
    for (let i = 0; i < missingIds.length; i += BATCH) {
      const batch = missingIds.slice(i, i + BATCH)
      const inClause = batch.map(id => "'" + id.replace(/'/g, "''") + "'").join(',')
      const { recordset } = await mssqlPool.request().query(`
        SELECT
          RTRIM(UDF_S_1475) AS customer_id,
          RTRIM(UDF_S_1476) AS name,
          RTRIM(UDF_S_1478) AS phone,
          RTRIM(UDF_S_6443) AS store_name,
          RTRIM(UDF_S_6444) AS bound_employee_id,
          RTRIM(UDF_S_1477) AS member_level,
          RTRIM(UDF_S_6446) AS customer_source,
          RTRIM(UDF_S_1712) AS category,
          UDF_S_1479          AS birthday,
          RTRIM(UDF_S_1481) AS occupation,
          RTRIM(UDF_S_1482) AS is_married_raw,
          RTRIM(UDF_S_6445) AS wechat_name,
          RTRIM(UDF_S_6447) AS skin_type,
          RTRIM(UDF_S_6448) AS improvement_focus,
          RTRIM(UDF_S_19093) AS skin_issue,
          RTRIM(UDF_S_19094) AS wellness_preference
        FROM UDT_S_311
        WHERE RTRIM(UDF_S_1475) IN (${inClause})
      `)
      for (const r of recordset) {
        custDetails.set(r.customer_id, r)
      }
    }

    const groupA = missingIds.filter(id => !custDetails.has(id)) // 不在顾客表
    const groupB = missingIds.filter(id => custDetails.has(id))  // 在顾客表但手机号冲突

    log(`分组 A (不在顾客表，从订单创建): ${groupA.length}`)
    log(`分组 B (在顾客表，手机号冲突): ${groupB.length}`)

    if (verifyOnly) {
      console.log('\n=== 验证完成 ===')
      console.log(`  需要创建: ${groupA.length + groupB.length} 条顾客记录`)
      return
    }

    if (dryRun) {
      console.log('\n=== DRY RUN ===')
      console.log(`  将创建 ${groupA.length} 条合成顾客 (从订单)`)
      console.log(`  将创建 ${groupB.length} 条顾客 (从档案，phone=NULL)`)
      console.log('\n  Group A 样例:')
      const orderMap = new Map()
      missingFromOrders.forEach(r => { if (!orderMap.has(r.customer_id)) orderMap.set(r.customer_id, r) })
      for (const id of groupA.slice(0, 5)) {
        const o = orderMap.get(id)
        console.log(`    ${id} (${o?.customer_name || '?'}) store=${o?.store_name || '?'}`)
      }
      console.log('\n  Group B 样例:')
      for (const id of groupB.slice(0, 5)) {
        const c = custDetails.get(id)
        console.log(`    ${id} (${c.name}) phone=${c.phone} → 设为 NULL`)
      }
      return
    }

    // ─── 3. 导入 ───────────────────────────────────────────
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // 预加载 stores lookup
      const { rows: stores } = await client.query('SELECT store_id, store_name FROM stores')
      const storeMap = {}
      stores.forEach(r => { storeMap[r.store_name] = r.store_id })

      // ID 生成器
      const idGen = createIdGenerator()
      await idGen.init(client)

      // 订单数据 lookup
      const orderMap = new Map()
      missingFromOrders.forEach(r => {
        if (!orderMap.has(r.customer_id)) orderMap.set(r.customer_id, r)
      })

      let insertedA = 0, insertedB = 0, skipped = 0

      // ── Group A：从订单创建合成记录 ──
      for (const customerId of groupA) {
        const order = orderMap.get(customerId)
        const storeName = trim(order?.store_name)
        const storeId = storeName ? (storeMap[storeName] || null) : null
        const name = trim(order?.customer_name) || customerId

        const res = await client.query(`
          INSERT INTO client_wechat_users (user_id, customer_id, name, bound_store_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (customer_id) WHERE customer_id IS NOT NULL DO NOTHING
        `, [idGen.next(), customerId, name, storeId])

        if (res.rowCount > 0) insertedA++
        else skipped++
      }
      log(`Group A 完成: 插入 ${insertedA}, 跳过 ${skipped}`)

      // ── Group B：从顾客表导入，phone=NULL 避免冲突 ──
      skipped = 0
      for (const customerId of groupB) {
        const c = custDetails.get(customerId)
        const storeName = trim(c.store_name)
        const storeId = storeName ? (storeMap[storeName] || null) : null

        const res = await client.query(`
          INSERT INTO client_wechat_users (
            user_id, customer_id, name, bound_store_id, bound_employee_id,
            member_level, customer_source, category, birthday, occupation,
            is_married, wechat_name, skin_type, improvement_focus,
            skin_issue, wellness_preference
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (customer_id) WHERE customer_id IS NOT NULL DO NOTHING
        `, [
          idGen.next(), customerId, trim(c.name) || customerId,
          storeId, trim(c.bound_employee_id), trim(c.member_level),
          normalizeCustomerSource(c.customer_source), trim(c.category), toDateStr(c.birthday),
          trim(c.occupation), toBool(c.is_married_raw), trim(c.wechat_name),
          trim(c.skin_type), trim(c.improvement_focus),
          trim(c.skin_issue), trim(c.wellness_preference),
        ])

        if (res.rowCount > 0) insertedB++
        else skipped++
      }
      log(`Group B 完成: 插入 ${insertedB}, 跳过 ${skipped}`)

      await client.query('COMMIT')
      log(`总计: 插入 ${insertedA + insertedB} 条顾客记录`)

      // ─── 4. 验证 ─────────────────────────────────────────
      console.log('\n=== 数据验证 ===')
      const { rows: [{ cnt: totalCusts }] } = await pgPool.query(
        'SELECT COUNT(*) AS cnt FROM client_wechat_users'
      )
      console.log(`  client_wechat_users 总数: ${totalCusts}`)

      // 重新检查缺失
      const { rows: pgCusts2 } = await pgPool.query(
        'SELECT customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL'
      )
      const pgSet2 = new Set(pgCusts2.map(r => r.customer_id))
      const stillMissing = missingIds.filter(id => !pgSet2.has(id))
      console.log(`  仍缺失的顾客: ${stillMissing.length}`)

      // FK 完整性
      const { rows: [{ cnt: orphanCusts }] } = await pgPool.query(`
        SELECT COUNT(*) AS cnt FROM client_wechat_users
        WHERE bound_store_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM stores WHERE store_id = client_wechat_users.bound_store_id)
      `)
      console.log(`  孤立 store_id: ${orphanCusts}`)

      // customer_id 唯一性
      const { rows: dupCheck } = await pgPool.query(`
        SELECT customer_id, COUNT(*) AS cnt
        FROM client_wechat_users
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id HAVING COUNT(*) > 1
        LIMIT 5
      `)
      console.log(`  customer_id 重复: ${dupCheck.length}`)

    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    console.log('\n✓ 迁移完成!')

  } catch (err) {
    console.error('\n✗ 失败:', err)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    if (pgPool) await pgPool.end()
  }
}

main()
