#!/usr/bin/env node
/**
 * migrate-active-cards.js — 迁移 WorkFine 活跃疗程卡余次到 PG
 *
 * 将 WorkFine 中有剩余次数且未过期的疗程卡导入到 PG sale_orders + sale_items，
 * 使员工端和客户端可以看到历史购买的疗程卡及余次。
 *
 * 用法：
 *   node scripts/migrate-active-cards.js              # 正式执行
 *   node scripts/migrate-active-cards.js --dry-run     # 预览模式
 *   node scripts/migrate-active-cards.js --verify      # 仅验证已导入数据
 *
 * 数据隔离：WorkFine 订单号无 -WX- 前缀，与 PG 原生订单自然隔离
 * 幂等设计：使用 UPSERT（ON CONFLICT DO UPDATE），可重复执行
 * 事务安全：按批次事务处理，单批失败回滚不影响已完成批次
 */

const mssql = require('mssql')
const { Pool } = require('pg')

// ─── 配置 ────────────────────────────────────────────────

const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER || 'SD',
  password: process.env.MSSQL_PASSWORD || 'Se4Qimoh',
  database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: process.env.MSSQL_SERVER || '47.96.87.33',
  port: parseInt(process.env.MSSQL_PORT) || 1433,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 300000, // 5 分钟超时（大查询）
}

// DATABASE_URL 必填且必须精确指向两个业务库之一（db/CLAUDE.md 硬规则：显式传值 + 断言 host/port/dbname）。
// 只查"非空"不够：已弃用的旧库 47.113.202.7 至今仍可连通，手滑传进来会静默写错库。
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
const DB_TARGET_RE = /^postgresql:\/\/[^@/]*@(101\.34\.242\.103|118\.178\.196\.26):5433\/fengyu_wxapp(\?.*)?$/
if (require.main === module && !DB_TARGET_RE.test(process.env.DATABASE_URL?.trim() || '')) {
  console.error('✗ DATABASE_URL 必须显式指向 dev=101.34.242.103:5433/fengyu_wxapp 或 prod=118.178.196.26:5433/fengyu_wxapp')
  process.exit(1)
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL?.trim(),
  max: 5,
}

const BATCH_SIZE = 500 // 每批处理的订单数

// ─── 工具函数 ──────────────────────────────────────────────

function trim(val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  return s === '' ? null : s
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

function toTimestamp(val) {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

function log(msg) {
  console.log(`[CARDS] ${msg}`)
}

function warn(msg) {
  console.log(`[CARDS][WARN] ${msg}`)
}

// ─── 1. 查询 WorkFine 活跃疗程卡 ─────────────────────────────

async function queryActiveCards(mssqlPool) {
  log('查询 WorkFine 活跃疗程卡...')
  log('  → 计算已使用次数（JOIN UDT_M_260, 约 83万行）...')

  const { recordset } = await mssqlPool.request().query(`
    ;WITH usage AS (
      SELECT
        RTRIM(UDF_M_4904) AS sale_flow_no,
        SUM(ISNULL(UDF_M_836, 0)) AS used_sessions
      FROM UDT_M_260
      WHERE UDF_M_4904 IS NOT NULL AND RTRIM(UDF_M_4904) != ''
      GROUP BY RTRIM(UDF_M_4904)
    )
    SELECT
      RTRIM(m.UDF_M_852)   AS sale_item_id,
      RTRIM(s.UDF_S_372)   AS sale_order_id,
      s.UDF_S_350           AS sale_date,
      RTRIM(s.UDF_S_348)   AS market_name,
      RTRIM(s.UDF_S_349)   AS store_name,
      RTRIM(s.UDF_S_1485)  AS customer_id,
      RTRIM(s.UDF_S_370)   AS customer_name,
      s.UDF_S_507           AS order_total,
      RTRIM(m.UDF_M_392)   AS category_name,
      RTRIM(m.UDF_M_393)   AS item_name,
      RTRIM(m.UDF_M_4728)  AS product_type_raw,
      m.UDF_M_394           AS total_sessions,
      ISNULL(u.used_sessions, 0) AS used_sessions,
      m.UDF_M_394 - ISNULL(u.used_sessions, 0) AS remaining_sessions,
      m.UDF_M_4949          AS original_price,
      m.UDF_M_395           AS sale_amount,
      m.UDF_M_399           AS received,
      m.UDF_M_7122          AS expire_date,
      RTRIM(m.UDF_M_4939)  AS is_gift_raw,
      RTRIM(m.UDF_M_16124) AS remark
    FROM UDT_M_213 m
    INNER JOIN UDT_S_209 s ON m.RID = s.RID
    LEFT JOIN usage u ON u.sale_flow_no = RTRIM(m.UDF_M_852)
    WHERE m.UDF_M_4728 IN (N'疗程卡', N'自定义-疗程')
      AND m.UDF_M_394 > 0
      AND m.UDF_M_394 - ISNULL(u.used_sessions, 0) > 0
      AND (m.UDF_M_7122 IS NULL OR m.UDF_M_7122 > GETDATE())
      AND m.UDF_M_852 IS NOT NULL AND RTRIM(m.UDF_M_852) != ''
      AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
    ORDER BY s.UDF_S_372, m.UDF_M_852
  `)

  log(`查询完成：${recordset.length} 条活跃疗程卡`)
  return recordset
}

// ─── 2. 加载 PG 查找表 ─────────────────────────────────────

async function loadLookups(pgPool) {
  log('加载 PG 查找表...')

  // 顾客 customer_id → user_id
  const custRes = await pgPool.query(
    "SELECT user_id, customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL"
  )
  const customerMap = {} // customer_id → user_id
  custRes.rows.forEach(r => { customerMap[r.customer_id] = r.user_id })
  log(`  顾客映射：${Object.keys(customerMap).length} 条`)

  // 门店 store_name → store_id
  const storeRes = await pgPool.query("SELECT store_id, store_name FROM stores")
  const storeMap = {} // store_name → store_id
  storeRes.rows.forEach(r => { storeMap[r.store_name] = r.store_id })
  log(`  门店映射：${Object.keys(storeMap).length} 条`)

  // 已存在的 sale_order_id（避免与 PG 原生订单冲突）
  const existRes = await pgPool.query("SELECT sale_order_id FROM sale_orders")
  const existingOrders = new Set(existRes.rows.map(r => r.sale_order_id))
  log(`  已存在订单：${existingOrders.size} 条`)

  return { customerMap, storeMap, existingOrders }
}

// ─── 3. 分组和验证 ─────────────────────────────────────────

function groupByOrder(rows, lookups) {
  const { customerMap, storeMap } = lookups
  const orders = new Map() // sale_order_id → { order, items[] }

  const stats = {
    total: rows.length,
    skippedNoCustomer: 0,
    skippedNoStore: 0,
    skippedNegativePrice: 0,
    skippedDuplicate: 0,
    validItems: 0,
    validOrders: 0,
    unmatchedCustomers: new Set(),
    unmatchedStores: new Set(),
  }

  for (const row of rows) {
    const saleOrderId = trim(row.sale_order_id)
    const saleItemId = trim(row.sale_item_id)
    if (!saleOrderId || !saleItemId) continue

    // PG 原生订单含 -WX-，WorkFine 不含；检查是否冲突
    if (saleOrderId.includes('-WX-') || saleItemId.includes('-WX-')) {
      stats.skippedDuplicate++
      continue
    }

    // 顾客映射
    const customerId = trim(row.customer_id)
    const userId = customerId ? customerMap[customerId] : null
    if (!userId) {
      stats.skippedNoCustomer++
      if (customerId) stats.unmatchedCustomers.add(customerId)
      continue
    }

    // 门店映射
    const storeName = trim(row.store_name)
    const storeId = storeName ? storeMap[storeName] : null
    if (!storeId) {
      stats.skippedNoStore++
      if (storeName) stats.unmatchedStores.add(storeName)
      continue
    }

    // 价格校验（CHECK 约束要求 >= 0）
    const unitPrice = Math.max(0, parseFloat(row.original_price) || 0)
    const saleAmount = Math.max(0, parseFloat(row.sale_amount) || 0)
    const unitRealPrice = saleAmount // quantity = 1
    const received = parseFloat(row.received) || 0

    // remaining_sessions 校验（CHECK 约束要求 >= 0）
    const remainingSessions = Math.max(0, Math.round(row.remaining_sessions || 0))
    if (remainingSessions <= 0) continue

    // 构建 order 组
    if (!orders.has(saleOrderId)) {
      orders.set(saleOrderId, {
        saleOrderId,
        saleDate: toTimestamp(row.sale_date),
        marketName: trim(row.market_name) || '未知市场',
        storeId,
        clientUserId: userId,
        customerName: trim(row.customer_name),
        orderTotal: parseFloat(row.order_total) || 0,
        items: [],
      })
    }

    const totalSessions = Math.round(parseFloat(row.total_sessions) || 0)

    orders.get(saleOrderId).items.push({
      saleItemId,
      categoryName: trim(row.category_name),
      itemName: trim(row.item_name),
      productType: row.product_type_raw === '自定义-疗程' ? '疗程卡' : '疗程卡',
      totalSessions,
      remainingSessions,
      unitPrice,
      unitRealPrice,
      saleAmount,
      received,
      expireDate: toDateStr(row.expire_date),
      remark: trim(row.remark),
    })

    stats.validItems++
  }

  stats.validOrders = orders.size

  return { orders, stats }
}

// ─── 4. 批量 UPSERT（多行 VALUES 优化版）──────────────────────

/**
 * 构建多行 INSERT 的 VALUES 占位符和扁平参数数组
 */
function buildMultiRowValues(rows, colCount) {
  const values = []
  const placeholders = []
  let paramIdx = 1
  for (const row of rows) {
    const ph = []
    for (let i = 0; i < colCount; i++) {
      ph.push(`$${paramIdx++}`)
      values.push(row[i])
    }
    placeholders.push(`(${ph.join(',')})`)
  }
  return { placeholders: placeholders.join(','), values }
}

async function batchUpsert(pgPool, orders, dryRun) {
  const orderList = [...orders.values()]
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)

  log(`开始导入：${orderList.length} 个订单，分 ${totalBatches} 批处理`)

  let totalOrdersUpserted = 0
  let totalItemsUpserted = 0

  if (dryRun) {
    totalOrdersUpserted = orderList.length
    totalItemsUpserted = orderList.reduce((sum, o) => sum + o.items.length, 0)
    return { totalOrdersUpserted, totalItemsUpserted }
  }

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, orderList.length)
    const batchOrders = orderList.slice(start, end)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // ── 批量 UPSERT sale_orders ──
      const orderRows = batchOrders.map(o => {
        const totalAmount = o.items.reduce((sum, it) => sum + it.saleAmount, 0)
        return [
          o.saleOrderId, '已完成', '普通', o.marketName, o.storeId,
          o.saleDate || new Date().toISOString(), o.clientUserId, o.customerName,
          totalAmount, '线下', 'admin', '已分配', 'WorkFine历史订单导入',
        ]
      })
      const oMv = buildMultiRowValues(orderRows, 13)
      const r1 = await client.query(`
        INSERT INTO sale_orders (
          sale_order_id, status, sale_order_type, market_name, store_id,
          sale_order_datetime, client_user_id, customer_name, total_amount,
          payment_method, sale_order_source, allocation_status, remark
        ) VALUES ${oMv.placeholders}
        ON CONFLICT (sale_order_id) DO UPDATE SET
          customer_name = EXCLUDED.customer_name,
          total_amount = EXCLUDED.total_amount,
          updated_at = now()
      `, oMv.values)
      totalOrdersUpserted += r1.rowCount

      // ── 批量 UPSERT sale_items ──
      const itemRows = []
      for (const order of batchOrders) {
        for (const item of order.items) {
          itemRows.push([
            item.saleItemId, order.saleOrderId, '购买',
            item.itemName || '未知项目', item.productType,
            item.totalSessions, item.remainingSessions,
            item.unitPrice, 1, item.unitRealPrice, item.saleAmount, item.received,
            item.expireDate, '自销自耗', item.remark,
          ])
        }
      }
      if (itemRows.length > 0) {
        const iMv = buildMultiRowValues(itemRows, 15)
        const r2 = await client.query(`
          INSERT INTO sale_items (
            sale_item_id, sale_order_id, item_direction,
            product_name, product_type,
            session_count, remaining_sessions,
            unit_price, quantity, unit_real_price, sale_amount, received,
            expire_date, sales_category, remark
          ) VALUES ${iMv.placeholders}
          ON CONFLICT (sale_item_id) DO UPDATE SET
            remaining_sessions = EXCLUDED.remaining_sessions,
            expire_date = EXCLUDED.expire_date,
            updated_at = now()
        `, iMv.values)
        totalItemsUpserted += r2.rowCount
      }

      await client.query('COMMIT')

      if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
        log(`  批次 ${batch + 1}/${totalBatches} 完成 (累计: ${totalOrdersUpserted} 订单, ${totalItemsUpserted} 项目)`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      warn(`批次 ${batch + 1} 失败，已回滚: ${err.message}`)
      const failedIds = batchOrders.map(o => o.saleOrderId).join(', ')
      warn(`  失败订单: ${failedIds.substring(0, 200)}...`)
      throw err
    } finally {
      client.release()
    }
  }

  return { totalOrdersUpserted, totalItemsUpserted }
}

// ─── 5. 验证 ────────────────────────────────────────────────

async function verify(pgPool, mssqlPool) {
  console.log('\n=== 数据验证 ===')

  // PG 侧统计
  const pgOrders = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders WHERE remark = 'WorkFine历史订单导入'"
  )
  const pgItems = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(remaining_sessions) AS total_remaining FROM sale_items si " +
    "JOIN sale_orders so ON si.sale_order_id = so.sale_order_id " +
    "WHERE so.remark = 'WorkFine历史订单导入'"
  )
  console.log(`  PG 导入订单: ${pgOrders.rows[0].cnt}`)
  console.log(`  PG 导入项目: ${pgItems.rows[0].cnt}, 总余次: ${pgItems.rows[0].total_remaining}`)

  // 按产品类型分布
  const byType = await pgPool.query(
    "SELECT si.product_type, COUNT(*) AS cnt, SUM(si.remaining_sessions) AS remaining " +
    "FROM sale_items si JOIN sale_orders so ON si.sale_order_id = so.sale_order_id " +
    "WHERE so.remark = 'WorkFine历史订单导入' " +
    "GROUP BY si.product_type ORDER BY si.product_type"
  )
  console.log('\n  按产品类型:')
  byType.rows.forEach(r => console.log(`    ${r.product_type}: ${r.cnt} 条, 余次 ${r.remaining}`))

  // FK 完整性检查
  console.log('\n  FK 完整性检查:')

  const orphanOrders = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders so " +
    "WHERE so.remark = 'WorkFine历史订单导入' " +
    "AND so.client_user_id IS NOT NULL " +
    "AND NOT EXISTS (SELECT 1 FROM client_wechat_users c WHERE c.user_id = so.client_user_id)"
  )
  console.log(`    孤立订单（无效 client_user_id）: ${orphanOrders.rows[0].cnt}`)

  const orphanStores = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders so " +
    "WHERE so.remark = 'WorkFine历史订单导入' " +
    "AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.store_id = so.store_id)"
  )
  console.log(`    孤立订单（无效 store_id）: ${orphanStores.rows[0].cnt}`)

  // remaining_sessions 合理性
  const negRemaining = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_items si " +
    "JOIN sale_orders so ON si.sale_order_id = so.sale_order_id " +
    "WHERE so.remark = 'WorkFine历史订单导入' AND si.remaining_sessions < 0"
  )
  console.log(`    负余次项目: ${negRemaining.rows[0].cnt}`)

  // 与 WorkFine 源对比
  if (mssqlPool) {
    const wfCount = await mssqlPool.request().query(`
      ;WITH usage AS (
        SELECT RTRIM(UDF_M_4904) AS sale_flow_no,
               SUM(ISNULL(UDF_M_836, 0)) AS used_sessions
        FROM UDT_M_260
        WHERE UDF_M_4904 IS NOT NULL AND RTRIM(UDF_M_4904) != ''
        GROUP BY RTRIM(UDF_M_4904)
      )
      SELECT COUNT(*) AS cnt
      FROM UDT_M_213 m
      LEFT JOIN usage u ON u.sale_flow_no = RTRIM(m.UDF_M_852)
      WHERE m.UDF_M_4728 IN (N'疗程卡', N'自定义-疗程')
        AND m.UDF_M_394 > 0
        AND m.UDF_M_394 - ISNULL(u.used_sessions, 0) > 0
        AND (m.UDF_M_7122 IS NULL OR m.UDF_M_7122 > GETDATE())
        AND m.UDF_M_852 IS NOT NULL AND RTRIM(m.UDF_M_852) != ''
    `)
    console.log(`\n  WorkFine 源活跃卡总数: ${wfCount.recordset[0].cnt}`)
    console.log(`  PG 导入数: ${pgItems.rows[0].cnt}`)
    const coverage = ((parseInt(pgItems.rows[0].cnt) / parseInt(wfCount.recordset[0].cnt)) * 100).toFixed(1)
    console.log(`  覆盖率: ${coverage}%`)
  }

  // 检查 remaining_sessions > session_count 的异常
  const overcounted = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_items si " +
    "JOIN sale_orders so ON si.sale_order_id = so.sale_order_id " +
    "WHERE so.remark = 'WorkFine历史订单导入' " +
    "AND si.remaining_sessions > si.session_count"
  )
  console.log(`    余次>总次数（异常）: ${overcounted.rows[0].cnt}`)
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== WorkFine 活跃疗程卡余次迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN（预览）' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  let mssqlPool = null
  let pgPool = null

  try {
    pgPool = new Pool(PG_CONFIG)
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) {
      await verify(pgPool, null)
      console.log('\n✓ 验证完成!')
      return
    }

    console.log('连接 WorkFine SQL Server...')
    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // Step 1: 查询活跃卡
    const activeCards = await queryActiveCards(mssqlPool)

    // Step 2: 加载 PG 查找表
    const lookups = await loadLookups(pgPool)

    // Step 3: 分组和验证
    const { orders, stats } = groupByOrder(activeCards, lookups)

    console.log('\n=== 数据分析 ===')
    console.log(`  WorkFine 活跃卡总数: ${stats.total}`)
    console.log(`  有效项目（可导入）: ${stats.validItems}`)
    console.log(`  有效订单: ${stats.validOrders}`)
    console.log(`  跳过 - 顾客未匹配: ${stats.skippedNoCustomer}（${stats.unmatchedCustomers.size} 个唯一顾客）`)
    console.log(`  跳过 - 门店未匹配: ${stats.skippedNoStore}（${stats.unmatchedStores.size} 个唯一门店）`)
    console.log(`  跳过 - ID 冲突: ${stats.skippedDuplicate}`)
    console.log(`  跳过 - 价格异常: ${stats.skippedNegativePrice}`)

    if (stats.unmatchedStores.size > 0) {
      console.log(`\n  未匹配门店: ${[...stats.unmatchedStores].slice(0, 10).join(', ')}${stats.unmatchedStores.size > 10 ? '...' : ''}`)
    }
    if (stats.unmatchedCustomers.size > 0) {
      console.log(`  未匹配顾客（前10）: ${[...stats.unmatchedCustomers].slice(0, 10).join(', ')}${stats.unmatchedCustomers.size > 10 ? '...' : ''}`)
    }

    if (stats.validItems === 0) {
      warn('没有可导入的数据')
      return
    }

    // Step 4: 批量 UPSERT
    console.log('')
    const result = await batchUpsert(pgPool, orders, dryRun)

    console.log(`\n=== ${dryRun ? '预览' : '导入'}结果 ===`)
    console.log(`  订单: ${result.totalOrdersUpserted}`)
    console.log(`  项目: ${result.totalItemsUpserted}`)

    // Step 5: 验证
    if (!dryRun) {
      await verify(pgPool, mssqlPool)
    }

    console.log(`\n✓ ${dryRun ? '预览完成（未写入数据）' : '迁移完成!'}`)
  } catch (err) {
    console.error('\n✗ 迁移失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    if (pgPool) await pgPool.end()
  }
}

// 仅在直接执行时运行：被 require 时不得有副作用（顶层校验同理，见文件头部）
if (require.main === module) main()
