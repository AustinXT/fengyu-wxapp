/**
 * 微信发货定时补偿单测（runShippingBackfill + reportShippingForOrder）
 *
 * 锁定：
 *   - reportShippingForOrder errcode 语义：0/10060002→ok(幂等)，10060001→pending(待重试)，其它→fail
 *   - 无付款人 openid → skip；item_desc 去重拼接 + 缺名兜底
 *   - runShippingBackfill：未启用→不扫描；窗口单逐单上报并汇总；单笔抛错隔离不影响其他单
 */

// ====== Mock: wx-server-sdk（index.js 顶层 cloud.init 需要）======
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath, filename: wxPath, loaded: true,
  exports: { init: () => {}, DYNAMIC_CURRENT_ENV: 'test-env' },
}

// ====== Mock: pg（getPg() 内 require('pg')，让 Pool.query 走 mockQuery）======
const pgPath = require.resolve('pg')
const mockQuery = vi.fn()
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    types: { setTypeParser: () => {} },
    Pool: class { query(...a) { return mockQuery(...a) } },
  },
}

// ====== Mock: ./utils/wx-shipping（控制 isEnabled + 捕获上报返回 errcode）======
const wxShippingPath = require.resolve('../utils/wx-shipping')
const mockIsEnabled = vi.fn(() => true)
const mockUpload = vi.fn(async () => ({ errcode: 0, errmsg: 'ok' }))
require.cache[wxShippingPath] = {
  id: wxShippingPath, filename: wxShippingPath, loaded: true,
  exports: {
    isEnabled: (...a) => mockIsEnabled(...a),
    uploadSelfPickupShipping: (...a) => mockUpload(...a),
    rfc3339: () => '2026-06-24T00:00:00+08:00',
    buildSelfPickupPayload: () => ({}),
    LOGISTICS_TYPE_SELF_PICKUP: 4,
  },
}

const { runShippingBackfill, reportShippingForOrder } = require('../index')

// 假 pg query：按 SQL 关键字分流（窗口扫描 / openid / 商品名）
function setupPg({ orders = [], openid = 'oABC', names = ['护理A', '护理A', '产品B'] } = {}) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM sale_order_payments/.test(sql) && /created_at/.test(sql)) {
      return { rows: orders }                                   // runShippingBackfill 窗口扫描
    }
    if (/client_wechat_users/.test(sql)) {
      return { rows: [{ openid: openid === null ? null : openid }] }
    }
    if (/sale_items/.test(sql)) return { rows: names.map((n) => ({ product_name: n })) }
    return { rows: [] }
  })
}

beforeEach(() => {
  mockIsEnabled.mockReset().mockReturnValue(true)
  mockUpload.mockReset().mockResolvedValue({ errcode: 0, errmsg: 'ok' })
  mockQuery.mockReset()
})

describe('reportShippingForOrder errcode 语义', () => {
  it('errcode 0 → ok，transactionId/openid/itemDesc(去重) 装填正确', async () => {
    setupPg({})
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(res).toEqual({ status: 'ok', errcode: 0 })
    const arg = mockUpload.mock.calls[0][0]
    expect(arg.transactionId).toBe('wx-txn-1')
    expect(arg.openid).toBe('oABC')
    expect(arg.itemDesc).toBe('护理A、产品B')         // 去重后
  })

  it('errcode 10060002（已上报）→ ok 幂等', async () => {
    setupPg({})
    mockUpload.mockResolvedValue({ errcode: 10060002, errmsg: 'already shipped' })
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(res.status).toBe('ok')
  })

  it('errcode 10060001（支付单未同步）→ pending，待重试', async () => {
    setupPg({})
    mockUpload.mockResolvedValue({ errcode: 10060001, errmsg: '支付单不存在' })
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(res.status).toBe('pending')
  })

  it('其它 errcode → fail', async () => {
    setupPg({})
    mockUpload.mockResolvedValue({ errcode: 10060004, errmsg: '不可发货状态' })
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(res.status).toBe('fail')
  })

  it('缺微信交易号 → skip，不调上报', async () => {
    setupPg({})
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', null)
    expect(res.status).toBe('skip')
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('无付款人 openid → skip，不调上报', async () => {
    setupPg({ openid: null })
    const res = await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(res.status).toBe('skip')
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('明细无商品名 → itemDesc 兜底「美容服务」', async () => {
    setupPg({ names: [] })
    await reportShippingForOrder({ query: mockQuery }, 'FY-1', 'wx-txn-1')
    expect(mockUpload.mock.calls[0][0].itemDesc).toBe('美容服务')
  })
})

describe('runShippingBackfill', () => {
  it('未启用 → 不扫描不上报', async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await runShippingBackfill()
    expect(res.message).toMatch(/disabled/)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('空窗口 → scanned=0', async () => {
    setupPg({ orders: [] })
    const res = await runShippingBackfill()
    expect(res.message).toMatch(/scanned=0/)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('窗口 2 单均成功 → ok=2', async () => {
    setupPg({ orders: [
      { sale_order_id: 'FY-1', wx_txn: 'wx-1' },
      { sale_order_id: 'FY-2', wx_txn: 'wx-2' },
    ] })
    const res = await runShippingBackfill()
    expect(res.message).toMatch(/scanned=2 ok=2 pending=0 failed=0/)
    expect(mockUpload).toHaveBeenCalledTimes(2)
  })

  it('窗口单返回 10060001 → 计 pending，不计 failed', async () => {
    setupPg({ orders: [{ sale_order_id: 'FY-1', wx_txn: 'wx-1' }] })
    mockUpload.mockResolvedValue({ errcode: 10060001, errmsg: '支付单不存在' })
    const res = await runShippingBackfill()
    expect(res.message).toMatch(/ok=0 pending=1 failed=0/)
  })

  it('单笔抛错被隔离，不影响其它单（failed=1, ok=1）', async () => {
    setupPg({ orders: [
      { sale_order_id: 'FY-BAD', wx_txn: 'wx-bad' },
      { sale_order_id: 'FY-OK', wx_txn: 'wx-ok' },
    ] })
    // 第一单 upload 抛错，第二单成功
    mockUpload
      .mockRejectedValueOnce(new Error('weixin 500'))
      .mockResolvedValueOnce({ errcode: 0, errmsg: 'ok' })
    const res = await runShippingBackfill()
    expect(res.message).toMatch(/ok=1 pending=0 failed=1/)
    expect(mockUpload).toHaveBeenCalledTimes(2)   // 第一单抛错未阻断第二单
  })
})
