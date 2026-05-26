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
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟内存 TTL（处理 warm 实例长期存活场景）
const STALE_CHECK_INTERVAL_MS = 30 * 1000 // 30 秒最多核对一次 updated_at 戳

let _cachedValue = null
let _cachedUpdatedAt = null // system_configs.updated_at 的毫秒戳
let _lastCheckAt = 0

/**
 * 获取会员门槛（单位：元）。
 * @returns {Promise<number>}
 */
async function getMemberThreshold() {
  const now = Date.now()

  // Fast path：内存缓存有效且 30s 内已核对过
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
      // updated_at 戳变化 → 重读 value
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

  // 查询失败或 DB 无该 key / 无效 value → 兜底但不写缓存（下次重试）
  return FALLBACK_THRESHOLD
}

/**
 * 主动清缓存（供 config.invalidateConfig action 调用）
 */
function invalidateCache() {
  _cachedValue = null
  _cachedUpdatedAt = null
  _lastCheckAt = 0
}

// TTL 双保险：模块加载时起每 5 分钟强制过期一次
const _ttlTimer = setInterval(() => {
  if (_cachedValue !== null && (Date.now() - _lastCheckAt) > CACHE_TTL_MS) {
    invalidateCache()
  }
}, CACHE_TTL_MS)
if (_ttlTimer && typeof _ttlTimer.unref === 'function') {
  _ttlTimer.unref()
}

module.exports = {
  getMemberThreshold,
  invalidateCache,
  FALLBACK_THRESHOLD,
}
