/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图列表（无需认证）
 */

const pg = require('../db/pg')

/**
 * 获取首页轮播图 URL 列表
 * 无需认证，公开接口
 */
async function banners(ctx) {
  const { rows } = await pg.query(
    "SELECT value FROM system_configs WHERE key = 'banner_images'"
  )
  let urls = []
  if (rows.length > 0) {
    try { urls = JSON.parse(rows[0].value) } catch { /* empty */ }
  }
  ctx.result = { banners: urls }
}

module.exports = { banners }
