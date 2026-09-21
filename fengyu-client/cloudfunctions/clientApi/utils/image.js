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
 * 只做等比缩放、不转格式：转 jpg 虽更小，但会让带透明通道的图出现黑底，
 * 而缩到 300x 后解码内存已降到 300×300×4 ≈ 360KB，格式带来的差异无关紧要。
 */

// 数据万象仅对 CloudBase / COS 自有域名生效，外链拼了参数反而可能 404
const COS_HOST_PATTERN = /(\.tcb\.qcloud\.la|\.myqcloud\.com|\.tcloudbaseapp\.com)$/i

/**
 * 给 COS 图片 URL 拼接等比缩略参数
 *
 * @param {string} url 原始图片 URL
 * @param {number} width 目标宽度（像素），等比缩放
 * @returns {string} 处理后的 URL；不适用的输入一律原样返回（降级不报错）
 */
function thumbUrl(url, width) {
  if (typeof url !== 'string' || url === '') return url
  if (!Number.isInteger(width) || width <= 0) return url

  // 仅处理 http(s)：cloud:// 等协议交给调用方自行转换
  if (!/^https?:\/\//i.test(url)) return url

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  // 用 hostname 判断而不是对整串做正则：否则 https://a.tcb.qcloud.la@evil.com/
  // 这类把可信域名塞进 userinfo 的 URL 会被误判为可信
  if (!COS_HOST_PATTERN.test(parsed.hostname)) return url

  // 幂等：已经带过 imageMogr2 的不再叠加（叠加会让后一个参数失效）。
  // 按「参数边界」判断而非子串匹配，否则 ?ref=imageMogr2Test 会被误判成已处理而放行原图
  const existingParams = parsed.search.replace(/^\?/, '').split('&')
  if (existingParams.some(p => p.startsWith('imageMogr2'))) return url

  // 经 URL 对象重建而非裸字符串拼接：字符串拼接遇到 #fragment 会把参数拼进 fragment 里
  // （对 COS 不生效），遇到末尾裸 ? 会拼出 ??
  const param = `imageMogr2/thumbnail/${width}x`
  parsed.search = parsed.search ? `${parsed.search}&${param}` : `?${param}`
  return parsed.toString()
}

/**
 * 门店列表卡片：显示尺寸 160rpx，3x 屏约 240 物理像素，取 300 留余量
 */
const STORE_LIST_THUMB_WIDTH = 300

/**
 * 门店详情头图 / 相册：头图宽度是满屏 750rpx，3x 屏（iPhone Pro 等）物理宽约 1170~1290px，
 * 用 750 会被放大约 1.7 倍发虚，故取 1080。
 * 解码约 1080×1080×4 ≈ 4.5MB/张，详情页图片数量有限（相册 admin 侧限制 9 张），可接受。
 */
const STORE_DETAIL_THUMB_WIDTH = 1080

module.exports = {
  thumbUrl,
  STORE_LIST_THUMB_WIDTH,
  STORE_DETAIL_THUMB_WIDTH,
}
