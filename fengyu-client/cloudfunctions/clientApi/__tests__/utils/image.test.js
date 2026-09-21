/**
 * image 工具测试 —— COS 缩略参数拼接（issue #213 门店封面 OOM 崩溃）
 *
 * 核心安全约定：无法保证缩略的输入一律返回 null，绝不退回原图。
 */
const {
  safeThumbUrl,
  isProcessableHost,
  STORE_LIST_THUMB_BOX,
  STORE_DETAIL_THUMB_BOX,
} = require('../../utils/image')

const COS_URL =
  'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/store-covers/1789097186265-apa9p0.png'

describe('safeThumbUrl', () => {
  test('COS 图片拼上双边 box 缩略参数', () => {
    expect(safeThumbUrl(COS_URL, 300)).toBe(
      `${COS_URL}?imageMogr2/thumbnail/300x300`
    )
  })

  /**
   * 双边 box 是本修复的核心不变量：只限宽（thumbnail/300x）挡不住细长图，
   * 1080×20000 的长截图能过 40MP 像素积上限，只限宽时解码仍是 86MB。
   */
  test('缩略规则必须同时约束宽和高，而不是只限宽', () => {
    const result = safeThumbUrl(COS_URL, 300)
    expect(result).toContain('imageMogr2/thumbnail/300x300')
    expect(result).not.toMatch(/thumbnail\/300x(?!300)/)
  })

  test('已有 query 时保留原参数并追加缩略参数', () => {
    const withQuery = `${COS_URL}?t=1758440000000`
    expect(safeThumbUrl(withQuery, 300)).toBe(
      `${withQuery}&imageMogr2/thumbnail/300x300`
    )
  })

  /**
   * 不能「看到 imageMogr2 就当作已处理并原样返回」：
   * 下面这些参数都会让超大图被原样下发，最终规则必须由服务端完全掌控。
   */
  describe('已有 imageMogr2 参数一律剥离后重拼，不信任外部规则', () => {
    const cases = [
      ['裸参数', 'imageMogr2'],
      ['伪装参数名', 'imageMogr2Evil=1'],
      ['原图尺寸的规则', 'imageMogr2/thumbnail/12576x'],
      ['放大规则', 'imageMogr2/thumbnail/50000x'],
      ['本服务自己拼过的规则', 'imageMogr2/thumbnail/300x300'],
    ]

    test.each(cases)('%s', (_label, param) => {
      const result = safeThumbUrl(`${COS_URL}?${param}`, 300)
      expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
      // 外部传入的规则必须消失，不能与服务端规则并存
      expect(result).not.toContain('50000')
      expect(result).not.toContain('12576')
      expect(result).not.toContain('Evil')
    })
  })

  test('剥离 imageMogr2 时保留其它无关 query 参数', () => {
    const result = safeThumbUrl(
      `${COS_URL}?t=123&imageMogr2/thumbnail/50000x&v=2`,
      300
    )
    expect(result).toBe(`${COS_URL}?t=123&v=2&imageMogr2/thumbnail/300x300`)
  })

  // 以下输入都无法保证缩略，必须返回 null 让调用方渲染占位图，而不是下发原图
  describe('无法保证缩略时返回 null', () => {
    test('非 COS 外链', () => {
      expect(safeThumbUrl('https://example.com/foo.png', 300)).toBeNull()
    })

    test('cloud:// 协议 fileID', () => {
      expect(
        safeThumbUrl('cloud://env.bucket/store-covers/a.png', 300)
      ).toBeNull()
    })

    test('伪造后缀域名', () => {
      expect(
        safeThumbUrl('https://evil.tcb.qcloud.la.attacker.com/a.png', 300)
      ).toBeNull()
    })

    test('userinfo 伪装域名（hostname 实为 evil.com）', () => {
      expect(
        safeThumbUrl('https://a.tcb.qcloud.la@evil.com/a.png', 300)
      ).toBeNull()
    })

    test('空值 / 纯空白 / 非字符串', () => {
      expect(safeThumbUrl('', 300)).toBeNull()
      expect(safeThumbUrl('   ', 300)).toBeNull()
      expect(safeThumbUrl(null, 300)).toBeNull()
      expect(safeThumbUrl(undefined, 300)).toBeNull()
      expect(safeThumbUrl(123, 300)).toBeNull()
    })

    test('非法 box 尺寸', () => {
      expect(safeThumbUrl(COS_URL, 0)).toBeNull()
      expect(safeThumbUrl(COS_URL, -1)).toBeNull()
      expect(safeThumbUrl(COS_URL, 1.5)).toBeNull()
      expect(safeThumbUrl(COS_URL, NaN)).toBeNull()
      expect(safeThumbUrl(COS_URL, '300')).toBeNull()
      expect(safeThumbUrl(COS_URL, undefined)).toBeNull()
    })

    test('非法 URL 字符串', () => {
      expect(safeThumbUrl('http://', 300)).toBeNull()
    })
  })

  test('URL 带 #fragment 时参数落在 query 而非 fragment 内', () => {
    const result = safeThumbUrl(`${COS_URL}#preview`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300#preview`)
    expect(result.indexOf('imageMogr2')).toBeLessThan(result.indexOf('#'))
  })

  test('末尾裸 ? 不产生双问号', () => {
    const result = safeThumbUrl(`${COS_URL}?`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
    expect(result).not.toContain('??')
  })

  test('其它 COS 域名后缀同样生效', () => {
    const myqcloud = 'https://bucket-123.cos.ap-shanghai.myqcloud.com/a.png'
    expect(safeThumbUrl(myqcloud, 300)).toBe(
      `${myqcloud}?imageMogr2/thumbnail/300x300`
    )
  })

  test('FQDN 尾点域名与不带尾点等价，不应漏处理', () => {
    const fqdn =
      'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la./a.png'
    expect(safeThumbUrl(fqdn, 300)).toContain('imageMogr2/thumbnail/300x300')
  })
})

describe('isProcessableHost', () => {
  test('识别 COS 域名并容忍 FQDN 尾点', () => {
    expect(isProcessableHost('a.tcb.qcloud.la')).toBe(true)
    expect(isProcessableHost('a.tcb.qcloud.la.')).toBe(true)
    expect(isProcessableHost('b.myqcloud.com')).toBe(true)
    expect(isProcessableHost('evil.com')).toBe(false)
    expect(isProcessableHost('a.tcb.qcloud.la.evil.com')).toBe(false)
  })
})

describe('展示尺寸常量', () => {
  test('列表与详情的 box 符合各自展示尺寸', () => {
    // 列表卡片 160rpx，3x 屏约 240 物理像素
    expect(STORE_LIST_THUMB_BOX).toBe(300)
    // 详情头图满屏 750rpx，3x 屏物理宽约 1170~1290px，750 会发虚
    expect(STORE_DETAIL_THUMB_BOX).toBe(1080)
  })

  /**
   * 解码内存的上界由 box 决定。注意这里断言的是「规则形态」，
   * 真实输出尺寸由 COS 保证，已在 _tmp/issue-213/verify.md 用 41 张生产图实测。
   */
  test('列表 box 把单张解码内存压到 1MB 以内', () => {
    const bytes = STORE_LIST_THUMB_BOX * STORE_LIST_THUMB_BOX * 4
    expect(bytes).toBeLessThan(1024 * 1024)
  })

  test('详情 box 把单张解码内存压到 5MB 以内', () => {
    const bytes = STORE_DETAIL_THUMB_BOX * STORE_DETAIL_THUMB_BOX * 4
    expect(bytes).toBeLessThan(5 * 1024 * 1024)
  })
})
