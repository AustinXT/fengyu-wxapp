/**
 * 系统配置路由测试
 * 覆盖：shareGift（脱敏、关闭/缺失/坏配置回退、默认值 clamp）
 *      consumeAgreement（有配置 / 对象 value / 无记录 / 坏 JSON / title 兜底）
 *      banners（URL 构造收回服务端后的下发形态与 fail-closed 分支，issue #231）
 */

const pg = globalThis.__mocks__.pg
const { createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach((key) => {
    if (key.includes('/routes/config')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/config')
})

describe('config.shareGift', () => {
  test('启用配置 → 仅返回脱敏展示字段', async () => {
    pg.query.mockResolvedValueOnce([
      {
        value: JSON.stringify({
          enabled: true,
          percent: 0.2,
          minFaceValue: 5,
          maxFaceValue: 300,
          couponTemplateId: 'tpl-secret',
          validityDays: 60,
          inviterMustHavePaidOrder: true,
          messageInviterTitle: '内部文案',
          messageInviterBody: '内部正文',
        }),
      },
    ])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result).toEqual({
      enabled: true,
      percent: 0.2,
      minFaceValue: 5,
      maxFaceValue: 300,
      validityDays: 60,
    })
    // 运营内部字段绝不外泄
    expect(ctx.result).not.toHaveProperty('couponTemplateId')
    expect(ctx.result).not.toHaveProperty('inviterMustHavePaidOrder')
    expect(ctx.result).not.toHaveProperty('messageInviterTitle')
    expect(ctx.result).not.toHaveProperty('messageInviterBody')
  })

  test('支持 value 为已解析对象（非字符串）', async () => {
    pg.query.mockResolvedValueOnce([
      { value: { enabled: true, percent: 0.1, minFaceValue: 1, maxFaceValue: 100, validityDays: 30 } },
    ])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result.enabled).toBe(true)
    expect(ctx.result.percent).toBe(0.1)
  })

  test('配置缺字段 → 使用默认值', async () => {
    pg.query.mockResolvedValueOnce([{ value: JSON.stringify({ enabled: true }) }])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result).toEqual({
      enabled: true,
      percent: 0.15,
      minFaceValue: 1,
      maxFaceValue: 500,
      validityDays: 90,
    })
  })

  test('显式关闭 → { enabled: false }', async () => {
    pg.query.mockResolvedValueOnce([{ value: JSON.stringify({ enabled: false, percent: 0.3 }) }])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result).toEqual({ enabled: false })
  })

  test('无配置行 → { enabled: false }', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result).toEqual({ enabled: false })
  })

  test('坏 JSON → { enabled: false }', async () => {
    pg.query.mockResolvedValueOnce([{ value: '{ not json' }])

    const ctx = createCtx({})
    await routes.shareGift(ctx)

    expect(ctx.result).toEqual({ enabled: false })
  })
})

describe('config.consumeAgreement', () => {
  test('有配置 → 返回 title/content/v', async () => {
    pg.query.mockResolvedValueOnce([
      { value: JSON.stringify({ title: '凤御服务协议', content: '一、总则\n正文' }), v: 1700000000000 },
    ])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result).toEqual({ title: '凤御服务协议', content: '一、总则\n正文', v: 1700000000000 })
  })

  test('支持 value 为已解析对象（非字符串）', async () => {
    pg.query.mockResolvedValueOnce([{ value: { title: 'T', content: 'C' }, v: 5 }])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result).toEqual({ title: 'T', content: 'C', v: 5 })
  })

  test('无配置行 → 兜底（title 默认 + content 空交前端）', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result).toEqual({ title: '服务消费协议', content: '', v: 0 })
  })

  test('坏 JSON → 兜底', async () => {
    pg.query.mockResolvedValueOnce([{ value: '{ not json', v: 9 }])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result).toEqual({ title: '服务消费协议', content: '', v: 0 })
  })

  test('title 缺失 → 回退默认标题，content 保留原值', async () => {
    pg.query.mockResolvedValueOnce([{ value: JSON.stringify({ content: '仅正文' }), v: 3 }])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result).toEqual({ title: '服务消费协议', content: '仅正文', v: 3 })
  })

  test('title 含空白 → trim 后采用', async () => {
    pg.query.mockResolvedValueOnce([
      { value: JSON.stringify({ title: '  会员服务协议  ', content: 'x' }), v: 1 },
    ])

    const ctx = createCtx({})
    await routes.consumeAgreement(ctx)

    expect(ctx.result.title).toBe('会员服务协议')
  })
})

/**
 * issue #231：banner 的 URL 构造从前端收回服务端。
 *
 * 此前 `config.banners` 只返回 count/v，由 `home.ts` 自己拼
 * `${CDN_BASE}/banner/banner{N}.jpg?v=${v}` —— banner 因此是全站唯一绕开
 * `safeThumbUrl` 防护的图片链路（生产那张 3002×1039 原图直发，解码 11.9MB）。
 *
 * 现在返回已施加缩略规则的完整 URL 列表。两个必须钉死的点：
 * - 下发值**一定**带 `imageMogr2` 规则（绝不退回原图）
 * - 下发值**一定**带 `?v=`（banner 是覆盖式上传，丢了版本号换图不生效）
 */
describe('config.banners（issue #231）', () => {
  const HOST = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'
  const V = 1756620894760

  /** banner_images 存的是 admin 上传原件的**随机名** URL，服务端只借它的 origin */
  const imagesRow = (host = HOST) => ({
    key: 'banner_images',
    value: JSON.stringify([`${host}/fengyu-client/banner/1788156883695-gz1cdm.jpg`]),
    v: V,
  })
  const countRow = (n) => ({ key: 'banner_count', value: String(n), v: V })

  test('下发带缩略规则与版本号的完整 URL，原图不外泄', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([countRow(1), imagesRow()])

    await routes.banners(ctx)

    expect(ctx.result.count).toBe(1)
    expect(ctx.result.v).toBe(V)
    expect(ctx.result.images).toEqual([
      `${HOST}/fengyu-client/banner/banner1.jpg?imageMogr2/thumbnail/1080x1080&v=${V}`,
    ])
  })

  test('按 count 生成固定路径序列（不是 banner_images 里的随机名）', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([countRow(3), imagesRow()])

    await routes.banners(ctx)

    expect(ctx.result.images).toHaveLength(3)
    ctx.result.images.forEach((url, i) => {
      expect(url).toContain(`/fengyu-client/banner/banner${i + 1}.jpg?`)
      expect(url).toContain('imageMogr2/thumbnail/')
      expect(url).toContain(`&v=${V}`)
    })
    // 随机名原件不该出现在下发值里
    expect(ctx.result.images.join()).not.toContain('1788156883695-gz1cdm')
  })

  describe('fail-closed：拼不出合法 URL 就整体返回空数组', () => {
    test('host 不在 COS 白名单', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1), imagesRow('https://evil.example.com')])
      await routes.banners(ctx)
      // count/v 照常返回（前端据此知道"配置了但取不到图"），images 为空
      expect(ctx.result.count).toBe(1)
      expect(ctx.result.images).toEqual([])
    })

    test('banner_images 是坏 JSON', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1), { key: 'banner_images', value: '{oops', v: V }])
      await routes.banners(ctx)
      expect(ctx.result.images).toEqual([])
    })

    test('banner_images 是空数组', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1), { key: 'banner_images', value: '[]', v: V }])
      await routes.banners(ctx)
      expect(ctx.result.images).toEqual([])
    })

    test('完全没有 banner_images 行', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1)])
      await routes.banners(ctx)
      expect(ctx.result.images).toEqual([])
    })

    test('count=0', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(0), imagesRow()])
      await routes.banners(ctx)
      expect(ctx.result.count).toBe(0)
      expect(ctx.result.images).toEqual([])
    })

    test('无任何配置行', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([])
      await routes.banners(ctx)
      expect(ctx.result).toEqual({ count: 0, v: 0, images: [] })
    })
  })

  test('无 banner_count 时按 banner_images 长度兜底（原有行为保留）', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([{
      key: 'banner_images',
      value: JSON.stringify([
        `${HOST}/fengyu-client/banner/a.jpg`,
        `${HOST}/fengyu-client/banner/b.jpg`,
      ]),
      v: V,
    }])

    await routes.banners(ctx)

    expect(ctx.result.count).toBe(2)
    expect(ctx.result.images).toHaveLength(2)
  })

  test('任何下发值都不得是未经处理的原图 URL', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([countRow(2), imagesRow()])
    await routes.banners(ctx)
    expect(ctx.result.images).toHaveLength(2)
    for (const url of ctx.result.images) {
      expect(url).toContain('imageMogr2/thumbnail/')
      expect(url).toMatch(/&v=\d+$/)
    }
  })
})
