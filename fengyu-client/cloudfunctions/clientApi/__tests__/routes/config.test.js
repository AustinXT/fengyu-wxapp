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

  /**
   * host 用写死的 COS_BASE，**不从 banner_images 取**（评审指出的 P1）。
   * banner_images 是 admin 可写且无校验的字段；拿它当 host 来源等于让持 system:config
   * 的账号把全量顾客的首页图源指到任意同后缀的桶，而 host 白名单只做后缀匹配、拦不住。
   * 下面几条正面证明这条攻击面已经不存在。
   */
  describe('banner_images 不参与 URL 构造（host 来源已钉死）', () => {
    const unaffected = [
      ['指向另一个桶', 'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la/x/y.jpg'],
      ['指向站外域名', 'https://evil.example.com/fengyu-client/banner/x.jpg'],
    ]
    test.each(unaffected)('banner_images %s → 下发仍走 COS_BASE', async (_label, url) => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1), { key: 'banner_images', value: JSON.stringify([url]), v: V }])

      await routes.banners(ctx)

      expect(ctx.result.images).toEqual([
        `${HOST}/fengyu-client/banner/banner1.jpg?imageMogr2/thumbnail/1080x1080&v=${V}`,
      ])
    })

    test.each([
      ['坏 JSON', '{oops'],
      ['空数组', '[]'],
    ])('banner_images 是%s → 有 banner_count 时不影响下发', async (_label, value) => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1), { key: 'banner_images', value, v: V }])
      await routes.banners(ctx)
      expect(ctx.result.images).toHaveLength(1)
    })

    test('完全没有 banner_images 行 → 不影响下发', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(1)])
      await routes.banners(ctx)
      expect(ctx.result.images).toHaveLength(1)
    })
  })

  describe('fail-closed / 边界', () => {
    test('count=0 → 空数组', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(0), imagesRow()])
      await routes.banners(ctx)
      expect(ctx.result.count).toBe(0)
      expect(ctx.result.images).toEqual([])
    })

    test('count 为负 → 空数组（不进循环）', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(-5), imagesRow()])
      await routes.banners(ctx)
      expect(ctx.result.images).toEqual([])
    })

    test('无任何配置行', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([])
      await routes.banners(ctx)
      expect(ctx.result).toEqual({ count: 0, v: 0, images: [] })
    })

    /**
     * `banner_count` 是裸 text、admin 侧无长度校验，而它现在是循环上界。
     * 不 clamp 的话 `999999` 会让这个**公开未认证接口**生成 99 万条 URL
     * （评审实测响应体 150MB / 云函数 OOM）。
     */
    test('count 失控（999999）被 clamp 到上限，不生成巨响应', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([countRow(999999), imagesRow()])

      await routes.banners(ctx)

      expect(ctx.result.images).toHaveLength(20)
      // ⚠️ `count` 也必须是 clamp 后的值。只 clamp 循环上界是不够的：
      // 存量客户端读的正是这个 count，拿到 999999 会 Array.from({length:999999})
      // 构造 99 万个 banner 对象 —— 服务端保护了自己却打挂旧版小程序。
      expect(ctx.result.count).toBe(20)
      expect(JSON.stringify(ctx.result).length).toBeLessThan(10 * 1024)
    })

    /**
     * v 来自 `EXTRACT(EPOCH FROM updated_at)*1000`，理论上不会是负数，
     * 但真出现时必须整体放弃：没有 `?v=` 的 banner URL 会被 CDN 长期缓存，换图不生效。
     */
    test('版本号非法 → 整体空数组（不降级成无 v 的 URL）', async () => {
      const ctx = createCtx()
      pg.query.mockResolvedValueOnce([{ key: 'banner_count', value: '2', v: -100 }])
      await routes.banners(ctx)
      expect(ctx.result.images).toEqual([])
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
