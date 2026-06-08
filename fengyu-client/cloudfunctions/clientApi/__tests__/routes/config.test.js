/**
 * 系统配置路由测试
 * 覆盖：shareGift（脱敏、关闭/缺失/坏配置回退、默认值 clamp）
 *      consumeAgreement（有配置 / 对象 value / 无记录 / 坏 JSON / title 兜底）
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
