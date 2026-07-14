

const pg = require('../db/pg')
const { requireStaffBound, requireManager } = require('../middleware/auth')
const { maskPhoneForAuth } = require('../utils/phone-visibility')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiDateStr, shanghaiYYMMDD } = require('../utils/datetime')
const { assertNoPendingRefundByServiceOrder } = require('../utils/refund')
const { isStoreInScope, restrictToBoundEmployee } = require('../utils/scope')
const { DEPOSIT_REFUND_REMARK } = require('../utils/consume-filter')


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

  const resolvedServiceDate = serviceDate || shanghaiDateStr()
  const resolvedStaffWfId = assignedStaffWfId || ctx.auth.staffWfId

  if (!normalizedItems || normalizedItems.length === 0) {
    throw new Error('INVALID_PARAMS: 服务明细不能为空')
  }

  
  if (!ctx.auth.roles.includes('manager') && resolvedStaffWfId !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 美容师只能创建分配给自己的服务单')
  }

  
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

  
  for (const item of normalizedItems) {
    if (!item.saleItemId) {
      throw new Error('INVALID_PARAMS: 服务明细缺少 saleItemId')
    }
    if (!item.sessionUsed || item.sessionUsed <= 0) {
      throw new Error('INVALID_PARAMS: 本次使用次数必须大于 0')
    }

    const saleItemRows = await pg.query(`
      SELECT
        si.sale_item_id,
        si.session_count,
        si.remaining_sessions,
        si.paid_sessions,
        si.unit_real_price,
        si.product_type,
        o.status AS order_status,
        o.store_id,
        o.client_user_id,
        o.client_phone,
        EXISTS(
          SELECT 1 FROM sale_order_payments sop
          WHERE sop.sale_order_id = o.sale_order_id
            AND sop.change_type = '退款'
            AND sop.status = '待审批'
        ) AS has_pending_refund
      FROM sale_items si
      INNER JOIN sale_orders o ON si.sale_order_id = o.sale_order_id
      WHERE si.sale_item_id = $1
    `, [item.saleItemId])

    if (saleItemRows.length === 0) {
      throw new Error(`INVALID_PARAMS: 销售明细 ${item.saleItemId} 不存在`)
    }

    const si = saleItemRows[0]

    
    if (!['已支付', '部分支付'].includes(si.order_status)) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单状态为 ${si.order_status}，不可消费`)
    }

    
    if (si.has_pending_refund) {
      throw new Error(`INVALID_STATE: REFUND_IN_PROGRESS: 订单行 ${item.saleItemId} 对应订单退款审批中，不可开单`)
    }

    if (si.product_type === '家居产品') {
      throw new Error(`INVALID_PARAMS: 家居产品不走到店服务流程`)
    }

    

    if (si.remaining_sessions !== null && si.remaining_sessions < item.sessionUsed) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 剩余次数不足`)
    }

    
    
    
    if (si.session_count != null) {
      const paid = si.paid_sessions == null ? Number(si.session_count) : Number(si.paid_sessions)
      if (paid <= 0) {
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.saleItemId} 尚未支付，无可用次数，请先完成付款`)
      }
      const usedNow = Number(si.session_count) - Number(si.remaining_sessions)
      const usedAfter = usedNow + Number(item.sessionUsed)
      if (usedAfter > paid) {
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.saleItemId} 已支付次数不足（已付 ${paid}/${si.session_count}，已用 ${usedNow}，本次需 ${item.sessionUsed}），请先完成付款`)
      }
    }
  }

  
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

  
  if (resolvedClientUserId) {
    const activeSo = await pg.query(
      "SELECT service_order_id FROM service_orders WHERE client_user_id = $1 AND status NOT IN ('已完成', '已取消') LIMIT 1",
      [resolvedClientUserId]
    )
    if (activeSo.length > 0) {
      throw new Error(`INVALID_PARAMS: 该顾客已有进行中的服务单（${activeSo[0].service_order_id}），请先完成后再创建`)
    }
  }

  
  
  let serviceOrderType = '售前'
  if (resolvedClientUserId) {
    const cuRows = await pg.query(
      'SELECT became_member_at, bound_store_id FROM client_wechat_users WHERE user_id = $1',
      [resolvedClientUserId]
    )
    
    if (cuRows[0]?.bound_store_id !== ctx.auth.effectiveStoreId) {
      throw new Error('INVALID_PARAMS: 顾客当前绑定门店非本门店，疗程卡只能在其绑定门店核销/开单')
    }
    if (cuRows.length > 0 && cuRows[0].became_member_at && new Date(cuRows[0].became_member_at) <= new Date()) {
      serviceOrderType = '售后'
    }
  } else {
    
    
    const itemStores = await pg.query(
      'SELECT store_id FROM sale_items WHERE sale_item_id = ANY($1)',
      [normalizedItems.map((it) => it.saleItemId)]
    )
    for (const row of itemStores) {
      if (!isStoreInScope(ctx.auth, row.store_id)) {
        throw new Error('PERMISSION_DENIED: 订单行不在当前门店范围内，无法核销')
      }
    }
  }

  
  
  let serviceOrderId
  const now = new Date()

  await pg.transaction(async (client) => {
    
    
    serviceOrderId = await generateServiceOrderId(client)

    
    
    
    
    try {
      await client.query(
        `INSERT INTO service_orders (
          service_order_id, status, service_order_type, market_name, store_id,
          service_date, assigned_employee_id,
          remark, client_user_id, appointment_id, created_at, updated_at
        ) VALUES ($1, '待服务', $2, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $4), $3), $4, $5, $6, $7, $8, $9, $10, $10)`,
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
    } catch (err) {
      if (err && err.code === '23505') {
        if (err.constraint === 'uq_so_appointment') {
          throw new Error('CONFLICT: 该预约已关联服务单，不可重复创建')
        }
        if (err.constraint === 'uq_so_client_active') {
          throw new Error('CONFLICT: 该顾客已有进行中的服务单，请先完成后再创建')
        }
      }
      throw err
    }

    
    for (const item of normalizedItems) {
      const serviceItemId = generateServiceItemId()

      
      
      
      const siRows = await client.query(
        `SELECT si.unit_real_price,
                COALESCE(si.is_shengmei, ps.is_shengmei) AS is_shengmei,
                COALESCE(si.sales_category, pc.sales_category) AS sales_category
         FROM sale_items si
         LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
         LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
         WHERE si.sale_item_id = $1`,
        [item.saleItemId]
      )
      const unitRealPrice = siRows.rows[0]?.unit_real_price || null
      const isShengmei = siRows.rows[0]?.is_shengmei ?? null
      const salesCategory = siRows.rows[0]?.sales_category ?? null

      await client.query(
        `INSERT INTO service_items
           (service_item_id, sale_item_id, unit_real_price, service_order_id,
            session_used, employee_id, service_duration, is_shengmei, sales_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          serviceItemId,
          item.saleItemId,
          unitRealPrice,
          serviceOrderId,
          item.sessionUsed,
          item.employeeId || resolvedStaffWfId,
          item.serviceDuration || null,
          isShengmei,
          salesCategory
        ]
      )
    }

    
    
    
    const depositCheck = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM service_items si
         JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
         JOIN sale_orders o ON o.sale_order_id = sli.sale_order_id
         WHERE si.service_order_id = $1 AND o.sale_order_type = '寄存单'
       ) AS has_deposit`,
      [serviceOrderId]
    )
    const hasDeposit = depositCheck.rows[0]?.has_deposit === true
    const isDepositRefund = remark === DEPOSIT_REFUND_REMARK
    if (isDepositRefund && !hasDeposit) {
      throw new Error('INVALID_PARAMS: 非寄存卡不可标记为寄存单退款')
    }

    
    await logOperation(client, ctx, 'service.create', 'service_order', serviceOrderId, {
      _v: 3,
      serviceOrderType,
      storeId: ctx.auth.effectiveStoreId,
      clientUserId: resolvedClientUserId,
      assignedEmployeeId: resolvedStaffWfId,
      itemCount: normalizedItems.length,
      appointmentId: appointmentId || null,
    })
  })

  ctx.result = {
    serviceOrderId,
    status: '待服务',
    message: '服务单已创建'
  }
}


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
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE service_orders SET status = '服务中', started_at = $1, updated_at = $1 WHERE service_order_id = $2 AND status = '待服务'",
      [now, serviceOrderId]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
    }
    
    await logTransition(client, ctx, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中')
  })

  ctx.result = {
    serviceOrderId,
    status: '服务中',
    message: '服务已开始'
  }
}


async function loadServiceItems(serviceOrderId) {
  return await pg.query(
    `SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.employee_id,
            sit.unit_real_price,
            si.service_fee, si.sales_category, si.session_count, si.quantity,
            swu.skills
     FROM service_items sit
     JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     LEFT JOIN staff_wechat_users swu ON swu.employee_id = sit.employee_id
     WHERE sit.service_order_id = $1`,
    [serviceOrderId]
  )
}


async function finalizeServiceOrder(client, so, items, ctx, now) {
  const serviceOrderId = so.service_order_id

  
  
  for (const item of items) {
    
    
    
    const updateResult = await client.query(
      `UPDATE sale_items
       SET remaining_sessions = remaining_sessions - $1
       WHERE sale_item_id = $2
         AND remaining_sessions >= $1
         AND remaining_sessions IS NOT NULL
         AND (session_count - remaining_sessions + $1) <= COALESCE(paid_sessions, session_count)`,
      [item.session_used, item.sale_item_id]
    )

    if (updateResult.rowCount === 0) {
      const checkRows = await client.query(
        'SELECT store_id, session_count, remaining_sessions, paid_sessions FROM sale_items WHERE sale_item_id = $1',
        [item.sale_item_id]
      )
      if (checkRows.rows.length === 0) {
        throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 不存在`)
      }
      const probe = checkRows.rows[0]
      if (probe.remaining_sessions !== null && probe.remaining_sessions < item.session_used) {
        throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}`)
      }
      if (probe.session_count !== null) {
        const paid = probe.paid_sessions == null ? 0 : Number(probe.paid_sessions)
        const usedNow = Number(probe.session_count) - Number(probe.remaining_sessions)
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.sale_item_id} 已支付次数不足（已付 ${paid}/${probe.session_count}，已用 ${usedNow}，本次需 ${item.session_used}），请先完成付款`)
      }
      throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 扣减失败`)
    }

    
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

  
  
  
  
  
  
  
  
  for (const row of items) {
    
    if (so.remark === DEPOSIT_REFUND_REMARK) continue

    const skills = Array.isArray(row.skills) ? row.skills : []
    const roleType = skills[0] || '美容师'

    const fixedFee = Math.round(Number(row.service_fee || 0) * row.session_used * 100) / 100
    const perSession = Number(row.unit_real_price || 0)
    const consumeBase = Math.round(perSession * row.session_used * 100) / 100

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
      [roleType, row.sales_category, consumeBase, serviceOrderId]
    )
    const rate = Number(rateRows.rows[0]?.commission_rate || 0)
    const consumeAmount = Math.round(consumeBase * rate * 100) / 100
    const commissionAmount = Math.round((fixedFee + consumeAmount) * 100) / 100

    
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

    
    
    
    await client.query(
      `INSERT INTO service_commissions (
         service_item_id, employee_id, role_type, allocation_ratio,
         commission_rate, commission_amount, fixed_fee, consume_amount,
         is_void
       ) VALUES ($1, $2, $3, 1.00, $4, $5, $6, $7, FALSE)
       ON CONFLICT (service_item_id, employee_id, role_type) WHERE is_void = false
       DO NOTHING`,
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

  
  const soUpdateResult = await client.query(
    "UPDATE service_orders SET status = '已完成', completed_at = $1, commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND status = '待客户确认'",
    [now, serviceOrderId]
  )
  if (soUpdateResult.rowCount === 0) {
    return false
  }

  
  if (so.appointment_id) {
    await client.query(
      "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
      [now, so.appointment_id]
    )
  }

  return true
}


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

  
  if (so.status === '待客户确认' || so.status === '已完成') {
    ctx.result = {
      serviceOrderId,
      status: so.status,
      message: so.status === '已完成' ? '服务已完成（幂等）' : '已标记完成，待客户确认（幂等）'
    }
    return
  }

  if (so.status !== '服务中') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可完成`)
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE service_orders SET status = '待客户确认', staff_completed_at = $1, updated_at = $1 WHERE service_order_id = $2 AND status = '服务中'",
      [now, serviceOrderId]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
    }
    
    await logTransition(client, ctx, 'service.complete', 'service_order', serviceOrderId, '服务中', '待客户确认')
  })

  ctx.result = {
    serviceOrderId,
    status: '待客户确认',
    message: '已标记完成，待客户确认'
  }
}


async function confirm(ctx) {
  await requireManager()(ctx, async () => {})

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

  
  if (so.status === '已完成') {
    ctx.result = { serviceOrderId, status: '已完成', message: '服务已完成（幂等）' }
    return
  }

  if (so.status !== '待客户确认') {
    throw new Error(`INVALID_STATE: 服务单当前状态为"${so.status}"，不可确认`)
  }

  
  await assertNoPendingRefundByServiceOrder(pg, serviceOrderId)

  const items = await loadServiceItems(serviceOrderId)
  const now = new Date()

  let finalized = false
  await pg.transaction(async (client) => {
    finalized = await finalizeServiceOrder(client, so, items, ctx, now)
    if (!finalized) {
      
      return
    }
    
    await logTransition(client, ctx, 'service.confirm', 'service_order', serviceOrderId, '待客户确认', '已完成', {
      clientUserId: so.client_user_id,
      itemCount: items.length,
    })
  })

  ctx.result = {
    serviceOrderId,
    status: '已完成',
    message: finalized ? '服务已确认完成，次数已扣减' : '服务已完成（幂等）'
  }
}


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

  
  const soIds = serviceOrders.map(s => s.service_order_id)
  let itemsSummary = []
  if (soIds.length > 0) {
    itemsSummary = await pg.query(`
      SELECT
        si.service_order_id,
        COALESCE(sli.product_name, '') AS product_name,
        sli.remaining_sessions,
        sli.session_count,
        sli.paid_sessions,
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
      spec: i.product_name || '',
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
      paidSessions: i.paid_sessions,
    })
  }

  
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
    customerPhone: maskPhoneForAuth(so.client_phone, ctx.auth),
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
      so.store_id,
      wu.phone AS client_phone
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    WHERE so.service_order_id = $1
  `, [id])

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在')
  }

  const so = serviceOrders[0]

  
  
  
  
  
  
  const inStoreScope = isStoreInScope(ctx.auth, so.store_id)
  const isManager = ctx.auth.roles.includes('manager')
  const isMgmt = ctx.auth.loginLevel === 'management'
  let visible = inStoreScope && (isManager || so.assigned_employee_id === ctx.auth.staffWfId)
  if (!visible && isMgmt && inStoreScope) {
    visible = true 
  }
  if (!visible && so.client_user_id) {
    
    
    
    const custRows = await pg.query(
      'SELECT bound_store_id, bound_employee_id FROM client_wechat_users WHERE user_id = $1',
      [so.client_user_id]
    )
    if (
      custRows.length > 0 &&
      isStoreInScope(ctx.auth, custRows[0].bound_store_id) &&
      (!restrictToBoundEmployee(ctx.auth) || custRows[0].bound_employee_id === ctx.auth.staffWfId)
    ) {
      visible = true
    }
  }
  if (!visible) {
    throw new Error('PERMISSION_DENIED: 无权查看该服务单')
  }

  
  const items = await pg.query(`
    SELECT
      si.sale_item_id,
      si.session_used,
      si.service_duration,
      sli.session_count,
      sli.remaining_sessions,
      sli.paid_sessions,
      sli.product_type,
      sli.product_name
    FROM service_items si
    LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
    WHERE si.service_order_id = $1
  `, [id])

  
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

  
  let review
  if (ctx.auth.roles.includes('manager') && so.status === '已完成') {
    const reviewRows = await pg.query(
      `SELECT rating, comment, created_at FROM service_reviews WHERE service_order_id = $1`,
      [id]
    )
    review = reviewRows.length > 0
      ? { rating: reviewRows[0].rating, comment: reviewRows[0].comment || '', createdAt: reviewRows[0].created_at }
      : null
  }

  ctx.result = {
    id: so.service_order_id,
    serviceOrderId: so.service_order_id,
    customerName,
    customerPhone: maskPhoneForAuth(so.client_phone, ctx.auth),
    staffName,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    appointmentId: so.appointment_id,
    remark: so.remark || '',
    review,
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      itemName: i.product_name || '',
      spec: i.product_name || '',
      sessionCount: i.session_used,
      serviceDuration: i.service_duration,
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
      paidSessions: i.paid_sessions,
    }))
  }
}


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

  
  if (!['待服务', '服务中', '待客户确认'].includes(so.status)) {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可取消`)
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE service_orders SET status = '已取消', updated_at = $1 WHERE service_order_id = $2 AND status = $3",
      [now, serviceOrderId, so.status]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
    }
    
    await logTransition(client, ctx, 'service.cancel', 'service_order', serviceOrderId, so.status, '已取消')
  })

  ctx.result = {
    serviceOrderId,
    status: '已取消',
    message: '服务单已取消'
  }
}




async function generateServiceOrderId(client) {
  if (!client) {
    throw new Error('generateServiceOrderId: client is required (must be called inside an outer transaction)')
  }
  
  const today = new Date()
  const dateStr = shanghaiYYMMDD(today)
  const likePattern = `HLD-WX-${dateStr}%`

  
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['service_order_id_gen'])
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
}

function generateServiceItemId() {
  return 'si_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}


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

module.exports = { create, start, complete, confirm, cancel, list, detail, counts }
