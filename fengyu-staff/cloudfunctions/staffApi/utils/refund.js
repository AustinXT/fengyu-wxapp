/**
 * 退款工具函数
 *
 * 核心规则（ticket 2026-04-24-refund-admin-parity-and-rules §1.2）：
 *   refundable_per_item = 未使用数量 × unit_real_price
 *   total_refundable    = Σ(refundable_per_item)
 *   final_refund_amount = max(0, total_refundable − handling_fee)
 *
 * 未使用数量按 sale_items.product_type 区分（2026-05-21 单品合并后）：
 *   疗程卡（含原单品=1 次卡）：remaining_sessions
 *   家居产品：quantity − picked_up_quantity
 *
 * 多收余数（overpay，2026-07-18 ticket FY-XSD-WX-2607150028）：
 *   部分支付单 received 不能被单次价整除时，差额是订单级孤儿（不落任何品项 received），
 *   按整次×单价逐项求和永远够不到它。补一条订单级纯现金退款（哨兵行 OVERPAY_SENTINEL）：
 *     overpayRefundable = max(0, (received − refunded − 已消耗价值) − Σ(未用整次×单价))
 *   不挂品项、不退次数、不触发作废级联（5 通道按 sale_item_id 匹配哨兵均落空，仅积分通道订单级按比例冲销）。
 *   两端镜像 admin lib/refund.ts。详见 plan fy-xsd-wx-2607150028-3000-2786-idempotent-goose。
 */

/** 多收余数退款哨兵 refSaleItemId（非空，禁用 null：refund-cascade.js 空明细兜底会把全品项当全退） */
const OVERPAY_SENTINEL = 'OVERPAY'

/**
 * 计算单个 sale_item 的可退未使用数量
 * @param {object} item sale_items 行（snake_case 字段）
 * @returns {number} 可退数量（≥0）
 */
function calculateUnusedQuantity(item) {
  if (!item) return 0
  if (item.product_type === '疗程卡') {
    // 修复（Bug A 数量门）：退款不减 remaining_sessions（Model X），仅靠 remaining 算可退会让全额退后
    // 仍显示全部可退 → 重复退款。真正可退 = 已付次数 − 已消费次数 = paid_sessions − (session_count − remaining)。
    // paid_sessions 已反映所有已审批退款（approveRefund 末尾 recalc），全额退后为 0 → 可退 0。
    // paid_sessions 为 null（历史行）回退 remaining_sessions，金额门仍兜底。两端镜像 admin lib/refund.ts。
    const remaining = Number(item.remaining_sessions || 0)
    if (item.paid_sessions == null) return remaining
    const consumed = Number(item.session_count || 0) - remaining
    return Math.max(0, Math.min(remaining, Number(item.paid_sessions) - consumed))
  }
  const quantity = Number(item.quantity || 0)
  const pickedUp = Number(item.picked_up_quantity || 0)
  return Math.max(0, quantity - pickedUp)
}

/**
 * 计算订单级「多收余数」可退额（overpay）。
 *
 * 部分支付单 received 不能被单次价整除时，超出 Σ(整次×单价) 的零头是订单级孤儿，
 * 逐项整次退款够不到它。本函数算出这笔可退的纯现金余数：
 *   overpay = max(0, netReceived − 已消耗价值 − Σ(未用整次×单价))
 * 其中 netReceived = received − refunded_amount（订单仍持有的实收）。
 *
 * @param {object} order sale_orders 行（需 received / refunded_amount）
 * @param {Array<object>} origItems 原单 sale_items（item_direction='购买'）
 * @returns {number} 多收余数可退额（≥0，已 round 到分）
 */
function computeOverpayRemainder(order, origItems) {
  const netReceived = Math.max(0, (Number(order && order.received) || 0) - (Number(order && order.refunded_amount) || 0))
  let consumedValue = 0
  let maxSessionRefundable = 0
  for (const it of origItems || []) {
    const urp = Number(it.unit_real_price) || 0
    if (it.product_type === '疗程卡') {
      const sc = Number(it.session_count) || 0
      const rem = Number(it.remaining_sessions) || 0
      consumedValue += Math.max(0, sc - rem) * urp
    } else {
      consumedValue += (Number(it.picked_up_quantity) || 0) * urp
    }
    maxSessionRefundable += calculateUnusedQuantity(it) * urp
  }
  consumedValue = Math.round(consumedValue * 100) / 100
  maxSessionRefundable = Math.round(maxSessionRefundable * 100) / 100
  return Math.max(0, Math.round((netReceived - consumedValue - maxSessionRefundable) * 100) / 100)
}

/**
 * 校验并构建退款明细
 *
 * @param {Array<object>} origItems 原单 sale_items（item_direction='购买'）
 * @param {Array<{saleItemId: string, refundQuantity?: number}>} requestItems 前端请求
 * @returns {{ refundDetails: Array, totalRefund: number }}
 * @throws Error INVALID_PARAMS / INVALID_STATE
 */
function buildRefundDetails(origItems, requestItems) {
  const itemMap = {}
  for (const i of origItems) itemMap[i.sale_item_id] = i

  const refundDetails = []
  let totalRefund = 0

  for (const req of requestItems) {
    const orig = itemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)

    const maxUnused = calculateUnusedQuantity(orig)
    // 疗程卡必须整卡全退（不支持部分退次数）：强制 requested = maxUnused，忽略前端传入的部分数量；
    // 家居产品仍可按未提货数量部分退。两端镜像 admin lib/refund.ts。
    const requested =
      orig.product_type === '疗程卡' ? maxUnused : (Number(req.refundQuantity) || maxUnused)

    if (requested <= 0) {
      throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 退款数量必须大于 0`)
    }
    if (requested > maxUnused) {
      throw new Error(
        `INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`,
      )
    }

    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = Math.round(unitRealPrice * requested * 100) / 100
    totalRefund += refundAmount

    // 退款行 service_fee 按比例扣减（原 service_fee 占比 × 退款数量占比）
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * requested / origQty) * 100) / 100

    // 修复（Bug M 强化 2026-06-08）：仅「退光全部可退 **且** 该明细零已消费/零已提货」才算全退该明细。
    // 退款只退未使用数量，未使用部分本无 service_commission；收紧后通道2 对被退 item 天然零作废，
    // 保护「已完成服务的提成」与「已实现营收的分配」不被退剩余次数误删（两端镜像 admin lib/refund.ts）。
    const consumedQty = orig.product_type === '疗程卡'
      ? Number(orig.session_count || 0) - Number(orig.remaining_sessions || 0)
      : Number(orig.picked_up_quantity || 0)

    refundDetails.push({
      refSaleItemId: req.saleItemId,
      skuId: orig.sku_id,
      productName: orig.product_name,
      productType: orig.product_type,
      sessionCount: orig.session_count,
      unitPrice: Number(orig.unit_price),
      quantity: requested,
      unitRealPrice,
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
      isShengmei: orig.is_shengmei ?? null,
      isFullItemRefund: requested >= maxUnused && consumedQty <= 0,
    })
  }

  return {
    refundDetails,
    totalRefund: Math.round(totalRefund * 100) / 100,
  }
}

/**
 * 退款封顶截断（疗程卡整卡全退专用）。
 *
 * 疗程卡强制整卡全退、退款数量不可调（见 buildRefundDetails）。部分支付订单（如疗程卡只付定金、
 * 次数全在）整卡值可能 > 净已收 refundCap，旧逻辑直接拒绝 → 该订单永远无法退款。
 * 改为：把逐项 refundAmount 等比缩到 targetGross（= refundCap + 手续费），数量不变（整卡仍作废）。
 * 退款额截断到「只退已付部分」，打破「数量↔金额自洽」（数量=整卡次数、金额=已付），符合"只能退已付"。
 *
 * 最大余数法对齐总额：逐项 floor 后把尾差补到 refundAmount 最大的一项，避免逐项 round 累积偏移。
 * 返回缩放后的 totalRefund（= targetGross）。两端镜像 admin src/lib/refund.ts。
 */
function capRefundAmounts(refundDetails, originalTotal, targetGross) {
  if (originalTotal <= 0 || targetGross >= originalTotal || refundDetails.length === 0) {
    return originalTotal
  }
  const ratio = targetGross / originalTotal
  let allocated = 0
  for (const d of refundDetails) {
    const v = Math.floor(d.refundAmount * ratio * 100) / 100
    d.refundAmount = v
    allocated += v
  }
  const remainder = Math.round((targetGross - allocated) * 100) / 100
  if (remainder !== 0) {
    let maxIdx = 0
    for (let i = 1; i < refundDetails.length; i += 1) {
      if (refundDetails[i].refundAmount > refundDetails[maxIdx].refundAmount) maxIdx = i
    }
    refundDetails[maxIdx].refundAmount = Math.round((refundDetails[maxIdx].refundAmount + remainder) * 100) / 100
  }
  return Math.round(targetGross * 100) / 100
}

/**
 * 按原单储值卡抵扣比例，将退款金额拆为储值卡回冲 + 原路径退款
 *
 *   refundByCard   = floor(origPrepaidCardAmount / origTotalAmount × refundAmount, 2)
 *   refundByOrigin = refundAmount − refundByCard   // 反向相减，无尾差
 *
 * @param {number} refundAmount 本次退款金额（正数，已扣 handling_fee）
 * @param {number} origPrepaidCardAmount 原单储值卡抵扣部分
 * @param {number} origTotalAmount 原单总金额
 * @returns {{ refundByCard: number, refundByOrigin: number }}
 */
/**
 * 拆分退款现金 vs 储值卡
 *
 * 2026-06-28 改为「全部走现金」：退款不再按储值卡占比拆分，refundByCard 始终为 0。
 * 所有退款统一走现金（refundByOrigin），避免用户退款拿到的现金和疗程卡对应金额不一致的误解，
 * 也避免了退款时出现剩余金额无法退款的情况。
 *
 * @param {number} refundAmount 退款总额
 * @param {number} _origPrepaidCardAmount 原单储值卡抵扣额（保留入参兼容调用方，不参与计算）
 * @param {number} _origTotalAmount 原单总额（保留入参兼容调用方，不参与计算）
 * @returns {{ refundByCard: number, refundByOrigin: number }}
 */
function splitRefundByOriginalPayment(refundAmount, _origPrepaidCardAmount, _origTotalAmount) {
  return {
    refundByCard: 0,
    refundByOrigin: Math.round(refundAmount * 100) / 100,
  }
}

/**
 * 决定退款 payments 行的 payment_method
 *
 * 2026-06-24 改为「全部走线下退款」：退款不按原路返还，一律记 '线下'（门店现场退现金/转账），
 * 不调拉卡拉/微信原路退款接口。2026-06-28 退款全部走现金（refundByCard=0），
 * 不再回冲储值卡余额。两端镜像 admin lib/refund.ts。
 *
 * @param {string} _origPaymentMethod 原单 payment_method（已不参与决策，保留入参兼容调用方）
 * @returns {string} 退款行的 payment_method（恒 '线下'）
 */
function resolveRefundPaymentMethod(_origPaymentMethod) {
  return '线下'
}

/**
 * 待审批退款冻结守卫（Bug I）：订单存在待审批退款时禁止改动其衍生数据（核销/分配/提货/回款）。
 * client 可为顶层 pg（query 返回数组）或事务内 client（返回 {rows}），兼容两种。
 */
async function assertNoPendingRefund(client, saleOrderId) {
  if (!saleOrderId) return
  const r = await client.query(
    `SELECT 1 FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待审批' LIMIT 1`,
    [saleOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_IN_PROGRESS: 该订单退款审批中，暂不可操作')
  }
}

/**
 * 退款已结算守卫（2026-06-24）：订单存在「已支付」退款时禁止重分配/清除分配。
 * 退款已记负数冲销行（挂退款流水 id），重保存/清除会与负数行脱节产生悬空净额。
 * client 可为顶层 pg（query 返回数组）或事务内 client（返回 {rows}）。SQL 谓词镜像 admin allocations.ts。
 */
async function assertNoSettledRefund(client, saleOrderId) {
  if (!saleOrderId) return
  const r = await client.query(
    `SELECT 1 FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '已支付' LIMIT 1`,
    [saleOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_SETTLED: 该订单已退款，营业额分配已锁定，不可再修改')
  }
}

/**
 * 退款已结算守卫·回款级（2026-06-24）：仅当本回款 salePaymentId 的可分配 item 中存在「已被结算退款冲销」的 item 时抛错。
 * 收窄订单级守卫——使同单其它无关 item 的后续回款仍可正常分配，不被同单一笔无关退款误锁。
 * 判定：本回款 sale_payment_allocatable_items ∩ 挂在「已支付退款流水」上的负数 sale_allocations 冲销行（sale_item 维度）≠ ∅。
 * SQL 谓词镜像 admin lib/refund-cascade.ts hasSettledRefundForPayment。
 */
async function assertNoSettledRefundForPayment(client, salePaymentId) {
  if (!salePaymentId) return
  const r = await client.query(
    `SELECT 1
       FROM sale_allocations sa
       JOIN sale_order_payments rsop ON rsop.id = sa.sale_payment_id
      WHERE sa.is_void = false
        AND sa.total_amount < 0
        AND rsop.change_type = '退款' AND rsop.status = '已支付'
        AND sa.sale_item_id IN (
          SELECT sale_item_id FROM sale_payment_allocatable_items WHERE sale_payment_id = $1
        )
      LIMIT 1`,
    [salePaymentId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_SETTLED: 该订单已退款，营业额分配已锁定，不可再修改')
  }
}

/**
 * 按服务单反查其涉及的所有订单是否有待审批退款（service.confirm 用，一服务单可跨多订单核销）。
 */
async function assertNoPendingRefundByServiceOrder(client, serviceOrderId) {
  if (!serviceOrderId) return
  const r = await client.query(
    `SELECT 1 FROM service_items sit
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
       JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
      WHERE sit.service_order_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批' LIMIT 1`,
    [serviceOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_IN_PROGRESS: 关联订单退款审批中，暂不可确认')
  }
}

/**
 * 退款通知（Bug C）：发起 → 通知门店店长（自审降噪）。client 须事务内（与写 sop 原子）。
 * 店长解析：permission_roles role='manager' 且 scope 直接绑定该 store 节点（store 级店长）。
 * SQL 谓词镜像 admin lib/refund-cascade.ts。
 */
async function notifyRefundCreated(client, { paymentId, saleOrderId, storeId, operatorId, amount, customerName }) {
  if (!storeId) return
  const mgrs = await client.query(
    `SELECT DISTINCT pr.employee_id FROM permission_roles pr
       JOIN stores s ON s.org_node_id = pr.scope_id
      WHERE pr.role = 'manager' AND s.store_id = $1`,
    [storeId],
  )
  const rows = mgrs && mgrs.rows ? mgrs.rows : mgrs
  for (const m of rows || []) {
    if (m.employee_id === operatorId) continue // 自审降噪：店长自己发起不通知自己
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
       VALUES ('员工', $1, $2, $3, 'order', $4, 'sale_order_payment', $5, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [m.employee_id, '退款待审批', `${customerName || '顾客'}的订单 ${saleOrderId} 发起退款 ¥${amount}，请及时审批`, `refund-created-${paymentId}-${m.employee_id}`, String(paymentId)],
    )
  }
}

/**
 * 退款审批结果通知（Bug C）：审批通过/驳回 → 通知发起人。client 须事务内。
 */
async function notifyRefundResult(client, { paymentId, saleOrderId, recipientEmployeeId, approved, reason, amount }) {
  if (!recipientEmployeeId) return
  const title = approved ? '退款已通过' : '退款已驳回'
  const body = approved
    ? `订单 ${saleOrderId} 退款 ¥${amount} 已审批通过`
    : `订单 ${saleOrderId} 退款申请被驳回${reason ? '：' + reason : ''}`
  const key = approved ? `refund-approved-${paymentId}` : `refund-rejected-${paymentId}`
  await client.query(
    `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
     VALUES ('员工', $1, $2, $3, 'order', $4, 'sale_order_payment', $5, NOW())
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [recipientEmployeeId, title, body, key, String(paymentId)],
  )
}

module.exports = {
  OVERPAY_SENTINEL,
  calculateUnusedQuantity,
  computeOverpayRemainder,
  buildRefundDetails,
  capRefundAmounts,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
  assertNoPendingRefund,
  assertNoSettledRefund,
  assertNoSettledRefundForPayment,
  assertNoPendingRefundByServiceOrder,
  notifyRefundCreated,
  notifyRefundResult,
}
