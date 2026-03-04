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
  if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
    throw new Error('INVALID_PARAMS: 分配记录不能为空')
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

module.exports = { save, deleteAllocation, getCommissionRates, pendingList }
