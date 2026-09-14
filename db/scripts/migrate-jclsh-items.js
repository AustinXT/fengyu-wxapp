#!/usr/bin/env node
/**
 * migrate-jclsh-items.js — 导入 WorkFine 结存项目（JCLSH）到 PG
 *
 * WorkFine 中有 45,786 个 JCLSH（结存流水号）项目，代表旧系统迁移到 WorkFine 时
 * 导入的疗程卡余次。这些项目在 UDT_M_260（售后护理明细）中被引用，但不存在于
 * UDT_M_213（标准销售明细），导致 ~84K 条护理记录因"无匹配 sale_item"被跳过。
 *
 * 本脚本将 JCLSH 项目作为 synthetic sale_items 导入 PG，使后续
 * migrate-service-records.js 能覆盖这些被跳过的护理记录。
 *
 * 数据源：
 *   - UDT_M_260（售后护理明细）— 唯一 JCLSH 列表 + 已使用次数
 *   - UDT_M_1028（护理记录详情）— 补充总次数、有效期
 *
 * 用法：
 *   node scripts/migrate-jclsh-items.js              # 正式执行
 *   node scripts/migrate-jclsh-items.js --dry-run     # 预览模式
 *   node scripts/migrate-jclsh-items.js --verify      # 仅验证
 *
 * 幂等设计：ON CONFLICT DO NOTHING（不覆盖已有数据）
 */

const mssql = require('mssql')
const { Pool } = require('pg')

const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER || 'SD',
  password: process.env.MSSQL_PASSWORD || 'Se4Qimoh',
  database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: process.env.MSSQL_SERVER || '47.96.87.33',
  port: parseInt(process.env.MSSQL_PORT) || 1433,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 600000,
}

// DATABASE_URL 必填且必须精确指向两个业务库之一（db/CLAUDE.md 硬规则：显式传值 + 断言 host/port/dbname）。
// 只查"非空"不够：已弃用的旧库 47.113.202.7 至今仍可连通，手滑传进来会静默写错库。
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
const DB_TARGET_RE = /^postgres(?:ql)?:\/\/[^@/]*@(101\.34\.242\.103|118\.178\.196\.26):5433\/fengyu_wxapp(\?.*)?$/
if (require.main === module && !DB_TARGET_RE.test(process.env.DATABASE_URL?.trim() || '')) {
  console.error('✗ DATABASE_URL 必须显式指向 dev=101.34.242.103:5433/fengyu_wxapp 或 prod=118.178.196.26:5433/fengyu_wxapp')
  process.exit(1)
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL?.trim(),
  max: 5,
}

const BATCH_SIZE = 500

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

function log(msg) { console.log(`[JCLSH] ${msg}`) }

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

// ─── 1. 查询 WorkFine JCLSH 数据 ─────────────────────────────

async function queryJclshItems(mssqlPool) {
  log('查询 UDT_M_260 中所有 JCLSH 引用（含已使用次数）...')
  const r1 = await mssqlPool.request().query(`
    SELECT
      RTRIM(m.UDF_M_4904)  AS flow_no,
      MIN(RTRIM(m.UDF_M_835))  AS item_name,
      MIN(RTRIM(m.UDF_M_6868)) AS category_name,
      SUM(ISNULL(m.UDF_M_836, 0)) AS total_used,
      COUNT(*) AS service_count,
      MIN(RTRIM(s.UDF_S_1491))  AS customer_id,
      MIN(RTRIM(s.UDF_S_820))   AS store_name,
      MIN(s.UDF_S_822) AS first_service_date
    FROM UDT_M_260 m
    INNER JOIN UDT_S_259 s ON m.RID = s.RID
    WHERE RTRIM(m.UDF_M_4904) LIKE N'JCLSH%'
      AND m.UDF_M_4904 IS NOT NULL
    GROUP BY RTRIM(m.UDF_M_4904)
  `)
  log(`UDT_M_260 唯一 JCLSH: ${r1.recordset.length}`)

  // 补充信息来自 UDT_M_1028
  log('查询 UDT_M_1028 补充总次数和有效期...')
  const r2 = await mssqlPool.request().query(`
    SELECT
      RTRIM(UDF_M_11414) AS flow_no,
      RTRIM(UDF_M_11412) AS customer_id,
      RTRIM(UDF_M_11413) AS customer_name,
      RTRIM(UDF_M_11410) AS store_name,
      MAX(UDF_M_11424) AS total_sessions,
      MIN(UDF_M_11418) AS expire_date
    FROM UDT_M_1028
    WHERE RTRIM(UDF_M_11414) LIKE N'JCLSH%'
    GROUP BY RTRIM(UDF_M_11414), RTRIM(UDF_M_11412), RTRIM(UDF_M_11413), RTRIM(UDF_M_11410)
  `)
  log(`UDT_M_1028 补充数据: ${r2.recordset.length} 条`)

  // 合并数据
  const supplementMap = {} // flow_no → { total_sessions, expire_date, customer_name }
  for (const row of r2.recordset) {
    const fn = trim(row.flow_no)
    if (!fn) continue
    if (!supplementMap[fn]) {
      supplementMap[fn] = {
        totalSessions: Math.round(parseFloat(row.total_sessions) || 0),
        expireDate: toDateStr(row.expire_date),
        customerName: trim(row.customer_name),
        storeName: trim(row.store_name),
        customerId: trim(row.customer_id),
      }
    }
  }

  // 合并
  const items = []
  for (const row of r1.recordset) {
    const flowNo = trim(row.flow_no)
    if (!flowNo) continue

    const supp = supplementMap[flowNo] || {}
    const totalUsed = Math.round(parseFloat(row.total_used) || 0)
    const totalSessions = supp.totalSessions || Math.max(totalUsed, 1)
    const remaining = Math.max(0, totalSessions - totalUsed)

    items.push({
      saleItemId: flowNo,
      itemName: trim(row.item_name) || '结存项目',
      categoryName: trim(row.category_name),
      customerId: supp.customerId || trim(row.customer_id),
      customerName: supp.customerName,
      storeName: supp.storeName || trim(row.store_name),
      totalSessions,
      totalUsed,
      remainingSessions: remaining,
      expireDate: supp.expireDate,
      firstServiceDate: toDateStr(row.first_service_date),
    })
  }

  log(`合并后: ${items.length} 个 JCLSH 项目`)
  return items
}

// ─── 2. 分组和匹配 ─────────────────────────────────────────

function groupByCustomer(items, customerMap, storeMap) {
  const orders = new Map() // customer_id → { items[], ... }
  const stats = {
    total: items.length,
    validItems: 0,
    skippedNoCustomer: 0,
    skippedNoStore: 0,
    uniqueCustomers: new Set(),
  }

  for (const item of items) {
    const customerId = item.customerId
    const userId = customerId ? customerMap[customerId] : null
    if (!userId) {
      stats.skippedNoCustomer++
      continue
    }

    const storeName = item.storeName
    const storeId = storeName ? storeMap[storeName] : null
    if (!storeId) {
      stats.skippedNoStore++
      continue
    }

    stats.uniqueCustomers.add(customerId)

    // 按顾客分组，一个顾客的所有结存项目归到一个 synthetic 订单
    const orderKey = `JCLSH-ORDER-${customerId}`
    if (!orders.has(orderKey)) {
      orders.set(orderKey, {
        saleOrderId: orderKey,
        storeId,
        clientUserId: userId,
        customerName: item.customerName || customerId,
        saleDate: item.firstServiceDate || '2023-02-03', // JCLSH 多从 2023-02 开始
        items: [],
      })
    }

    orders.get(orderKey).items.push({
      saleItemId: item.saleItemId,
      itemName: item.itemName,
      sessionCount: item.totalSessions,
      remainingSessions: item.remainingSessions,
      expireDate: item.expireDate,
    })

    stats.validItems++
  }

  return { orders, stats }
}

// ─── 3. 批量 INSERT（多行 VALUES 优化）──────────────────────

async function batchInsert(pgPool, orders, dryRun) {
  const orderList = [...orders.values()]
  const totalItems = orderList.reduce((s, o) => s + o.items.length, 0)
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)

  log(`导入: ${orderList.length} 个合成订单, ${totalItems} 个结存项目, 分 ${totalBatches} 批`)

  if (dryRun) {
    return { orders: orderList.length, items: totalItems }
  }

  let ordersInserted = 0
  let itemsInserted = 0

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, orderList.length)
    const batchOrders = orderList.slice(start, end)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // ── 批量 INSERT sale_orders ──
      const orderRows = batchOrders.map(o => {
        const totalAmount = 0 // 结存项目无原始金额
        return [
          o.saleOrderId, '已完成', '普通', '未知市场', o.storeId,
          o.saleDate, o.clientUserId, o.customerName,
          totalAmount, '线下', 'admin', '已分配', 'WorkFine结存项目导入',
        ]
      })
      const oMv = buildMultiRowValues(orderRows, 13)
      const r1 = await client.query(`
        INSERT INTO sale_orders (
          sale_order_id, status, sale_order_type, market_name, store_id,
          sale_order_datetime, client_user_id, customer_name, total_amount,
          payment_method, sale_order_source, allocation_status, remark
        ) VALUES ${oMv.placeholders}
        ON CONFLICT (sale_order_id) DO NOTHING
      `, oMv.values)
      ordersInserted += r1.rowCount

      // ── 批量 INSERT sale_items ──
      const itemRows = []
      for (const order of batchOrders) {
        for (const item of order.items) {
          itemRows.push([
            item.saleItemId, order.saleOrderId, '购买', item.itemName,
            '疗程卡', item.sessionCount, item.remainingSessions,
            0, 1, 0, 0, 0, // unit_price, qty, unit_real_price, sale_amount, received = 0（结存无原始价格）
            item.expireDate, '自销自耗', null, // remark
          ])
        }
      }
      if (itemRows.length > 0) {
        const iMv = buildMultiRowValues(itemRows, 15)
        const r2 = await client.query(`
          INSERT INTO sale_items (
            sale_item_id, sale_order_id, item_direction, product_name,
            product_type, session_count, remaining_sessions,
            unit_price, quantity, unit_real_price, sale_amount, received,
            expire_date, sales_category, remark
          ) VALUES ${iMv.placeholders}
          ON CONFLICT (sale_item_id) DO NOTHING
        `, iMv.values)
        itemsInserted += r2.rowCount
      }

      await client.query('COMMIT')

      if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
        log(`  批次 ${batch + 1}/${totalBatches} (累计: ${ordersInserted} 订单, ${itemsInserted} 项目)`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      log(`  批次 ${batch + 1} 失败: ${err.message}`)
      throw err
    } finally {
      client.release()
    }
  }

  return { orders: ordersInserted, items: itemsInserted }
}

// ─── 4. 验证 ────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')

  const jclshOrders = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders WHERE remark = 'WorkFine结存项目导入'"
  )
  const jclshItems = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(remaining_sessions) AS total_remaining FROM sale_items " +
    "WHERE sale_item_id LIKE 'JCLSH%'"
  )
  console.log(`  结存订单: ${jclshOrders.rows[0].cnt}`)
  console.log(`  结存项目: ${jclshItems.rows[0].cnt}, 总余次: ${jclshItems.rows[0].total_remaining || 0}`)

  // FK 完整性
  const orphanUser = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders so " +
    "WHERE so.remark = 'WorkFine结存项目导入' " +
    "AND so.client_user_id IS NOT NULL " +
    "AND NOT EXISTS (SELECT 1 FROM client_wechat_users c WHERE c.user_id = so.client_user_id)"
  )
  const orphanStore = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders so " +
    "WHERE so.remark = 'WorkFine结存项目导入' " +
    "AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.store_id = so.store_id)"
  )
  console.log('\n  FK 完整性:')
  console.log(`    孤立 client_user_id: ${orphanUser.rows[0].cnt}`)
  console.log(`    孤立 store_id: ${orphanStore.rows[0].cnt}`)

  // 潜在解锁的护理记录数
  const unlockable = await pgPool.query(`
    SELECT COUNT(*) AS cnt FROM sale_items WHERE sale_item_id LIKE 'JCLSH%'
  `)
  console.log(`\n  导入结存项目后，重跑 migrate-service-records.js 预计可额外覆盖 ~84K 条护理记录`)
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== WorkFine 结存项目（JCLSH）迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  let mssqlPool = null
  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) {
      await verify(pgPool)
      return
    }

    console.log('连接 WorkFine SQL Server...')
    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // Step 1: 查询
    const items = await queryJclshItems(mssqlPool)

    // Step 2: 加载 PG 查找表
    log('加载 PG 查找表...')
    const custRes = await pgPool.query(
      "SELECT user_id, customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL"
    )
    const customerMap = {}
    custRes.rows.forEach(r => { customerMap[r.customer_id] = r.user_id })
    log(`  顾客映射: ${Object.keys(customerMap).length}`)

    const storeRes = await pgPool.query("SELECT store_id, store_name FROM stores")
    const storeMap = {}
    storeRes.rows.forEach(r => { storeMap[r.store_name] = r.store_id })
    log(`  门店映射: ${Object.keys(storeMap).length}`)

    // 检查已存在的 JCLSH items
    const existRes = await pgPool.query(
      "SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE 'JCLSH%'"
    )
    const existingCount = existRes.rows.length
    if (existingCount > 0) {
      log(`  已有 JCLSH 项目: ${existingCount}（ON CONFLICT DO NOTHING 跳过）`)
    }

    // Step 3: 分组
    const { orders, stats } = groupByCustomer(items, customerMap, storeMap)

    console.log('\n=== 数据分析 ===')
    console.log(`  JCLSH 总项目: ${stats.total}`)
    console.log(`  有效（可导入）: ${stats.validItems}`)
    console.log(`  涉及顾客: ${stats.uniqueCustomers.size}`)
    console.log(`  合成订单: ${orders.size}`)
    console.log(`  跳过 - 顾客未匹配: ${stats.skippedNoCustomer}`)
    console.log(`  跳过 - 门店未匹配: ${stats.skippedNoStore}`)

    if (stats.validItems === 0) {
      log('没有可导入的数据')
      return
    }

    // Step 4: 批量 INSERT
    console.log('')
    const result = await batchInsert(pgPool, orders, dryRun)

    console.log(`\n=== ${dryRun ? '预览' : '导入'}结果 ===`)
    console.log(`  合成订单: ${result.orders}`)
    console.log(`  结存项目: ${result.items}`)

    if (!dryRun) {
      await verify(pgPool)
    }

    console.log(`\n✓ ${dryRun ? '预览完成' : '迁移完成!'}`)
    if (!dryRun) {
      console.log('\n下一步: 重跑 migrate-service-records.js 以覆盖之前因缺少 JCLSH 引用而跳过的护理记录')
    }
  } catch (err) {
    console.error('\n✗ 失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    await pgPool.end()
  }
}

// 仅在直接执行时运行：被 require 时不得有副作用（顶层校验同理，见文件头部）
if (require.main === module) main()
