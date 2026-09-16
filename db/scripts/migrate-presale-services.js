#!/usr/bin/env node
/**
 * migrate-presale-services.js — 迁移 WorkFine 售前护理单到 PG
 *
 * WorkFine 中的售前护理单（UDT_S_762 + UDT_M_763）使用 HLD- 订单号，
 * 关联拓客卡流水（TKKLS-...），是面向潜在顾客的体验服务记录，
 * 与售后护理单（UDT_S_259）完全独立，此前从未迁移。
 *
 * 数据规模（2023-2026）：106,538 条，64,616 个唯一 TKKLS 流水号。
 *
 * 迁移策略：
 *   Phase 1 — 创建 TKKLS 合成 sale_orders + sale_items
 *     (与 migrate-jclsh-items.js 类似，为 service_items.sale_item_id FK 提供锚点)
 *   Phase 2 — 导入售前护理 service_orders + service_items
 *     (TKKLS 记录 service_fee 几乎全为 0，不计入 service_commissions)
 *
 * 用法：
 *   node scripts/migrate-presale-services.js              # 正式执行
 *   node scripts/migrate-presale-services.js --dry-run     # 预览
 *   node scripts/migrate-presale-services.js --verify      # 仅验证
 *   node scripts/migrate-presale-services.js --year=2025   # 指定年份
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

function log(msg) { console.log(`[PRESALE] ${msg}`) }

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

// ─── Phase 1: 查询并创建 TKKLS 合成 sale_items ────────────────

async function queryTkklsItems(mssqlPool) {
  log('查询 TKKLS 拓客卡流水（UDT_M_763 + UDT_S_762）...')
  const { recordset } = await mssqlPool.request().query(`
    SELECT
      RTRIM(m.UDF_M_4904)  AS flow_no,
      MIN(RTRIM(m.UDF_M_835))  AS item_name,
      MIN(RTRIM(m.UDF_M_6868)) AS category_name,
      MAX(m.UDF_M_836)          AS session_count,
      MIN(RTRIM(s.UDF_S_1491)) AS customer_id,
      MIN(RTRIM(s.UDF_S_820))  AS store_name,
      MIN(s.UDF_S_822) AS first_service_date
    FROM UDT_M_763 m
    INNER JOIN UDT_S_762 s ON m.RID = s.RID
    WHERE RTRIM(m.UDF_M_4904) LIKE N'TKKLS%'
      AND m.UDF_M_4904 IS NOT NULL
      AND s.UDF_S_822 IS NOT NULL
    GROUP BY RTRIM(m.UDF_M_4904)
  `)
  log(`唯一 TKKLS 流水: ${recordset.length}`)
  return recordset
}

async function createTkklsSaleItems(pgPool, wfItems, customerMap, storeMap, dryRun) {
  const orders = new Map() // TKKLS-ORDER-{customerId} → { ...order, items[] }
  const stats = { total: wfItems.length, valid: 0, skipCustomer: 0, skipStore: 0, existing: 0 }

  // 已存在的 TKKLS sale_items
  const existRes = await pgPool.query("SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE 'TKKLS%'")
  const existingIds = new Set(existRes.rows.map(r => r.sale_item_id))
  stats.existing = existingIds.size
  if (existingIds.size > 0) log(`  已有 TKKLS 项目: ${existingIds.size}（跳过）`)

  for (const row of wfItems) {
    const flowNo = trim(row.flow_no)
    if (!flowNo || existingIds.has(flowNo)) { if (existingIds.has(flowNo)) stats.existing++; continue }

    const customerId = trim(row.customer_id)
    const userId = customerId ? customerMap[customerId] : null
    if (!userId) { stats.skipCustomer++; continue }

    const storeName = trim(row.store_name)
    const storeId = storeName ? storeMap[storeName] : null
    if (!storeId) { stats.skipStore++; continue }

    const orderKey = `TKKLS-ORDER-${customerId}`
    if (!orders.has(orderKey)) {
      orders.set(orderKey, {
        saleOrderId: orderKey,
        storeId,
        clientUserId: userId,
        saleDate: toDateStr(row.first_service_date) || '2023-01-01',
        items: [],
      })
    }
    orders.get(orderKey).items.push({
      saleItemId: flowNo,
      itemName: trim(row.item_name) || '拓客卡',
      sessionCount: Math.max(1, Math.round(parseFloat(row.session_count) || 1)),
    })
    stats.valid++
  }

  log(`  TKKLS 可导入: ${stats.valid} (跳过顾客: ${stats.skipCustomer}, 跳过门店: ${stats.skipStore})`)
  log(`  合成订单: ${orders.size}`)

  if (dryRun || orders.size === 0) return { orders: orders.size, items: stats.valid }

  const orderList = [...orders.values()]
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)
  let ordersInserted = 0, itemsInserted = 0

  for (let b = 0; b < totalBatches; b++) {
    const slice = orderList.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE)
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // sale_orders
      const oRows = slice.map(o => [
        o.saleOrderId, '已完成', '普通', '未知市场', o.storeId,
        o.saleDate, o.clientUserId, null,
        0, '线下', 'admin', '已分配', 'WorkFine拓客卡导入',
      ])
      const oMv = buildMultiRowValues(oRows, 13)
      const r1 = await client.query(`
        INSERT INTO sale_orders (
          sale_order_id, status, sale_order_type, market_name, store_id,
          sale_order_datetime, client_user_id, customer_name,
          total_amount, payment_method, sale_order_source, allocation_status, remark
        ) VALUES ${oMv.placeholders}
        ON CONFLICT (sale_order_id) DO NOTHING
      `, oMv.values)
      ordersInserted += r1.rowCount

      // sale_items
      const iRows = []
      for (const o of slice) {
        for (const it of o.items) {
          iRows.push([
            it.saleItemId, o.saleOrderId, '购买', it.itemName,
            '疗程卡', it.sessionCount, 0,
            0, 1, 0, 0, 0,
            null, '自销自耗', null,
          ])
        }
      }
      if (iRows.length > 0) {
        const iMv = buildMultiRowValues(iRows, 15)
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
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  log(`  TKKLS sale_orders 导入: ${ordersInserted}, sale_items 导入: ${itemsInserted}`)
  return { orders: ordersInserted, items: itemsInserted }
}

// ─── Phase 2: 导入售前护理服务记录 ─────────────────────────────

async function queryPresaleServices(mssqlPool, yearFilter) {
  const yearClause = yearFilter
    ? `AND YEAR(s.UDF_S_822) = ${yearFilter}`
    : 'AND YEAR(s.UDF_S_822) >= 2023'

  log(`查询售前护理数据 (${yearFilter || '2023-2026'})...`)
  const { recordset } = await mssqlPool.request().query(`
    SELECT
      RTRIM(s.UDF_S_821)  AS service_order_id,
      s.UDF_S_822          AS service_date,
      RTRIM(s.UDF_S_818)  AS market_name,
      RTRIM(s.UDF_S_820)  AS store_name,
      RTRIM(s.UDF_S_1491) AS customer_id,
      RTRIM(s.UDF_S_1417) AS service_type,
      m.OBYID               AS sub_index,
      RTRIM(m.UDF_M_835)  AS item_name,
      m.UDF_M_836           AS session_used,
      m.UDF_M_837           AS service_fee,
      RTRIM(m.UDF_M_2472) AS employee_id,
      m.UDF_M_840           AS duration_minutes,
      m.UDF_M_6869          AS unit_real_price,
      RTRIM(m.UDF_M_4904) AS sale_flow_no,
      RTRIM(s.UDF_S_820)  AS item_store_name
    FROM UDT_S_762 s
    INNER JOIN UDT_M_763 m ON m.RID = s.RID
    WHERE s.UDF_S_821 IS NOT NULL AND RTRIM(s.UDF_S_821) != ''
      AND s.UDF_S_822 IS NOT NULL
      AND RTRIM(m.UDF_M_4904) LIKE N'TKKLS%'
      AND m.UDF_M_2472 IS NOT NULL AND RTRIM(m.UDF_M_2472) != ''
      ${yearClause}
    ORDER BY s.UDF_S_822, s.UDF_S_821
  `)
  log(`查询到 ${recordset.length} 条售前护理明细`)
  return recordset
}

function processPresaleData(rows, lookups) {
  const { saleItemIds, customerMap, storeMap, employeeIds, employeeSkills, existingServiceIds } = lookups
  const orders = new Map()
  const stats = {
    total: rows.length, newItems: 0,
    skipNoSaleItem: 0, skipNoEmployee: 0, skipNoStore: 0, skipExists: 0,
  }

  for (const row of rows) {
    const serviceOrderId = trim(row.service_order_id)
    if (!serviceOrderId) continue

    const storeName = trim(row.store_name) || trim(row.item_store_name)
    const storeId = storeName ? storeMap[storeName] : null
    if (!storeId) { stats.skipNoStore++; continue }

    const employeeId = trim(row.employee_id)
    if (!employeeId || !employeeIds.has(employeeId)) { stats.skipNoEmployee++; continue }

    const saleFlowNo = trim(row.sale_flow_no)
    if (!saleFlowNo || !saleItemIds.has(saleFlowNo)) { stats.skipNoSaleItem++; continue }

    const serviceItemId = `SVCI-${serviceOrderId}-${row.sub_index}`
    if (existingServiceIds.has(serviceItemId)) { stats.skipExists++; continue }

    const customerId = trim(row.customer_id)
    const userId = customerId ? customerMap[customerId] : null

    if (!orders.has(serviceOrderId)) {
      orders.set(serviceOrderId, {
        serviceOrderId,
        serviceDate: toDateStr(row.service_date),
        marketName: trim(row.market_name) || '未知市场',
        storeId,
        clientUserId: userId,
        assignedEmployeeId: employeeId,
        serviceType: '售前', // 售前护理单（TKKLS 拓客卡场景）
        items: [],
      })
    }

    const sessionUsed = Math.max(1, parseInt(row.session_used) || 1)
    const serviceFee = Math.max(0, parseFloat(row.service_fee) || 0)
    const unitRealPrice = Math.max(0, parseFloat(row.unit_real_price) || 0)

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
      unitRealPrice,
      serviceFee,
    })
    stats.newItems++
  }

  return { orders, stats }
}

async function batchInsertServices(pgPool, orders, dryRun) {
  const orderList = [...orders.values()]
  const totalItems = orderList.reduce((s, o) => s + o.items.length, 0)
  const totalBatches = Math.ceil(orderList.length / BATCH_SIZE)

  log(`导入: ${orderList.length} 护理单, ${totalItems} 明细, 分 ${totalBatches} 批`)
  if (dryRun) return { orders: orderList.length, items: totalItems, commissions: 0 }

  let ordersInserted = 0, itemsInserted = 0, commissionsInserted = 0

  for (let b = 0; b < totalBatches; b++) {
    const slice = orderList.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE)
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      // service_orders
      const oRows = slice.map(o => [
        o.serviceOrderId, '已完成', o.serviceType, o.marketName,
        o.storeId, o.serviceDate, o.assignedEmployeeId,
        o.clientUserId, o.serviceDate,
      ])
      const oMv = buildMultiRowValues(oRows, 9)
      const r1 = await client.query(`
        INSERT INTO service_orders (
          service_order_id, status, service_order_type, market_name, store_id,
          service_date, assigned_employee_id, client_user_id, completed_at
        ) VALUES ${oMv.placeholders}
        ON CONFLICT (service_order_id) DO NOTHING
      `, oMv.values)
      ordersInserted += r1.rowCount

      // service_items
      const iRows = []
      for (const o of slice) {
        for (const it of o.items) {
          iRows.push([
            it.serviceItemId, it.saleItemId, o.serviceOrderId,
            it.sessionUsed, it.employeeId, it.serviceDuration, it.unitRealPrice,
          ])
        }
      }
      if (iRows.length > 0) {
        const iMv = buildMultiRowValues(iRows, 7)
        const r2 = await client.query(`
          INSERT INTO service_items (
            service_item_id, sale_item_id, service_order_id,
            session_used, employee_id, service_duration, unit_real_price
          ) VALUES ${iMv.placeholders}
          ON CONFLICT (service_item_id) DO NOTHING
        `, iMv.values)
        itemsInserted += r2.rowCount
      }

      // service_commissions（仅 fee > 0，占比极少）
      const cRows = []
      for (const o of slice) {
        for (const it of o.items) {
          if (it.serviceFee > 0) {
            const rate = it.unitRealPrice > 0
              ? Math.min(9.9999, Math.round((it.serviceFee / it.unitRealPrice) * 10000) / 10000)
              : 1.0
            cRows.push([it.serviceItemId, it.employeeId, it.roleType, rate, it.serviceFee, false])
          }
        }
      }
      if (cRows.length > 0) {
        const cMv = buildMultiRowValues(cRows, 6)
        const r3 = await client.query(`
          INSERT INTO service_commissions (
            service_item_id, employee_id, role_type, commission_rate, commission_amount, is_void
          ) VALUES ${cMv.placeholders}
          ON CONFLICT ON CONSTRAINT uq_svc_comm_item_emp_role DO NOTHING
        `, cMv.values)
        commissionsInserted += r3.rowCount
      }

      await client.query('COMMIT')

      if ((b + 1) % 10 === 0 || b === totalBatches - 1) {
        log(`  批次 ${b + 1}/${totalBatches} (累计: ${ordersInserted} 单, ${itemsInserted} 明细, ${commissionsInserted} 提成)`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      log(`  批次 ${b + 1} 失败: ${err.message}`)
      throw err
    } finally {
      client.release()
    }
  }

  return { orders: ordersInserted, items: itemsInserted, commissions: commissionsInserted }
}

// ─── 验证 ─────────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')

  const tkkls = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_items WHERE sale_item_id LIKE 'TKKLS%'"
  )
  const tkklsOrders = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_orders WHERE remark = 'WorkFine拓客卡导入'"
  )
  const svc = await pgPool.query(
    "SELECT COUNT(*) AS so, (SELECT COUNT(*) FROM service_items) AS si, " +
    "(SELECT COUNT(*) FROM service_orders) AS total_so FROM service_orders WHERE service_order_type = '售前'"
  )
  console.log(`  拓客卡 sale_orders: ${tkklsOrders.rows[0].cnt}`)
  console.log(`  拓客卡 sale_items:  ${tkkls.rows[0].cnt}`)
  console.log(`  体验型护理单(总): ${svc.rows[0].so} (PG护理单总: ${svc.rows[0].total_so})`)
  console.log(`  PG service_items 总: ${svc.rows[0].si}`)

  // FK 完整性
  const orphan1 = await pgPool.query(
    "SELECT COUNT(*) AS c FROM service_items si WHERE NOT EXISTS (SELECT 1 FROM sale_items s WHERE s.sale_item_id = si.sale_item_id)"
  )
  const orphan2 = await pgPool.query(
    "SELECT COUNT(*) AS c FROM service_items si WHERE NOT EXISTS (SELECT 1 FROM service_orders so WHERE so.service_order_id = si.service_order_id)"
  )
  console.log('\n  FK 完整性:')
  console.log(`    孤立 sale_item_id: ${orphan1.rows[0].c}`)
  console.log(`    孤立 service_order_id: ${orphan2.rows[0].c}`)
}

// ─── 主函数 ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')
  const yearArg = args.find(a => a.startsWith('--year='))
  const yearFilter = yearArg ? parseInt(yearArg.split('=')[1]) : null

  console.log('=== WorkFine 售前护理单（拓客卡）迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}`)
  console.log(`范围: ${yearFilter || '2023-2026'}\n`)

  let mssqlPool = null
  const pgPool = new Pool(PG_CONFIG)

  try {
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) { await verify(pgPool); return }

    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // 加载 PG 查找表
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

    const empRes = await pgPool.query("SELECT employee_id, skills FROM staff_wechat_users WHERE employee_id IS NOT NULL")
    const employeeIds = new Set(empRes.rows.map(r => r.employee_id))
    const employeeSkills = new Map(
      empRes.rows.map(r => [r.employee_id, Array.isArray(r.skills) ? r.skills : []])
    )
    log(`  员工: ${employeeIds.size}`)

    // ── Phase 1: TKKLS 合成 sale_items ──
    console.log('\n--- Phase 1: TKKLS 拓客卡合成导入 ---')
    const tkklsItems = await queryTkklsItems(mssqlPool)
    const p1Result = await createTkklsSaleItems(pgPool, tkklsItems, customerMap, storeMap, dryRun)

    // 重新加载 sale_item_ids（包含新增的 TKKLS）
    const saleItemRes = await pgPool.query("SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE 'TKKLS%'")
    const saleItemIds = new Set(saleItemRes.rows.map(r => r.sale_item_id))
    log(`  TKKLS sale_items 可用: ${saleItemIds.size}`)

    // 也加载已存在的护理明细
    const existSvcRes = await pgPool.query(
      "SELECT service_item_id FROM service_items WHERE service_item_id LIKE 'SVCI-HLD-%'"
    )
    const existingServiceIds = new Set(existSvcRes.rows.map(r => r.service_item_id))
    log(`  已有 HLD 护理明细: ${existingServiceIds.size}`)

    // ── Phase 2: 售前护理记录 ──
    console.log('\n--- Phase 2: 售前护理服务记录导入 ---')
    const rows = await queryPresaleServices(mssqlPool, yearFilter)
    const { orders, stats } = processPresaleData(rows, {
      saleItemIds, customerMap, storeMap, employeeIds, employeeSkills, existingServiceIds,
    })

    console.log('\n=== 数据分析 ===')
    console.log(`  源明细总数: ${stats.total}`)
    console.log(`  可导入: ${stats.newItems} (${orders.size} 护理单)`)
    console.log(`  跳过 - 无匹配 sale_item: ${stats.skipNoSaleItem}`)
    console.log(`  跳过 - 员工未匹配: ${stats.skipNoEmployee}`)
    console.log(`  跳过 - 门店未匹配: ${stats.skipNoStore}`)
    console.log(`  跳过 - 已存在: ${stats.skipExists}`)

    if (orders.size === 0) { log('没有可导入的数据'); return }

    console.log('')
    const p2Result = await batchInsertServices(pgPool, orders, dryRun)

    console.log(`\n=== ${dryRun ? '预览' : '导入'}结果 ===`)
    console.log(`  Phase 1 拓客卡 sale_items: ${p1Result.items}`)
    console.log(`  Phase 2 售前护理单: ${p2Result.orders}`)
    console.log(`  Phase 2 售前护理明细: ${p2Result.items}`)
    if (p2Result.commissions) console.log(`  Phase 2 服务提成: ${p2Result.commissions}`)

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

// 仅在直接执行时运行：被 require 时不得有副作用（顶层校验同理，见文件头部）
if (require.main === module) main()
