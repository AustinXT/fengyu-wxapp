/**
 * 小程序前端版本号提取（前端 utils/cloud.ts 自动在 payload 附加 `_appVersion`）。
 *
 * 背景：上线版与测试版共用同一 CloudBase 环境，云函数 `tcb fn code update` 部署即生效，
 * 但小程序新版本上线有审批延迟，新旧前端长期并存。云函数据此 ctx.appVersion 可做
 * 向后兼容分流（如 `semver(appVersion) >= 'x' ? 新逻辑 : 旧逻辑`）。
 *
 * 本函数仅建立"版本传递管道"，不做任何分流；分流逻辑后续按需在各 route 内基于
 * ctx.appVersion 实现。
 *
 * @param {*} payload 请求 payload
 * @returns {string|null} 规范化版本串（去首尾空白），缺失/非字符串/空串返回 null
 */
function extractAppVersion(payload) {
  if (!payload || typeof payload !== 'object') return null
  const v = payload._appVersion
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed || null
}

module.exports = { extractAppVersion }
