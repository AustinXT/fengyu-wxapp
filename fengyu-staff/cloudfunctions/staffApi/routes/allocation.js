/**
 * 营业额分配模块路由（员工端）—— 按回款逐笔分配
 * allocation.pendingPayments — 待分配/已分配回款列表（店长专用）
 * allocation.suggestPayment — 某笔回款的分配建议（店长专用）
 * allocation.savePayment — 保存某笔回款的营业额分配（店长专用）
 * allocation.deletePaymentAllocation — 删除某笔回款的营业额分配（店长专用）
 * allocation.getCommissionRates — 获取提成比例矩阵
 *
 * sale_allocations 为扁平结构：每行 = 一条 sale_item + 一个员工的分配记录。
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')
const { logOperation } = require('../utils/operation-log')
const { assertNoPendingRefund } = require('../utils/refund')
const { resolveMarketNameByStore } = require('../utils/market')
const { refreshOrderAllocationRollup } = require('../utils/payment-allocatable')

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

// ============================================================================
// 按回款逐笔分配（2026-06 需求变更）：分配单元从「订单」下沉到「回款事件」。
// 列表/建议/保存/删除均以 sale_payment_id 为粒度；提成率档位基准 = 本次回款额。
// ============================================================================

/**
 * 待分配/已分配回款列表（店长专用）
 * 列「销售单/转换单」非历史单的回款事件主流水行（allocation_status=$）。
 */
async function pendingPayments(ctx) {
  await requireManager()(ctx, async () => {})

  const { page = 1, pageSize = 20, allocationStatus = '待分配' } = ctx.event.payload || {}
  if (!['待分配', '已分配'].includes(allocationStatus)) {
    throw new Error('INVALID_PARAMS: allocationStatus 必须为 待分配 或 已分配')
  }
  const offset = (page - 1) * pageSize

  const payments = await pg.query(
    `SELECT p.id AS sale_payment_id, p.sale_order_id, p.change_type, p.amount, p.payment_method,
            p.paid_at, p.created_at, p.allocation_status,
            o.customer_name, o.client_phone, o.sale_order_type, o.preferred_employee_id, o.total_amount
       FROM sale_order_payments p
       JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      WHERE o.store_id = $1
        AND p.allocation_status = $2
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.legacy_source IS DISTINCT FROM 'workfine'
      ORDER BY p.paid_at DESC NULLS LAST, p.id DESC
      LIMIT $3 OFFSET $4`,
    [ctx.auth.effectiveStoreId, allocationStatus, pageSize, offset]
  )
  ctx.result = { payments, page, pageSize }
}

/**
 * 某笔回款的分配建议（店长专用）
 * 可分配项 = sale_payment_allocatable_items（基数 amount）；提成率按【本次回款额】查档。
 */
async function suggestPayment(ctx) {
  await requireManager()(ctx, async () => {})

  const { salePaymentId } = ctx.event.payload || {}
  if (!salePaymentId) throw new Error('INVALID_PARAMS: 缺少 salePaymentId')

  const payRows = await pg.query(
    `SELECT p.id, p.sale_order_id, p.amount, p.allocation_status, p.paid_at, p.change_type, p.payment_method,
            o.store_id, o.market_name, o.preferred_employee_id, o.client_phone, o.customer_name,
            o.sale_order_type, o.legacy_source
       FROM sale_order_payments p
       JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      WHERE p.id = $1 AND o.store_id = $2`,
    [salePaymentId, ctx.auth.effectiveStoreId]
  )
  if (payRows.length === 0) throw new Error('INVALID_PARAMS: 回款不存在或不属于本门店')
  const pay = payRows[0]
  pay.market_name = (await resolveMarketNameByStore(pay.store_id)) || pay.market_name
  if (!ALLOCATABLE_ORDER_TYPES.includes(pay.sale_order_type)) {
    throw new Error('INVALID_STATE: ORDER_TYPE_NOT_ALLOCATABLE: 该订单类型不参与营业额分配')
  }
  if (pay.legacy_source === 'workfine') {
    throw new Error('INVALID_STATE: LEGACY_ORDER_NOT_ALLOCATABLE: 历史订单不参与营业额分配')
  }

  let beauticianInfo = null
  let deptAnomalous = false
  if (pay.preferred_employee_id) {
    beauticianInfo = await resolveStaffRoles(pay.preferred_employee_id)
    if (beauticianInfo && beauticianInfo.skills.length === 0) deptAnomalous = true
  }
  const isNewCustomer = await checkNewCustomer(pay.client_phone, pay.sale_order_id)
  const beauticianRequired = !!(beauticianInfo && beauticianInfo.skills.length > 0)

  // 该回款的可分配项（基数 amount；同时以 received 别名下发，复用前端「实收×比例」算法）
  const items = await pg.query(
    `SELECT a.sale_item_id, a.amount::numeric AS amount, a.amount::numeric AS received,
            a.sales_category, si.product_name, si.product_type
       FROM sale_payment_allocatable_items a
       JOIN sale_items si ON si.sale_item_id = a.sale_item_id
      WHERE a.sale_payment_id = $1
      ORDER BY a.sale_item_id`,
    [salePaymentId]
  )
  const eventAmount = Math.round(items.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100

  // 该回款已有分配（供前端恢复编辑态）
  const existingAllocations = await pg.query(
    `SELECT sa.sale_item_id, sa.employee_id, sa.role_type, sa.department_name,
            sa.allocation_ratio, sa.total_amount, sa.is_void,
            swu.name AS employee_name
       FROM sale_allocations sa
       LEFT JOIN staff_wechat_users swu ON swu.employee_id = sa.employee_id
      WHERE sa.sale_payment_id = $1 AND sa.is_void = false
      ORDER BY sa.sale_item_id`,
    [salePaymentId]
  )

  let rates = []
  if (pay.market_name) {
    const rateRows = await pg.query(`
      SELECT crm.role_type, crm.sales_category, crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
      FROM commission_rate_matrix crm JOIN org_nodes n ON n.id = crm.org_id
      WHERE n.name = $1 AND crm.order_type = '销售单'
      ORDER BY crm.role_type, crm.amount_tier_min`, [pay.market_name])
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
  const ratesByRole = {}
  for (const rate of rates) if (!ratesByRole[rate.department]) ratesByRole[rate.department] = rate.orderRates

  const allocLines = []
  if (beauticianInfo && beauticianInfo.skills.length > 0) {
    for (const item of items) {
      const salesCat = item.sales_category || '自销自耗'
      for (const role of beauticianInfo.skills) {
        allocLines.push({
          saleItemId: item.sale_item_id,
          roleType: role,
          departmentName: null,
          staffWfId: beauticianInfo.staffWfId,
          staffName: beauticianInfo.name,
          salesCategory: salesCat,
          commissionRate: lookupTierRate(role, salesCat, eventAmount),
          allocationRatio: 1.00,
          autoFilled: true,
        })
      }
    }
  }

  let candidateEmployees = []
  if (pay.store_id) {
    const empRows = await pg.query(`
      SELECT u.employee_id, u.name, u.store_id, u.skills, u.is_on_business_trip,
             d.name AS department, s.store_name
      FROM staff_wechat_users u
      LEFT JOIN stores s ON u.store_id = s.store_id
      LEFT JOIN org_nodes d ON u.org_node_id = d.id
      WHERE u.is_resigned = false
        AND (u.store_id = $1 OR u.is_on_business_trip = true)
        AND u.employee_id IS NOT NULL
      ORDER BY u.name`, [pay.store_id])
    candidateEmployees = empRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      storeId: r.store_id || '',
      storeName: r.store_name || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      department: r.department || '',
      isOnBusinessTrip: r.is_on_business_trip === true,
    }))
  }

  ctx.result = {
    salePaymentId,
    saleOrderId: pay.sale_order_id,
    paymentAmount: Number(pay.amount),
    eventAmount,
    paymentMethod: pay.payment_method,
    changeType: pay.change_type,
    allocationStatus: pay.allocation_status,
    isNewCustomer,
    beauticianInfo,
    deptAnomalous,
    beauticianRequired,
    ratesByRole,
    allocLines,
    candidateEmployees,
    existingAllocations,  // 该回款已有分配（恢复编辑态用）
    orderStoreId: pay.store_id,
    items,             // 每项含 amount（可分配基数）+ received（=amount 别名）+ sales_category
    totalAmount: eventAmount, // 前端以此为「金额合计」基数（=本次回款额）
    customerName: pay.customer_name,
    paidAt: pay.paid_at,
    frozen: isFrozen(pay.paid_at),
  }
}

/**
 * 保存某笔回款的营业额分配（店长专用）
 * totalAmount 服务端重算 = 可分配额 × ratio；提成率按本次回款额查档。
 */
async function savePayment(ctx) {
  await requireManager()(ctx, async () => {})

  const { salePaymentId, allocations } = ctx.event.payload || {}
  if (!salePaymentId) throw new Error('INVALID_PARAMS: 缺少 salePaymentId')
  if (!Array.isArray(allocations)) throw new Error('INVALID_PARAMS: allocations 必须为数组')

  const payRows = await pg.query(
    `SELECT p.id, p.sale_order_id, p.allocation_status, p.paid_at,
            o.store_id, o.market_name, o.sale_order_type, o.legacy_source
       FROM sale_order_payments p
       JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      WHERE p.id = $1 AND o.store_id = $2`,
    [salePaymentId, ctx.auth.effectiveStoreId]
  )
  if (payRows.length === 0) throw new Error('INVALID_PARAMS: 回款不存在或不属于本门店')
  const pay = payRows[0]
  pay.market_name = (await resolveMarketNameByStore(pay.store_id)) || pay.market_name
  if (!ALLOCATABLE_ORDER_TYPES.includes(pay.sale_order_type)) {
    throw new Error('INVALID_STATE: ORDER_TYPE_NOT_ALLOCATABLE: 该订单类型不参与营业额分配')
  }
  if (pay.legacy_source === 'workfine') {
    throw new Error('INVALID_STATE: LEGACY_ORDER_NOT_ALLOCATABLE: 历史订单不参与营业额分配')
  }
  if (!['待分配', '已分配'].includes(pay.allocation_status)) {
    throw new Error('PERMISSION_DENIED: 该回款不可分配（状态异常）')
  }
  if (isFrozen(pay.paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，回款到账超过 ${FREEZE_DAYS} 天不可修改`)
  }
  await assertNoPendingRefund(pg, pay.sale_order_id)

  const allocItems = await pg.query(
    'SELECT sale_item_id, amount::numeric AS amount, sales_category FROM sale_payment_allocatable_items WHERE sale_payment_id = $1',
    [salePaymentId]
  )
  const baseMap = new Map(allocItems.map(i => [i.sale_item_id, Number(i.amount) || 0]))
  const catMap = new Map(allocItems.map(i => [i.sale_item_id, i.sales_category || '自销自耗']))
  const validItemIds = new Set(allocItems.map(i => i.sale_item_id))
  const eventAmount = Math.round(allocItems.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100
  const rateLookup = await buildSalesRateLookup(pay.market_name)
  const now = new Date()

  // 空分配 = 标记该回款无需分配
  if (allocations.length === 0) {
    await pg.transaction(async (client) => {
      await client.query(
        `UPDATE sale_allocations SET is_void = true, voided_at = NOW(), updated_at = NOW()
          WHERE sale_payment_id = $1 AND is_void = false`,
        [salePaymentId]
      )
      await client.query("UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1", [salePaymentId])
      await refreshOrderAllocationRollup(client, pay.sale_order_id)
      await logOperation(client, ctx, 'allocation.savePayment', 'sale_payment', String(salePaymentId), {
        _v: 1, allocationCount: 0, note: '标记为无需分配',
      })
    })
    ctx.result = { salePaymentId, message: '已标记为无需分配', allocationCount: 0 }
    return
  }

  const enriched = []
  for (const alloc of allocations) {
    if (!alloc.saleItemId) throw new Error('INVALID_PARAMS: 分配记录缺少 saleItemId')
    if (!validItemIds.has(alloc.saleItemId)) {
      throw new Error(`INVALID_PARAMS: saleItemId ${alloc.saleItemId} 不属于该回款`)
    }
    if (!alloc.employeeId) throw new Error('INVALID_PARAMS: 分配记录缺少 employeeId')
    if (!alloc.roleType) throw new Error('INVALID_PARAMS: 分配记录缺少 roleType')
    const ratioStr = Number(alloc.allocationRatio).toFixed(2)
    if (!VALID_RATIOS.has(ratioStr)) {
      throw new Error('INVALID_PARAMS: allocationRatio 必须为整十百分比（0.10~1.00）')
    }
    const base = baseMap.get(alloc.saleItemId) || 0
    const totalAmount = Math.round(base * Number(ratioStr) * 100) / 100
    const salesCategory = catMap.get(alloc.saleItemId) || '自销自耗'
    const commissionRate = rateLookup(alloc.roleType, salesCategory, eventAmount)
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

  // 按 (saleItemId, roleType) 分池校验：≤3 人、池内 Σ ≤ 该项可分配额、同员工不重复
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
    const base = baseMap.get(saleItemId) || 0
    const sum = pool.reduce((s, a) => s + a.totalAmount, 0)
    if (sum > base + AMOUNT_TOLERANCE) {
      throw new Error('INVALID_PARAMS: 分配金额合计超过本次回款该商品可分配额')
    }
    const empIds = new Set()
    for (const a of pool) {
      if (empIds.has(a.employeeId)) {
        throw new Error('INVALID_PARAMS: 同商品同技能标签不能重复分配同一员工')
      }
      empIds.add(a.employeeId)
    }
  }

  await pg.transaction(async (client) => {
    await client.query(
      `UPDATE sale_allocations SET is_void = true, voided_at = NOW(), updated_at = NOW()
        WHERE sale_payment_id = $1 AND is_void = false`,
      [salePaymentId]
    )
    for (const a of enriched) {
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, role_type, department_name, allocation_ratio, total_amount,
            commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $10)`,
        [a.saleItemId, a.employeeId, a.roleType, a.departmentName, a.allocationRatio,
         a.totalAmount, a.commissionRate, a.commissionAmount, salePaymentId, now]
      )
    }
    await client.query("UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1", [salePaymentId])
    await refreshOrderAllocationRollup(client, pay.sale_order_id)
    await logOperation(client, ctx, 'allocation.savePayment', 'sale_payment', String(salePaymentId), {
      _v: 1,
      allocationCount: enriched.length,
      totalAmount: Math.round(enriched.reduce((s, a) => s + a.totalAmount, 0) * 100) / 100,
    })
  })

  ctx.result = { salePaymentId, message: '提成分配已保存', allocationCount: enriched.length }
}

/**
 * 删除某笔回款的营业额分配（重置该回款为待分配；店长专用）
 */
async function deletePaymentAllocation(ctx) {
  await requireManager()(ctx, async () => {})

  const { salePaymentId } = ctx.event.payload || {}
  if (!salePaymentId) throw new Error('INVALID_PARAMS: 缺少 salePaymentId')

  const payRows = await pg.query(
    `SELECT p.id, p.sale_order_id, p.paid_at FROM sale_order_payments p
       JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      WHERE p.id = $1 AND o.store_id = $2`,
    [salePaymentId, ctx.auth.effectiveStoreId]
  )
  if (payRows.length === 0) throw new Error('INVALID_PARAMS: 回款不存在或不属于本门店')
  const pay = payRows[0]
  if (isFrozen(pay.paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，回款到账超过 ${FREEZE_DAYS} 天不可修改`)
  }
  await assertNoPendingRefund(pg, pay.sale_order_id)

  await pg.transaction(async (client) => {
    await client.query(
      `UPDATE sale_allocations SET is_void = true, voided_at = NOW(), updated_at = NOW()
        WHERE sale_payment_id = $1 AND is_void = false`,
      [salePaymentId]
    )
    await client.query("UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1", [salePaymentId])
    await refreshOrderAllocationRollup(client, pay.sale_order_id)
    await logOperation(client, ctx, 'allocation.deletePaymentAllocation', 'sale_payment', String(salePaymentId), { _v: 1 })
  })

  ctx.result = { salePaymentId, message: '营业额分配已清除' }
}

module.exports = {
  // 回款级（按回款逐笔分配，当前口径）
  pendingPayments, suggestPayment, savePayment, deletePaymentAllocation,
  getCommissionRates,
}
