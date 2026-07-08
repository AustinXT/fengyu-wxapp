



process.env.TZ = 'Asia/Shanghai'

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')
const { settlePointsSafe } = require('./points')
const { recalcMemberLevel } = require('./member-level')
const { parseErrorPrefix } = require('./error-codes')
const { recalcPaidSessionsForOrder } = require('./paid-sessions')
const { capturePaymentAllocatables, refreshOrderAllocationRollup } = require('./payment-allocatable')


async function autoAllocateOnlinePayment(
  client,
  { salePaymentId, saleOrderId, perItem, eventAmount, preferredEmployeeId, marketName, now },
) {
  if (!preferredEmployeeId || !Array.isArray(perItem) || perItem.length === 0) return

  
  const empRow = await client.query(
    'SELECT skills FROM staff_wechat_users WHERE employee_id = $1',
    [preferredEmployeeId],
  )
  const skills = Array.isArray(empRow.rows[0]?.skills) ? empRow.rows[0].skills : []
  const roleType = skills[0] || '美容师'

  
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

  
  for (const it of perItem) {
    const salesCategory = it.salesCategory || '自销自耗'
    const commissionRate = lookupSalesRate(roleType, salesCategory, eventAmount)
    const commissionAmount = Math.round(Number(it.amount) * commissionRate * 100) / 100
    await client.query(
      `INSERT INTO sale_allocations
         (sale_item_id, employee_id, role_type, allocation_ratio, total_amount,
          commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
       VALUES ($1, $2, $3, 1.00, $4, $5, $6, $7, FALSE, $8, $8)
       ON CONFLICT ON CONSTRAINT uq_sale_alloc_item_emp_role_payment DO NOTHING`,
      [it.saleItemId, preferredEmployeeId, roleType, Number(it.amount).toFixed(2),
       commissionRate, commissionAmount, salePaymentId, now],
    )
  }
  
  
  
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

const lakalaClient = require('./utils/lakala-client')





let pgPool = null
function getPg() {
  if (!pgPool) {
    const pg = require('pg')
    
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


function isPayNotifyEnabled() {
  if (process.env.PAYNOTIFY_ENABLED !== 'true') return false
  if (!lakalaConfig.isReady()) return false
  return true
}


function parseHttpTriggerEvent(event) {
  if (!event || typeof event !== 'object') return null
  if (event.httpMethod !== 'POST') return null

  const cfg = lakalaConfig.readConfig()
  const rawHeaders = event.headers || {}
  const headers = {}
  for (const k of Object.keys(rawHeaders)) headers[k.toLowerCase()] = rawHeaders[k]

  
  if (!cfg.ipWhitelistOpen) {
    const xff = headers['x-forwarded-for'] || headers['x-real-ip'] || event.sourceIp || ''
    const clientIp = String(xff).split(',')[0].trim()
    if (!clientIp || !cfg.ipWhitelist.includes(clientIp)) {
      const err = new Error('PERMISSION_DENIED: LAKALA_CALLBACK_IP_NOT_ALLOWED')
      err._statusCode = 403
      throw err
    }
  }

  
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

  
  const outTradeNo = body.out_trade_no
  const tradeNo = body.trade_no
  const tradeState = String(body.trade_state || '').toUpperCase()
  const accountType = String(body.account_type || '').toUpperCase()
  const totalAmountFen = Number(body.total_amount || 0)
  const payerAmountFen = Number(body.payer_amount || 0)

  
  if (tradeState === 'REFUND' || tradeState === 'PART_REFUND') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: '退款回调已确认' } }
  }
  
  if (tradeState !== 'SUCCESS') {
    return { _lakalaCallbackAcked: true, ackBody: { code: 'SUCCESS', message: `非成功状态 ${tradeState} ack` } }
  }

  
  
  
  
  
  let effectiveFen = totalAmountFen
  if (!effectiveFen || effectiveFen <= 0) {
    if (payerAmountFen > 0) {
      console.warn('[payNotify] total_amount 缺失，兜底 payer_amount=', payerAmountFen, 'outTradeNo=', outTradeNo)
      effectiveFen = payerAmountFen
    }
  }

  
  const paymentMethod = accountType === 'ALIPAY' ? '支付宝' : '微信'

  return {
    orderNo: outTradeNo,           
    transactionId: tradeNo,        
    payAmount: Math.round(effectiveFen) / 100,
    paymentMethod,
    
    
    tradeInfo: body,
    _httpEntry: true,
  }
}


exports.parseHttpTriggerEvent = parseHttpTriggerEvent


async function reportShippingForOrder(pg, saleOrderId, wxTxnId) {
  if (!wxTxnId) {
    console.warn('[payNotify/wx-shipping] 缺微信交易单号(acc_trade_no)，跳过上报:', saleOrderId)
    return { status: 'skip' }
  }
  
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
    
    console.log('[payNotify/wx-shipping] 支付单未同步，待定时补偿重试:', saleOrderId)
    return { status: 'pending', errcode }
  }
  console.error('[payNotify/wx-shipping] 上报失败:', saleOrderId, errcode, res && res.errmsg)
  return { status: 'fail', errcode }
}


async function reportWxShippingSafe(pg, { saleOrderId, paymentMethod, tradeInfo }) {
  try {
    if (!wxShipping.isEnabled()) return
    if (paymentMethod !== '微信') return
    if (!tradeInfo) return  
    await reportShippingForOrder(pg, saleOrderId, tradeInfo.acc_trade_no)
  } catch (e) {
    console.error('[payNotify/wx-shipping] 上报异常(非致命):', saleOrderId, e && e.message)
  }
}


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


async function runPaymentReconcile() {
  if (!isPayNotifyEnabled()) {
    console.log('[payNotify/reconcile] skip: 未启用')
    return { code: 'SUCCESS', message: 'reconcile disabled' }
  }
  const pg = getPg()
  
  
  
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
      if (!resp || resp.tradeState !== 'SUCCESS') { skip++; continue }
      
      const paid = await pg.query(
        'SELECT 1 FROM sale_order_payments WHERE external_txn_id = $1 LIMIT 1',
        [resp.tradeNo]
      )
      if (paid.rows.length > 0) { skip++; continue }
      const payAmount = Math.round(Number(resp.totalAmountFen || 0)) / 100
      if (!(payAmount > 0)) { skip++; continue }
      const paymentMethod = o.payment_method === '支付宝' ? '支付宝' : '微信'
      
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


exports.reportWxShippingSafe = reportWxShippingSafe
exports.reportShippingForOrder = reportShippingForOrder
exports.runShippingBackfill = runShippingBackfill
exports.runPaymentReconcile = runPaymentReconcile


exports.main = async (event) => {
  
  
  
  if (event && event.Type === 'Timer') {
    
    
    try { await runShippingBackfill() } catch (e) { console.error('[payNotify/wx-shipping] backfill 异常(非致命):', e && e.message) }
    return await runPaymentReconcile()
  }

  
  if (!isPayNotifyEnabled()) {
    const safeEvent = event && typeof event === 'object' ? event : {}
    console.warn('[payNotify] disabled invocation rejected',
      JSON.stringify({ reason: 'NOT_ENABLED_OR_NOT_READY', httpMethod: safeEvent.httpMethod || null }))
    if (safeEvent.httpMethod === 'POST') {
      return { statusCode: 503, body: JSON.stringify({ code: 'FAIL', message: 'NOT_READY' }) }
    }
    return { code: -403, message: 'PERMISSION_DENIED: PAYNOTIFY_DISABLED', data: null }
  }

  
  let httpEntryResult = null
  try {
    httpEntryResult = parseHttpTriggerEvent(event)
  } catch (httpErr) {
    const statusCode = httpErr._statusCode || 400
    console.warn('[payNotify] HTTP entry rejected:', httpErr.message)
    return { statusCode, body: JSON.stringify({ code: 'FAIL', message: httpErr.message }) }
  }
  
  if (httpEntryResult && httpEntryResult._lakalaCallbackAcked) {
    return { statusCode: 200, body: JSON.stringify(httpEntryResult.ackBody) }
  }

  
  const businessEvent = httpEntryResult || event
  const isHttpEntry = !!httpEntryResult

  try {
    const { orderNo, transactionId, payAmount: payAmountInput, paymentMethod: paymentMethodInput, tradeInfo } = businessEvent
    
    const txnSummary = transactionId ? String(transactionId).slice(0, 8) : 'null'
    console.log('[payNotify] received', JSON.stringify({ orderNo, txn: txnSummary, isHttpEntry }))

    if (!orderNo) {
      return isHttpEntry
        ? { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: '缺少 orderNo' }) }
        : { code: 'FAIL', message: '缺少 orderNo' }
    }
    
    if (!transactionId) {
      return isHttpEntry
        ? { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: '缺少 transactionId' }) }
        : { code: 'FAIL', message: '缺少 transactionId' }
    }

    const pg = getPg()

    
    
    
    
    const saleOrderId = String(orderNo).replace(/_\d+$/, '')

    
    
    const orderResult = await pg.query(
      `SELECT status, payment_method, preferred_employee_id,
              total_amount, payable_amount, client_user_id, store_id, prepaid_card_amount,
              sale_order_type, ref_sale_order_id, market_name
       FROM sale_orders WHERE sale_order_id = $1`,
      [saleOrderId]
    )

    if (orderResult.rows.length === 0) {
      console.error('[payNotify] 订单不存在:', orderNo)
      return { code: 'FAIL', message: '订单不存在' }
    }

    const order = orderResult.rows[0]

    
    
    const targetOrderNo = saleOrderId
    const targetOrder = order
    const isRepaymentCredential = false  

    
    if (order.status === '已支付' || order.status === '已完成') {
      console.log('[payNotify] 订单已支付，跳过:', orderNo)
      return { code: 'SUCCESS', message: '已处理' }
    }

    
    if (order.status !== '待支付' && order.status !== '部分支付') {
      console.warn('[payNotify] 订单状态异常:', orderNo, order.status)
      return { code: 'FAIL', message: `订单状态异常: ${order.status}` }
    }

    const now = new Date()
    
    const txnId = transactionId
    
    
    const paymentMethod = paymentMethodInput
      || (order.payment_method === '支付宝' ? '支付宝' : '微信')

    
    const client = await pg.connect()
    try {
      await client.query('BEGIN')

      
      
      
      
      
      
      
      
      
      
      
      
      
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
      
      if (thisPayAmount > remaining + 0.001) {
        throw new Error(`INVALID_PARAMS: 本次支付金额超过订单剩余应付 (${thisPayAmount} > ${remaining})`)
      }

      
      
      
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
            
            tradeInfo ? JSON.stringify(tradeInfo) : null,
          ]
        )
      } catch (err) {
        if (err && err.code === '23505' && err.constraint === 'uq_sop_first_payment') {
          
          await client.query('ROLLBACK')
          console.log('[payNotify] 并发首次支付（uq_sop_first_payment 命中），跳过:', orderNo, txnId)
          return { code: 'SUCCESS', message: '已处理（幂等）' }
        }
        throw err
      }

      if (insertRes.rows.length === 0) {
        
        await client.query('ROLLBACK')
        console.log('[payNotify] 重复回调（uq_sop_txn 命中），跳过:', orderNo, txnId)
        return { code: 'SUCCESS', message: '已处理（幂等）' }
      }

      
      
      
      const pendingCardRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS pending_card
         FROM sale_order_payments
         WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'`,
        [targetOrderNo]
      )
      const pendingCardAmount = Math.round(Number(pendingCardRes.rows[0]?.pending_card || 0) * 100) / 100

      
      const newPaidSum = Math.round((paidSum + thisPayAmount) * 100) / 100
      const fullyPaid = (newPaidSum + pendingCardAmount) + 0.001 >= payableAmount
      const newStatus = fullyPaid ? '已支付' : '部分支付'

      
      
      
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
        
        await client.query('ROLLBACK')
        console.warn('[payNotify] state-transition-blocked:', targetOrderNo, '→', newStatus)
        return { code: 'SUCCESS', message: '订单状态已变更（幂等）' }
      }

      
      const onlinePaymentId = insertRes.rows[0].id

      
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
          
          console.warn('[payNotify] credential state-transition-blocked:', orderNo)
        }
      }

      
      
      if (!fullyPaid) {
        const perItemPartial = await capturePaymentAllocatables(client, {
          salePaymentId: onlinePaymentId,
          saleOrderId: targetOrderNo,
          eventAmount: thisPayAmount,
          directedItems: null,
        })
        await autoAllocateOnlinePayment(client, {
          salePaymentId: onlinePaymentId,
          saleOrderId: targetOrderNo,
          perItem: perItemPartial,
          eventAmount: thisPayAmount,
          preferredEmployeeId: targetOrder.preferred_employee_id,
          marketName: targetOrder.market_name,
          now,
        })
        await refreshOrderAllocationRollup(client, targetOrderNo)

        
        
        await recalcPaidSessionsForOrder(client, targetOrderNo)

        await client.query('COMMIT')
        console.log('[payNotify] 订单部分支付到账:', orderNo, `paid_sum=${newPaidSum}/${payableAmount}`)
        
        await reportWxShippingSafe(pg, { saleOrderId: targetOrderNo, paymentMethod, tradeInfo })
        return { code: 'SUCCESS', message: '部分支付已到账' }
      }

      

      
      
      
      
      
      if (targetOrder.client_user_id && targetOrder.sale_order_type === '充值单') {
        const faceValue = Number(targetOrder.total_amount)
        if (faceValue > 0) {
          const dupCheck = await client.query(
            `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
            [targetOrderNo]
          )
          if (dupCheck.rows.length === 0) {
            
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

      
      
      
      
      let prepaidConsumedThisCallback = 0
      if (targetOrder.client_user_id && Number(targetOrder.prepaid_card_amount) > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
          [targetOrderNo]
        )
        if (dupCheck.rows.length === 0) {
          const prepaidAmount = Number(targetOrder.prepaid_card_amount)
          
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
          
          
          
          await client.query(
            `INSERT INTO sale_order_payments (
              sale_order_id, change_type, amount, payment_method,
              external_txn_id, status, source_end, operator_employee_id,
              note, created_at, paid_at
            ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'notify', NULL,
              $3, NOW(), NOW())`,
            [targetOrderNo, prepaidAmount, `储值卡抵扣 订单 ${targetOrderNo}`]
          )
          
          
          await client.query(
            `UPDATE sale_orders SET received = received + $1, updated_at = NOW() WHERE sale_order_id = $2`,
            [prepaidAmount, targetOrderNo]
          )
          prepaidConsumedThisCallback = prepaidAmount
          console.log(`[payNotify] 消费扣款: order=${targetOrderNo}, card=${cardId}, amount=${prepaidAmount}`)
        } else {
          console.log(`[payNotify] 消费扣款幂等跳过: order=${targetOrderNo}`)
        }
      }

      
      
      
      
      
      if (targetOrder.client_user_id && pendingCardAmount > 0) {
        const pendingRows = await client.query(
          `SELECT id, amount FROM sale_order_payments
           WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'
           ORDER BY id
           FOR UPDATE`,
          [targetOrderNo]
        )
        if (pendingRows.rows.length > 0) {
          const cardRow = await client.query(
            `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
            [targetOrder.client_user_id]
          )
          if (cardRow.rows.length === 0 || Number(cardRow.rows[0].balance) + 0.001 < pendingCardAmount) {
            throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足以完成混合回款抵扣')
          }
          const cardId = cardRow.rows[0].card_id
          await client.query(
            `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
            [pendingCardAmount, cardId]
          )
          for (const pr of pendingRows.rows) {
            const amt = Math.round(Number(pr.amount) * 100) / 100
            await client.query(
              `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
               VALUES ($1, '扣款', $2, $3, $4, NOW())
               ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
              [cardId, -amt, targetOrderNo, `card-repay-intent-${pr.id}`]
            )
            await client.query(
              `UPDATE sale_order_payments SET status = '已支付', paid_at = $1 WHERE id = $2 AND status = '待支付'`,
              [now, pr.id]
            )
          }
          
          await client.query(
            `UPDATE sale_orders
             SET received = received + $1,
                 prepaid_card_amount = COALESCE(prepaid_card_amount, 0) + $1,
                 payable_amount = COALESCE(payable_amount, total_amount) - $1,
                 updated_at = $2
             WHERE sale_order_id = $3`,
            [pendingCardAmount, now, targetOrderNo]
          )
          prepaidConsumedThisCallback = Math.round((prepaidConsumedThisCallback + pendingCardAmount) * 100) / 100
          console.log(`[payNotify] 混合回款储值卡抵扣消费: order=${targetOrderNo}, card=${cardId}, amount=${pendingCardAmount}`)
        }
      }

      
      
      const fullEventAmount = Math.round((thisPayAmount + prepaidConsumedThisCallback) * 100) / 100
      const perItemFull = await capturePaymentAllocatables(client, {
        salePaymentId: onlinePaymentId,
        saleOrderId: targetOrderNo,
        eventAmount: fullEventAmount,
        directedItems: null,
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

      
      
      await recalcPaidSessionsForOrder(client, targetOrderNo)

      
      
      
      
      
      
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

        
        const curType = await client.query(
          'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
          [targetOrder.client_user_id]
        )
        if (curType.rows[0]?.customer_type !== '会员客') {
          const threshold = await getMemberThreshold()

          
          
          
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

        
        await recalcMemberLevel(client, targetOrder.client_user_id, await getMemberThreshold(), 'payNotify')
      }

      
      
      const pointsResult = await settlePointsSafe(client, targetOrderNo, 'payNotify')
      if (pointsResult.delta) {
        console.log(`[payNotify] 积分结算: order=${targetOrderNo}, delta=${pointsResult.delta}, expected=${pointsResult.expected}`)
      }

      
      
      
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

    
    
    await reportWxShippingSafe(pg, { saleOrderId: targetOrderNo, paymentMethod, tradeInfo })

    
    if (isHttpEntry) {
      return { statusCode: 200, body: JSON.stringify({ code: 'SUCCESS', message: '执行成功' }) }
    }
    return { code: 'SUCCESS', message: '成功' }
  } catch (err) {
    
    
    
    const parsed = parseErrorPrefix(err && err.message)
    console.error('[payNotify] Error:', err, parsed ? { errorType: parsed.prefix } : { errorType: null })
    const safeMessage = parsed ? parsed.displayMessage : '内部错误'
    if (isHttpEntry) {
      return { statusCode: 500, body: JSON.stringify({ code: 'FAIL', message: safeMessage }) }
    }
    return { code: 'FAIL', message: safeMessage }
  }
}
