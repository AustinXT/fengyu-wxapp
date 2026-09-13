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
 * rate 命中 tier 用整池 consumeBase（不乘 ratio）；commission_rate_matrix 按服务单所属市场过滤
 * （service_order→store→org 树解析市场节点，与 service.complete 一致，避免跨市场费率行碰撞）。
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')
const { logOperation } = require('../utils/operation-log')
const { assertNoPendingRefundByServiceOrder } = require('../utils/refund')
const { resolveMarketNameByStore } = require('../utils/market')
const { DEPOSIT_REFUND_REMARK } = require('../utils/consume-filter')
const { assertEmployeesAssignableToStore } = require('../utils/employee-assignment')
const { normalizeListFilters, addDateRange } = require('../utils/list-filters')

// 与 allocation.js 同源校验范式：每池 = (serviceItemId, roleType)，池间互不约束
// 分配比例校验：0~1 之间（精度 0.001，支持自定义小数比例）
const MAX_PER_POOL = 3

// 分配冻结窗口：服务单完成（completed_at）超过 N 天后，店长端禁止再修改提成分配（admin 后台不受限）
const FREEZE_DAYS = 3

// 是否已过冻结窗口（anchor 为完成/支付时刻；为空则保守放行）
function isFrozen(anchor) {
  if (!anchor) return false
  return Date.now() - new Date(anchor).getTime() > FREEZE_DAYS * 86400000
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

/**
 * 服务提成订单列表（店长专用）
 * commissionStatus 默认「待分配」，支持「已分配」用于「营业额分配」页状态切换。
 */
async function pendingList(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { commissionStatus = '待分配' } = payload
  if (!['全部', '待分配', '已分配'].includes(commissionStatus)) {
    throw new Error('INVALID_PARAMS: commissionStatus 必须为 全部、待分配 或 已分配')
  }
  const { page, pageSize, offset, keyword, keywordPattern, phoneKeyword, startDate, endDate } = normalizeListFilters(payload)
  const params = [ctx.auth.effectiveStoreId]
  const conditions = ["so.store_id = $1", "so.status = '已完成'"]

  // NULL ≡「待分配」：commission_status 无 DB default，建单初值为 NULL，筛选与展示统一 COALESCE，
  // 避免 NULL 单在「待分配」「已分配」两个筛选下都查不到、只在「全部」里露出并渲染成 "null"。
  if (commissionStatus !== '全部') {
    params.push(commissionStatus)
    // ::text 显式转型：枚举列 COALESCE 后与 $n 绑定参数比较，避免 42P18 could not determine data type
    conditions.push(`COALESCE(so.commission_status::text, '待分配') = $${params.length}`)
  }

  if (keyword) {
    params.push(keywordPattern)
    const searchParts = [`COALESCE(cu.name, '') ILIKE $${params.length} ESCAPE '\\'`]
    if (phoneKeyword) {
      params.push(`%${phoneKeyword}%`)
      searchParts.push(`regexp_replace(COALESCE(cu.phone, ''), '[^0-9]', '', 'g') LIKE $${params.length}`)
    }
    conditions.push(`(${searchParts.join(' OR ')})`)
  }

  addDateRange(conditions, params, 'so.service_date', startDate, endDate)

  params.push(pageSize)
  const limitParam = params.length
  params.push(offset)
  const offsetParam = params.length

  const orders = await pg.query(`
    SELECT
      so.service_order_id, so.status, so.service_date,
      COALESCE(so.commission_status::text, '待分配') AS commission_status,
      so.assigned_employee_id, so.client_user_id,
      cu.name AS customer_name, cu.phone AS client_phone,
      swu.name AS employee_name
    FROM service_orders so
    LEFT JOIN client_wechat_users cu ON so.client_user_id = cu.user_id
    LEFT JOIN staff_wechat_users swu ON so.assigned_employee_id = swu.employee_id
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY so.service_date DESC, so.updated_at DESC, so.service_order_id DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, params)

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
           COALESCE(so.commission_status::text, '待分配') AS commission_status,
           so.client_user_id, so.assigned_employee_id, so.completed_at,
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
  // market_name 快照口径修正：以门店反查 org 树市场名为权威（弃用开单人登录态快照），
  // 反查失败时保留原快照降级。修复服务提成「按市场算提成 / 选员工」因快照空/错而失效。
  order.market_name = (await resolveMarketNameByStore(order.store_id)) || order.market_name
  // 完成超 FREEZE_DAYS 天则冻结，前端据此禁用保存
  order.frozen = isFrozen(order.completed_at)

  // 2. 服务明细 ⋈ sale_items（含定价快照）
  const items = await pg.query(`
    SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.unit_real_price,
           sit.sales_category, sit.employee_id,
           si.service_fee, si.session_count, si.quantity,
           si.product_name,
           COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit
    FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
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

  // 5. 候选员工：本店员工 ∪ 任意市场出差员工；所有技能统一规则。
  //    出差标记 staff_wechat_users.is_on_business_trip 长期保留直至 admin 手动改回（2026-07-13 起不再每日重置）；本 action 已 requireManager() 门控。
  let candidateEmployees = []
  if (order.store_id) {
    const empRows = await pg.query(`
      SELECT u.employee_id, u.name, u.store_id, u.skills, u.is_on_business_trip,
             d.name AS department, s.store_name, employee_market.name AS market_name,
             CASE
               WHEN u.store_id = $1 THEN 'local'
               WHEN employee_market.id = target_market.id THEN 'same_market_trip'
               ELSE 'cross_market_trip'
             END AS assignment_scope
      FROM staff_wechat_users u
      LEFT JOIN stores s ON u.store_id = s.store_id
      LEFT JOIN org_nodes so ON s.org_node_id = so.id
      LEFT JOIN org_nodes d ON u.org_node_id = d.id
      LEFT JOIN org_nodes employee_org_parent ON employee_org_parent.id = d.parent_id
      LEFT JOIN org_nodes employee_market ON employee_market.id = COALESCE(
        so.parent_id,
        CASE
          WHEN d.type = '市场' THEN d.id
          WHEN d.type = '门店' THEN d.parent_id
          WHEN d.type = '部门' AND employee_org_parent.type = '市场' THEN employee_org_parent.id
          WHEN d.type = '部门' AND employee_org_parent.type = '门店' THEN employee_org_parent.parent_id
          ELSE NULL
        END
      ) AND employee_market.type = '市场'
      JOIN stores target_store ON target_store.store_id = $1
      JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
      LEFT JOIN org_nodes target_market ON target_market.id = target_store_node.parent_id
      WHERE u.is_resigned = false
        AND (u.store_id = $1 OR u.is_on_business_trip = true)
        AND u.employee_id IS NOT NULL
      ORDER BY
        CASE
          WHEN u.store_id = $1 THEN 0
          WHEN employee_market.id = target_market.id THEN 1
          ELSE 2
        END,
        employee_market.name NULLS LAST,
        s.store_name NULLS LAST,
        d.name NULLS LAST,
        u.name NULLS LAST,
        u.employee_id
    `, [order.store_id])
    candidateEmployees = empRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      storeId: r.store_id || '',
      storeName: r.store_name || '',
      marketName: r.market_name || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      department: r.department || '',
      isOnBusinessTrip: r.is_on_business_trip === true,
      assignmentScope: r.assignment_scope,
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
    'SELECT service_order_id, status, commission_status, completed_at, remark, store_id FROM service_orders WHERE service_order_id = $1 AND store_id = $2',
    [serviceOrderId, ctx.auth.effectiveStoreId]
  )
  if (orders.length === 0) {
    throw new Error('NOT_FOUND: 服务单不存在或不属于本门店')
  }
  const order = orders[0]
  if (order.status !== '已完成') {
    throw new Error('INVALID_STATE: 仅已完成服务单可分配提成')
  }
  // commission_status 无 DB default，建单初值为 NULL；NULL ≡「待分配」（尚未产生分配结果）。
  // 历史上 admin 代确认因 CAS 漏 IS NULL 会把已完成单留在 NULL，这里必须放行，否则店长无法调整提成。
  if (order.commission_status != null && !['待分配', '已分配'].includes(order.commission_status)) {
    throw new Error('INVALID_STATE: 服务单提成状态异常')
  }
  // 完成超 FREEZE_DAYS 天后冻结分配结果（含清空场景；admin 后台不受此限）
  if (isFrozen(order.completed_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，服务单完成超过 ${FREEZE_DAYS} 天不可修改`)
  }
  // 冻结闭环（Bug I）：关联订单退款审批中禁止改服务提成（退款 cascade 会作废提成）
  await assertNoPendingRefundByServiceOrder(pg, serviceOrderId)

  // 寄存单退款专用服务单不参与提成分配（顾客退寄存卡次数，员工未实际提供服务）。
  // 正常寄存消费核销单照常参与服务提成（寄存单仍不计营业额分成，由 ALLOCATABLE_ORDER_TYPES 守卫）。
  if (order.remark === DEPOSIT_REFUND_REMARK) {
    throw new Error('INVALID_STATE: 寄存单退款专用服务单不参与提成分配')
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
      // CAS 守卫：NULL（建单初值，见 save 开头注释）视同「待分配」一并放行，挡其它脏态
      const upd = await client.query(
        "UPDATE service_orders SET commission_status = '待分配', updated_at = NOW() WHERE service_order_id = $1 AND (commission_status IS NULL OR commission_status IN ('待分配', '已分配'))",
        [serviceOrderId]
      )
      if (upd.rowCount === 0) {
        throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:service_orders:${serviceOrderId}:commission_status→待分配`)
      }
      // 审计日志
      await logOperation(client, ctx, 'serviceCommission.save', 'service_order', serviceOrderId, {
        _v: 3,
        commissionCount: 0,
        note: '清空提成分配',
      })
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
    const ratioStr = Number(c.allocationRatio).toFixed(3)
    if (!(Number(ratioStr) > 0 && Number(ratioStr) <= 1)) {
      throw new Error('INVALID_PARAMS: 分配比例必须为 0~1 之间（精度 0.001）')
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
    // 容差 0.0001：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与 allocation/admin 同口径）
    const ratioSum = pool.reduce((s, c) => s + Number(c.allocationRatio), 0)
    if (ratioSum > 1.0001) {
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
  await assertEmployeesAssignableToStore(
    pg,
    commissions.map((commission) => commission.employeeId),
    order.store_id,
    { assignmentScope: 'allocationSupport' },
  )

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
      const ratio = Number(Number(c.allocationRatio).toFixed(3))
      const sessionUsed = Number(p.session_used) || 0

      // consumeBase = unit_real_price × session_used（unit_real_price 已是 per-session）
      const consumeBase = round2(Number(p.unit_real_price || 0) * sessionUsed)

      // rate 命中 tier 用整池 consumeBase（不乘 ratio），按服务单所属市场过滤（与 service.complete 一致）
      const rateRows = await client.query(
        `SELECT commission_rate FROM commission_rate_matrix
         WHERE order_type = '服务单'
           AND role_type = $1
           AND sales_category = $2
           AND amount_tier_min <= $3
           AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
           AND org_id = (
             SELECT m.id FROM service_orders so
               JOIN stores s ON so.store_id = s.store_id
               JOIN org_nodes son ON s.org_node_id = son.id
               JOIN org_nodes m ON son.parent_id = m.id
              WHERE so.service_order_id = $4
           )
         ORDER BY amount_tier_min DESC
         LIMIT 1`,
        [c.roleType, p.sales_category, consumeBase, serviceOrderId]
      )
      // 容错口径（对齐 finalize：routes/service.js:519）：查无匹配行 / 命中行 rate=0
      // 统一按 rate=0 落库，不阻塞保存（与 admin 镜像）。
      const rate = Number(rateRows.rows[0]?.commission_rate || 0)

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

    // CAS 守卫：同上，NULL（建单初值）视同「待分配」一并放行
    const upd = await client.query(
      "UPDATE service_orders SET commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND (commission_status IS NULL OR commission_status IN ('待分配', '已分配'))",
      [now, serviceOrderId]
    )
    if (upd.rowCount === 0) {
      throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:service_orders:${serviceOrderId}:commission_status→已分配`)
    }
    // 审计日志
    await logOperation(client, ctx, 'serviceCommission.save', 'service_order', serviceOrderId, {
      _v: 3,
      commissionCount: commissions.length,
    })
  })

  ctx.result = {
    serviceOrderId,
    message: '服务提成已保存',
    commissionCount: commissions.length,
  }
}

module.exports = { pendingList, detail, save }
