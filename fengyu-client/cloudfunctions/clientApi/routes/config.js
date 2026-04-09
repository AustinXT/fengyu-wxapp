/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图列表（无需认证）
 * config.fengyuguan — 获取凤御馆宣传图（无需认证）
 * config.invalidateConfig — 主动清空 utils/config 内存缓存（admin 保存配置时广播，副作用仅限清一次缓存）
 */

const pg = require('../db/pg')
const { invalidateCache } = require('../utils/config')

/**
 * 获取首页轮播图 URL 列表
 * 无需认证，公开接口
 */
async function banners(ctx) {
  const rows = await pg.query(
    "SELECT value FROM system_configs WHERE key = 'banner_images'"
  )
  let urls = []
  if (rows.length > 0) {
    try { urls = JSON.parse(rows[0].value) } catch { /* empty */ }
  }
  ctx.result = { banners: urls }
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
