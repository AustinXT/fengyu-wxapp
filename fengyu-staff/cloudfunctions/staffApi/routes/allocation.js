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
const { logOperation } = require('../utils/operation-log')

// P2-14 Q5: skillTags 驱动的业绩分配校验
// 每池 = (saleItemId, roleType) 二元组，池间互不约束
const VALID_RATIOS = new Set(['0.10','0.20','0.30','0.40','0.50','0.60','0.70','0.80','0.90','1.00'])
const MAX_PER_POOL = 3
const AMOUNT_TOLERANCE = 0.02 // 整十档 × 浮点舍入的容差

// 营业额口径白名单：仅「销售单」「转换单」产生营业额、参与销售提成分配。
// 寄存单/充值单/内部单不计营业额（与 dashboard / staff.js / mgmt-dashboard.js 口径一致）。
const ALLOCATABLE_ORDER_TYPES = ['销售单', '转换单']

// 分配冻结窗口：订单支付（paid_at）超过 N 天后，店长端禁止再修改分配（admin 后台不受限）
const FREEZE_DAYS = 3

// 是否已过冻结窗口（anchor 为支付时刻；为空则保守放行）
function isFrozen(anchor) {
  if (!anchor) return false
  return Date.now() - new Date(anchor).getTime() > FREEZE_DAYS * 86400000
}

/**
 * 构造销售提成率查找器（销售提成固化快照用）。
 *
 * 一次性加载该市场「销售单」的 commission_rate_matrix，返回 (role, salesCat, amount) => rate。
 * 口径与 suggest 的 lookupTierRate 完全一致：amountMin <= amount <= amountMax，多 tier 命中取
 * amountMin 最大者（高 tier 优先），跳过 rate<=0 的 grouped 项；market 为空 / 无配置 → 恒返回 0。
 * amount（tier 基准）应传订单级 received 合计，与 suggest 一致。
 *
 * 跨端约定（no-shared-cloudfunctions）：admin allocations.ts / payNotify 各保留同语义独立副本。
 */
async function buildSalesRateLookup(marketName) {
  if (!marketName) return () => 0

  const rateRows = await pg.query(`
    SELECT crm.role_type, crm.sales_category,
           crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
    FROM commission_rate_matrix crm
    JOIN org_nodes n ON n.id = crm.org_id
    WHERE n.name = $1 AND crm.order_type = '销售单'
    ORDER BY crm.role_type, crm.amount_tier_min
  `, [marketName])

  const grouped = []
  const byKey = new Map()
  for (const r of rateRows) {
    const dept = (r.role_type || '').trim()
    const key = `${dept}|${r.amount_tier_min}|${r.amount_tier_max}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        department: dept,
        amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
        amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
        orderRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
      }
      byKey.set(key, entry)
      grouped.push(entry)
    }
    entry.orderRates[r.sales_category] = Number(r.commission_rate) || 0
  }

  return function lookup(role, salesCat, amount) {
    let hit = null
    for (const r of grouped) {
      if (r.department !== role) continue
      if (amount < r.amountMin || amount > r.amountMax) continue
      const rate = r.orderRates[salesCat]
      if (!rate || rate <= 0) continue
      if (!hit || r.amountMin > hit.amountMin) hit = r
    }
    return (hit && hit.orderRates[salesCat]) || 0
  }
}

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
    'SELECT sale_order_id, status, allocation_status, store_id, market_name, paid_at, sale_order_type FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [saleOrderId, ctx.auth.effectiveStoreId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (!ALLOCATABLE_ORDER_TYPES.includes(order.sale_order_type)) {
    throw new Error('INVALID_STATE: ORDER_TYPE_NOT_ALLOCATABLE: 该订单类型不参与营业额分配')
  }
  if (order.status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可进行提成分配')
  }
  if (!['待分配', '已分配'].includes(order.allocation_status)) {
    throw new Error('PERMISSION_DENIED: 订单分配状态异常')
  }
  // 支付超 FREEZE_DAYS 天后冻结分配结果（含清空场景；admin 后台不受此限）
  if (isFrozen(order.paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，订单支付超过 ${FREEZE_DAYS} 天不可修改`)
  }

  // 查询订单明细（用于校验 saleItemId 归属 + 服务端重算 totalAmount + 提成率查找）
  const orderItems = await pg.query(
    'SELECT sale_item_id, received, sales_category FROM sale_items WHERE sale_order_id = $1',
    [saleOrderId]
  )
  const validItemIds = new Set(orderItems.map(i => i.sale_item_id))
  const receivedMap = new Map(orderItems.map(i => [i.sale_item_id, Number(i.received) || 0]))
  const salesCategoryMap = new Map(orderItems.map(i => [i.sale_item_id, i.sales_category || '自销自耗']))
  // tier 基准 = 订单级 received 合计（与 suggest.lookupTierRate 一致）
  const orderTotalReceived = orderItems.reduce((s, i) => s + (Number(i.received) || 0), 0)
  const rateLookup = await buildSalesRateLookup(order.market_name)

  // 空分配：标记为无需分配
  if (allocations.length === 0) {
    const now = new Date()
    await pg.transaction(async (client) => {
      // 删除原有分配记录
      const itemIds = orderItems.map(i => i.sale_item_id)
      if (itemIds.length > 0) {
        // 2026-04-26 D-Q8 落地：硬 DELETE → 软删除（保留历史业绩快照可追溯）
        await client.query(
          `UPDATE sale_allocations
              SET is_void = true, voided_at = NOW(), updated_at = NOW()
            WHERE sale_item_id = ANY($1) AND is_void = false`,
          [itemIds]
        )
      }
      const upd = await client.query(
        "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status IN ('待分配', '已分配')",
        [now, saleOrderId]
      )
      if (upd.rowCount === 0) {
        throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:allocation_status→已分配`)
      }
      // 审计日志
      await logOperation(client, ctx, 'allocation.save', 'sale_order', saleOrderId, {
        _v: 3,
        allocationCount: 0,
        note: '标记为无需分配',
      })
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
    // 销售提成固化快照：rate = 市场×角色×销售类别×订单级金额档位命中费率；提成额 = 份额 × 费率
    const salesCategory = salesCategoryMap.get(alloc.saleItemId) || '自销自耗'
    const commissionRate = rateLookup(alloc.roleType, salesCategory, orderTotalReceived)
    const commissionAmount = Math.round(totalAmount * commissionRate * 100) / 100
    enriched.push({
      saleItemId: alloc.saleItemId,
      employeeId: alloc.employeeId,
      roleType: alloc.roleType,
      departmentName: alloc.departmentName || null,
      allocationRatio: ratioStr,
      totalAmount,
      commissionRate,
      commissionAmount,
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
    // 2026-04-26 D-Q8 落地：硬 DELETE → 软删除
    const itemIds = orderItems.map(i => i.sale_item_id)
    if (itemIds.length > 0) {
      await client.query(
        `UPDATE sale_allocations
            SET is_void = true, voided_at = NOW(), updated_at = NOW()
          WHERE sale_item_id = ANY($1) AND is_void = false`,
        [itemIds]
      )
    }

    // 插入新的分配记录（扁平结构，写入 role_type 列 + 销售提成固化快照）
    for (const alloc of enriched) {
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, role_type, department_name, allocation_ratio, total_amount, commission_rate, commission_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $9)`,
        [
          alloc.saleItemId,
          alloc.employeeId,
          alloc.roleType,
          alloc.departmentName,
          alloc.allocationRatio,
          alloc.totalAmount,
          alloc.commissionRate,
          alloc.commissionAmount,
          now
        ]
      )
    }

    // 更新订单分配状态
    const upd = await client.query(
      "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status IN ('待分配', '已分配')",
      [now, saleOrderId]
    )
    if (upd.rowCount === 0) {
      throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:allocation_status→已分配`)
    }
    // 审计日志
    await logOperation(client, ctx, 'allocation.save', 'sale_order', saleOrderId, {
      _v: 3,
      allocationCount: enriched.length,
      totalAmount: Math.round(enriched.reduce((s, a) => s + a.totalAmount, 0) * 100) / 100,
    })
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
    'SELECT sale_order_id, status, allocation_status, paid_at FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [saleOrderId, ctx.auth.effectiveStoreId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '已支付') {
    throw new Error('PERMISSION_DENIED: 仅已支付订单可操作分配')
  }
  // 支付超 FREEZE_DAYS 天后冻结分配结果（admin 后台不受此限）
  if (isFrozen(orders[0].paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，订单支付超过 ${FREEZE_DAYS} 天不可修改`)
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    const itemIds = await client.query(
      'SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1',
      [saleOrderId]
    )
    const ids = itemIds.rows.map(r => r.sale_item_id)
    if (ids.length > 0) {
      // 2026-04-26 D-Q8 落地：硬 DELETE → 软删除
      await client.query(
        `UPDATE sale_allocations
            SET is_void = true, voided_at = NOW(), updated_at = NOW()
          WHERE sale_item_id = ANY($1) AND is_void = false`,
        [ids]
      )
    }
    const upd = await client.query(
      "UPDATE sale_orders SET allocation_status = '待分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status = '已分配'",
      [now, saleOrderId]
    )
    if (upd.rowCount === 0) {
      throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:allocation_status→待分配`)
    }
    // 审计日志
    await logOperation(client, ctx, 'allocation.delete', 'sale_order', saleOrderId, { _v: 3 })
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
 * 销售提成订单列表（店长专用）
 * allocationStatus 默认「待分配」，支持「已分配」用于「营业额分配」页状态切换。
 */
async function pendingList(ctx) {
  await requireManager()(ctx, async () => {})

  const { page = 1, pageSize = 20, allocationStatus = '待分配' } = ctx.event.payload || {}
  if (!['待分配', '已分配'].includes(allocationStatus)) {
    throw new Error('INVALID_PARAMS: allocationStatus 必须为 待分配 或 已分配')
  }
  const offset = (page - 1) * pageSize

  const orders = await pg.query(`
    SELECT
      o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
      o.payment_method, o.paid_at, o.created_at, o.allocation_status,
      o.preferred_employee_id, o.total_amount
    FROM sale_orders o
    WHERE o.store_id = $1
      AND o.status = '已支付'
      AND o.allocation_status = $2
      AND o.sale_order_type IN ('销售单', '转换单')
      AND o.legacy_source IS DISTINCT FROM 'workfine'
    ORDER BY o.paid_at DESC
    LIMIT $3 OFFSET $4
  `, [ctx.auth.effectiveStoreId, allocationStatus, pageSize, offset])

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
            preferred_employee_id, client_phone, customer_name, paid_at, sale_order_type
     FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2`,
    [saleOrderId, ctx.auth.effectiveStoreId]
  )
  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }
  const order = orders[0]

  if (!ALLOCATABLE_ORDER_TYPES.includes(order.sale_order_type)) {
    throw new Error('INVALID_STATE: ORDER_TYPE_NOT_ALLOCATABLE: 该订单类型不参与营业额分配')
  }

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

  // 7. tier-aware 提成比例查找：按 (role, salesCat, totalAmount) 命中 tier 区间
  // 规则：amountMin <= totalAmount <= amountMax；多 tier 命中时取 amountMin 最大者（高 tier 优先），
  //       与 service.complete 的 `ORDER BY amount_tier_min DESC LIMIT 1` 语义一致。
  // 注意：rates 是 pivot 后的 grouped 结构，每个 grouped 项的 orderRates 含全部 4 个 sales_category 占位
  //      （未配的为 0）。需跳过 orderRates[salesCat]==0 的 grouped 项，避免同 amountMin 多 grouped 项
  //      中误选未配该 sales_category 的那条。
  function lookupTierRate(role, salesCat, amount) {
    let hit = null
    for (const r of rates) {
      if (r.department !== role) continue
      if (amount < r.amountMin || amount > r.amountMax) continue
      const rate = r.orderRates[salesCat]
      if (!rate || rate <= 0) continue
      if (!hit || r.amountMin > hit.amountMin) hit = r
    }
    return (hit && hit.orderRates[salesCat]) || 0
  }

  // 向后兼容字段：ratesByRole 仍以 role 为键暴露首 tier 的 orderRates（前端老版本可能依赖）。
  // 新代码（含本文件 allocLines 生成）走 lookupTierRate；前端 allocation-calc 已切到 rates 数组。
  const ratesByRole = {}
  for (const rate of rates) {
    if (!ratesByRole[rate.department]) {
      ratesByRole[rate.department] = rate.orderRates
    }
  }

  // 8. 生成分配行：对每个 (item × skill) 生成一条 allocLine，roleType 必填
  // 新流程（技能→员工→比例）：预建行只携带 roleType + 指定员工 + 默认 100% 分配比例，
  // 金额由前端按 (实收 × 分配比例) 计算，不再下发以「提成额」为值的 amount。
  const allocLines = []
  if (beauticianInfo && beauticianInfo.skills.length > 0) {
    for (const item of items) {
      const salesCat = item.sales_category || '自销自耗'
      for (const role of beauticianInfo.skills) {
        const commRate = lookupTierRate(role, salesCat, totalAmount)
        allocLines.push({
          saleItemId: item.sale_item_id,
          roleType: role,        // P2-14：必填
          departmentName: null,  // deprecated (PR-4)：保留字段兼容前端展示，值不再由服务端填
          staffWfId: beauticianInfo.staffWfId,
          staffName: beauticianInfo.name,
          salesCategory: salesCat,
          commissionRate: commRate,
          allocationRatio: 1.00, // 默认 100%，店长可下调
          autoFilled: true,
        })
      }
    }
  }

  // 9. 候选员工（admin 式按技能筛选用）：订单所属市场内全部在职员工，含 store_id / skills。
  //    前端按规则筛选：美容师 → 订单所属门店；养生师/推广师 → 市场内任意门店。
  //    品项老师特例：可跨门店/跨市场选全公司任意品项老师，故 WHERE 额外 OR 拥有该技能者（不限市场）。
  //    本 action 已 requireManager() 门控，与 admin 让分配人看到市场级员工口径一致。
  let candidateEmployees = []
  if (order.market_name) {
    const empRows = await pg.query(`
      SELECT u.employee_id, u.name, u.store_id, u.skills,
             d.name AS department, s.store_name
      FROM staff_wechat_users u
      LEFT JOIN stores s ON u.store_id = s.store_id
      LEFT JOIN org_nodes so ON s.org_node_id = so.id
      LEFT JOIN org_nodes m  ON so.parent_id = m.id
      LEFT JOIN org_nodes d  ON u.org_node_id = d.id
      WHERE u.is_resigned = false
        AND (m.name = $1 OR '品项老师' = ANY(u.skills))
        AND u.employee_id IS NOT NULL
      ORDER BY u.name
    `, [order.market_name])
    candidateEmployees = empRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      storeId: r.store_id || '',
      storeName: r.store_name || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      department: r.department || '',
    }))
  }

  ctx.result = {
    isNewCustomer,
    beauticianInfo,     // P2-14：现含 skills 字段（替代 resolvedDept）
    deptAnomalous,      // 向后兼容：员工无 skills 时为 true
    beauticianRequired, // 向后兼容：员工有可用 skills 时为 true
    ratesByRole,        // P2-14：以 role_type 为键的提成比例索引（替代 beautyRates）
    allocLines,         // 每条含 roleType（P2-14 必填）+ 默认 allocationRatio
    candidateEmployees, // admin 式按技能筛选的候选员工（市场内）
    orderStoreId: order.store_id,
    items,
    totalAmount,
    rates,
    frozen: isFrozen(order.paid_at), // 支付超 FREEZE_DAYS 天，前端据此禁用保存
  }
}

module.exports = { save, deleteAllocation, getCommissionRates, pendingList, suggest }
