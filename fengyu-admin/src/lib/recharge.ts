/**
 * 充值卡档位配置与匹配逻辑（admin 侧）
 *
 * ⚠️ 必须与 client 云函数 `fengyu-client/cloudfunctions/clientApi/routes/card.js`
 *    的 RECHARGE_TIERS / RECHARGE_MIN_AMOUNT / RECHARGE_MAX_AMOUNT / matchTier 保持一致。
 *    档位或折扣变更时务必两端同改，否则 admin 开单与 client 小程序充值的面值/实付
 *    会出现不一致，引发对账问题。
 *
 * 同样，RECHARGE_VIRTUAL_SKU_ID 与 `fengyu-client/cloudfunctions/clientApi/routes/_constants.js`
 * 以及 `fengyu-client/cloudfunctions/payNotify/index.js` 重复定义保持同值。
 *
 * TODO(future): 改"不发版"运营档位时，独立成 recharge_tier_config 表，admin 维护，
 *               client/云函数从 DB 读。本期硬编码。
 */

export const RECHARGE_VIRTUAL_SKU_ID = 'sku-recharge-virtual'

export interface RechargeTier {
  faceValue: number
  discount: number
}

export const RECHARGE_TIERS: readonly RechargeTier[] = [
  { faceValue: 500, discount: 0.99 },
  { faceValue: 1000, discount: 0.98 },
  { faceValue: 5000, discount: 0.95 },
]

export const RECHARGE_MIN_AMOUNT = 500
export const RECHARGE_MAX_AMOUNT = 100000

/**
 * 按充值面值匹配折扣并计算实付金额（区间左闭右开）。
 *
 * 500-999   → 9.9 折
 * 1000-4999 → 9.8 折
 * ≥5000     → 9.5 折
 *
 * @throws Error 前缀为 INVALID_PARAMS，由调用方捕获后 return {success:false,message} 或原样透出
 */
export function matchTier(amount: number): { discount: number; payAmount: number } {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  // 小数位 ≤ 2
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

/**
 * 从 sale_items.product_name（形如 "预付充值卡 ¥500"）中解析面值。
 * @returns 面值（数字）；无法解析返回 null。
 */
export function parseRechargeFaceValue(productName: string | null | undefined): number | null {
  if (!productName) return null
  const m = productName.match(/¥\s*(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = parseFloat(m[1])
  if (!Number.isFinite(v) || v <= 0) return null
  return v
}
