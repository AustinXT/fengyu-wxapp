/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图数量 + 版本号（无需认证）
 * config.fengyuguan — 获取凤御馆宣传图（无需认证）
 * config.invalidateConfig — 主动清空 utils/config 内存缓存（admin 保存配置时广播，副作用仅限清一次缓存）
 */

const pg = require('../db/pg')
const { invalidateCache } = require('../utils/config')

/**
 * 获取首页轮播图数量 + 缓存版本号。
 *
 * 返回 { count, v } 而非 URL 列表：客户端用自己的 env-aware CDN_BASE 拼固定路径
 * `${CDN_BASE}/banner/banner{N}.jpg?v=${v}`（<image> 加载，不受 wx.request 域名白名单限制）。
 * count/v 取自 system_configs.banner_count（admin saveSettings 每次保存写入，updated_at=NOW()），
 * 用 updated_at 当缓存版本号；无 banner_count 时按 banner_images 数组长度兜底。
 * 无需认证，公开接口。
 */
async function banners(ctx) {
  const rows = await pg.query(
    `SELECT key, value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v
     FROM system_configs WHERE key IN ('banner_count', 'banner_images')`
  )
  let count = 0
  let v = 0
  const cntRow = rows.find((r) => r.key === 'banner_count')
  if (cntRow) {
    count = parseInt(cntRow.value, 10) || 0
    v = Math.floor(Number(cntRow.v)) || 0
  } else {
    // 兜底：无 banner_count 时按 banner_images 数组长度
    const imgRow = rows.find((r) => r.key === 'banner_images')
    if (imgRow) {
      try { count = JSON.parse(imgRow.value).length } catch { /* empty */ }
      v = Math.floor(Number(imgRow.v)) || 0
    }
  }
  ctx.result = { count, v }
}

/**
 * 获取凤御馆宣传图 URL
 * 无需认证，公开接口
 */
async function fengyuguan(ctx) {
  const rows = await pg.query(
    "SELECT value FROM system_configs WHERE key = 'fengyuguan_image'"
  )
  ctx.result = { url: rows.length > 0 ? (rows[0].value || '') : '' }
}

/**
 * 主动清空 utils/config 的内存缓存。
 *
 * 调用者：admin saveSettings 在 newMemberThreshold 变化时广播。
 * 授信前提：通过 CloudBase node-sdk（持有项目 SecretId/Key）调用；被恶意调用的副作用仅限
 * 清一次进程内内存，不涉及数据写入。
 */
async function invalidateConfig(ctx) {
  invalidateCache()
  ctx.result = { success: true }
}

module.exports = { banners, fengyuguan, invalidateConfig }
