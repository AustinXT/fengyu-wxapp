// #529：资金净额与退项权益分开；金额仅使用整数分。
function cents(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_PARAMS: 退款金额不合法')
  return Math.round(n * 100)
}

// 按有效实付权重分摊；单项不得超过毛退款，封顶后在剩余项中继续分摊。
function allocate(total, rows, caps) {
  const result = rows.map(() => 0)
  let left = total
  while (left > 0) {
    const active = rows.map((r, i) => ({ ...r, i, cap: caps[i] - result[i] }))
      .filter(r => r.cap > 0 && r.weight > 0)
    const weight = active.reduce((s, r) => s + r.weight, 0)
    if (!weight) throw new Error('INVALID_STATE: 手续费缺少可分摊的商品实付')
    const saturated = active.filter(r => left * r.weight / weight >= r.cap)
    if (saturated.length) {
      for (const r of saturated) { result[r.i] += r.cap; left -= r.cap }
      continue
    }
    const parts = active.map(r => {
      const exact = left * r.weight / weight
      return { ...r, amount: Math.floor(exact), frac: exact - Math.floor(exact) }
    }).sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id))
    let tail = left - parts.reduce((s, r) => s + r.amount, 0)
    for (const r of parts) { result[r.i] += r.amount + (tail-- > 0 ? 1 : 0) }
    left = 0
  }
  return result
}

function allocateRefundAccounting(items, paidByItem, handlingFee, overdraftDeduction = 0) {
  if (new Set(items.map(it => it.refSaleItemId)).size !== items.length) throw new Error('INVALID_PARAMS: 退款商品子项不能重复')
  const caps = items.map(it => cents(it.refundAmount))
  const fee = cents(handlingFee)
  const deduction = cents(overdraftDeduction)
  if (fee + deduction > caps.reduce((s, n) => s + n, 0)) {
    throw new Error('INVALID_PARAMS: 手续费及扣除金额超过退款毛额')
  }
  const weights = items.map((it, i) => ({ id: it.refSaleItemId,
    weight: caps[i] > 0 ? cents(paidByItem.get(it.refSaleItemId) ?? 0) : 0 }))
  const fees = allocate(fee, weights, caps)
  // 既有透支扣除独立于手续费，按扣手续费后的退款额分摊。
  const remaining = caps.map((n, i) => n - fees[i])
  const deductions = allocate(deduction, items.map((it, i) => ({ id: it.refSaleItemId, weight: remaining[i] })), remaining)
  return items.map((it, i) => ({ ...it, grossRefundAmount: caps[i] / 100, paidAmount: weights[i].weight / 100,
    handlingFee: fees[i] / 100, overdraftDeduction: deductions[i] / 100,
    netRefundAmount: (caps[i] - fees[i] - deductions[i]) / 100 }))
}

module.exports = { allocateRefundAccounting, remapLegacyOverpay }

// 历史订单级余数必须先落到锁内仍可退余数的真实商品，再分摊手续费。
// 使用真实余数容量，不能借用其它商品的整次本金或已折抵金额。
function remapLegacyOverpay(items, availableByItem) {
  const sentinel = items.find(it => it.refSaleItemId === 'OVERPAY')
  if (!sentinel) return items
  if (new Set(items.map(it => it.refSaleItemId)).size !== items.length) throw new Error('INVALID_PARAMS: 退款商品子项不能重复')
  const real = items.filter(it => it.refSaleItemId !== 'OVERPAY').map(it => ({ ...it }))
  const candidates = [...availableByItem].sort(([a], [b]) => a.localeCompare(b))
  const caps = candidates.map(([id, amount]) => Math.max(0, cents(amount) - cents(real.find(it => it.refSaleItemId === id)?.overpayAmount)))
  const total = cents(sentinel.refundAmount)
  if (total > caps.reduce((sum, amount) => sum + amount, 0)) throw new Error('CONFLICT: OVERPAY_REFUNDABLE_CHANGED: 可退余数已变化，请刷新后重新发起退款')
  const parts = allocate(total, candidates.map(([id], i) => ({ id, weight: caps[i] })), caps)
  for (let i = 0; i < candidates.length; i += 1) {
    if (parts[i] <= 0) continue
    const id = candidates[i][0]
    const existing = real.find(it => it.refSaleItemId === id)
    if (existing) {
      existing.refundAmount = (cents(existing.refundAmount) + parts[i]) / 100
      existing.overpayAmount = (cents(existing.overpayAmount) + parts[i]) / 100
    } else {
      real.push({ ...sentinel, refSaleItemId: id, refundAmount: parts[i] / 100,
        overpayAmount: parts[i] / 100, quantity: 0, sessionCount: 0,
        isOverpay: false, isFullItemRefund: false })
    }
  }
  return real
}
