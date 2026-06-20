/**
 * wx-shipping 纯函数单测
 *
 * 锁定微信「发货信息管理」上报的核心字段契约（拉卡拉服务商收单的关键约定）：
 *   - order_number_type=2 + transaction_id（用微信交易单号，不是商户单号）
 *   - logistics_type=4（用户自提，无需物流单号）
 *   - shipping_list[].item_desc / payer.openid
 *   - isEnabled 双条件门控；rfc3339 +08:00 格式
 */

const wxShipping = require('../utils/wx-shipping')

describe('wx-shipping.isEnabled', () => {
  const savedEnabled = process.env.WX_SHIPPING_ENABLED
  const savedSecret = process.env.CLIENT_APPSECRET
  afterEach(() => {
    process.env.WX_SHIPPING_ENABLED = savedEnabled
    process.env.CLIENT_APPSECRET = savedSecret
  })

  it('两条件齐全才启用', () => {
    process.env.WX_SHIPPING_ENABLED = 'true'
    process.env.CLIENT_APPSECRET = 'fake-secret'
    expect(wxShipping.isEnabled()).toBe(true)
  })

  it('flag 未开 → 关闭', () => {
    process.env.WX_SHIPPING_ENABLED = 'false'
    process.env.CLIENT_APPSECRET = 'fake-secret'
    expect(wxShipping.isEnabled()).toBe(false)
  })

  it('flag 缺省 → 关闭', () => {
    delete process.env.WX_SHIPPING_ENABLED
    process.env.CLIENT_APPSECRET = 'fake-secret'
    expect(wxShipping.isEnabled()).toBe(false)
  })
})

describe('wx-shipping.rfc3339', () => {
  it('输出 +08:00 RFC3339 字面（按进程东八区墙钟）', () => {
    // 进程 TZ 默认随机；直接断言格式而非具体时刻
    const s = wxShipping.rfc3339(new Date('2026-06-20T10:11:12+08:00'))
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  })
})

describe('wx-shipping.buildSelfPickupPayload', () => {
  it('用户自提字段契约：order_number_type=2 + transaction_id + logistics_type=4', () => {
    const payload = wxShipping.buildSelfPickupPayload({
      transactionId: '4500000198202606185828616740',
      openid: 'oABC123',
      itemDesc: '蜜语水润嫩肤护理、家居洁面乳',
      now: new Date('2026-06-20T09:00:00+08:00'),
    })
    expect(payload.order_key).toEqual({
      order_number_type: 2,
      transaction_id: '4500000198202606185828616740',
    })
    expect(payload.logistics_type).toBe(4)
    expect(payload.delivery_mode).toBe(1)
    expect(payload.shipping_list).toEqual([{ item_desc: '蜜语水润嫩肤护理、家居洁面乳' }])
    expect(payload.payer).toEqual({ openid: 'oABC123' })
    expect(payload.upload_time).toMatch(/\+08:00$/)
    // 自提无需物流单号 / 快递公司
    expect(payload.shipping_list[0].tracking_no).toBeUndefined()
    expect(payload.shipping_list[0].express_company).toBeUndefined()
  })
})
