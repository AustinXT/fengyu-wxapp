
function extractAppVersion(payload) {
  if (!payload || typeof payload !== 'object') return null
  const v = payload._appVersion
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed || null
}

module.exports = { extractAppVersion }
