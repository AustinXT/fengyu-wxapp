/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图（已缩略的完整 URL 列表 + 版本号，无需认证）
 * config.fengyuguan — 获取凤御馆宣传图（无需认证）
 * config.shareGift — 获取分享礼展示规则（脱敏，无需认证）
 * config.serviceHotline — 获取客服热线电话号（无需认证）
 * config.invalidateConfig — 主动清空 utils/config 内存缓存（admin 保存配置时广播，副作用仅限清一次缓存）
 */

const pg = require('../db/pg')
const { invalidateCache } = require('../utils/config')
const { safeBannerThumbUrl, bannerSourceUrl } = require('../utils/image-banner')

/**
 * 获取首页轮播图。
 *
 * 返回 `{ count, v, images }`，其中 `images` 是**已施加缩略规则的完整 URL 列表**（issue #231）。
 *
 * 为什么把 URL 构造收回服务端：原先只下发 count/v、由客户端拼
 * `${CDN_BASE}/banner/banner{N}.jpg?v=${v}`，导致 banner 是全站唯一绕开
 * `safeThumbUrl` 防护的图片链路 —— 生产那张 3002×1039 的 banner 原图直发，解码 11.9MB，
 * 而首页是流量最高的页面、swiper 还会预渲染相邻帧。
 * 收回服务端后，后续调整尺寸不需要小程序发版（审核周期长）。
 *
 * banner 链路有三点与其它图片不同（对象键三段 / 覆盖式上传必须带 `?v=` /
 * host 写死不从 `banner_images` 取），三条的完整论证见 `utils/image-banner.js`。
 *
 * ⚠️ **`count`/`v` 必须保留，不要因为"新版前端不读了"就删**：
 * 小程序是**存量客户端**——用户设备上跑的旧版 `home.ts` 仍在读这两个字段自行拼 URL。
 * 删掉 = 所有还没更新的小程序首页轮播直接空白（比"图略大"严重得多的回归）。
 * 等灰度覆盖后再议。
 *
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
  const imgRow = rows.find((r) => r.key === 'banner_images')
  if (cntRow) {
    count = parseInt(cntRow.value, 10) || 0
    v = Math.floor(Number(cntRow.v)) || 0
  } else if (imgRow) {
    // 兜底：无 banner_count 时按 banner_images 数组长度
    try { count = JSON.parse(imgRow.value).length } catch { /* empty */ }
    v = Math.floor(Number(imgRow.v)) || 0
  }

  ctx.result = { count, v, images: buildBannerUrls(count, v) }
}

/**
 * banner 张数上限。
 *
 * `count` 驱动下面的循环，而它来自 `system_configs.banner_count`（裸 text，
 * admin 侧 `saveSettings` 无长度校验、UI 的 `max={0}` 也不限张数）。
 * 不 clamp 的话 `banner_count='999999'` 会让这个**公开未认证接口**
 * 生成 99 万条 URL —— 实测响应体 150MB，云函数直接 OOM，首页轮播接口全站不可用。
 *
 * 改动前 `count` 只是原样回显（代价 O(1)），是本 PR 让它变成了循环上界。
 * 与 `PRODUCT_DETAIL_IMAGE_MAX_COUNT` 同一思路：**下发侧必须自己截断，不能信上游**。
 * 20 远超运营实际用量（生产现为 1）。
 */
const MAX_BANNER_COUNT = 20

/**
 * 按 `count` 拼出固定名 `banner{N}.jpg` 的缩略 URL 列表。
 * 路径与 host 的口径见 `utils/image-banner.js`。
 */
function buildBannerUrls(count, v) {
  const n = Math.min(Math.max(count, 0), MAX_BANNER_COUNT)
  const urls = []
  for (let i = 1; i <= n; i += 1) {
    const url = safeBannerThumbUrl(bannerSourceUrl(i), v)
    if (!url) {
      // 整体放弃而非跳过：宁可轮播整块不显示，也不给残缺序列。
      // 前端对空数组不进 catch，没这行日志两端都不留痕。
      console.warn('[config.banners] fail-closed: 无法生成合法 banner URL', { count, v, i })
      return []
    }
    urls.push(url)
  }
  return urls
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
 * 获取客服热线电话号 + 缓存版本号（无需认证）。
 *
 * 读 system_configs.service_hotline（admin 系统配置「基础配置」Tab 写入，value 为纯文本号码）。
 * 返回 { phone, v }：phone 为号码字符串（无配置时为空串，由客户端展示占位「-」并禁用拨号）；
 * v 取 updated_at 毫秒戳，供客户端做缓存版本（与 banners/fengyuguan 同款）。
 * 无需认证，公开接口。
 */
async function serviceHotline(ctx) {
  const rows = await pg.query(
    `SELECT value, EXTRACT(EPOCH FROM updated_at) * 1000 AS v
     FROM system_configs WHERE key = 'service_hotline'`
  )
  ctx.result = {
    phone: rows.length > 0 ? (rows[0].value || '') : '',
    v: rows.length > 0 ? (Math.floor(Number(rows[0].v)) || 0) : 0,
  }
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

module.exports = { banners, fengyuguan, shareGift, consumeAgreement, serviceHotline, invalidateConfig }
