/**
 * reportWxShippingSafe 门控单测
 *
 * 锁定「何时上报 / 何时跳过」与字段装填：
 *   - 未启用 / 支付宝渠道 / 无回调快照 / 缺 acc_trade_no / 缺付款人 openid → 不上报
 *   - 微信渠道 + acc_trade_no + openid → 上报，transactionId 取 acc_trade_no（非拉卡拉流水号），
 *     item_desc 取明细商品名去重拼接
 *   - 上报抛错绝不冒泡（非致命）
 */

// ====== Mock: wx-server-sdk（index.js 顶层 cloud.init 需要）======
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath, filename: wxPath, loaded: true,
  exports: { init: () => {}, DYNAMIC_CURRENT_ENV: 'test-env' },
}

// ====== Mock: ./utils/wx-shipping（控制 isEnabled + 捕获上报调用）======
const wxShippingPath = require.resolve('../utils/wx-shipping')
const mockIsEnabled = vi.fn(() => true)
const mockUpload = vi.fn(async () => ({ errcode: 0, errmsg: 'ok' }))
require.cache[wxShippingPath] = {
  id: wxShippingPath, filename: wxShippingPath, loaded: true,
  exports: {
    isEnabled: (...a) => mockIsEnabled(...a),
    uploadSelfPickupShipping: (...a) => mockUpload(...a),
    rfc3339: () => '2026-06-20T09:00:00+08:00',
    buildSelfPickupPayload: () => ({}),
    LOGISTICS_TYPE_SELF_PICKUP: 4,
  },
}

const { reportWxShippingSafe } = require('../index')

// 假 pg：第一条查 openid，第二条查 sale_items；按 SQL 关键字分流
function makePg({ openid = 'oABC', names = ['护理A', '护理A', '产品B'] } = {}) {
  return {
    query: vi.fn(async (sql) => {
      if (/client_wechat_users/.test(sql)) return { rows: openid ? [{ openid }] : [{ openid: null }] }
      if (/sale_items/.test(sql)) return { rows: names.map((n) => ({ product_name: n })) }
      return { rows: [] }
    }),
  }
}

const WX = { saleOrderId: 'FY-XSD-WX-2606200001', paymentMethod: '微信', tradeInfo: { acc_trade_no: 'wx-txn-9' } }

describe('reportWxShippingSafe 门控', () => {
  beforeEach(() => {
    mockIsEnabled.mockReset().mockReturnValue(true)
    mockUpload.mockReset().mockResolvedValue({ errcode: 0, errmsg: 'ok' })
  })

  it('未启用 → 不上报', async () => {
    mockIsEnabled.mockReturnValue(false)
    await reportWxShippingSafe(makePg(), WX)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('支付宝渠道 → 不上报', async () => {
    await reportWxShippingSafe(makePg(), { ...WX, paymentMethod: '支付宝' })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('无 tradeInfo（callFunction 入口）→ 不上报', async () => {
    await reportWxShippingSafe(makePg(), { ...WX, tradeInfo: null })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('缺 acc_trade_no → 不上报', async () => {
    await reportWxShippingSafe(makePg(), { ...WX, tradeInfo: { trade_no: 'LAK-1' } })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('缺付款人 openid → 不上报', async () => {
    await reportWxShippingSafe(makePg({ openid: null }), WX)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('微信 + acc_trade_no + openid → 上报，transactionId 取 acc_trade_no，item_desc 去重拼接', async () => {
    await reportWxShippingSafe(makePg(), WX)
    expect(mockUpload).toHaveBeenCalledTimes(1)
    const arg = mockUpload.mock.calls[0][0]
    expect(arg.transactionId).toBe('wx-txn-9')   // 微信交易单号，非拉卡拉流水号
    expect(arg.openid).toBe('oABC')
    expect(arg.itemDesc).toBe('护理A、产品B')      // 去重后
  })

  it('明细无商品名 → item_desc 兜底「美容服务」', async () => {
    await reportWxShippingSafe(makePg({ names: [] }), WX)
    expect(mockUpload.mock.calls[0][0].itemDesc).toBe('美容服务')
  })

  it('上报抛错不冒泡（非致命）', async () => {
    mockUpload.mockRejectedValue(new Error('weixin 500'))
    await expect(reportWxShippingSafe(makePg(), WX)).resolves.toBeUndefined()
  })
})
