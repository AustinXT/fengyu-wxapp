/**
 * 系统配置读取 + 内存缓存（会员门槛等动态配置）
 *
 * 权威源：system_configs 表
 * 失效策略（双层）：
 *   1. 主动：admin saveSettings → 调用 config.invalidateConfig action → 清空本函数缓存
 *   2. 被动：每 30 秒最多核对一次 system_configs.updated_at 戳，变化则重读
 * 失败兜底：DB 报错 → 返回 FALLBACK_THRESHOLD（1980）
 *
 * FALLBACK_THRESHOLD 与 admin/actions/settings.ts DEFAULT_SETTINGS 对齐（1980）。
 */

const pg = require('../db/pg')

const FALLBACK_THRESHOLD = 1980
const FALLBACK_POINTS_TO_YUAN_RATE = 0.01 // 100 积分 = 1 元
const FALLBACK_POINTS_DEDUCTION_RATE = 0.03 // 积分抵扣上限比例默认 3%（订单金额的 3%）
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟内存 TTL（处理 warm 实例长期存活场景）
const STALE_CHECK_INTERVAL_MS = 30 * 1000 // 30 秒最多核对一次 updated_at 戳

let _cachedValue = null
let _cachedUpdatedAt = null // system_configs.updated_at 的毫秒戳
let _lastCheckAt = 0

// 积分抵扣上限比例独立缓存（与会员门槛互不干扰，各自 30s 戳核对 + 5min TTL）
let _pointsRateCachedValue = null
let _pointsRateCachedUpdatedAt = null
let _pointsRateLastCheckAt = 0
let _deductRateCachedValue = null
let _deductRateCachedUpdatedAt = null
let _deductRateLastCheckAt = 0

/**
 * 获取会员门槛（单位：元）。
 * @returns {Promise<number>}
 */
async function getMemberThreshold() {
  const now = Date.now()

  if (_cachedValue !== null && (now - _lastCheckAt) < STALE_CHECK_INTERVAL_MS) {
    return _cachedValue
  }

  try {
    const rows = await pg.query(
      "SELECT value, updated_at FROM system_configs WHERE key = 'new_member_threshold'"
    )
    const row = rows[0]
    if (row) {
      const ts = new Date(row.updated_at).getTime()
      if (ts !== _cachedUpdatedAt || _cachedValue === null) {
        const v = Number(row.value)
        if (Number.isFinite(v) && v > 0) {
          _cachedValue = v
          _cachedUpdatedAt = ts
        }
      }
      _lastCheckAt = now
      if (_cachedValue !== null) return _cachedValue
    }
  } catch (err) {
    console.warn('[config] getMemberThreshold fallback:', err.message)
  }

  return FALLBACK_THRESHOLD
}

/**
 * 获取积分折算金额比例（默认 0.01，即 100 积分 = 1 元）。
 * @returns {Promise<number>}
 */
async function getPointsToYuanRate() {
  const now = Date.now()

  if (_pointsRateCachedValue !== null && (now - _pointsRateLastCheckAt) < STALE_CHECK_INTERVAL_MS) {
    return _pointsRateCachedValue
  }

  try {
    const rows = await pg.query(
      "SELECT value, updated_at FROM system_configs WHERE key = 'points_to_yuan_rate'"
    )
    const row = rows[0]
    if (row) {
      const ts = new Date(row.updated_at).getTime()
      const v = Number(row.value)
      _pointsRateLastCheckAt = now
      _pointsRateCachedUpdatedAt = ts
      if (Number.isFinite(v) && v > 0) {
        _pointsRateCachedValue = v
        return _pointsRateCachedValue
      }
      _pointsRateCachedValue = null
      return FALLBACK_POINTS_TO_YUAN_RATE
    }
  } catch (err) {
    console.warn('[config] getPointsToYuanRate fallback:', err.message)
  }

  // DB 无该 key / 查询失败 → 缓存兜底值 30s 防每次穿透 DB
  _pointsRateCachedValue = FALLBACK_POINTS_TO_YUAN_RATE
  _pointsRateCachedUpdatedAt = null
  _pointsRateLastCheckAt = now
  return FALLBACK_POINTS_TO_YUAN_RATE
}

/**
 * 获取积分抵扣上限比例（0~1 小数，默认 0.03 即 3%）。
 *
 * 口径：积分可抵扣金额上限 = 使用优惠券和积分「前」的订单金额 × 该比例。
 * 日常 3%，活动期运营在 admin 系统配置-基础配置临时调至 5%，活动后改回。
 * 值域 [0, 1]；DB 无该行 / 解析失败 / 越界一律降级为 FALLBACK_POINTS_DEDUCTION_RATE。
 *
 * 与 admin/lib/system-config.getPointsDeductionMaxRate + staffApi/payNotify 副本同口径
 * （三端独立副本，靠各自单测守护；不进 cross-end-sql-snapshot）。
 *
 * @returns {Promise<number>}
 */
async function getPointsDeductionMaxRate() {
  const now = Date.now()

  if (_deductRateCachedValue !== null && (now - _deductRateLastCheckAt) < STALE_CHECK_INTERVAL_MS) {
    return _deductRateCachedValue
  }

  try {
    const rows = await pg.query(
      "SELECT value, updated_at FROM system_configs WHERE key = 'points_deduction_max_rate'"
    )
    const row = rows[0]
    if (row) {
      const ts = new Date(row.updated_at).getTime()
      const v = Number(row.value)
      _deductRateLastCheckAt = now
      _deductRateCachedUpdatedAt = ts
      if (Number.isFinite(v) && v >= 0 && v <= 1) {
        _deductRateCachedValue = v
        return _deductRateCachedValue
      }
      _deductRateCachedValue = null
      return FALLBACK_POINTS_DEDUCTION_RATE
    }
  } catch (err) {
    console.warn('[config] getPointsDeductionMaxRate fallback:', err.message)
  }

  // DB 无该 key / 查询失败 → 缓存兜底值 30s 防每次穿透 DB
  _deductRateCachedValue = FALLBACK_POINTS_DEDUCTION_RATE
  _deductRateCachedUpdatedAt = null
  _deductRateLastCheckAt = now
  return FALLBACK_POINTS_DEDUCTION_RATE
}

/**
 * 主动清缓存（供 config.invalidateConfig action 调用）
 */
function invalidateCache() {
  _cachedValue = null
  _cachedUpdatedAt = null
  _lastCheckAt = 0
  _pointsRateCachedValue = null
  _pointsRateCachedUpdatedAt = null
  _pointsRateLastCheckAt = 0
  _deductRateCachedValue = null
  _deductRateCachedUpdatedAt = null
  _deductRateLastCheckAt = 0
}

const _ttlTimer = setInterval(() => {
  const now = Date.now()
  if (
    (_cachedValue !== null && (now - _lastCheckAt) > CACHE_TTL_MS) ||
    (_pointsRateCachedValue !== null && (now - _pointsRateLastCheckAt) > CACHE_TTL_MS) ||
    (_deductRateCachedValue !== null && (now - _deductRateLastCheckAt) > CACHE_TTL_MS)
  ) {
    invalidateCache()
  }
}, CACHE_TTL_MS)
if (_ttlTimer && typeof _ttlTimer.unref === 'function') {
  _ttlTimer.unref()
}

module.exports = {
  getMemberThreshold,
  getPointsToYuanRate,
  getPointsDeductionMaxRate,
  invalidateCache,
  FALLBACK_THRESHOLD,
  FALLBACK_POINTS_TO_YUAN_RATE,
  FALLBACK_POINTS_DEDUCTION_RATE,
}
