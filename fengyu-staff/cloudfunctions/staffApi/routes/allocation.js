/**
 * 营业额分配模块路由（员工端）
 * allocation.save — 保存/更新营业额分配（店长专用）
 * allocation.delete — 删除营业额分配记录（店长专用）
 *
 * 锁定规则：
 *   - 订单状态为"待支付"时可自由修改（待扫码阶段）
 *   - 订单变为"待确认收款"或之后，分配方案锁定，不可修改
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')

/**
 * 保存营业额分配
 * payload: {
 *   orderNo: string,
 *   allocations: [
 *     {
 *       employeeId: string,   // WorkFine 员工编号
 *       allocationRatio: number, // 占比 0-1
 *       totalAmount: number,  // 分配金额
 *       items: [{ performanceCategory, amount }] // 业绩分类明细
 *     }
 *   ]
 * }
 *
 * 规则：
 *   - 同部门：所有员工分配总额 ≤ 实收金额
 *   - 跨部门：各部门可各按实收金额分配（总额可达 2x）
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
    'SELECT order_no, status, store_name FROM orders WHERE order_no = $1 AND store_name = $2',
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  // 分配锁定：仅允许在"待支付"时修改
  if (order.status !== '待支付') {
    throw new Error('PERMISSION_DENIED: 顾客已扫码或订单已支付，分配方案已锁定，如需修改请关闭订单后重新开单')
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
    if (typeof alloc.totalAmount !== 'number' || alloc.totalAmount < 0) {
      throw new Error('INVALID_PARAMS: 分配金额不合法')
    }
    const dept = alloc.department || 'default'
    deptTotals[dept] = (deptTotals[dept] || 0) + alloc.totalAmount
  }

  // 跨部门时各部门总额不超过实收（简单校验：每个部门总额不超过实收）
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
      const insertResult = await client.query(
        `INSERT INTO revenue_allocations
           (order_no, employee_id, allocation_ratio, total_amount, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, false, $5, $5)
         RETURNING id`,
        [orderNo, alloc.employeeId, alloc.allocationRatio || 1.0, alloc.totalAmount, now]
      )
      const allocId = insertResult.rows[0].id

      // 插入业绩分类明细
      if (alloc.items && alloc.items.length > 0) {
        for (const item of alloc.items) {
          await client.query(
            `INSERT INTO revenue_allocation_items (allocation_id, performance_category, amount)
             VALUES ($1, $2, $3)`,
            [allocId, item.performanceCategory || '单品', item.amount || 0]
          )
        }
      } else {
        // 无明细时，插入默认条目
        await client.query(
          `INSERT INTO revenue_allocation_items (allocation_id, performance_category, amount)
           VALUES ($1, '单品', $2)`,
          [allocId, alloc.totalAmount]
        )
      }
    }
  })

  ctx.result = {
    orderNo,
    message: '营业额分配已保存',
    allocationCount: allocations.length
  }
}

/**
 * 删除营业额分配记录（重置为未分配状态）
 * 仅允许在"待支付"（待扫码）阶段操作
 */
async function deleteAllocation(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    'SELECT order_no, status FROM orders WHERE order_no = $1 AND store_name = $2',
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '待支付') {
    throw new Error('PERMISSION_DENIED: 分配方案已锁定，不可删除')
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
  })

  ctx.result = {
    orderNo,
    message: '营业额分配已清除'
  }
}

module.exports = { save, deleteAllocation }
