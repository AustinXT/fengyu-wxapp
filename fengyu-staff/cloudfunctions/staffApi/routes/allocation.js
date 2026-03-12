/**
 * 营业额分配模块路由（员工端）
 * allocation.save — 保存/更新提成分配（店长专用，支付后操作）
 * allocation.delete — 删除营业额分配记录（店长专用）
 * allocation.getCommissionRates — 获取提成比例矩阵（从 WorkFine）
 * allocation.pendingList — 待分配订单列表（店长专用）
 *
 * 新规则（支付后分配）：
 *   - 订单状态为"已支付"且 allocation_status IN ('pending', 'allocated') 时可分配
 *   - 按 SKU 销售分类 × 部门 × 提成比例计算
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireManager } = require('../middleware/auth')

/**
 * 保存提成分配（支付后分配）
 * payload: {
 *   orderNo: string,
 *   allocations: [{
 *     employeeId: string,
 *     department: string,
 *     items: [{
 *       itemFlowNo: string,
 *       salesCategory: string,
 *       commissionRate: number,
 *       amount: number
 *     }]
 *   }]
 * }
 */
async function save(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo, allocations } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }
  if (!Array.isArray(allocations)) {
    throw new Error('INVALID_PARAMS: allocations 必须为数组')
  }

  // 查询订单
  const orders = await pg.query(
    'SELECT order_no, status, allocation_status, store_name FROM orders WHERE order_no = $1 AND store_name = $2',
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  // 新规则：仅允许"已支付"状态的订单进行分配
  if (order.status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可进行提成分配')
  }
  if (!['pending', 'allocated'].includes(order.allocation_status)) {
    throw new Error('PERMISSION_DENIED: 订单分配状态异常')
  }

  // 空分配：标记为无需分配
  if (allocations.length === 0) {
    const now = new Date()
    await pg.transaction(async (client) => {
      // 删除原有分配记录
      const existingAllocs = await client.query(
        'SELECT id FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
        [orderNo]
      )
      for (const ea of existingAllocs.rows) {
        await client.query('DELETE FROM revenue_allocation_items WHERE allocation_id = $1', [ea.id])
      }
      await client.query(
        'DELETE FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
        [orderNo]
      )
      await client.query(
        "UPDATE orders SET allocation_status = 'allocated', updated_at = $1 WHERE order_no = $2",
        [now, orderNo]
      )
    })
    ctx.result = { orderNo, message: '已标记为无需分配', allocationCount: 0 }
    return
  }

  // 查询实收金额（receivable 合计）
  const amtRows = await pg.query(
    'SELECT COALESCE(SUM(receivable), 0) AS total FROM order_items WHERE order_no = $1',
    [orderNo]
  )
  const totalReceivable = Number(amtRows[0].total)

  // 校验分配金额（按部门检查：同部门总额 ≤ 实收）
  const deptTotals = {}
  for (const alloc of allocations) {
    if (!alloc.employeeId) {
      throw new Error('INVALID_PARAMS: 分配记录缺少 employeeId')
    }
    if (!alloc.department) {
      throw new Error('INVALID_PARAMS: 分配记录缺少 department')
    }
    if (!alloc.items || !Array.isArray(alloc.items) || alloc.items.length === 0) {
      throw new Error('INVALID_PARAMS: 分配明细不能为空')
    }
    const allocTotal = alloc.items.reduce((s, i) => s + (Number(i.amount) || 0), 0)
    const dept = alloc.department
    deptTotals[dept] = (deptTotals[dept] || 0) + allocTotal
  }

  // 每个部门总额不超过实收
  for (const [dept, total] of Object.entries(deptTotals)) {
    if (total > totalReceivable + 0.01) {
      throw new Error(`INVALID_PARAMS: ${dept} 部门分配总额 ${total} 超过实收金额 ${totalReceivable}`)
    }
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    // 删除原有的未作废分配记录
    const existingAllocs = await client.query(
      'SELECT id FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
      [orderNo]
    )

    for (const ea of existingAllocs.rows) {
      await client.query('DELETE FROM revenue_allocation_items WHERE allocation_id = $1', [ea.id])
    }
    await client.query(
      'DELETE FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
      [orderNo]
    )

    // 插入新的分配记录
    for (const alloc of allocations) {
      const allocTotal = alloc.items.reduce((s, i) => s + (Number(i.amount) || 0), 0)

      const insertResult = await client.query(
        `INSERT INTO revenue_allocations
           (order_no, employee_id, department, allocation_ratio, total_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, 1.0, $4, false, $5, $5)
         RETURNING id`,
        [orderNo, alloc.employeeId, alloc.department, allocTotal, now]
      )
      const allocId = insertResult.rows[0].id

      // 插入明细
      for (const item of alloc.items) {
        await client.query(
          `INSERT INTO revenue_allocation_items
             (allocation_id, item_flow_no, performance_category, amount, commission_rate)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            allocId,
            item.itemFlowNo || null,
            item.salesCategory || '单品',
            Number(item.amount) || 0,
            item.commissionRate != null ? item.commissionRate : null
          ]
        )
      }
    }

    // 更新订单分配状态
    await client.query(
      "UPDATE orders SET allocation_status = 'allocated', updated_at = $1 WHERE order_no = $2",
      [now, orderNo]
    )
  })

  ctx.result = {
    orderNo,
    message: '提成分配已保存',
    allocationCount: allocations.length
  }
}

/**
 * 删除营业额分配记录（重置为待分配状态）
 * 仅允许"已支付"阶段操作
 */
async function deleteAllocation(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    'SELECT order_no, status, allocation_status FROM orders WHERE order_no = $1 AND store_name = $2',
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可操作分配')
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    const existingAllocs = await client.query(
      'SELECT id FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
      [orderNo]
    )
    for (const ea of existingAllocs.rows) {
      await client.query('DELETE FROM revenue_allocation_items WHERE allocation_id = $1', [ea.id])
    }
    await client.query(
      'DELETE FROM revenue_allocations WHERE order_no = $1 AND is_void = false',
      [orderNo]
    )
    // 重置为 pending
    await client.query(
      "UPDATE orders SET allocation_status = 'pending', updated_at = $1 WHERE order_no = $2",
      [now, orderNo]
    )
  })

  ctx.result = {
    orderNo,
    message: '营业额分配已清除'
  }
}

/**
 * 获取提成比例矩阵（从 WorkFine UDT_S_1962 / UDT_M_1964）
 * payload: { marketName: string }
 * 返回: { rates: [{ department, amountMin, amountMax, orderRates: {...}, serviceRates: {...} }] }
 */
async function getCommissionRates(ctx) {
  await requireManager()(ctx, async () => {})

  const { marketName } = ctx.event.payload || {}
  if (!marketName) {
    throw new Error('INVALID_PARAMS: 缺少 marketName')
  }

  const pool = await mssql.getPool()
  const esc = (v) => String(v).replace(/'/g, "''")

  // 1. 查 UDT_S_1962 获取市场对应的 RID
  const masterResult = await pool.request()
    .input('market', marketName)
    .query('SELECT RID FROM UDT_S_1962 WHERE UDF_S_18660 = @market')

  if (masterResult.recordset.length === 0) {
    throw new Error(`INVALID_PARAMS: 未找到市场 "${marketName}" 的提成配置`)
  }

  const rid = masterResult.recordset[0].RID

  // 2. 查 UDT_M_1964 获取所有部门的提成配置
  const detailResult = await pool.request()
    .input('rid', rid)
    .query(`
      SELECT
        UDF_M_18649 AS department,
        UDF_M_18650 AS amount_min,
        UDF_M_18651 AS amount_max,
        UDF_M_18652 AS order_self_sell,
        UDF_M_18653 AS order_other_sell_self_use,
        UDF_M_18654 AS order_other_sell_other_use,
        UDF_M_18655 AS order_eco_coop,
        UDF_M_18656 AS service_self_sell,
        UDF_M_18657 AS service_other_sell_self_use,
        UDF_M_18658 AS service_other_sell_other_use,
        UDF_M_18659 AS service_eco_coop
      FROM UDT_M_1964
      WHERE RID = @rid
      ORDER BY UDF_M_18649, UDF_M_18650
    `)

  const rates = detailResult.recordset.map(r => ({
    department: (r.department || '').trim(),
    amountMin: r.amount_min != null ? Number(r.amount_min) : -9999.9,
    amountMax: r.amount_max != null ? Number(r.amount_max) : 10000000,
    orderRates: {
      '自采自销': Number(r.order_self_sell) || 0,
      '他销自耗': Number(r.order_other_sell_self_use) || 0,
      '他销他耗': Number(r.order_other_sell_other_use) || 0,
      '生态合作': Number(r.order_eco_coop) || 0,
    },
    serviceRates: {
      '自采自销': Number(r.service_self_sell) || 0,
      '他销自耗': Number(r.service_other_sell_self_use) || 0,
      '他销他耗': Number(r.service_other_sell_other_use) || 0,
      '生态合作': Number(r.service_eco_coop) || 0,
    },
  }))

  ctx.result = { rates }
}

/**
 * 待分配订单列表（店长专用）
 * 返回 status='已支付' AND allocation_status='pending' 的订单
 */
async function pendingList(ctx) {
  await requireManager()(ctx, async () => {})

  const { page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const orders = await pg.query(`
    SELECT
      o.order_no, o.status, o.order_type, o.client_phone, o.customer_name,
      o.payment_method, o.paid_at, o.created_at, o.allocation_status,
      o.order_source, o.preferred_employee_id,
      COALESCE((
        SELECT SUM(oi.receivable) FROM order_items oi WHERE oi.order_no = o.order_no
      ), 0) AS total_amount
    FROM orders o
    WHERE o.store_name = $1
      AND o.status = '已支付'
      AND o.allocation_status = 'pending'
    ORDER BY o.paid_at DESC
    LIMIT $2 OFFSET $3
  `, [ctx.auth.storeName, pageSize, offset])

  ctx.result = { orders, page, pageSize }
}

/**
 * 查询员工部门归属（美容部/养生部判定）
 * 优先使用主部门 UDF_S_1513，兜底第二部门 UDF_S_12921
 */
async function resolveStaffDepartment(staffWfId) {
  const pool = await mssql.getPool()
  const result = await pool.request()
    .input('id', staffWfId)
    .query(`
      SELECT UDF_S_1147 AS staffWfId, UDF_S_1155 AS name,
             UDF_S_1513 AS primaryDept, UDF_S_12921 AS secondaryDept
      FROM UDT_S_287
      WHERE UDF_S_1147 = @id
    `)

  if (result.recordset.length === 0) return null

  const row = result.recordset[0]
  const primary = (row.primaryDept || '').trim()
  const secondary = (row.secondaryDept || '').trim()
  const validDepts = ['美容部', '养生部']

  let resolvedDept = null
  if (validDepts.includes(primary)) {
    resolvedDept = primary
  } else if (validDepts.includes(secondary)) {
    resolvedDept = secondary
  }

  return {
    staffWfId: (row.staffWfId || '').trim(),
    name: (row.name || '').trim(),
    primaryDept: primary,
    secondaryDept: secondary,
    resolvedDept,
  }
}

/**
 * 检查是否为新顾客（跨所有门店，无历史已支付订单）
 */
async function checkNewCustomer(clientPhone, currentOrderNo) {
  if (!clientPhone) return false
  const rows = await pg.query(
    "SELECT COUNT(*)::int AS cnt FROM orders WHERE client_phone = $1 AND status = '已支付' AND order_no != $2",
    [clientPhone, currentOrderNo]
  )
  return rows[0].cnt === 0
}

/**
 * 获取分配建议
 * payload: { orderNo }
 * 返回自动填充的分配行 + 上下文信息
 */
async function suggest(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  // 1. 加载订单
  const orders = await pg.query(
    `SELECT order_no, status, allocation_status, store_name, market_name,
            order_source, preferred_employee_id, client_phone, customer_name
     FROM orders WHERE order_no = $1 AND store_name = $2`,
    [orderNo, ctx.auth.storeName]
  )
  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }
  const order = orders[0]

  // 2. 解析指定美容师
  let beauticianInfo = null
  let deptAnomalous = false
  if (order.preferred_employee_id) {
    beauticianInfo = await resolveStaffDepartment(order.preferred_employee_id)
    if (beauticianInfo && !beauticianInfo.resolvedDept) {
      deptAnomalous = true
    }
  }

  // 3. 检查新顾客
  const isNewCustomer = await checkNewCustomer(order.client_phone, orderNo)

  // 4. 美容部/养生部提成始终可选
  const beauticianRequired = false

  // 5. 加载订单项
  const items = await pg.query(`
    SELECT oi.item_flow_no, oi.receivable, oi.sales_category,
           p.name AS spu_name, m.sku_display_name, m.product_type
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
    ORDER BY oi.item_flow_no
  `, [orderNo])

  const totalAmount = items.reduce((s, i) => s + Number(i.receivable || 0), 0)

  // 6. 加载提成比例
  let rates = []
  try {
    const pool = await mssql.getPool()
    const masterResult = await pool.request()
      .input('market', order.market_name)
      .query('SELECT RID FROM UDT_S_1962 WHERE UDF_S_18660 = @market')

    if (masterResult.recordset.length > 0) {
      const rid = masterResult.recordset[0].RID
      const detailResult = await pool.request()
        .input('rid', rid)
        .query(`
          SELECT
            UDF_M_18649 AS department, UDF_M_18650 AS amount_min, UDF_M_18651 AS amount_max,
            UDF_M_18652 AS order_self_sell, UDF_M_18653 AS order_other_sell_self_use,
            UDF_M_18654 AS order_other_sell_other_use, UDF_M_18655 AS order_eco_coop,
            UDF_M_18656 AS service_self_sell, UDF_M_18657 AS service_other_sell_self_use,
            UDF_M_18658 AS service_other_sell_other_use, UDF_M_18659 AS service_eco_coop
          FROM UDT_M_1964 WHERE RID = @rid
          ORDER BY UDF_M_18649, UDF_M_18650
        `)

      rates = detailResult.recordset.map(r => ({
        department: (r.department || '').trim(),
        amountMin: r.amount_min != null ? Number(r.amount_min) : -9999.9,
        amountMax: r.amount_max != null ? Number(r.amount_max) : 10000000,
        orderRates: {
          '自采自销': Number(r.order_self_sell) || 0,
          '他销自耗': Number(r.order_other_sell_self_use) || 0,
          '他销他耗': Number(r.order_other_sell_other_use) || 0,
          '生态合作': Number(r.order_eco_coop) || 0,
        },
      }))
    }
  } catch (_) {
    console.warn('[allocation.suggest] 获取提成比例失败')
  }

  // 7. 提取美容部/养生部提成比例（按 salesCategory），供前端选人后动态计算
  const beautyDepts = ['美容部', '养生部']
  const beautyRates = {} // { '美容部': { '自采自销': 0.15, ... }, '养生部': { ... } }
  for (const rate of rates) {
    if (beautyDepts.includes(rate.department) && !beautyRates[rate.department]) {
      beautyRates[rate.department] = rate.orderRates
    }
  }

  // 8. 生成分配行（仅在有指定美容师且部门已解析时预填）
  const allocLines = []
  if (beauticianInfo && beauticianInfo.resolvedDept && beautyRates[beauticianInfo.resolvedDept]) {
    const dept = beauticianInfo.resolvedDept
    for (const item of items) {
      const salesCat = item.sales_category || '自采自销'
      const receivable = Number(item.receivable) || 0
      const commRate = beautyRates[dept][salesCat] || 0
      const amount = (receivable * commRate).toFixed(2)
      allocLines.push({
        itemFlowNo: item.item_flow_no,
        department: dept,
        staffWfId: beauticianInfo.staffWfId,
        staffName: beauticianInfo.name,
        salesCategory: salesCat,
        commissionRate: commRate,
        amount,
        autoAmount: amount,
        autoFilled: true,
      })
    }
  }

  ctx.result = {
    isNewCustomer,
    beauticianInfo,
    deptAnomalous,
    beauticianRequired,
    orderSource: order.order_source,
    beautyRates,
    allocLines,
    items,
    totalAmount,
    rates,
  }
}

module.exports = { save, deleteAllocation, getCommissionRates, pendingList, suggest }
