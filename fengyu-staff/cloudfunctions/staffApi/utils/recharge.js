/**
 * 充值卡档位配置 + matchTier 工具
 *
 * 与 fengyu-client/cloudfunctions/clientApi/routes/card.js / fengyu-admin/src/lib/recharge.ts 同源。
 * 修改档位前先全文同步三端。
 */

const RECHARGE_TIERS = [
  { faceValue: 500, discount: 0.99 },
  { faceValue: 1000, discount: 0.98 },
  { faceValue: 5000, discount: 0.95 },
]
const RECHARGE_MIN_AMOUNT = 500
const RECHARGE_MAX_AMOUNT = 100000
const RECHARGE_VIRTUAL_SKU_ID = 'sku-recharge-virtual'

/**
 * 按自定义面值匹配折扣（区间左闭右开）
 * @param {number} amount
 * @returns {{ discount: number, payAmount: number }}
 * @throws 校验失败抛 'INVALID_PARAMS: ...'
 */
function matchTier(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  if (Math.round(amount * 100) !== amount * 100) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数')
  }
  if (amount < RECHARGE_MIN_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${RECHARGE_MIN_AMOUNT}`)
  }
  if (amount > RECHARGE_MAX_AMOUNT) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${RECHARGE_MAX_AMOUNT}`)
  }
  let discount = RECHARGE_TIERS[0].discount
  for (const tier of RECHARGE_TIERS) {
    if (amount >= tier.faceValue) discount = tier.discount
  }
  const payAmount = Math.round(amount * discount * 100) / 100
  return { discount, payAmount }
}

module.exports = {
  RECHARGE_TIERS,
  RECHARGE_MIN_AMOUNT,
  RECHARGE_MAX_AMOUNT,
  RECHARGE_VIRTUAL_SKU_ID,
  matchTier,
}
