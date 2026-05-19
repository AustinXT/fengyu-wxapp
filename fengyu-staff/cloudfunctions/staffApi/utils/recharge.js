/**
 * 充值卡档位配置加载 + matchTier 工具
 *
 * 2026-05-20 充值卡剥离 SKU 化：档位/边界来源从代码硬编码改为 system_configs 表。
 * key:
 *   recharge.tiers     — JSON 数组 [{faceValue, payAmount}, ...]
 *   recharge.minAmount — 字符串数字，最低充值金额
 *   recharge.maxAmount — 字符串数字，单次上限
 *
 * 调用方应在请求生命周期内 await loadRechargeConfig(pg)，结果可短期缓存到 ctx。
 */

/**
 * 从 system_configs 读取充值卡档位配置
 * @param {object} pg - PG client（pg.query 兼容接口）
 * @returns {Promise<{ tiers: Array<{faceValue:number, payAmount:number}>, minAmount: number, maxAmount: number }>}
 */
async function loadRechargeConfig(pg) {
  const rows = await pg.query(
    `SELECT key, value FROM system_configs WHERE key IN ('recharge.tiers','recharge.minAmount','recharge.maxAmount')`
  )
  const cfg = {}
  for (const r of rows) cfg[r.key] = r.value
  if (!cfg['recharge.tiers'] || !cfg['recharge.minAmount'] || !cfg['recharge.maxAmount']) {
    throw new Error('INVALID_STATE: 系统未配置充值卡档位（system_configs.recharge.*）')
  }
  let tiers
  try {
    tiers = JSON.parse(cfg['recharge.tiers'])
  } catch (e) {
    throw new Error('INVALID_STATE: recharge.tiers 配置格式错误（非合法 JSON）')
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('INVALID_STATE: recharge.tiers 配置必须为非空数组')
  }
  for (const t of tiers) {
    if (typeof t.faceValue !== 'number' || typeof t.payAmount !== 'number') {
      throw new Error('INVALID_STATE: recharge.tiers 条目必须含 faceValue/payAmount 数字字段')
    }
  }
  // 按 faceValue 升序，便于 matchTier 区间匹配
  tiers.sort((a, b) => a.faceValue - b.faceValue)
  const minAmount = Number(cfg['recharge.minAmount'])
  const maxAmount = Number(cfg['recharge.maxAmount'])
  if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount <= 0 || maxAmount < minAmount) {
    throw new Error('INVALID_STATE: recharge.minAmount/maxAmount 配置无效')
  }
  return { tiers, minAmount, maxAmount }
}

/**
 * 按自定义面值匹配档位实付金额
 *
 * 匹配规则：找最大的 faceValue ≤ amount 的档位，按 (payAmount/faceValue) 折扣比推算实付。
 * 若 amount 恰为某档面值，直接取该档 payAmount。
 *
 * @param {number} amount - 顾客输入的面值
 * @param {object} cfg - loadRechargeConfig 返回的配置
 * @returns {{ payAmount: number, discount: number }} discount 仅用于前端展示
 * @throws 'INVALID_PARAMS: ...'
 */
function matchTier(amount, cfg) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('INVALID_PARAMS: 充值金额格式错误')
  }
  if (Math.round(amount * 100) !== amount * 100) {
    throw new Error('INVALID_PARAMS: 充值金额最多保留 2 位小数')
  }
  if (amount < cfg.minAmount) {
    throw new Error(`INVALID_PARAMS: 最低充值金额 ¥${cfg.minAmount}`)
  }
  if (amount > cfg.maxAmount) {
    throw new Error(`INVALID_PARAMS: 单次充值上限 ¥${cfg.maxAmount}`)
  }
  // 精确命中档位则直取
  const hit = cfg.tiers.find(t => t.faceValue === amount)
  if (hit) {
    const discount = amount > 0 ? Math.round((hit.payAmount / amount) * 100) / 100 : 1
    return { payAmount: hit.payAmount, discount }
  }
  // 否则取最大的 faceValue ≤ amount 档位的折扣比，按比例换算
  let baseTier = cfg.tiers[0]
  for (const t of cfg.tiers) {
    if (amount >= t.faceValue) baseTier = t
  }
  const ratio = baseTier.payAmount / baseTier.faceValue
  const payAmount = Math.round(amount * ratio * 100) / 100
  const discount = Math.round(ratio * 100) / 100
  return { payAmount, discount }
}

module.exports = {
  loadRechargeConfig,
  matchTier,
}
