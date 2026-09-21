/**
 * 图片 URL 缩略处理（CloudBase COS 数据万象）
 *
 * 背景（issue #213）：admin 上传封面图不做任何压缩，生产库里存在 12576×12575 的门店封面 PNG。
 * 该文件体积仅 405KB（调色板 + 高压缩率），能轻松通过上传侧的 file.size 校验，
 * 但小程序 <image> 渲染时按像素解码，单张约 12576×12575×4 ≈ 603MB，
 * 直接把小程序进程撑爆，微信杀进程并提示「小程序意外退出，请稍后重试」。
 *
 * 关键认知：解码内存只跟分辨率有关，与文件体积无关——所以「限制上传体积」防不住这类图，
 * 必须在 URL 上限制输出分辨率。
 *
 * 用 imageMogr2 拼缩略参数的好处是对存量图立即生效（无需重新上传、无需小程序发版）。
 */

/**
 * 只认 CloudBase 云存储的 CDN 域名（本项目 stores.cover_image 全部是这个后缀，已核对 41/41）。
 *
 * 刻意**不**放通另外两类看起来相关的域名：
 * - `*.tcloudbaseapp.com` 是 CloudBase **静态网站托管**，不执行数据万象，
 *   拼上参数也会原样返回原图 —— 那等于保护静默失效
 * - `*.myqcloud.com` 是通用 COS 域名，任何腾讯云用户都能建桶，
 *   无法保证对方开通了数据万象
 *
 * 已知限制：同后缀的其它 CloudBase 环境也会匹配。更严格的做法是按本项目实际 bucket
 * 做精确 hostname 白名单，但那需要引入环境变量配置，留待后续。
 */
const COS_HOST_PATTERN = /\.tcb\.qcloud\.la$/i

/**
 * CloudBase COS 下载域名 —— **写死实测值，不从任何外部数据推导**。
 *
 * 与前端 `miniprogram/utils/cloud-env.ts` 的 `COS_BASE` 同值、同理由：
 * 桶前缀是建桶时分配的，不能从 envId 推算。
 *
 * ⚠️ 为什么不从 `system_configs.banner_images` 取 origin（issue #231 评审指出）：
 * 那个值是 admin **上传当时**所在桶的 URL，而图片实际被 `reuploadToFixedPath`
 * 重传到 admin **当前** `CDN_BASE` 桶 —— 两者在环境切换后会不一致，
 * 而且都是 `.tcb.qcloud.la` 后缀，host 白名单**拦不住**，
 * 表现为首页整屏 404 破图且服务端毫无感知。
 * 同一个 `routes/config.js` 里 `fengyuguan` 的注释早就写明了这一点
 * （「不直接用 url，url 指向 admin 上传时所在桶，未必是本环境桶」）——
 * banner 一度走反了方向。
 *
 * 顺带消掉另一条：`banner_images` 是 admin 可写且无校验的字段，
 * 拿它当 host 来源等于让持 `system:config` 权限的账号能把**全量顾客的首页图源**
 * 指到任意同后缀的桶。
 */
const COS_BASE = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

/**
 * 档位参数上界。box 是 contain 语义、**不放大**，取得过大等于完全不约束 ——
 * 「规则看着在、实际不生效」的又一种形态（`thumbnail/1e+21x1e+21` COS 直接原样返回原图）。
 *
 * ⚠️ 本 PR 只给新增的 `safeBannerThumbUrl` 用。给 `safeThumbUrl` /
 * `safeThumbUrlByArea` 补同样的上界是 issue #232（PR #275）的范围，
 * 那边取的也是 2000（与前端净化器 `cart.ts` 的 `SANITIZE_MAX_EDGE` 对齐）——
 * 两个 PR 取同一个值，merge 时不会留下两套口径。
 */
const MAX_THUMB_BOX = 2000

/**
 * 对象键白名单（默认）：两段、纯 ASCII、以图片扩展名结尾。
 * admin `path=` 模式上传生成的键形如 `store-covers/1789097186265-apa9p0.png`。
 * 详细理由见 parseProcessableUrl 里的注释。
 */
const OBJECT_KEY_PATTERN = /^\/[\w-]+\/[\w.-]+\.(png|jpe?g|webp|gif)$/i

/**
 * 首页 banner 的对象键白名单（issue #231）—— **比默认的两段键更严格**。
 *
 * banner 与其它图片链路有两处结构性不同：
 * 1. 键是**三段** `fengyu-client/banner/banner{N}.jpg`，过不了默认的两段白名单
 * 2. 文件名**固定**、覆盖式上传（admin `settings.ts` 的 `reuploadToFixedPath`），
 *    所以换图后 URL 不变，必须靠 `?v=` 破缓存
 *
 * 刻意**不**把默认白名单放宽成「2~3 段」来容纳它 —— 那条白名单是 #230 五轮 +
 * #232 两轮评审钉死的，且有多份副本；放宽会扩大
 * 「样式分隔符配成 `/` 时与正常键不可区分」这个已知限制的暴露面。
 *
 * ⚠️ 下一个要接入的三段键链路是**头像**（`avatars/staff/<id>/…`、`avatars/<openid>/…`，
 * 见 issue #233）。照此新建专属白名单，**不要**放宽默认的那条。
 *
 * ⚠️ 这里排除 `gif` 对 banner 是**无效防护**：admin 重传时目标路径的扩展名是
 * 字面量 `.jpg`（`settings.ts` 的模板串），GIF 字节也会存进 `banner1.jpg`。
 * 真要挡动图得在 admin 上传侧按 path 分流拒掉 `image/gif`。
 */
const BANNER_OBJECT_KEY_PATTERN =
  /^\/fengyu-client\/banner\/banner\d+\.(png|jpe?g|webp)$/i

/**
 * 对象键白名单的**命名变体表**。
 *
 * `parseProcessableUrl` 只接受这里的键名，不接受裸正则（issue #231 评审指出）：
 * - 传裸正则等于给调用方开了一个放宽整条防线的口子（`/^\/.*$/` 就能全放行），
 *   而「参数只用来换一条同样是白名单的正则」这种约定代码层约束不了
 * - 裸正则还可能带 `g` 标志，`.test()` 对带 `g` 的正则是**有状态**的
 *   （`lastIndex` 让它隔次返回 false），表现成「偶数张 banner 随机消失」这类极难排查的故障
 */
const OBJECT_KEY_VARIANTS = {
  default: OBJECT_KEY_PATTERN,
  banner: BANNER_OBJECT_KEY_PATTERN,
}

/**
 * 判断 hostname 是否属于可做数据万象处理的域名。
 * 先去掉 FQDN 尾点（`a.tcb.qcloud.la.` 与 `a.tcb.qcloud.la` DNS 等价，
 * 不归一会漏匹配从而退回下发原图）。
 */
function isProcessableHost(hostname) {
  return COS_HOST_PATTERN.test(String(hostname).replace(/\.$/, ''))
}

/**
 * 判断 URL 是否带 COS 签名（私有读 / 临时密钥）。
 *
 * 带签名的 URL 一律放弃处理（返回 null），不尝试「保留签名参数 + 追加缩略规则」：
 * - 哪些参数被签进签名由 `q-url-param-list` 声明，而它写在 URL 上无从验真。
 *   曾经据此做动态保留，结果被构造
 *   `?imageView2%2F1%2Fw%2F50000&q-url-param-list=imageView2%2F1%2Fw%2F50000`
 *   让一条放大规则「自声明」成已签名参数而存活。
 * - 腾讯云要求把已签名的处理参数做**双重编码**写进 `q-url-param-list`，
 *   还可能带 `versionId` 等其它签名参数；少保留一个签名就废，多保留一个就是放大通道。
 * - 签名 URL 本身有时效，下发给小程序也不合适。
 *
 * 无法在不重签名的前提下安全追加处理规则，就不该返回一个注定 403 的 URL —— 直接 null。
 * 当前生产 stores.cover_image 全部是公共读 URL（已核对 41/41），不受影响。
 */
function hasCosSignature(rawParams) {
  return rawParams.some((p) => {
    const name = decodeParamName(p)
    return name.startsWith('q-') || name === 'x-cos-security-token'
  })
}

/** 取参数名并归一（解码 + 小写），解码失败时退回原串 */
function decodeParamName(param) {
  const eq = param.indexOf('=')
  const rawName = eq === -1 ? param : param.slice(0, eq)
  try {
    return decodeURIComponent(rawName).toLowerCase()
  } catch {
    // 非法百分号编码：退回原串。方向安全——它不会被当成签名参数，URL 走正常清洗
    return rawName.toLowerCase()
  }
}

/**
 * 校验 URL 是否可安全施加数据万象处理规则，通过则返回已清洗 query 的 URL 对象。
 *
 * **无法保证处理的一律返回 null，而不是退回原图** —— 这是本模块的核心安全约定。
 * 退回原图意味着「保护静默失效」：调用方看不出区别，而那张图可能正是会撑爆进程的巨图。
 *
 * 被 safeThumbUrl（box 模式）与 safeThumbUrlByArea（面积模式）共用，
 * 保证两种模式的准入规则**逐字一致**——校验放两份必然漂移。
 *
 * @param {string} url 原始图片 URL
 * @returns {URL|null} 通过校验的 URL 对象（query 尚未写入规则）；不通过返回 null
 */
function parseProcessableUrl(url, keyVariant = 'default') {
  const objectKeyPattern = OBJECT_KEY_VARIANTS[keyVariant]
  // 未知变体名一律拒绝，而不是回退到默认 —— 回退会让拼错的变体名静默降级成另一条规则
  if (!objectKeyPattern) return null

  if (typeof url !== 'string' || url.trim() === '') return null

  // 只处理 http(s)。cloud:// 这类 fileID 需由调用侧先换成 https 再进来，
  // 否则无从施加缩略规则，按约定返回 null 而不是把原始地址下发出去。
  if (!/^https?:\/\//i.test(url)) return null

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  // 用 hostname 判断而不是对整串做正则：否则 https://a.tcb.qcloud.la@evil.com/
  // 这类把可信域名塞进 userinfo 的 URL 会被误判为可信
  if (!isProcessableHost(parsed.hostname)) return null

  // 图片样式可以直接挂在对象路径后，样式本身能携带完整的缩放规则；
  // 光清洗 query 挡不住它，而两种处理机制并存时的优先级 COS 并未定义。
  //
  // 这里用「本项目对象键格式」的白名单，而不是逐个排除分隔符：
  // COS 的样式分隔符可配置成 `!` `_` `/` `-` 四种，逐个排除既挡不全，
  // 也挡不住 `%21` / `%2F` 这类编码形态（URL.pathname 不会替你解码）。
  // admin 上传生成的键形如 `store-covers/1789097186265-apa9p0.png`（两段、纯 ASCII、无编码）。
  //
  // 末尾锚定图片扩展名：样式名通常不带扩展名，所以这一条顺带挡掉了
  // `a.png-oversize` / `a.png_oversize` 这类用 `-`/`_` 作分隔符的形态，
  // 同时排除 SVG/PDF 等不该走图片管线的对象。
  //
  // ⚠️ 剩余已知限制：若 bucket 把分隔符配成 `-` / `_` / `/`，且样式名本身以图片扩展名结尾
  // （`/` 的情形是 `store-covers` 为对象键、`oversize.png` 为样式名），
  // 代码层与正常两段键不可区分。本项目 bucket 须保持默认分隔符 `!`、
  // 且不得配置含缩放规则的样式。
  //
  // 走 OBJECT_KEY_VARIANTS 里的命名变体（issue #231 的 banner 是三段固定键）。
  // 不接受裸正则，理由见该常量的注释。默认变体就是上面描述的两段键规则。
  if (!objectKeyPattern.test(parsed.pathname)) {
    return null
  }

  const rawParams = parsed.search.replace(/^\?/, '').split('&').filter(Boolean)

  // 带签名的 URL 无法在不重签名的前提下安全改造，放弃处理
  if (hasCosSignature(rawParams)) return null

  return parsed
}

/**
 * 生成可安全下发给小程序的缩略图 URL（**box 模式**：双边边长约束）。
 *
 * 缩略规则用**双边** box（`thumbnail/NxN`，数据万象的 contain 语义：等比缩放到宽高都不超过 N），
 * 而不是只限宽的 `thumbnail/Nx`。只限宽挡不住细长图：
 * 一张 1080×20000 的长截图（21.6MP，能过 40MP 上限、文件也不大）在 `1080x` 规则下
 * 宽度已达标、高度完全不受约束，解码仍是 1080×20000×4 ≈ 86MB。
 * 用双边 box 后，解码内存被硬封顶为 N×N×4。
 *
 * ⚠️ **只适用于长宽比接近 1 的常规图**（封面、头像、方卡）。
 * 对长图用 box 会毁掉观感：contain 语义下 1389×5547 的详情长图会被压成 270×1080，
 * 前端 `mode="widthFix"` 再拉回满屏等于放大 4.8 倍，文字糊成一片。
 * 长图请改用 {@link safeThumbUrlByArea}。
 *
 * @param {string} url 原始图片 URL
 * @param {number} boxSize 目标 box 边长（像素），等比缩放到宽高均不超过它
 * @returns {string|null} 处理后的 URL；无法保证缩略时返回 null
 */
function safeThumbUrl(url, boxSize) {
  if (!Number.isInteger(boxSize) || boxSize <= 0) return null

  const parsed = parseProcessableUrl(url)
  if (!parsed) return null

  // 丢弃原 URL 上的**全部** query，只留服务端自己的规则。
  //
  // 必须是「全部丢弃」而不是「剥掉 imageMogr2」的黑名单：COS 还有与 imageMogr2 平级的
  // imageView2（mode 1 可把图放大到指定尺寸）、ci-process 等，黑名单漏掉任何一个
  // 都等于留了个放大通道。最终生效的规则必须由服务端完全掌控。
  //
  // 经 URL 对象重建而非裸字符串拼接：字符串拼接遇到 #fragment 会把参数拼进 fragment 里
  // （对 COS 不生效），遇到末尾裸 ? 会拼出 ??
  parsed.search = `?imageMogr2/thumbnail/${boxSize}x${boxSize}`
  return parsed.toString()
}

/**
 * 生成可安全下发给小程序的缩略图 URL（**面积模式**：总像素数约束）。
 *
 * 用 `thumbnail/<Area>@` —— 数据万象按「缩放到总像素数不超过 Area」等比压缩。
 *
 * **为什么长图必须用这个而不是 box**：我们真正要封顶的是**解码内存**，
 * 而解码内存 = 总像素数 × 4 字节。面积模式**直接**约束这个量，box 只是间接地
 * 通过边长约束它——对长宽比接近 1 的图两者等价，对长图 box 会过度惩罚。
 *
 * 实测（生产详情图 1737×7065，原图解码 46.8MB）：
 * - `thumbnail/1080x1080` → 266×1080，解码 1.1MB，但在 1290px 屏上放大 4.8 倍 ❌
 * - `thumbnail/2250000@`  → 743×3025，解码 8.6MB，放大 1.7 倍 ✅
 *
 * 面积模式对细长图同样安全：100×1,000,000（1 亿像素）在 2250000@ 下会被压到
 * 约 15×150000，总像素仍是 2.25M → 解码恒为 Area×4，**与长宽比无关**。
 * 这是它比「只限宽 `thumbnail/Nx`」安全的地方——后者高度完全不受约束。
 *
 * ⚠️ 必须是不带 `!` 的 `<Area>@`。实测 `thumbnail/!<Area>@` 在本项目 bucket 上
 * **原样返回原图**（规则不生效），写成那样等于保护静默失效。
 *
 * @param {string} url 原始图片 URL
 * @param {number} maxPixels 输出图的总像素数上限，解码内存被封顶为 maxPixels×4 字节
 * @returns {string|null} 处理后的 URL；无法保证缩略时返回 null
 */
function safeThumbUrlByArea(url, maxPixels) {
  if (!Number.isInteger(maxPixels) || maxPixels <= 0) return null

  const parsed = parseProcessableUrl(url)
  if (!parsed) return null

  parsed.search = `?imageMogr2/thumbnail/${maxPixels}@`
  return parsed.toString()
}

/**
 * 首页 banner 专用的缩略 URL（issue #231）。
 *
 * 与 {@link safeThumbUrl} 的两点不同，都源于 banner 链路的结构性差异：
 *
 * 1. **对象键走 {@link BANNER_OBJECT_KEY_PATTERN}**（三段固定键，比默认白名单更严）
 * 2. **在规则后追加 `&v=<version>`** —— banner 是覆盖式上传，换图后 URL 不变，
 *    丢了版本号客户端会长期拿到旧图。
 *    已对生产图实测：`?imageMogr2/thumbnail/1080x1080&v=175…` 与
 *    `?v=175…&imageMogr2/thumbnail/1080x1080` **两种顺序都正常缩略**（1080×374），
 *    规则与版本号可以共存。
 *
 * 追加 `&v=` 不违背「query 整串由服务端掌控」这条核心约定 —— 丢弃的是**外部传入**的
 * query，追加的是服务端自己算出来的版本号，最终 query 仍然完全由服务端决定。
 *
 * @param {string} url 原始 banner URL（host 仍走 COS 白名单校验）
 * @param {number} boxSize 目标 box 边长
 * @param {number} version 缓存版本号（system_configs.banner_count 的 updated_at 毫秒）
 * @returns {string|null} 处理后的 URL；无法保证缩略时返回 null
 */
function safeBannerThumbUrl(url, boxSize, version) {
  if (!Number.isInteger(boxSize) || boxSize <= 0) return null
  // 上界与 safeThumbUrl 同口径：box 是 contain 语义、不放大，取得过大等于完全不约束
  // （`thumbnail/1e+21x1e+21` 这种非法规则 COS 会直接原样返回原图 = 保护静默失效）
  if (boxSize > MAX_THUMB_BOX) return null
  // 版本号必须是非负整数。给不出版本号时**不降级下发**：
  // 没有 `?v=` 的 banner URL 会被 CDN 长期缓存，换图不生效——
  // 那是比"图略大"更难排查的故障，宁可走占位。
  if (!Number.isInteger(version) || version < 0) return null

  const parsed = parseProcessableUrl(url, 'banner')
  if (!parsed) return null

  parsed.search = `?imageMogr2/thumbnail/${boxSize}x${boxSize}&v=${version}`
  return parsed.toString()
}

/**
 * 首页 banner 档位（issue #231）：满屏轮播，`.banner-swiper { height: 260rpx }` + aspectFill。
 *
 * 展示位宽约 686rpx（750 − 32×2 padding），3x 屏物理约 1180×447。
 * 生产 banner 实测 3002×1039（2.89:1 宽图），box 1080 输出 1080×374、解码 1.5MB
 * （原图 11.9MB），aspectFill 放大约 1.19 倍 —— 对照片类内容可接受。
 *
 * 与 STORE_DETAIL_THUMB_BOX / PRODUCT_THUMB_BOX_LARGE 同取 1080，不另立档位。
 * swiper 开了 `circular` + `autoplay` 会预渲染相邻帧，N 张时可能同时驻留 2~3 张：
 * 本档下 3 张 ≈ 4.5MB；若抬到 1280（放大 1.01 倍）则 3 张 ≈ 6.6MB，不值。
 */
const BANNER_THUMB_BOX = 1080

/**
 * 门店列表卡片：显示尺寸 160rpx，3x 屏约 240 物理像素，取 300 留余量。
 * 解码上限 300×300×4 ≈ 0.34MB/张。
 */
const STORE_LIST_THUMB_BOX = 300

/**
 * 门店详情头图 / 相册：头图宽度是满屏 750rpx，3x 屏物理宽约 1170~1290px，
 * 用 750 会被放大约 1.7 倍发虚，故取 1080。
 * 解码上限 1080×1080×4 ≈ 4.5MB/张，详情页图片数量有限（相册 admin 侧限制 9 张），可接受。
 */
const STORE_DETAIL_THUMB_BOX = 1080

/**
 * 商品小缩略图（issue #230）：订单行 96~120rpx、扫码付 96rpx、体验卡列表卡片 200rpx。
 * 取其中最大的 200rpx，3x 屏约 344 物理像素，取 400 留余量。
 * 解码上限 400×400×4 ≈ 0.6MB/张——订单列表一屏十几行也压不垮。
 */
const PRODUCT_THUMB_BOX_SMALL = 400

/**
 * 商品大图（issue #230）：覆盖两类宽展示位，共用一个档位。
 * - 商品列表卡片：shop 页是 `van-sidebar` 双栏布局，封面容器宽
 *   = 750 − 180(--sidebar-width) − 32(padding) = **538rpx**，3x 屏约 925 物理像素
 * - 详情头图：满屏 750rpx，3x 屏约 1170~1290 物理像素
 *
 * 与 STORE_DETAIL_THUMB_BOX 同取 1080：再小会在整屏宽度上被放大而发虚。
 * 解码上限 1080×1080×4 ≈ 4.5MB/张，配合 lazy-load 只解码可见项，列表页可接受。
 *
 * 生产封面实测：44/44 张长宽比恒为 1.56（1125×720 或 2083×1333），
 * box 模式对它们无过度惩罚。
 *
 * 刻意**不**给 skuDetail 单独拆一个中间档：它同时服务结算页（120rpx 小图）与
 * 体验卡详情页（整屏 480rpx 头图），取两者大者即此档；拆档要给接口加尺寸参数，
 * 换来的只是结算页几张图的解码量，不值。
 *
 * ⚠️ 已接受的取舍：`app.json` 开了 `resizable: true`（折叠屏适配）。
 * 折叠屏展开态整屏物理宽可达 2000+px，满屏展示位会被放大约 2 倍而发虚。
 * 抬档会让解码内存线性膨胀，与本模块的目的直接冲突，故维持 1080。
 */
const PRODUCT_THUMB_BOX_LARGE = 1080

/**
 * 商品详情长图（issue #230）：总像素上限，**用面积模式不用 box**。
 *
 * 生产 14/14 张 detail_images 全是长图（高宽比 3.56~5.42，如 1389×5547、1737×7065），
 * 前端 `mode="widthFix"` 满屏渲染。用 box 会把它们压成 199~302px 宽，
 * 再被 widthFix 拉回 1290px = 放大 4.3~6.5 倍，长图里的文字直接糊掉。
 *
 * 取 2,250,000 ≈ 750×3000：实测 1737×7065 → 743×3025，解码 8.6MB，
 * 在 1290px 屏上放大 1.7 倍（与 `pages/cart` 凤御馆长图沿用的 750 宽口径一致）。
 *
 * 解码上限恒为 2.25M×4 ≈ **8.6MB/张**，与长宽比无关。
 * admin 侧 detail_images 有 9 张上限（`product-detail-page.tsx` 的 `max={9}`），
 * 故详情页最坏 = 头图 4.5MB + 9×8.6MB ≈ 82MB。
 * 改前是原图直发：单张 1737×7065 就要 46.8MB，9 张 = 421MB。
 */
const PRODUCT_DETAIL_IMAGE_MAX_PIXELS = 2250000

/**
 * 详情长图的**张数**上限（issue #230 双谱系评审独立提出）。
 *
 * 单张封顶只解决「一张图撑爆进程」，解决不了「很多张加起来撑爆进程」——
 * 页面级总量 = 张数 × 单张。admin UI 有 `max={9}`（`product-detail-page.tsx`），
 * 但那只是**客户端**限制：`actions/products.ts` 的 `createProduct` / `updateProduct`
 * 既无 zod 也无长度断言，`db/schema/product.ts` 的 `text().array()` 也没有 CHECK ——
 * 持 `product:update` 权限的账号直调 server action 就能写进 50 张。
 *
 * 所以下发侧必须自己截断，不能信上游。9 与 admin UI 上限对齐。
 * 截断后详情页最坏 = 头图 4.5MB + 9×8.6MB ≈ **82MB**（有硬上限）。
 *
 * 治本仍需在 admin action 加服务端校验 + DB 加 `cardinality(detail_images) <= 9` 约束，
 * 那属 admin 端改动，见 PR 的后续项。
 */
const PRODUCT_DETAIL_IMAGE_MAX_COUNT = 9

module.exports = {
  safeThumbUrl,
  safeThumbUrlByArea,
  safeBannerThumbUrl,
  isProcessableHost,
  COS_BASE,
  BANNER_THUMB_BOX,
  MAX_THUMB_BOX,
  STORE_LIST_THUMB_BOX,
  STORE_DETAIL_THUMB_BOX,
  PRODUCT_THUMB_BOX_SMALL,
  PRODUCT_THUMB_BOX_LARGE,
  PRODUCT_DETAIL_IMAGE_MAX_PIXELS,
  PRODUCT_DETAIL_IMAGE_MAX_COUNT,
}
