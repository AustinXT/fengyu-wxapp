/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')
const { settlePointsSafe } = require('./points')
const { parseErrorPrefix } = require('./error-codes')
const { recalcPaidSessionsForOrder } = require('./paid-sessions')
const lakalaSign = require('./utils/lakala-sign')
const lakalaConfig = require('./utils/lakala-config')

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
 * 拉卡拉回调约定（详见 sources/documents/拉卡拉接口规范-补充.md）：
 *   - HTTP POST，event.body = 原始 JSON 字符串（验签必须用原始字节，禁止 JSON.parse 再 stringify）
 *   - event.headers.authorization = 'LKLAPI-SHA256withRSA timestamp="...",nonce_str="...",signature="..."'
 *   - body 为扁平 JSON：{ pay_order_no, out_order_no, order_status, total_amount, order_trade_info:{...} }
 *
 * 返回：
 *   - null              非 HTTP 入口（走原 callFunction 路径）
 *   - { _lakalaCallbackAcked: true, ackBody: {...} }   退款回调 / 非成功状态，已 ack
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

  const tradeInfo = body.order_trade_info || {}
  const payOrderNo = body.pay_order_no
  const outOrderNo = body.out_order_no
  const orderStatus = body.order_status
  const totalAmountFen = Number(body.total_amount || 0)

  // 退款回调 / 非成功状态：ack 让拉卡拉停重试，退款流程由 admin 退款 cron 推进（Phase 5）
  if (orderStatus === '6' || tradeInfo.trade_type === 'REFUND') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: '退款回调已确认' } }
  }
  if (orderStatus !== '2' && tradeInfo.trade_status !== 'S') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: `非成功状态 ${orderStatus} ack` } }
  }

  // 推断付款方式
  const payMode = String(tradeInfo.pay_mode || '').toUpperCase()
  const paymentMethod = payMode === 'ALIPAY' ? '支付宝' : '微信'

  return {
    orderNo: outOrderNo,
    transactionId: payOrderNo,
    payAmount: Math.round(totalAmountFen) / 100,
    paymentMethod,
    _httpEntry: true,
  }
}

/**
 * 云函数入口
 *
 * 注意：member_level（钻石等级）由 cronTask 每日凌晨3点统一重算，本函数不直接更新。
 */
exports.main = async (event) => {
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
    const { orderNo, transactionId, payAmount: payAmountInput, paymentMethod: paymentMethodInput } = businessEvent
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

    // 幂等检查：订单是否已支付
    // 注：wechat_transaction_id 列已在 migration 0018 DROP，三方流水号下沉到 sale_order_payments.external_txn_id
    const orderResult = await pg.query(
      `SELECT status, payment_method, preferred_employee_id,
              total_amount, payable_amount, client_user_id, store_id, prepaid_card_amount,
              sale_order_type, ref_sale_order_id
       FROM sale_orders WHERE sale_order_id = $1`,
      [orderNo]
    )

    if (orderResult.rows.length === 0) {
      console.error('[payNotify] 订单不存在:', orderNo)
      return { code: 'FAIL', message: '订单不存在' }
    }

    const order = orderResult.rows[0]

    // 回款单已在 2026-04-26 sale-order-domain-refactor 从 sale_order_type 枚举移除（合并到 sale_order_payments.change_type='回款'）。
    // 这里不再判别 isRepaymentCredential，所有支付都按原单推进；回款由 change_type 区分。
    const targetOrderNo = orderNo
    const targetOrder = order
    const isRepaymentCredential = false  // 兼容下方未清理的引用（如有），后续整体重构时移除

    // 幂等：凭证单自身或原单已终态 → 再写一次 payments（ON CONFLICT DO NOTHING）后返回
    if (order.status === '已支付' || order.status === '已完成') {
      console.log('[payNotify] 订单已支付，跳过:', orderNo)
      return { code: 'SUCCESS', message: '已处理' }
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

    // 开启事务：更新订单 + 设置单品到期日 + 自动创建业绩分配
    const client = await pg.connect()
    try {
      await client.query('BEGIN')

      // ========== 核心幂等：INSERT payments 行（ON CONFLICT DO NOTHING） ==========
      //
      // 幂等键：uq_sop_txn (sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL
      //
      // **回款凭证单场景**：payments / 业务动作以 targetOrderNo（=原销售单）为准；
      //   凭证单本身在事务末尾再更新 status='已支付'。
      //
      // 先决定本次金额 payAmount：优先取 event.payAmount，否则按目标订单剩余应付推算
      //   remaining = (total_amount - prepaid_card_amount) - Σ payments.amount (已支付, 首次/回款/退款)
      // 第一次回调时 payments 表为空，remaining = total_amount - prepaid_card_amount（即全单线上应付）
      // 线上应付现金基准 = payable_amount 列（已编码充值折扣），旧单 NULL 用 total - prepaid 兜底。
      // 普通单 payable_amount == total - prepaid（不变）；充值单 payable(实付 980) ≠ total(面额 1000)，
      // 不用 payable 则 980 回调永远判为「部分支付」且储值卡不入账。
      const payableAmount = targetOrder.payable_amount != null
        ? Math.round(Number(targetOrder.payable_amount) * 100) / 100
        : Math.round(
            (Number(targetOrder.total_amount || 0) - Number(targetOrder.prepaid_card_amount || 0)) * 100
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

      // change_type：
      //   - 回款凭证单回调：总是 '回款'（线上通道）
      //   - 普通销售单：判断是否已有 '首次支付' 行
      let changeType
      if (isRepaymentCredential) {
        changeType = '回款'
      } else {
        const firstPayCheck = await client.query(
          `SELECT 1 FROM sale_order_payments
           WHERE sale_order_id = $1 AND change_type = '首次支付' LIMIT 1`,
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
            external_txn_id, status, source_end, operator_employee_id,
            note, created_at, paid_at
          ) VALUES ($1, $2, $3, $4, $5, '已支付', 'notify', NULL, $6, $7, $7)
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

      // 判定目标订单最终状态
      const newPaidSum = Math.round((paidSum + thisPayAmount) * 100) / 100
      const fullyPaid = newPaidSum + 0.001 >= payableAmount
      const newStatus = fullyPaid ? '已支付' : '部分支付'

      // 1. 更新目标订单：received 累加、status 置新值、paid_at（全额时）
      // CAS 守卫（state-machine-cas-guard ticket）：只允许从 待支付/部分支付 翻转
      // 注：wechat_transaction_id 列已 DROP，三方流水号由上面 INSERT sale_order_payments.external_txn_id 承担
      const updResult = await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             received = $2,
             paid_at = CASE WHEN $1::text = '已支付' THEN $3 ELSE paid_at END,
             updated_at = $3
         WHERE sale_order_id = $4
           AND status IN ('待支付', '部分支付')`,
        [newStatus, newPaidSum, now, targetOrderNo]
      )
      if (updResult.rowCount === 0) {
        // 主单已被其他事务先翻至终态（已支付/已关闭等），回滚 payment 插入并幂等 ack 微信
        await client.query('ROLLBACK')
        console.warn('[payNotify] state-transition-blocked:', targetOrderNo, '→', newStatus)
        return { code: 'SUCCESS', message: '订单状态已变更（幂等）' }
      }

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

      // paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
      // 部分支付也需要触发：让顾客刚回款的部分立即可消费
      await recalcPaidSessionsForOrder(client, targetOrderNo)

      // 后续业务动作（单品到期日 / 充值入账 / 消费扣款 / 业绩分配 / 顾客档位重算）
      // 仅当目标订单整单结清（fullyPaid = true）时才触发，避免部分支付中途产生副作用。
      if (!fullyPaid) {
        await client.query('COMMIT')
        console.log('[payNotify] 订单部分支付到账:', orderNo, `paid_sum=${newPaidSum}/${payableAmount}`)
        return { code: 'SUCCESS', message: '部分支付已到账' }
      }

      // 2. 设置单品到期日（paid_at + 1 year）——以原销售单为准
      await client.query(
        `UPDATE sale_items
         SET expire_date = ($1::date + interval '1 year')::date
         WHERE sale_order_id = $2
           AND product_type = '单品'
           AND expire_date IS NULL`,
        [now, targetOrderNo]
      )

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
            const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
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

      // 3b. 消费扣款入账（订单的 prepaid_card_amount > 0 时扣余额）
      // 幂等：card_transactions 用 ref_order_id + type='扣款' 的 NOT EXISTS 守护
      // 余额不足时抛错 → 整个事务回滚 → 订单保持 '待支付'（ticket §4.8 #38）
      if (targetOrder.client_user_id && Number(targetOrder.prepaid_card_amount) > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
          [targetOrderNo]
        )
        if (dupCheck.rows.length === 0) {
          const prepaidAmount = Number(targetOrder.prepaid_card_amount)
          // 二次校验余额（FOR UPDATE 锁，防并发）
          const cardRow = await client.query(
            `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
            [targetOrder.client_user_id]
          )
          if (cardRow.rows.length === 0 || Number(cardRow.rows[0].balance) < prepaidAmount) {
            throw new Error(`INSUFFICIENT_BALANCE: 储值卡余额不足以完成扣款`)
          }
          const cardId = cardRow.rows[0].card_id
          await client.query(
            `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
            [prepaidAmount, cardId]
          )
          await client.query(
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
             VALUES ($1, '扣款', $2, $3, $4, NOW())
             ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
            [cardId, -prepaidAmount, targetOrderNo, `card-deduct-${targetOrderNo}`]
          )
          // 写储值卡抵扣流水（与 confirmOffline/staffApi 一致，amount 为负数）
          await client.query(
            `INSERT INTO sale_order_payments (
              sale_order_id, change_type, amount, payment_method,
              external_txn_id, status, source_end, operator_employee_id,
              note, created_at, paid_at
            ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'notify', NULL,
              $3, NOW(), NOW())`,
            [targetOrderNo, -prepaidAmount, `储值卡抵扣 订单 ${targetOrderNo}`]
          )
          console.log(`[payNotify] 消费扣款: order=${targetOrderNo}, card=${cardId}, amount=${prepaidAmount}`)
        } else {
          console.log(`[payNotify] 消费扣款幂等跳过: order=${targetOrderNo}`)
        }
      }

      // 3. 自动创建业绩分配（如有指定美容师）——以原销售单为准
      if (targetOrder.preferred_employee_id) {
        // 读取员工 skills 推断 role_type（首位技能，缺省回退到 '美容师'）
        const empRow = await client.query(
          'SELECT skills FROM staff_wechat_users WHERE employee_id = $1',
          [targetOrder.preferred_employee_id]
        )
        const skills = Array.isArray(empRow.rows[0]?.skills) ? empRow.rows[0].skills : []
        const roleType = skills[0] || '美容师'

        // 查询该订单的所有明细
        const itemsResult = await client.query(
          'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
          [targetOrderNo]
        )

        // 为每个明细行创建分配记录（100% 给指定美容师）
        for (const item of itemsResult.rows) {
          await client.query(
            `INSERT INTO sale_allocations
               (sale_item_id, employee_id, role_type, allocation_ratio, total_amount,
                is_void, created_at, updated_at)
             VALUES ($1, $2, $3, 1.00, $4, FALSE, $5, $5)
             ON CONFLICT ON CONSTRAINT uq_sale_alloc_item_emp_role DO NOTHING`,
            [item.sale_item_id, targetOrder.preferred_employee_id, roleType, item.received, now]
          )
        }
      }

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
             SELECT COALESCE(SUM(total_amount), 0) AS total
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

          // 三端 SQL 独立副本（admin actions/orders.ts + staffApi routes/order.js + payNotify index.js）
          // 修改时必须同步另外两端；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
          // 守护（会员客分支允许 payNotify 特有的回款单累计差异）。
          const typeResult = await client.query(
            `SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM sale_orders o
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND (
                     o.total_amount >= $2
                     OR (o.total_amount + COALESCE((
                       SELECT SUM(r.total_amount)
                       FROM sale_orders r
                       WHERE r.ref_sale_order_id = o.sale_order_id
                         AND r.sale_order_type = '回款单'
                         AND r.status IN ('已支付', '已完成')
                     ), 0)) >= $2
                   )
               ) THEN '会员客'
               WHEN EXISTS (
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND si.is_experience = false
               ) THEN '小美客'
               WHEN EXISTS (
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND si.is_experience = true
               ) THEN '体验客'
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
            await client.query(
              `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
              [targetOrder.client_user_id]
            )
          }
        }
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
