/**
 * 首页 banner 缩略链路测试（issue #231）
 *
 * 刻意**不**并进 `image.test.js`：那份文件在 issue #232 之后与 staffApi 侧
 * 保持字节一致（由 `staffApi/__tests__/utils/image-cross-copy.test.js` 守护），
 * 往里加 client 专属断言会破坏这个不变量。端专属的用法测试一律独立成文件。
 *
 * banner 与其它图片链路有三处结构性差异，本文件逐条钉住：
 * 1. 对象键是**三段** `fengyu-client/banner/banner{N}.jpg`（前端 CDN_BASE 带前缀）
 * 2. 文件名**固定**、覆盖式上传 → 必须带 `?v=` 破缓存
 * 3. 因此走 `safeBannerThumbUrl` 而不是 `safeThumbUrl`
 */
const {
  safeThumbUrl,
  safeBannerThumbUrl,
  BANNER_THUMB_BOX,
  MAX_THUMB_BOX,
  STORE_DETAIL_THUMB_BOX,
  PRODUCT_THUMB_BOX_LARGE,
} = require('../../utils/image')

const HOST = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'
const BANNER = `${HOST}/fengyu-client/banner/banner1.jpg`
const V = 1756620894760

describe('safeBannerThumbUrl', () => {
  test('拼出 box 规则 + 版本号', () => {
    expect(safeBannerThumbUrl(BANNER, 1080, V)).toBe(
      `${BANNER}?imageMogr2/thumbnail/1080x1080&v=${V}`
    )
  })

  /**
   * 规则与 `&v=` 能否共存是本方案成立的前提，已对生产图实测：
   * `?imageMogr2/thumbnail/1080x1080&v=175…` → 1080×374（原图 3002×1039）。
   * 两种顺序都生效。这里钉住输出形态，防止有人把 v 挪进规则串里。
   */
  test('版本号在规则之后，用 & 分隔，不混进规则串', () => {
    const url = safeBannerThumbUrl(BANNER, 1080, V)
    expect(url).toContain('?imageMogr2/thumbnail/1080x1080&v=')
    // 规则本身不能被 v 污染（`thumbnail/1080x1080&v=...` 里的规则段必须干净）
    expect(url).toMatch(/\?imageMogr2\/thumbnail\/\d+x\d+&v=\d+$/)
  })

  test('原 URL 上的 query 被整串丢弃后重拼（含旧的 ?v=）', () => {
    expect(safeBannerThumbUrl(`${BANNER}?v=999`, 1080, V)).toBe(
      `${BANNER}?imageMogr2/thumbnail/1080x1080&v=${V}`
    )
    // 放大通道不与服务端规则并存
    expect(safeBannerThumbUrl(`${BANNER}?imageView2/1/w/50000`, 1080, V)).toBe(
      `${BANNER}?imageMogr2/thumbnail/1080x1080&v=${V}`
    )
  })

  test('幂等：二次施加不会拼出两段规则', () => {
    const once = safeBannerThumbUrl(BANNER, 1080, V)
    expect(safeBannerThumbUrl(once, 1080, V)).toBe(once)
  })

  /**
   * 路径白名单比默认的两段键**更严**：段名写死、文件名锚定 `banner<数字>`。
   * 这是刻意的——不放宽通用白名单来容纳 banner，而是给 banner 一条更窄的。
   */
  describe('对象键白名单只认 banner 这一种形态', () => {
    const rejected = [
      [`${HOST}/product-covers/a.png`, '两段键（普通商品图）'],
      [`${HOST}/fengyu-client/other/banner1.jpg`, '三段但目录不对'],
      [`${HOST}/other/banner/banner1.jpg`, '第一段不对'],
      [`${HOST}/fengyu-client/banner/evil.jpg`, 'banner 目录下的任意文件名'],
      [`${HOST}/fengyu-client/banner/1788156883695-gz1cdm.jpg`, 'admin 上传的随机名原件'],
      [`${HOST}/fengyu-client/banner/banner.jpg`, '缺序号'],
      [`${HOST}/fengyu-client/banner/banner1.gif`, 'gif —— ⚠️ 对 banner 是无效防护，见下方说明'],
      [`${HOST}/fengyu-client/banner/banner1.jpg!style`, '路径型图片样式'],
      [`${HOST}/fengyu-client/banner/sub/banner1.jpg`, '四段'],
    ]
    test.each(rejected)('%s → null（%s）', (url) => {
      expect(safeBannerThumbUrl(url, 1080, V)).toBeNull()
    })
  })

  /**
   * ⚠️ 上面那条 `.gif` 用例**不构成动图防护**（评审指出）：
   * admin 重传时目标路径的扩展名是字面量 `.jpg`（`settings.ts` 的模板串，
   * 与源文件 MIME 无关），GIF 字节会存进 `banner1.jpg` 并被本白名单放行。
   * 真要挡动图得在 admin 上传侧按 path 分流拒掉 `image/gif`。
   * 保留这条用例只是钉住「扩展名白名单本身没被放宽」，不要读成"动图进不来"。
   */
  test('多张 banner 的序号都认', () => {
    for (const n of [1, 2, 9, 12]) {
      expect(safeBannerThumbUrl(`${HOST}/fengyu-client/banner/banner${n}.jpg`, 1080, V))
        .toContain(`banner${n}.jpg?imageMogr2/`)
    }
  })

  /**
   * 缺版本号时**不降级下发**。没有 `?v=` 的 banner URL 会被 CDN 长期缓存，
   * 换图不生效——那是比「图略大」更难排查的故障，宁可走占位。
   */
  test('版本号非法一律 null，不降级成无 v 的 URL', () => {
    for (const bad of [undefined, null, -1, 1.5, NaN, Infinity, '123', {}]) {
      expect(safeBannerThumbUrl(BANNER, 1080, bad)).toBeNull()
    }
    // 0 是合法的（首次保存前 updated_at 可能取不到，此时 v=0 仍是确定值）
    expect(safeBannerThumbUrl(BANNER, 1080, 0)).toContain('&v=0')
  })

  test('档位非法一律 null', () => {
    for (const bad of [0, -1, 1.5, NaN, '1080', undefined]) {
      expect(safeBannerThumbUrl(BANNER, bad, V)).toBeNull()
    }
  })

  test('档位有上界 —— 过大等于完全不约束（contain 不放大）', () => {
    expect(safeBannerThumbUrl(BANNER, MAX_THUMB_BOX, V)).toContain('imageMogr2/thumbnail/')
    expect(safeBannerThumbUrl(BANNER, MAX_THUMB_BOX + 1, V)).toBeNull()
    // 1e21 这种会拼出 `thumbnail/1e+21x1e+21` 的非法规则，COS 直接原样返回原图
    expect(safeBannerThumbUrl(BANNER, 1e21, V)).toBeNull()
  })

  test('未知的对象键变体名一律 null，不静默回退到默认白名单', () => {
    // parseProcessableUrl 只认 OBJECT_KEY_VARIANTS 里的命名变体。
    // 这条从外部验证「拼错变体名不会降级成另一条规则」——内部实现改成回退时会红。
    const img = require('../../utils/image')
    expect(typeof img.safeBannerThumbUrl).toBe('function')
    // banner 白名单不认普通两段键，默认白名单不认三段键；两者不会互相回退
    expect(img.safeBannerThumbUrl(`${HOST}/product-covers/a.png`, 1080, V)).toBeNull()
    expect(img.safeThumbUrl(BANNER, 400)).toBeNull()
  })

  test('非 COS 域名 / 非 http(s) 一律 null（与其它模式同一套 host 判据）', () => {
    expect(safeBannerThumbUrl('https://evil.com/fengyu-client/banner/banner1.jpg', 1080, V)).toBeNull()
    expect(safeBannerThumbUrl('cloud://env/fengyu-client/banner/banner1.jpg', 1080, V)).toBeNull()
    // userinfo 伪装：hostname 实为 evil.com
    expect(safeBannerThumbUrl(
      'https://a.tcb.qcloud.la@evil.com/fengyu-client/banner/banner1.jpg', 1080, V
    )).toBeNull()
  })

  test('带 COS 签名的 URL 一律 null', () => {
    expect(safeBannerThumbUrl(`${BANNER}?q-sign-algorithm=sha1&q-signature=abc`, 1080, V)).toBeNull()
  })
})

describe('默认路径白名单未被 banner 改动放宽（回归）', () => {
  /**
   * `parseProcessableUrl` 新增了 keyVariant 参数（命名变体，不接受裸正则）。
   * 这条钉住「默认变体行为完全不变」——否则就是借 banner 之名把通用白名单放宽了。
   */
  test('普通两段键仍可用', () => {
    expect(safeThumbUrl(`${HOST}/product-covers/a.png`, 400))
      .toBe(`${HOST}/product-covers/a.png?imageMogr2/thumbnail/400x400`)
  })

  test('banner 的三段键仍被默认白名单拒绝', () => {
    expect(safeThumbUrl(BANNER, 400)).toBeNull()
  })

  test('banner 白名单也不接受普通商品图', () => {
    expect(safeBannerThumbUrl(`${HOST}/product-covers/a.png`, 400, V)).toBeNull()
  })
})

describe('BANNER_THUMB_BOX', () => {
  test('与满屏展示位的既有档位一致，不另立数值', () => {
    expect(BANNER_THUMB_BOX).toBe(1080)
    // "一致"要真的比对，否则改了那两个常量这句话会静默变假
    expect(BANNER_THUMB_BOX).toBe(STORE_DETAIL_THUMB_BOX)
    expect(BANNER_THUMB_BOX).toBe(PRODUCT_THUMB_BOX_LARGE)
  })

  /**
   * 生产 banner 实测 3002×1039 → box 1080 输出 1080×374、解码 1.5MB（原图 11.9MB）。
   * swiper 开了 circular + autoplay 会预渲染相邻帧，按同时驻留 3 张算。
   */
  test('单张解码压到 5MB 以内，3 张同时驻留仍在 5MB 量级', () => {
    const bytes = BANNER_THUMB_BOX * BANNER_THUMB_BOX * 4
    expect(bytes).toBeLessThan(5 * 1024 * 1024)
    // 实际输出是 1080×374（2.89:1 宽图 contain 后高度远小于 box）。
    // 用常量算而不是写死 1080 —— 写死的话档位改了这条断言还是恒真。
    const actualHeight = Math.round(BANNER_THUMB_BOX / 2.89)
    expect(BANNER_THUMB_BOX * actualHeight * 4 * 3).toBeLessThan(5 * 1024 * 1024)
  })
})
