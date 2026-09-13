/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 * staff.uploadAvatar — 员工头像上传（HTTPS POST 转发到 clientApi 写入 client env COS）
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')
const pg = require('../db/pg')
const { requireStaffBound, invalidateAuthCache, isCurrentStoreManager } = require('../middleware/auth')
const { assertEmployeeInScope, isStoreInScope, buildStoreScopeCondition } = require('../utils/scope')
const { shanghaiDateStr } = require('../utils/datetime')
const { SALES_CATEGORIES, UNCATEGORIZED } = require('../utils/sales-categories')

// 跨 env 转上传相关 env vars：
// - CLIENT_API_HTTP_URL：clientApi 的 HTTP 触发器 URL（部署 clientApi 后 tcb fn detail 拿）
// - CLIENT_SECRET：与 clientApi 共享的 HMAC 密钥，已存在（原本给 wxacode.js 用）
//
// 不再用 wx-server-sdk 的 new Cloud({resourceEnv})（实测 v3.0.4 静默忽略 resourceEnv）；
// 也不引 @cloudbase/node-sdk（避免多套 SDK 凭证管理）。
// 直接 https.request 到 clientApi HTTP 触发器，clientApi 在自己 env 内上传 + getTempFileURL 返回 HTTPS URL。
// 这个 URL 与 admin 写入的 products.cover_image 完全同 shape，三端 `<image src>` 透明渲染。
const CLIENT_API_HTTP_URL = process.env.CLIENT_API_HTTP_URL
const CLIENT_SECRET = process.env.CLIENT_SECRET

/**
 * HTTPS POST JSON helper（同 utils/wxacode.js 的 httpGet 同款风格，本地 Promise 包装）
 * 返回 { status, json, raw }
 */
function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const data = Buffer.from(body, 'utf-8')
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json = null
        try { json = JSON.parse(text) } catch (_) {}
        resolve({ status: res.statusCode, json, raw: text })
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function performanceEventWindow(eventAlias, startIdx, endIdx) {
  return `${eventAlias}.status = '已支付'
    AND ${eventAlias}.performance_date >= ($${startIdx}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    AND ${eventAlias}.performance_date < ($${endIdx}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`
}

/**
 * 员工列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // Scope guard: 防止任意员工通过 payloadStoreId 枚举跨店员工
  // admin/headquarters 永远放行；其他角色必须在自己 scopeStoreIds 内
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  // 美容师选择列表按 skills 数组含 '美容师' 或 '养生师' 判定，不按 position_name ——
  // 养生师也可被指定接单（业务诉求）；与 clientApi/routes/staff.js + admin
  // orders/services/customers picker 单源对齐，写法与 mgmt-dashboard.js 的
  // `s.skills && ARRAY['美容师','养生师']::text[]` 同源。
  // 经理/督导/财智部等岗位即使 store_id 匹配也不应进入美容师选择列表。
  const staffRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      u.skills,
      u.avatar_url,
      u.store_id,
      u.is_on_business_trip,
      d.name AS department,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.is_resigned = false
      AND u.store_id = $1
      AND u.employee_id IS NOT NULL
      AND u.skills && ARRAY['美容师','养生师']::text[]
    ORDER BY d.name, u.name
  `, [targetStoreId])

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: r.skills || [],
      avatarUrl: r.avatar_url || null,
      storeId: r.store_id || '',
      department: r.department || '',
      storeName: r.store_name || '',
      marketName: r.market_name || '',
      isOnBusinessTrip: r.is_on_business_trip === true,
      isManager: r.position === '门店经理'
    }))
  }
}

/**
 * 部门列表（含可分配业绩员工）
 */
async function departments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // Scope guard: 同 list，防止跨店枚举
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  // 查询美容部
  const beautyRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      u.skills,
      u.avatar_url,
      d.name AS department
    FROM staff_wechat_users u
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.is_resigned = false
      AND u.store_id = $1
      AND d.name = '美容部'
      AND u.employee_id IS NOT NULL
    ORDER BY u.name
  `, [targetStoreId])

  // 查询其他部门（按市场查询）
  // 仅总部 / 市场级可见整个市场的人员名单；门店级（store_manager / store_staff）跳过
  const marketName = ctx.auth.marketName
  const canSeeMarket = ctx.auth.staffLevel === 'headquarters' || ctx.auth.staffLevel === 'market'
  let otherDeptRows = []

  if (marketName && canSeeMarket) {
    otherDeptRows = await pg.query(`
      SELECT
        u.employee_id,
        u.name,
        u.position_name AS position,
        u.skills,
        u.avatar_url,
        d.name AS department,
        s.store_name
      FROM staff_wechat_users u
      LEFT JOIN stores s ON u.store_id = s.store_id
      LEFT JOIN org_nodes so ON s.org_node_id = so.id
      LEFT JOIN org_nodes m ON so.parent_id = m.id
      LEFT JOIN org_nodes d ON u.org_node_id = d.id
      WHERE u.is_resigned = false
        AND m.name = $1
        AND d.name IS NOT NULL
        AND d.name != '美容部'
        AND d.name != ''
        AND u.employee_id IS NOT NULL
      ORDER BY d.name, u.name
    `, [marketName])
  }

  // 按部门分组
  const deptMap = {}

  if (beautyRows.length > 0) {
    deptMap['美容部'] = beautyRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      avatarUrl: r.avatar_url || null,
      department: '美容部'
    }))
  }

  for (const r of otherDeptRows) {
    const dept = r.department || '其他'
    if (!deptMap[dept]) deptMap[dept] = []
    deptMap[dept].push({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      avatarUrl: r.avatar_url || null,
      department: dept,
      storeName: r.store_name || ''
    })
  }

  const departments = Object.entries(deptMap).map(([name, members]) => ({
    departmentName: name,
    members
  }))

  ctx.result = { departments }
}

/**
 * 今日分成
 *
 * 口径约定（勿误改）：首卡「今日分成（营业额）」金额 = SUM(sale_payment_item_allocations.allocated_amount)
 *   = 员工分到的【销售营业额份额】（= 实收 × 分账比例，见 allocation.js），是【业绩】而非提成；
 *   服务在卡上只做计数（serviceCount），不并入金额。
 *   本口径与 mgmt-dashboard.staffRankingRevenue（员工业绩排行）一致，spec 标题即「今日分成（营业额）」。
 *   ⚠️ 不要为了"对齐绩效页合计"而把服务提成（service_commissions.commission_amount）加进来——
 *      绩效页是【提成】维度、本卡是【营业额】维度，两者本就不应相等（详见 performanceDetail 注释）。
 */
async function todayCommission(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId } = ctx.auth
  const isManager = isCurrentStoreManager(ctx.auth)

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayEnd.getDate() + 1)
  const todayStr = shanghaiDateStr(todayStart)

  // 今日分成金额 + 订单数
  const commissionRows = await pg.query(`
    SELECT
      COALESCE(SUM(spia.allocated_amount::numeric), 0) AS today_amount,
      COUNT(DISTINCT si.sale_order_id) AS order_count
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
    WHERE spia.employee_id = $1
      AND spia.is_void = false
      AND ${performanceEventWindow('spe', 2, 3)}
  `, [staffWfId, todayStart, todayEnd])

  // 今日服务单数
  const serviceRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date = $2
  `, [staffWfId, todayStr])

  // 本月时间范围
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  // 本月分成金额 + 订单数（个人口径）
  const thisMonthCommRows = await pg.query(`
    SELECT
      COALESCE(SUM(spia.allocated_amount::numeric), 0) AS amount,
      COUNT(DISTINCT si.sale_order_id) AS order_count
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
    WHERE spia.employee_id = $1
      AND spia.is_void = false
      AND ${performanceEventWindow('spe', 2, 3)}
  `, [staffWfId, thisMonthStart, thisMonthEnd])

  // 本月服务单数（个人口径）
  const thisMonthSvcRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, shanghaiDateStr(thisMonthStart), shanghaiDateStr(thisMonthEnd)])

  // 上月时间范围
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  // 上月分成金额 + 订单数
  const lastMonthCommRows = await pg.query(`
    SELECT
      COALESCE(SUM(spia.allocated_amount::numeric), 0) AS amount,
      COUNT(DISTINCT si.sale_order_id) AS order_count
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
    WHERE spia.employee_id = $1
      AND spia.is_void = false
      AND ${performanceEventWindow('spe', 2, 3)}
  `, [staffWfId, lastMonthStart, lastMonthEnd])

  // 上月服务单数
  const lastMonthSvcRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, shanghaiDateStr(lastMonthStart), shanghaiDateStr(lastMonthEnd)])

  const result = {
    todayAmount: Number(commissionRows[0].today_amount).toFixed(2),
    orderCount: Number(commissionRows[0].order_count),
    serviceCount: Number(serviceRows[0].service_count),
    thisMonthAmount: Number(thisMonthCommRows[0].amount).toFixed(2),
    thisMonthOrderCount: Number(thisMonthCommRows[0].order_count),
    thisMonthServiceCount: Number(thisMonthSvcRows[0].service_count),
    lastMonthAmount: Number(lastMonthCommRows[0].amount).toFixed(2),
    lastMonthOrderCount: Number(lastMonthCommRows[0].order_count),
    lastMonthServiceCount: Number(lastMonthSvcRows[0].service_count),
  }

  // 店长：门店今日总业绩（首次收款按订单归属日，后续回款/退款按真实发生日）
  // 门店过滤用 effectiveStoreId（当前选中门店），多店店长切店后才正确
  const eff = ctx.auth.effectiveStoreId
  if (isManager && eff) {
    const sc = buildStoreScopeCondition(ctx.auth, 'spe.store_id', 1)
    const storeRows = await pg.query(`
      SELECT COALESCE(SUM(spe.amount::numeric), 0) AS store_revenue
      FROM sale_order_performance_events spe
      WHERE ${sc.sql}
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date = $${sc.params.length + 1}::date
    `, [...sc.params, todayStr])
    result.storeTodayRevenue = Number(storeRows[0].store_revenue).toFixed(2)
  }

  ctx.result = result
}

/**
 * 月度业绩日历（整店口径）
 *
 * 口径约定（勿误改）：日历每日格子 + 头部合计 = 整店汇总业绩
 *   = SUM(sale_order_performance_events.amount)，首次收款按订单归属日，后续流水按真实发生日，
 *   按 effectiveStoreId（当前选中门店）过滤，与首卡「门店今日营收」/ mgmt-dashboard.queryStoreRevenue 同口径。
 *   ⚠️ 这是【整店营业额】维度，不是登录员工的个人分成份额（个人本月累计走 todayCommission.thisMonth*）。
 */
async function monthlyCalendar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { yearMonth } = ctx.event.payload || {}

  const now = new Date()
  const defaultYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const ym = yearMonth || defaultYm

  const [y, m] = ym.split('-').map(Number)
  const monthStart = new Date(y, m - 1, 1)
  const monthEnd = new Date(y, m, 1)
  const monthStartStr = shanghaiDateStr(monthStart)
  const monthEndStr = shanghaiDateStr(monthEnd)

  const sc = buildStoreScopeCondition(ctx.auth, 'spe.store_id', 1)

  // 按业绩归属日汇总整店业绩
  const dailyRows = await pg.query(`
    SELECT
      spe.performance_date AS date,
      SUM(spe.amount::numeric) AS amount
    FROM sale_order_performance_events spe
    WHERE ${sc.sql}
      AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
      AND spe.status = '已支付'
      AND spe.change_type IN ('首次支付', '回款', '退款')
      AND spe.legacy_source IS DISTINCT FROM 'workfine'
      AND spe.performance_date >= $${sc.params.length + 1}::date
      AND spe.performance_date < $${sc.params.length + 2}::date
    GROUP BY spe.performance_date
    ORDER BY spe.performance_date
  `, [...sc.params, monthStartStr, monthEndStr])

  // 月度整店汇总
  const totalRows = await pg.query(`
    SELECT
      COALESCE(SUM(spe.amount::numeric), 0) AS total_amount,
      COUNT(DISTINCT spe.sale_order_id) AS total_order_count
    FROM sale_order_performance_events spe
    WHERE ${sc.sql}
      AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
      AND spe.status = '已支付'
      AND spe.change_type IN ('首次支付', '回款', '退款')
      AND spe.legacy_source IS DISTINCT FROM 'workfine'
      AND spe.performance_date >= $${sc.params.length + 1}::date
      AND spe.performance_date < $${sc.params.length + 2}::date
  `, [...sc.params, monthStartStr, monthEndStr])

  // 月度整店服务单数
  const svcSc = buildStoreScopeCondition(ctx.auth, 'store_id', 1)
  const svcRows = await pg.query(`
    SELECT COUNT(*) AS total_service_count
    FROM service_orders
    WHERE ${svcSc.sql}
      AND service_date >= $${svcSc.params.length + 1}
      AND service_date < $${svcSc.params.length + 2}
  `, [...svcSc.params, monthStartStr, monthEndStr])

  const dailyData = dailyRows.map(r => ({
    date: r.date instanceof Date ? shanghaiDateStr(r.date) : String(r.date).slice(0, 10),
    amount: Number(r.amount),
  }))

  ctx.result = {
    dailyData,
    totalAmount: Number(totalRows[0].total_amount),
    totalOrderCount: Number(totalRows[0].total_order_count),
    totalServiceCount: Number(svcRows[0].total_service_count),
  }
}

/**
 * 待处理事项汇总
 */
async function todoList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, effectiveStoreId } = ctx.auth
  const isManager = isCurrentStoreManager(ctx.auth)

  // 待确认预约
  let appointmentCount
  if (isManager) {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE store_id = $1 AND status = '待确认'`,
      [effectiveStoreId]
    )
  } else {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE employee_id = $1 AND status = '待确认'`,
      [staffWfId]
    )
  }

  // 待推进服务单
  let serviceCount
  if (isManager) {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE store_id = $1 AND status IN ('待服务', '服务中')`,
      [effectiveStoreId]
    )
  } else {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE assigned_employee_id = $1 AND status IN ('待服务', '服务中')`,
      [staffWfId]
    )
  }

  const result = {
    pendingAppointmentCount: Number(appointmentCount[0].cnt),
    pendingServiceCount: Number(serviceCount[0].cnt),
  }

  // 店长专属
  if (isManager) {
    // 「待支付」语义包含「部分支付」（未结清未关闭都算待店长确认收款；
    //  覆盖部分付场景，店长能在首页待办看到欠款单）
    const offlineRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status IN ('待支付', '部分支付') AND payment_method = '线下'`,
      [effectiveStoreId]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待支付' AND opened_by IS NULL`,
      [effectiveStoreId]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)

    const unbindRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM store_unbind_requests WHERE from_store_id = $1 AND status = '待处理'`,
      [effectiveStoreId]
    )
    result.pendingUnbindCount = Number(unbindRows[0].cnt)

    // 待提成分配订单（口径对齐 allocation.pendingList：仅销售单/转换单且非历史订单，避免内部单/寄存单/充值单/历史单致计数虚高）
    const allocRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '已支付' AND allocation_status = '待分配'
         AND sale_order_type IN ('销售单', '转换单') AND legacy_source IS DISTINCT FROM 'workfine'`,
      [effectiveStoreId]
    )
    result.pendingAllocationCount = Number(allocRows[0].cnt)

    // 待审批退款流水（2026-04-26 sale-order-domain-refactor：从 sale_order_payments 推断）
    const refundRows = await pg.query(
      `SELECT COUNT(*) AS cnt
         FROM sale_order_payments sop
         JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
        WHERE so.store_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批'`,
      [effectiveStoreId]
    )
    result.pendingRefundCount = Number(refundRows[0].cnt)
  }

  ctx.result = result
}

/**
 * 切换工作门店
 */
async function bindStore(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId } = ctx.event.payload || {}
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  // Scope guard: 总部可任意切店；其他角色（market / store_manager / store_staff）
  // 必须在自己 scopeStoreIds 内，禁止绕过 scope 切到任意门店
  if (ctx.auth.staffLevel !== 'headquarters') {
    if (!isStoreInScope(ctx.auth, storeId)) {
      throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
    }
  }

  const storeRows = await pg.query(
    'SELECT store_id, store_name FROM stores WHERE store_id = $1 AND is_closed = false',
    [storeId]
  )

  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已关闭')
  }

  // 持久化到 staff_wechat_users.store_id，否则刷新后 auth 中间件依然读旧值
  await pg.query(
    'UPDATE staff_wechat_users SET store_id = $1, updated_at = NOW() WHERE employee_id = $2',
    [storeRows[0].store_id, ctx.auth.staffWfId]
  )

  // 清除 OPENID → authData 缓存，避免 5 分钟内仍返回旧 storeId
  invalidateAuthCache(ctx.auth.openid)

  ctx.result = {
    success: true,
    storeId: storeRows[0].store_id,
    storeName: storeRows[0].store_name
  }
}

/**
 * 员工绩效明细
 * 返回指定时段的分配明细 + 服务提成明细
 * payload: { startDate, endDate, employeeId? (店长可查他人), salesCategory?, page, pageSize }
 *
 * 口径约定（2026-05-26 落地 staff.pr.spec §3.15 双维度提成模型，勿误改）：
 *   totalSalesAlloc       = SUM(sale_payment_item_allocations.commission_amount) — 真实【销售提成】（= 营业额份额 × 提成率快照）
 *   totalServiceCommission = SUM(service_commissions.commission_amount) — 真实【服务提成】
 *   totalCommission（合计）= 两者相加 —— 销售/服务两侧均为真实提成收入。
 *   item.amount = 该行销售提成（commission_amount）；item.allocAmount = 该员工营业额分配份额（spia.allocated_amount）。
 *   item.businessAmount = 整行实收（si.received）— **已弃用**，仅保留兼容线上老版本小程序；
 *     新版前端「业绩」展示 allocAmount（issue #123：员工看到的应是自己的分配额，不是订单行总额）。
 *   提成率快照在 allocation.save / admin / payNotify 写入时固化（commission_rate），历史不随改率变化。
 *   与 mgmt staffRankingIncome / querySalesCommissionIncome 同口径（销售部分均 = commission_amount），三处自洽。
 *   ⚠️ 销售提成是【提成收入】维度，与首卡「今日分成（营业额）」（= staffRankingRevenue，营业额份额维度）本就不等，勿强行对齐。
 *
 * 筛选与汇总解耦（issue #123，勿回退）：
 *   salesCategory / filterType 入参**只过滤 items 明细**，不影响任何汇总字段。
 *   categorySummary（4 归属分类 × {sales, service} = 绩效页 8 维度总览）与 totalSalesAlloc /
 *   totalServiceCommission / totalCommission 恒按本期全量计算，否则前端切二级 chip 后其余维度会归零，
 *   且「4 子类之和 = 顶部销售提成」的勾稽关系断裂。
 *   categorySummary 固定 4 类零填充 + 逐类 round2，categories 下发有序分类清单（前端不再自持硬编码）。
 *
 * ⚠️ 退款在销售侧与服务侧的口径不对称（既有，非本次引入，勿误以为 bug）：
 *   销售侧 = **冲销式**：refund-cascade INSERT 负数镜像子分配，`is_void` 仍为 false →
 *     负数行进入 allocRows，明细会出现负提成/负分配额（前端按 amount < 0 打「退款」标识）。
 *   服务侧 = **删除式**：退款把 service_commissions.is_void 置 true → 本查询直接排除 →
 *     已过去月份的服务提成会**回溯变小**，员工事后查看历史月份与当时所见不一致。
 *   两侧统一为冲销式需要改 refund-cascade + 历史数据回填，超出绩效页范围。
 */
async function performanceDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { startDate, endDate, employeeId: queryEmployeeId, salesCategory, filterType, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const isManager = isCurrentStoreManager(ctx.auth)

  // 分页入参加固：非法值会让 slice 走进负索引（page=-1 静默返回列表尾部的错误数据）
  // 或字符串拼接（pageSize='20' 时 offset + pageSize → '2020'，一次吐 2000 条）
  const safePage = Math.max(1, Math.floor(Number(page)) || 1)
  const safePageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize)) || 20))

  // 美容师只能查自己
  const targetEmployeeId = (isManager && queryEmployeeId) ? queryEmployeeId : ctx.auth.staffWfId

  // Scope guard: when querying another employee, verify they're within current scope
  // assertEmployeeInScope 自查（staffWfId === targetEmployeeId）直接放行，无需 DB
  await assertEmployeeInScope(pg, ctx.auth, targetEmployeeId)

  if (!startDate || !endDate) {
    throw new Error('INVALID_PARAMS: 缺少 startDate 或 endDate')
  }

  const start = new Date(startDate.replace(/-/g, '/'))
  const end = new Date(endDate.replace(/-/g, '/'))
  end.setDate(end.getDate() + 1)

  // 销售提成明细（基于 sale_payment_item_allocations）
  // ⚠️ 不在 SQL 里按 salesCategory 过滤：汇总必须覆盖全量 4 分类（见函数头注释「筛选与汇总解耦」），
  //    明细筛选在下方内存阶段完成（本就全量取回内存分页，无额外 DB 往返）。
  const allocParams = [targetEmployeeId, start, end]

  const allocRows = await pg.query(`
    SELECT
      spia.allocated_amount AS alloc_amount,
      COALESCE(spia.commission_amount, 0) AS commission_amount,
      spia.commission_rate,
      spia.allocation_ratio,
      spia.department_name,
      si.product_name,
      si.sales_category,
      si.unit_real_price,
      si.received,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      o.sale_order_id,
      o.customer_name,
      o.client_phone,
      spe.performance_date AS paid_at,
      o.store_id
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
    WHERE spia.employee_id = $1
      AND spia.is_void = false
      AND ${performanceEventWindow('spe', 2, 3)}
    ORDER BY spe.performance_date DESC, spia.id DESC
  `, allocParams)

  // 服务提成明细（基于 service_commissions 表）
  // 口径：commission_amount = fixed_fee + consume_amount
  //       fixed_fee = sale_items.service_fee × session_used （固定手工费快照）
  //       consume_amount = unit_real_price × session_used × commission_rate （消耗提成）
  // 旧实现曾用 unit_real_price × session_used 作为"服务提成"，这是消耗业绩金额口径，
  // 导致员工看到的数字虚高 3-5 倍，已修复。
  // 同上：salesCategory 不进 SQL，汇总恒全量
  const svcParams = [targetEmployeeId, startDate, endDate.replace(/-/g, '/')]

  const svcRows = await pg.query(`
    SELECT
      sc.commission_amount,
      sc.fixed_fee,
      sc.consume_amount,
      sc.role_type,
      sc.commission_rate,
      sit.session_used,
      sit.unit_real_price AS service_unit_price,
      si.product_name,
      si.sales_category,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      so.service_order_id,
      so.service_date,
      so.created_at AS service_created_at,
      so.store_id,
      cu.name AS customer_name,
      cu.phone AS client_phone
    FROM service_commissions sc
    JOIN service_items sit ON sit.service_item_id = sc.service_item_id
    JOIN service_orders so ON so.service_order_id = sit.service_order_id
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN client_wechat_users cu ON cu.user_id = so.client_user_id
    WHERE sc.employee_id = $1
      AND sc.is_void = false
      AND sc.voided_at IS NULL
      AND so.status = '已完成'
      AND so.service_date >= $2
      AND so.service_date <= $3
    ORDER BY so.service_date DESC
  `, svcParams)

  // 汇总
  let totalSalesAlloc = 0
  let totalServiceCommission = 0

  // 固定 4 分类零填充打底：即使本期某分类无数据，前端也要能渲染 ¥0.00 的格子；
  // 运行时出现的额外分类（sales_category 为 NULL → UNCATEGORIZED）追加在固定 4 类之后。
  const categorySummary = {}
  for (const cat of SALES_CATEGORIES) categorySummary[cat] = { sales: 0, service: 0 }
  const bucketOf = (rawCategory) => {
    const key = rawCategory || UNCATEGORIZED
    if (!categorySummary[key]) categorySummary[key] = { sales: 0, service: 0 }
    return categorySummary[key]
  }

  for (const r of allocRows) {
    // 销售侧汇总用真实提成 commission_amount（§3.15），不再用营业额份额
    const amount = Number(r.commission_amount)
    totalSalesAlloc += amount
    bucketOf(r.sales_category).sales += amount
  }

  for (const r of svcRows) {
    const amount = Number(r.commission_amount)
    totalServiceCommission += amount
    bucketOf(r.sales_category).service += amount
  }

  // 浮点累加归一：顶部三联卡走了 round，分类格子也必须走，否则「4 分类之和 = 顶部提成」
  // 的勾稽会在 IEEE754 误差下差 0.01（该勾稽是本接口对前端的承诺，见函数头注释）
  const round2 = (v) => Math.round(v * 100) / 100
  for (const key of Object.keys(categorySummary)) {
    categorySummary[key].sales = round2(categorySummary[key].sales)
    categorySummary[key].service = round2(categorySummary[key].service)
  }

  // 合并为时间线，按 filterType 过滤，分页
  const saleItems = allocRows.map(r => ({
    type: 'sale',
    productName: r.product_name,
    specName: null,
    salesCategory: r.sales_category,
    amount: Number(r.commission_amount), // 该行真实销售提成（§3.15）
    allocAmount: Number(r.alloc_amount), // 该员工营业额分配份额（spia.allocated_amount）
    commissionRate: Number(r.commission_rate || 0), // 提成率快照
    ratio: Number(r.allocation_ratio),
    businessAmount: Number(r.received), // 整行实收 — 已弃用，仅兼容线上老版本前端（见函数头注释）
    customerName: r.customer_name,
    clientPhone: r.client_phone,
    orderId: r.sale_order_id,
    date: r.paid_at,
    department: r.department_name,
    unit: r.unit || '次',
  }))

  const serviceItems = svcRows.map(r => ({
    type: 'service',
    productName: r.product_name,
    specName: null,
    salesCategory: r.sales_category,
    roleType: r.role_type,
    amount: Number(r.commission_amount),
    fixedFee: Number(r.fixed_fee || 0),
    consumeAmount: Number(r.consume_amount || 0),
    commissionRate: Number(r.commission_rate || 0),
    sessionUsed: r.session_used,
    servicePrice: Number(r.service_unit_price || 0),
    unit: r.unit || '次',
    customerName: r.customer_name,
    clientPhone: r.client_phone,
    orderId: r.service_order_id,
    date: r.service_created_at || r.service_date,
  }))

  // 明细筛选：一级 filterType（sale/service）+ 二级 salesCategory，两级任意组合
  // 汇总已在上方按全量算完，此处过滤不会回写汇总（issue #123）
  let allItems
  if (filterType === 'sale') allItems = saleItems
  else if (filterType === 'service') allItems = serviceItems
  else allItems = [...saleItems, ...serviceItems]

  if (salesCategory) {
    // 与 categorySummary 归类口径对齐：NULL 分类统一落 UNCATEGORIZED，保证可被筛出
    // （旧实现的 SQL `si.sales_category = $4` 筛不出 NULL 行，这是本次的净修复）
    allItems = allItems.filter(i => (i.salesCategory || UNCATEGORIZED) === salesCategory)
  }

  allItems.sort((a, b) => new Date(b.date) - new Date(a.date))

  const offset = (safePage - 1) * safePageSize
  const paged = allItems.slice(offset, offset + safePageSize)

  const roundedServiceCommission = Math.round(totalServiceCommission * 100) / 100

  ctx.result = {
    totalSalesAlloc: Math.round(totalSalesAlloc * 100) / 100,
    totalServiceCommission: roundedServiceCommission,
    // 向后兼容：保留 totalServiceFee 字段名供老版本前端使用（1-2 发布周期后下线）
    totalServiceFee: roundedServiceCommission,
    totalCommission: Math.round((totalSalesAlloc + totalServiceCommission) * 100) / 100,
    categorySummary,
    // 有序分类清单（固定 4 类在前 + 运行时出现的额外分类）——前端据此渲染格子与 chip，
    // 不再自持硬编码副本，枚举改名/新增时不会出现「幽灵格子 + 真实分类并存」
    categories: Object.keys(categorySummary),
    items: paged,
    total: allItems.length,
    page: safePage,
    pageSize: safePageSize,
  }
}

/**
 * 头像上传（员工本人自助）
 *
 * 流程：
 *   1. 本函数前置校验参数（与 clientApi.auth.uploadStaffAvatar 重复一份，让 base64 损坏/超 2MB
 *      等错误更早抛出，节省一次跨 env HTTPS 往返）
 *   2. HMAC-SHA256(body, CLIENT_SECRET) 签 body，HTTPS POST 到 clientApi HTTP 触发器
 *   3. clientApi 在 client env 内 cloud.uploadFile + getTempFileURL，返回 HTTPS URL
 *   4. 本函数把 HTTPS URL 写入 PG staff_wechat_users.avatar_url
 *
 * 为什么不直接在 staff env 写 staff env COS：
 *   - 客户端小程序读 staff env URL 需要额外配域名白名单 + staff env COS 还得改公共读策略
 *   - 复用 admin → client env COS 的已有写路径（products.cover_image 已实证）最一致
 *
 * 为什么不用 wx-server-sdk 跨 env：
 *   - wx-server-sdk@3.0.4 的 new Cloud({resourceEnv}) 实测被静默忽略（fileID 仍落 staff env）
 *   - 不用 @cloudbase/node-sdk：避免再引一套 SDK + 腾讯云 secret 凭证管理
 *
 * 安全：HMAC 防伪 + timestamp 防重放 + clientApi HTTP 入口 allowlist 仅 uploadStaffAvatar
 */
async function uploadAvatar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { base64, ext } = ctx.event.payload || {}
  const { OPENID } = cloud.getWXContext()
  const employeeId = ctx.auth.staffWfId

  // 前置参数校验
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 base64 参数')
  }
  const normalizedExt = String(ext || 'jpg').toLowerCase()
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(normalizedExt)) {
    throw new Error('INVALID_PARAMS: 不支持的图片格式')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw new Error('INVALID_PARAMS: 头像数据解析失败')
  }
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('INVALID_PARAMS: 图片大小超过 2MB')
  }
  if (!employeeId) {
    throw new Error('UNAUTHORIZED: 员工档案未关联')
  }
  if (!CLIENT_API_HTTP_URL || !CLIENT_SECRET) {
    throw new Error('INVALID_STATE: CLIENT_API_HTTP_URL/CLIENT_SECRET 未配置')
  }

  // 签 + 发
  const body = JSON.stringify({
    action: 'auth.uploadStaffAvatar',
    payload: { base64, ext: normalizedExt, employeeId },
    timestamp: Date.now(),
  })
  const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(body).digest('hex')

  let resp
  try {
    resp = await postJson(CLIENT_API_HTTP_URL, body, { 'x-fengyu-signature': sig })
  } catch (err) {
    throw new Error(`INVALID_STATE: 跨 env 上传请求失败：${err.message}`)
  }

  if (resp.status !== 200 || !resp.json) {
    throw new Error(`INVALID_STATE: 跨 env 上传 HTTP status=${resp.status}, body=${(resp.raw || '').slice(0, 200)}`)
  }
  if (resp.json.code !== 0) {
    // clientApi 已 buildErrorResponse，errorType 已是 9 项白名单之一；message 含前缀
    throw new Error(resp.json.message || 'INVALID_STATE: 跨 env 上传失败')
  }

  const httpsUrl = resp.json.data && resp.json.data.avatarUrl
  const fileID = resp.json.data && resp.json.data.fileID
  if (!httpsUrl) {
    throw new Error('INVALID_STATE: clientApi 未返回 avatarUrl')
  }

  await pg.query(
    'UPDATE staff_wechat_users SET avatar_url = $1, updated_at = NOW() WHERE employee_id = $2',
    [httpsUrl, employeeId]
  )

  // 清除 auth 缓存，下一次 login/任意接口能读到新头像
  invalidateAuthCache(OPENID)

  ctx.result = { fileID, avatarUrl: httpsUrl }
}

/**
 * 技能标签字典（提成分配 / 服务提成下拉选项来源）
 * 读 skill_tags 字典表（admin 员工管理维护），与员工技能标签同源。
 */
async function skillTags(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const rows = await pg.query(
    'SELECT name FROM skill_tags WHERE is_valid = true ORDER BY sort_order, name'
  )

  ctx.result = { skillTags: rows.map(r => r.name) }
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail, uploadAvatar, skillTags }
