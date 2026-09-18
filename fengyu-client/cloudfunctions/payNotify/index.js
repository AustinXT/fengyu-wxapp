/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 */

// 强制进程时区为东八区。CloudBase 运行时默认 UTC，否则 new Date(y,m,d) / getHours/getDate
// 等本地时间方法会偏差 8 小时（须在任何 Date 操作与模块 require 之前设置）。
process.env.TZ = 'Asia/Shanghai'

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')
const { settlePointsSafe } = require('./points')
const { recalcMemberLevel } = require('./member-level')
const { parseErrorPrefix } = require('./error-codes')
const { verifyHealthPayload } = require('./utils/system-health')
const { recalcPaidSessionsForOrder } = require('./paid-sessions')
const { capturePaymentAllocatables, refreshOrderAllocationRollup } = require('./payment-allocatable')
const { getPerItemRefundedMap, computeRefundAwareDirectedItems } = require('./per-item-refund')
const { classifySaleOrderDocumentType } = require('./document-type')

/**
 * 顾客分类跃迁的订单级金额 CTE（#187，2026-09-18）。$1 = client_user_id。
 * 产出每张已结清销售单的 non_trial / trial = 非体验 / 体验行的**毛实收**合计
 * （sale_items.received 净额 + 该行逐项退款额 → 还原"曾经收到的钱"，退款不扣减）。
 * refund_by_item 的 note→jsonb 三重防线逐字对齐 paid-sessions.js
 * RECEIVED_REFUNDED_DEDUCT_SQL，根除 22P02。七处副本逐字一致，由 staffApi
 * __tests__/routes/recalc-customer-type-sql.test.js 守护。
 */
const RECALC_CUSTOMER_TYPE_CTE = `WITH refund_by_item AS (
       SELECT elem ->> 'refSaleItemId' AS sale_item_id,
              SUM(COALESCE((elem ->> 'refundAmount')::numeric, 0)) AS refunded
       FROM sale_order_payments sop
       JOIN sale_orders ro ON ro.sale_order_id = sop.sale_order_id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN sop.note LIKE '{%'
              THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                        THEN (sop.note)::jsonb -> 'items'
                        ELSE '[]'::jsonb END
              ELSE '[]'::jsonb END
       ) AS elem
       WHERE ro.client_user_id = $1
         AND sop.change_type = '退款'
         AND sop.status = '已支付'
         AND elem ->> 'refSaleItemId' <> 'OVERPAY'
       GROUP BY 1
     ),
     order_amounts AS (
       SELECT o.sale_order_id,
              COALESCE(SUM(si.received::numeric + COALESCE(rbi.refunded, 0))
                       FILTER (WHERE si.is_experience = false), 0) AS non_trial,
              COALESCE(SUM(si.received::numeric + COALESCE(rbi.refunded, 0))
                       FILTER (WHERE si.is_experience = true), 0) AS trial
       FROM sale_orders o
       JOIN sale_items si ON si.sale_order_id = o.sale_order_id
       LEFT JOIN refund_by_item rbi ON rbi.sale_item_id = si.sale_item_id
       WHERE o.client_user_id = $1
         AND o.status IN ('已支付', '已完成')
         AND o.sale_order_type = '销售单'
         AND si.item_direction = '购买'
       GROUP BY o.sale_order_id
     )`

/**
 * 线上支付自动逐笔分配：把本次回款（perItem 逐项可分配额）100% 记到开单指定销售员名下，
 * 提成率按【本次回款额 eventAmount】查档（按回款逐笔分配口径，非订单累计）。
 * 无 preferred / 无 perItem 直接跳过（留待分配走手动）。
 * 跨端约定（no-shared-cloudfunctions）：buildSalesRateLookup 与 staffApi allocation.js /
 * admin allocations.ts 同语义独立副本。
 */
async function autoAllocateOnlinePayment(
  client,
  { salePaymentId, saleOrderId, perItem, eventAmount, preferredEmployeeId, marketName, now },
) {
  if (!preferredEmployeeId || !Array.isArray(perItem) || perItem.length === 0) return

  // 读取员工 skills 推断 role_type（首位技能，缺省回退到 '美容师'）
  const empRow = await client.query(
    'SELECT skills FROM staff_wechat_users WHERE employee_id = $1',
    [preferredEmployeeId],
  )
  const skills = Array.isArray(empRow.rows[0]?.skills) ? empRow.rows[0].skills : []
  const roleType = skills[0] || '美容师'

  // 销售提成固化快照：加载该市场「销售单」费率矩阵，tier 基准 = 本次回款额 eventAmount
  let salesRateGrouped = []
  if (marketName) {
    const rateRows = await client.query(
      `SELECT crm.role_type, crm.sales_category,
              crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
       FROM commission_rate_matrix crm
       JOIN org_nodes n ON n.id = crm.org_id
       WHERE n.name = $1 AND crm.order_type = '销售单'
       ORDER BY crm.role_type, crm.amount_tier_min`,
      [marketName],
    )
    const byKey = new Map()
    for (const r of rateRows.rows) {
      const dept = (r.role_type || '').trim()
      const key = `${dept}|${r.amount_tier_min}|${r.amount_tier_max}`
      let entry = byKey.get(key)
      if (!entry) {
        entry = {
          department: dept,
          amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
          amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
          orderRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 },
        }
        byKey.set(key, entry)
        salesRateGrouped.push(entry)
      }
      entry.orderRates[r.sales_category] = Number(r.commission_rate) || 0
    }
  }
  const lookupSalesRate = (role, salesCat, amount) => {
    let hit = null
    for (const r of salesRateGrouped) {
      if (r.department !== role) continue
      if (amount < r.amountMin || amount > r.amountMax) continue
      const rate = r.orderRates[salesCat]
      if (!rate || rate <= 0) continue
      if (!hit || r.amountMin > hit.amountMin) hit = r
    }
    return (hit && hit.orderRates[salesCat]) || 0
  }

  // 为本次回款每个可分配项建分配记录（100% 给指定销售员）+ 销售提成固化快照
  for (const it of perItem) {
    let receiptId = it.receiptId
    if (!receiptId) {
      const receiptRows = await client.query(
        `SELECT id FROM sale_payment_item_receipts
          WHERE sale_payment_id = $1 AND sale_item_id = $2
          LIMIT 1`,
        [salePaymentId, it.saleItemId],
      )
      receiptId = receiptRows.rows[0] && receiptRows.rows[0].id
    }
    if (!receiptId) continue
    const salesCategory = it.salesCategory || '自销自耗'
    const commissionRate = lookupSalesRate(roleType, salesCategory, eventAmount)
    const commissionAmount = Math.round(Number(it.amount) * commissionRate * 100) / 100
    await client.query(
      `INSERT INTO sale_payment_item_allocations
         (sale_payment_item_receipt_id, employee_id, role_type, allocation_ratio, allocated_amount,
          commission_rate, commission_amount, is_void, created_at, updated_at)
       VALUES ($1, $2, $3, 1.00, $4, $5, $6, FALSE, $7, $7)
       ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false DO NOTHING`,
      [receiptId, preferredEmployeeId, roleType, Number(it.amount).toFixed(2),
       commissionRate, commissionAmount, now],
    )
  }
  // 本回款主流水行 → 已分配（线上自动分配完成；店长仍可从已分配复核改派）
  // CAS 守卫：IN ('待分配','已分配') 挡 NULL/脏态；支付回调事务中分配标记为次要副作用，
  // rowCount=0 仅告警不 throw（INSERT 已 ON CONFLICT DO NOTHING 幂等，不回滚支付）。
  const allocUpd = await client.query(
    `UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1 AND allocation_status IN ('待分配', '已分配')`,
    [salePaymentId],
  )
  if (allocUpd.rowCount === 0) {
    console.warn('[payNotify] allocation-status-transition-blocked:', salePaymentId)
  }
}
const lakalaSign = require('./utils/lakala-sign')
const lakalaConfig = require('./utils/lakala-config')
const wxShipping = require('./utils/wx-shipping')
// issue #37 定时补偿：queryTrade 主动查拉卡拉真实状态（独立副本，与 clientApi/utils/lakala-client 同源）
const lakalaClient = require('./utils/lakala-client')

// 充值卡剥离 SKU 化（2026-05-20）：充值识别改为 sale_orders.sale_order_type='充值单'，
// 不再依赖虚拟 SKU 或 product_name 正则解析面值。

// PostgreSQL 连接（懒初始化）
let pgPool = null
function getPg() {
  if (!pgPool) {
    const pg = require('pg')
    // 全局 OID 解析：numeric/bigint → JS Number（详见 db/pg.js 注释）
    pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)))
    pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)))
    // date 保持 YYYY-MM-DD 文本（与 staffApi/clientApi 的 db/pg.js 三端一致，snapshot 守护）
    pg.types.setTypeParser(1082, (val) => val)
    // timestamp 列自 migration 0076 起统一为 timestamptz（1184）：pg 内置 parser 按字面偏移正确解析，无需自定义 1114 parser。
    pgPool = new pg.Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 3,
      idleTimeoutMillis: 60000
    })
  }
  return pgPool
}

/**
 * payNotify 启用开关（2026-05-20 改为环境变量控制，替代硬编码常量守卫）
 *
 * 启用条件（两者皆需）：
 *   1. 环境变量 PAYNOTIFY_ENABLED=true
 *   2. lakalaConfig.isReady() = true（即 LAKALA_APPID / SERIAL_NO / PRIVATE_KEY_PEM / PLATFORM_CERT_PEM /
 *      DEFAULT_MERCHANT_NO / DEFAULT_TERM_NO / API_BASE 7 项必填环境变量齐全）
 *
 * 不通过条件：HTTP 入口返回 503，wx.cloud.callFunction 入口返回 -403，不会进入业务逻辑。
 *
 * 历史背景：D-Q1-2026-04-26 引入硬编码常量守卫等待拉卡拉对接；2026-05-20 拉卡拉接入完成后切换为 env 控制。
 */
function isPayNotifyEnabled() {
  if (process.env.PAYNOTIFY_ENABLED !== 'true') return false
  if (!lakalaConfig.isReady()) return false
  return true
}

/**
 * 解析拉卡拉 HTTP 触发器回调，校验 IP 白名单 + 3 行异步通知签名，转换为内部 event 格式。
 *
 * 拉卡拉聚合主扫回调约定（详见 sources/documents/拉卡拉接口规范-补充.md）：
 *   - HTTP POST，event.body = 原始 JSON 字符串（验签必须用原始字节，禁止 JSON.parse 再 stringify）
 *   - event.headers.authorization = 'LKLAPI-SHA256withRSA timestamp="...",nonce_str="...",signature="..."'
 *   - body 为扁平 JSON（聚合主扫规范）：
 *       out_trade_no  商户交易流水号（含 `_unixSec` 后缀，需剥离得 saleOrderId）
 *       trade_no      拉卡拉交易流水号（落 sale_order_payments.external_txn_id 作幂等键）
 *       trade_state   INIT/CREATE/SUCCESS/FAIL/DEAL/UNKNOWN/CLOSE/PART_REFUND/REFUND
 *       account_type  WECHAT / ALIPAY / UQRCODEPAY ...
 *       acc_trade_no  微信 transaction_id 或支付宝交易号（落 external_trade_info 供 admin 退款取 origin）
 *       total_amount  订单/本次应付金额（分，= 我方 preorder 传入额；**入账基准用此字段**）
 *       payer_amount  用户实付金额（分，扣除了银行立减金/平台立减/红包等"渠道·银行出资"营销立减；
 *                     这类立减由银行/平台补贴、商户全额到账，**不作入账**，否则会被误判少收/部分支付。
 *                     仅随整 body 落 external_trade_info 作快照）
 *
 * 返回：
 *   - null              非 HTTP 入口（走原 callFunction 路径）
 *   - { _lakalaCallbackAcked: true, ackBody: {...} }   退款回调 / 非终态非成功状态，已 ack
 *   - { orderNo, tradeState, _lakalaTerminalPayment: true } FAIL/CLOSE，待按当前单号 CAS 释放
 *   - { orderNo, transactionId, payAmount, paymentMethod, _httpEntry: true }  成功支付回调，待业务处理
 * 抛错：签名 / IP 白名单失败，由 main 转 403 响应
 */
function parseHttpTriggerEvent(event) {
  if (!event || typeof event !== 'object') return null
  if (event.httpMethod !== 'POST') return null

  const cfg = lakalaConfig.readConfig()
  const rawHeaders = event.headers || {}
  const headers = {}
  for (const k of Object.keys(rawHeaders)) headers[k.toLowerCase()] = rawHeaders[k]

  // IP 白名单（LAKALA_CALLBACK_IP_WHITELIST=* 跳过）
  if (!cfg.ipWhitelistOpen) {
    const xff = headers['x-forwarded-for'] || headers['x-real-ip'] || event.sourceIp || ''
    const clientIp = String(xff).split(',')[0].trim()
    if (!clientIp || !cfg.ipWhitelist.includes(clientIp)) {
      const err = new Error('PERMISSION_DENIED: LAKALA_CALLBACK_IP_NOT_ALLOWED')
      err._statusCode = 403
      throw err
    }
  }

  // 异步通知验签（3 行：timestamp\nnonce_str\nbody\n，body 必须是原始字节）
  const authorizationHeader = headers['authorization'] || ''
  const rawBody = typeof event.body === 'string' ? event.body : ''
  const verifyResult = lakalaSign.verifyAsyncNotification({
    authorizationHeader,
    rawBody,
    platformCertPem: cfg.platformCertPem,
  })
  if (!verifyResult.ok) {
    const err = new Error(`PERMISSION_DENIED: LAKALA_CALLBACK_SIGN_FAIL: ${verifyResult.reason}`)
    err._statusCode = 403
    throw err
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch (parseErr) {
    const err = new Error('INVALID_PARAMS: LAKALA_CALLBACK_BODY_NOT_JSON')
    err._statusCode = 400
    throw err
  }

  // 聚合主扫扁平字段映射
  const outTradeNo = body.out_trade_no
  const tradeNo = body.trade_no
  const tradeState = String(body.trade_state || '').toUpperCase()
  const accountType = String(body.account_type || '').toUpperCase()
  const totalAmountFen = Number(body.total_amount || 0)
  const payerAmountFen = Number(body.payer_amount || 0)

  // 退款回调：ack 让拉卡拉停重试，退款流程由 admin 退款 cron 推进
  if (tradeState === 'REFUND' || tradeState === 'PART_REFUND') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: '退款回调已确认' } }
  }
  // 明确失败/关闭：交给 main 按当前 out_trade_no CAS 释放活动意图后再 ack。
  // 不能在 parse 阶段直接 ack，否则受限回款会永久卡在 PAYMENT_INTENT_ACTIVE。
  if (tradeState === 'FAIL' || tradeState === 'CLOSE') {
    return {
      orderNo: outTradeNo,
      tradeState,
      _lakalaTerminalPayment: true,
      _httpEntry: true,
    }
  }
  // 其它非成功状态（INIT/CREATE/DEAL/UNKNOWN）：仍可能在途，保留意图并 ack 等后续通知。
  if (tradeState !== 'SUCCESS') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: `非成功状态 ${tradeState} ack` } }
  }

  // 入账基准用 total_amount（本次/订单应付额 = 我方 preorder 传入额）。
  // payer_amount 是"用户实付"，扣了银行立减金/平台立减/红包等"渠道·银行出资"营销立减；
  // 这些立减由银行/平台补贴、商户全额到账，订单不应记为少收/部分支付。
  // 订单优惠(优惠券/储值卡)已在下单时编入 total_amount，支付侧立减不再二次扣减 received。
  // （payer_amount 仍随整 body 落 external_trade_info 作快照）
  let effectiveFen = totalAmountFen
  if (!effectiveFen || effectiveFen <= 0) {
    if (payerAmountFen > 0) {
      console.warn('[payNotify] total_amount 缺失，兜底 payer_amount=', payerAmountFen, 'outTradeNo=', outTradeNo)
      effectiveFen = payerAmountFen
    }
  }

  // 推断付款方式（聚合主扫：account_type 顶层字段直接用）
  const paymentMethod = accountType === 'ALIPAY' ? '支付宝' : '微信'

  return {
    orderNo: outTradeNo,           // out_trade_no（含 _unixSec 后缀，下游 replace(/_\d+$/, '') 剥）
    transactionId: tradeNo,        // 拉卡拉交易流水号，作 external_txn_id 幂等键
    payAmount: Math.round(effectiveFen) / 100,
    paymentMethod,
    // 透传整个扁平 body 作为 sale_order_payments.external_trade_info JSONB 快照；
    // admin 退款 cron 取 .acc_trade_no / .trade_no / .log_no 字段路径与原嵌套 order_trade_info.* 在顶层下访问保持一致
    tradeInfo: body,
    _httpEntry: true,
  }
}

// 测试可见：聚合主扫 HTTP 回调字段映射（含 total_amount 入账基准）单测直接调用
exports.parseHttpTriggerEvent = parseHttpTriggerEvent

/**
 * 对单笔微信交易上报「用户自提」发货（查 openid + 商品描述 → 调微信 upload_shipping_info）。
 * 回调即时上报与定时补偿共用此核心。调用方负责 try/catch（本函数会向上抛 PG/网络异常）。
 *
 * 微信 errcode 语义：
 *   - 0          上报成功
 *   - 10060002   该交易已上报过发货（幂等命中，视为成功）
 *   - 10060001   支付单不存在 —— 拉卡拉服务商交易刚支付、微信支付单尚未同步到「发货信息管理」
 *                系统（付款后通常 ~10 秒内同步），而回调在 ~2 秒内即触发，故首次多半命中此码。
 *                属预期内、待定时补偿 runShippingBackfill 稍后重试，不计为错误。
 *   - 其它        真实失败（记 error 日志）
 *
 * @param {import('pg').Pool} pg
 * @param {string} saleOrderId
 * @param {string} wxTxnId  微信交易单号（拉卡拉回调的 acc_trade_no）
 * @returns {Promise<{status:'ok'|'pending'|'skip'|'fail', errcode?:number}>}
 */
async function reportShippingForOrder(pg, saleOrderId, wxTxnId) {
  if (!wxTxnId) {
    console.warn('[payNotify/wx-shipping] 缺微信交易单号(acc_trade_no)，跳过上报:', saleOrderId)
    return { status: 'skip' }
  }
  // 付款人 openid（客户端 appid 下）；WorkFine 同步顾客可能无 openid → 跳过
  const openidRes = await pg.query(
    `SELECT u.openid
       FROM sale_orders o
       JOIN client_wechat_users u ON u.user_id = o.client_user_id
      WHERE o.sale_order_id = $1`,
    [saleOrderId]
  )
  const openid = openidRes.rows[0]?.openid
  if (!openid) {
    console.warn('[payNotify/wx-shipping] 订单无付款人 openid，跳过上报:', saleOrderId)
    return { status: 'skip' }
  }

  // 商品描述：取明细商品名去重拼接，截断到 120 字（微信 item_desc 上限 128）；缺名兜底
  const itemRes = await pg.query(
    `SELECT product_name FROM sale_items WHERE sale_order_id = $1 AND product_name IS NOT NULL`,
    [saleOrderId]
  )
  const names = [...new Set(itemRes.rows.map((r) => r.product_name).filter(Boolean))]
  let itemDesc = names.join('、') || '美容服务'
  if (itemDesc.length > 120) itemDesc = itemDesc.slice(0, 117) + '...'

  const res = await wxShipping.uploadSelfPickupShipping({ transactionId: wxTxnId, openid, itemDesc })
  const errcode = res && res.errcode
  if (errcode === 0 || errcode === 10060002) {
    console.log('[payNotify/wx-shipping] 上报成功:', saleOrderId, errcode === 10060002 ? '(已上报,幂等)' : '')
    return { status: 'ok', errcode }
  }
  if (errcode === 10060001) {
    // 支付单尚未同步到发货系统，待定时补偿重试（非错误，不刷 error 日志）
    console.log('[payNotify/wx-shipping] 支付单未同步，待定时补偿重试:', saleOrderId)
    return { status: 'pending', errcode }
  }
  console.error('[payNotify/wx-shipping] 上报失败:', saleOrderId, errcode, res && res.errmsg)
  return { status: 'fail', errcode }
}

/**
 * 回调即时上报（best-effort）——付款回调成功后尝试一次，绝不抛错。
 *
 * 触发条件：WX_SHIPPING_ENABLED=true + 有 CLIENT_APPSECRET + 微信渠道 + 拿到 acc_trade_no。
 * 支付宝订单 / callFunction 入口（无 tradeInfo 快照）一律跳过。
 *
 * 注：拉卡拉服务商交易刚支付时微信支付单常未同步（首次多半返回 10060001 pending），由定时补偿
 * runShippingBackfill 兜底重试；故此处失败 / 未同步绝不影响给拉卡拉的 SUCCESS 应答。
 *
 * @param {import('pg').Pool} pg
 * @param {{ saleOrderId:string, paymentMethod:string, tradeInfo:any }} p
 */
async function reportWxShippingSafe(pg, { saleOrderId, paymentMethod, tradeInfo }) {
  try {
    if (!wxShipping.isEnabled()) return
    if (paymentMethod !== '微信') return
    if (!tradeInfo) return  // callFunction 入口无回调快照，取不到微信交易单号
    await reportShippingForOrder(pg, saleOrderId, tradeInfo.acc_trade_no)
  } catch (e) {
    console.error('[payNotify/wx-shipping] 上报异常(非致命):', saleOrderId, e && e.message)
  }
}

/**
 * 微信发货补偿上报（CloudBase 定时触发器入口）。
 *
 * 背景：付款回调内即时上报常因「支付单尚未同步」(10060001) 失败——拉卡拉服务商交易支付后，
 * 微信支付单同步到「发货信息管理」系统通常需 ~10 秒，而回调在 ~2 秒内就完成。故由定时器每分钟
 * 扫描近期已支付的微信单补偿上报，直到成功（微信幂等：已上报返回 10060002 视为成功）。
 *
 * 窗口下界 now()-30s：给微信同步留时间（早于此回调刚试过，多半还没同步）。
 * 窗口上界 now()-30min：覆盖同步延迟 + 充足重试次数；超窗仍失败者已非时序问题，停止避免无限重试。
 * 美容院单量小，窗口内通常 0~2 单，无状态重复扫描开销可忽略（已上报单走 10060002 幂等跳过）。
 *
 * @returns {Promise<{code:string, message:string}>}
 */
async function runShippingBackfill() {
  if (!wxShipping.isEnabled()) {
    console.log('[payNotify/wx-shipping] backfill skip: 未启用(WX_SHIPPING_ENABLED/CLIENT_APPSECRET)')
    return { code: 'SUCCESS', message: 'wx-shipping disabled' }
  }
  const pg = getPg()
  const { rows } = await pg.query(
    `SELECT sale_order_id, external_trade_info->>'acc_trade_no' AS wx_txn
       FROM sale_order_payments
      WHERE payment_method = '微信'
        AND external_trade_info->>'acc_trade_no' IS NOT NULL
        AND created_at <  now() - interval '30 seconds'
        AND created_at >  now() - interval '30 minutes'
      ORDER BY created_at ASC`
  )
  let ok = 0, pending = 0, failed = 0, skipped = 0
  for (const r of rows) {
    try {
      const res = await reportShippingForOrder(pg, r.sale_order_id, r.wx_txn)
      if (res.status === 'ok') ok++
      else if (res.status === 'pending') pending++
      else if (res.status === 'skip') skipped++
      else failed++
    } catch (e) {
      failed++
      console.error('[payNotify/wx-shipping] backfill 单笔异常(非致命):', r.sale_order_id, e && e.message)
    }
  }
  console.log('[payNotify/wx-shipping] backfill done',
    JSON.stringify({ scanned: rows.length, ok, pending, failed, skipped }))
  return { code: 'SUCCESS', message: `backfill scanned=${rows.length} ok=${ok} pending=${pending} failed=${failed}` }
}

/**
 * 解析门店关联的拉卡拉商户（定时补偿用，独立副本，逻辑同 clientApi order.js resolveLakalaMerchant）。
 * 一店一商户：stores.lakala_merchant_id → lakala_merchants；未启用 / 未配商户号 / 缺终端号一律返回 null
 * （对账 best-effort 静默 skip。与 clientApi 端 term_no 缺失 throw 不同——clientApi 由 confirmPayment
 * 的 try/catch 降级为 lakela_not_configured，本端直接 null；两端最终都不传播异常）。
 */
async function resolveLakalaMerchantForReconcile(storeId) {
  if (!lakalaConfig.isReady()) return null
  if (!storeId) return null
  const pg = getPg()
  const res = await pg.query(
    `SELECT lm.merchant_no, lm.term_no, lm.enabled
       FROM stores s
       JOIN lakala_merchants lm ON lm.id = s.lakala_merchant_id
      WHERE s.store_id = $1`,
    [storeId]
  )
  if (res.rows.length === 0) return null
  const row = res.rows[0]
  if (!row.enabled) return null
  if (!row.merchant_no) return null
  if (!row.term_no) return null
  return { merchantNo: row.merchant_no, termNo: row.term_no }
}

/**
 * 支付回调丢失定时补偿（issue #37）。
 *
 * payNotify 异步回调偶发丢失会让"钱已扣、订单仍待支付"。本任务每分钟（CloudBase Timer 触发器）
 * 扫描「拉卡拉下单成功 + received=0 + 待支付/部分支付 + 90s~30min」的订单，主动 queryTrade 查真实状态，
 * SUCCESS 则 cloud.callFunction 自调 payNotify main（event 入口）触发与回调同款的幂等入账。
 *
 * 窗口：90s 下界给正常回调留时间（避免与前端轮询/正常回调抢）；30min 上界超窗已非时序问题，停止避免无限扫。
 * 与前端 confirmPayment 轮询互补：前端覆盖用户在线场景，本任务覆盖用户付款后长时间不回订单页的兜底。
 * 两者最终都走 payNotify 幂等入账，重复安全（uq_sop_txn / uq_sop_first_payment / CAS 守卫）。
 *
 * @returns {Promise<{code:string, message:string}>}
 */
async function runPaymentReconcile() {
  if (!isPayNotifyEnabled()) {
    console.log('[payNotify/reconcile] skip: 未启用')
    return { code: 'SUCCESS', message: 'reconcile disabled' }
  }
  const pg = getPg()
  // 窗口锚 updated_at（createLakalaPreorder 写 updated_at 反映最近一次拉卡拉下单）：覆盖老订单回款回调
  // 丢失（回款覆写 lakala_out_order_no 但不动 sale_order_datetime，故 sale_order_datetime 锚不到回款）。
  // LIMIT 20 + 串行循环（每单 PG+HTTPS+callFunction）避免超 CloudBase Timer 超时；美容院单量小窗口内通常 0~2 单。
  const { rows } = await pg.query(
    `SELECT sale_order_id, store_id, lakala_out_order_no, payment_method
       FROM sale_orders
      WHERE lakala_out_order_no IS NOT NULL
        AND status IN ('待支付', '部分支付')
        AND updated_at > now() - interval '30 minutes'
        AND updated_at < now() - interval '90 seconds'
      ORDER BY updated_at ASC
      LIMIT 20`)
  let ok = 0
  let skip = 0
  let failed = 0
  for (const o of rows) {
    try {
      const merchant = await resolveLakalaMerchantForReconcile(o.store_id)
      if (!merchant) { skip++; continue }
      const resp = await lakalaClient.queryTrade({
        merchantNo: merchant.merchantNo,
        termNo: merchant.termNo,
        outTradeNo: o.lakala_out_order_no,
      })
      if (resp && ['FAIL', 'CLOSE'].includes(resp.tradeState)) {
        await pg.query(
          `UPDATE sale_orders
           SET lakala_out_order_no = NULL, updated_at = NOW()
           WHERE sale_order_id = $1
             AND status IN ('待支付', '部分支付')
             AND lakala_out_order_no = $2`,
          [o.sale_order_id, o.lakala_out_order_no]
        )
        skip++
        continue
      }
      if (!resp || resp.tradeState !== 'SUCCESS') { skip++; continue }
      // 已入账（external_txn_id = 拉卡拉 tradeNo 已存在）→ 幂等跳过，避免每分钟重复 callFunction
      const paid = await pg.query(
        'SELECT 1 FROM sale_order_payments WHERE external_txn_id = $1 LIMIT 1',
        [resp.tradeNo]
      )
      if (paid.rows.length > 0) { skip++; continue }
      const payAmount = Math.round(Number(resp.totalAmountFen || 0)) / 100
      if (!(payAmount > 0)) { skip++; continue }
      const paymentMethod = o.payment_method === '支付宝' ? '支付宝' : '微信'
      // 自调 payNotify main（event 入口）触发同款幂等入账；event.Type 非 Timer 不会再次进入本任务，无递归
      const r = await cloud.callFunction({
        name: 'payNotify',
        data: {
          orderNo: o.lakala_out_order_no,
          transactionId: resp.tradeNo,
          payAmount,
          paymentMethod,
          tradeInfo: resp.raw || null,
        },
      })
      const result = r && r.result
      if (result && result.code === 'SUCCESS') {
        ok++
      } else {
        skip++
        console.warn('[payNotify/reconcile] 入账未成功:', o.sale_order_id, JSON.stringify(result))
      }
    } catch (e) {
      failed++
      console.error('[payNotify/reconcile] 单笔异常(非致命):', o.sale_order_id, e && e.message)
    }
  }
  console.log('[payNotify/reconcile] done',
    JSON.stringify({ scanned: rows.length, ok, skip, failed }))
  return { code: 'SUCCESS', message: `reconcile scanned=${rows.length} ok=${ok} skip=${skip} fail=${failed}` }
}

// 测试可见
exports.reportWxShippingSafe = reportWxShippingSafe
exports.reportShippingForOrder = reportShippingForOrder
exports.runShippingBackfill = runShippingBackfill
exports.runPaymentReconcile = runPaymentReconcile

/**
 * 在本次线上到账事务内兑现订单当前绑定的待扣储值卡。
 *
 * initial pending 来自开单时 sale_orders.pending_prepaid_card_amount；repay intents 来自
 * client.repay 写入的待支付储值卡流水。调用方已锁定 intents，并在本函数返回后统一写
 * sale_orders.received/status，避免“先标部分支付并早退、卡款永远不扣”的状态漂移。
 */
async function settlePendingPrepaidForPayment(client, {
  targetOrder,
  targetOrderNo,
  pendingIntentRows,
  pendingIntentAmount,
  now,
}) {
  if (!targetOrder.client_user_id) return 0

  let consumed = 0
  const initialPendingCardAmount = Math.max(
    0,
    Math.round(
      (Number(targetOrder.pending_prepaid_card_amount || 0) - pendingIntentAmount) * 100
    ) / 100,
  )

  if (initialPendingCardAmount > 0) {
    const dupCheck = await client.query(
      `SELECT 1 FROM card_transactions
       WHERE external_ref = $1 AND type = '扣款' LIMIT 1`,
      [`card-deduct-${targetOrderNo}`]
    )
    if (dupCheck.rows.length === 0) {
      const cardRow = await client.query(
        `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
        [targetOrder.client_user_id]
      )
      if (cardRow.rows.length === 0
          || Number(cardRow.rows[0].balance) + 0.001 < initialPendingCardAmount) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足以完成扣款')
      }
      const cardId = cardRow.rows[0].card_id
      await client.query(
        `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
        [initialPendingCardAmount, cardId]
      )
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
         VALUES ($1, '扣款', $2, $3, $4, NOW())
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardId, -initialPendingCardAmount, targetOrderNo, `card-deduct-${targetOrderNo}`]
      )
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, operator_employee_id,
          note, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'notify', NULL,
          $3, $4, $4)`,
        [targetOrderNo, initialPendingCardAmount, `储值卡抵扣 订单 ${targetOrderNo}`, now]
      )
      await client.query(
        `UPDATE sale_orders
         SET pending_prepaid_card_amount = GREATEST(
               0, pending_prepaid_card_amount::numeric - $1::numeric
             ),
             updated_at = $2
         WHERE sale_order_id = $3`,
        [initialPendingCardAmount, now, targetOrderNo]
      )
      consumed = initialPendingCardAmount
      console.log(`[payNotify] 消费扣款: order=${targetOrderNo}, card=${cardId}, amount=${initialPendingCardAmount}`)
    } else {
      console.log(`[payNotify] 消费扣款幂等跳过: order=${targetOrderNo}`)
    }
  }

  if (pendingIntentRows.length > 0 && pendingIntentAmount > 0) {
    const cardRow = await client.query(
      `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
      [targetOrder.client_user_id]
    )
    if (cardRow.rows.length === 0
        || Number(cardRow.rows[0].balance) + 0.001 < pendingIntentAmount) {
      throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足以完成混合回款抵扣')
    }
    const cardId = cardRow.rows[0].card_id
    await client.query(
      `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
      [pendingIntentAmount, cardId]
    )
    for (const intent of pendingIntentRows) {
      const amount = Math.round(Number(intent.amount) * 100) / 100
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
         VALUES ($1, '扣款', $2, $3, $4, NOW())
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardId, -amount, targetOrderNo, `card-repay-intent-${intent.id}`]
      )
      await client.query(
        `UPDATE sale_order_payments
         SET status = '已支付', paid_at = $1
         WHERE id = $2 AND status = '待支付'`,
        [now, intent.id]
      )
    }
    await client.query(
      `UPDATE sale_orders
       SET pending_prepaid_card_amount = GREATEST(
             0, pending_prepaid_card_amount::numeric - $1::numeric
           ),
           updated_at = $2
       WHERE sale_order_id = $3`,
      [pendingIntentAmount, now, targetOrderNo]
    )
    consumed = Math.round((consumed + pendingIntentAmount) * 100) / 100
    console.log(`[payNotify] 混合回款储值卡抵扣消费: order=${targetOrderNo}, card=${cardId}, amount=${pendingIntentAmount}`)
  }

  return consumed
}

/**
 * 云函数入口
 *
 * 注意：member_level（钻石等级）由 cronTask 每日凌晨3点统一重算，本函数不直接更新。
 */
exports.main = async (event) => {
  // Admin 系统自检：先于支付开关分流，仅做 HMAC + PG SELECT 1。
  if (event && event.action === 'system.health') {
    try {
      verifyHealthPayload(event.payload, 'payNotify')
      await getPg().query('SELECT 1 AS ok')
      return { code: 0, message: 'success', data: { ok: true, checkedAt: new Date().toISOString() } }
    } catch (error) {
      const parsed = parseErrorPrefix(error && error.message)
      return {
        code: parsed && parsed.prefix === 'UNAUTHORIZED' ? -401 : -1,
        message: parsed ? parsed.displayMessage : '服务器内部错误',
        errorType: parsed ? parsed.prefix : null,
        data: null,
      }
    }
  }

  // ========== CloudBase 定时触发器：微信发货补偿上报 ==========
  // 独立于支付回调，仅需 WX_SHIPPING_ENABLED + CLIENT_APPSECRET + PG（不依赖拉卡拉配置），
  // 故先于 isPayNotifyEnabled 分流；定时事件由 CloudBase 注入 event.Type==='Timer'。
  if (event && event.Type === 'Timer') {
    // 定时器同时跑：微信发货补偿上报 + 支付回调丢失对账（issue #37）。两任务隔离 try/catch，
    // 避免 backfill 抛错（PG 瞬断等）跳过 reconcile —— 那正是本 PR 要防的故障模式。
    try { await runShippingBackfill() } catch (e) { console.error('[payNotify/wx-shipping] backfill 异常(非致命):', e && e.message) }
    return await runPaymentReconcile()
  }

  // ========== 启用开关：env PAYNOTIFY_ENABLED=true + lakalaConfig.isReady() ==========
  if (!isPayNotifyEnabled()) {
    const safeEvent = event && typeof event === 'object' ? event : {}
    console.warn('[payNotify] disabled invocation rejected',
      JSON.stringify({ reason: 'NOT_ENABLED_OR_NOT_READY', httpMethod: safeEvent.httpMethod || null }))
    if (safeEvent.httpMethod === 'POST') {
      return { statusCode: 503, body: JSON.stringify({ code: 'FAIL', message: 'NOT_READY' }) }
    }
    return { code: -403, message: 'PERMISSION_DENIED: PAYNOTIFY_DISABLED', data: null }
  }

  // ========== HTTP 触发器入口（拉卡拉异步通知）：IP 白名单 + 3 行验签 + 字段映射 ==========
  let httpEntryResult = null
  try {
    httpEntryResult = parseHttpTriggerEvent(event)
  } catch (httpErr) {
    const statusCode = httpErr._statusCode || 400
    console.warn('[payNotify] HTTP entry rejected:', httpErr.message)
    return { statusCode, body: JSON.stringify({ code: 'FAIL', message: httpErr.message }) }
  }
  // 退款回调 / 非成功状态：拉卡拉只需收到 SUCCESS 终止重试
  if (httpEntryResult && httpEntryResult._lakalaCallbackAcked) {
    return { statusCode: 200, body: JSON.stringify(httpEntryResult.ackBody) }
  }

  // 业务事件归一化：HTTP 入口 → 映射结果；callFunction 入口 → 直接用 event
  const businessEvent = httpEntryResult || event
  const isHttpEntry = !!httpEntryResult

  try {
    if (businessEvent && businessEvent._lakalaTerminalPayment) {
      // FAIL/CLOSE 会清除活动支付意图，属于写操作；只接受已完成 IP/签名校验的 HTTP 映射结果。
      // callFunction 入口即使伪造 _httpEntry 字段也不会令 isHttpEntry 成真。
      if (!isHttpEntry) {
        console.warn('[payNotify] unauthenticated terminal callback rejected')
        return { code: -403, message: 'PERMISSION_DENIED: LAKALA_TERMINAL_CALLBACK_HTTP_ONLY', data: null }
      }
      const terminalOutTradeNo = String(businessEvent.orderNo || '')
      const terminalSaleOrderId = terminalOutTradeNo.replace(/_\d+$/, '')
      if (terminalOutTradeNo && terminalSaleOrderId) {
        const pg = getPg()
        await pg.query(
          `UPDATE sale_orders
           SET lakala_out_order_no = NULL, updated_at = NOW()
           WHERE sale_order_id = $1
             AND status IN ('待支付', '部分支付')
             AND lakala_out_order_no = $2`,
          [terminalSaleOrderId, terminalOutTradeNo]
        )
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ code: 'SUCCESS', message: `终态 ${businessEvent.tradeState} 已确认` }),
      }
    }

    const { orderNo, transactionId, payAmount: payAmountInput, paymentMethod: paymentMethodInput, tradeInfo } = businessEvent
    // PII 精简日志：不打全 event，仅 orderNo + txn 前 8 位
    const txnSummary = transactionId ? String(transactionId).slice(0, 8) : 'null'
    console.log('[payNotify] received', JSON.stringify({ orderNo, txn: txnSummary, isHttpEntry }))

    if (!orderNo) {
      return isHttpEntry
        ? { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: '缺少 orderNo' }) }
        : { code: 'FAIL', message: '缺少 orderNo' }
    }
    // 移除 mock_txn_${Date.now()} fallback（P0-04v2-06），缺 transactionId 直接拒绝
    if (!transactionId) {
      return isHttpEntry
        ? { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: '缺少 transactionId' }) }
        : { code: 'FAIL', message: '缺少 transactionId' }
    }

    const pg = getPg()

    // 拉卡拉收银台下单时 out_order_no = `${saleOrderId}_${unixSeconds}`（防判重后缀，见 order.js createLakalaCounterOrder）。
    // 回调原样回传该 out_order_no，而 sale_orders.sale_order_id 无此后缀 → 必须剥离才能匹配订单，
    // 否则 `WHERE sale_order_id = out_order_no` 永远落空、回调入账失败（联调回调侧根因）。
    // sale_order_id 形如 FY-XSD-WX-YYMMDDNNNN（无下划线），故剥尾部 `_<数字>` 安全且对无后缀输入幂等。
    const saleOrderId = String(orderNo).replace(/_\d+$/, '')

    // 同一查询读取订单和 txn 幂等标记，但业务判断仍严格先看 transaction_already_paid：
    // 首次成功处理会清空活动意图，随后同一回调重投仍应 ACK。
    // 注：wechat_transaction_id 列已在 migration 0018 DROP，三方流水号下沉到 sale_order_payments.external_txn_id
    const orderResult = await pg.query(
      `SELECT status, payment_method, preferred_employee_id,
              total_amount, payable_amount, client_user_id, store_id,
              prepaid_card_amount, pending_prepaid_card_amount,
              sale_order_type, ref_sale_order_id, market_name,
              lakala_out_order_no, first_payment_amount,
              EXISTS (
                SELECT 1 FROM sale_order_payments p
                WHERE p.sale_order_id = sale_orders.sale_order_id
                  AND p.external_txn_id = $2
                  AND p.status = '已支付'
              ) AS transaction_already_paid
       FROM sale_orders WHERE sale_order_id = $1`,
      [saleOrderId, transactionId]
    )

    if (orderResult.rows.length === 0) {
      console.error('[payNotify] 订单不存在:', orderNo)
      return { code: 'FAIL', message: '订单不存在' }
    }

    const order = orderResult.rows[0]

    if (order.transaction_already_paid === true) {
      console.log('[payNotify] 重复回调（txn 已入账），跳过:', orderNo, txnSummary)
      return isHttpEntry
        ? { statusCode: 200, body: JSON.stringify({ code: 'SUCCESS', message: '已处理（幂等）' }) }
        : { code: 'SUCCESS', message: '已处理（幂等）' }
    }

    // 回款单已在 2026-04-26 sale-order-domain-refactor 从 sale_order_type 枚举移除（合并到 sale_order_payments.change_type='回款'）。
    // 这里不再判别 isRepaymentCredential，所有支付都按原单推进；回款由 change_type 区分。
    const targetOrderNo = saleOrderId
    let targetOrder = order
    const isRepaymentCredential = false  // 兼容下方未清理的引用（如有），后续整体重构时移除

    // 未知 txn 到达终态订单不是幂等，不能 ACK 成功掩盖真实扣款未入账。
    if (order.status === '已支付' || order.status === '已完成') {
      console.warn('[payNotify] 终态订单收到未知 txn:', orderNo, txnSummary)
      return isHttpEntry
        ? { statusCode: 409, body: JSON.stringify({ code: 'FAIL', message: '订单已终态且交易未入账' }) }
        : { code: 'FAIL', message: '订单已终态且交易未入账' }
    }

    // 处理 '待支付' / '部分支付' 两种状态
    if (order.status !== '待支付' && order.status !== '部分支付') {
      console.warn('[payNotify] 订单状态异常:', orderNo, order.status)
      return { code: 'FAIL', message: `订单状态异常: ${order.status}` }
    }

    const now = new Date()
    // P0-04v2-06：transactionId 必须真实存在（上面已校验），不再 fallback 到 mock_txn_${Date.now()}
    const txnId = transactionId
    // payment_method：默认沿用订单上记录的支付方式（pay/alipayPay 发起时已写入），
    // 允许回调事件显式覆盖（方便 staff 端走同一 payNotify 通道）。
    const paymentMethod = paymentMethodInput
      || (order.payment_method === '支付宝' ? '支付宝' : '微信')

    // 开启事务：更新订单 + 充值入账 + 自动创建业绩分配
    const client = await pg.connect()
    try {
      await client.query('BEGIN')

      // 所有回调先锁主单，再读取本场次 pending/received。这样同订单不同 txn 的并发回调会串行，
      // 后到事务能看到前一事务已兑现的卡款，避免对同一 pending 快照重复扣卡。
      const lockedOrderRes = await client.query(
        `SELECT status, payment_method, preferred_employee_id,
                total_amount, payable_amount, client_user_id, store_id,
                prepaid_card_amount, pending_prepaid_card_amount,
                sale_order_type, ref_sale_order_id, market_name,
                lakala_out_order_no, first_payment_amount
         FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE`,
        [targetOrderNo]
      )
      if (lockedOrderRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return { code: 'FAIL', message: '订单不存在' }
      }
      targetOrder = lockedOrderRes.rows[0]

      // 行锁后再次以 txn 查询幂等，覆盖两个相同回调并发进入、首个事务已提交并清空意图的场景。
      const lockedDuplicateTxn = await client.query(
        `SELECT 1 FROM sale_order_payments
         WHERE sale_order_id = $1
           AND external_txn_id = $2
           AND status = '已支付'
         LIMIT 1`,
        [targetOrderNo, txnId]
      )
      if (lockedDuplicateTxn.rows.length > 0) {
        await client.query('ROLLBACK')
        return isHttpEntry
          ? { statusCode: 200, body: JSON.stringify({ code: 'SUCCESS', message: '已处理（幂等）' }) }
          : { code: 'SUCCESS', message: '已处理（幂等）' }
      }
      if (!['待支付', '部分支付'].includes(targetOrder.status)) {
        await client.query('ROLLBACK')
        return isHttpEntry
          ? { statusCode: 409, body: JSON.stringify({ code: 'FAIL', message: '订单状态已变更且交易未入账' }) }
          : { code: 'FAIL', message: '订单状态已变更且交易未入账' }
      }

      if (!targetOrder.lakala_out_order_no
          || String(targetOrder.lakala_out_order_no) !== String(orderNo)) {
        await client.query('ROLLBACK')
        console.error('[payNotify] 非当前拉卡拉意图:', JSON.stringify({ saleOrderId: targetOrderNo, callbackOutTradeNo: orderNo, currentOutTradeNo: targetOrder.lakala_out_order_no || null }))
        return isHttpEntry
          ? { statusCode: 409, body: JSON.stringify({ code: 'FAIL', message: '非当前支付意图' }) }
          : { code: 'FAIL', message: '非当前支付意图' }
      }

      // ========== 核心幂等：INSERT payments 行（ON CONFLICT DO NOTHING） ==========
      //
      // 幂等键：uq_sop_txn (sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL
      //
      // **回款凭证单场景**：payments / 业务动作以 targetOrderNo（=原销售单）为准；
      //   凭证单本身在事务末尾再更新 status='已支付'。
      //
      // 先决定本次金额 payAmount：优先取 event.payAmount，否则按目标订单剩余应付推算
      //   remaining = payable_amount - Σ现金类 payments.amount（已支付, 首次/回款/退款）
      // actual/pending 储值卡均已从 payable_amount 扣除，且这里不累计储值卡流水，避免重复扣减。
      // 线上应付现金基准 = payable_amount 列（已编码充值折扣），旧单 NULL 用 total - prepaid 兜底。
      // 普通单 payable_amount == total - prepaid（不变）；充值单 payable(实付 980) ≠ total(面额 1000)，
      // 不用 payable 则 980 回调永远判为「部分支付」且储值卡不入账。
      const payableAmount = targetOrder.payable_amount != null
        ? Math.round(Number(targetOrder.payable_amount) * 100) / 100
        : Math.round(
            (Number(targetOrder.total_amount || 0)
              - Number(targetOrder.prepaid_card_amount || 0)
              - Number(targetOrder.pending_prepaid_card_amount || 0)) * 100
          ) / 100
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid_sum
         FROM sale_order_payments
         WHERE sale_order_id = $1
           AND status = '已支付'
           AND change_type IN ('首次支付','回款','退款')`,
        [targetOrderNo]
      )
      const paidSum = Number(sumRes.rows[0]?.paid_sum || 0)
      const remaining = Math.round((payableAmount - paidSum) * 100) / 100
      const thisPayAmount = (payAmountInput !== undefined && payAmountInput !== null)
        ? Math.round(Number(payAmountInput) * 100) / 100
        : remaining

      if (!(thisPayAmount > 0)) {
        throw new Error(`INVALID_PARAMS: 本次支付金额无效 ${thisPayAmount}`)
      }
      // P0-04v2-05 上限校验：本次支付金额不得超过剩余应付（+0.001 元浮点容差）
      if (thisPayAmount > remaining + 0.001) {
        throw new Error(`INVALID_PARAMS: 本次支付金额超过订单剩余应付 (${thisPayAmount} > ${remaining})`)
      }

      const frozenAmount = Number(targetOrder.first_payment_amount || 0)
      const expectedFrozenAmount = frozenAmount > 0 ? Math.min(frozenAmount, remaining) : 0
      if (frozenAmount > 0
          && Math.round(thisPayAmount * 100) !== Math.round(expectedFrozenAmount * 100)) {
        throw new Error(`INVALID_STATE: PAYMENT_INTENT_AMOUNT_MISMATCH: 回调金额与冻结金额不一致 (${thisPayAmount} != ${expectedFrozenAmount})`)
      }

      // change_type：
      //   - 回款凭证单回调：总是 '回款'（线上通道）
      //   - 普通销售单：判断是否已有 '首次支付' 行
      let changeType
      if (isRepaymentCredential) {
        changeType = '回款'
      } else {
        const firstPayCheck = await client.query(
          `SELECT 1 FROM sale_order_payments
           WHERE sale_order_id = $1
             AND status = '已支付'
             AND amount > 0
             AND (change_type = '首次支付' OR change_type IN ('回款', '储值卡抵扣'))
           LIMIT 1`,
          [targetOrderNo]
        )
        changeType = firstPayCheck.rows.length > 0 ? '回款' : '首次支付'
      }

      // INSERT payments（幂等：重复回调 ON CONFLICT DO NOTHING）
      // 注意：payments.sale_order_id 写 targetOrderNo（原销售单），不是凭证单
      // 两层 partial unique 防 TOCTOU：
      //   1) uq_sop_txn (sale_order_id, payment_method, external_txn_id) — 同 txnId 重复回调
      //   2) uq_sop_first_payment (sale_order_id) WHERE change_type='首次支付' AND status='已支付'
      //      — 同订单两个不同支付通道同时回调，避免双 '首次支付' 行
      // 任一索引命中均视为幂等成功（重复回调），静默 ACK
      let insertRes
      try {
        insertRes = await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method,
            external_txn_id, external_trade_info, status, source_end, operator_employee_id,
            note, created_at, paid_at
          ) VALUES ($1, $2, $3, $4, $5, $8, '已支付', 'notify', NULL, $6, $7, $7)
          ON CONFLICT (sale_order_id, payment_method, external_txn_id)
            WHERE external_txn_id IS NOT NULL
          DO NOTHING
          RETURNING id`,
          [
            targetOrderNo, changeType, thisPayAmount, paymentMethod, txnId,
            isRepaymentCredential
              ? `${paymentMethod} 回款到账 凭证 ${orderNo}`
              : `${paymentMethod} 回调到账`,
            now,
            // 受单交易信息快照（退款 origin 引用来源）；callFunction 入口无 tradeInfo → NULL
            tradeInfo ? JSON.stringify(tradeInfo) : null,
          ]
        )
      } catch (err) {
        if (err && err.code === '23505' && err.constraint === 'uq_sop_first_payment') {
          // 并发不同通道同时回调同订单，第二个落 uq_sop_first_payment；视为重复回调
          await client.query('ROLLBACK')
          console.log('[payNotify] 并发首次支付（uq_sop_first_payment 命中），跳过:', orderNo, txnId)
          return { code: 'SUCCESS', message: '已处理（幂等）' }
        }
        throw err
      }

      if (insertRes.rows.length === 0) {
        // uq_sop_txn 命中，重复回调；静默 ack 不再修改 sale_orders
        await client.query('ROLLBACK')
        console.log('[payNotify] 重复回调（uq_sop_txn 命中），跳过:', orderNo, txnId)
        return { code: 'SUCCESS', message: '已处理（幂等）' }
      }

      // 混合回款：本单可能有 client.repay 写下的「待支付储值卡抵扣」意向（线上款 + 储值卡共同覆盖尾款）。
      // 储值卡扣减推迟到此处与线上到账同事务执行，故判定整单结清时必须把待支付意向额一并计入，
      // 否则线上款单独 < 应付会被判为「部分支付」而储值卡永不入账、订单卡死。
      const pendingCardRes = await client.query(
        `SELECT id, amount FROM sale_order_payments
         WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'
         ORDER BY id
         FOR UPDATE`,
        [targetOrderNo]
      )
      const pendingCardRows = pendingCardRes.rows
      const pendingCardAmount = Math.round(
        pendingCardRows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100
      ) / 100

      // 卡款必须先于“部分支付”早退兑现。本函数与线上流水 INSERT、订单状态更新处于同一事务；
      // 任一步失败都会整体回滚，避免现金已入账但本场次储值卡仍悬空。
      const prepaidConsumedThisCallback = await settlePendingPrepaidForPayment(client, {
        targetOrder,
        targetOrderNo,
        pendingIntentRows: pendingCardRows,
        pendingIntentAmount: pendingCardAmount,
        now,
      })

      // INSERT 线上流水、兑现储值卡意向后，从已支付流水权威重聚合订单实收。
      // 不能只用“本次现金 + 本次卡款”：后续回款回调的 pending 已归零，否则会丢掉此前
      // 已结算的储值卡金额（如首场现金 500 + 卡 500，第二场现金 500 应累计为 1500）。
      const paidAggregateRes = await client.query(
        `SELECT
           COALESCE(SUM(CASE
             WHEN status = '已支付' AND change_type IN ('首次支付','回款','退款')
               THEN amount ELSE 0 END), 0) AS cash_paid_sum,
           COALESCE(SUM(CASE
             WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
               THEN amount ELSE 0 END), 0) AS received_sum
         FROM sale_order_payments
         WHERE sale_order_id = $1`,
        [targetOrderNo]
      )
      // payable_amount 已排除 actual/pending 储值卡，终态仍按现金净到账判断。
      const newPaidSum = Math.round(Number(paidAggregateRes.rows[0]?.cash_paid_sum || 0) * 100) / 100
      const fullyPaid = newPaidSum + 0.001 >= payableAmount
      const newStatus = fullyPaid ? '已支付' : '部分支付'
      const newReceived = Math.round(Number(paidAggregateRes.rows[0]?.received_sum || 0) * 100) / 100

      if (!['部分支付', '已支付', '已完成'].includes(targetOrder.status)) {
        const documentType = await classifySaleOrderDocumentType(
          client,
          targetOrder.client_user_id,
          targetOrderNo,
        )
        await client.query(
          `UPDATE sale_orders SET document_type = $1::document_type
           WHERE sale_order_id = $2 AND status = $3`,
          [documentType, targetOrderNo, targetOrder.status],
        )
      }

      // 1. 更新目标订单：received 累加、status 置新值、paid_at（全额时）
      // CAS 守卫（state-machine-cas-guard ticket）：只允许从 待支付/部分支付 翻转
      // 注：wechat_transaction_id 列已 DROP，三方流水号由上面 INSERT sale_order_payments.external_txn_id 承担
      const updResult = await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             received = $2,
             first_payment_amount = NULL,
             lakala_out_order_no = NULL,
             paid_at = CASE WHEN $1::text = '已支付' THEN $3 ELSE paid_at END,
             updated_at = $3
         WHERE sale_order_id = $4
           AND status IN ('待支付', '部分支付')
           AND lakala_out_order_no = $5`,
        [newStatus, newReceived, now, targetOrderNo, orderNo]
      )
      if (updResult.rowCount === 0) {
        // 主单已被其他事务先翻至终态（已支付/已关闭等），回滚 payment 插入并幂等 ack 微信
        await client.query('ROLLBACK')
        console.warn('[payNotify] state-transition-blocked:', targetOrderNo, '→', newStatus)
        return { code: 'SUCCESS', message: '订单状态已变更（幂等）' }
      }

      // 本次线上回款主流水行 id（按回款逐笔分配的归属键）
      const onlinePaymentId = insertRes.rows[0].id

      // 1b. 回款凭证单：已在 2026-04-26 sale-order-domain-refactor 重构（回款下沉到 sale_order_payments.change_type='回款'），下方分支永远 false 走不到
      if (isRepaymentCredential) {
        const credUpd = await client.query(
          `UPDATE sale_orders
           SET status = '已支付'::order_status,
               paid_at = COALESCE(paid_at, $1),
               updated_at = $1
           WHERE sale_order_id = $2
             AND status IN ('待支付', '部分支付')`,
          [now, orderNo]
        )
        if (credUpd.rowCount === 0) {
          // 凭证单允许延迟一致，仅记 warn 不 rollback
          console.warn('[payNotify] credential state-transition-blocked:', orderNo)
        }
      }

      // 按回款逐笔分配：部分到账也必须包含本场次已兑现的储值卡，保证 receipt 与 received 同口径。
      // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
      if (!fullyPaid) {
        const partialEventAmount = Math.round((thisPayAmount + prepaidConsumedThisCallback) * 100) / 100
        const perItemPartial = await capturePaymentAllocatables(client, {
          salePaymentId: onlinePaymentId,
          saleOrderId: targetOrderNo,
          eventAmount: partialEventAmount,
          directedItems: null,
        })
        await autoAllocateOnlinePayment(client, {
          salePaymentId: onlinePaymentId,
          saleOrderId: targetOrderNo,
          perItem: perItemPartial,
          eventAmount: partialEventAmount,
          preferredEmployeeId: targetOrder.preferred_employee_id,
          marketName: targetOrder.market_name,
          now,
        })
        await refreshOrderAllocationRollup(client, targetOrderNo)

        // paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
        // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
        await recalcPaidSessionsForOrder(client, targetOrderNo)

        await client.query('COMMIT')
        console.log('[payNotify] 订单部分支付到账:', orderNo, `received=${newReceived}`)
        // 微信发货上报：本次微信交易已到账即上报（每笔交易各对应发货管理一条订单）
        await reportWxShippingSafe(pg, { saleOrderId: targetOrderNo, paymentMethod, tradeInfo })
        return { code: 'SUCCESS', message: '部分支付已到账' }
      }

      // 2. 2026-05-21 单品合并：单品 1 年有效期自动赋值已移除（原在此按 product_type='单品' 写 expire_date）

      // 3a. 充值卡入账（2026-05-20 重构）
      // 识别 sale_orders.sale_order_type='充值单'；面值直接取 sale_orders.total_amount，
      // 实付已在 received 累加（payable_amount 入账）。
      // 必须在状态翻转之后、业绩分配之前；与上述 UPDATE 同事务保证原子性。
      // 幂等键 'card-topup-{saleOrderId}'（与 staff order.confirmOffline 同源）
      if (targetOrder.client_user_id && targetOrder.sale_order_type === '充值单') {
        const faceValue = Number(targetOrder.total_amount)
        if (faceValue > 0) {
          const dupCheck = await client.query(
            `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
            [targetOrderNo]
          )
          if (dupCheck.rows.length === 0) {
            // 确定性 card_id（Bug U）：一户一卡，避免 Date.now()+random 并发撞 PK
            const newCardId = `FY-CARD-${targetOrder.client_user_id}`
            const upsertRes = await client.query(
              `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (user_id) DO UPDATE
                 SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
               RETURNING card_id`,
              [newCardId, targetOrder.client_user_id, faceValue]
            )
            const cardId = upsertRes.rows[0].card_id
            await client.query(
              `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
               VALUES ($1, '充值', $2, $3, $4, NOW())
               ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
              [cardId, faceValue, targetOrderNo, `card-topup-${targetOrderNo}`]
            )
            console.log(`[payNotify] 充值入账: order=${targetOrderNo}, card=${cardId}, faceValue=${faceValue}`)
          } else {
            console.log(`[payNotify] 充值入账幂等跳过: order=${targetOrderNo}`)
          }
        }
      }

      // 3. 按回款逐笔分配：捕获本次回款（线上付款 + 本次储值卡消费）逐项可分配额，
      //    线上单自动 100% 分给开单销售员（提成率按本次回款额定档）；无 preferred 留待分配走手动。
      const fullEventAmount = Math.round((thisPayAmount + prepaidConsumedThisCallback) * 100) / 100
      // 退款感知定向（本次到账付清，fullEventAmount === remaining）：有退款时只分摊到未退行，
      // 避免非定向瀑布流把回款误充已退行；无退款 null 走原瀑布流，首次付清零变化。
      // （部分到额分支上方 directedItems:null 不动 —— 部分到账金额不定，定向 Σ 无法对齐 eventAmount）
      const notifyItemRows = await client.query(
        `SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
           FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
        [targetOrderNo]
      )
      const notifyRefundMap = await getPerItemRefundedMap(client, targetOrderNo)
      const notifyDirectedItems = computeRefundAwareDirectedItems(notifyItemRows.rows, notifyRefundMap)
      const perItemFull = await capturePaymentAllocatables(client, {
        salePaymentId: onlinePaymentId,
        saleOrderId: targetOrderNo,
        eventAmount: fullEventAmount,
        directedItems: notifyDirectedItems,
      })
      await autoAllocateOnlinePayment(client, {
        salePaymentId: onlinePaymentId,
        saleOrderId: targetOrderNo,
        perItem: perItemFull,
        eventAmount: fullEventAmount,
        preferredEmployeeId: targetOrder.preferred_employee_id,
        marketName: targetOrder.market_name,
        now,
      })
      await refreshOrderAllocationRollup(client, targetOrderNo)

      // paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
      // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
      await recalcPaidSessionsForOrder(client, targetOrderNo)

      // 4. 重算顾客历史消费档位
      // spending_tier 档位边界为固定值（含 '1990-1W' 档下界 1990），不随
      // system_configs.new_member_threshold 变化；门槛只影响 customer_type / member_level
      // 与 admin refreshSpendingTierTx (refunds.ts) / staffApi refreshSpendingTier 跨端字面对齐：
      // 仅纳入"销售单 + 转换单"做消费档位累计；
      // 充值单（预收，2026-05-20 充值卡剥离 SKU 化新增）/ 内部单 / 寄存单不算消费。
      if (targetOrder.client_user_id) {
        await client.query(
          `UPDATE client_wechat_users
           SET spending_tier = CASE
             WHEN t.total >= 100000 THEN '10W+'
             WHEN t.total >= 60000  THEN '6-10W'
             WHEN t.total >= 30000  THEN '3-6W'
             WHEN t.total >= 10000  THEN '1-3W'
             WHEN t.total >= 1990   THEN '1990-1W'
             ELSE '<1990'
           END::spending_tier,
           updated_at = NOW()
           FROM (
             SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) AS total
             FROM sale_orders
             WHERE client_user_id = $1
               AND status IN ('已支付', '已完成')
               AND sale_order_type IN ('销售单','转换单')
           ) t
           WHERE user_id = $1`,
          [targetOrder.client_user_id]
        )

        // 5. 重算顾客类型（只升不降，已是会员客则跳过）
        const curType = await client.query(
          'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
          [targetOrder.client_user_id]
        )
        if (curType.rows[0]?.customer_type !== '会员客') {
          const threshold = await getMemberThreshold()

          // 七处 SQL 独立副本（staffApi routes/order.js + clientApi routes/order.js + payNotify index.js
          // + admin actions/orders.ts + admin lib/recompute-customer-tags.ts
          // + db/scripts/recalc-all-customer-types.js + db/scripts/recalc-became-member-at.js）。
          // 修改时必须同步其余六处；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js 守护。
          // #187（2026-09-18）：按单笔订单的非体验部分毛实收判定，落地 Q5.2 决策。
          const typeResult = await client.query(
            `${RECALC_CUSTOMER_TYPE_CTE}
             SELECT CASE
               WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial >= $2) THEN '会员客'
               WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial > 0)   THEN '小美客'
               WHEN EXISTS (SELECT 1 FROM order_amounts WHERE trial > 0)       THEN '体验客'
               ELSE '流量客'
             END AS computed_type`,
            [targetOrder.client_user_id, threshold]
          )

          const newType = typeResult.rows[0].computed_type
          // 只升不降；若跃迁为 '会员客'，同步写入 became_member_at
          // TODO: 将来若开放降级路径，需同步 UPDATE became_member_at = NULL。
          const upgradeResult = await client.query(
            `UPDATE client_wechat_users
             SET customer_type = $2::customer_type, updated_at = NOW()
             WHERE user_id = $1
               AND (CASE customer_type
                      WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
                      WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
                    END)
                 < (CASE $2::customer_type
                      WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
                      WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
                    END)
             RETURNING customer_type`,
            [targetOrder.client_user_id, newType]
          )
          if (upgradeResult.rowCount > 0 && upgradeResult.rows[0].customer_type === '会员客') {
            // became_member_at 记为确立会员资格的首笔达标单时间（COALESCE(paid_at, created_at)）；
            // 选单子查询与本端下方 is_membership_upgrade 归因同源、选同一单。
            await client.query(
              `UPDATE client_wechat_users SET became_member_at = (
                 ${RECALC_CUSTOMER_TYPE_CTE}
                 SELECT COALESCE(o.paid_at, o.created_at) FROM sale_orders o
                 JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
                 WHERE oa.non_trial >= $2
                 ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
                 LIMIT 1
               ) WHERE user_id = $1`,
              [targetOrder.client_user_id, threshold]
            )
            // 给触发本次首次跃迁的达标销售单打会员升级标记。WHERE 与本端会员客判定 CASE 同源
            // （单笔达标）。paid_at 最早 = 确立会员资格的首笔达标单。
            await client.query(
              `UPDATE sale_orders SET is_membership_upgrade = true
               WHERE sale_order_id = (
                 ${RECALC_CUSTOMER_TYPE_CTE}
                 SELECT o.sale_order_id FROM sale_orders o
                 JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
                 WHERE oa.non_trial >= $2
                 ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
                 LIMIT 1
               )`,
              [targetOrder.client_user_id, threshold]
            )
          }
        }

        // 会员等级即时重算（只升不降；对所有会员客生效，含已是会员客后继续消费跨档；礼包留给 cron）
        await recalcMemberLevel(client, targetOrder.client_user_id, await getMemberThreshold(), 'payNotify')
      }

      // 6. 积分结算（订单链净额差值法，幂等）
      // targetOrderNo 已指向原销售单（回款凭证单场景上面已重映射），直接作为原单 id 传入
      const pointsResult = await settlePointsSafe(client, targetOrderNo, 'payNotify')
      if (pointsResult.delta) {
        console.log(`[payNotify] 积分结算: order=${targetOrderNo}, delta=${pointsResult.delta}, expected=${pointsResult.expected}`)
      }

      // 7. 分享礼：首单结清时向邀请人 + 新客各发一张动态面值代金券 + 一条站内消息
      // 仅在整单结清（fullyPaid=true）路径调用；回款凭证单场景以 targetOrderNo（原销售单）为幂等根键。
      // 幂等由 grantShareGift 内部 INSERT ... ON CONFLICT 保证；失败不阻塞主支付事务（ticket §9.4）。
      try {
        await client.query('SAVEPOINT sp_share_gift')
        const { grantShareGift } = require('./share-gift')
        const sgRes = await grantShareGift(client, {
          saleOrderId: targetOrderNo,
          clientUserId: targetOrder.client_user_id,
          paidAmount: newPaidSum,
          source: 'payNotify',
        })
        await client.query('RELEASE SAVEPOINT sp_share_gift')
        if (sgRes.granted) {
          console.log('[payNotify/share-gift] granted', sgRes)
        } else {
          console.log('[payNotify/share-gift] skipped', sgRes.reason)
        }
      } catch (sgErr) {
        // 分享礼失败不阻塞主支付事务
        try { await client.query('ROLLBACK TO SAVEPOINT sp_share_gift') } catch (e) {}
        console.error('[payNotify/share-gift] error (non-fatal):', sgErr)
      }

      await client.query('COMMIT')
      console.log('[payNotify] 订单支付成功:', orderNo)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // 微信「发货信息管理」自动上报（用户自提）——事务已提交、连接已释放后执行；
    // 与支付到账解耦，失败不影响给拉卡拉的 SUCCESS 应答
    await reportWxShippingSafe(pg, { saleOrderId: targetOrderNo, paymentMethod, tradeInfo })

    // 成功响应：HTTP 入口必须返回 {statusCode, body} 才能让 CloudBase HTTP 触发器透传给拉卡拉
    if (isHttpEntry) {
      return { statusCode: 200, body: JSON.stringify({ code: 'SUCCESS', message: '执行成功' }) }
    }
    return { code: 'SUCCESS', message: '成功' }
  } catch (err) {
    // [CC5] 用 parseErrorPrefix 给错误日志做归类（ops 按 errorType 监控告警）
    // 响应仍保持微信支付/拉卡拉协议要求的 {code: 'SUCCESS'|'FAIL', message} 外壳
    // P1-04v2-11：FAIL 响应不暴露内部 SQL / schema 错误细节
    const parsed = parseErrorPrefix(err && err.message)
    console.error('[payNotify] Error:', err, parsed ? { errorType: parsed.prefix } : { errorType: null })
    const safeMessage = parsed ? parsed.displayMessage : '内部错误'
    if (isHttpEntry) {
      return { statusCode: 500, body: JSON.stringify({ code: 'FAIL', message: safeMessage }) }
    }
    return { code: 'FAIL', message: safeMessage }
  }
}
