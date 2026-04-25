/**
 * 服务单模块路由（员工端）
 * service.create — 创建服务单
 * service.start — 开始服务（待服务 → 服务中）
 * service.complete — 完成服务（服务中 → 已完成，扣减次数）
 * service.list — 服务单列表
 * service.detail — 服务单详情
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 创建服务单
 * payload: {
 *   clientUserId, clientPhone, serviceDate, assignedStaffWfId,
 *   remark, appointmentId,
 *   items: [{ saleItemId, sessionUsed, employeeId, serviceDuration? }]
 * }
 */
async function create(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientUserId,
    clientPhone,
    serviceDate,
    assignedStaffWfId,
    remark,
    appointmentId,
    items
  } = payload

  const normalizedItems = (items || []).map(item => ({
    saleItemId: item.saleItemId,
    sessionUsed: item.sessionUsed || 1,
    employeeId: item.employeeId,
    serviceDuration: item.serviceDuration || null,
  }))

  const resolvedServiceDate = serviceDate || new Date().toISOString().slice(0, 10)
  const resolvedStaffWfId = assignedStaffWfId || ctx.auth.staffWfId

  if (!normalizedItems || normalizedItems.length === 0) {
    throw new Error('INVALID_PARAMS: 服务明细不能为空')
  }

  // 权限：店长可为任何员工创建，美容师只能指定自己
  if (!ctx.auth.roles.includes('manager') && resolvedStaffWfId !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 美容师只能创建分配给自己的服务单')
  }

  // 验证关联预约
  if (appointmentId) {
    const appts = await pg.query(
      "SELECT * FROM appointments WHERE appointment_id = $1 AND store_id = $2 AND status = '已确认'",
      [appointmentId, ctx.auth.effectiveStoreId]
    )
    if (appts.length === 0) {
      throw new Error('INVALID_PARAMS: 预约不存在、不属于本门店或状态不是已确认')
    }
    const existSo = await pg.query(
      'SELECT service_order_id FROM service_orders WHERE appointment_id = $1',
      [appointmentId]
    )
    if (existSo.length > 0) {
      throw new Error('INVALID_PARAMS: 该预约已关联服务单，不可重复创建')
    }
  }

  // 验证订单行
  for (const item of normalizedItems) {
    if (!item.saleItemId) {
      throw new Error('INVALID_PARAMS: 服务明细缺少 saleItemId')
    }
    if (!item.sessionUsed || item.sessionUsed <= 0) {
      throw new Error('INVALID_PARAMS: sessionUsed 必须大于 0')
    }

    const saleItemRows = await pg.query(`
      SELECT
        si.sale_item_id,
        si.remaining_sessions,
        si.unit_real_price,
        si.product_type,
        o.status AS order_status,
        o.store_id,
        o.client_user_id,
        o.client_phone
      FROM sale_items si
      INNER JOIN sale_orders o ON si.sale_order_id = o.sale_order_id
      WHERE si.sale_item_id = $1
    `, [item.saleItemId])

    if (saleItemRows.length === 0) {
      throw new Error(`INVALID_PARAMS: 销售明细 ${item.saleItemId} 不存在`)
    }

    const si = saleItemRows[0]

    if (si.order_status !== '已支付') {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单未支付`)
    }

    if (si.product_type === '家居产品') {
      throw new Error(`INVALID_PARAMS: 家居产品不走到店服务流程`)
    }

    if (si.store_id !== ctx.auth.effectiveStoreId) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 仅在 ${si.store_id} 可核销，当前门店 ${ctx.auth.effectiveStoreId} 无法创建服务单`)
    }

    if (si.remaining_sessions !== null && si.remaining_sessions < item.sessionUsed) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 剩余次数不足`)
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

  if (!resolvedClientUserId && normalizedItems.length > 0) {
    const orderRow = await pg.query(
      'SELECT o.client_user_id FROM sale_items si INNER JOIN sale_orders o ON si.sale_order_id = o.sale_order_id WHERE si.sale_item_id = $1',
      [normalizedItems[0].saleItemId]
    )
    if (orderRow.length > 0 && orderRow[0].client_user_id) {
      resolvedClientUserId = orderRow[0].client_user_id
    }
  }

  // 校验：同一顾客只能有一个进行中的护理单
  if (resolvedClientUserId) {
    const activeSo = await pg.query(
      "SELECT service_order_id FROM service_orders WHERE client_user_id = $1 AND status IN ('待服务', '服务中') LIMIT 1",
      [resolvedClientUserId]
    )
    if (activeSo.length > 0) {
      throw new Error(`INVALID_PARAMS: 该顾客已有进行中的护理单（${activeSo[0].service_order_id}），请先完成后再创建`)
    }
  }

  // 根据顾客成为会员客的时间戳判定服务单类型：
  // became_member_at 非空且 ≤ 当前时间 → 售后，否则 → 售前
  let serviceOrderType = '售前'
  if (resolvedClientUserId) {
    const cuRows = await pg.query(
      'SELECT became_member_at FROM client_wechat_users WHERE user_id = $1',
      [resolvedClientUserId]
    )
    if (cuRows.length > 0 && cuRows[0].became_member_at && new Date(cuRows[0].became_member_at) <= new Date()) {
      serviceOrderType = '售后'
    }
  }

  const serviceOrderId = await generateServiceOrderId()
  const now = new Date()

  await pg.transaction(async (client) => {
    // 创建服务单主表
    await client.query(
      `INSERT INTO service_orders (
        service_order_id, status, service_order_type, market_name, store_id,
        service_date, assigned_employee_id,
        remark, client_user_id, appointment_id, created_at, updated_at
      ) VALUES ($1, '待服务', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        serviceOrderId,
        serviceOrderType,
        ctx.auth.marketName || '',
        ctx.auth.effectiveStoreId,
        resolvedServiceDate,
        resolvedStaffWfId,
        remark || '',
        resolvedClientUserId,
        appointmentId || null,
        now
      ]
    )

    // 创建服务明细
    for (const item of normalizedItems) {
      const serviceItemId = generateServiceItemId()

      // 获取 sale_item 的 sku_id、unit_real_price、is_shengmei、sales_category（全部快照拷贝到 service_items）
      const siRows = await client.query(
        `SELECT si.sku_id, si.unit_real_price, si.is_shengmei, si.sales_category
         FROM sale_items si
         WHERE si.sale_item_id = $1`,
        [item.saleItemId]
      )
      const skuId = siRows.rows[0]?.sku_id || null
      const unitRealPrice = siRows.rows[0]?.unit_real_price || null
      const isShengmei = siRows.rows[0]?.is_shengmei ?? null
      const salesCategory = siRows.rows[0]?.sales_category ?? null

      await client.query(
        `INSERT INTO service_items
           (service_item_id, sale_item_id, unit_real_price, service_order_id,
            sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          serviceItemId,
          item.saleItemId,
          unitRealPrice,
          serviceOrderId,
          skuId,
          item.sessionUsed,
          item.employeeId || resolvedStaffWfId,
          item.serviceDuration || null,
          isShengmei,
          salesCategory
        ]
      )
    }
  })

  ctx.result = {
    serviceOrderId,
    status: '待服务',
    message: '服务单已创建'
  }
}

/**
 * 开始服务（待服务 → 服务中）
 */
async function start(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND store_id = $2',
    [serviceOrderId, ctx.auth.effectiveStoreId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!ctx.auth.roles.includes('manager') && so.assigned_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  if (so.status !== '待服务') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可开始服务`)
  }

  const now = new Date()
  const result = await pg.query(
    "UPDATE service_orders SET status = '服务中', started_at = $1, updated_at = $1 WHERE service_order_id = $2 AND status = '待服务'",
    [now, serviceOrderId]
  )
  if (result.rowCount === 0) {
    throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
  }

  ctx.result = {
    serviceOrderId,
    status: '服务中',
    message: '服务已开始'
  }
}

/**
 * 完成服务（服务中 → 已完成）
 * 幂等 + 原子扣减
 */
async function complete(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND store_id = $2',
    [serviceOrderId, ctx.auth.effectiveStoreId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!ctx.auth.roles.includes('manager') && so.assigned_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  // 幂等
  if (so.status === '已完成') {
    ctx.result = {
      serviceOrderId,
      status: '已完成',
      message: '服务已完成（幂等）'
    }
    return
  }

  if (so.status !== '服务中') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可完成`)
  }

  // 加载本服务单所有 service_items + 关联 sale_items 的快照（含 service_fee、sales_category）+ 员工 skills
  // 一次 JOIN 拿全，避免 for 循环内 N 次查询
  const items = await pg.query(
    `SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.employee_id,
            sit.unit_real_price,
            si.service_fee, si.sales_category,
            swu.skills
     FROM service_items sit
     JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     LEFT JOIN staff_wechat_users swu ON swu.employee_id = sit.employee_id
     WHERE sit.service_order_id = $1`,
    [serviceOrderId]
  )

  const now = new Date()

  await pg.transaction(async (client) => {
    // 原子扣减每条订单行的剩余次数（强制 sale_items.store_id 与服务单门店一致，
    // 防止本店服务单核销他店购买的卡）
    for (const item of items) {
      const updateResult = await client.query(
        `UPDATE sale_items
         SET remaining_sessions = remaining_sessions - $1
         WHERE sale_item_id = $2
           AND store_id = $3
           AND remaining_sessions >= $1
           AND remaining_sessions IS NOT NULL`,
        [item.session_used, item.sale_item_id, so.store_id]
      )

      if (updateResult.rowCount === 0) {
        const checkRows = await client.query(
          'SELECT store_id, remaining_sessions FROM sale_items WHERE sale_item_id = $1',
          [item.sale_item_id]
        )
        if (checkRows.rows.length === 0) {
          throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 不存在`)
        }
        const probe = checkRows.rows[0]
        if (probe.store_id !== so.store_id) {
          throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 仅在 ${probe.store_id} 可核销，当前服务单门店 ${so.store_id}`)
        }
        if (probe.remaining_sessions !== null) {
          throw new Error(`次数不足：订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}`)
        }
      }

      // 查询扣减后剩余次数，若归零则关闭对应预约
      const remainRows = await client.query(
        'SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1',
        [item.sale_item_id]
      )

      if (remainRows.rows.length > 0 && remainRows.rows[0].remaining_sessions === 0) {
        await client.query(
          `UPDATE appointments
           SET status = '已关闭', updated_at = $1
           WHERE sale_item_id = $2
             AND status IN ('待确认', '已确认')`,
          [now, item.sale_item_id]
        )
      }
    }

    // ========== 计算并写入服务提成（service_commissions）==========
    // 双字段模型：fixed_fee = service_fee × session_used
    //            consume_amount = unit_real_price × session_used × commission_rate
    //            commission_amount = fixed_fee + consume_amount
    // roleType 取员工 skills[0] 自动推断；无 skills 兜底 '美容师'
    // commission_rate 缺失时 rate=0 + 写 operation_logs，不阻塞 service.complete
    for (const row of items) {
      const skills = Array.isArray(row.skills) ? row.skills : []
      const roleType = skills[0] || '美容师'

      const fixedFee = Math.round(Number(row.service_fee || 0) * row.session_used * 100) / 100
      const consumeBase = Math.round(Number(row.unit_real_price || 0) * row.session_used * 100) / 100

      const rateRows = await client.query(
        `SELECT commission_rate FROM commission_rate_matrix
         WHERE order_type = '服务单'
           AND role_type = $1
           AND sales_category = $2
           AND amount_tier_min <= $3
           AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
         ORDER BY amount_tier_min DESC
         LIMIT 1`,
        [roleType, row.sales_category, consumeBase]
      )
      const rate = Number(rateRows.rows[0]?.commission_rate || 0)
      const consumeAmount = Math.round(consumeBase * rate * 100) / 100
      const commissionAmount = Math.round((fixedFee + consumeAmount) * 100) / 100

      // rate=0 且有消耗金额时，提示运维补齐矩阵规则
      if (rate === 0 && consumeBase > 0) {
        await client.query(
          `INSERT INTO operation_logs
             (operator_employee_id, operator_name, operator_role, action, target_type, target_id, detail, source, created_at)
           VALUES ($1, $2, $3, 'service.complete.rate_missing', 'service_item', $4, $5::jsonb, 'staffApi', NOW())`,
          [
            ctx.auth.staffWfId,
            ctx.auth.name || null,
            (ctx.auth.roles && ctx.auth.roles[0]) || null,
            row.service_item_id,
            JSON.stringify({ roleType, salesCategory: row.sales_category, consumeBase, serviceOrderId }),
          ]
        )
      }

      // INSERT 提成记录：ON CONFLICT 保证幂等（唯一索引 where is_void=false）
      await client.query(
        `INSERT INTO service_commissions (
           service_item_id, employee_id, role_type, allocation_ratio,
           commission_rate, commission_amount, fixed_fee, consume_amount,
           is_void
         ) VALUES ($1, $2, $3, 1.00, $4, $5, $6, $7, FALSE)
         ON CONFLICT ON CONSTRAINT uq_svc_comm_item_emp_role DO NOTHING`,
        [
          row.service_item_id,
          row.employee_id,
          roleType,
          rate,
          commissionAmount,
          fixedFee,
          consumeAmount,
        ]
      )
    }

    // 更新服务单状态（C4: WHERE 锁定当前状态防止并发竞态）+ 同步 commission_status
    const soUpdateResult = await client.query(
      "UPDATE service_orders SET status = '已完成', completed_at = $1, commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND status = '服务中'",
      [now, serviceOrderId]
    )
    if (soUpdateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
    }

    // 如关联预约，将预约状态更新为已完成
    if (so.appointment_id) {
      await client.query(
        "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
        [now, so.appointment_id]
      )
    }
  })

  ctx.result = {
    serviceOrderId,
    status: '已完成',
    message: '服务已完成，次数已扣减'
  }
}

/**
 * 服务单列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 30 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.effectiveStoreId, pageSize, offset]
  let whereExtra = ''

  if (status) {
    params.push(status)
    whereExtra += ` AND so.status = $${params.length}`
  }

  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND so.assigned_employee_id = $${params.length}`
  }

  const serviceOrders = await pg.query(`
    SELECT
      so.service_order_id,
      so.status,
      so.service_date,
      so.assigned_employee_id,
      so.client_user_id,
      so.appointment_id,
      so.remark,
      so.started_at,
      so.completed_at,
      so.created_at,
      wu.phone AS client_phone
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    WHERE so.store_id = $1
    ${whereExtra}
    ORDER BY so.service_date DESC, so.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  // 批量查询服务明细摘要
  const soIds = serviceOrders.map(s => s.service_order_id)
  let itemsSummary = []
  if (soIds.length > 0) {
    itemsSummary = await pg.query(`
      SELECT
        si.service_order_id,
        COALESCE(sli.product_name, '') AS product_name,
        sli.sku_spec_name,
        sli.remaining_sessions,
        sli.session_count,
        si.service_duration
      FROM service_items si
      LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
      WHERE si.service_order_id = ANY($1)
    `, [soIds])
  }

  const itemsMap = {}
  for (const i of itemsSummary) {
    if (!itemsMap[i.service_order_id]) itemsMap[i.service_order_id] = []
    itemsMap[i.service_order_id].push({
      itemName: i.product_name,
      spec: i.sku_spec_name || '',
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
    })
  }

  // 批量查询员工姓名（从 PG staff_wechat_users）
  const staffWfIds = [...new Set(serviceOrders.map(s => s.assigned_employee_id).filter(Boolean))]
  let staffNameMap = {}
  if (staffWfIds.length > 0) {
    const staffRows = await pg.query(
      'SELECT employee_id, name FROM staff_wechat_users WHERE employee_id = ANY($1)',
      [staffWfIds]
    )
    for (const r of staffRows) {
      staffNameMap[r.employee_id] = r.name || ''
    }
  }

  // 批量查询顾客姓名
  const clientUserIds = [...new Set(serviceOrders.map(s => s.client_user_id).filter(Boolean))]
  let customerNameMap = {}
  if (clientUserIds.length > 0) {
    const nameRows = await pg.query(
      `SELECT user_id, name FROM client_wechat_users WHERE user_id = ANY($1)`,
      [clientUserIds]
    )
    for (const r of nameRows) {
      if (r.name) customerNameMap[r.user_id] = r.name
    }
    // 兜底从订单取
    const missingIds = clientUserIds.filter(id => !customerNameMap[id])
    if (missingIds.length > 0) {
      const orderNameRows = await pg.query(`
        SELECT DISTINCT ON (o.client_user_id)
          o.client_user_id, o.customer_name
        FROM sale_orders o
        WHERE o.client_user_id = ANY($1)
        ORDER BY o.client_user_id, o.created_at DESC
      `, [missingIds])
      for (const r of orderNameRows) {
        if (r.customer_name && !customerNameMap[r.client_user_id]) {
          customerNameMap[r.client_user_id] = r.customer_name
        }
      }
    }
  }

  ctx.result = serviceOrders.map(so => ({
    id: so.service_order_id,
    serviceOrderId: so.service_order_id,
    customerName: customerNameMap[so.client_user_id] || '',
    customerPhone: so.client_phone || '',
    staffName: staffNameMap[so.assigned_employee_id] || '',
    assignedStaffWfId: so.assigned_employee_id,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    appointmentId: so.appointment_id,
    remark: so.remark || '',
    items: itemsMap[so.service_order_id] || [],
  }))
}

/**
 * 服务单详情
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { id } = ctx.event.payload || {}
  if (!id) {
    throw new Error('INVALID_PARAMS: 缺少 id 参数')
  }

  const serviceOrders = await pg.query(`
    SELECT
      so.service_order_id,
      so.status,
      so.service_date,
      so.assigned_employee_id,
      so.client_user_id,
      so.appointment_id,
      so.remark,
      so.started_at,
      so.completed_at,
      so.created_at,
      so.updated_at,
      wu.phone AS client_phone
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    WHERE so.service_order_id = $1 AND so.store_id = $2
  `, [id, ctx.auth.effectiveStoreId])

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!ctx.auth.roles.includes('manager') && so.assigned_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该服务单')
  }

  // 查询服务明细
  const items = await pg.query(`
    SELECT
      si.sale_item_id,
      si.session_used,
      si.service_duration,
      sli.session_count,
      sli.remaining_sessions,
      sli.sku_spec_name,
      sli.product_type,
      sli.product_name
    FROM service_items si
    LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
    WHERE si.service_order_id = $1
  `, [id])

  // 查询员工姓名
  let staffName = ''
  if (so.assigned_employee_id) {
    const staffRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [so.assigned_employee_id]
    )
    if (staffRows.length > 0) {
      staffName = staffRows[0].name || ''
    }
  }

  // 查询顾客姓名
  let customerName = ''
  if (so.client_user_id) {
    const nameRows = await pg.query(
      'SELECT name FROM client_wechat_users WHERE user_id = $1',
      [so.client_user_id]
    )
    if (nameRows.length > 0 && nameRows[0].name) {
      customerName = nameRows[0].name
    }
    if (!customerName) {
      const orderNameRows = await pg.query(
        `SELECT customer_name FROM sale_orders WHERE client_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [so.client_user_id]
      )
      if (orderNameRows.length > 0) customerName = orderNameRows[0].customer_name || ''
    }
  }

  ctx.result = {
    id: so.service_order_id,
    serviceOrderId: so.service_order_id,
    customerName,
    customerPhone: so.client_phone || '',
    staffName,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    appointmentId: so.appointment_id,
    remark: so.remark || '',
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      itemName: i.product_name || '',
      spec: i.sku_spec_name || '',
      sessionCount: i.session_used,
      serviceDuration: i.service_duration,
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
    }))
  }
}

/**
 * 取消服务单
 */
async function cancel(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND store_id = $2',
    [serviceOrderId, ctx.auth.effectiveStoreId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!ctx.auth.roles.includes('manager') && so.assigned_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  if (!['待服务', '服务中'].includes(so.status)) {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可取消`)
  }

  const now = new Date()
  const result = await pg.query(
    "UPDATE service_orders SET status = '已取消', updated_at = $1 WHERE service_order_id = $2 AND status = $3",
    [now, serviceOrderId, so.status]
  )
  if (result.rowCount === 0) {
    throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
  }

  ctx.result = {
    serviceOrderId,
    status: '已取消',
    message: '服务单已取消'
  }
}

// ========== 辅助函数 ==========

async function generateServiceOrderId() {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  // 使用 advisory lock 防止并发生成重复 ID
  const likePattern = `HLD-WX-${dateStr}%`
  const lockKey = Buffer.from('svc_order_id').reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0)
  const result = await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey])
    const rows = await client.query(`
      SELECT service_order_id FROM service_orders
      WHERE service_order_id LIKE $1
      ORDER BY service_order_id DESC LIMIT 1
    `, [likePattern])
    let seq = 1
    if (rows.rows.length > 0) {
      seq = parseInt(rows.rows[0].service_order_id.slice(-4)) + 1
    }
    return `HLD-WX-${dateStr}${String(seq).padStart(4, '0')}`
  })

  return result
}

function generateServiceItemId() {
  return 'si_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

/**
 * 服务单各状态计数（轻量级，供前端 Tab badge 使用）
 */
async function counts(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const params = [ctx.auth.effectiveStoreId]
  let scopeFilter = 'so.store_id = $1'

  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    scopeFilter += ` AND so.assigned_employee_id = $${params.length}`
  }

  const rows = await pg.query(`
    SELECT so.status, COUNT(*)::int AS cnt
    FROM service_orders so
    WHERE ${scopeFilter}
      AND so.status IN ('待服务', '服务中')
    GROUP BY so.status
  `, params)

  const countMap = {}
  for (const r of rows) countMap[r.status] = r.cnt

  ctx.result = {
    pending: countMap['待服务'] || 0,
    processing: countMap['服务中'] || 0,
  }
}

module.exports = { create, start, complete, cancel, list, detail, counts }
