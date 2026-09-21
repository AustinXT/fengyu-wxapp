/**
 * image 工具测试 —— COS 缩略参数拼接（issue #213 门店封面 OOM 崩溃）
 */
const {
  thumbUrl,
  STORE_LIST_THUMB_WIDTH,
  STORE_DETAIL_THUMB_WIDTH,
} = require('../../utils/image')

const COS_URL =
  'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/store-covers/1789097186265-apa9p0.png'

describe('thumbUrl', () => {
  test('COS 图片拼上等比缩略参数', () => {
    expect(thumbUrl(COS_URL, 300)).toBe(`${COS_URL}?imageMogr2/thumbnail/300x`)
  })

  test('已有 query 时用 & 续接（admin exactKey 上传会带 ?t=时间戳）', () => {
    const withQuery = `${COS_URL}?t=1758440000000`
    expect(thumbUrl(withQuery, 300)).toBe(
      `${withQuery}&imageMogr2/thumbnail/300x`
    )
  })

  test('幂等：已带 imageMogr2 的不再叠加', () => {
    const already = `${COS_URL}?imageMogr2/thumbnail/300x`
    expect(thumbUrl(already, 750)).toBe(already)
  })

  // pr-ready P2-4：幂等判断若用子串匹配，这类 query 会被误判成「已处理」而放行原图
  test('query 含 imageMogr2 子串但不是该参数时，仍要正常缩略', () => {
    const withDecoy = `${COS_URL}?ref=imageMogr2Test`
    expect(thumbUrl(withDecoy, 300)).toBe(
      `${withDecoy}&imageMogr2/thumbnail/300x`
    )
  })

  // pr-ready P3：字符串拼接会把参数拼进 fragment 里，对 COS 不生效
  test('URL 带 #fragment 时参数落在 query 而非 fragment 内', () => {
    const result = thumbUrl(`${COS_URL}#preview`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x#preview`)
    expect(result.indexOf('imageMogr2')).toBeLessThan(result.indexOf('#'))
  })

  // pr-ready P3：末尾裸 ? 会被 URL 规范化为空 search，字符串拼接会拼出 ??
  test('末尾裸 ? 不产生双问号', () => {
    const result = thumbUrl(`${COS_URL}?`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x`)
    expect(result).not.toContain('??')
  })

  test('非 COS 域名原样返回（数据万象不生效，拼了可能 404）', () => {
    const external = 'https://example.com/foo.png'
    expect(thumbUrl(external, 300)).toBe(external)
  })

  test('cloud:// 等非 http 协议原样返回', () => {
    const cloudId = 'cloud://env.bucket/store-covers/a.png'
    expect(thumbUrl(cloudId, 300)).toBe(cloudId)
  })

  test('空值 / 非字符串原样返回', () => {
    expect(thumbUrl('', 300)).toBe('')
    expect(thumbUrl(null, 300)).toBeNull()
    expect(thumbUrl(undefined, 300)).toBeUndefined()
    expect(thumbUrl(123, 300)).toBe(123)
  })

  test('非法宽度降级为原样返回，不抛错', () => {
    expect(thumbUrl(COS_URL, 0)).toBe(COS_URL)
    expect(thumbUrl(COS_URL, -1)).toBe(COS_URL)
    expect(thumbUrl(COS_URL, 1.5)).toBe(COS_URL)
    expect(thumbUrl(COS_URL, NaN)).toBe(COS_URL)
    expect(thumbUrl(COS_URL, '300')).toBe(COS_URL)
    expect(thumbUrl(COS_URL, undefined)).toBe(COS_URL)
  })

  test('非法 URL 字符串不抛错', () => {
    expect(thumbUrl('http://', 300)).toBe('http://')
  })

  test('其它 COS 域名后缀同样生效', () => {
    const myqcloud = 'https://bucket-123.cos.ap-shanghai.myqcloud.com/a.png'
    expect(thumbUrl(myqcloud, 300)).toBe(
      `${myqcloud}?imageMogr2/thumbnail/300x`
    )
  })

  test('域名后缀只认结尾，防伪造域名绕过', () => {
    const fake = 'https://evil.tcb.qcloud.la.attacker.com/a.png'
    expect(thumbUrl(fake, 300)).toBe(fake)
  })

  // 把可信域名塞进 userinfo：new URL().hostname 解析为 evil.com，必须不被当作可信
  test('userinfo 伪装域名不被误判为 COS', () => {
    const spoofed = 'https://a.tcb.qcloud.la@evil.com/a.png'
    expect(thumbUrl(spoofed, 300)).toBe(spoofed)
  })

  test('导出的宽度常量符合展示尺寸', () => {
    expect(STORE_LIST_THUMB_WIDTH).toBe(300)
    // 详情头图满屏 750rpx，3x 屏物理宽约 1170~1290px，750 会发虚，故用 1080
    expect(STORE_DETAIL_THUMB_WIDTH).toBe(1080)
  })

  test('缩略后解码内存显著低于原图（回归护栏）', () => {
    // 原图 12576×12575×4 ≈ 603MB；缩到 300x 后 300×300×4 ≈ 0.34MB
    const originalBytes = 12576 * 12575 * 4
    const thumbBytes = STORE_LIST_THUMB_WIDTH * STORE_LIST_THUMB_WIDTH * 4
    expect(thumbBytes).toBeLessThan(originalBytes / 1000)
  })
})
