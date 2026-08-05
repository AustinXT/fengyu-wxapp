/**
 * 充值卡模块路由（员工端）
 *
 * 2026-05-20 充值卡剥离 SKU 化：
 *   - 充值订单不再依赖 product_skus / sale_items；改用 sale_order_type='充值单' 标识
 *   - 档位配置从 product_skus.is_recharge_card=true 行迁到 system_configs（recharge.tiers）
 *   - total_amount=面值，payable_amount=实付，sale_items 0 行
 *
 * 入账：线下走 order.confirmOffline 识别 sale_order_type='充值单'；微信走 payNotify 同识别。
 *
 * 退款（仅退剩余余额，整笔退、不可拆、只能退 1 次）：
 *   1. card.createRefund — admin/staff 发起，写 sale_order_payments(change_type='退款', status='待审批')
 *   2. card.approveRefund — manager 审批通过：扣 balance + card_transactions(-faceVal) + status='已支付'；退款金额统一线下处理
 *   3. card.rejectRefund — manager 拒绝：status='已作废'
 */

const pg = require('../db/pg')
const { requireManager, requireStaffBound } = require('../middleware/auth')
const { isStoreInScope } = require('../utils/scope')
const { loadRechargeConfig, matchTier } = require('../utils/recharge')
const { notifyRefundCreated, notifyRefundResult } = require('../utils/refund')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiYYMMDD } = require('../utils/datetime')

// 旧系统(WorkFine)充值金转入专用备注标记（与 admin orders.ts LEGACY_INFLOW_NOTE 字面一致）
const LEGACY_INFLOW_NOTE = '旧系统充值金转入'

// ================= 路由 =================

/**
 * 返回充值卡档位 + 自定义金额边界（与 clientApi.card.rechargeConfig 字节同义）
 *
 * 数据来源：system_configs（admin 后台 system-configs 编辑入口维护）
 *
 * 权限：登录态可读（非店长也可浏览面值/折扣表）；真正下单走 card.recharge 仍 manager-only。
 */
async function rechargeConfig(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const cfg = await loadRechargeConfig(pg)
  ctx.result = {
    tiers: cfg.tiers.map(t => ({
      faceValue: t.faceValue,
      payAmount: t.payAmount,
      discount: t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1,
    })),
    minAmount: cfg.minAmount,
    maxAmount: cfg.maxAmount,
  }
}

/**
 * 店长替顾客开充值卡订单
 *
 * payload: {
 *   clientUserId: string,              // 必填，已注册顾客 user_id
 *   faceValue: number,                 // 充值面值；payAmount 由后端按 system_configs 推导
 *   paymentMethod: '线下'|'微信',
 *   remark?: string
 * }
 *
 * 返回: { saleOrderId, faceValue, payAmount, paymentMethod, status }
 */
async function recharge(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientUserId, faceValue, paymentMethod, remark } = payload

  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  if (!['线下', '微信'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }

  const cfg = await loadRechargeConfig(pg)
  const { payAmount } = matchTier(Number(faceValue), cfg)
  const faceVal = Number(faceValue)

  const storeId = ctx.auth.effectiveStoreId
  // market_name 在 INSERT 时以门店反查 org 树市场名为权威（子查询），此处仅备开单人快照作 COALESCE 兜底。
  const marketName = ctx.auth.marketName || ''
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  // 查顾客 + document_type
  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, bound_store_id FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  // 非本店顾客禁止充值（同 order.create 口径：账户余额可跨店查看，但充值按门店结算）
  if (!isStoreInScope(ctx.auth, user.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法充值')
  }
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'

  // 事务内：advisory lock + 生成订单号 + INSERT sale_orders（不写 sale_items）
  let saleOrderId
  await pg.transaction(async (client) => {
    // 按顾客串行化开单（advisory lock 持有到 COMMIT）：uq 拆除员工单 DB 兜底后，业务守卫
    // SELECT-then-INSERT 非原子，并发开单可产生重复员工单。pg_advisory_xact_lock(hashtext($1))
    // 让同顾客开单串行，existing 守卫在此锁下原子生效。业务守卫查顾客维度全量待支付单（含自助单），
    // advisory lock 串行化并发；DB uq 仅兜底 opened_by IS NULL 自助单。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientUserId])
    const pendingRows = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE client_user_id = $1 AND status = '待支付' LIMIT 1`,
      [clientUserId]
    )
    if (pendingRows.rows.length > 0) {
      const err = new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
      err.data = { pendingOrderNo: pendingRows.rows[0].sale_order_id }
      throw err
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
    const dateStrOrder = shanghaiYYMMDD(now)
    const orderSeqResult = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE sale_order_id LIKE $1
       ORDER BY sale_order_id DESC LIMIT 1`,
      [`FY-XSD-WX-${dateStrOrder}%`]
    )
    let orderSeq = 1
    if (orderSeqResult.rows.length > 0) {
      orderSeq = parseInt(orderSeqResult.rows[0].sale_order_id.slice(-4)) + 1
    }
    saleOrderId = `FY-XSD-WX-${dateStrOrder}${String(orderSeq).padStart(4, '0')}`

    // 线下/微信 → 统一 '待支付'；线下走 confirmOffline 入账，微信走 payNotify 回调入账
    const initialStatus = '待支付'

    // 充值单：total_amount=面值，payable_amount=实付，prepaid_card_amount=0（充值单本身不允许储值卡支付）
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, payable_amount, prepaid_card_amount,
        client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark,
        created_at, updated_at
      ) VALUES ($1, $2, '充值单', $3, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $5), $4), $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, 0,
                $9, $10, $11, $12, $13, $14, $6, $6)`,
      [
        saleOrderId, initialStatus, documentType, marketName, storeId, now,
        faceVal, payAmount,
        clientUserId, clientPhone, customerName,
        paymentMethod, ctx.auth.staffWfId, remark || null,
      ]
    )
    // 审计日志
    await logOperation(client, ctx, 'card.recharge', 'sale_order', saleOrderId, {
      _v: 3,
      clientUserId,
      faceValue: faceVal,
      payAmount,
      paymentMethod,
      storeId,
    })
  })

  ctx.result = {
    saleOrderId,
    faceValue: faceVal,
    payAmount,
    paymentMethod,
    status: '待支付',
    message: '开单成功',
  }
}

/**
 * 旧系统(WorkFine)充值金转入：把顾客在旧系统的充值金余额等额导入新系统储值卡
 *
 * 与 card.recharge 的区别：
 *   - 旧系统已收过钱 → 1:1 等额、不打折、不限额、不走 matchTier 档位；
 *   - 直接建 status='已支付' 的充值单（不经待支付 → confirmOffline），即时入账 balance += amount；
 *   - remark / 流水 note 打专用标记「旧系统充值金转入」，便于查账识别（充值单本就不计营收）。
 *
 * 转入单本质是普通充值单：将来退款天然走 card.createRefund/approveRefund（与任何充值单一致）。
 * received=amount（非 0）+ 配一条「首次支付」流水，维护资金不变量 received=Σ流水，
 * 保证将来退款 refunded_amount ≤ received，不触发 cron 资金巡检告警。
 *
 * payload: { clientUserId, amount, remark? }
 * 返回: { saleOrderId, amount, status }
 */
async function inflow(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientUserId, amount, remark } = payload

  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('INVALID_PARAMS: 转入金额必须为正数')
  // 浮点容差：与 matchTier 同口径，最多保留 2 位小数
  if (Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 转入金额最多保留 2 位小数')
  }
  if (amt > 99999999.99) throw new Error('INVALID_PARAMS: 转入金额超出上限') // NUMERIC(10,2) 上界保护，非业务限额

  const storeId = ctx.auth.effectiveStoreId
  // market_name 以门店反查 org 树市场名为权威（INSERT 子查询），此处仅备 COALESCE 兜底
  const marketName = ctx.auth.marketName || ''
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, bound_store_id FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  // 非本店顾客禁止转入（同 card.recharge 口径：账户余额跨店可见，但转入按门店结算）
  if (!isStoreInScope(ctx.auth, user.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法转入')
  }
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'
  const note = remark ? `${LEGACY_INFLOW_NOTE}｜${remark}` : LEGACY_INFLOW_NOTE

  // 幂等 token：前端每次提交生成、CloudBase SDK 自动重试携带同一值，后端据此去重，杜绝网络重试重复入账
  const requestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : null

  let saleOrderId
  let idempotentHit = false
  await pg.transaction(async (client) => {
    // 顾客级 advisory lock：串行化同顾客的并发转入（双击 / SDK 重试）。键与 'sale_order_id_gen' 互异、
    // 且本路径恒「先顾客锁后订单号锁」，其它路径不持顾客锁，不构成跨锁死锁。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card_inflow:${clientUserId}`])

    // 幂等短路：同一 requestId 已成功转入则复用既有订单，不重复建单 / 不重复 += balance（防重复入账核心）
    // 注：事务内 client.query() 返回原生 node-pg Result（取 .rows），与模块级 pg.query（已解包成数组）不同
    if (requestId) {
      const dup = await client.query(
        `SELECT ref_order_id FROM card_transactions WHERE external_ref = $1 LIMIT 1`,
        [`card-inflow-${requestId}`]
      )
      if (dup.rows.length > 0) {
        saleOrderId = dup.rows[0].ref_order_id
        idempotentHit = true
        return
      }
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
    const dateStrOrder = shanghaiYYMMDD(now)
    const orderSeqResult = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE sale_order_id LIKE $1
       ORDER BY sale_order_id DESC LIMIT 1`,
      [`FY-XSD-WX-${dateStrOrder}%`]
    )
    let orderSeq = 1
    if (orderSeqResult.rows.length > 0) {
      orderSeq = parseInt(orderSeqResult.rows[0].sale_order_id.slice(-4)) + 1
    }
    saleOrderId = `FY-XSD-WX-${dateStrOrder}${String(orderSeq).padStart(4, '0')}`

    // 转入单：直接 '已支付'，total=payable=received=amt（1:1），prepaid_card_amount=0，线下，paid_at=now
    // 不加待支付并发守卫（uq_sale_orders_client_pending 仅约束 '待支付'，迁移不应被无关待支付单卡住）
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, payable_amount, prepaid_card_amount, received,
        client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark, paid_at, allocation_status,
        created_at, updated_at
      ) VALUES ($1, '已支付', '充值单', $2, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $4), $3), $4, (SELECT store_name FROM stores WHERE store_id = $4), $5, $6, $6, 0, $6,
                $7, $8, $9, '线下', $10, $11, $5, '待分配', $5, $5)`,
      [
        saleOrderId, documentType, marketName, storeId, now,
        amt,
        clientUserId, clientPhone, customerName,
        ctx.auth.staffWfId, note,
      ]
    )

    // 首次支付流水（线下 / external_txn_id=NULL / 已支付）：维护 received=Σ流水（资金不变量 I1）
    await client.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, amount, payment_method, external_txn_id,
         status, source_end, operator_employee_id, note, created_at, paid_at
       ) VALUES ($1, '首次支付', $2, '线下', NULL, '已支付', 'staff', $3, $4, $5, $5)`,
      [saleOrderId, amt, ctx.auth.staffWfId || null, note, now]
    )

    // 充值入账（字面镜像 order.confirmOffline 充值单入账块；幂等键 card-topup-{saleOrderId} 三端统一）
    // card_id 必须取 UPSERT 的 RETURNING 值：一户一卡，已有卡时 ON CONFLICT(user_id) 命中旧行，
    // 其 card_id 可能是历史异格式（FY-CARD-{时间戳} / UUID / 手工值），≠ FY-CARD-{clientUserId}；
    // card_transactions.card_id 外键指向 prepaid_cards.card_id，必须引用真实卡号否则违反外键（23503）。
    const newCardId = `FY-CARD-${clientUserId}`
    const upsertRes = await client.query(
      `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
       RETURNING card_id`,
      [newCardId, clientUserId, amt]
    )
    const cardId = upsertRes.rows[0].card_id
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '充值', $2, $3, $4, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
      // 优先用 requestId 幂等键（防重复入账）；无 token 时回退订单号键（与 confirmOffline 一致）
      [cardId, amt, saleOrderId, requestId ? `card-inflow-${requestId}` : `card-topup-${saleOrderId}`]
    )

    // 审计日志
    await logOperation(client, ctx, 'card.inflow', 'sale_order', saleOrderId, {
      _v: 1,
      clientUserId,
      amount: amt,
      storeId,
      legacy: true,
    })
  })

  ctx.result = {
    saleOrderId,
    amount: amt,
    status: '已支付',
    message: idempotentHit ? '转入已完成（请勿重复提交）' : '转入成功',
  }
}

/**
 * 发起充值卡退款（admin 或 staff 调用）
 *
 * 仅支持"退剩余余额"语义：refundFace = balance_now，整笔退，不可拆。
 * 实际线下退款金额 = round(refundFace * payable_amount / total_amount, 2)。
 *
 * payload: { saleOrderId: string, reason?: string }
 * 返回: { paymentId, refundFace, refundPay }
 */
async function createRefund(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleOrderId, reason } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  // 校验订单存在 + 为充值单 + 已支付
  const orderRows = await pg.query(
    `SELECT sale_order_id, sale_order_type, status, total_amount, payable_amount,
            client_user_id, store_id, customer_name
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orderRows.length === 0) throw new Error('NOT_FOUND: 订单不存在')
  const order = orderRows[0]
  if (!isStoreInScope(ctx.auth, order.store_id)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  if (order.sale_order_type !== '充值单') {
    throw new Error('INVALID_STATE: 非充值单不可走充值卡退款流程')
  }
  if (order.status !== '已支付') {
    throw new Error(`INVALID_STATE: 订单状态 ${order.status} 不可退款`)
  }

  // 校验无在途退款（uq_sop_status_audit 会兜底）
  const existing = await pg.query(
    `SELECT id FROM sale_order_payments
     WHERE sale_order_id = $1 AND change_type = '退款' AND status IN ('待审批', '已支付')`,
    [saleOrderId]
  )
  if (existing.length > 0) {
    throw new Error('CONFLICT: 该订单已有在途/已完成的退款，不可重复发起')
  }

  // 取顾客当前余额（按面值口径），refundFace = balance_now
  const cardRows = await pg.query(
    `SELECT pc.card_id, pc.balance FROM prepaid_cards pc WHERE pc.user_id = $1`,
    [order.client_user_id]
  )
  if (cardRows.length === 0) {
    throw new Error('NOT_FOUND: 顾客无充值卡账户，无可退余额')
  }
  const balanceNow = Number(cardRows[0].balance)
  if (!(balanceNow > 0)) {
    throw new Error('INSUFFICIENT_BALANCE: 当前余额为 0，无可退金额')
  }

  const totalAmount = Number(order.total_amount)
  const payableAmount = Number(order.payable_amount)
  if (!(totalAmount > 0)) throw new Error('INVALID_STATE: 订单总额异常，无法计算退款金额')
  // 修复（Bug K）：prepaid_cards 是一户一钱包（聚合所有充值/转换/回冲），不能退整个 balance。
  // 退款面值上限 = 该充值单自身面值；取 min(该单面值, 当前余额) → 退款现金 ≤ 该单实付，不超退、不殃及其它充值单的钱。
  const refundFace = Math.min(totalAmount, balanceNow)
  const refundPay = Math.round((refundFace * payableAmount / totalAmount) * 100) / 100

  // 写 sale_order_payments：change_type='退款' status='待审批' amount=负。
  // 退款金额统一线下处理，payment_method 固定为 '线下'，external_txn_id 保持 NULL。
  const sourceEnd = ctx.event.payload?._sourceEnd === 'admin' ? 'admin' : 'staff'
  let paymentId
  await pg.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, amount, payment_method, status, source_end,
         operator_employee_id, refund_reason, note
       ) VALUES ($1, '退款', $2, '线下', '待审批', $3, $4, $5, $6)
       RETURNING id`,
      [
        saleOrderId,
        -refundPay,
        sourceEnd,
        ctx.auth.staffWfId || null,
        reason || null,
        JSON.stringify({ refundFace, balanceAtRequest: balanceNow }),
      ]
    )
    paymentId = inserted.rows[0].id
    // 审计日志
    await logOperation(client, ctx, 'card.createRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId,
      refundFace,
      refundPay,
      reason: reason || null,
    })

    await notifyRefundCreated(client, {
      paymentId,
      saleOrderId,
      storeId: order.store_id,
      operatorId: ctx.auth.staffWfId,
      amount: refundPay,
      customerName: order.customer_name,
    })
  })

  ctx.result = {
    paymentId,
    refundFace,
    refundPay,
    status: '待审批',
  }
}

/**
 * 店长审批通过充值卡退款
 *
 * payload: { paymentId: number }
 */
async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  await pg.transaction(async (client) => {
    // 锁定 sale_order_payments 行
    const payRows = await client.query(
      `SELECT sop.id, sop.sale_order_id, sop.change_type, sop.amount, sop.status, sop.note,
              sop.operator_employee_id,
              so.client_user_id, so.total_amount, so.payable_amount, so.store_id, so.sale_order_type
       FROM sale_order_payments sop
       JOIN sale_orders so ON sop.sale_order_id = so.sale_order_id
       WHERE sop.id = $1 FOR UPDATE OF sop`,
      [paymentId]
    )
    if (payRows.rows.length === 0) throw new Error('NOT_FOUND: 退款单不存在')
    const pay = payRows.rows[0]
    if (pay.change_type !== '退款') {
      throw new Error('INVALID_STATE: 该流水非退款类型')
    }
    if (pay.sale_order_type !== '充值单') {
      throw new Error('INVALID_STATE: 非充值单不可走充值卡退款审批')
    }
    if (pay.status !== '待审批') {
      throw new Error(`INVALID_STATE: 退款单当前状态 ${pay.status} 不可审批`)
    }

    // 权限：manager 必须覆盖订单门店
    const scopeStoreIds = ctx.auth.scopeStoreIds || []
    if (!scopeStoreIds.includes(pay.store_id)) {
      throw new Error('PERMISSION_DENIED: 当前店长无权审批该门店的退款')
    }

    // 读 note 拿 refundFace
    let meta
    try {
      meta = JSON.parse(pay.note || '{}')
    } catch (e) {
      throw new Error('INVALID_STATE: 退款单元数据格式异常（note 非合法 JSON）')
    }
    const refundFace = Number(meta.refundFace)
    if (!(refundFace > 0)) throw new Error('INVALID_STATE: 退款单缺少 refundFace 元数据')

    // advisory lock + 校验余额
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`card-balance-${pay.client_user_id}`])
    const balRows = await client.query(
      `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
      [pay.client_user_id]
    )
    if (balRows.rows.length === 0) throw new Error('NOT_FOUND: 顾客充值卡账户已不存在')
    const card = balRows.rows[0]
    const balance = Number(card.balance)
    if (balance < refundFace) {
      throw new Error(`INSUFFICIENT_BALANCE: 当前余额 ${balance} < 退款面值 ${refundFace}（审批期间已被消费）`)
    }

    // 扣 balance + 写 card_transactions
    await client.query(
      `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
      [refundFace, card.card_id]
    )
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
       VALUES ($1, '扣款', $2, $3, $4)`,
      [card.card_id, -refundFace, pay.sale_order_id, `card-refund-${paymentId}`]
    )

    // 翻 status='已支付' + 记审批人 + paid_at（CAS 守卫：仅 '待审批' → '已支付'，防并发重复审批）
    const casUpd = await client.query(
      `UPDATE sale_order_payments
       SET status='已支付', payment_method='线下', external_txn_id=NULL,
           audit_employee_id=$1, audit_at=NOW(), paid_at=NOW()
       WHERE id=$2 AND status='待审批'`,
      [ctx.auth.staffWfId || null, paymentId]
    )
    if (casUpd.rowCount !== 1) {
      throw new Error('INVALID_STATE: 退款单状态已变更，请刷新后重试')
    }

    // sale_orders.refunded_amount 累加（应用层冗余快照）
    await client.query(
      `UPDATE sale_orders SET refunded_amount = COALESCE(refunded_amount, 0) + $1, updated_at = NOW()
       WHERE sale_order_id = $2`,
      [Math.abs(Number(pay.amount)), pay.sale_order_id]
    )

    // 审计日志
    await logTransition(client, ctx, 'card.approveRefund', 'sale_order_payment', paymentId, '待审批', '已支付', {
      saleOrderId: pay.sale_order_id,
      refundFace,
      refundAmount: Math.abs(Number(pay.amount)),
    })

    if (pay.operator_employee_id && pay.operator_employee_id !== ctx.auth.staffWfId) {
      await notifyRefundResult(client, {
        paymentId,
        saleOrderId: pay.sale_order_id,
        recipientEmployeeId: pay.operator_employee_id,
        approved: true,
        amount: Math.abs(Number(pay.amount)),
      })
    }
  })

  ctx.result = { paymentId, status: '已支付' }
}

/**
 * 店长拒绝充值卡退款
 *
 * payload: { paymentId: number, reason?: string }
 */
async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})
  const { paymentId, reason } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  const payRows = await pg.query(
    `SELECT sop.id, sop.change_type, sop.status, sop.sale_order_id, sop.operator_employee_id,
            so.store_id, so.sale_order_type
     FROM sale_order_payments sop
     JOIN sale_orders so ON sop.sale_order_id = so.sale_order_id
     WHERE sop.id = $1`,
    [paymentId]
  )
  if (payRows.length === 0) throw new Error('NOT_FOUND: 退款单不存在')
  const pay = payRows[0]
  if (pay.change_type !== '退款') {
    throw new Error('INVALID_STATE: 该流水非退款类型')
  }
  if (pay.sale_order_type !== '充值单') {
    throw new Error('INVALID_STATE: 非充值单不可走充值卡退款审批')
  }
  if (pay.status !== '待审批') {
    throw new Error(`INVALID_STATE: 退款单当前状态 ${pay.status} 不可审批`)
  }
  const scopeStoreIds = ctx.auth.scopeStoreIds || []
  if (!scopeStoreIds.includes(pay.store_id)) {
    throw new Error('PERMISSION_DENIED: 当前店长无权审批该门店的退款')
  }

  await pg.transaction(async (client) => {
    const upd = await client.query(
      `UPDATE sale_order_payments
       SET status='已作废', audit_employee_id=$1, audit_at=NOW(), audit_remark=$2
       WHERE id=$3 AND status='待审批'`,
      [ctx.auth.staffWfId || null, reason || null, paymentId]
    )
    if (upd.rowCount !== 1) {
      throw new Error('INVALID_STATE: 退款单状态已变更，请刷新后重试')
    }

    // 审计日志
    await logTransition(client, ctx, 'card.rejectRefund', 'sale_order_payment', paymentId, '待审批', '已作废', {
      saleOrderId: pay.sale_order_id,
      reason: reason || null,
    })

    if (pay.operator_employee_id && pay.operator_employee_id !== ctx.auth.staffWfId) {
      await notifyRefundResult(client, {
        paymentId,
        saleOrderId: pay.sale_order_id,
        recipientEmployeeId: pay.operator_employee_id,
        approved: false,
        reason: reason || null,
        amount: 0,
      })
    }
  })

  ctx.result = { paymentId, status: '已作废' }
}

module.exports = { rechargeConfig, recharge, inflow, createRefund, approveRefund, rejectRefund }
