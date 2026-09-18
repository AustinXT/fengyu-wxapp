/**
 * 营业额分配模块路由（员工端）—— 按回款逐笔分配
 * allocation.pendingPayments — 待分配/已分配回款列表（店长专用）
 * allocation.suggestPayment — 某笔回款的分配建议（店长专用）
 * allocation.savePayment — 保存某笔回款的营业额分配（店长专用）
 * allocation.deletePaymentAllocation — 删除某笔回款的营业额分配（店长专用）
 * allocation.getCommissionRates — 获取提成比例矩阵
 *
 * 新结构：
 *   sale_payment_item_receipts 为父表，每行 = 一笔款项 × 一个商品子项的有符号实收。
 *   sale_payment_item_allocations 为子表，每行 = 一条 receipt × 一个员工 × 一个角色。
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')
const { logOperation } = require('../utils/operation-log')
const { normalizeListFilters, addDateRange } = require('../utils/list-filters')
const { assertPaymentAttributionReady } = require('../utils/attribution-guard')
const { assertNoPendingRefund, assertNoSettledRefundForPayment } = require('../utils/refund')
const { resolveMarketNameByStore } = require('../utils/market')
const { createSalesCategoryRates } = require('../utils/sales-categories')
const { refreshOrderAllocationRollup } = require('../utils/payment-allocatable')
const {
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
} = require('../utils/employee-assignment')

// P2-14 Q5: skillTags 驱动的业绩分配校验
// 每池 = (saleItemId, roleType) 二元组，池间互不约束
// 分配比例校验：0~1 之间（精度 0.001，支持自定义小数比例），与 serviceCommission.js / admin actions 同源
const MAX_PER_POOL = 3

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
        orderRates: createSalesCategoryRates(),
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
        orderRates: createSalesCategoryRates(),
        serviceRates: createSalesCategoryRates(),
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

  const payload = ctx.event.payload || {}
  const { allocationStatus = '待分配' } = payload
  if (!['全部', '待分配', '已分配'].includes(allocationStatus)) {
    throw new Error('INVALID_PARAMS: allocationStatus 必须为 全部、待分配 或 已分配')
  }
  const { page, pageSize, offset, keyword, keywordPattern, phoneKeyword, startDate, endDate } = normalizeListFilters(payload)
  const params = [ctx.auth.effectiveStoreId]
  const conditions = [
    'o.store_id = $1',
    'p.allocation_status IS NOT NULL',
    "o.sale_order_type IN ('销售单', '转换单')",
    "o.legacy_source IS DISTINCT FROM 'workfine'",
  ]

  if (allocationStatus !== '全部') {
    params.push(allocationStatus)
    conditions.push(`p.allocation_status = $${params.length}`)
  }

  if (keyword) {
    params.push(keywordPattern)
    const searchParts = [`COALESCE(c.name, o.customer_name, '') ILIKE $${params.length} ESCAPE '\\'`]
    if (phoneKeyword) {
      params.push(`%${phoneKeyword}%`)
      searchParts.push(`regexp_replace(COALESCE(c.phone, o.client_phone, ''), '[^0-9]', '', 'g') LIKE $${params.length}`)
    }
    conditions.push(`(${searchParts.join(' OR ')})`)
  }

  // 日期筛选口径固定为「款项业绩归属日期」（#139），与 admin 营业额分配默认口径 attribution 同构。
  // 款项粒度：直接约束当前这一行款项的归属日期，**不得**退化成订单级 EXISTS 半连接
  // （那样会把同订单里落在区间外的其他回款一并带出）。归属日期是 date，走 addDateRange 闭区间。
  //
  // 这里**不加** `status='已支付'` 闸门，与 admin allocations.ts 的 getPendingPayments 保持一致
  // （加了反而制造副本漂移）。注意别把理由记成「allocation_status IS NOT NULL 只命中已支付行」——
  // 那是错的：退款行会被 helpers/refund-cascade.js 置 '已分配'，全额储值卡抵扣行也会被
  // utils/payment-allocatable.js 置 '待分配'，DB 层只有枚举没有 CHECK 兜底。
  // 真正的依据是**写入侧时序**：这些写入点都发生在该行 status 已置 '已支付' 之后。
  if (startDate || endDate) await assertPaymentAttributionReady(pg)
  addDateRange(conditions, params, 'p.performance_attribution_date', startDate, endDate)

  params.push(pageSize)
  const limitParam = params.length
  params.push(offset)
  const offsetParam = params.length

  const payments = await pg.query(
    `SELECT p.id AS sale_payment_id, p.sale_order_id, p.change_type, p.amount, p.payment_method,
            p.paid_at, p.created_at, p.allocation_status,
            COALESCE(c.name, o.customer_name) AS customer_name,
            COALESCE(c.phone, o.client_phone) AS client_phone,
            o.sale_order_type, o.preferred_employee_id, o.total_amount
      FROM sale_order_payments p
      JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      LEFT JOIN client_wechat_users c ON c.user_id = o.client_user_id
     WHERE ${conditions.join('\n       AND ')}
        AND (
          p.allocation_status <> '待分配'
          OR EXISTS (
            SELECT 1
              FROM sale_payment_item_receipts spir
             WHERE spir.sale_payment_id = p.id
               AND spir.amount::numeric <> 0
               AND NOT EXISTS (
                 SELECT 1
                   FROM sale_payment_item_allocations spia
                  WHERE spia.sale_payment_item_receipt_id = spir.id
                    AND spia.is_void = false
               )
          )
          OR (
            NOT EXISTS (
              SELECT 1 FROM sale_payment_item_receipts spir WHERE spir.sale_payment_id = p.id
            )
            AND GREATEST(COALESCE(o.received::numeric, 0) - COALESCE(o.refunded_amount::numeric, 0), 0) > 0
          )
        )
      ORDER BY p.paid_at DESC NULLS LAST, p.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  )
  ctx.result = { payments, page, pageSize }
}

/**
 * 某笔回款的分配建议（店长专用）
 * 可分配项 = sale_payment_item_receipts（基数 amount）；提成率按【本次回款额】查档。
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
    if (beauticianInfo && !(await isEmployeeAssignableToStore(pg, pay.preferred_employee_id, pay.store_id))) {
      beauticianInfo = null
    }
    if (beauticianInfo && beauticianInfo.skills.length === 0) deptAnomalous = true
  }
  const isNewCustomer = await checkNewCustomer(pay.client_phone, pay.sale_order_id)
  const beauticianRequired = !!(beauticianInfo && beauticianInfo.skills.length > 0)

  // 该回款的可分配项（基数 amount；同时以 received 别名下发，复用前端「实收×比例」算法）
  const items = await pg.query(
    `SELECT a.id AS receipt_id, a.sale_item_id, a.amount::numeric AS amount, a.amount::numeric AS received,
            a.sales_category, si.sku_id, si.product_name, si.product_type, si.item_direction
       FROM sale_payment_item_receipts a
       JOIN sale_items si ON si.sale_item_id = a.sale_item_id
      WHERE a.sale_payment_id = $1
      ORDER BY a.sale_item_id`,
    [salePaymentId]
  )
  const eventAmount = Math.round(items.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100

  // 该回款已有分配（供前端恢复编辑态）
  const existingAllocations = await pg.query(
    `SELECT spir.sale_item_id, spia.employee_id, spia.role_type, spia.department_name,
            spia.allocation_ratio, spia.allocated_amount AS total_amount, spia.is_void,
            swu.name AS employee_name
       FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
       LEFT JOIN staff_wechat_users swu ON swu.employee_id = spia.employee_id
      WHERE spir.sale_payment_id = $1 AND spia.is_void = false
      ORDER BY spir.sale_item_id`,
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
          orderRates: createSalesCategoryRates(),
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
        u.employee_id`, [pay.store_id])
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
 * 取订单行锁，把本模块的写事务钉在项目约定的锁序上：`sale_orders` → `sale_order_payments`
 * （硬约束见 db/CLAUDE.md「写 sale_order_payments 的硬约束」）。
 *
 * 分配链路天然是「先改款项行、再刷订单汇总」，与「订单级改期」（先锁订单、
 * 再由迁移 0040 的 AFTER trigger 回写款项行）方向相反，并发同一订单必 40P01（issue #148，
 * 已在临时 PG 实测复现）。事务一进来就先取订单行锁即可消环。
 *
 * ⚠ 必须是**独立一条**只查 sale_orders 的语句：写成
 * `SELECT ... FROM sop JOIN so ... WHERE sop.id = $1 FOR UPDATE OF sop, so` 会按 sop 主键扫描，
 * 物理上先锁款项行，恰好把锁序倒回来（该坑已在 #137 评审中实测踩过）。
 *
 * ⚠ 锁强度是 `FOR NO KEY UPDATE`，**不要"顺手"改成 `FOR UPDATE`**。三者实测对照
 * （PG 16，2026-09-18，issue #148 评审）：
 *
 * | 本事务持有 | FK 子表 INSERT（取父行 FOR KEY SHARE） | 改期的 FOR UPDATE | 0040 trigger 的 FOR SHARE |
 * |---|---|---|---|
 * | `FOR UPDATE`        | **被挡** | 被挡 | 被挡 |
 * | `FOR NO KEY UPDATE` | 放行     | 被挡 | 被挡 |
 *
 * 消环只需要挡住后两者，`FOR NO KEY UPDATE` 已经够。而 `FOR UPDATE` 会在整个分配事务期间
 * 把该订单的所有子表 INSERT 一并挡住 —— `order.js` 的 createRefund 事务第一条就是
 * `INSERT INTO sale_order_payments`，本来是毫秒级，会被拖到分配事务提交。
 * 它也正是 rollup 的 `UPDATE sale_orders` 最终要取的锁级别，顺带省掉一次锁升级。
 *
 * 订单行在事务外已查得存在；`sale_order_payments.sale_order_id` 是 NOT NULL + ON DELETE RESTRICT，
 * 有款项行时订单删不掉，所以这里恒锁到 1 行。返回 0 行只可能是传了空 saleOrderId 之类的编程错误，
 * 那意味着**本次调用完全没拿到订单锁、锁序修复对它失效**，必须响亮失败而不是静默退化。
 */
async function lockSaleOrderForAllocation(client, saleOrderId) {
  const res = await client.query(
    'SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR NO KEY UPDATE',
    [saleOrderId],
  )
  if (res.rowCount !== 1) {
    throw new Error(`CONFLICT: ORDER_GONE: 订单不存在或已被删除（${saleOrderId}）`)
  }
}

/**
 * 把 PG 死锁（40P01）翻成可重试的 CONFLICT，而不是掉进全局兜底的「-1 服务器内部错误」。
 * 锁序修正后分配 × 改期这一个环已消除，这里是**兜底**：仍可能有未覆盖的交错路径，
 * 届时用户看到的应该是「请重试」而不是一个无从判断的内部错误。
 */
function rethrowAsConflictIfDeadlock(err) {
  if (err && err.code === '40P01') {
    throw new Error('CONFLICT: DEADLOCK_DETECTED: 该订单正被其他操作修改，请稍后重试')
  }
  throw err
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
    `SELECT p.id, p.sale_order_id, p.allocation_status, p.paid_at, p.change_type,
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
  if (pay.change_type === '退款') {
    throw new Error('INVALID_STATE: REFUND_ALLOCATION_READONLY: 退款赤字分配由系统自动生成，不可手动修改')
  }
  if (isFrozen(pay.paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，回款到账超过 ${FREEZE_DAYS} 天不可修改`)
  }
  await assertNoPendingRefund(pg, pay.sale_order_id)
  // 退款后重分配守卫（2026-06-24）：本回款的可分配 item 中存在「已支付退款」冲销时禁止重分配——退款已记负数冲销行（挂退款流水 id），
  // 重保存会作废原回款正数行 + 写新正数行，与退款负数行脱节 → 净额错乱。回款级守卫：同单其它无关 item 的回款不受影响。两端镜像 admin savePaymentAllocations。
  await assertNoSettledRefundForPayment(pg, salePaymentId)
  await assertEmployeesAssignableToStore(
    pg,
    allocations.map((allocation) => allocation.employeeId),
    pay.store_id,
    { assignmentScope: 'allocationSupport' },
  )

  const allocItems = await pg.query(
    'SELECT id AS receipt_id, sale_item_id, amount::numeric AS amount, sales_category FROM sale_payment_item_receipts WHERE sale_payment_id = $1',
    [salePaymentId]
  )
  const baseMap = new Map(allocItems.map(i => [i.sale_item_id, { receiptId: Number(i.receipt_id), amount: Number(i.amount) || 0 }]))
  const catMap = new Map(allocItems.map(i => [i.sale_item_id, i.sales_category || '自销自耗']))
  const validItemIds = new Set(allocItems.map(i => i.sale_item_id))
  const eventAmount = Math.round(allocItems.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100
  const rateLookup = await buildSalesRateLookup(pay.market_name)
  const now = new Date()

  // 空分配 = 标记该回款无需分配
  if (allocations.length === 0) {
    await pg.transaction(async (client) => {
      // 锁序 sale_orders → sale_order_payments，必须是事务第一条语句（见 lockSaleOrderForAllocation）
      await lockSaleOrderForAllocation(client, pay.sale_order_id)
      await client.query(
        `UPDATE sale_payment_item_allocations
            SET is_void = true, voided_at = NOW(), updated_at = NOW()
          WHERE sale_payment_item_receipt_id IN (
            SELECT id FROM sale_payment_item_receipts WHERE sale_payment_id = $1
          )
            AND is_void = false`,
        [salePaymentId]
      )
      // CAS 守卫：allocation_status 仅 2 值轻量级状态机；IN ('待分配','已分配') 幂等允许重分配 + 挡 NULL/脏态
      const emptyUpd = await client.query("UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1 AND allocation_status IN ('待分配', '已分配')", [salePaymentId])
      if (emptyUpd.rowCount === 0) throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED: sale_order_payments:${salePaymentId}:allocation_status`)
      await refreshOrderAllocationRollup(client, pay.sale_order_id)
      await logOperation(client, ctx, 'allocation.savePayment', 'sale_payment', String(salePaymentId), {
        _v: 1, allocationCount: 0, note: '标记为无需分配',
      })
    }).catch(rethrowAsConflictIfDeadlock)
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
    const ratioStr = Number(alloc.allocationRatio).toFixed(3)
    if (!(Number(ratioStr) > 0 && Number(ratioStr) <= 1)) {
      throw new Error('INVALID_PARAMS: allocationRatio 必须为 0~1 之间（精度 0.001）')
    }
    const base = baseMap.get(alloc.saleItemId)
    if (!base) throw new Error(`INVALID_PARAMS: saleItemId ${alloc.saleItemId} 不属于该回款`)
    const totalAmount = Math.round(base.amount * Number(ratioStr) * 100) / 100
    const salesCategory = catMap.get(alloc.saleItemId) || '自销自耗'
    const commissionRate = rateLookup(alloc.roleType, salesCategory, eventAmount)
    const commissionAmount = Math.round(totalAmount * commissionRate * 100) / 100
    enriched.push({
      saleItemId: alloc.saleItemId,
      employeeId: alloc.employeeId,
      roleType: alloc.roleType,
      receiptId: base.receiptId,
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
  for (const [, pool] of pools) {
    if (pool.length > MAX_PER_POOL) {
      throw new Error(`INVALID_PARAMS: 每个商品每个技能标签最多分配 ${MAX_PER_POOL} 人`)
    }
    // 池内分配比例合计 ≤ 100%（容差 0.0001：仅吸收浮点漂移，不放过 ≥0.1% 真实超额）。回款级 base 恒正，比例校验与原金额校验等价；
    // 改用比例校验避免对负数 received（转换单转出行等）方向反转误报，与 admin/前端统一「只看比例」。
    const ratioSum = pool.reduce((s, a) => s + Number(a.allocationRatio), 0)
    if (ratioSum > 1.0001) {
      throw new Error('INVALID_PARAMS: 同技能标签的分配比例合计不能超过 100%')
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
    // 锁序 sale_orders → sale_order_payments，必须是事务第一条语句（见 lockSaleOrderForAllocation）
    await lockSaleOrderForAllocation(client, pay.sale_order_id)
    await client.query(
      `UPDATE sale_payment_item_allocations
          SET is_void = true, voided_at = NOW(), updated_at = NOW()
        WHERE sale_payment_item_receipt_id IN (
          SELECT id FROM sale_payment_item_receipts WHERE sale_payment_id = $1
        )
          AND is_void = false`,
      [salePaymentId]
    )
    for (const a of enriched) {
      await client.query(
        `INSERT INTO sale_payment_item_allocations
           (sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio, allocated_amount,
            commission_rate, commission_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $9)`,
        [a.receiptId, a.employeeId, a.roleType, a.departmentName, a.allocationRatio,
         a.totalAmount, a.commissionRate, a.commissionAmount, now]
      )
    }
    // CAS 守卫：同上，IN ('待分配','已分配') 幂等允许重分配 + 挡 NULL/脏态
    const savedUpd = await client.query("UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1 AND allocation_status IN ('待分配', '已分配')", [salePaymentId])
    if (savedUpd.rowCount === 0) throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED: sale_order_payments:${salePaymentId}:allocation_status`)
    await refreshOrderAllocationRollup(client, pay.sale_order_id)
    await logOperation(client, ctx, 'allocation.savePayment', 'sale_payment', String(salePaymentId), {
      _v: 1,
      allocationCount: enriched.length,
      totalAmount: Math.round(enriched.reduce((s, a) => s + a.totalAmount, 0) * 100) / 100,
    })
  }).catch(rethrowAsConflictIfDeadlock)

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
    `SELECT p.id, p.sale_order_id, p.paid_at, p.change_type FROM sale_order_payments p
       JOIN sale_orders o ON o.sale_order_id = p.sale_order_id
      WHERE p.id = $1 AND o.store_id = $2`,
    [salePaymentId, ctx.auth.effectiveStoreId]
  )
  if (payRows.length === 0) throw new Error('INVALID_PARAMS: 回款不存在或不属于本门店')
  const pay = payRows[0]
  if (pay.change_type === '退款') {
    throw new Error('INVALID_STATE: REFUND_ALLOCATION_READONLY: 退款赤字分配由系统自动生成，不可手动清除')
  }
  if (isFrozen(pay.paid_at)) {
    throw new Error(`INVALID_STATE: ALLOCATION_FROZEN: 分配结果已冻结，回款到账超过 ${FREEZE_DAYS} 天不可修改`)
  }
  await assertNoPendingRefund(pg, pay.sale_order_id)
  // 退款后守卫（2026-06-24）：本回款的可分配 item 中存在「已支付退款」冲销时禁止清除分配（防作废正数行后留悬空负数）。回款级守卫：同单其它无关 item 的回款不受影响。两端镜像 admin。
  await assertNoSettledRefundForPayment(pg, salePaymentId)

  await pg.transaction(async (client) => {
    // 锁序 sale_orders → sale_order_payments，必须是事务第一条语句（见 lockSaleOrderForAllocation）
    await lockSaleOrderForAllocation(client, pay.sale_order_id)
    await client.query(
      `UPDATE sale_payment_item_allocations
          SET is_void = true, voided_at = NOW(), updated_at = NOW()
        WHERE sale_payment_item_receipt_id IN (
          SELECT id FROM sale_payment_item_receipts WHERE sale_payment_id = $1
        )
          AND is_void = false`,
      [salePaymentId]
    )
    // CAS 守卫：删除分配只允许 '已分配'→'待分配'，挡并发双删（脏 voided_at 时间戳）
    const resetUpd = await client.query("UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1 AND allocation_status = '已分配'", [salePaymentId])
    if (resetUpd.rowCount === 0) throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED: sale_order_payments:${salePaymentId}:allocation_status`)
    await refreshOrderAllocationRollup(client, pay.sale_order_id)
    await logOperation(client, ctx, 'allocation.deletePaymentAllocation', 'sale_payment', String(salePaymentId), { _v: 1 })
  }).catch(rethrowAsConflictIfDeadlock)

  ctx.result = { salePaymentId, message: '营业额分配已清除' }
}

module.exports = {
  // 回款级（按回款逐笔分配，当前口径）
  pendingPayments, suggestPayment, savePayment, deletePaymentAllocation,
  getCommissionRates,
}
