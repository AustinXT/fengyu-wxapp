

const pg = require('pg')
const { Pool } = pg



pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)))    
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)))    



pg.types.setTypeParser(1114, (val) => (val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')))

const FALLBACK_THRESHOLD = 1980
const CACHE_TTL_MS = 5 * 60 * 1000
const STALE_CHECK_INTERVAL_MS = 30 * 1000

let _cachedValue = null
let _cachedUpdatedAt = null
let _lastCheckAt = 0

let _configPool = null
function getConfigPool() {
  if (!_configPool) {
    _configPool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 2,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 3000,
    })
    _configPool.on('error', (err) => {
      console.error('[config] pool error:', err)
    })
  }
  return _configPool
}


async function getMemberThreshold() {
  const now = Date.now()

  if (_cachedValue !== null && (now - _lastCheckAt) < STALE_CHECK_INTERVAL_MS) {
    return _cachedValue
  }

  try {
    const result = await getConfigPool().query(
      "SELECT value, updated_at FROM system_configs WHERE key = 'new_member_threshold'"
    )
    const row = result.rows[0]
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

function invalidateCache() {
  _cachedValue = null
  _cachedUpdatedAt = null
  _lastCheckAt = 0
}

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
