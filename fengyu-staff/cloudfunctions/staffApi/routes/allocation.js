/**
 * 营业额分配模块路由（员工端）
 * allocation.save — 保存/更新提成分配（店长专用，支付后操作）
 * allocation.delete — 删除营业额分配记录（店长专用）
 * allocation.getCommissionRates — 获取提成比例矩阵
 * allocation.pendingList — 待分配订单列表（店长专用）
 * allocation.suggest — 获取分配建议
 *
 * sale_allocations 为扁平结构：每行 = 一条 sale_item + 一个员工的分配记录。
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireManager } = require('../middleware/auth')

/**
 * 保存提成分配（支付后分配）
 * payload: {
 *   saleOrderId: string,
 *   allocations: [{
 *     saleItemId: string,
 *     employeeId: string,
 *     departmentName: string,
 *     allocationRatio: number,
 *     totalAmount: number
 *   }]
 * }
 */
async function save(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId, allocations } = ctx.event.payload || {}

  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }
  if (!Array.isArray(allocations)) {
    throw new Error('INVALID_PARAMS: allocations 必须为数组')
  }

  // 查询订单
  const orders = await pg.query(
    'SELECT sale_order_id, status, allocation_status, store_id FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (order.status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可进行提成分配')
  }
  if (!['pending', 'allocated'].includes(order.allocation_status)) {
    throw new Error('PERMISSION_DENIED: 订单分配状态异常')
  }

  // 查询订单明细（用于校验 saleItemId 归属）
  const orderItems = await pg.query(
    'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
    [saleOrderId]
  )
  const validItemIds = new Set(orderItems.map(i => i.sale_item_id))

  // 空分配：标记为无需分配
  if (allocations.length === 0) {
    const now = new Date()
    await pg.transaction(async (client) => {
      // 删除原有分配记录
      const itemIds = orderItems.map(i => i.sale_item_id)
      if (itemIds.length > 0) {
        await client.query(
          'DELETE FROM sale_allocations WHERE sale_item_id = ANY($1) AND is_void = false',
          [itemIds]
        )
      }
      await client.query(
        "UPDATE sale_orders SET allocation_status = 'allocated', updated_at = $1 WHERE sale_order_id = $2",
        [now, saleOrderId]
      )
    })
    ctx.result = { saleOrderId, message: '已标记为无需分配', allocationCount: 0 }
    return
  }

  // 校验分配记录
  for (const alloc of allocations) {
    if (!alloc.saleItemId) {
      throw new Error('INVALID_PARAMS: 分配记录缺少 saleItemId')
    }
    if (!validItemIds.has(alloc.saleItemId)) {
      throw new Error(`INVALID_PARAMS: saleItemId ${alloc.saleItemId} 不属于该订单`)
    }
    if (!alloc.employeeId) {
      throw new Error('INVALID_PARAMS: 分配记录缺少 employeeId')
    }
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    // 删除原有的未作废分配记录
    const itemIds = orderItems.map(i => i.sale_item_id)
    if (itemIds.length > 0) {
      await client.query(
        'DELETE FROM sale_allocations WHERE sale_item_id = ANY($1) AND is_void = false',
        [itemIds]
      )
    }

    // 插入新的分配记录（扁平结构）
    for (const alloc of allocations) {
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, department_name, allocation_ratio, total_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, $6, $6)`,
        [
          alloc.saleItemId,
          alloc.employeeId,
          alloc.departmentName || null,
          alloc.allocationRatio != null ? alloc.allocationRatio : 1.0,
          Number(alloc.totalAmount) || 0,
          now
        ]
      )
    }

    // 更新订单分配状态
    await client.query(
      "UPDATE sale_orders SET allocation_status = 'allocated', updated_at = $1 WHERE sale_order_id = $2",
      [now, saleOrderId]
    )
  })

  ctx.result = {
    saleOrderId,
    message: '提成分配已保存',
    allocationCount: allocations.length
  }
}

/**
 * 删除营业额分配记录（重置为待分配状态）
 */
async function deleteAllocation(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId } = ctx.event.payload || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    'SELECT sale_order_id, status, allocation_status FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可操作分配')
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    const itemIds = await client.query(
      'SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1',
      [saleOrderId]
    )
    const ids = itemIds.rows.map(r => r.sale_item_id)
    if (ids.length > 0) {
      await client.query(
        'DELETE FROM sale_allocations WHERE sale_item_id = ANY($1) AND is_void = false',
        [ids]
      )
    }
    await client.query(
      "UPDATE sale_orders SET allocation_status = 'pending', updated_at = $1 WHERE sale_order_id = $2",
      [now, saleOrderId]
    )
  })

  ctx.result = {
    saleOrderId,
    message: '营业额分配已清除'
  }
}

/**
 * 获取提成比例矩阵（从 WorkFine UDT_S_1962 / UDT_M_1964）
 * 暂保留 WorkFine 查询（commission_rate_matrix 数据未确认）
 */
async function getCommissionRates(ctx) {
  await requireManager()(ctx, async () => {})

  const { marketName } = ctx.event.payload || {}
  if (!marketName) {
    throw new Error('INVALID_PARAMS: 缺少 marketName')
  }

  const pool = await mssql.getPool()

  const masterResult = await pool.request()
    .input('market', marketName)
    .query('SELECT RID FROM UDT_S_1962 WHERE UDF_S_18660 = @market')

  if (masterResult.recordset.length === 0) {
    throw new Error(`INVALID_PARAMS: 未找到市场 "${marketName}" 的提成配置`)
  }

  const rid = masterResult.recordset[0].RID

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
 */
async function pendingList(ctx) {
  await requireManager()(ctx, async () => {})

  const { page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const orders = await pg.query(`
    SELECT
      o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
      o.payment_method, o.paid_at, o.created_at, o.allocation_status,
      o.sale_order_source, o.preferred_employee_id, o.total_amount
    FROM sale_orders o
    WHERE o.store_id = $1
      AND o.status = '已支付'
      AND o.allocation_status = 'pending'
    ORDER BY o.paid_at DESC
    LIMIT $2 OFFSET $3
  `, [ctx.auth.storeId, pageSize, offset])

  ctx.result = { orders, page, pageSize }
}

/**
 * 查询员工部门归属（美容部/养生部判定）
 */
async function resolveStaffDepartment(staffWfId) {
  const rows = await pg.query(`
    SELECT
      u.employee_id, u.name,
      d.name AS department
    FROM staff_wechat_users u
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.employee_id = $1
  `, [staffWfId])

  if (rows.length === 0) return null

  const row = rows[0]
  const dept = (row.department || '').trim()
  const validDepts = ['美容部', '养生部']

  return {
    staffWfId: row.employee_id,
    name: (row.name || '').trim(),
    resolvedDept: validDepts.includes(dept) ? dept : null,
  }
}

/**
 * 检查是否为新顾客
 */
async function checkNewCustomer(clientPhone, currentSaleOrderId) {
  if (!clientPhone) return false
  const rows = await pg.query(
    "SELECT COUNT(*)::int AS cnt FROM sale_orders WHERE client_phone = $1 AND status = '已支付' AND sale_order_id != $2",
    [clientPhone, currentSaleOrderId]
  )
  return rows[0].cnt === 0
}

/**
 * 获取分配建议
 */
async function suggest(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId } = ctx.event.payload || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  // 1. 加载订单
  const orders = await pg.query(
    `SELECT sale_order_id, status, allocation_status, store_id, market_name,
            sale_order_source, preferred_employee_id, client_phone, customer_name
     FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2`,
    [saleOrderId, ctx.auth.storeId]
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
  const isNewCustomer = await checkNewCustomer(order.client_phone, saleOrderId)

  const beauticianRequired = false

  // 5. 加载订单项
  const items = await pg.query(`
    SELECT si.sale_item_id, si.received, si.sales_category,
           si.product_name, si.sku_spec_name, si.product_type
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  const totalAmount = items.reduce((s, i) => s + Number(i.received || 0), 0)

  // 6. 加载提成比例（暂保留 WorkFine 查询）
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

  // 7. 提取美容部/养生部提成比例
  const beautyDepts = ['美容部', '养生部']
  const beautyRates = {}
  for (const rate of rates) {
    if (beautyDepts.includes(rate.department) && !beautyRates[rate.department]) {
      beautyRates[rate.department] = rate.orderRates
    }
  }

  // 8. 生成分配行
  const allocLines = []
  if (beauticianInfo && beauticianInfo.resolvedDept && beautyRates[beauticianInfo.resolvedDept]) {
    const dept = beauticianInfo.resolvedDept
    for (const item of items) {
      const salesCat = item.sales_category || '自采自销'
      const received = Number(item.received) || 0
      const commRate = beautyRates[dept][salesCat] || 0
      const amount = (received * commRate).toFixed(2)
      allocLines.push({
        saleItemId: item.sale_item_id,
        departmentName: dept,
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
    orderSource: order.sale_order_source,
    beautyRates,
    allocLines,
    items,
    totalAmount,
    rates,
  }
}

module.exports = { save, deleteAllocation, getCommissionRates, pendingList, suggest }
