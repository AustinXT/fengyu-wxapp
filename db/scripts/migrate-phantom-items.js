#!/usr/bin/env node
/**
 * migrate-phantom-items.js — 为 phantom XSLSH/FY- 流水号创建合成 sale_items
 *
 * 问题：售后护理记录 (UDT_M_260) 引用了约 24,683 个 XSLSH 流水号，
 * 这些流水号在 WorkFine 销售明细表 (UDT_M_213) 中也不存在。
 * 导致 migrate-service-records.js 因无匹配 sale_item 跳过 ~96K 条护理记录。
 *
 * 方案：与 migrate-jclsh-items.js 类似，从护理记录本身反向重建合成
 * sale_orders + sale_items，为 service_items.sale_item_id FK 提供锚点。
 *
 * 用法：
 *   node scripts/migrate-phantom-items.js              # 正式执行
 *   node scripts/migrate-phantom-items.js --dry-run     # 预览
 *   node scripts/migrate-phantom-items.js --verify      # 仅验证
 *
 * 幂等设计：ON CONFLICT DO NOTHING
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
const DB_TARGET_RE = /^postgres(?:ql)?:\/\/[^@/]*@(101\.34\.242\.103|118\.178\.196\.26):5433\/fengyu_wxapp(?:\?(?![^#]*\b(?:host|hostaddr|port|dbname|database|options|service|passfile)=)[^#]*)?$/
if (require.main === module && !DB_TARGET_RE.test(process.env.DATABASE_URL?.trim() || '')) {
  console.error('✗ DATABASE_URL 必须显式指向 dev=101.34.242.103:5433/fengyu_wxapp 或 prod=118.178.196.26:5433/fengyu_wxapp')
  process.exit(1)
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL?.trim(),
  max: 5,
}

const BATCH_SIZE = 100 // 每批 100 订单（phantom 订单含大量 items，需控制参数数）

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

function log(msg) { console.log(`[PHANTOM] ${msg}`) }

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

// ─── 1. 查询 phantom 流水号 ────────────────────────────────

async function queryPhantomItems(mssqlPool, pgPool) {
  log('查询 UDT_M_260 中所有非 JCLSH/TKKLS 的流水号...')

  // 从护理记录聚合，每个 flow_no 取最早信息
  const { recordset } = await mssqlPool.request().query(`
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
    WHERE m.UDF_M_4904 IS NOT NULL AND RTRIM(m.UDF_M_4904) != ''
      AND RTRIM(m.UDF_M_4904) NOT LIKE N'JCLSH%'
      AND RTRIM(m.UDF_M_4904) NOT LIKE N'TKKLS%'
    GROUP BY RTRIM(m.UDF_M_4904)
  `)
  log(`UDT_M_260 唯一非 JCLSH/TKKLS 流水号: ${recordset.length}`)

  // 检查哪些已在 PG sale_items 中
  const allIds = recordset.map(r => r.flow_no)
  const { rows: existing } = await pgPool.query(
    'SELECT sale_item_id FROM sale_items WHERE sale_item_id = ANY($1)',
    [allIds]
  )
  const existingSet = new Set(existing.map(r => r.sale_item_id))
  log(`  已有 sale_items: ${existingSet.size}（ON CONFLICT DO NOTHING 跳过）`)

  // 也检查是否在 WorkFine UDT_M_213 中存在（已被 history-orders 导入）
  // phantom = 不在 UDT_M_213 中的
  const items = []
  for (const row of recordset) {
    const flowNo = trim(row.flow_no)
    if (!flowNo) continue
    // 已在 PG 中的会被 ON CONFLICT 跳过，但仍需处理
    const totalUsed = Math.round(parseFloat(row.total_used) || 0)
    const totalSessions = Math.max(totalUsed, 1) // 至少等于已用次数

    items.push({
      saleItemId: flowNo,
      itemName: trim(row.item_name) || '疗程项目',
      categoryName: trim(row.category_name),
      customerId: trim(row.customer_id),
      storeName: trim(row.store_name),
      totalSessions,
      totalUsed,
      remainingSessions: 0, // phantom 项目默认余次为 0（已被消耗）
      firstServiceDate: toDateStr(row.first_service_date),
    })
  }

  const phantomCount = items.filter(i => !existingSet.has(i.saleItemId)).length
  log(`  可导入 phantom 项目: ${phantomCount}`)

  return items
}

// ─── 2. 分组 ──────────────────────────────────────────────

function groupByCustomer(items, customerMap, storeMap) {
  const orders = new Map()
  const stats = {
    total: items.length,
    validItems: 0,
    skippedNoCustomer: 0,
    skippedNoStore: 0,
  }

  for (const item of items) {
    const customerId = item.customerId
    const userId = customerId ? customerMap[customerId] : null
    if (!userId) { stats.skippedNoCustomer++; continue }

    const storeId = item.storeName ? storeMap[item.storeName] : null
    if (!storeId) { stats.skippedNoStore++; continue }

    // 按顾客分组
    // sale_order_id 限 varchar(30)，用短前缀 + customer_id 后半段
    const custSuffix = customerId.replace('FYGK-', '')
    const orderKey = `PHT-${custSuffix}`.slice(0, 30)
    if (!orders.has(orderKey)) {
      orders.set(orderKey, {
        saleOrderId: orderKey,
        storeId,
        clientUserId: userId,
        customerName: customerId,
        saleDate: item.firstServiceDate || '2023-01-01',
        items: [],
      })
    }

    orders.get(orderKey).items.push({
      saleItemId: item.saleItemId,
      itemName: item.itemName,
      sessionCount: item.totalSessions,
      remainingSessions: item.remainingSessions,
    })

    stats.validItems++
  }

  return { orders, stats }
}

// ─── 3. 批量 INSERT ──────────────────────────────────────

async function batchInsert(pgPool, orders, dryRun) {
  const orderList = [...orders.values()]
  const totalItems = orderList.reduce((s, o) => s + o.items.length, 0)
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)

  log(`导入: ${orderList.length} 个合成订单, ${totalItems} 个 phantom 项目, 分 ${totalBatches} 批`)

  if (dryRun) return { orders: orderList.length, items: totalItems }

  let ordersInserted = 0, itemsInserted = 0

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, orderList.length)
    const batchOrders = orderList.slice(start, end)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // sale_orders
      const orderRows = batchOrders.map(o => [
        o.saleOrderId, '已完成', '普通', '未知市场', o.storeId,
        o.saleDate, o.clientUserId, o.customerName,
        0, '线下', 'admin', '已分配', 'WorkFine phantom流水号导入',
      ])
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

      // sale_items
      const itemRows = []
      for (const order of batchOrders) {
        for (const item of order.items) {
          itemRows.push([
            item.saleItemId, order.saleOrderId, '购买', item.itemName,
            '疗程卡', item.sessionCount, item.remainingSessions,
            0, 1, 0, 0, 0, null, '自销自耗', null,
          ])
        }
      }
      // 拆分 items 插入（每批最多 500 行，避免参数数超限）
      const ITEM_BATCH = 500
      for (let ib = 0; ib < itemRows.length; ib += ITEM_BATCH) {
        const subBatch = itemRows.slice(ib, ib + ITEM_BATCH)
        const iMv = buildMultiRowValues(subBatch, 15)
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
      throw err
    } finally {
      client.release()
    }
  }

  return { orders: ordersInserted, items: itemsInserted }
}

// ─── 主函数 ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== Phantom 流水号合成导入 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  let mssqlPool = null
  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) {
      const phantom = await pgPool.query(
        "SELECT COUNT(*) AS cnt FROM sale_orders WHERE remark = 'WorkFine phantom流水号导入'"
      )
      const items = await pgPool.query(
        "SELECT COUNT(*) AS cnt FROM sale_items si " +
        "INNER JOIN sale_orders so ON si.sale_order_id = so.sale_order_id " +
        "WHERE so.remark = 'WorkFine phantom流水号导入'"
      )
      console.log(`  phantom 订单: ${phantom.rows[0].cnt}`)
      console.log(`  phantom 项目: ${items.rows[0].cnt}`)
      return
    }

    console.log('连接 WorkFine SQL Server...')
    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // Step 1: 查询
    const items = await queryPhantomItems(mssqlPool, pgPool)

    // Step 2: 加载查找表
    log('加载 PG 查找表...')
    const custRes = await pgPool.query(
      'SELECT user_id, customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL'
    )
    const customerMap = {}
    custRes.rows.forEach(r => { customerMap[r.customer_id] = r.user_id })
    log(`  顾客映射: ${custRes.rows.length}`)

    const storeRes = await pgPool.query('SELECT store_id, store_name FROM stores')
    const storeMap = {}
    storeRes.rows.forEach(r => { storeMap[r.store_name] = r.store_id })
    log(`  门店映射: ${storeRes.rows.length}`)

    const existingRes = await pgPool.query(
      "SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE 'XSLSH%' OR sale_item_id LIKE 'FY-%'"
    )
    const existingItems = new Set(existingRes.rows.map(r => r.sale_item_id))
    log(`  已有 XSLSH/FY- items: ${existingItems.size}`)

    // Step 3: 分组
    const { orders, stats } = groupByCustomer(items, customerMap, storeMap)

    console.log('\n=== 数据分析 ===')
    console.log(`  源 phantom 项目: ${stats.total}`)
    console.log(`  可导入: ${stats.validItems} (${orders.size} 个合成订单)`)
    console.log(`  跳过 - 顾客未匹配: ${stats.skippedNoCustomer}`)
    console.log(`  跳过 - 门店未匹配: ${stats.skippedNoStore}`)

    if (orders.size === 0) {
      log('无新数据需要导入')
      return
    }

    // Step 4: 导入
    const result = await batchInsert(pgPool, orders, dryRun)

    console.log('\n=== 导入结果 ===')
    console.log(`  合成订单: ${result.orders}`)
    console.log(`  phantom 项目: ${result.items}`)

    if (!dryRun) {
      // 验证
      console.log('\n=== 数据验证 ===')
      const total = await pgPool.query("SELECT COUNT(*) AS cnt FROM sale_items")
      console.log(`  sale_items 总数: ${total.rows[0].cnt}`)

      const orphanUser = await pgPool.query(
        "SELECT COUNT(*) AS cnt FROM sale_orders so " +
        "WHERE so.remark = 'WorkFine phantom流水号导入' " +
        "AND so.client_user_id IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM client_wechat_users c WHERE c.user_id = so.client_user_id)"
      )
      const orphanStore = await pgPool.query(
        "SELECT COUNT(*) AS cnt FROM sale_orders so " +
        "WHERE so.remark = 'WorkFine phantom流水号导入' " +
        "AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.store_id = so.store_id)"
      )
      console.log(`  FK - 孤立 client_user_id: ${orphanUser.rows[0].cnt}`)
      console.log(`  FK - 孤立 store_id: ${orphanStore.rows[0].cnt}`)
    }

    console.log('\n✓ 迁移完成!')
    console.log('下一步: 重跑 migrate-service-records.js 以覆盖之前跳过的护理记录')

  } catch (err) {
    console.error('\n✗ 失败:', err)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    await pgPool.end()
  }
}

// 仅在直接执行时运行：被 require 时不得有副作用（顶层校验同理，见文件头部）
if (require.main === module) main()
