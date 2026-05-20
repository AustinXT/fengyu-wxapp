/**
 * 服务提成模块路由（员工端）—— 对齐 admin /allocations 服务提成 Tab
 * serviceCommission.pendingList — 服务提成订单列表（店长专用，已完成服务单）
 * serviceCommission.detail      — 服务单提成详情（明细 + 已有分配 + 服务单提成比例矩阵）
 * serviceCommission.save        — 保存/重分配服务提成（店长专用，按 ratio 拆分）
 *
 * 提成公式（与员工端 service.complete + admin batchSave 修正后一致，按 ratio 拆分）：
 *   consumeBase   = round(unit_real_price × session_used, 2)           // unit_real_price 已是 per-session 单次价
 *   consumeAmount = round(consumeBase × allocation_ratio × rate, 2)
 *   fixedFee      = round(service_fee × session_used × allocation_ratio, 2)
 *   commissionAmount = round(fixedFee + consumeAmount, 2)
 * rate 命中 tier 用整池 consumeBase（不乘 ratio），且 commission_rate_matrix 不按 market 过滤
 * （与 service.complete 一致，依赖 (order_type, role_type, sales_category, tier) 唯一性）。
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')

// 与 allocation.js 同源校验范式：每池 = (serviceItemId, roleType)，池间互不约束
const VALID_RATIOS = new Set(['0.10','0.20','0.30','0.40','0.50','0.60','0.70','0.80','0.90','1.00'])
const MAX_PER_POOL = 3

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

/**
 * 服务提成订单列表（店长专用）
 * commissionStatus 默认「待分配」，支持「已分配」用于「营业额分配」页状态切换。
 */
async function pendingList(ctx) {
  await requireManager()(ctx, async () => {})

  const { page = 1, pageSize = 20, commissionStatus = '待分配' } = ctx.event.payload || {}
  if (!['待分配', '已分配'].includes(commissionStatus)) {
    throw new Error('INVALID_PARAMS: commissionStatus 必须为 待分配 或 已分配')
  }
  const offset = (page - 1) * pageSize

  const orders = await pg.query(`
    SELECT
      so.service_order_id, so.status, so.service_date, so.commission_status,
      so.assigned_employee_id, so.client_user_id,
      cu.name AS customer_name, cu.phone AS client_phone,
      swu.name AS employee_name
    FROM service_orders so
    LEFT JOIN client_wechat_users cu ON so.client_user_id = cu.user_id
    LEFT JOIN staff_wechat_users swu ON so.assigned_employee_id = swu.employee_id
    WHERE so.store_id = $1
      AND so.status = '已完成'
      AND so.commission_status = $2
    ORDER BY so.service_date DESC, so.updated_at DESC
    LIMIT $3 OFFSET $4
  `, [ctx.auth.effectiveStoreId, commissionStatus, pageSize, offset])

  ctx.result = { orders, page, pageSize }
}

/**
 * 服务单提成详情
 * payload: { serviceOrderId }
 * 返回 { order, items, commissions, rates }
 */
async function detail(ctx) {
  await requireManager()(ctx, async () => {})

  const { serviceOrderId } = ctx.event.payload || {}
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  // 1. 服务单（scope 校验：限本门店）
  const orders = await pg.query(`
    SELECT so.service_order_id, so.status, so.service_date, so.market_name, so.store_id,
           so.commission_status, so.client_user_id, so.assigned_employee_id,
           cu.name AS customer_name,
           swu.name AS employee_name
    FROM service_orders so
    LEFT JOIN client_wechat_users cu ON so.client_user_id = cu.user_id
    LEFT JOIN staff_wechat_users swu ON so.assigned_employee_id = swu.employee_id
    WHERE so.service_order_id = $1 AND so.store_id = $2
  `, [serviceOrderId, ctx.auth.effectiveStoreId])
  if (orders.length === 0) {
    throw new Error('NOT_FOUND: 服务单不存在或不属于本门店')
  }
  const order = orders[0]

  // 2. 服务明细 ⋈ sale_items（含定价快照）
  const items = await pg.query(`
    SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.unit_real_price,
           sit.sales_category, sit.employee_id,
           si.service_fee, si.session_count, si.quantity,
           si.product_name, si.sku_spec_name
    FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE sit.service_order_id = $1
    ORDER BY sit.service_item_id
  `, [serviceOrderId])

  // 3. 已有非 void 提成记录（已分配回填用）
  const commissions = await pg.query(`
    SELECT sc.service_item_id, sc.employee_id, sc.role_type, sc.allocation_ratio,
           sc.commission_rate, sc.fixed_fee, sc.consume_amount, sc.commission_amount,
           swu.name AS employee_name
    FROM service_commissions sc
    LEFT JOIN staff_wechat_users swu ON sc.employee_id = swu.employee_id
    WHERE sc.service_item_id IN (
      SELECT service_item_id FROM service_items WHERE service_order_id = $1
    ) AND sc.is_void = false
  `, [serviceOrderId])

  // 4. 服务单提成比例矩阵（按 market pivot，仅 serviceRates）
  let rates = []
  if (order.market_name) {
    const rateRows = await pg.query(`
      SELECT crm.role_type, crm.sales_category,
             crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
      FROM commission_rate_matrix crm
      JOIN org_nodes n ON n.id = crm.org_id
      WHERE n.name = $1 AND crm.order_type = '服务单'
      ORDER BY crm.role_type, crm.amount_tier_min
    `, [order.market_name])

    const grouped = new Map()
    for (const r of rateRows) {
      const role = (r.role_type || '').trim()
      const key = `${role}|${r.amount_tier_min}|${r.amount_tier_max}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          department: role,
          amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
          amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
          serviceRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        })
      }
      grouped.get(key).serviceRates[r.sales_category] = Number(r.commission_rate) || 0
    }
    rates = [...grouped.values()]
  }

  // 5. 候选员工（admin 式按技能筛选用）：订单所属市场内全部在职员工，含 store_id / skills。
  //    前端按规则筛选：美容师 → 服务单所属门店；养生师/推广师 → 市场内任意门店。
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
        AND m.name = $1
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

  ctx.result = { order, items, commissions, rates, candidateEmployees, orderStoreId: order.store_id }
}

/**
 * 保存/重分配服务提成（店长专用）
 * payload: {
 *   serviceOrderId: string,
 *   commissions: [{ serviceItemId, employeeId, roleType, allocationRatio }]
 * }
 * commissionRate/commissionAmount 由服务端重算，忽略前端传入值（防篡改）。
 */
async function save(ctx) {
  await requireManager()(ctx, async () => {})

  const { serviceOrderId, commissions } = ctx.event.payload || {}
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }
  if (!Array.isArray(commissions)) {
    throw new Error('INVALID_PARAMS: commissions 必须为数组')
  }

  // 服务单 scope + 状态校验
  const orders = await pg.query(
    'SELECT service_order_id, status, commission_status FROM service_orders WHERE service_order_id = $1 AND store_id = $2',
    [serviceOrderId, ctx.auth.effectiveStoreId]
  )
  if (orders.length === 0) {
    throw new Error('NOT_FOUND: 服务单不存在或不属于本门店')
  }
  const order = orders[0]
  if (order.status !== '已完成') {
    throw new Error('INVALID_STATE: 仅已完成服务单可分配提成')
  }
  if (!['待分配', '已分配'].includes(order.commission_status)) {
    throw new Error('INVALID_STATE: 服务单提成状态异常')
  }

  // 加载服务明细定价（校验归属 + 重算）
  const itemRows = await pg.query(`
    SELECT sit.service_item_id, sit.session_used, sit.unit_real_price, sit.sales_category,
           si.service_fee, si.session_count, si.quantity
    FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE sit.service_order_id = $1
  `, [serviceOrderId])
  const pricingMap = new Map(itemRows.map(r => [r.service_item_id, r]))

  // 空数组：清空提成 → 待分配
  if (commissions.length === 0) {
    await pg.transaction(async (client) => {
      await client.query(
        `UPDATE service_commissions SET is_void = true, voided_at = NOW(), updated_at = NOW()
         WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id = $1)
           AND is_void = false`,
        [serviceOrderId]
      )
      const upd = await client.query(
        "UPDATE service_orders SET commission_status = '待分配', updated_at = NOW() WHERE service_order_id = $1 AND commission_status IN ('待分配', '已分配')",
        [serviceOrderId]
      )
      if (upd.rowCount === 0) {
        throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:service_orders:${serviceOrderId}:commission_status→待分配`)
      }
    })
    ctx.result = { serviceOrderId, message: '已清空提成分配', commissionCount: 0 }
    return
  }

  // 校验入参 + 分池
  for (const c of commissions) {
    if (!c.serviceItemId) throw new Error('INVALID_PARAMS: 分配记录缺少 serviceItemId')
    if (!pricingMap.has(c.serviceItemId)) {
      throw new Error('INVALID_PARAMS: 服务明细不属于该服务单，请刷新后重试')
    }
    if (!c.employeeId) throw new Error('INVALID_PARAMS: 分配记录缺少 employeeId')
    if (!c.roleType) throw new Error('INVALID_PARAMS: 分配记录缺少 roleType')
    const ratioStr = Number(c.allocationRatio).toFixed(2)
    if (!VALID_RATIOS.has(ratioStr)) {
      throw new Error('INVALID_PARAMS: 分配比例必须为整十百分比（10%~100%）')
    }
  }

  // 按 (serviceItemId, roleType) 分池校验
  const pools = new Map()
  for (const c of commissions) {
    const key = `${c.serviceItemId}|${c.roleType}`
    if (!pools.has(key)) pools.set(key, [])
    pools.get(key).push(c)
  }
  for (const [, pool] of pools) {
    if (pool.length > MAX_PER_POOL) {
      throw new Error(`INVALID_PARAMS: 每个服务明细每个技能标签最多分配 ${MAX_PER_POOL} 人`)
    }
    const ratioSum = pool.reduce((s, c) => s + Number(c.allocationRatio), 0)
    if (ratioSum > 1.01) {
      throw new Error('INVALID_PARAMS: 同技能标签的分配比例合计不能超过 100%')
    }
    const empIds = new Set()
    for (const c of pool) {
      if (empIds.has(c.employeeId)) {
        throw new Error('INVALID_PARAMS: 同一服务明细同一技能标签不能重复分配同一员工')
      }
      empIds.add(c.employeeId)
    }
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    // 软 void 现有提成
    await client.query(
      `UPDATE service_commissions SET is_void = true, voided_at = NOW(), updated_at = NOW()
       WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id = $1)
         AND is_void = false`,
      [serviceOrderId]
    )

    for (const c of commissions) {
      const p = pricingMap.get(c.serviceItemId)
      const ratio = Number(Number(c.allocationRatio).toFixed(2))
      const sessionUsed = Number(p.session_used) || 0

      // consumeBase = unit_real_price × session_used（unit_real_price 已是 per-session）
      const consumeBase = round2(Number(p.unit_real_price || 0) * sessionUsed)

      // rate 命中 tier 用整池 consumeBase（不乘 ratio），不按 market 过滤（与 service.complete 一致）
      const rateRows = await client.query(
        `SELECT commission_rate FROM commission_rate_matrix
         WHERE order_type = '服务单'
           AND role_type = $1
           AND sales_category = $2
           AND amount_tier_min <= $3
           AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
         ORDER BY amount_tier_min DESC
         LIMIT 1`,
        [c.roleType, p.sales_category, consumeBase]
      )
      const rate = Number(rateRows.rows[0]?.commission_rate || 0)
      if (rate === 0 && consumeBase > 0) {
        throw new Error(`INVALID_STATE: COMMISSION_RATE_MISSING: serviceItemId=${c.serviceItemId}, roleType=${c.roleType}, salesCategory=${p.sales_category}, consumeBase=${consumeBase}`)
      }

      // 按 ratio 拆分
      const consumeAmount = round2(consumeBase * ratio * rate)
      const fixedFee = round2(Number(p.service_fee || 0) * sessionUsed * ratio)
      const commissionAmount = round2(fixedFee + consumeAmount)

      await client.query(
        `INSERT INTO service_commissions
           (service_item_id, employee_id, role_type, allocation_ratio,
            commission_rate, fixed_fee, consume_amount, commission_amount,
            is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $9)`,
        [
          c.serviceItemId,
          c.employeeId,
          c.roleType,
          ratio,
          rate,
          fixedFee,
          consumeAmount,
          commissionAmount,
          now,
        ]
      )
    }

    const upd = await client.query(
      "UPDATE service_orders SET commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND commission_status IN ('待分配', '已分配')",
      [now, serviceOrderId]
    )
    if (upd.rowCount === 0) {
      throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:service_orders:${serviceOrderId}:commission_status→已分配`)
    }
  })

  ctx.result = {
    serviceOrderId,
    message: '服务提成已保存',
    commissionCount: commissions.length,
  }
}

module.exports = { pendingList, detail, save }
