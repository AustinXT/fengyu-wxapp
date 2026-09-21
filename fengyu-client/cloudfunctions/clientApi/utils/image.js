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
 *
 * ⚠️ **本文件在两端各有一份字节一致的副本，改一端必须同步另一端**（issue #232）：
 *   ├── fengyu-client/cloudfunctions/clientApi/utils/image.js
 *   └── fengyu-staff/cloudfunctions/staffApi/utils/image.js
 *
 * 项目禁止跨端共享代码目录（见根 CLAUDE.md），一致性靠
 * `staffApi/__tests__/utils/image-cross-copy.test.js` 的全文断言守护，漂移立即转红。
 * 为什么是「字节一致」而不是「行为等价」，见那个文件的 docstring。
 */

/**
 * 可做数据万象处理的 bucket hostname —— **精确白名单，不是后缀通配**。
 *
 * 为什么必须精确到 bucket（#232 评审指出）：
 * 数据万象是**按 bucket 绑定**的服务，不是 `.tcb.qcloud.la` 这个后缀自带的能力。
 * 用后缀通配的话，任何同后缀但没开通数据万象的 CloudBase 环境都会通过校验，
 * 拼上 `imageMogr2` 后 COS 原样返回**原图** —— 这正是本模块最怕的「保护静默失效」：
 * URL 看着有规则、图也能正常加载，下发的却是那张会撑爆进程的巨图，
 * 连渲染侧的 `binderror` 兜底都不会触发。
 *
 * 两个 host 的来源是 `fengyu-admin/src/lib/cloudbase.ts` 的 `CDN_BASE`（按环境取值）：
 * - `6665-fengyu-client-prod-…` —— 当前生产。库里实测 prod 43+42 张、
 *   dev 43+42+12 张**全部**是它（单 CloudBase 环境架构，dev/prod 同一个 bucket）
 * - `636c-cloud1-3gpht4b01ff88838-…` —— 历史 dev 环境，仍是 admin `.env.local`
 *   的默认值，本机开发上传的图会落在这里
 *
 * ⚠️ 换 bucket / 加环境时必须显式加进这个数组，否则该环境的图片会**全部**变占位。
 * 这是刻意的 fail-closed；下发侧的 `console.warn` 会在日志里暴露漏加。
 *
 * 刻意**不**放通另外两类看起来相关的域名：
 * - `*.tcloudbaseapp.com` 是 CloudBase **静态网站托管**，不执行数据万象
 * - `*.myqcloud.com` 是通用 COS 域名，任何腾讯云用户都能建桶
 */
const COS_ALLOWED_HOSTS = [
  '6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la',
  '636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la',
]

/**
 * 入参 URL 的长度上界。现实封面 URL 约 110 字符，2048 已是数量级余量。
 * 存在的理由见 parseProcessableUrl 里的注释：挡的是「一条超长 URL 撑爆整个接口响应」。
 */
const MAX_SOURCE_URL_LENGTH = 2048

/**
 * 档位参数的上界，两种模式同一口径：**单张解码不超过 2048×2048×4 ≈ 16.8MB**。
 *
 * 不是为了当前调用点（它们传的都是本模块导出的常量），而是为了让
 * 「档位值本身失控」不至于等于没有保护 —— 这正是 issue #230 在
 * `thumbnail/!<Area>@` 上踩过的同一类坑：规则看着在，实际不生效。
 *
 * 2048 也远超现实需要：最大的展示位是满屏 750rpx（折叠屏展开约 2000 物理像素），
 * 本模块最大的档位常量是 1080。
 */
const MAX_THUMB_BOX = 2048
const MAX_THUMB_PIXELS = MAX_THUMB_BOX * MAX_THUMB_BOX

/**
 * 判断 hostname 是否属于可做数据万象处理的 bucket。
 *
 * 归一两件事后再精确比对：
 * - FQDN 尾点（`a.tcb.qcloud.la.` 与 `a.tcb.qcloud.la` DNS 等价，不归一会漏匹配）
 * - 大小写（DNS 不区分大小写）。⚠️ **只有这一段**不敏感 ——
 *   数据万象的处理指令是大小写敏感的（`IMAGEMOGR2` 不执行），那部分绝不能一起放宽
 */
function isProcessableHost(hostname) {
  const normalized = String(hostname).replace(/\.$/, '').toLowerCase()
  return COS_ALLOWED_HOSTS.includes(normalized)
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
 *
 * ⚠️ **已知限制：只认 COS V5 的 query 签名形态**（`q-*` / `x-cos-security-token`）。
 * `cloud.getTempFileURL()` 产的是另一种——CloudBase CDN 鉴权（`sign` / `t` 之类），
 * 参数名不以 `q-` 开头，会被当成普通 query 一并丢弃，下发出去就是 403 裂图。
 *
 * 当前没有调用点会喂进这种 URL（封面来自 admin `lib/cloudbase.ts` 拼的公共读地址；
 * 生产库实测：staff 头像 17/17 无 query、client 头像 42/42 是 `cloud://` 走不到这里）。
 * 刻意**不**把 `t` / `token` / `expire` 加进名单：它们同时也是极常见的缓存刷新参数
 * （banner 就用 `?v=`），误判成签名会让本可缩略的图直接变占位。
 * 真要接 `getTempFileURL` 链路（issue #233 的头像下发侧）时，
 * 应当按**实际抓到的参数名**收紧，而不是现在凭猜测扩名单。
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
function parseProcessableUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null

  // 长度上界：`products.cover_image` / `stores.cover_image` 都是无约束的 `text`，
  // admin 的写入侧也没有长度断言。一条 10MB 的 URL 会被原样放大后塞进响应体，
  // 撑爆的不是一张图而是**整个接口**（列表接口要拼几十条）。
  // 2048 是现实 URL 的数量级上限（实际封面 URL ~110 字符）。
  if (url.length > MAX_SOURCE_URL_LENGTH) return null

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
  if (!/^\/[\w-]+\/[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(parsed.pathname)) {
    return null
  }

  const rawParams = parsed.search.replace(/^\?/, '').split('&').filter(Boolean)

  // 带签名的 URL 无法在不重签名的前提下安全改造，放弃处理
  if (hasCosSignature(rawParams)) return null

  // 清掉 userinfo：`https://user:pw@host/...` 的 hostname 判断已经是安全的
  // （走 parsed.hostname，不会被 `@` 伪装骗过），但 `toString()` 会把凭证原样带出去，
  // 下发进 `<image src>` 和前端日志。库里不该有这种 URL，真有就不该传播。
  parsed.username = ''
  parsed.password = ''

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
  // 上界：`thumbnail/NxN` 是 contain 语义、**不放大**，所以 N 取得过大等于完全不约束——
  // 「保护静默失效」的又一种形态（`thumbnail/99999x99999` 看着有规则，实际原样返回）。
  // 当前所有调用点传的都是本模块导出的常量，这条挡的是将来有人传外部输入。
  if (boxSize > MAX_THUMB_BOX) return null

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
  // 与 box 同口径的上界，见 MAX_THUMB_PIXELS
  if (maxPixels > MAX_THUMB_PIXELS) return null

  const parsed = parseProcessableUrl(url)
  if (!parsed) return null

  parsed.search = `?imageMogr2/thumbnail/${maxPixels}@`
  return parsed.toString()
}

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
 * 商品小缩略图。**两端共 5 个调用点**，改值会同时影响 client 与 staff：
 *
 * | 端 | 位置 | 展示位 |
 * |---|---|---|
 * | client (#230) | `order.js` 订单行 ×2、扫码付 ×1 | 96~120rpx 方形 |
 * | client (#230) | `product.js` 体验卡列表卡片 | 200×200rpx 方形 |
 * | **staff (#232)** | `product.js` bundleGroups → `bundle-picker` | **200rpx 宽 × 最高约 211rpx 高** |
 *
 * ⚠️ **已接受的取舍：这一档在 aspectFill 展示位上会放大约 1.4 倍。**
 *
 * 容易算错的地方是——约束展示位的是**高**不是宽。staff 的 `.bundle-cover` 只设了
 * `width: 200rpx`，高度被 flex `align-items: stretch` 拉满卡片（名称 2 行 + 描述 + 页脚
 * ≈ 211rpx）。生产封面长宽比恒 1.56（横图），contain 到 400 box 后是 400×256，
 * 高度方向只有 256 —— 而 1290px 屏上容器高约 363 物理像素，`aspectFill` 因此放大 1.42 倍。
 * 要让高度方向也不放大，box 得抬到 566 以上。
 *
 * 不抬的理由：抬档会让**全部 5 个调用点**的解码量线性膨胀，而其中三个
 * （订单列表、扫码付）恰恰是一屏十几张的场景 —— 正是本模块要压的那一类。
 * 1.4 倍放大在 200rpx 的小展示位上对照片类内容观感损失有限
 * （与 #230 详情长图 4.8 倍把文字压糊完全不是一个量级）。
 * 折叠屏展开态（staff `app.json` 的 `resizable: true`）约 2.2 倍，同理接受。
 *
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
  isProcessableHost,
  COS_ALLOWED_HOSTS,
  MAX_SOURCE_URL_LENGTH,
  MAX_THUMB_BOX,
  MAX_THUMB_PIXELS,
  STORE_LIST_THUMB_BOX,
  STORE_DETAIL_THUMB_BOX,
  PRODUCT_THUMB_BOX_SMALL,
  PRODUCT_THUMB_BOX_LARGE,
  PRODUCT_DETAIL_IMAGE_MAX_PIXELS,
  PRODUCT_DETAIL_IMAGE_MAX_COUNT,
}
