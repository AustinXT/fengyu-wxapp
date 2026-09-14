#!/usr/bin/env node
/**
 * migrate-service-records.js — 导入 WorkFine 护理记录到 PG
 *
 * 将 WorkFine 售后护理单（UDT_S_259 + UDT_M_260）导入 PG 的
 * service_orders + service_items + service_commissions，
 * 使员工端可以看到历史服务记录和手工费。
 *
 * 用法：
 *   node scripts/migrate-service-records.js              # 2025-2026 数据
 *   node scripts/migrate-service-records.js --dry-run     # 预览
 *   node scripts/migrate-service-records.js --verify      # 仅验证
 *   node scripts/migrate-service-records.js --year=2026   # 仅指定年份
 *
 * 幂等设计：ON CONFLICT DO NOTHING（不覆盖已有记录）
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

// DATABASE_URL 必填：不提供默认值，避免忘传时静默连到已弃用的旧 dev 库（见 db/CLAUDE.md）
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
if (require.main === module && !process.env.DATABASE_URL?.trim()) {
  console.error('✗ 必须显式传 DATABASE_URL（dev=101.34.242.103:5433/fengyu_wxapp / prod=118.178.196.26:5433/fengyu_wxapp）')
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

function log(msg) { console.log(`[SVC] ${msg}`) }

// ─── 1. 查询 WorkFine 护理数据 ─────────────────────────────

async function queryServiceData(mssqlPool, yearFilter) {
  const yearClause = yearFilter ? `AND YEAR(s.UDF_S_822) = ${yearFilter}` : 'AND YEAR(s.UDF_S_822) >= 2025'

  log(`查询 WorkFine 护理数据 (${yearFilter || '2025-2026'})...`)

  const { recordset } = await mssqlPool.request().query(`
    SELECT
      RTRIM(s.UDF_S_821)  AS service_order_id,
      s.UDF_S_822          AS service_date,
      RTRIM(s.UDF_S_818)  AS market_name,
      RTRIM(s.UDF_S_820)  AS store_name,
      RTRIM(s.UDF_S_1491) AS customer_id,
      RTRIM(s.UDF_S_823)  AS customer_name,
      RTRIM(s.UDF_S_1417) AS service_type,
      m.OBYID               AS sub_index,
      RTRIM(m.UDF_M_835)  AS item_name,
      m.UDF_M_836           AS session_used,
      m.UDF_M_837           AS service_fee,
      RTRIM(m.UDF_M_2472) AS employee_id,
      RTRIM(m.UDF_M_839)  AS employee_name,
      m.UDF_M_840           AS duration_minutes,
      m.UDF_M_6869          AS unit_real_price,
      RTRIM(m.UDF_M_4904) AS sale_flow_no,
      RTRIM(m.UDF_M_6868) AS category_name,
      RTRIM(m.UDF_M_14831) AS item_store_name
    FROM UDT_S_259 s
    INNER JOIN UDT_M_260 m ON m.RID = s.RID
    WHERE s.UDF_S_821 IS NOT NULL AND RTRIM(s.UDF_S_821) != ''
      AND s.UDF_S_822 IS NOT NULL
      ${yearClause}
    ORDER BY s.UDF_S_822, s.UDF_S_821, m.OBYID
  `)

  log(`查询到 ${recordset.length} 条护理明细`)
  return recordset
}

// ─── 2. 处理和分组 ─────────────────────────────────────────

function processData(rows, lookups) {
  const { saleItemIds, customerMap, storeMap, employeeIds, employeeSkills, existingServiceIds } = lookups
  const orders = new Map()

  const stats = {
    total: rows.length,
    newItems: 0,
    skippedNoSaleItem: 0,
    skippedNoEmployee: 0,
    skippedNoStore: 0,
    skippedExists: 0,
  }

  for (const row of rows) {
    const serviceOrderId = trim(row.service_order_id)
    if (!serviceOrderId) continue

    // 门店匹配
    const storeName = trim(row.store_name) || trim(row.item_store_name)
    const storeId = storeName ? storeMap[storeName] : null
    if (!storeId) { stats.skippedNoStore++; continue }

    // 员工匹配
    const employeeId = trim(row.employee_id)
    if (!employeeId || !employeeIds.has(employeeId)) {
      stats.skippedNoEmployee++
      continue
    }

    // sale_item_id 匹配（必须引用已有的 sale_item）
    const saleFlowNo = trim(row.sale_flow_no)
    if (!saleFlowNo || !saleItemIds.has(saleFlowNo)) {
      stats.skippedNoSaleItem++
      continue
    }

    // 顾客匹配
    const customerId = trim(row.customer_id)
    const userId = customerId ? customerMap[customerId] : null

    // 构建 service_item_id
    const serviceItemId = `SVCI-${serviceOrderId}-${row.sub_index}`

    // 跳过已存在的服务单
    if (existingServiceIds.has(serviceItemId)) {
      stats.skippedExists++
      continue
    }

    // 分组到 order
    if (!orders.has(serviceOrderId)) {
      orders.set(serviceOrderId, {
        serviceOrderId,
        serviceDate: toDateStr(row.service_date),
        marketName: trim(row.market_name) || '未知市场',
        storeId,
        clientUserId: userId,
        assignedEmployeeId: employeeId, // 第一个明细的员工
        serviceType: trim(row.service_type) === '售前' ? '售前' : '售后',
        items: [],
      })
    }

    const sessionUsed = Math.max(1, parseInt(row.session_used) || 1)
    const serviceFee = Math.max(0, parseFloat(row.service_fee) || 0)
    const unitRealPrice = parseFloat(row.unit_real_price) || 0

    // role_type 派生：员工 skills[0]，缺省 '美容师'（与 backfill / payNotify 一致）
    const skills = (employeeSkills && employeeSkills.get(employeeId)) || []
    const roleType = skills[0] || '美容师'

    orders.get(serviceOrderId).items.push({
      serviceItemId,
      saleItemId: saleFlowNo,
      sessionUsed,
      employeeId,
      roleType,
      serviceDuration: parseInt(row.duration_minutes) || null,
      unitRealPrice: Math.max(0, unitRealPrice),
      serviceFee,
    })

    stats.newItems++
  }

  return { orders, stats }
}

// ─── 3. 批量 INSERT（多行 VALUES 优化版）──────────────────────

/**
 * 构建多行 INSERT 的 VALUES 占位符和扁平参数数组
 * @param {Array<Array>} rows - 每行的参数数组
 * @param {number} colCount - 每行列数
 * @returns {{ placeholders: string, values: Array }}
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

async function batchInsert(pgPool, orders, dryRun) {
  const orderList = [...orders.values()]
  const totalItems = orderList.reduce((s, o) => s + o.items.length, 0)
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)

  log(`导入: ${orderList.length} 护理单, ${totalItems} 明细, 分 ${totalBatches} 批`)

  if (dryRun) {
    return { orders: orderList.length, items: totalItems }
  }

  let ordersInserted = 0
  let itemsInserted = 0
  let commissionsInserted = 0

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, orderList.length)
    const batchOrders = orderList.slice(start, end)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // ── 1. 批量 INSERT service_orders ──
      const orderRows = batchOrders.map(o => [
        o.serviceOrderId, '已完成', o.serviceType, o.marketName,
        o.storeId, o.serviceDate, o.assignedEmployeeId,
        o.clientUserId, o.serviceDate,
      ])
      const oMv = buildMultiRowValues(orderRows, 9)
      const r1 = await client.query(`
        INSERT INTO service_orders (
          service_order_id, status, service_order_type, market_name, store_id,
          service_date, assigned_employee_id, client_user_id, completed_at
        ) VALUES ${oMv.placeholders}
        ON CONFLICT (service_order_id) DO NOTHING
      `, oMv.values)
      ordersInserted += r1.rowCount

      // ── 2. 批量 INSERT service_items ──
      const itemRows = []
      for (const order of batchOrders) {
        for (const item of order.items) {
          itemRows.push([
            item.serviceItemId, item.saleItemId, order.serviceOrderId,
            item.sessionUsed, item.employeeId, item.serviceDuration,
            item.unitRealPrice,
          ])
        }
      }
      if (itemRows.length > 0) {
        const iMv = buildMultiRowValues(itemRows, 7)
        const r2 = await client.query(`
          INSERT INTO service_items (
            service_item_id, sale_item_id, service_order_id,
            session_used, employee_id, service_duration, unit_real_price
          ) VALUES ${iMv.placeholders}
          ON CONFLICT (service_item_id) DO NOTHING
        `, iMv.values)
        itemsInserted += r2.rowCount
      }

      // ── 3. 批量 INSERT service_commissions ──
      const commRows = []
      for (const order of batchOrders) {
        for (const item of order.items) {
          if (item.serviceFee > 0) {
            const rate = item.unitRealPrice > 0
              ? Math.min(9.9999, Math.round((item.serviceFee / item.unitRealPrice) * 10000) / 10000)
              : 1.0000
            commRows.push([
              item.serviceItemId, item.employeeId, item.roleType, rate, item.serviceFee, false,
            ])
          }
        }
      }
      if (commRows.length > 0) {
        const cMv = buildMultiRowValues(commRows, 6)
        const r3 = await client.query(`
          INSERT INTO service_commissions (
            service_item_id, employee_id, role_type, commission_rate, commission_amount, is_void
          ) VALUES ${cMv.placeholders}
          ON CONFLICT ON CONSTRAINT uq_svc_comm_item_emp_role
          DO NOTHING
        `, cMv.values)
        commissionsInserted += r3.rowCount
      }

      await client.query('COMMIT')

      if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
        log(`  批次 ${batch + 1}/${totalBatches} (累计: ${ordersInserted} 单, ${itemsInserted} 明细, ${commissionsInserted} 提成)`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      log(`  批次 ${batch + 1} 失败: ${err.message}`)
      throw err
    } finally {
      client.release()
    }
  }

  return { orders: ordersInserted, items: itemsInserted, commissions: commissionsInserted }
}

// ─── 4. 验证 ────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')

  const so = await pgPool.query("SELECT COUNT(*) AS cnt FROM service_orders")
  const si = await pgPool.query("SELECT COUNT(*) AS cnt FROM service_items")
  const sc = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(commission_amount) AS total FROM service_commissions WHERE is_void = false"
  )
  console.log(`  护理单: ${so.rows[0].cnt}`)
  console.log(`  护理明细: ${si.rows[0].cnt}`)
  console.log(`  服务提成: ${sc.rows[0].cnt}, 总额 ¥${parseFloat(sc.rows[0].total || 0).toFixed(2)}`)

  // FK 完整性
  const orphan1 = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM service_items si WHERE NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.sale_item_id = si.sale_item_id)"
  )
  const orphan2 = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM service_items si WHERE NOT EXISTS (SELECT 1 FROM service_orders so WHERE so.service_order_id = si.service_order_id)"
  )
  const orphan3 = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM service_commissions sc WHERE NOT EXISTS (SELECT 1 FROM service_items si WHERE si.service_item_id = sc.service_item_id)"
  )
  console.log('\n  FK 完整性:')
  console.log(`    孤立 sale_item_id: ${orphan1.rows[0].cnt}`)
  console.log(`    孤立 service_order_id: ${orphan2.rows[0].cnt}`)
  console.log(`    孤立 service_item_id: ${orphan3.rows[0].cnt}`)
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')
  const yearArg = args.find(a => a.startsWith('--year='))
  const yearFilter = yearArg ? parseInt(yearArg.split('=')[1]) : null

  console.log('=== WorkFine 护理记录迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}`)
  console.log(`范围: ${yearFilter || '2025-2026'}\n`)

  let mssqlPool = null
  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) { await verify(pgPool); return }

    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // Step 1: 查询
    const rows = await queryServiceData(mssqlPool, yearFilter)

    // Step 2: 加载查找表
    log('加载 PG 查找表...')
    const saleItemRes = await pgPool.query("SELECT sale_item_id FROM sale_items")
    const saleItemIds = new Set(saleItemRes.rows.map(r => r.sale_item_id))
    log(`  sale_items: ${saleItemIds.size}`)

    const custRes = await pgPool.query("SELECT user_id, customer_id FROM client_wechat_users WHERE customer_id IS NOT NULL")
    const customerMap = {}
    custRes.rows.forEach(r => { customerMap[r.customer_id] = r.user_id })

    const storeRes = await pgPool.query("SELECT store_id, store_name FROM stores")
    const storeMap = {}
    storeRes.rows.forEach(r => { storeMap[r.store_name] = r.store_id })

    const empRes = await pgPool.query("SELECT employee_id, skills FROM staff_wechat_users WHERE employee_id IS NOT NULL")
    const employeeIds = new Set(empRes.rows.map(r => r.employee_id))
    const employeeSkills = new Map(
      empRes.rows.map(r => [r.employee_id, Array.isArray(r.skills) ? r.skills : []])
    )

    const existSvcRes = await pgPool.query("SELECT service_item_id FROM service_items")
    const existingServiceIds = new Set(existSvcRes.rows.map(r => r.service_item_id))
    log(`  已有护理明细: ${existingServiceIds.size}`)

    // Step 3: 处理
    const { orders, stats } = processData(rows, { saleItemIds, customerMap, storeMap, employeeIds, employeeSkills, existingServiceIds })

    console.log('\n=== 数据分析 ===')
    console.log(`  源明细总数: ${stats.total}`)
    console.log(`  可导入: ${stats.newItems} (${orders.size} 护理单)`)
    console.log(`  跳过 - 无匹配 sale_item: ${stats.skippedNoSaleItem}`)
    console.log(`  跳过 - 员工未匹配: ${stats.skippedNoEmployee}`)
    console.log(`  跳过 - 门店未匹配: ${stats.skippedNoStore}`)
    console.log(`  跳过 - 已存在: ${stats.skippedExists}`)

    if (orders.size === 0) { log('没有可导入的数据'); return }

    // Step 4: 导入
    console.log('')
    const result = await batchInsert(pgPool, orders, dryRun)

    console.log(`\n=== ${dryRun ? '预览' : '导入'}结果 ===`)
    console.log(`  护理单: ${result.orders}`)
    console.log(`  护理明细: ${result.items}`)
    if (result.commissions !== undefined) console.log(`  服务提成: ${result.commissions}`)

    if (!dryRun) await verify(pgPool)

    console.log(`\n✓ ${dryRun ? '预览完成' : '迁移完成!'}`)
  } catch (err) {
    console.error('\n✗ 失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    await pgPool.end()
  }
}

main()
