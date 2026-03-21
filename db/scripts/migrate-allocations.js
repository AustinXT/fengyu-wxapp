#!/usr/bin/env node
/**
 * migrate-allocations.js — 迁移 WorkFine 营业额分配到 PG
 *
 * 将 WorkFine UDT_M_217 中的营业额分配记录导入 PG sale_allocations，
 * 使员工端可以看到历史业绩分配数据（日/月提成统计）。
 *
 * 映射策略：
 *   - WorkFine 分配是订单级（一个员工一条），PG 分配是 item 级
 *   - 单 item 订单：直接映射
 *   - 多 item 订单：按各 item 的 sale_amount 比例分配
 *
 * 用法：
 *   node scripts/migrate-allocations.js              # 正式执行
 *   node scripts/migrate-allocations.js --dry-run     # 预览模式
 *   node scripts/migrate-allocations.js --verify      # 仅验证
 *
 * 幂等设计：ON CONFLICT (sale_item_id, employee_id) WHERE is_void = false DO UPDATE
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
  requestTimeout: 300000,
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp',
  max: 5,
}

const BATCH_SIZE = 1000

function trim(val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  return s === '' ? null : s
}

function log(msg) { console.log(`[ALLOC] ${msg}`) }
function warn(msg) { console.log(`[ALLOC][WARN] ${msg}`) }

// ─── 1. 查询 WorkFine 分配数据 ────────────────────────────────

async function queryAllocations(mssqlPool) {
  log('查询 WorkFine 营业额分配数据...')

  const { recordset } = await mssqlPool.request().query(`
    SELECT
      RTRIM(s.UDF_S_372)   AS sale_order_id,
      RTRIM(a.UDF_M_2316)  AS employee_id,
      RTRIM(a.UDF_M_419)   AS employee_name,
      RTRIM(a.UDF_M_418)   AS position_name,
      RTRIM(a.UDF_M_13713) AS department_name,
      a.UDF_M_13715         AS total_amount,
      a.UDF_M_420            AS amount_cat1,
      a.UDF_M_421            AS amount_cat2,
      a.UDF_M_422            AS amount_cat3,
      a.UDF_M_423            AS amount_cat4
    FROM UDT_M_217 a
    INNER JOIN UDT_S_209 s ON a.RID = s.RID
    WHERE a.UDF_M_2316 IS NOT NULL AND RTRIM(a.UDF_M_2316) != ''
      AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
      AND a.UDF_M_13715 IS NOT NULL
    ORDER BY s.UDF_S_372, a.UDF_M_2316
  `)

  log(`WorkFine 查询到 ${recordset.length} 条分配记录`)
  return recordset
}

// ─── 2. 加载 PG 查找表 ─────────────────────────────────────

async function loadLookups(pgPool) {
  log('加载 PG 查找表...')

  // 已导入订单的 items 映射 (sale_order_id → items[])
  const itemsRes = await pgPool.query(`
    SELECT si.sale_item_id, si.sale_order_id, si.sale_amount
    FROM sale_items si
    JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
    WHERE so.remark = 'WorkFine历史订单导入'
    ORDER BY si.sale_order_id, si.sale_amount DESC
  `)

  const orderItemsMap = {} // sale_order_id → [{ sale_item_id, sale_amount }]
  for (const row of itemsRes.rows) {
    if (!orderItemsMap[row.sale_order_id]) {
      orderItemsMap[row.sale_order_id] = []
    }
    orderItemsMap[row.sale_order_id].push({
      saleItemId: row.sale_item_id,
      saleAmount: parseFloat(row.sale_amount) || 0,
    })
  }
  log(`  订单-项目映射：${Object.keys(orderItemsMap).length} 个订单`)

  // 有效员工 ID 集合
  const empRes = await pgPool.query(
    "SELECT employee_id FROM staff_wechat_users WHERE employee_id IS NOT NULL"
  )
  const validEmployees = new Set(empRes.rows.map(r => r.employee_id))
  log(`  有效员工：${validEmployees.size} 个`)

  return { orderItemsMap, validEmployees }
}

// ─── 3. 生成 PG 分配记录 ───────────────────────────────────

function generateAllocations(wfAllocations, lookups) {
  const { orderItemsMap, validEmployees } = lookups
  const pgAllocations = [] // { saleItemId, employeeId, allocationRatio, totalAmount, departmentName }

  const stats = {
    total: wfAllocations.length,
    skippedNoOrder: 0,
    skippedNoEmployee: 0,
    skippedZeroAmount: 0,
    singleItemOrders: 0,
    multiItemOrders: 0,
    generatedRows: 0,
    unmatchedOrders: new Set(),
    unmatchedEmployees: new Set(),
  }

  for (const row of wfAllocations) {
    const saleOrderId = trim(row.sale_order_id)
    const employeeId = trim(row.employee_id)
    const totalAmount = parseFloat(row.total_amount) || 0
    const deptName = trim(row.department_name)

    if (!saleOrderId || !employeeId) continue

    // 订单必须存在于 PG
    const items = orderItemsMap[saleOrderId]
    if (!items || items.length === 0) {
      stats.skippedNoOrder++
      stats.unmatchedOrders.add(saleOrderId)
      continue
    }

    // 员工必须存在于 PG
    if (!validEmployees.has(employeeId)) {
      stats.skippedNoEmployee++
      stats.unmatchedEmployees.add(employeeId)
      continue
    }

    // 跳过零金额
    if (totalAmount === 0) {
      stats.skippedZeroAmount++
      continue
    }

    if (items.length === 1) {
      // 单 item 订单：直接映射
      stats.singleItemOrders++
      const item = items[0]
      const ratio = item.saleAmount > 0
        ? Math.min(999.99, Math.round((totalAmount / item.saleAmount) * 100) / 100)
        : 1.00

      pgAllocations.push({
        saleItemId: item.saleItemId,
        employeeId,
        allocationRatio: ratio,
        totalAmount,
        departmentName: deptName,
      })
      stats.generatedRows++
    } else {
      // 多 item 订单：按 sale_amount 比例分配
      stats.multiItemOrders++
      const orderTotal = items.reduce((sum, it) => sum + it.saleAmount, 0)

      if (orderTotal <= 0) {
        // 所有 item 金额为 0（全赠品），分配到第一个 item
        pgAllocations.push({
          saleItemId: items[0].saleItemId,
          employeeId,
          allocationRatio: 1.00,
          totalAmount,
          departmentName: deptName,
        })
        stats.generatedRows++
      } else {
        // 按比例分配，确保合计精确
        let distributed = 0
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          let itemAlloc
          if (i === items.length - 1) {
            // 最后一个 item 承接剩余（避免舍入误差）
            itemAlloc = Math.round((totalAmount - distributed) * 100) / 100
          } else {
            const share = item.saleAmount / orderTotal
            itemAlloc = Math.round(totalAmount * share * 100) / 100
          }
          distributed += itemAlloc

          if (itemAlloc === 0) continue // 跳过 0 分配

          const ratio = item.saleAmount > 0
            ? Math.min(999.99, Math.round((itemAlloc / item.saleAmount) * 100) / 100)
            : 1.00

          pgAllocations.push({
            saleItemId: item.saleItemId,
            employeeId,
            allocationRatio: ratio,
            totalAmount: itemAlloc,
            departmentName: deptName,
          })
          stats.generatedRows++
        }
      }
    }
  }

  return { pgAllocations, stats }
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

async function batchUpsert(pgPool, allocations, dryRun) {
  const totalBatches = Math.ceil(allocations.length / BATCH_SIZE)
  log(`开始导入：${allocations.length} 条分配记录，分 ${totalBatches} 批`)

  let totalUpserted = 0

  if (dryRun) {
    log(`[DRY] 将导入 ${allocations.length} 条`)
    return allocations.length
  }

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, allocations.length)
    const batchRows = allocations.slice(start, end)

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')

      const rows = batchRows.map(r => [
        r.saleItemId, r.employeeId, r.allocationRatio, r.totalAmount, false, r.departmentName,
      ])
      const mv = buildMultiRowValues(rows, 6)
      const res = await client.query(`
        INSERT INTO sale_allocations (
          sale_item_id, employee_id, allocation_ratio, total_amount,
          is_void, department_name
        ) VALUES ${mv.placeholders}
        ON CONFLICT (sale_item_id, employee_id) WHERE is_void = false
        DO UPDATE SET
          allocation_ratio = EXCLUDED.allocation_ratio,
          total_amount = EXCLUDED.total_amount,
          department_name = EXCLUDED.department_name,
          updated_at = now()
      `, mv.values)
      totalUpserted += res.rowCount

      await client.query('COMMIT')

      if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
        log(`  批次 ${batch + 1}/${totalBatches} (累计: ${totalUpserted})`)
      }
    } catch (err) {
      await client.query('ROLLBACK')
      warn(`批次 ${batch + 1} 失败: ${err.message}`)
      throw err
    } finally {
      client.release()
    }
  }

  // 批量更新 allocation_status
  log('更新订单分配状态...')
  await pgPool.query(`
    UPDATE sale_orders so SET allocation_status = 'allocated', updated_at = now()
    WHERE so.remark = 'WorkFine历史订单导入'
      AND so.allocation_status IS DISTINCT FROM 'allocated'
      AND EXISTS (
        SELECT 1 FROM sale_items si
        JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id AND sa.is_void = false
        WHERE si.sale_order_id = so.sale_order_id
      )
  `)

  return totalUpserted
}

// ─── 5. 验证 ────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')

  // 总体统计
  const total = await pgPool.query(
    "SELECT COUNT(*) AS cnt, SUM(total_amount) AS total_amount FROM sale_allocations WHERE is_void = false"
  )
  console.log(`  分配记录总数: ${total.rows[0].cnt}, 总金额: ¥${parseFloat(total.rows[0].total_amount || 0).toFixed(2)}`)

  // 涉及员工数
  const emps = await pgPool.query(
    "SELECT COUNT(DISTINCT employee_id) AS cnt FROM sale_allocations WHERE is_void = false"
  )
  console.log(`  涉及员工: ${emps.rows[0].cnt}`)

  // FK 完整性
  console.log('\n  FK 完整性检查:')

  const orphanItems = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_allocations sa " +
    "WHERE sa.is_void = false AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_item_id = sa.sale_item_id)"
  )
  console.log(`    孤立 sale_item_id: ${orphanItems.rows[0].cnt}`)

  const orphanEmps = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_allocations sa " +
    "WHERE sa.is_void = false AND NOT EXISTS (SELECT 1 FROM staff_wechat_users e WHERE e.employee_id = sa.employee_id)"
  )
  console.log(`    孤立 employee_id: ${orphanEmps.rows[0].cnt}`)

  // 负金额检查
  const negAmount = await pgPool.query(
    "SELECT COUNT(*) AS cnt FROM sale_allocations WHERE is_void = false AND total_amount < 0"
  )
  console.log(`    负金额分配: ${negAmount.rows[0].cnt}`)

  // allocation_status 更新情况
  const allocStatus = await pgPool.query(`
    SELECT allocation_status, COUNT(*) AS cnt
    FROM sale_orders
    WHERE remark = 'WorkFine历史订单导入'
    GROUP BY allocation_status
    ORDER BY allocation_status
  `)
  console.log('\n  导入订单分配状态:')
  allocStatus.rows.forEach(r => console.log(`    ${r.allocation_status || '(null)'}: ${r.cnt}`))

  // 按部门统计
  const byDept = await pgPool.query(`
    SELECT COALESCE(department_name, '(无部门)') AS dept, COUNT(*) AS cnt, SUM(total_amount) AS total
    FROM sale_allocations
    WHERE is_void = false AND department_name IS NOT NULL
    GROUP BY department_name
    ORDER BY total DESC
    LIMIT 10
  `)
  console.log('\n  按部门 TOP 10:')
  byDept.rows.forEach(r => console.log(`    ${r.dept}: ${r.cnt} 条, ¥${parseFloat(r.total).toFixed(2)}`))
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verifyOnly = args.includes('--verify')

  console.log('=== WorkFine 营业额分配迁移 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : verifyOnly ? '仅验证' : '正式执行'}\n`)

  let mssqlPool = null
  let pgPool = null

  try {
    pgPool = new Pool(PG_CONFIG)
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功')

    if (verifyOnly) {
      await verify(pgPool)
      return
    }

    console.log('连接 WorkFine SQL Server...')
    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功\n')

    // Step 1: 查询分配数据
    const wfAllocations = await queryAllocations(mssqlPool)

    // Step 2: 加载 PG 查找表
    const lookups = await loadLookups(pgPool)

    // Step 3: 生成 PG 分配记录
    const { pgAllocations, stats } = generateAllocations(wfAllocations, lookups)

    console.log('\n=== 数据分析 ===')
    console.log(`  WorkFine 分配总数: ${stats.total}`)
    console.log(`  生成 PG 记录: ${stats.generatedRows}`)
    console.log(`  单 item 订单映射: ${stats.singleItemOrders}`)
    console.log(`  多 item 订单拆分: ${stats.multiItemOrders}`)
    console.log(`  跳过 - 订单不在PG: ${stats.skippedNoOrder}（${stats.unmatchedOrders.size} 个）`)
    console.log(`  跳过 - 员工不在PG: ${stats.skippedNoEmployee}（${stats.unmatchedEmployees.size} 个）`)
    console.log(`  跳过 - 零金额: ${stats.skippedZeroAmount}`)

    if (pgAllocations.length === 0) {
      warn('没有可导入的分配记录')
      return
    }

    // 去重：同一 (sale_item_id, employee_id) 合并金额，避免同批 UPSERT 冲突
    const dedupMap = new Map()
    for (const r of pgAllocations) {
      const key = `${r.saleItemId}|${r.employeeId}`
      if (dedupMap.has(key)) {
        const existing = dedupMap.get(key)
        existing.totalAmount = Math.round((existing.totalAmount + r.totalAmount) * 100) / 100
      } else {
        dedupMap.set(key, { ...r })
      }
    }
    const dedupedAllocations = [...dedupMap.values()]
    if (dedupedAllocations.length < pgAllocations.length) {
      log(`  去重: ${pgAllocations.length} → ${dedupedAllocations.length} 条（合并 ${pgAllocations.length - dedupedAllocations.length} 条重复）`)
    }

    // Step 4: 批量 UPSERT
    console.log('')
    const totalUpserted = await batchUpsert(pgPool, dedupedAllocations, dryRun)

    console.log(`\n=== ${dryRun ? '预览' : '导入'}结果 ===`)
    console.log(`  分配记录: ${totalUpserted}`)

    // Step 5: 验证
    if (!dryRun) {
      await verify(pgPool)
    }

    console.log(`\n✓ ${dryRun ? '预览完成' : '迁移完成!'}`)
  } catch (err) {
    console.error('\n✗ 迁移失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    if (pgPool) await pgPool.end()
  }
}

main()
