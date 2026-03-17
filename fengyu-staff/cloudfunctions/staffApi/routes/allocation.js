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
const { requireManager } = require('../middleware/auth')

// role_type 直接作为 department（数据层面存 '美容部'/'养生部'/'推广' 等值）

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
 * 获取提成比例矩阵（PG commission_rate_matrix）
 * 运行时 100% PG，零 MSSQL 依赖。
 */
async function getCommissionRates(ctx) {
  await requireManager()(ctx, async () => {})

  const { marketName } = ctx.event.payload || {}
  if (!marketName) {
    throw new Error('INVALID_PARAMS: 缺少 marketName')
  }

  const rows = await pg.query(`
    SELECT crm.role_type, crm.order_type, crm.sales_category,
           crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
    FROM commission_rate_matrix crm
    JOIN org_nodes n ON n.id = crm.org_id
    WHERE n.name = $1
    ORDER BY crm.role_type, crm.amount_tier_min
  `, [marketName])

  if (rows.length === 0) {
    throw new Error(`INVALID_PARAMS: 未找到市场 "${marketName}" 的提成配置`)
  }

  // 将扁平行 pivot 为按 (role_type, amount_tier) 分组的结构
  const grouped = new Map()
  for (const r of rows) {
    const dept = (r.role_type || '').trim()
    const key = `${dept}|${r.amount_tier_min}|${r.amount_tier_max}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        department: dept,
        amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
        amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
        orderRates: { '自采自销': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        serviceRates: { '自采自销': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
      })
    }
    const entry = grouped.get(key)
    const rate = Number(r.commission_rate) || 0
    if (r.order_type === 'sale') entry.orderRates[r.sales_category] = rate
    else if (r.order_type === 'service') entry.serviceRates[r.sales_category] = rate
  }

  ctx.result = { rates: [...grouped.values()] }
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

  // 6. 加载提成比例（PG commission_rate_matrix，仅 sale 类型用于分配建议）
  let rates = []
  if (order.market_name) {
    const rateRows = await pg.query(`
      SELECT crm.role_type, crm.sales_category,
             crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
      FROM commission_rate_matrix crm
      JOIN org_nodes n ON n.id = crm.org_id
      WHERE n.name = $1 AND crm.order_type = 'sale'
      ORDER BY crm.role_type, crm.amount_tier_min
    `, [order.market_name])

    const grouped = new Map()
    for (const r of rateRows) {
      const dept = (r.role_type || '').trim()
      const key = `${dept}|${r.amount_tier_min}|${r.amount_tier_max}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          department: dept,
          amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
          amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
          orderRates: { '自采自销': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        })
      }
      grouped.get(key).orderRates[r.sales_category] = Number(r.commission_rate) || 0
    }
    rates = [...grouped.values()]
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
