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

// P2-14 Q5: skillTags 驱动的业绩分配校验
// 每池 = (saleItemId, roleType) 二元组，池间互不约束
const VALID_RATIOS = new Set(['0.10','0.20','0.30','0.40','0.50','0.60','0.70','0.80','0.90','1.00'])
const MAX_PER_POOL = 3
const AMOUNT_TOLERANCE = 0.02 // 整十档 × 浮点舍入的容差

/**
 * 保存提成分配（支付后分配）
 *
 * P2-14 Q5: roleType 字段改为 required，按 (saleItemId, roleType) 分池独立校验；
 * totalAmount 在服务端由 received × allocationRatio 重算，忽略前端传入值（防篡改）。
 *
 * payload: {
 *   saleOrderId: string,
 *   allocations: [{
 *     saleItemId: string,
 *     employeeId: string,
 *     roleType: string,           // required (P2-14)
 *     departmentName?: string,    // 仅用于 DB 向后兼容展示，不参与角色推断
 *     allocationRatio: number,    // 整十档 0.10~1.00
 *     totalAmount?: number        // ignored，服务端重算
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
    [saleOrderId, ctx.auth.effectiveStoreId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (order.status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可进行提成分配')
  }
  if (!['待分配', '已分配'].includes(order.allocation_status)) {
    throw new Error('PERMISSION_DENIED: 订单分配状态异常')
  }

  // 查询订单明细（用于校验 saleItemId 归属 + 服务端重算 totalAmount）
  const orderItems = await pg.query(
    'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
    [saleOrderId]
  )
  const validItemIds = new Set(orderItems.map(i => i.sale_item_id))
  const receivedMap = new Map(orderItems.map(i => [i.sale_item_id, Number(i.received) || 0]))

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
        "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2",
        [now, saleOrderId]
      )
    })
    ctx.result = { saleOrderId, message: '已标记为无需分配', allocationCount: 0 }
    return
  }

  // 校验 + 服务端重算 totalAmount
  const enriched = []
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
    if (!alloc.roleType) {
      throw new Error('INVALID_PARAMS: 分配记录缺少 roleType')
    }
    const ratioStr = Number(alloc.allocationRatio).toFixed(2)
    if (!VALID_RATIOS.has(ratioStr)) {
      throw new Error('INVALID_PARAMS: allocationRatio 必须为整十百分比（0.10~1.00）')
    }
    const received = receivedMap.get(alloc.saleItemId) || 0
    const totalAmount = Math.round(received * Number(ratioStr) * 100) / 100
    enriched.push({
      saleItemId: alloc.saleItemId,
      employeeId: alloc.employeeId,
      roleType: alloc.roleType,
      departmentName: alloc.departmentName || null,
      allocationRatio: ratioStr,
      totalAmount,
    })
  }

  // 按 (saleItemId, roleType) 分池校验
  const pools = new Map()
  for (const a of enriched) {
    const key = `${a.saleItemId}|${a.roleType}`
    if (!pools.has(key)) pools.set(key, [])
    pools.get(key).push(a)
  }
  for (const [key, pool] of pools) {
    const saleItemId = key.split('|')[0]
    if (pool.length > MAX_PER_POOL) {
      throw new Error(`INVALID_PARAMS: 每个商品每个技能标签最多分配 ${MAX_PER_POOL} 人`)
    }
    const received = receivedMap.get(saleItemId) || 0
    const sum = pool.reduce((s, a) => s + a.totalAmount, 0)
    if (sum > received + AMOUNT_TOLERANCE) {
      throw new Error('INVALID_PARAMS: 分配金额合计超过商品金额')
    }
    const empIds = new Set()
    for (const a of pool) {
      if (empIds.has(a.employeeId)) {
        throw new Error('INVALID_PARAMS: 同商品同技能标签不能重复分配同一员工')
      }
      empIds.add(a.employeeId)
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

    // 插入新的分配记录（扁平结构，写入 role_type 列）
    for (const alloc of enriched) {
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, role_type, department_name, allocation_ratio, total_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $7)`,
        [
          alloc.saleItemId,
          alloc.employeeId,
          alloc.roleType,
          alloc.departmentName,
          alloc.allocationRatio,
          alloc.totalAmount,
          now
        ]
      )
    }

    // 更新订单分配状态
    await client.query(
      "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2",
      [now, saleOrderId]
    )
  })

  ctx.result = {
    saleOrderId,
    message: '提成分配已保存',
    allocationCount: enriched.length
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
    [saleOrderId, ctx.auth.effectiveStoreId]
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
      "UPDATE sale_orders SET allocation_status = '待分配', updated_at = $1 WHERE sale_order_id = $2",
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
        orderRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        serviceRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
      })
    }
    const entry = grouped.get(key)
    const rate = Number(r.commission_rate) || 0
    if (r.order_type === '销售单') entry.orderRates[r.sales_category] = rate
    else if (r.order_type === '服务单') entry.serviceRates[r.sales_category] = rate
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
      o.preferred_employee_id, o.total_amount
    FROM sale_orders o
    WHERE o.store_id = $1
      AND o.status = '已支付'
      AND o.allocation_status = '待分配'
    ORDER BY o.paid_at DESC
    LIMIT $2 OFFSET $3
  `, [ctx.auth.effectiveStoreId, pageSize, offset])

  ctx.result = { orders, page, pageSize }
}

/**
 * 查询员工技能标签（P2-14 Q5）
 * 返回 skills 数组，由 suggest 按每个 skill 生成独立 allocLine。
 */
async function resolveStaffRoles(staffWfId) {
  const rows = await pg.query(
    'SELECT employee_id, name, skills FROM staff_wechat_users WHERE employee_id = $1',
    [staffWfId]
  )

  if (rows.length === 0) return null

  const row = rows[0]
  return {
    staffWfId: row.employee_id,
    name: (row.name || '').trim(),
    skills: Array.isArray(row.skills) ? row.skills : [],
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
            preferred_employee_id, client_phone, customer_name
     FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2`,
    [saleOrderId, ctx.auth.effectiveStoreId]
  )
  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }
  const order = orders[0]

  // 2. 解析指定员工（P2-14 Q5：按 skills 建议角色池）
  let beauticianInfo = null
  let deptAnomalous = false // 向后兼容字段：空 skills 时为 true
  if (order.preferred_employee_id) {
    beauticianInfo = await resolveStaffRoles(order.preferred_employee_id)
    if (beauticianInfo && beauticianInfo.skills.length === 0) {
      deptAnomalous = true
    }
  }

  // 3. 检查新顾客
  const isNewCustomer = await checkNewCustomer(order.client_phone, saleOrderId)

  // 向后兼容字段：保留 beauticianRequired，语义改为"员工有可用 skills"
  const beauticianRequired = !!(beauticianInfo && beauticianInfo.skills.length > 0)

  // 5. 加载订单项
  const items = await pg.query(`
    SELECT si.sale_item_id, si.received, si.sales_category,
           si.product_name, si.sku_spec_name, si.product_type
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  const totalAmount = items.reduce((s, i) => s + Number(i.received || 0), 0)

  // 6. 加载提成比例（PG commission_rate_matrix，仅销售单用于分配建议）
  let rates = []
  if (order.market_name) {
    const rateRows = await pg.query(`
      SELECT crm.role_type, crm.sales_category,
             crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
      FROM commission_rate_matrix crm
      JOIN org_nodes n ON n.id = crm.org_id
      WHERE n.name = $1 AND crm.order_type = '销售单'
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
          orderRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        })
      }
      grouped.get(key).orderRates[r.sales_category] = Number(r.commission_rate) || 0
    }
    rates = [...grouped.values()]
  }

  // 7. 按 role_type 索引提成比例（P2-14：三角色均纳入，不再过滤白名单）
  const ratesByRole = {}
  for (const rate of rates) {
    if (!ratesByRole[rate.department]) {
      ratesByRole[rate.department] = rate.orderRates
    }
  }

  // 8. 生成分配行：对每个 (item × skill) 生成一条 allocLine，roleType 必填
  const allocLines = []
  if (beauticianInfo && beauticianInfo.skills.length > 0) {
    for (const item of items) {
      const salesCat = item.sales_category || '自销自耗'
      const received = Number(item.received) || 0
      for (const role of beauticianInfo.skills) {
        const commRate = (ratesByRole[role] && ratesByRole[role][salesCat]) || 0
        const amount = (received * commRate).toFixed(2)
        allocLines.push({
          saleItemId: item.sale_item_id,
          roleType: role,        // P2-14：必填
          departmentName: null,  // deprecated (PR-4)：保留字段兼容前端展示，值不再由服务端填
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
  }

  ctx.result = {
    isNewCustomer,
    beauticianInfo,     // P2-14：现含 skills 字段（替代 resolvedDept）
    deptAnomalous,      // 向后兼容：员工无 skills 时为 true
    beauticianRequired, // 向后兼容：员工有可用 skills 时为 true
    ratesByRole,        // P2-14：以 role_type 为键的提成比例索引（替代 beautyRates）
    allocLines,         // 每条含 roleType（P2-14 必填）
    items,
    totalAmount,
    rates,
  }
}

module.exports = { save, deleteAllocation, getCommissionRates, pendingList, suggest }
