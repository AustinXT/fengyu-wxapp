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
 * 生成可安全下发给小程序的缩略图 URL。
 *
 * **无法保证缩略的一律返回 null，而不是退回原图** —— 这是本模块的核心安全约定。
 * 退回原图意味着「保护静默失效」：调用方看不出区别，而那张图可能正是会撑爆进程的巨图。
 * 返回 null 时调用方应渲染占位图（前端各处已有 wx:if 占位分支）。
 *
 * 缩略规则用**双边** box（`thumbnail/NxN`，数据万象的 contain 语义：等比缩放到宽高都不超过 N），
 * 而不是只限宽的 `thumbnail/Nx`。只限宽挡不住细长图：
 * 一张 1080×20000 的长截图（21.6MP，能过 40MP 上限、文件也不大）在 `1080x` 规则下
 * 宽度已达标、高度完全不受约束，解码仍是 1080×20000×4 ≈ 86MB。
 * 用双边 box 后，解码内存被硬封顶为 N×N×4。
 *
 * @param {string} url 原始图片 URL
 * @param {number} boxSize 目标 box 边长（像素），等比缩放到宽高均不超过它
 * @returns {string|null} 处理后的 URL；无法保证缩略时返回 null
 */
function safeThumbUrl(url, boxSize) {
  if (typeof url !== 'string' || url.trim() === '') return null
  if (!Number.isInteger(boxSize) || boxSize <= 0) return null

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

  // 图片样式可以直接挂在对象路径后（默认分隔符 `!`），且样式本身能携带完整的缩放规则。
  // 光清洗 query 挡不住它，而两种处理机制同时出现时的优先级 COS 并未定义 —— 直接拒绝。
  if (parsed.pathname.includes('!')) return null

  const rawParams = parsed.search.replace(/^\?/, '').split('&').filter(Boolean)

  // 带签名的 URL 无法在不重签名的前提下安全改造，放弃处理
  if (hasCosSignature(rawParams)) return null

  // 其余情况丢弃原 URL 上的**全部** query，只留服务端自己的规则。
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

module.exports = {
  safeThumbUrl,
  isProcessableHost,
  STORE_LIST_THUMB_BOX,
  STORE_DETAIL_THUMB_BOX,
}
