/**
 * 服务单模块路由（员工端）
 * service.create — 创建服务单
 * service.start — 开始服务（待服务 → 服务中）
 * service.complete — 员工标记完成（服务中 → 待客户确认，不产生副作用）
 * service.confirm — 店长代客户确认（待客户确认 → 已完成，扣次数+计提成+关预约）
 * service.list — 服务单列表
 * service.detail — 服务单详情
 */

const pg = require('../db/pg')
const { requireStaffBound, requireManager, isCurrentStoreManager, hasValidManagerRole } = require('../middleware/auth')
const { maskPhone } = require('../utils/pii')
const { normalizeListFilters, addDateRange } = require('../utils/list-filters')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiDateStr, shanghaiYYMMDD } = require('../utils/datetime')
const { assertNoPendingRefundByServiceOrder } = require('../utils/refund')
const { isStoreInScope, restrictToBoundEmployee } = require('../utils/scope')
const { DEPOSIT_REFUND_REMARK } = require('../utils/consume-filter')
const { grantVisitPointsSafe } = require('../utils/visit-points')
const {
  assertEmployeesAssignableToStore,
  SERVICE_ORDER_ASSIGNABLE_SKILLS,
} = require('../utils/employee-assignment')

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
  const normalizedRemark = typeof remark === 'string' ? remark : ''

  const resolvedServiceDate = serviceDate || shanghaiDateStr()
  const resolvedStaffWfId = assignedStaffWfId || ctx.auth.staffWfId

  if (!normalizedItems || normalizedItems.length === 0) {
    throw new Error('INVALID_PARAMS: 服务明细不能为空')
  }

  // 权限：店长可为任何员工创建，美容师只能指定自己
  if (!isCurrentStoreManager(ctx.auth) && resolvedStaffWfId !== ctx.auth.staffWfId) {
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

    // 订单状态门槛（ticket 2026-05-19 D2=A）：允许 已支付 / 部分支付 两种状态消费
    if (!['已支付', '部分支付'].includes(si.order_status)) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 对应订单状态为 ${si.order_status}，不可消费`)
    }

    // 在途退款冻结：原订单存在 '待审批' 退款时，疗程卡不可开单/核销（审批通过后由 paid_sessions 限额继续守护）
    if (si.has_pending_refund) {
      throw new Error(`INVALID_STATE: REFUND_IN_PROGRESS: 订单行 ${item.saleItemId} 对应订单退款审批中，不可开单`)
    }

    if (si.product_type === '家居产品') {
      throw new Error(`INVALID_PARAMS: 家居产品不走到店服务流程`)
    }

    // 注：可核销门店不再看卡售出门店（si.store_id），改由下方「顾客绑定门店」统一把关（卡跟顾客走）

    if (si.remaining_sessions !== null && si.remaining_sessions < item.sessionUsed) {
      throw new Error(`INVALID_PARAMS: 订单行 ${item.saleItemId} 剩余次数不足`)
    }

    // paid_sessions 限额校验（ticket 2026-05-19 D6=A）：paid_sessions=0 时整张卡锁死
    // session_count != null 同时覆盖 undefined（兼容历史 mock）
    // paid_sessions IS NULL 视为 session_count（兼容历史数据 / 旧 fixture，不引入回归）
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

  // 校验：同一顾客只能有一个进行中的服务单（含待客户确认，与 uq_so_client_active 索引谓词一致）
  if (resolvedClientUserId) {
    const activeSo = await pg.query(
      "SELECT service_order_id FROM service_orders WHERE client_user_id = $1 AND status NOT IN ('已完成', '已取消') LIMIT 1",
      [resolvedClientUserId]
    )
    if (activeSo.length > 0) {
      throw new Error(`INVALID_PARAMS: 该顾客已有进行中的服务单（${activeSo[0].service_order_id}），请先完成后再创建`)
    }
  }

  // 根据顾客成为会员客的时间戳判定服务单类型：
  // became_member_at 非空且 ≤ 当前时间 → 售后，否则 → 售前
  let serviceOrderType = '售前'
  if (resolvedClientUserId) {
    const cuRows = await pg.query(
      'SELECT became_member_at, bound_store_id FROM client_wechat_users WHERE user_id = $1',
      [resolvedClientUserId]
    )
    // 疗程卡使用限当前绑定门店：开单门店必须 == 顾客绑定门店（卡跟顾客走、只能用在绑定门店）
    if (cuRows[0]?.bound_store_id !== ctx.auth.effectiveStoreId) {
      throw new Error('INVALID_PARAMS: 顾客当前绑定门店非本门店，疗程卡只能在其绑定门店核销/开单')
    }
    if (cuRows.length > 0 && cuRows[0].became_member_at && new Date(cuRows[0].became_member_at) <= new Date()) {
      serviceOrderType = '售后'
    }
  } else {
    // 无法解析顾客（legacy client_user_id IS NULL 且未传 clientPhone）：无顾客可绑，退回「sale_item 售出门店 ∈ scope」
    // 兜底把关，杜绝 A 店凭他店订单行越权核销其剩余次数（卡跟顾客走的前提是有顾客；无顾客时按售出门店校验）。
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

  // 服务单可指派「本店员工 ∪ 本门店所属市场内开启出差支援的员工」，技能扩至四项（issue #210）；
  // 与 staff.list({ scene: 'service' }) 的候选口径同源，否则前端选得到、提交被拦。
  await assertEmployeesAssignableToStore(
    pg,
    [resolvedStaffWfId, ...normalizedItems.map((item) => item.employeeId)],
    ctx.auth.effectiveStoreId,
    {
      requireServiceSkills: true,
      skills: SERVICE_ORDER_ASSIGNABLE_SKILLS,
      assignmentScope: 'marketSupport',
    },
  )

  // serviceOrderId 在事务内由 generateServiceOrderId(client) 生成，保证 advisory lock
  // 持有窗口覆盖 SELECT MAX → INSERT 全程，闭合 TOCTOU
  let serviceOrderId
  const now = new Date()

  await pg.transaction(async (client) => {
    // 生成 serviceOrderId（内部独占 advisory_xact_lock(hashtext('service_order_id_gen'))，
    // 与 admin services.ts 跨端互锁）
    serviceOrderId = await generateServiceOrderId(client)

    // 创建服务单主表
    // partial unique 兜底 TOCTOU：
    //   uq_so_appointment(appointment_id) WHERE appointment_id IS NOT NULL — 同预约双 create
    //   uq_so_client_active(client_user_id) WHERE status NOT IN ('已完成','已取消') — 同顾客双 create（含待客户确认）
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
          normalizedRemark,
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

    // 创建服务明细
    for (const item of normalizedItems) {
      const serviceItemId = generateServiceItemId()

      // sale_items → product_skus + product_categories fallback：
      // 历史 sale_items（WorkFine migration 进入）这两列常为 NULL，导致看板"项目数 / 生美实耗"为 0。
      // 优先取 sale_items 上已快照值；为 NULL 时回退到 product_skus + product_categories。
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

    // 寄存单退款打标校验（M8）：service_items 已落库，反查是否含寄存卡。
    // remark 非必填：空备注按正常消耗计业绩（写提成 + 计消耗业绩，营业额分成按寄存单 sale_order 排除）。
    // 仅防误标：非寄存卡但误标「寄存单退款专用」预设 → 拒绝。
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
    const isDepositRefund = normalizedRemark === DEPOSIT_REFUND_REMARK
    if (isDepositRefund && !hasDeposit) {
      throw new Error('INVALID_PARAMS: 非寄存卡不可标记为寄存单退款')
    }

    // 审计日志
    await logOperation(client, ctx, 'service.create', 'service_order', serviceOrderId, {
      _v: 3,
      serviceOrderType,
      storeId: ctx.auth.effectiveStoreId,
      clientUserId: resolvedClientUserId,
      assignedEmployeeId: resolvedStaffWfId,
      itemCount: normalizedItems.length,
      appointmentId: appointmentId || null,
      remarkPresent: normalizedRemark.trim().length > 0,
      remarkLength: normalizedRemark.trim().length,
    })
  })

  ctx.result = {
    serviceOrderId,
    status: '待服务',
    message: '服务单已创建'
  }
}

/**
 * 开始服务（待服务 → 服务中）
 *
 * 预扣机制：服务开始时校验可用次数（扣除其他服务单预扣）+ 标记本服务单预扣（reserved_at），
 * 防止服务期间疗程卡被转换单/退款消耗。
 */
async function start(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  // 管理层模式是只读视角（requireManager 亦如此声明）。放开门店门后
  // `store_id = NULL OR assigned_employee_id = 本人` 会让管理层拿到自己被指派的单并写状态，
  // 与前端 isReadOnly 口径分叉且 operation_logs 追不回门店，故显式拒绝。
  if (ctx.auth.loginLevel === 'management') {
    throw new Error('PERMISSION_DENIED: 管理层模式仅支持只读操作')
  }

  // 门店门（#224）：本店单 ∪ 指派给本人的跨店支援单；下方第二道门把非店长收死在「指派给自己」
  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND (store_id = $2 OR assigned_employee_id = $3)',
    [serviceOrderId, ctx.auth.effectiveStoreId, ctx.auth.staffWfId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!isOrderStoreManager(ctx.auth, so) && !isAssignedToSelf(ctx.auth, so)) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  if (so.status !== '待服务') {
    throw new Error(`INVALID_PARAMS: 服务单当前状态为"${so.status}"，不可开始服务`)
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    // 1. 锁定本服务单关联的订单行。转换单在持有同一 sale_items 行锁后才会
    // 汇总预扣，因此二者不会通过各自过期的可用次数校验而超售。
    const items = await client.query(
      `SELECT sit.service_item_id,
              sit.sale_item_id,
              sit.session_used,
              sit.reserved_at,
              si.remaining_sessions,
              si.session_count,
              si.paid_sessions,
              si.product_type
         FROM service_items sit
         JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
       WHERE sit.service_order_id = $1`,
      [serviceOrderId]
    )

    const saleItemIds = [...new Set(items.rows.map((item) => item.sale_item_id))]
    if (saleItemIds.length === 0) {
      throw new Error('INVALID_PARAMS: 服务单缺少服务明细')
    }

    const lockedItems = await client.query(
      `SELECT sale_item_id, remaining_sessions, session_count, paid_sessions, product_type
         FROM sale_items
        WHERE sale_item_id = ANY($1)
        ORDER BY sale_item_id
        FOR UPDATE`,
      [saleItemIds]
    )
    if (lockedItems.rows.length !== saleItemIds.length) {
      throw new Error('INVALID_PARAMS: 部分订单行不存在')
    }
    const lockedBySaleItemId = new Map(lockedItems.rows.map((row) => [row.sale_item_id, row]))

    // 2. 在行锁持有期间汇总其他服务单已预扣的次数；当前服务单的多条明细要合并校验。
    const reservedRows = await client.query(
      `SELECT reserved_item.sale_item_id,
              COALESCE(SUM(reserved_item.session_used) FILTER (
                WHERE reserved_item.reserved_at IS NOT NULL
                  AND reserved_item.service_order_id != $2
                  AND reserved_order.status IN ('服务中', '待客户确认')
              ), 0) AS total_reserved
         FROM service_items reserved_item
         JOIN service_orders reserved_order
           ON reserved_order.service_order_id = reserved_item.service_order_id
        WHERE reserved_item.sale_item_id = ANY($1)
        GROUP BY reserved_item.sale_item_id`,
      [saleItemIds, serviceOrderId]
    )
    const reservedBySaleItemId = new Map(
      reservedRows.rows.map((row) => [row.sale_item_id, Number(row.total_reserved || 0)])
    )
    const requestedBySaleItemId = new Map()
    for (const item of items.rows) {
      requestedBySaleItemId.set(
        item.sale_item_id,
        (requestedBySaleItemId.get(item.sale_item_id) || 0) + Number(item.session_used || 0)
      )
    }

    for (const [saleItemId, requested] of requestedBySaleItemId) {
      const row = lockedBySaleItemId.get(saleItemId)

      // 家居产品跳过次数校验
      if (row.product_type !== '疗程卡') continue

      const reserved = reservedBySaleItemId.get(saleItemId) || 0
      const remainingAvailable = Number(row.remaining_sessions || 0) - reserved
      if (remainingAvailable < requested) {
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${saleItemId} 可用次数不足（剩余 ${row.remaining_sessions}，已预留 ${reserved}，本次需 ${requested}）`)
      }

      // paid_sessions 限额校验（与 finalizeServiceOrder 一致）
      if (row.session_count != null) {
        const paid = row.paid_sessions == null ? Number(row.session_count) : Number(row.paid_sessions)
        if (paid <= 0) {
          throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${saleItemId} 尚未支付，无可用次数，请先完成付款`)
        }
        const usedNow = Number(row.session_count) - Number(row.remaining_sessions)
        // 已预扣的服务同样占用已支付额度，不能只按已核销次数判断。
        const paidAvailable = paid - usedNow - reserved
        if (paidAvailable < requested) {
          throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${saleItemId} 已支付可用次数不足（已付 ${paid}/${row.session_count}，已核销 ${usedNow}，已预留 ${reserved}，本次需 ${requested}），请先完成付款`)
        }
      }
    }

    // 3. 更新服务单状态
    const result = await client.query(
      "UPDATE service_orders SET status = '服务中', started_at = $1, updated_at = $1 WHERE service_order_id = $2 AND status = '待服务'",
      [now, serviceOrderId]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 服务单状态已变更，请刷新后重试')
    }

    // 4. 标记预扣（幂等：ON CONFLICT DO NOTHING 或直接 UPDATE）
    await client.query(
      `UPDATE service_items
       SET reserved_at = $1, updated_at = $1
       WHERE service_order_id = $2 AND reserved_at IS NULL`,
      [now, serviceOrderId]
    )

    // 审计日志
    await logTransition(client, ctx, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中')
  })

  ctx.result = {
    serviceOrderId,
    status: '服务中',
    message: '服务已开始'
  }
}

/**
 * 加载服务单的所有 service_items + 关联 sale_items 快照（含 service_fee、sales_category）+ 员工 skills。
 * 一次 JOIN 拿全，避免 finalize 循环内 N 次查询。confirm 链路使用。
 */
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

/**
 * finalize 副作用（待客户确认 → 已完成）—— 顾客确认 / 店长代确认 共用。
 *
 * 跨端独立副本：与 clientApi utils/service-finalize.js、fengyu-admin services.ts 字面量一致，
 * 由 cross-end-sql-snapshot.test.js 守护。改一端必同步其它端。
 *
 * 在外层事务内执行：
 *   0. 按稳定顺序锁定关联 sale_items，与转换单/service.start 共用临界区
 *   1. 状态 待客户确认 → 已完成（CAS）后原子扣减每条 sale_items 的剩余次数
 *   2. 扣减成功后清除预扣标记（reserved_at = NULL）+ 归零关预约
 *   3. 计算并写入服务提成（service_commissions，双字段模型 + 缺率写 operation_logs）
 *
 * @param client 外层事务 pg client
 * @param so     服务单行
 * @param items  loadServiceItems 结果
 * @param ctx    用于 operation_logs operator 字段
 * @param now    时间戳
 * @returns {boolean} 状态翻转是否成功（rowCount>0）；false 表示已被其它入口确认（幂等）
 */
async function finalizeServiceOrder(client, so, items, ctx, now) {
  const serviceOrderId = so.service_order_id

  // 0. 先锁卡，禁止转换单在预扣释放和实际扣次之间取得可转次数。
  const saleItemIds = [...new Set(items.map((item) => item.sale_item_id))].sort()
  if (saleItemIds.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单缺少服务明细')
  }
  const lockedItems = await client.query(
    `SELECT sale_item_id
       FROM sale_items
      WHERE sale_item_id = ANY($1)
      ORDER BY sale_item_id
      FOR UPDATE`,
    [saleItemIds]
  )
  if (lockedItems.rowCount !== saleItemIds.length) {
    throw new Error('INVALID_PARAMS: 部分订单行不存在')
  }

  // 1. 状态 CAS 必须在扣次前完成；失败时不释放预扣，由已胜出的确认事务负责。
  const soUpdateResult = await client.query(
    "UPDATE service_orders SET status = '已完成', completed_at = $1, commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND status = '待客户确认'",
    [now, serviceOrderId]
  )
  if (soUpdateResult.rowCount === 0) {
    return false
  }

  // 2. 原子扣减每条订单行的剩余次数。
  // 可核销门店由 service.create 的「顾客绑定门店」校验把关，此处仅按 sale_item_id 扣减、不再比卡售出门店（卡跟顾客走）。
  for (const item of items) {
    // 原子扣减条件叠加 paid_sessions 限额（ticket 2026-05-19）：
    //   扣减后已用次数 (session_count - (remaining - sessionUsed)) 不得超 paid_sessions
    //   paid_sessions NULL 视为 session_count（兼容历史数据 / 旧 fixture）
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

  // 预扣仅在状态 CAS 与所有扣次均成功后释放。事务提交前 sale_items 行锁始终持有，
  // 转换单无法看见“预扣已清除但剩余次数尚未扣减”的中间状态。
  await client.query(
    `UPDATE service_items
     SET reserved_at = NULL, updated_at = $1
     WHERE service_order_id = $2`,
    [now, serviceOrderId]
  )

  // ========== 计算并写入服务提成（service_commissions）==========
  // 双字段模型：fixed_fee = service_fee × session_used
  //            consume_amount = unit_real_price × session_used × commission_rate
  //            commission_amount = fixed_fee + consume_amount
  // 说明：sale_items/service_items.unit_real_price 已是 per-session 单次价（如 5次卡 3500/5=700），
  //       直接作为每次消耗基准，无需再 ÷session_count。
  // roleType 取员工 skills[0] 自动推断；无 skills 兜底 '美容师'
  // commission_rate 缺失时 rate=0 + 写 operation_logs，不阻塞确认
  for (const row of items) {
    // 寄存单退款单（M8）：真扣次数、假消耗 → 跳过提成写入（仅当显式选「寄存单退款专用」备注打标时；remark 非必填，空备注按正常消耗计提成；此为 finalize 兜底防漏）
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

    // INSERT 提成记录：ON CONFLICT 保证幂等（partial unique index where is_void=false）
    // 注意：uq_svc_comm_item_emp_role 是 partial unique INDEX 不是 CONSTRAINT，
    // ON CONFLICT ON CONSTRAINT 形式会报 "constraint does not exist"，必须用列推断 + WHERE
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

  // 如关联预约，将预约状态更新为已完成
  if (so.appointment_id) {
    await client.query(
      "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
      [now, so.appointment_id]
    )
  }

  // 会员到店积分：失败仅记 points.visitGrantFailed，不阻断服务完成。
  // 按 service_date + client_user_id 幂等；员工 complete 阶段不发，仅最终 confirm 后发。
  await grantVisitPointsSafe(client, so, items, ctx, now)

  return true
}

/**
 * 员工标记完成服务（服务中 → 待客户确认）
 * 仅翻状态 + 记 staff_completed_at，不扣次数 / 不计提成 / 不关预约——这些副作用推迟到顾客确认。
 * 幂等：待客户确认 / 已完成 直接返回。
 */
async function complete(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  // 管理层模式只读（同 start）
  if (ctx.auth.loginLevel === 'management') {
    throw new Error('PERMISSION_DENIED: 管理层模式仅支持只读操作')
  }

  // 门店门（#224）：本店单 ∪ 指派给本人的跨店支援单；下方第二道门把非店长收死在「指派给自己」
  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND (store_id = $2 OR assigned_employee_id = $3)',
    [serviceOrderId, ctx.auth.effectiveStoreId, ctx.auth.staffWfId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!isOrderStoreManager(ctx.auth, so) && !isAssignedToSelf(ctx.auth, so)) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  // 幂等：已进入待客户确认或已完成
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
    // 审计日志
    await logTransition(client, ctx, 'service.complete', 'service_order', serviceOrderId, '服务中', '待客户确认')
  })

  ctx.result = {
    serviceOrderId,
    status: '待客户确认',
    message: '已标记完成，待客户确认'
  }
}

/**
 * 店长代客户确认（待客户确认 → 已完成）
 * 兜底入口：顾客不便用小程序时由店长代确认。执行 finalize 副作用（扣次数+计提成+关预约）。
 * 幂等：已完成 直接返回。
 */
async function confirm(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const serviceOrderId = payload.serviceOrderId || payload.serviceOrderNo
  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId')
  }

  // 确认保持「仅开单门店店长」（#224 未放宽）；与 cancel 同款，区分两种拒绝原因。
  // 店经理在服务单技能白名单内 → 店长本人也可能是外援，会看到自己的支援单进入「待客户确认」。
  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND (store_id = $2 OR assigned_employee_id = $3)',
    [serviceOrderId, ctx.auth.effectiveStoreId, ctx.auth.staffWfId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  if (!isInCurrentStore(ctx.auth, so)) {
    throw new Error('PERMISSION_DENIED: 支援服务单需由开单门店店长确认')
  }

  // 幂等：已完成
  if (so.status === '已完成') {
    ctx.result = { serviceOrderId, status: '已完成', message: '服务已完成（幂等）' }
    return
  }

  if (so.status !== '待客户确认') {
    throw new Error(`INVALID_STATE: 服务单当前状态为"${so.status}"，不可确认`)
  }

  // 冻结闭环（Bug I）：关联订单退款审批中禁止确认核销（否则扣次数与退款冲突 → 孤儿服务单/账实错乱）
  await assertNoPendingRefundByServiceOrder(pg, serviceOrderId)

  const items = await loadServiceItems(serviceOrderId)
  const now = new Date()

  let finalized = false
  let finalStatus = null
  await pg.transaction(async (client) => {
    finalized = await finalizeServiceOrder(client, so, items, ctx, now)
    if (!finalized) {
      // finalize 的状态守卫没命中：可能是顾客本人抢先确认了（→ 已完成），
      // 也可能是开单门店在这期间取消了（→ 已取消）。回读一次真实状态，
      // 否则并发取消会被报成「服务已完成（幂等）」，前端在刷新前一直显示错误终态。
      const cur = await client.query(
        'SELECT status FROM service_orders WHERE service_order_id = $1',
        [serviceOrderId]
      )
      finalStatus = cur.rows[0]?.status || null
      return
    }
    // 审计日志（仅本入口真正完成时记；finalize 共享副本不含日志，归属 handler 层）
    await logTransition(client, ctx, 'service.confirm', 'service_order', serviceOrderId, '待客户确认', '已完成', {
      clientUserId: so.client_user_id,
      itemCount: items.length,
    })
  })

  if (!finalized && finalStatus && finalStatus !== '已完成') {
    // 状态已被并发操作改走（如开单门店取消），据实回报而不是谎称已完成
    throw new Error(`CONFLICT: 服务单状态已变更为"${finalStatus}"，请刷新后重试`)
  }

  ctx.result = {
    serviceOrderId,
    status: finalized ? '已完成' : (finalStatus || '已完成'),
    message: finalized ? '服务已确认完成，次数已扣减' : '服务已完成（幂等）'
  }
}

/**
 * 服务单列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { status } = payload
  const { pageSize, offset, keyword, keywordPattern, phoneKeyword, startDate, endDate } = normalizeListFilters(payload)
  // 门店门（#224）按角色分支构造，不用「统一 OR + 再 AND 收窄」：
  //  - 非店长可见范围本就等价于「指派给本人」（`(store ∪ assigned) ∧ assigned ≡ assigned`），
  //    多写的 OR 纯属冗余，却会让 planner 从 idx_svc_orders_assigned_employee 退化成 BitmapOr
  //  - 店长才真需要 OR：本店全部 ∪ 自己的跨店支援单
  // 管理层模式（effectiveStoreId=null）必落非店长分支，条件即「指派给本人」，不放大权限。
  const params = []
  const conditions = []
  if (isCurrentStoreManager(ctx.auth)) {
    params.push(ctx.auth.effectiveStoreId, ctx.auth.staffWfId)
    conditions.push('(so.store_id = $1 OR so.assigned_employee_id = $2)')
  } else {
    params.push(ctx.auth.staffWfId)
    conditions.push('so.assigned_employee_id = $1')
  }

  if (status) {
    if (!['待服务', '服务中', '待客户确认', '已完成', '已取消'].includes(status)) {
      throw new Error('INVALID_PARAMS: status 不是有效服务单状态')
    }
    params.push(status)
    conditions.push(`so.status = $${params.length}`)
  }

  if (keyword) {
    params.push(keywordPattern)
    const nameParam = params.length
    const searchParts = [
      `COALESCE(wu.name, '') ILIKE $${nameParam} ESCAPE '\\'`,
      `EXISTS (
        SELECT 1 FROM sale_orders search_o
        WHERE search_o.client_user_id = so.client_user_id
          AND COALESCE(search_o.customer_name, '') ILIKE $${nameParam} ESCAPE '\\'
      )`,
    ]
    // 手机号匹配只对「能看到全号」的门店集开放（#224）：响应里跨店支援单的手机号是脱敏的，
    // 若仍允许拿原始全号去匹配，外援可逐位枚举 keyword 观察目标单是否出现在结果中，
    // 约 40 次请求就能还原被 **** 掩盖的 4 位，等于绕过脱敏。按姓名搜索不受影响。
    const phoneStoreIds = phoneSearchStoreIds(ctx.auth)
    if (phoneKeyword && phoneStoreIds.length > 0) {
      params.push(`%${phoneKeyword}%`)
      const phoneParam = params.length
      params.push(phoneStoreIds)
      searchParts.push(
        `(regexp_replace(COALESCE(wu.phone, ''), '[^0-9]', '', 'g') LIKE $${phoneParam} AND so.store_id = ANY($${params.length}::text[]))`
      )
    }
    conditions.push(`(${searchParts.join(' OR ')})`)
  }

  addDateRange(conditions, params, 'so.service_date', startDate, endDate)

  params.push(pageSize)
  const limitParam = params.length
  params.push(offset)
  const offsetParam = params.length

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
      so.store_id,
      st.store_name,
      wu.phone AS client_phone,
      wu.name AS client_name
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    LEFT JOIN stores st ON st.store_id = so.store_id
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY so.service_date DESC, so.created_at DESC, so.service_order_id DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, params)

  // 批量查询服务明细摘要
  const soIds = serviceOrders.map(s => s.service_order_id)
  let itemsSummary = []
  if (soIds.length > 0) {
    itemsSummary = await pg.query(`
      SELECT
        si.service_order_id,
        si.service_item_id,
        COALESCE(sli.product_name, '') AS product_name,
        sli.remaining_sessions,
        sli.session_count,
        sli.paid_sessions,
        sli.product_type,
        COALESCE(ps.unit, CASE WHEN sli.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
        si.service_duration
      FROM service_items si
      LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
      LEFT JOIN product_skus ps ON ps.sku_id = sli.sku_id
      WHERE si.service_order_id = ANY($1)
    `, [soIds])
  }

  const itemsMap = {}
  for (const i of itemsSummary) {
    if (!itemsMap[i.service_order_id]) itemsMap[i.service_order_id] = []
    itemsMap[i.service_order_id].push({
      // wxml 的 wx:for 用它做 wx:key —— 此前未下发，key 恒 undefined 导致列表 diff 错位
      serviceItemId: i.service_item_id,
      itemName: i.product_name,
      spec: '',
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
      paidSessions: i.paid_sessions,
      unit: i.unit || (i.product_type === '家居产品' ? '盒' : '次'),
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

  // 批量查询顾客姓名与归属门店
  // bound_store_id 是「店长特权」的第二条来源（顾客是我店的客户），detail 侧也用同一口径；
  // 搭这趟已有的批量查询顺带取回，避免同一张单在列表脱敏、点进详情却是全号（#224）
  const clientUserIds = [...new Set(serviceOrders.map(s => s.client_user_id).filter(Boolean))]
  let customerNameMap = {}
  const customerStoreMap = {}
  if (clientUserIds.length > 0) {
    for (const serviceOrder of serviceOrders) {
      if (serviceOrder.client_name) customerNameMap[serviceOrder.client_user_id] = serviceOrder.client_name
    }
    const nameRows = await pg.query(
      `SELECT user_id, name, bound_store_id FROM client_wechat_users WHERE user_id = ANY($1)`,
      [clientUserIds]
    )
    for (const r of nameRows) {
      if (r.name) customerNameMap[r.user_id] = r.name
      if (r.bound_store_id) customerStoreMap[r.user_id] = r.bound_store_id
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
    customerPhone: maskPhoneForOrder(ctx.auth, so, customerStoreMap[so.client_user_id]
      ? { bound_store_id: customerStoreMap[so.client_user_id] }
      : null),
    staffName: staffNameMap[so.assigned_employee_id] || '',
    assignedStaffWfId: so.assigned_employee_id,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    appointmentId: so.appointment_id,
    remark: so.remark || '',
    storeName: (so.store_name || '').trim(),
    inCurrentStore: isInCurrentStore(ctx.auth, so),
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

  // 交易数据跟顾客走：先不限门店查服务单，再分层判定可见性
  // （顾客档案的服务记录可跨门店查看任意服务单详情；管理层模式 effectiveStoreId=null 时本就需放开）
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
      st.store_name,
      wu.phone AS client_phone
    FROM service_orders so
    LEFT JOIN client_wechat_users wu ON so.client_user_id = wu.user_id
    LEFT JOIN stores st ON st.store_id = so.store_id
    WHERE so.service_order_id = $1
  `, [id])

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在')
  }

  const so = serviceOrders[0]

  // 分层可见性（与 order.detail 一致）：
  //  0) 服务单指派给本人 → 放行，**不要求门店在 scope 内**（跨店支援单，#224）。
  //     指派关系本身就是授权凭据（建单时已过 marketSupport 校验），此处不重算「锚定市场 + 出差标记」：
  //     重算会让出差标记一关掉，在途支援单立刻变不可见，且引入第 6 份锚定市场 SQL 副本。
  //  1) 服务单在本 scope 内 + 店长 → 门店操作权限放行（护理 Tab / 操作场景，行为不变）
  //  2) 管理层模式 + 服务单门店在本 scope 内 → 监管只读放行
  //  3) 服务单顾客在本 scope 内（bound_store_id ∈ scope）→ 顾客档案场景只读放行（含跨门店服务单）
  //  4) 都不满足 → 无权查看
  // 注：门店模式普通员工不靠 inStoreScope 放开（否则可看本店他人服务单），仅经分支 0/3。
  const inStoreScope = isStoreInScope(ctx.auth, so.store_id)
  const isManager = isCurrentStoreManager(ctx.auth)
  const isMgmt = ctx.auth.loginLevel === 'management'
  let visible = isAssignedToSelf(ctx.auth, so) || (inStoreScope && isManager)
  if (!visible && isMgmt && inStoreScope) {
    visible = true // 管理层监管本 scope 内服务单（只读）
  }
  // 顾客归属：可见性分支 3 与「店长特权」（全号手机 / 顾客评价）都要用，按需查一次后复用。
  // 不无条件预查——本店店长看本店单是最高频路径，那里两个用途都不需要它。
  let customer = null
  let customerLoaded = false
  const loadCustomer = async () => {
    if (customerLoaded || !so.client_user_id) return customer
    customerLoaded = true
    const custRows = await pg.query(
      'SELECT bound_store_id, bound_employee_id FROM client_wechat_users WHERE user_id = $1',
      [so.client_user_id]
    )
    customer = custRows[0] || null
    return customer
  }

  if (!visible && so.client_user_id && await loadCustomer()) {
    // 顾客在本 scope 内 → 可只读查看其任意服务单（含跨门店）：顾客档案服务记录场景。
    // 普通员工(store_staff)额外要求该顾客分配给本人（与 assertCustomerProfileVisible 同口径），
    // 否则可凭可枚举的 service_order_id 越权查看本店他人负责顾客的服务单详情。
    if (
      isStoreInScope(ctx.auth, customer.bound_store_id) &&
      (!restrictToBoundEmployee(ctx.auth) || customer.bound_employee_id === ctx.auth.staffWfId)
    ) {
      visible = true
    }
  }
  if (!visible) {
    throw new Error('PERMISSION_DENIED: 无权查看该服务单')
  }

  // 看非本店单时，店长特权可能来自「顾客是我的客户」这条来源，需要顾客归属才能判（#224）。
  // 管理层分支同样要覆盖——它可能经「监管 scope 内」提前放行而跳过上面的兜底加载，
  // 且 scopeStoreIds ⊋ managerStoreIds，单在 scope 内不等于在我管辖的门店内。
  // 本店单与无店长角色的身份都不必走这一步，高频路径因此不会多一次查询。
  const mayHaveManagerPrivilege = ctx.auth.loginLevel === 'management'
    ? hasValidManagerRole(ctx.auth) && !managerCoversStore(ctx.auth, so.store_id)
    : isCurrentStoreManager(ctx.auth) && !isInCurrentStore(ctx.auth, so)
  if (mayHaveManagerPrivilege) {
    await loadCustomer()
  }

  // 查询服务明细
  const items = await pg.query(`
    SELECT
      si.sale_item_id,
      si.session_used,
      si.service_duration,
      sli.session_count,
      sli.remaining_sessions,
      sli.paid_sessions,
      sli.product_type,
      sli.product_name,
      COALESCE(ps.unit, CASE WHEN sli.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit
    FROM service_items si
    LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
    LEFT JOIN product_skus ps ON ps.sku_id = sli.sku_id
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

  // 顾客评价：与全号手机同判据（店长对这张单有特权：我店的单 ∨ 我店的客户）；仅已完成单有评价。
  // 前端靠下发的 canViewReview 决定是否渲染评价区块——它自己无从知道顾客归属。
  const canViewReview = canReadFullPhone(ctx.auth, so, customer)
  let review
  if (canViewReview && so.status === '已完成') {
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
    customerPhone: maskPhoneForOrder(ctx.auth, so, customer),
    staffName,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    appointmentId: so.appointment_id,
    remark: so.remark || '',
    storeName: (so.store_name || '').trim(),
    inCurrentStore: isInCurrentStore(ctx.auth, so),
    canOperate: canOperateOrder(ctx.auth, so),
    canViewReview,
    review,
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      itemName: i.product_name || '',
      spec: '',
      sessionCount: i.session_used,
      serviceDuration: i.service_duration,
      remainingSessions: i.remaining_sessions,
      totalSessions: i.session_count,
      paidSessions: i.paid_sessions,
      unit: i.unit || (i.product_type === '家居产品' ? '盒' : '次'),
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

  // 取消保持「仅开单门店」（#224 已拍板）：取消属开单门店的调度决策，不由外援行使。
  // 一次查出「本店单 ∪ 指派给本人的单」再在 JS 侧分流，拆成两次查询会多占一条池连接（max 5）
  // 并引入文案 TOCTOU。门店归属判定复用 isInCurrentStore —— 与前端拿到的 inCurrentStore 同源。
  const serviceOrders = await pg.query(
    'SELECT * FROM service_orders WHERE service_order_id = $1 AND (store_id = $2 OR assigned_employee_id = $3)',
    [serviceOrderId, ctx.auth.effectiveStoreId, ctx.auth.staffWfId]
  )

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在或不属于本门店')
  }

  const so = serviceOrders[0]

  // 支援单现在看得见了（#224），沿用「不存在」文案会误导
  if (!isInCurrentStore(ctx.auth, so)) {
    throw new Error('PERMISSION_DENIED: 支援服务单需由开单门店取消')
  }

  if (!isOrderStoreManager(ctx.auth, so) && !isAssignedToSelf(ctx.auth, so)) {
    throw new Error('PERMISSION_DENIED: 无权操作该服务单')
  }

  // 确认前（待客户确认）店长可撤；确认后（已完成）不可取消，走退款链路
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

    // 释放预扣（清除 reserved_at）
    await client.query(
      `UPDATE service_items
       SET reserved_at = NULL, updated_at = $1
       WHERE service_order_id = $2`,
      [now, serviceOrderId]
    )

    // 审计日志
    await logTransition(client, ctx, 'service.cancel', 'service_order', serviceOrderId, so.status, '已取消')
  })

  ctx.result = {
    serviceOrderId,
    status: '已取消',
    message: '服务单已取消'
  }
}

// ========== 辅助函数 ==========

/**
 * 服务单是否指派给当前请求人本人。
 *
 * 六个入口均先过 requireStaffBound()，staffWfId 必非空；这里仍显式判空，
 * 避免将来被无守卫的调用方复用时 `undefined === undefined` 误判为放行。
 */
function isAssignedToSelf(auth, so) {
  return Boolean(auth && auth.staffWfId && so.assigned_employee_id === auth.staffWfId)
}

/**
 * 服务单是否属于当前生效门店（#224）。
 *
 * **必须与 cancel / confirm 的门店门 `store_id = $2` 严格同源**——前端用它决定是否渲染
 * 「取消服务单」「代客户确认」按钮，判据比后端窄或宽都会造出「按钮点了必报错」的死路：
 *   - `effectiveStoreId=null`（管理层模式，或门店模式解析不出门店的员工，auth.js:77-79）
 *     → SQL `store_id = NULL` 恒 0 行，此处同样返回 false
 *   - 别人负责的跨门店单（detail 分支 3 顾客档案兜底可打开）→ 两侧同样为 false
 *
 * 取反即「非本店单」，用于列表/详情展示开单门店名。不参与任何鉴权放行判定。
 */
function isInCurrentStore(auth, so) {
  return Boolean(auth && auth.effectiveStoreId && so.store_id === auth.effectiveStoreId)
}

/**
 * 当前请求人是否为**这张单所属门店**的店长（#224）。
 *
 * `isCurrentStoreManager` 只看请求人当前门店，与单的门店无关——直接用它做第二道门，
 * 对任何店长都恒真短路，整条边界就只剩第一道门 SQL 单点承担。这里显式与 `so.store_id`
 * 挂钩，让两道门重新互相独立。
 */
function isOrderStoreManager(auth, so) {
  return isCurrentStoreManager(auth) && isInCurrentStore(auth, so)
}

/**
 * 服务单顾客手机号的可见形态（#224）。
 *
 * 不能直接用通用的 `maskPhoneForAuth(phone, auth)`：它判的是「请求人在**自己当前门店**是不是店长」，
 * 而本次放开 assigned 后，A 店店长会以外援身份拿到 B 店的单——B 店根本不在他的店长 scope 内，
 * 沿用旧判据就会把 B 店顾客的完整手机号交出去，构成跨组织域 PII 泄露。
 * 店长特权一律与**这张单的门店**挂钩；仅因「指派给我」放行的跨店支援单按普通员工脱敏。
 */
function maskPhoneForOrder(auth, so, customer) {
  return canReadFullPhone(auth, so, customer) ? (so.client_phone || '') : maskPhone(so.client_phone)
}

/**
 * 是否有权读到这张单顾客的完整手机号（评价可见性同判据）。
 *
 * 店长特权有**两条独立来源**，缺一条就会误伤存量场景：
 *   ① 这是我店的单 —— 护理 Tab / 操作场景
 *   ② 这是我店的客户 —— 顾客档案里看他在别店做的服务单。顾客档案页本身就显示全号，
 *      只按单的门店判会让同一个号码在两个页面一个全号一个脱敏，且相对改动前是能力收缩
 * 外援场景两条都不满足（顾客与单都在别店），因此仍按普通员工脱敏——这正是要堵的泄露面。
 *
 * 管理层分支**必须按 `managerStoreIds` 判，不能用 `scopeStoreIds`**：后者是全角色并集，
 * 「manager@A 店 + finance@B 店」的账号在 B 店会同时满足 `hasValidManagerRole`（因 A 的绑定）
 * 与 `isStoreInScope`（因 B 的财务绑定），拼接出一个 B 店并不存在的店长特权。
 * 这正是 `requireManager()` 在 2026-05-21 堵掉的越权模式，PII 读取路径同样不能重蹈。
 *
 * @param customer 可选，`client_wechat_users` 行。list 不查顾客归属，传 undefined 即只按 ① 判——
 *                 其可见集是「本店单 ∪ 指派给本人」，不含「顾客在本店但单在别店」那类单。
 */
function canReadFullPhone(auth, so, customer) {
  if (!auth) return false
  if (auth.loginLevel === 'management') {
    if (!hasValidManagerRole(auth)) return false
    return managerCoversStore(auth, so.store_id)
      || (!!customer && managerCoversStore(auth, customer.bound_store_id))
  }
  if (!isCurrentStoreManager(auth)) return false
  return isInCurrentStore(auth, so)
    || (!!customer && !!customer.bound_store_id && customer.bound_store_id === auth.effectiveStoreId)
}

/** manager 角色是否覆盖该门店。**只看 managerStoreIds，绝不退回 scopeStoreIds**（见上方说明）。 */
function managerCoversStore(auth, storeId) {
  return Boolean(storeId) && Array.isArray(auth.managerStoreIds) && auth.managerStoreIds.includes(storeId)
}

/**
 * 允许用原始手机号参与列表搜索的门店集合（#224）。
 *
 * 必须与 `canReadFullPhone` 的门店口径一致：响应脱敏、搜索却拿全号匹配，
 * 等于开了个能逐位枚举还原隐藏 4 位的旁路。返回空数组表示该身份不得按手机号搜。
 */
function phoneSearchStoreIds(auth) {
  if (!auth) return []
  if (auth.loginLevel === 'management') {
    if (!hasValidManagerRole(auth) || !Array.isArray(auth.managerStoreIds)) return []
    return auth.managerStoreIds
  }
  return auth.effectiveStoreId ? [auth.effectiveStoreId] : []
}

/**
 * 是否可对该单执行 start / complete / cancel（即路由里的「第二道门」）。
 *
 * 下发给详情页驱动按钮显隐——detail 的顾客档案兜底分支能打开「本店、顾客绑给我、但指派给同事」
 * 的单，此时 inCurrentStore 为 true 却操作不了，不据此收口就会渲染出点了必报错的按钮。
 * 列表页无需此字段：list 的可见集恒为「本店单（店长）∪ 指派给本人」，两者都必然可操作。
 */
function canOperateOrder(auth, so) {
  // 管理层是只读视角，start/complete 会先于两道门直接拒绝——不带上这一条，
  // 字段契约就与接口实际行为不符（当前 WXML 另有 isReadOnly 兜底，但消费者不该依赖那个巧合）
  if (auth?.loginLevel === 'management') return false
  return isOrderStoreManager(auth, so) || isAssignedToSelf(auth, so)
}

/**
 * 生成服务单 ID
 *
 * advisory lock 必须与最终 INSERT 在同一事务内才能闭合 TOCTOU 窗口。
 * 调用方必须传入外层事务的 client，函数内不再自开 pg.transaction。
 *
 * lock key 与 admin services.ts 对齐：hashtext('service_order_id_gen')，
 * 保证 staffApi + admin 跨端互锁（旧的 Buffer 自定义 hash 与 admin 互不相交，
 * 会导致跨端并发撞号）。
 *
 * @param client 外层事务的 pg client（必传）
 */
async function generateServiceOrderId(client) {
  if (!client) {
    throw new Error('generateServiceOrderId: client is required (must be called inside an outer transaction)')
  }
  // dateStr 在事务内计算，避免跨午夜窗口
  const today = new Date()
  const dateStr = shanghaiYYMMDD(today)
  const likePattern = `HLD-WX-${dateStr}%`

  // 与 admin services.ts:522 对齐：hashtext('service_order_id_gen')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['service_order_id_gen'])
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

/**
 * 服务单各状态计数（轻量级，供前端 Tab badge 使用）
 */
async function counts(ctx) {
  await requireStaffBound()(ctx, async () => {})

  // 与 list 同口径同分支（#224），否则角标数与列表条数对不上
  const params = []
  let scopeFilter
  if (isCurrentStoreManager(ctx.auth)) {
    params.push(ctx.auth.effectiveStoreId, ctx.auth.staffWfId)
    scopeFilter = '(so.store_id = $1 OR so.assigned_employee_id = $2)'
  } else {
    params.push(ctx.auth.staffWfId)
    scopeFilter = 'so.assigned_employee_id = $1'
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
