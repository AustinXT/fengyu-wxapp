/**
 * 系统配置模块路由（客户端）
 * config.banners — 获取首页轮播图数量 + 版本号（无需认证）
 * config.fengyuguan — 获取凤御馆宣传图（无需认证）
 * config.shareGift — 获取分享礼展示规则（脱敏，无需认证）
 * config.serviceHotline — 获取客服热线电话号（无需认证）
 * config.invalidateConfig — 主动清空 utils/config 内存缓存（admin 保存配置时广播，副作用仅限清一次缓存）
 */

const pg = require('../db/pg')
const { invalidateCache } = require('../utils/config')
const { safeBannerThumbUrl, BANNER_THUMB_BOX } = require('../utils/image')

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
 * ⚠️ 三个与其它链路不同的地方：
 * 1. **对象键是三段** `fengyu-client/banner/banner{N}.jpg`，过不了 `safeThumbUrl` 的
 *    两段白名单，所以走 `safeBannerThumbUrl`（专属白名单，比默认更严）
 * 2. **必须带 `?v=`**：banner 是覆盖式上传（admin `reuploadToFixedPath` 到固定文件名），
 *    换图后 URL 不变，丢了版本号客户端会长期拿到旧图
 * 3. **host 取自 `banner_images`**（admin 写入时用的是它自己的 `CDN_BASE`），
 *    而不是云函数另配一份 —— 少一处需要跟环境同步的配置。
 *    host 仍过 COS 白名单校验，不在白名单就返回 null（fail-closed）
 *
 * `count`/`v` 保留：前端据此判断是否有 banner，且 v 仍是缓存版本的单一来源。
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

  ctx.result = { count, v, images: buildBannerUrls(imgRow && imgRow.value, count, v) }
}

/**
 * 由 `banner_images` 的第一条取出 origin，拼出固定路径的 banner URL 列表并施加缩略规则。
 *
 * `banner_images` 存的是 admin **上传原件**的随机名 URL
 * （`fengyu-client/banner/<ts>-<rand>.jpg`），而客户端要的是
 * `reuploadToFixedPath` 之后的固定名 `banner{N}.jpg` —— 两者同图不同键，
 * 所以这里只借它的 origin，路径按 count 重新生成。
 *
 * 任何一条拼不出合法 URL（host 不在白名单、版本号非法……）就整体返回 `[]`：
 * banner 是展示位，宁可不显示也不下发未经缩略的原图。
 */
function buildBannerUrls(rawImages, count, v) {
  if (!count || !rawImages) return []

  let origin
  try {
    const list = JSON.parse(rawImages)
    if (!Array.isArray(list) || list.length === 0) return []
    origin = new URL(list[0]).origin
  } catch {
    return []
  }

  const urls = []
  for (let i = 1; i <= count; i += 1) {
    const url = safeBannerThumbUrl(
      `${origin}/fengyu-client/banner/banner${i}.jpg`,
      BANNER_THUMB_BOX,
      v
    )
    // 有一条不合规就整体放弃，避免前端拿到"缺了中间几张"的残缺轮播
    if (!url) return []
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
