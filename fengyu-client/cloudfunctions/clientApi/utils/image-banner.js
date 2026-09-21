/**
 * 首页 banner 的缩略 URL 构造（issue #231）—— **clientApi 端专属**
 *
 * 刻意不放进 `utils/image.js`：那份文件在 issue #232 之后与 staffApi 侧
 * 保持**字节一致**（由 `staffApi/__tests__/utils/image-cross-copy.test.js` 守护），
 * 往里塞 client 独有的链路会让 staff 副本背上一堆用不到的代码，也让那个文件
 * 随着每条新链路无限长胖。端专属逻辑一律独立成 `image-*.js` 兄弟模块，
 * 只从 `image.js` 复用**共享的准入校验**。
 *
 * banner 与其它图片链路的三点结构性不同：
 * 1. 对象键是**三段** `fengyu-client/banner/banner{N}.jpg`（前端 CDN_BASE 自带前缀）
 * 2. 文件名**固定**、覆盖式上传 → 换图后 URL 不变，必须靠 `?v=` 破缓存
 * 3. host 不能信 DB，只能用写死的桶地址（见 `COS_BASE`）
 */

const { parseProcessableUrl, isProcessableHost } = require('./image')

/**
 * CloudBase COS 下载域名 —— 写死实测值，不从任何外部数据推导。
 *
 * 与前端 `miniprogram/utils/cloud-env.ts` 的 `COS_BASE` 同值（桶前缀是建桶时分配的，
 * 无法从 envId 推算）。两端漂移由 `miniprogram/__tests__/utils/cart.test.ts` 守护
 * ——那个测试已经用 `createRequire` 加载云函数模块跑真实实现。
 *
 * ⚠️ **不从 `system_configs.banner_images` 取 origin**：那是 admin **上传当时**所在桶，
 * 而图片实际被 `reuploadToFixedPath` 重传到 admin **当前**桶；两者同为 `.tcb.qcloud.la`
 * 后缀、host 白名单拦不住，表现为首页整屏 404 且服务端无感知。
 * 该字段还是 admin 可写且无校验的，拿它当 host 来源等于让持 `system:config`
 * 的账号把全量顾客的首页图源指到任意同后缀的桶。
 */
const COS_BASE = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

/** banner 在桶里的目录。与下面的白名单单源，改目录只改这一处 */
const BANNER_KEY_DIR = '/fengyu-client/banner'

/**
 * banner 的对象键白名单 —— **比 `image.js` 的默认两段键更严格**：
 * 目录写死、文件名锚定 `banner<数字>`，连 admin 上传的随机名原件都不认。
 *
 * 刻意不把默认白名单放宽成「2~3 段」来容纳三段键：那条白名单是 #230 五轮 +
 * #232 两轮评审钉死的、且有多份副本，放宽会扩大
 * 「样式分隔符配成 `/` 时与正常键不可区分」这个已知限制的暴露面。
 *
 * ⚠️ 排除 `gif` 对 banner 是**无效防护**：admin 重传时目标路径的扩展名是字面量 `.jpg`
 * （`settings.ts` 的模板串，与源文件 MIME 无关），GIF 字节会存进 `banner1.jpg` 并被放行。
 * 真要挡动图得在 admin 上传侧按 path 分流拒掉 `image/gif`。
 *
 * ⚠️ 下一条要接的三段键链路是**头像**（issue #233）。在决定照抄这个模式之前先看一眼
 * 根因：三段键唯一的来源是 admin `settings.ts` 的一个字面量，而同文件里凤御馆用的是
 * **两段键**（`images/fengyuguan.jpg`）——即 banner 是项目里唯一的三段键。
 * 头像是新链路、无存量迁移负担，**从一开始就用两段键**比再加一条白名单更根本。
 */
const BANNER_OBJECT_KEY_PATTERN =
  /^\/fengyu-client\/banner\/banner\d+\.(png|jpe?g|webp)$/i

/**
 * banner 档位：满屏轮播，`.banner-swiper { height: 260rpx }` + aspectFill。
 * 展示位宽约 686rpx（750 − 32×2），3x 屏物理约 1180×447。
 *
 * 生产 banner 实测 3002×1039（2.89:1 宽图）→ box 1080 输出 1080×374、
 * 解码 1.5MB（原图 11.9MB），aspectFill 放大约 1.19 倍。
 * 与 `STORE_DETAIL_THUMB_BOX` / `PRODUCT_THUMB_BOX_LARGE` 同取 1080，不另立档位。
 */
const BANNER_THUMB_BOX = 1080

/**
 * 生成 banner 的缩略 URL。
 *
 * 档位不作为参数 —— banner 只有一个展示位，传参只会引出「上界该是多少」这类
 * 本不存在的问题。需要调尺寸就改 {@link BANNER_THUMB_BOX}。
 *
 * **在规则后追加 `&v=<version>`**：banner 是覆盖式上传，换图后 URL 不变，
 * 丢了版本号客户端会长期拿到旧图。已对生产图实测
 * `?imageMogr2/thumbnail/1080x1080&v=175…` 与反序**都正常缩略**（输出 1080×374），
 * 规则与版本号可以共存。
 *
 * 追加 `&v=` 不违背「query 整串由服务端掌控」这条核心约定：丢弃的是**外部传入**的
 * query，追加的是服务端自己算出来的版本号，最终 query 仍完全由服务端决定。
 *
 * **入参是序号而不是 URL**（评审指出）：banner 的 URL 完全由服务端构造，
 * 没有理由接受外部传入的 URL —— 收窄入参就等于取消了「调用方传个宽泛 URL 进来」
 * 这条路。白名单校验仍然保留，作为纵深防御：万一 `BANNER_KEY_DIR` 或
 * `bannerSourceUrl` 被改坏，拼出的 URL 过不了自己的白名单，走 fail-closed 而不是下发脏值。
 *
 * @param {number} index banner 序号，从 1 起
 * @param {number} version 缓存版本号（`system_configs.banner_count` 的 updated_at 毫秒）
 * @returns {string|null} 处理后的 URL；无法保证缩略时返回 null
 */
function safeBannerThumbUrl(index, version) {
  if (!Number.isInteger(index) || index < 1) return null
  // 版本号必须是非负整数。给不出版本号时**不降级下发**：
  // 没有 `?v=` 的 banner URL 会被 CDN 长期缓存，换图不生效 ——
  // 那是比「图略大」更难排查的故障，宁可走占位。
  if (!Number.isInteger(version) || version < 0) return null

  const parsed = parseProcessableUrl(bannerSourceUrl(index), BANNER_OBJECT_KEY_PATTERN)
  if (!parsed) return null

  parsed.search = `?imageMogr2/thumbnail/${BANNER_THUMB_BOX}x${BANNER_THUMB_BOX}&v=${version}`
  return parsed.toString()
}

/** 第 N 张 banner 的完整源 URL（未施加缩略规则） */
function bannerSourceUrl(index) {
  return `${COS_BASE}${BANNER_KEY_DIR}/banner${index}.jpg`
}

module.exports = {
  safeBannerThumbUrl,
  bannerSourceUrl,
  isProcessableHost,
  COS_BASE,
  BANNER_KEY_DIR,
  BANNER_THUMB_BOX,
  BANNER_OBJECT_KEY_PATTERN,
}
