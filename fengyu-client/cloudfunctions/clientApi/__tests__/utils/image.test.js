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

  /**
   * 带签名的 URL 一律放弃处理，不尝试「保留签名参数 + 追加缩略规则」：
   * 哪些参数被签进签名由 q-url-param-list 声明，而它写在 URL 上无从验真
   * （曾被构造成让放大规则自声明存活）；腾讯云还要求已签名的处理参数做双重编码，
   * 少保留一个签名就废、多保留一个就是放大通道。
   * 无法在不重签名的前提下安全追加规则，就不该返回一个注定 403 的 URL。
   */
  describe('带 COS 签名的 URL 一律返回 null', () => {
    test('标准 V5 私有读签名', () => {
      const signed =
        `${COS_URL}?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1&q-key-time=1` +
        `&q-header-list=host&q-url-param-list=&q-signature=abc`
      expect(safeThumbUrl(signed, 300)).toBeNull()
    })

    test('临时密钥安全令牌', () => {
      expect(
        safeThumbUrl(`${COS_URL}?x-cos-security-token=TOKEN123`, 300)
      ).toBeNull()
    })

    test('已把处理参数签进签名的 URL（双重编码形态）', () => {
      const signed =
        `${COS_URL}?q-url-param-list=imagemogr2%252fthumbnail%252f100x100` +
        `&imageMogr2%2Fthumbnail%2F100x100=&q-signature=abc`
      expect(safeThumbUrl(signed, 300)).toBeNull()
    })

    test('第四轮的自声明劫持构造', () => {
      const attack =
        `${COS_URL}?imageView2%2F1%2Fw%2F50000%2Fh%2F50000` +
        `&q-url-param-list=imageView2%2F1%2Fw%2F50000%2Fh%2F50000`
      expect(safeThumbUrl(attack, 300)).toBeNull()
    })
  })

  /**
   * 图片样式可以直接挂在对象路径后（默认分隔符 `!`），样式本身能携带完整缩放规则。
   * 只清洗 query 挡不住它，而两种处理机制并存时的优先级 COS 并未定义。
   */
  test('路径型图片样式返回 null', () => {
    expect(
      safeThumbUrl(
        'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/store-covers/a.png!oversize',
        300
      )
    ).toBeNull()
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
      'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la./store-covers/a.png'
    expect(safeThumbUrl(fqdn, 300)).toContain('imageMogr2/thumbnail/300x300')
  })

  /**
   * 路径必须符合 admin 生成的对象键格式（两段、纯 ASCII、无编码）。
   * COS 样式分隔符可配置成 ! _ / -，逐个排除既挡不全，也挡不住 %21 / %2F 编码形态。
   */
  describe('不符合对象键格式的路径一律返回 null', () => {
    const host =
      'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'
    const cases = [
      ['! 分隔符', `${host}/store-covers/a.png!oversize`],
      ['%21 编码形态', `${host}/store-covers/a.png%21oversize`],
      ['%2F 编码形态', `${host}/store-covers/a.png%2Foversize`],
      ['/ 分隔符（三段路径）', `${host}/store-covers/a.png/oversize`],
      ['任意百分号编码', `${host}/store-covers/a%2Ebpng`],
      ['单段路径', `${host}/a.png`],
      // 扩展名锚定顺带挡掉用 - / _ 作分隔符的样式形态
      ['- 分隔符', `${host}/store-covers/a.png-oversize`],
      ['_ 分隔符', `${host}/store-covers/a.png_oversize`],
      ['非图片扩展名', `${host}/store-covers/a.svg`],
      ['无扩展名', `${host}/store-covers/a`],
    ]

    test.each(cases)('%s', (_label, url) => {
      expect(safeThumbUrl(url, 300)).toBeNull()
    })
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

/**
 * issue #230：面积模式（`thumbnail/<Area>@`）—— 为商品详情长图引入。
 *
 * 为什么长图不能用 box：我们真正要封顶的是**解码内存**，而解码内存 = 总像素数 × 4。
 * 面积模式直接约束这个量；box 只是通过边长间接约束它——对长宽比接近 1 的图两者等价，
 * 对长图 box 会过度惩罚。
 *
 * 生产实测（详情图 1737×7065，原图解码 46.8MB）：
 * - `thumbnail/1080x1080` → 266×1080，解码 1.1MB，但在 1290px 屏上放大 4.8 倍（糊）
 * - `thumbnail/2250000@`  → 743×3025，解码 8.6MB，放大 1.7 倍（可接受）
 */
describe('safeThumbUrlByArea', () => {
  const { safeThumbUrlByArea, PRODUCT_DETAIL_IMAGE_MAX_PIXELS } = require('../../utils/image')

  test('COS 图片拼上面积缩略参数', () => {
    expect(safeThumbUrlByArea(COS_URL, 2250000)).toBe(
      `${COS_URL}?imageMogr2/thumbnail/2250000@`
    )
  })

  test('规则不带 `!` —— 实测 `!<Area>@` 在本项目 bucket 上原样返回原图', () => {
    // 写成 `thumbnail/!2250000@` 时数据万象不执行缩放（已对生产图实测），
    // 那等于保护静默失效：URL 看着有参数，返回的却是 46.8MB 的原图。
    const url = safeThumbUrlByArea(COS_URL, 2250000)
    expect(url).not.toContain('!')
    expect(url).toMatch(/imageMogr2\/thumbnail\/\d+@$/)
  })

  test('与 safeThumbUrl 共用同一套准入规则（校验不得分叉）', () => {
    // 两个函数的 URL 校验都走 parseProcessableUrl。这条钉住「两种模式准入一致」，
    // 防止将来有人只给其中一个加/减规则导致漂移。
    const cases = [
      null,
      undefined,
      '',
      '   ',
      42,
      {},
      'ftp://evil.com/a.jpg',
      'https://img.example.com/a.jpg',                                  // 非 COS 域名
      'https://a.tcb.qcloud.la@evil.com/x/a.jpg',                       // userinfo 伪装
      'https://x.tcb.qcloud.la/a.png',                                  // 对象键只有一段
      'https://x.tcb.qcloud.la/dir/a.svg',                              // 非图片扩展名
      'https://x.tcb.qcloud.la/dir/a.png?q-sign-algorithm=sha1',        // 带 COS 签名
    ]
    for (const input of cases) {
      expect(safeThumbUrl(input, 300)).toBeNull()
      expect(safeThumbUrlByArea(input, 2250000)).toBeNull()
    }
  })

  test('maxPixels 非法时返回 null（与 boxSize 同口径）', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '2250000', null, undefined]) {
      expect(safeThumbUrlByArea(COS_URL, bad)).toBeNull()
    }
  })

  test('原 URL 的 query 整串丢弃，放大通道不与服务端规则并存', () => {
    expect(
      safeThumbUrlByArea(`${COS_URL}?imageView2/1/w/50000/h/50000`, 2250000)
    ).toBe(`${COS_URL}?imageMogr2/thumbnail/2250000@`)
  })

  test('幂等：二次施加不会拼出两段规则', () => {
    // invariant：整串丢弃 query 再重写。若有人改成「黑名单剥离 imageMogr2」，
    // 二次应用会拼出 `?imageMogr2/...?imageMogr2/...`，这条立刻转红。
    const once = safeThumbUrlByArea(COS_URL, 2250000)
    expect(safeThumbUrlByArea(once, 2250000)).toBe(once)
    // box 模式同理
    const boxOnce = safeThumbUrl(COS_URL, 300)
    expect(safeThumbUrl(boxOnce, 300)).toBe(boxOnce)
  })

  test('详情长图档位把单张解码内存压到 10MB 以内，且与长宽比无关', () => {
    // 面积模式的关键性质：解码内存恒为 maxPixels×4，不论原图多细长。
    // 一张 100×1,000,000（1 亿像素）的极端细长图同样被压到这个量。
    const bytes = PRODUCT_DETAIL_IMAGE_MAX_PIXELS * 4
    expect(bytes).toBeLessThan(10 * 1024 * 1024)
    // admin 侧 detail_images 上限 9 张 → 详情页长图部分最坏 ≈ 77MB
    expect(bytes * 9).toBeLessThan(80 * 1024 * 1024)
  })
})
