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

// 数据万象仅对 CloudBase / COS 自有域名生效，外链拼了参数反而可能 404
const COS_HOST_PATTERN = /(\.tcb\.qcloud\.la|\.myqcloud\.com|\.tcloudbaseapp\.com)$/i

/**
 * 判断 hostname 是否属于可做数据万象处理的域名。
 * 先去掉 FQDN 尾点（`a.tcb.qcloud.la.` 与 `a.tcb.qcloud.la` DNS 等价，
 * 不归一会漏匹配从而退回下发原图）。
 */
function isProcessableHost(hostname) {
  return COS_HOST_PATTERN.test(String(hostname).replace(/\.$/, ''))
}

/**
 * 判断一个 query 参数是否属于「鉴权必需、删了会 403」的那类。
 *
 * 光靠固定前缀列表补不全：COS V5 签名把哪些业务参数纳入签名，是由 `q-url-param-list`
 * 自己声明的（分号分隔）。若只保留 `q-url-param-list=response-content-disposition`
 * 而把真正的 `response-content-disposition=inline` 删掉，签名照样失效。
 * 所以这里先读出它声明的参数名集合，再据此决定保留谁。
 *
 * @param {string} param 形如 `key=value` 的原始参数串
 * @param {string[]} allParams 同一 URL 上的全部原始参数串
 */
function isAuthParam(param, allParams) {
  const name = decodeParamName(param)

  // q-* 是签名自身的字段；临时密钥 URL 还必须带安全令牌
  if (name.startsWith('q-')) return true
  if (name === 'x-cos-security-token') return true

  // q-url-param-list 声明了哪些业务参数被签进了签名，这些同样不能动
  const listParam = allParams.find(
    (p) => decodeParamName(p) === 'q-url-param-list'
  )
  if (!listParam) return false

  const signedNames = decodeURIComponentSafe(listParam.slice(listParam.indexOf('=') + 1))
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  return signedNames.includes(name)
}

/** 取参数名并归一（解码 + 小写），解码失败时退回原串 */
function decodeParamName(param) {
  const eq = param.indexOf('=')
  const rawName = eq === -1 ? param : param.slice(0, eq)
  return decodeURIComponentSafe(rawName).toLowerCase()
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法百分号编码：退回原串。这里只影响「是否认定为鉴权参数」，
    // 退回原串会让它落到「非鉴权 → 丢弃」，方向是安全的
    return value
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

  // 丢弃原 URL 上的全部图片处理参数，只保留鉴权相关参数，再拼服务端自己的规则。
  //
  // 这里必须是白名单而不是「剥掉 imageMogr2」的黑名单：COS 还有与 imageMogr2 平级的
  // imageView2（mode 1 可把图放大到指定尺寸），黑名单漏掉它就等于留了个放大通道；
  // 而黑名单永远只挡得住已知参数名。最终生效的规则必须由服务端完全掌控。
  const rawParams = parsed.search.replace(/^\?/, '').split('&').filter(Boolean)
  const kept = rawParams.filter((p) => isAuthParam(p, rawParams))

  kept.push(`imageMogr2/thumbnail/${boxSize}x${boxSize}`)

  // 经 URL 对象重建而非裸字符串拼接：字符串拼接遇到 #fragment 会把参数拼进 fragment 里
  // （对 COS 不生效），遇到末尾裸 ? 会拼出 ??
  parsed.search = `?${kept.join('&')}`
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
