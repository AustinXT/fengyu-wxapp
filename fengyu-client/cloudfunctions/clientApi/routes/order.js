/**
 * 订单模块路由
 * 客户端订单相关接口
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireFields } = require('../middleware/validate')
const { requirePhone } = require('../middleware/auth')

/**
 * 扫码查看订单详情（员工开单订单专用）
 * 不要求 client_user_id 匹配，仅限 order_source = 'staff' 的订单
 */
async function scanDetail(ctx) {
  const { orderNo } = ctx.event.payload || {}
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  const orders = await pg.query(
    "SELECT * FROM orders WHERE order_no = $1 AND order_source = 'staff'",
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 非待支付状态返回提示
  if (order.status !== '待支付') {
    const statusMsgMap = {
      '已支付': '该订单已完成支付',
      '已完成': '该订单已完成',
      '待确认收款': '该订单正在等待店长确认收款',
      '已关闭': '该订单已关闭',
      '支付失败': '该订单支付失败，请联系店员'
    }
    ctx.result = {
      orderNo: order.order_no,
      status: order.status,
      statusMsg: statusMsgMap[order.status] || `订单状态为「${order.status}」`
    }
    return
  }

  // 查询商品明细
  const items = await pg.query(`
    SELECT
      oi.item_flow_no, oi.unit_price, oi.quantity, oi.receivable,
      p.name AS spu_name, m.sku_display_name
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
    ORDER BY oi.item_flow_no
  `, [orderNo])

  const totalAmount = items.reduce((sum, i) => sum + Number(i.receivable || 0), 0)

  ctx.result = {
    order: {
      orderNo: order.order_no,
      status: order.status,
      storeName: order.store_name,
      orderType: order.order_type,
      totalAmount
    },
    items: items.map(i => ({
      itemFlowNo: i.item_flow_no,
      spuName: i.spu_name,
      skuDisplayName: i.sku_display_name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      receivable: i.receivable
    }))
  }
}

/**
 * 顾客自助下单
 * 创建订单 + 订单明细
 */
async function create(ctx) {
  // 必须绑定手机号
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload

  // 参数校验
  const {
    storeName,
    marketName,
    items, // [{ skuId, quantity }]
    preferredStaffWfId, // 可选,指定美容师
    paymentMethod, // 'wechat' | 'offline'
    orderType: orderTypeParam, // 可选, 'promo' | undefined
    promotionSchemeId: promoSchemeId // 可选, 促销方案编号
  } = payload

  if (!storeName || !marketName || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
    throw new Error('INVALID_PARAMS: 参数不完整')
  }

  // 检查是否已有待支付订单(部分唯一索引约束)
  const existingOrders = await pg.query(
    "SELECT order_no FROM orders WHERE client_user_id = $1 AND status = '待支付'",
    [userId]
  )
  if (existingOrders.length > 0) {
    throw new Error('INVALID_PARAMS: 您已有待支付订单,请先完成支付或取消订单')
  }

  // 生成订单号（在事务外先生成，订单号无唯一约束冲突风险因为有用户级唯一检查）
  const orderNo = await generateOrderNo()
  const now = new Date()

  // 查询 SKU 信息并从 WorkFine 读取价格（并行）
  const skuResults = await Promise.all(
    items.map(async (item) => {
      const skuInfo = await getSkuInfo(item.skuId)
      const workfinePrice = await getWorkfinePrice(skuInfo.workfine_item_id, skuInfo.workfine_source)
      return { item, skuInfo, workfinePrice }
    })
  )

  // 预计算明细数据（不含 itemFlowNo，流水号在事务内生成）
  let totalAmount = 0
  const itemsData = skuResults.map(({ item, skuInfo, workfinePrice }) => {
    const unitPrice = workfinePrice.originalPrice
    const quantity = item.quantity || 1
    const saleAmount = unitPrice * quantity
    totalAmount += saleAmount
    return {
      skuId: item.skuId,
      sessionCount: workfinePrice.sessionCount,
      remainingSessions: workfinePrice.sessionCount,
      unitPrice,
      quantity,
      unitDiscount: 0,
      saleAmount,
      receivable: saleAmount,
      received: 0,
      productType: skuInfo.product_type
    }
  })

  // 使用事务创建订单（流水号在事务内原子生成）
  await pg.transaction(async (client) => {
    // 获取 advisory lock 防止并发生成重复流水号
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['item_flow_no_gen'])

    // 在事务内查询今日最大序号（使用 client 而非 pg.query，确保同连接可见性）
    const today = new Date()
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT item_flow_no FROM order_items
       WHERE item_flow_no LIKE $1
       ORDER BY item_flow_no DESC
       LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )

    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].item_flow_no.slice(-4)) + 1
    }

    // 确定订单类型
    const orderType = orderTypeParam === 'promo' ? '促销方案' : '正式'
    const promotionSchemeId = promoSchemeId || null

    // 从 WorkFine 查询顾客姓名（按手机号）
    let customerName = null
    if (ctx.auth.phone) {
      try {
        const esc = v => String(v).replace(/'/g, "''")
        const nameRows = await mssql.query(`
          SELECT TOP 1 UDF_S_1476 AS name FROM UDT_S_311
          WHERE UDF_S_1478 = '${esc(ctx.auth.phone)}'
        `)
        if (nameRows.length > 0 && nameRows[0].name) {
          customerName = nameRows[0].name.trim()
        }
      } catch (_) {
        // WorkFine 查询失败不阻塞下单
      }
    }

    // 创建订单主表
    await client.query(
      `INSERT INTO orders (
        order_no, status, order_type, market_name, store_name,
        order_datetime, client_user_id, client_phone, customer_name,
        payment_method, order_source,
        preferred_staff_wf_id, created_at, updated_at
      ) VALUES ($1, '待支付', $2, $3, $4, $5, $6, $7, $8, $9, 'client', $10, $5, $5)`,
      [orderNo, orderType, marketName, storeName, now, userId, ctx.auth.phone || null, customerName, paymentMethod, preferredStaffWfId || null]
    )

    // 创建订单明细（流水号递增）
    for (let i = 0; i < itemsData.length; i++) {
      const itemFlowNo = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemsData[i]
      await client.query(
        `INSERT INTO order_items (
          item_flow_no, order_no, sku_id, session_count, remaining_sessions,
          unit_price, quantity, unit_discount, sale_amount, receivable, received,
          promotion_scheme_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          itemFlowNo, orderNo, d.skuId, d.sessionCount,
          d.remainingSessions, d.unitPrice, d.quantity,
          d.unitDiscount, d.saleAmount, d.receivable, d.received,
          promotionSchemeId
        ]
      )
    }
  })

  ctx.result = {
    orderNo,
    totalAmount,
    status: '待支付'
  }
}

/**
 * 发起微信支付
 * 返回预支付参数(实际支付由 payNotify 云函数处理)
 */
async function pay(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单（不限定 client_user_id）
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1',
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 权限：已绑定用户 → 校验一致；未绑定 → 仅允许员工开单订单
  if (order.client_user_id) {
    if (order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (order.order_source !== 'staff') {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  const now = new Date()

  // 自动绑定 client_user_id（仅 staff 来源且未绑定时）
  if (!order.client_user_id && order.order_source === 'staff') {
    await pg.query(
      'UPDATE orders SET client_user_id = $1, payment_method = $2, updated_at = $3 WHERE order_no = $4',
      [userId, 'wechat', now, orderNo]
    )
  } else {
    // 更新支付方式为微信支付
    await pg.query(
      "UPDATE orders SET payment_method = 'wechat', updated_at = $1 WHERE order_no = $2",
      [now, orderNo]
    )
  }

  // 计算总金额
  const items = await pg.query(
    'SELECT SUM(receivable) AS total FROM order_items WHERE order_no = $1',
    [orderNo]
  )
  const totalAmount = items[0].total || 0

  // TODO: 调用微信支付统一下单接口,生成预支付参数
  // 这里返回模拟数据,实际需要对接微信支付
  ctx.result = {
    orderNo,
    totalAmount,
    paymentParams: {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).substr(2),
      package: `prepay_id=wx${Date.now()}`,
      signType: 'MD5',
      paySign: 'mock_sign'
    }
  }
}

/**
 * 选择线下付款
 * 订单进入"待确认收款"状态
 */
async function offlinePay(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单（不限定 client_user_id）
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1',
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 权限：已绑定用户 → 校验一致；未绑定 → 仅允许员工开单订单
  if (order.client_user_id) {
    if (order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (order.order_source !== 'staff') {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许付款')
  }

  // 更新订单状态 + 自动绑定 + 设置支付方式
  const now = new Date()
  await pg.query(
    "UPDATE orders SET status = '待确认收款', client_user_id = COALESCE(client_user_id, $1), payment_method = 'offline', updated_at = $2 WHERE order_no = $3",
    [userId, now, orderNo]
  )

  ctx.result = {
    orderNo,
    status: '待确认收款',
    message: '已提交,等待店长确认收款'
  }
}

/**
 * 订单列表
 * 包含体验单
 */
async function list(ctx) {
  const { userId } = ctx.auth
  const { status } = ctx.event.payload || {}

  // 构造查询条件
  let whereClause = 'WHERE o.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND o.status = $${params.length}`
  }

  const orders = await pg.query(`
    SELECT
      o.order_no,
      o.status,
      o.order_type,
      o.market_name,
      o.store_name,
      o.order_datetime,
      o.payment_method,
      o.preferred_staff_wf_id,
      o.created_at,
      COALESCE((
        SELECT SUM(oi.receivable)
        FROM order_items oi
        WHERE oi.order_no = o.order_no
      ), 0) AS total_amount
    FROM orders o
    ${whereClause}
    ORDER BY o.created_at DESC
    LIMIT 100
  `, params)

  // 批量查询所有订单的明细项（含商品名称）
  if (orders.length > 0) {
    const orderNos = orders.map(o => o.order_no)
    const placeholders = orderNos.map((_, i) => `$${i + 1}`).join(',')
    const items = await pg.query(`
      SELECT
        oi.order_no,
        oi.item_flow_no,
        oi.quantity,
        oi.remaining_sessions,
        p.name AS spu_name,
        m.sku_display_name,
        m.product_type
      FROM order_items oi
      LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
      LEFT JOIN product_spu p ON m.spu_id = p.spu_id
      WHERE oi.order_no IN (${placeholders})
      ORDER BY oi.item_flow_no
    `, orderNos)

    // 按订单号分组
    const itemsMap = new Map()
    for (const item of items) {
      if (!itemsMap.has(item.order_no)) {
        itemsMap.set(item.order_no, [])
      }
      itemsMap.get(item.order_no).push(item)
    }

    // 挂载到每个订单上
    for (const order of orders) {
      order.items = itemsMap.get(order.order_no) || []
    }
  }

  ctx.result = {
    orders
  }
}

/**
 * 订单详情
 * 包含明细 + 剩余次数
 */
async function detail(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单主表
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 查询订单明细
  const items = await pg.query(`
    SELECT
      oi.item_flow_no,
      oi.sku_id,
      oi.session_count,
      oi.remaining_sessions,
      oi.unit_price,
      oi.quantity,
      oi.sale_amount,
      oi.receivable,
      oi.received,
      oi.expire_date,
      p.name AS spu_name,
      m.sku_display_name,
      m.product_type
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
    ORDER BY oi.item_flow_no
  `, [orderNo])

  // 计算总金额
  const totalAmount = items.reduce((sum, item) => sum + Number(item.receivable || 0), 0)

  ctx.result = {
    order: {
      ...order,
      total_amount: totalAmount
    },
    items
  }
}

/**
 * 取消订单
 * 仅可取消待支付状态的订单
 */
async function cancel(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 当前订单状态不允许取消')
  }

  // 更新订单状态为已关闭
  const now = new Date()
  await pg.query(
    "UPDATE orders SET status = '已关闭', updated_at = $1 WHERE order_no = $2",
    [now, orderNo]
  )

  ctx.result = {
    orderNo,
    status: '已关闭',
    message: '订单已取消'
  }
}

/**
 * 获取可预约项目列表
 * 查询已支付订单中有剩余次数的项目(疗程卡/单品)
 * 性能优化:一次查询获取所有可预约项目,无需 order.list + order.detail 组合
 */
async function appointableItems(ctx) {
  const { userId } = ctx.auth

  // 查询已支付订单中有剩余次数的项目
  const items = await pg.query(`
    SELECT
      o.order_no,
      o.status AS order_status,
      o.store_name,
      o.market_name,
      o.preferred_staff_wf_id,
      oi.item_flow_no,
      oi.sku_id,
      oi.session_count,
      oi.remaining_sessions,
      oi.unit_price,
      oi.sale_amount,
      oi.expire_date,
      p.spu_id,
      p.name AS spu_name,
      p.category,
      p.big_category,
      m.sku_display_name,
      m.product_type,
      m.workfine_item_id,
      m.workfine_source
    FROM orders o
    INNER JOIN order_items oi ON o.order_no = oi.order_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE o.client_user_id = $1
      AND o.status = '已支付'
      AND oi.remaining_sessions > 0
      AND (oi.expire_date IS NULL OR oi.expire_date > CURRENT_DATE)
      AND m.product_type IN ('疗程卡', '单品')
    ORDER BY o.paid_at DESC, oi.item_flow_no
  `, [userId])

  // 按订单号分组
  const orderMap = new Map()
  for (const item of items) {
    if (!orderMap.has(item.order_no)) {
      orderMap.set(item.order_no, {
        orderNo: item.order_no,
        orderStatus: item.order_status,
        storeName: item.store_name,
        marketName: item.market_name,
        preferredStaffWfId: item.preferred_staff_wf_id,
        items: []
      })
    }
    orderMap.get(item.order_no).items.push({
      itemFlowNo: item.item_flow_no,
      skuId: item.sku_id,
      spuId: item.spu_id,
      spuName: item.spu_name,
      category: item.category,
      bigCategory: item.big_category,
      skuDisplayName: item.sku_display_name,
      productType: item.product_type,
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      unitPrice: item.unit_price,
      saleAmount: item.sale_amount,
      expireDate: item.expire_date,
      workfineItemId: item.workfine_item_id,
      workfineSource: item.workfine_source
    })
  }

  ctx.result = {
    orders: Array.from(orderMap.values())
  }
}

// ========== 辅助函数 ==========

/**
 * 生成订单号
 * 格式: FY-XSD-WX-{YYMMDD}{序号}
 */
async function generateOrderNo() {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  // 查询今日最大序号
  const result = await pg.query(`
    SELECT order_no FROM orders
    WHERE order_no LIKE 'FY-XSD-WX-${dateStr}%'
    ORDER BY order_no DESC
    LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    const lastNo = result[0].order_no
    seq = parseInt(lastNo.slice(-4)) + 1
  }

  return `FY-XSD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

/**
 * 获取 SKU 信息
 */
async function getSkuInfo(skuId) {
  const result = await pg.query(
    'SELECT sku_id, workfine_item_id, workfine_source, product_type FROM product_spu_sku_map WHERE sku_id = $1',
    [skuId]
  )

  if (result.length === 0) {
    throw new Error(`INVALID_PARAMS: SKU ${skuId} 不存在`)
  }

  return result[0]
}

/**
 * 从 WorkFine 读取价格信息
 */
async function getWorkfinePrice(workfineItemId, workfineSource) {
  if (!workfineItemId || !workfineSource) {
    throw new Error(`INVALID_PARAMS: WorkFine 参数缺失 (itemId=${workfineItemId}, source=${workfineSource})`)
  }

  let sql = ''

  if (workfineSource === 'UDT_M_1281') {
    sql = `
      SELECT
        UDF_M_14508 AS original_price,
        UDF_M_14506 AS session_count
      FROM UDT_M_1281
      WHERE UDF_M_14503 = '${workfineItemId}'
    `
  } else if (workfineSource === 'UDT_M_1383') {
    sql = `
      SELECT
        UDF_M_14508 AS original_price,
        UDF_M_14506 AS session_count
      FROM UDT_M_1383
      WHERE UDF_M_14503 = '${workfineItemId}'
    `
  } else if (workfineSource === 'UDT_M_341') {
    sql = `
      SELECT
        UDF_M_1875 AS original_price,
        NULL AS session_count
      FROM UDT_M_341
      WHERE UDF_M_1870 = '${workfineItemId}'
    `
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
  pay,
  offlinePay,
  list,
  detail,
  cancel,
  appointableItems,
  scanDetail
}
