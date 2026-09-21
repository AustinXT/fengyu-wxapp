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

  /**
   * cache-buster 这类非白名单参数也会被丢弃。这是安全的：门店封面走 path 模式上传，
   * 文件名自带时间戳 + 随机串，URL 本身已唯一，不依赖 ?t= 刷新缓存
   * （?t= 只在 admin 的 exactKey 覆盖式上传里出现，那类图不走本函数）。
   */
  test('非白名单的 cache-buster 参数被丢弃', () => {
    expect(safeThumbUrl(`${COS_URL}?t=1758440000000`, 300)).toBe(
      `${COS_URL}?imageMogr2/thumbnail/300x300`
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

    test('链式 pipe 规则整条丢弃', () => {
      const result = safeThumbUrl(
        `${COS_URL}?imageMogr2/thumbnail/300x300|imageMogr2/crop/50000x50000`,
        300
      )
      expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
      expect(result).not.toContain('crop')
    })
  })

  /**
   * 白名单而非黑名单：COS 还有与 imageMogr2 平级的 imageView2（mode 1 可放大），
   * 只剥 imageMogr2 的话它能存活下来，等于留了个放大通道。
   */
  test('imageView2 等其它图片处理参数同样被丢弃', () => {
    const result = safeThumbUrl(
      `${COS_URL}?imageView2/1/w/50000/h/50000`,
      300
    )
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
    expect(result).not.toContain('imageView2')
    expect(result).not.toContain('50000')
  })

  test('未知的图片处理参数一律丢弃，不留放大通道', () => {
    const result = safeThumbUrl(`${COS_URL}?t=123&someFutureApi/9999&v=2`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
  })

  // COS 私有读签名共 7 个认证参数，丢任意一个都会 403
  test('私有读签名的全部 7 个参数都必须保留', () => {
    const signed =
      `${COS_URL}?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1&q-key-time=1` +
      `&q-header-list=host&q-url-param-list=&q-signature=abc`
    const result = safeThumbUrl(signed, 300)

    for (const param of [
      'q-sign-algorithm=sha1',
      'q-ak=AKID',
      'q-sign-time=1',
      'q-key-time=1',
      'q-header-list=host',
      'q-url-param-list=',
      'q-signature=abc',
    ]) {
      expect(result).toContain(param)
    }
    expect(result).toContain('imageMogr2/thumbnail/300x300')
  })

  test('临时密钥 URL 的安全令牌必须保留', () => {
    const result = safeThumbUrl(
      `${COS_URL}?q-signature=abc&x-cos-security-token=TOKEN123`,
      300
    )
    expect(result).toContain('x-cos-security-token=TOKEN123')
  })

  /**
   * 被签进签名的业务参数由 q-url-param-list 自己声明。只保留 q-url-param-list
   * 本身、却把它列出的参数删掉，签名一样失效——白名单前缀列表覆盖不了这种动态声明。
   */
  test('q-url-param-list 声明的业务参数必须一并保留', () => {
    const result = safeThumbUrl(
      `${COS_URL}?q-url-param-list=response-content-disposition` +
        `&response-content-disposition=inline&q-signature=abc`,
      300
    )
    expect(result).toContain('q-url-param-list=response-content-disposition')
    expect(result).toContain('response-content-disposition=inline')
    expect(result).toContain('imageMogr2/thumbnail/300x300')
  })

  /**
   * q-url-param-list 写在 URL 上、无从验真，不能当授权证据：
   * 让一条放大规则「自声明」成已签名参数，就能存活并排在服务端规则之前，
   * 而 COS 未定义多个独立处理键的优先级 —— 等于赌未定义行为。
   */
  test('自声明的处理参数不得借 q-url-param-list 存活', () => {
    const attack =
      `${COS_URL}?imageView2%2F1%2Fw%2F50000%2Fh%2F50000` +
      `&q-url-param-list=imageView2%2F1%2Fw%2F50000%2Fh%2F50000`
    const result = safeThumbUrl(attack, 300)
    expect(result).not.toContain('imageView2')
    expect(result).not.toContain('50000')
    expect(result).toContain('imageMogr2/thumbnail/300x300')
  })

  test('无等号的编码参数名自声明同样无效', () => {
    const attack =
      `${COS_URL}?imageMogr2%2Fthumbnail%2F65536x65536` +
      `&q-url-param-list=imagemogr2%2Fthumbnail%2F65536x65536`
    const result = safeThumbUrl(attack, 300)
    expect(result).not.toContain('65536')
    expect(result).toContain('imageMogr2/thumbnail/300x300')
  })

  test('未被签名声明的同名业务参数仍然丢弃', () => {
    const result = safeThumbUrl(
      `${COS_URL}?q-url-param-list=&response-content-disposition=inline`,
      300
    )
    expect(result).not.toContain('response-content-disposition=inline')
  })

  test('非法百分号编码不抛错且按非鉴权参数丢弃', () => {
    const result = safeThumbUrl(`${COS_URL}?%ZZbad=1&imageView2/1/w/9999`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
  })

  test('编码变体的处理参数同样被丢弃', () => {
    const result = safeThumbUrl(`${COS_URL}?%69mageMogr2/thumbnail/50000x`, 300)
    expect(result).toBe(`${COS_URL}?imageMogr2/thumbnail/300x300`)
    expect(result).not.toContain('50000')
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

  /**
   * 只认 CloudBase 云存储 CDN 域名。另外两类看起来相关的域名刻意不放通：
   * tcloudbaseapp.com 是静态网站托管（不执行数据万象，拼了也原图直出）；
   * myqcloud.com 是通用 COS 域名，任何人都能建桶、无法保证开通了数据万象。
   * 拼上参数却不生效 = 保护静默失效，所以按约定返回 null。
   */
  test('通用 COS 域名与静态托管域名一律返回 null', () => {
    expect(
      safeThumbUrl('https://bucket-123.cos.ap-shanghai.myqcloud.com/a.png', 300)
    ).toBeNull()
    expect(
      safeThumbUrl('https://attacker-env.tcloudbaseapp.com/12576.png', 300)
    ).toBeNull()
  })

  test('FQDN 尾点域名与不带尾点等价，不应漏处理', () => {
    const fqdn =
      'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la./a.png'
    expect(safeThumbUrl(fqdn, 300)).toContain('imageMogr2/thumbnail/300x300')
  })
})

describe('isProcessableHost', () => {
  test('识别 CloudBase 云存储域名并容忍 FQDN 尾点', () => {
    expect(isProcessableHost('a.tcb.qcloud.la')).toBe(true)
    expect(isProcessableHost('a.tcb.qcloud.la.')).toBe(true)
    expect(isProcessableHost('evil.com')).toBe(false)
    expect(isProcessableHost('a.tcb.qcloud.la.evil.com')).toBe(false)
    // 静态网站托管，不执行数据万象
    expect(isProcessableHost('x.tcloudbaseapp.com')).toBe(false)
    // 通用 COS 域名，任何人可建桶，无法保证开通了数据万象
    expect(isProcessableHost('b.myqcloud.com')).toBe(false)
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
