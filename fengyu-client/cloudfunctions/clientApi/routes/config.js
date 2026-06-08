/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图数量 + 版本号（无需认证）
 * config.fengyuguan — 获取凤御馆宣传图（无需认证）
 * config.shareGift — 获取分享礼展示规则（脱敏，无需认证）
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
 * 获取凤御馆宣传图 URL + 缓存版本号。
 *
 * 返回 { url, v }：v 取自 system_configs.fengyuguan_image 的 updated_at（admin saveSettings 每次写入），
 * 客户端用 v 给自己 env-aware CDN_BASE 拼出的固定路径长图做防缓存（换图后强制刷新），
 * 不直接用 url（url 指向 admin 上传时所在桶，未必是本环境桶）。
 * 无需认证，公开接口。
 */
async function fengyuguan(ctx) {
  const rows = await pg.query(
    `SELECT value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v
     FROM system_configs WHERE key = 'fengyuguan_image'`
  )
  ctx.result = {
    url: rows.length > 0 ? (rows[0].value || '') : '',
    v: rows.length > 0 ? (Math.floor(Number(rows[0].v)) || 0) : 0,
  }
}

/**
 * 获取分享礼展示规则（脱敏，无需认证）。
 *
 * 读 system_configs.share_gift_config，仅返回顾客端展示所需字段：
 *   { enabled, percent, minFaceValue, maxFaceValue, validityDays }
 * 运营内部字段（couponTemplateId / inviterMustHavePaidOrder / 各类消息文案）一律不暴露。
 * 无配置、解析失败或显式关闭时返回 { enabled: false }，前端据此展示「活动暂未开启」。
 */
async function shareGift(ctx) {
  const disabled = { enabled: false }
  const rows = await pg.query(
    "SELECT value FROM system_configs WHERE key = 'share_gift_config'"
  )
  if (rows.length === 0 || !rows[0].value) {
    ctx.result = disabled
    return
  }
  let cfg
  try {
    cfg = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
  } catch (e) {
    ctx.result = disabled
    return
  }
  if (!cfg || !cfg.enabled) {
    ctx.result = disabled
    return
  }
  ctx.result = {
    enabled: true,
    percent: Number(cfg.percent) > 0 ? Number(cfg.percent) : 0.15,
    minFaceValue: Number(cfg.minFaceValue) > 0 ? Number(cfg.minFaceValue) : 1,
    maxFaceValue: Number(cfg.maxFaceValue) > 0 ? Number(cfg.maxFaceValue) : 500,
    validityDays: Number(cfg.validityDays) > 0 ? Number(cfg.validityDays) : 90,
  }
}

/**
 * 获取消费协议（标题 + 正文 + 缓存版本号，无需认证）。
 *
 * 读 system_configs.consume_agreement（admin 系统配置「消费协议」Tab 写入，
 * value 为 JSON 字符串 {title, content}）。返回 { title, content, v }：
 *   - v 取 updated_at 毫秒戳，供客户端做缓存版本（与 banners 同款）
 *   - 无配置 / JSON 损坏 / 显式空内容 → 返回 { title:'服务消费协议', content:'', v:0 }；
 *     content 为空时由客户端用内置兜底文案展示，绝不阻塞下单。
 * 无需认证，公开接口（与 shareGift 一致：协议预览不要求登录态）。
 */
async function consumeAgreement(ctx) {
  const fallback = { title: '服务消费协议', content: '', v: 0 }
  const rows = await pg.query(
    "SELECT value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM system_configs WHERE key = 'consume_agreement'"
  )
  if (rows.length === 0 || !rows[0].value) {
    ctx.result = fallback
    return
  }
  let cfg
  try {
    cfg = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
  } catch (e) {
    ctx.result = fallback
    return
  }
  if (!cfg || typeof cfg !== 'object') {
    ctx.result = fallback
    return
  }
  const title = typeof cfg.title === 'string' && cfg.title.trim() ? cfg.title.trim() : '服务消费协议'
  const content = typeof cfg.content === 'string' ? cfg.content : ''
  ctx.result = { title, content, v: Math.floor(Number(rows[0].v)) || 0 }
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

module.exports = { banners, fengyuguan, shareGift, consumeAgreement, invalidateConfig }
