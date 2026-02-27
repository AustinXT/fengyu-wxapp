/**
 * 服务单模块路由（员工端）
 * service.create — 创建服务单
 * service.start — 开始服务（待服务 → 服务中）
 * service.complete — 完成服务（服务中 → 已完成，扣减次数）
 * service.list — 服务单列表
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 创建服务单
 * payload: {
 *   clientUserId: string | null,  // 顾客微信用户 ID（可选）
 *   clientPhone: string | null,   // 顾客手机号（clientUserId 为 null 时备用查询）
 *   serviceDate: string,          // 服务日期 YYYY-MM-DD
 *   serviceDuration: number,      // 服务时长（分钟，可选）
 *   assignedStaffWfId: string,    // 主责服务员工
 *   remark: string,               // 备注（可选）
 *   appointmentId: string | null, // 关联预约（可选）
 *   items: [{ itemFlowNo, sessionUsed, employeeId }]  // 核销明细
 * }
 *
 * 规则：
 *   - 每条 itemFlowNo 必须来自已支付订单
 *   - 如关联预约，预约必须是已确认状态
 *   - 一条预约只能关联一张服务单
 */
async function create(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientUserId,
    clientPhone,
    serviceDate,
    serviceDuration,
    assignedStaffWfId,
    remark,
    appointmentId,
    items
  } = payload

  if (!serviceDate) {
    throw new Error('INVALID_PARAMS: 缺少 serviceDate')
  }
  if (!assignedStaffWfId) {
    throw new Error('INVALID_PARAMS: 缺少 assignedStaffWfId')
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 服务明细不能为空')
  }

  // 权限：店长可为任何员工创建，美容师只能指定自己
  if (ctx.auth.role !== 'manager' && assignedStaffWfId !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 美容师只能创建分配给自己的服务单')
  }

  // 验证关联预约（若有）
  if (appointmentId) {
    const appts = await pg.query(
      "SELECT * FROM appointments WHERE appointment_id = $1 AND store_name = $2 AND status = '已确认'",
      [appointmentId, ctx.auth.storeName]
    )
    if (appts.length === 0) {
      throw new Error('INVALID_PARAMS: 预约不存在、不属于本门店或状态不是已确认')
    }
    // 检查是否已有服务单关联该预约
    const existSo = await pg.query(
      'SELECT service_order_no FROM service_orders WHERE appointment_id = $1',
      [appointmentId]
    )
    if (existSo.length > 0) {
      throw new Error('INVALID_PARAMS: 该预约已关联服务单，不可重复创建')
    }
  }

  // 验证订单行权限：每条 item_flow_no 必须来自已支付订单
  for (const item of items) {
    if (!item.itemFlowNo) {
      throw new Error('INVALID_PARAMS: 服务明细缺少 itemFlowNo')
    }
    if (!item.sessionUsed || item.sessionUsed <= 0) {
      throw new Error('INVALID_PARAMS: sessionUsed 必须大于 0')
    }

    const orderItems = await pg.query(`
      SELECT
        oi.item_flow_no,
        oi.remaining_sessions,
        o.status AS order_status,
        o.store_name,
        o.client_user_id,
        o.client_phone,
        m.product_type
      FROM order_items oi
      INNER JOIN orders o ON oi.order_no = o.order_no
      LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
      WHERE oi.item_flow_no = $1
    `, [item.itemFlowNo])

    if (orderItems.length === 0) {
      throw new Error(`INVALID_PARAMS: 销售流水号 ${item.itemFlowNo} 不存在`)
    }

    const oi = orderItems[0]

    if (oi.order_status !== '已支付') {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.itemFlowNo} 对应订单未支付，不可创建服务单`)
    }

    if (oi.product_type === '院装产品') {
      throw new Error(`INVALID_PARAMS: 院装产品不走到店服务流程`)
    }

    if (oi.remaining_sessions !== null && oi.remaining_sessions < item.sessionUsed) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.itemFlowNo} 剩余次数不足`)
    }
  }

  // 解析 clientUserId
  let resolvedClientUserId = clientUserId || null

  if (!resolvedClientUserId && clientPhone) {
    const clientUsers = await pg.query(
      'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
      [clientPhone]
    )
    if (clientUsers.length > 0) {
      resolvedClientUserId = clientUsers[0].user_id
    }
  }

  // 生成服务单号
  const serviceOrderNo = await generateServiceOrderNo()
  const now = new Date()

  await pg.transaction(async (client) => {
    // 创建服务单主表
    await client.query(
      `INSERT INTO service_orders (
        service_order_no, status, market_name, store_name,
        service_date, service_duration, assigned_staff_wf_id,
        remark, client_user_id, appointment_id, created_at, updated_at
      ) VALUES ($1, '待服务', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        serviceOrderNo,
        ctx.auth.marketName || '',
        ctx.auth.storeName,
        serviceDate,
        serviceDuration || null,
        assignedStaffWfId,
        remark || '',
        resolvedClientUserId,
        appointmentId || null,
        now
      ]
    )

    // 创建服务明细
    for (const item of items) {
      const serviceItemId = generateServiceItemId()
      const skuRows = await client.query(
        'SELECT sku_id FROM order_items WHERE item_flow_no = $1',
        [item.itemFlowNo]
      )
      const skuId = skuRows.rows[0]?.sku_id || null

      await client.query(
        `INSERT INTO service_items
           (service_item_id, item_flow_no, service_order_no, sku_id, session_used, employee_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          serviceItemId,
          item.itemFlowNo,
          serviceOrderNo,
          skuId,
          item.sessionUsed,
          item.employeeId || assignedStaffWfId
        ]
      )
    }
  })

  ctx.result = {
    serviceOrderNo,
    status: '待服务',
    message: '服务单已创建'
  }
}

/**
 * 开始服务（待服务 → 服务中）
 * 权限：店长或 assigned_staff_wf_id 匹配的员工
 */
async function start(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { serviceOrderNo } = ctx.event.payload || {}
  if (!serviceOrderNo) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderNo')
  }

  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_no = $1 AND store_name = $2',
    [serviceOrderNo, ctx.auth.storeName]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  // 权限校验
  if (ctx.auth.role !== 'manager' && so.assigned_staff_wf_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  if (so.status !== '待服务') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可开始服务`)
  }

  const now = new Date()
  await pg.query(
    "UPDATE service_orders SET status = '服务中', updated_at = $1 WHERE service_order_no = $2",
    [now, serviceOrderNo]
  )

  ctx.result = {
    serviceOrderNo,
    status: '服务中',
    message: '服务已开始'
  }
}

/**
 * 完成服务（服务中 → 已完成）
 * 幂等：若已完成，不重复扣减次数
 * 原子扣减：UPDATE ... WHERE remaining_sessions >= n
 * 扣减后若剩余次数归零，自动关闭该订单行的待确认/已确认预约
 */
async function complete(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { serviceOrderNo } = ctx.event.payload || {}
  if (!serviceOrderNo) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderNo')
  }

  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_no = $1 AND store_name = $2',
    [serviceOrderNo, ctx.auth.storeName]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  // 权限校验
  if (ctx.auth.role !== 'manager' && so.assigned_staff_wf_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  // 幂等：已完成直接返回成功
  if (so.status === '已完成') {
    ctx.result = {
      serviceOrderNo,
      status: '已完成',
      message: '服务已完成（幂等）'
    }
    return
  }

  if (so.status !== '服务中') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可完成`)
  }

  // 查询服务明细
  const items = await pg.query(
    'SELECT service_item_id, item_flow_no, session_used FROM service_items WHERE service_order_no = $1',
    [serviceOrderNo]
  )

  const now = new Date()

  await pg.transaction(async (client) => {
    // 原子扣减每条订单行的剩余次数
    for (const item of items) {
      const updateResult = await client.query(
        `UPDATE order_items
         SET remaining_sessions = remaining_sessions - $1
         WHERE item_flow_no = $2
           AND remaining_sessions >= $1
           AND remaining_sessions IS NOT NULL`,
        [item.session_used, item.item_flow_no]
      )

      if (updateResult.rowCount === 0) {
        // 检查是否是次数不足还是院装产品（remaining_sessions IS NULL）
        const checkRows = await client.query(
          'SELECT remaining_sessions FROM order_items WHERE item_flow_no = $1',
          [item.item_flow_no]
        )
        if (checkRows.rows.length > 0 && checkRows.rows[0].remaining_sessions !== null) {
          throw new Error(`次数不足：订单行 ${item.item_flow_no} 剩余次数不足 ${item.session_used}`)
        }
        // remaining_sessions 为 null（院装产品），跳过
      }

      // 查询扣减后剩余次数，若归零则关闭对应预约
      const remainRows = await client.query(
        'SELECT remaining_sessions FROM order_items WHERE item_flow_no = $1',
        [item.item_flow_no]
      )

      if (remainRows.rows.length > 0 && remainRows.rows[0].remaining_sessions === 0) {
        // 关闭该订单行的待确认/已确认预约
        await client.query(
          `UPDATE appointments
           SET status = '已关闭', updated_at = $1
           WHERE item_flow_no = $2
             AND status IN ('待确认', '已确认')`,
          [now, item.item_flow_no]
        )
      }
    }

    // 更新服务单状态
    await client.query(
      "UPDATE service_orders SET status = '已完成', updated_at = $1 WHERE service_order_no = $2",
      [now, serviceOrderNo]
    )

    // 如关联预约，将预约状态更新为已完成
    if (so.appointment_id) {
      await client.query(
        "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
        [now, so.appointment_id]
      )
    }
  })

  ctx.result = {
    serviceOrderNo,
    status: '已完成',
    message: '服务已完成，次数已扣减'
  }
}

/**
 * 服务单列表
 * 店长：查看本店所有服务单
 * 美容师：只看分配给自己的服务单
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 30 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeName, pageSize, offset]
  let whereExtra = ''

  if (status) {
    params.push(status)
    whereExtra += ` AND so.status = $${params.length}`
  }

  if (ctx.auth.role !== 'manager') {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND so.assigned_staff_wf_id = $${params.length}`
  }

  const serviceOrders = await pg.query(`
    SELECT
      so.service_order_no,
      so.status,
      so.service_date,
      so.service_duration,
      so.assigned_staff_wf_id,
      so.client_user_id,
      so.appointment_id,
      so.remark,
      so.created_at,
      wu.phone AS client_phone
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    WHERE so.store_name = $1
    ${whereExtra}
    ORDER BY so.service_date DESC, so.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  // 批量查询服务明细摘要
  const soNos = serviceOrders.map(s => s.service_order_no)
  let itemsSummary = []
  if (soNos.length > 0) {
    itemsSummary = await pg.query(`
      SELECT
        si.service_order_no,
        COALESCE(p.name, '') AS spu_name,
        m.sku_display_name
      FROM service_items si
      LEFT JOIN order_items oi ON si.item_flow_no = oi.item_flow_no
      LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
      LEFT JOIN product_spu p ON m.spu_id = p.spu_id
      WHERE si.service_order_no = ANY($1)
    `, [soNos])
  }

  const itemsMap = {}
  for (const i of itemsSummary) {
    if (!itemsMap[i.service_order_no]) itemsMap[i.service_order_no] = []
    itemsMap[i.service_order_no].push({
      spuName: i.spu_name,
      skuDisplayName: i.sku_display_name
    })
  }

  ctx.result = {
    serviceOrders: serviceOrders.map(so => ({
      ...so,
      items: itemsMap[so.service_order_no] || []
    })),
    page,
    pageSize
  }
}

// ========== 辅助函数 ==========

async function generateServiceOrderNo() {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  const result = await pg.query(`
    SELECT service_order_no FROM service_orders
    WHERE service_order_no LIKE 'HLD-WX-${dateStr}%'
    ORDER BY service_order_no DESC LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    seq = parseInt(result[0].service_order_no.slice(-4)) + 1
  }

  return `HLD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

function generateServiceItemId() {
  return 'si_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

module.exports = { create, start, complete, list }
