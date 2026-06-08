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
 */

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
    const requested = Number(req.refundQuantity) || maxUnused

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
function splitRefundByOriginalPayment(refundAmount, origPrepaidCardAmount, origTotalAmount) {
  let refundByCard = 0
  let refundByOrigin = Math.round(refundAmount * 100) / 100

  if (origPrepaidCardAmount > 0 && origTotalAmount > 0 && refundAmount > 0) {
    const raw = (origPrepaidCardAmount / origTotalAmount) * refundAmount
    refundByCard = Math.floor(raw * 100) / 100
    refundByOrigin = Math.round((refundAmount - refundByCard) * 100) / 100
  }

  return { refundByCard, refundByOrigin }
}

/**
 * 决定退款 payments 行的 payment_method
 *
 * 过渡期：微信/支付宝退款 API 未集成前，原单微信/支付宝通道的退款
 * 暂用 '线下' 承接（需店员现场退现或走其他渠道），下一 ticket 集成三方 refund
 * API 后改为 '微信'/'支付宝' + external_txn_id。
 *
 * @param {string} origPaymentMethod 原单 payment_method 枚举值
 * @returns {string} 退款行的 payment_method
 */
function resolveRefundPaymentMethod(origPaymentMethod) {
  if (origPaymentMethod === '微信' || origPaymentMethod === '支付宝') {
    return '线下'
  }
  if (!origPaymentMethod || origPaymentMethod === '无') {
    return '线下'
  }
  return origPaymentMethod
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
  calculateUnusedQuantity,
  buildRefundDetails,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
  assertNoPendingRefund,
  assertNoPendingRefundByServiceOrder,
  notifyRefundCreated,
  notifyRefundResult,
}
