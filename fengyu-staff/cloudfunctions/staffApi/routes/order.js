/**
 * 订单模块路由（员工端）
 * order.create — 员工开单（店长专用）
 * order.qrcode — 查询订单二维码状态
 * order.confirmOffline — 确认线下收款（店长专用）
 * order.close — 关闭订单（店长专用）
 * order.resetFailed — 重置支付失败订单（店长专用）
 * order.list — 订单列表
 * order.detail — 订单详情
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireStaffBound, requireManager } = require('../middleware/auth')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')

// 模块级缓存：orderNo → qrcodeUrl，避免轮询时重复生成
const qrcodeCache = new Map()

/**
 * 员工开单（店长专用）
 * payload: {
 *   clientPhone: string,       // 顾客手机号（必填）
 *   clientName: string,        // 顾客姓名（必填）
 *   storeName: string,         // 开单门店（可选，默认用当前员工门店）
 *   marketName: string,        // 市场（可选）
 *   orderType: '正式'|'体验'|'促销方案',
 *   items: [{ skuId, quantity, customPrice? }],
 *   paymentMethod: 'wechat'|'offline',
 *   preferredStaffWfId: string // 指定美容师（可选）
 * }
 */
async function create(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientPhone,
    clientName,
    items,
    paymentMethod,
    orderType: orderTypeParam,
    preferredStaffWfId
  } = payload

  let storeName = payload.storeName || ctx.auth.storeName
  let marketName = payload.marketName || ctx.auth.marketName

  if (!clientPhone) {
    throw new Error('INVALID_PARAMS: 顾客手机号为必填项')
  }
  if (!clientName) {
    throw new Error('INVALID_PARAMS: 顾客姓名为必填项')
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 商品明细不能为空')
  }
  if (!paymentMethod) {
    throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  }
  if (!storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeName')
  }

  // 映射前端 orderType（normal/experience/promotion）→ 后端中文值
  const ORDER_TYPE_MAP = { normal: '正式', experience: '体验', promotion: '促销方案' }
  const orderType = ORDER_TYPE_MAP[orderTypeParam] || orderTypeParam || '正式'
  if (!['正式', '体验', '促销方案'].includes(orderType)) {
    throw new Error('INVALID_PARAMS: orderType 值不合法')
  }

  // 查询顾客是否已注册客户端小程序（按手机号）
  const clientUsers = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  const clientUserId = clientUsers.length > 0 ? clientUsers[0].user_id : null

  // 检查是否已有待支付订单（同门店 + 同手机号）
  if (clientUserId) {
    const existing = await pg.query(
      "SELECT order_no FROM orders WHERE client_user_id = $1 AND status = '待支付' LIMIT 1",
      [clientUserId]
    )
    if (existing.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }
  } else {
    const existing = await pg.query(
      "SELECT order_no FROM orders WHERE client_phone = $1 AND store_name = $2 AND status = '待支付' LIMIT 1",
      [clientPhone, storeName]
    )
    if (existing.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }
  }

  // 获取 SKU 信息 + WorkFine 价格（并行）
  const itemDataList = await Promise.all(
    items.map(async (item) => {
      const skuRows = await pg.query(
        'SELECT sku_id, workfine_item_id, workfine_source, product_type FROM product_spu_sku_map WHERE sku_id = $1',
        [item.skuId]
      )
      if (skuRows.length === 0) {
        throw new Error(`INVALID_PARAMS: SKU ${item.skuId} 不存在`)
      }
      const sku = skuRows[0]

      // 体验单允许自定义价格，其他从 WorkFine 读取
      let unitPrice
      let sessionCount = null

      if (orderType === '体验' && item.customPrice !== undefined) {
        unitPrice = Number(item.customPrice)
        sessionCount = 1 // 体验单按单品处理，1次
      } else {
        const wfData = await getWorkfinePrice(sku.workfine_item_id, sku.workfine_source)
        unitPrice = wfData.originalPrice
        sessionCount = wfData.sessionCount
      }

      const quantity = item.quantity || 1
      const saleAmount = unitPrice * quantity

      // 优惠金额（前端按行传入总优惠）
      const discount = Number(item.discount) || 0
      if (discount < 0 || discount > saleAmount) {
        throw new Error('INVALID_PARAMS: 优惠金额不合法')
      }
      const unitDiscount = quantity > 0 ? discount / quantity : 0
      const receivable = saleAmount - discount

      return {
        skuId: item.skuId,
        productType: sku.product_type,
        sessionCount,
        remainingSessions: sessionCount,
        unitPrice,
        quantity,
        unitDiscount,
        saleAmount,
        receivable,
        received: 0
      }
    })
  )

  const now = new Date()
  const orderNo = await generateOrderNo(storeName)

  await pg.transaction(async (client) => {
    // Advisory lock 防并发流水号冲突
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['item_flow_no_gen'])

    const today = now
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT item_flow_no FROM order_items
       WHERE item_flow_no LIKE $1
       ORDER BY item_flow_no DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].item_flow_no.slice(-4)) + 1
    }

    // 创建订单主表
    await client.query(
      `INSERT INTO orders (
        order_no, status, order_type, market_name, store_name,
        order_datetime, client_user_id, client_phone, customer_name,
        payment_method, order_source, opened_by,
        preferred_staff_wf_id, created_at, updated_at
      ) VALUES ($1, '待支付', $2, $3, $4, $5, $6, $7, $8, $9, 'staff', $10, $11, $5, $5)`,
      [
        orderNo, orderType, marketName || '', storeName, now,
        clientUserId, clientPhone, clientName,
        paymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null
      ]
    )

    // 创建订单明细
    for (let i = 0; i < itemDataList.length; i++) {
      const itemFlowNo = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]

      // 院装产品无 session_count
      const productType = d.productType
      const sc = productType === '院装产品' ? null : d.sessionCount
      const rs = productType === '院装产品' ? null : d.remainingSessions

      await client.query(
        `INSERT INTO order_items (
          item_flow_no, order_no, sku_id, session_count, remaining_sessions,
          unit_price, quantity, unit_discount, sale_amount, receivable, received
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          itemFlowNo, orderNo, d.skuId, sc, rs,
          d.unitPrice, d.quantity, d.unitDiscount,
          d.saleAmount, d.receivable, d.received
        ]
      )
    }
  })

  const totalAmount = itemDataList.reduce((sum, d) => sum + d.receivable, 0)

  ctx.result = {
    orderNo,
    totalAmount,
    status: '待支付',
    clientUserId,
    message: '开单成功'
  }
}

/**
 * 订单二维码状态
 * 返回订单信息和当前状态，供前端展示二维码
 * 二维码内容由前端生成（encode 订单号 + 小程序路径）
 */
async function qrcode(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    `SELECT o.order_no, o.status, o.order_type, o.client_phone, o.customer_name,
            o.payment_method, o.paid_at, o.store_name, o.opened_by
     FROM orders o
     WHERE o.order_no = $1`,
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 仅本店员工可查看（店长或开单员工）
  if (ctx.auth.position !== '门店经理' && order.store_name !== ctx.auth.storeName) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  const items = await pg.query(`
    SELECT
      oi.item_flow_no, oi.receivable,
      p.name AS spu_name, m.sku_display_name
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
  `, [orderNo])

  const totalAmount = items.reduce((s, i) => s + Number(i.receivable || 0), 0)

  // 推导二维码显示状态
  let qrCodeStatus
  if (['已支付', '已完成'].includes(order.status)) {
    qrCodeStatus = '已支付'
  } else if (order.status === '待确认收款') {
    qrCodeStatus = '待确认收款'
  } else if (order.status === '待支付') {
    qrCodeStatus = '待扫码'
  } else {
    qrCodeStatus = order.status // 支付失败/已关闭
  }

  // 仅待支付订单生成小程序码（带缓存）
  let qrcodeUrl = ''
  let qrcodeError = ''
  if (order.status === '待支付') {
    if (qrcodeCache.has(orderNo)) {
      qrcodeUrl = qrcodeCache.get(orderNo)
    } else {
      try {
        const buffer = await generateWxacode(orderNo, 'pages/scan-pay/scan-pay')
        const cloudPath = `wxacode/order/${orderNo}.png`
        qrcodeUrl = await uploadToCloudStorage(buffer, cloudPath)
        qrcodeCache.set(orderNo, qrcodeUrl)
      } catch (err) {
        console.error('[order.qrcode] 生成小程序码失败:', err)
        qrcodeError = err.message || '生成小程序码失败'
      }
    }
  }

  ctx.result = {
    orderNo: order.order_no,
    status: order.status,
    qrCodeStatus,
    orderType: order.order_type,
    clientPhone: order.client_phone,
    customerName: order.customer_name,
    paymentMethod: order.payment_method,
    paidAt: order.paid_at,
    openedBy: order.opened_by,
    totalAmount,
    items: items.map(i => ({
      itemFlowNo: i.item_flow_no,
      spuName: i.spu_name,
      skuDisplayName: i.sku_display_name,
      receivable: i.receivable
    })),
    qrcodeUrl,
    qrcodeError
  }
}

/**
 * 确认线下收款（店长专用）
 * 将订单从"待确认收款"更新为"已支付"
 * 并触发：院装产品行直接完成 + 自动营业额分配（若有指定美容师）
 */
async function confirmOffline(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    "SELECT * FROM orders WHERE order_no = $1 AND store_name = $2",
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (order.status === '待支付' && order.payment_method !== 'offline') {
    throw new Error(`INVALID_PARAMS: 非线下支付订单不可直接确认收款`)
  }
  if (!['待确认收款', '待支付'].includes(order.status)) {
    throw new Error(`INVALID_PARAMS: 订单当前状态为"${order.status}"，不可确认收款`)
  }

  const now = new Date()

  // 查询订单明细，用于计算实收金额
  const items = await pg.query(
    `SELECT oi.item_flow_no, oi.sku_id, oi.receivable, m.product_type
     FROM order_items oi
     LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
     WHERE oi.order_no = $1`,
    [orderNo]
  )

  const totalReceived = items.reduce((s, i) => s + Number(i.receivable || 0), 0)

  await pg.transaction(async (client) => {
    // 更新订单状态
    await client.query(
      `UPDATE orders
       SET status = '已支付', paid_at = $1, updated_at = $1,
           offline_confirmed_by = $2, offline_confirmed_at = $1
       WHERE order_no = $3`,
      [now, ctx.auth.staffWfId, orderNo]
    )

    // 更新实收金额
    await client.query(
      `UPDATE order_items SET received = receivable WHERE order_no = $1`,
      [orderNo]
    )

    // 单品到期日写入（paid_at + 1年）
    await client.query(
      `UPDATE order_items oi
       SET expire_date = ($1::date + INTERVAL '1 year')
       FROM product_spu_sku_map m
       WHERE oi.sku_id = m.sku_id
         AND m.product_type = '单品'
         AND oi.order_no = $2
         AND oi.expire_date IS NULL`,
      [now, orderNo]
    )

    // 自动营业额分配（顾客指定了美容师且无分配记录时）
    if (order.preferred_staff_wf_id) {
      const existAlloc = await client.query(
        'SELECT id FROM revenue_allocations WHERE order_no = $1 AND is_void = false LIMIT 1',
        [orderNo]
      )
      if (existAlloc.rows.length === 0) {
        const allocId = await client.query(
          `INSERT INTO revenue_allocations
             (order_no, employee_id, allocation_ratio, total_amount, is_void, created_at, updated_at)
           VALUES ($1, $2, 1.0, $3, false, $4, $4)
           RETURNING id`,
          [orderNo, order.preferred_staff_wf_id, totalReceived, now]
        )
        // 插入默认分类明细（单品分类）
        await client.query(
          `INSERT INTO revenue_allocation_items (allocation_id, performance_category, amount)
           VALUES ($1, '单品', $2)`,
          [allocId.rows[0].id, totalReceived]
        )
      }
    }
  })

  ctx.result = {
    orderNo,
    status: '已支付',
    paidAt: now,
    totalReceived,
    message: '线下收款已确认'
  }
}

/**
 * 关闭订单
 * 店长：可关闭"待支付/待确认收款/支付失败"的订单
 * 开单员工：可关闭自己开的"待支付"订单
 * 同时将分配记录标记为无效
 */
async function close(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    "SELECT * FROM orders WHERE order_no = $1 AND store_name = $2",
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]
  const isManagerRole = ctx.auth.position === '门店经理'
  const isCreator = order.opened_by === ctx.auth.staffWfId

  if (isManagerRole) {
    // 店长：待支付/待确认收款/支付失败 均可关闭
    if (!['待支付', '待确认收款', '支付失败'].includes(order.status)) {
      throw new Error(`INVALID_PARAMS: 订单当前状态"${order.status}"不允许关闭`)
    }
  } else if (isCreator) {
    // 开单员工：仅限关闭自己开的待支付订单
    if (order.status !== '待支付') {
      throw new Error(`INVALID_PARAMS: 订单当前状态"${order.status}"不允许取消`)
    }
  } else {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    await client.query(
      "UPDATE orders SET status = '已关闭', updated_at = $1 WHERE order_no = $2",
      [now, orderNo]
    )
    // 作废营业额分配
    await client.query(
      "UPDATE revenue_allocations SET is_void = true, voided_at = $1, updated_at = $1 WHERE order_no = $2 AND is_void = false",
      [now, orderNo]
    )
  })

  ctx.result = {
    orderNo,
    status: '已关闭',
    message: '订单已关闭'
  }
}

/**
 * 重置支付失败订单（店长专用）
 * 将"支付失败"订单重置为"待支付"，允许重新付款
 */
async function resetFailed(ctx) {
  await requireManager()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    "SELECT * FROM orders WHERE order_no = $1 AND store_name = $2",
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '支付失败') {
    throw new Error('INVALID_PARAMS: 订单状态不是支付失败，无法重置')
  }

  const now = new Date()
  await pg.query(
    "UPDATE orders SET status = '待支付', updated_at = $1 WHERE order_no = $2",
    [now, orderNo]
  )

  ctx.result = {
    orderNo,
    status: '待支付',
    message: '订单已重置，顾客可重新发起付款'
  }
}

/**
 * 订单列表
 * 店长：查看本店所有订单
 * 美容师：查看与自己相关的订单（preferred_staff_wf_id 匹配）
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeName, pageSize, offset]
  let whereExtra = ''

  if (status) {
    params.push(status)
    whereExtra += ` AND o.status = $${params.length}`
  }

  // 美容师只能看到指定自己的订单
  if (ctx.auth.position !== '门店经理') {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND o.preferred_staff_wf_id = $${params.length}`
  }

  const orders = await pg.query(`
    SELECT
      o.order_no, o.status, o.order_type, o.client_phone, o.customer_name,
      o.payment_method, o.order_source, o.preferred_staff_wf_id,
      o.paid_at, o.created_at, o.opened_by,
      COALESCE((
        SELECT SUM(oi.receivable) FROM order_items oi WHERE oi.order_no = o.order_no
      ), 0) AS total_amount
    FROM orders o
    WHERE o.store_name = $1
    ${whereExtra}
    ORDER BY o.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = { orders, page, pageSize }
}

/**
 * 订单详情
 * 含明细、营业额分配信息
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo')
  }

  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND store_name = $2',
    [orderNo, ctx.auth.storeName]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  // 美容师只能看指定自己的订单
  if (ctx.auth.position !== '门店经理' && order.preferred_staff_wf_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  // 兜底补充顾客信息（兼容历史订单）
  if (!order.client_phone && order.client_user_id) {
    const clientRows = await pg.query(
      'SELECT phone FROM client_wechat_users WHERE user_id = $1 LIMIT 1',
      [order.client_user_id]
    )
    if (clientRows.length > 0 && clientRows[0].phone) {
      order.client_phone = clientRows[0].phone
    }
  }
  if (!order.customer_name && order.client_phone) {
    try {
      const pool = await mssql.getPool()
      const nameResult = await pool.request()
        .input('phone', order.client_phone)
        .query('SELECT TOP 1 UDF_S_1476 AS name FROM UDT_S_311 WHERE UDF_S_1478 = @phone')
      if (nameResult.recordset.length > 0 && nameResult.recordset[0].name) {
        order.customer_name = nameResult.recordset[0].name.trim()
      }
    } catch (_) {
      // WorkFine 查询失败不阻塞详情展示
    }
  }

  // 解析指定美容师姓名
  if (order.preferred_staff_wf_id) {
    const pool = await mssql.getPool()
    const staffResult = await pool.request()
      .input('id', order.preferred_staff_wf_id)
      .query(`SELECT UDF_S_1155 AS name FROM UDT_S_287 WHERE UDF_S_1147 = @id`)
    if (staffResult.recordset.length > 0) {
      order.preferred_staff_name = (staffResult.recordset[0].name || '').trim()
    }
  }

  const items = await pg.query(`
    SELECT
      oi.item_flow_no, oi.sku_id, oi.session_count, oi.remaining_sessions,
      oi.unit_price, oi.quantity, oi.sale_amount, oi.receivable, oi.received,
      oi.expire_date, oi.remark,
      p.name AS spu_name, m.sku_display_name, m.product_type
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
    ORDER BY oi.item_flow_no
  `, [orderNo])

  const totalAmount = items.reduce((s, i) => s + Number(i.receivable || 0), 0)

  // 营业额分配
  const allocations = await pg.query(`
    SELECT
      ra.id, ra.employee_id, ra.allocation_ratio, ra.total_amount, ra.is_void,
      rai.performance_category, rai.amount AS category_amount
    FROM revenue_allocations ra
    LEFT JOIN revenue_allocation_items rai ON rai.allocation_id = ra.id
    WHERE ra.order_no = $1
    ORDER BY ra.id, rai.id
  `, [orderNo])

  // 按分配记录分组
  const allocMap = {}
  for (const r of allocations) {
    if (!allocMap[r.id]) {
      allocMap[r.id] = {
        id: r.id,
        employeeId: r.employee_id,
        allocationRatio: r.allocation_ratio,
        totalAmount: r.total_amount,
        isVoid: r.is_void,
        items: []
      }
    }
    if (r.performance_category) {
      allocMap[r.id].items.push({
        category: r.performance_category,
        amount: r.category_amount
      })
    }
  }

  ctx.result = {
    order: { ...order, totalAmount },
    items,
    allocations: Object.values(allocMap)
  }
}

// ========== 辅助函数 ==========

/**
 * 生成订单号：FY-XSD-WX-{YYMMDD}{4位序号}
 */
async function generateOrderNo(storeName) {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  const result = await pg.query(`
    SELECT order_no FROM orders
    WHERE order_no LIKE 'FY-XSD-WX-${dateStr}%'
    ORDER BY order_no DESC LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    seq = parseInt(result[0].order_no.slice(-4)) + 1
  }

  return `FY-XSD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

/**
 * 从 WorkFine 读取价格/次数（单条查询，开单时使用）
 */
async function getWorkfinePrice(workfineItemId, workfineSource) {
  if (!workfineItemId || !workfineSource) {
    throw new Error(`INVALID_PARAMS: WorkFine 参数缺失`)
  }

  const esc = (v) => String(v).replace(/'/g, "''")
  let sql = ''

  if (workfineSource === 'UDT_M_1281') {
    sql = `SELECT UDF_M_14508 AS original_price, UDF_M_14506 AS session_count
           FROM UDT_M_1281 WHERE UDF_M_14503 = '${esc(workfineItemId)}'`
  } else if (workfineSource === 'UDT_M_1383') {
    sql = `SELECT UDF_M_14508 AS original_price, UDF_M_14506 AS session_count
           FROM UDT_M_1383 WHERE UDF_M_14503 = '${esc(workfineItemId)}'`
  } else if (workfineSource === 'UDT_M_341') {
    sql = `SELECT UDF_M_1875 AS original_price, NULL AS session_count
           FROM UDT_M_341 WHERE UDF_M_1870 = '${esc(workfineItemId)}'`
  } else if (workfineSource === 'UDT_M_1460') {
    sql = `SELECT UDF_M_17171 AS original_price, UDF_M_17167 AS session_count
           FROM UDT_M_1460 WHERE UDF_M_17163 = '${esc(workfineItemId)}'`
  } else {
    throw new Error(`INVALID_PARAMS: 未知 workfine_source: ${workfineSource}`)
  }

  const result = await mssql.query(sql)

  if (result.length === 0) {
    throw new Error(`INVALID_PARAMS: WorkFine 项目 ${workfineItemId} 不存在`)
  }

  return {
    originalPrice: result[0].original_price,
    sessionCount: result[0].session_count
  }
}

module.exports = {
  create,
  qrcode,
  confirmOffline,
  close,
  resetFailed,
  list,
  detail
}
