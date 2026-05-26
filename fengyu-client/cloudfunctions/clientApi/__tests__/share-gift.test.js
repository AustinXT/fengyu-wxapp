/**
 * grantShareGift 单元测试
 *
 * 覆盖 ticket §8 的 12 种路径：
 *   no_paid_amount / no_config / bad_config / disabled /
 *   not_first_order / no_inviter / inviter_not_qualified / template_unavailable /
 *   granted(happy path) / 幂等 / clamp 下限 / clamp 上限
 *
 * 额外覆盖：消息标题为空跳过该条、文案占位符渲染、
 *   validity_mode='days' / 'fixed' / 兜底、config.value 为对象（非字符串）
 */

const { grantShareGift } = require('../share-gift')

// ──────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────

/** 顺序 mock pg client，超出 results 后返回默认空行 */
function makeClient(...results) {
  const q = vi.fn()
  for (const r of results) q.mockResolvedValueOnce(r)
  q.mockResolvedValue({ rows: [], rowCount: 0 })
  return { query: q }
}

const BASE_CFG = {
  enabled: true,
  percent: 0.15,
  minFaceValue: 1,
  maxFaceValue: 500,
  couponTemplateId: 'tpl-001',
  validityDays: 90,
  inviterMustHavePaidOrder: false,
  messageInviterTitle: '分享礼到账',
  messageInviterBody: '您邀请的新客首单 ¥{paidAmount}，券 ¥{couponValue}，{validityDays}天内有效',
  messageInviteeTitle: '新客首单回馈',
  messageInviteeBody: '感谢分享，券 ¥{couponValue}，{validityDays}天内有效',
}

const BASE_ORDER = {
  saleOrderId: 'FY-XSD-WX-2604240001',
  clientUserId: 'FYGK-20260424-00002',
  paidAmount: 100,
  source: 'payNotify',
}

const INVITER_ID = 'FYGK-20260424-00001'

/** 辅助：产生 system_configs 行（JSON 字符串） */
function cfgRow(overrides = {}) {
  return { rows: [{ value: JSON.stringify({ ...BASE_CFG, ...overrides }) }] }
}
/** 辅助：产生 system_configs 行（对象，非字符串，测试 typeof 分支） */
function cfgRowObj(overrides = {}) {
  return { rows: [{ value: { ...BASE_CFG, ...overrides } }] }
}
function firstOrder(count = 0) {
  return { rows: [{ c: count }] }
}
function inviterResult(userId = INVITER_ID) {
  return { rows: [{ inviter_user_id: userId }] }
}
function noInviter() {
  return { rows: [{ inviter_user_id: null }] }
}
function tplRow(overrides = {}) {
  return {
    rows: [{
      template_id: 'tpl-001',
      is_active: true,
      validity_mode: 'days',
      valid_days: 90,
      valid_to: null,
      ...overrides,
    }],
  }
}

// 标准 happy path 从第 1 步到第 10 步所需的 mock 序列
function happyPathClient(cfgOverride = {}, tplOverride = {}) {
  return makeClient(
    cfgRow(cfgOverride),      // 1. SELECT system_configs
    firstOrder(0),            // 2. COUNT(*) = 0 → 首单
    inviterResult(),          // 3. SELECT inviter_user_id
                              // 4. (inviterMustHavePaidOrder=false，跳过)
    tplRow(tplOverride),      // 5. SELECT coupon_templates
    { rowCount: 1 },          // 6. INSERT user_coupons (inviter)
    { rowCount: 1 },          // 7. INSERT user_coupons (invitee)
    { rowCount: 1 },          // 8. INSERT messages (inviter)
    { rowCount: 1 },          // 9. INSERT messages (invitee)
    { rowCount: 1 },          // 10. INSERT operation_logs
  )
}

// ──────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────

describe('grantShareGift — no_paid_amount', () => {
  test('paidAmount = 0 → granted:false', async () => {
    const c = makeClient()
    const r = await grantShareGift(c, { ...BASE_ORDER, paidAmount: 0 })
    expect(r).toEqual({ granted: false, reason: 'no_paid_amount' })
    expect(c.query).not.toHaveBeenCalled()
  })

  test('paidAmount 负数 → granted:false', async () => {
    const c = makeClient()
    const r = await grantShareGift(c, { ...BASE_ORDER, paidAmount: -10 })
    expect(r).toEqual({ granted: false, reason: 'no_paid_amount' })
  })

  test('clientUserId 缺失 → granted:false', async () => {
    const c = makeClient()
    const r = await grantShareGift(c, { saleOrderId: 'x', paidAmount: 100 })
    expect(r).toEqual({ granted: false, reason: 'no_paid_amount' })
  })

  test('saleOrderId 缺失 → granted:false', async () => {
    const c = makeClient()
    const r = await grantShareGift(c, { clientUserId: 'u', paidAmount: 100 })
    expect(r).toEqual({ granted: false, reason: 'no_paid_amount' })
  })

  test('order = null → granted:false', async () => {
    const c = makeClient()
    const r = await grantShareGift(c, null)
    expect(r).toEqual({ granted: false, reason: 'no_paid_amount' })
  })
})

describe('grantShareGift — no_config', () => {
  test('system_configs 无 share_gift_config 行 → granted:false', async () => {
    const c = makeClient({ rows: [] })
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'no_config' })
  })

  test('rows[0].value 为空字符串 → granted:false', async () => {
    const c = makeClient({ rows: [{ value: '' }] })
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'no_config' })
  })
})

describe('grantShareGift — bad_config', () => {
  test('value 为非法 JSON → granted:false', async () => {
    const c = makeClient({ rows: [{ value: '{broken' }] })
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'bad_config' })
  })
})

describe('grantShareGift — disabled', () => {
  test('cfg.enabled = false → granted:false', async () => {
    const c = makeClient(cfgRow({ enabled: false }))
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'disabled' })
    expect(c.query).toHaveBeenCalledTimes(1)
  })

  test('cfg.couponTemplateId 为空 → granted:false', async () => {
    const c = makeClient(cfgRow({ couponTemplateId: '' }))
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'disabled' })
  })

  test('config.value 为对象（非字符串）且 enabled=false → granted:false', async () => {
    const c = makeClient(cfgRowObj({ enabled: false }))
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'disabled' })
  })
})

describe('grantShareGift — not_first_order', () => {
  test('COUNT(*)=1（已有其他结清订单）→ granted:false', async () => {
    const c = makeClient(cfgRow(), firstOrder(1))
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'not_first_order' })
  })

  test('COUNT(*)=5 → granted:false', async () => {
    const c = makeClient(cfgRow(), firstOrder(5))
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'not_first_order' })
  })

  test('首单判定 SQL 包含 sale_order_id <> $2', async () => {
    const c = makeClient(cfgRow(), firstOrder(1))
    await grantShareGift(c, BASE_ORDER)
    const sql = c.query.mock.calls[1][0]
    expect(sql).toContain('sale_order_id <> $2')
    const params = c.query.mock.calls[1][1]
    expect(params).toEqual([BASE_ORDER.clientUserId, BASE_ORDER.saleOrderId])
  })
})

describe('grantShareGift — no_inviter', () => {
  test('inviter_user_id = null → granted:false', async () => {
    const c = makeClient(cfgRow(), firstOrder(0), noInviter())
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'no_inviter' })
  })

  test('client_wechat_users 无该用户行 → granted:false', async () => {
    const c = makeClient(cfgRow(), firstOrder(0), { rows: [] })
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'no_inviter' })
  })
})

describe('grantShareGift — inviter_not_qualified', () => {
  test('inviterMustHavePaidOrder=true 且邀请人无结清订单 → granted:false', async () => {
    const c = makeClient(
      cfgRow({ inviterMustHavePaidOrder: true }),
      firstOrder(0),
      inviterResult(),
      { rows: [] },   // 邀请人无结清订单
    )
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'inviter_not_qualified' })
  })

  test('inviterMustHavePaidOrder=true 且邀请人有结清订单 → 继续发放', async () => {
    const c = makeClient(
      cfgRow({ inviterMustHavePaidOrder: true }),
      firstOrder(0),
      inviterResult(),
      { rows: [{ 1: 1 }] },   // 邀请人有结清订单
      tplRow(),
      { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 },
    )
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r.granted).toBe(true)
  })
})

describe('grantShareGift — template_unavailable', () => {
  test('模板不存在 → granted:false', async () => {
    const c = makeClient(cfgRow(), firstOrder(0), inviterResult(), { rows: [] })
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'template_unavailable' })
  })

  test('模板存在但 is_active=false → granted:false', async () => {
    const c = makeClient(
      cfgRow(), firstOrder(0), inviterResult(),
      tplRow({ is_active: false }),
    )
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r).toEqual({ granted: false, reason: 'template_unavailable' })
  })
})

describe('grantShareGift — granted (happy path)', () => {
  test('正常发放：返回 granted:true + value + inviter', async () => {
    const c = happyPathClient()
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r.granted).toBe(true)
    expect(r.inviter).toBe(INVITER_ID)
    expect(typeof r.value).toBe('number')
    expect(r.value).toBeGreaterThan(0)
  })

  test('发起 9 次 DB 查询（config+首单+inviter+模板+券×2+消息×2+log；inviterMustHavePaidOrder=false 时资格查询跳过）', async () => {
    const c = happyPathClient()
    await grantShareGift(c, BASE_ORDER)
    expect(c.query).toHaveBeenCalledTimes(9)
  })

  test('user_coupons INSERT 使用 sg-inviter-<orderId> / sg-invitee-<orderId>', async () => {
    const c = happyPathClient()
    await grantShareGift(c, BASE_ORDER)
    const couponCalls = c.query.mock.calls.filter(
      ([sql]) => sql && sql.includes('user_coupons'),
    )
    expect(couponCalls).toHaveLength(2)
    expect(couponCalls[0][1][0]).toBe(`sg-inviter-${BASE_ORDER.saleOrderId}`)
    expect(couponCalls[1][1][0]).toBe(`sg-invitee-${BASE_ORDER.saleOrderId}`)
  })

  test('messages INSERT 使用幂等键 sg-msg-inviter / sg-msg-invitee', async () => {
    const c = happyPathClient()
    await grantShareGift(c, BASE_ORDER)
    const msgCalls = c.query.mock.calls.filter(
      ([sql]) => sql && sql.includes('messages'),
    )
    expect(msgCalls).toHaveLength(2)
    expect(msgCalls[0][1][3]).toBe(`sg-msg-inviter-${BASE_ORDER.saleOrderId}`)
    expect(msgCalls[1][1][3]).toBe(`sg-msg-invitee-${BASE_ORDER.saleOrderId}`)
  })

  test('operation_logs INSERT action = share.giftGranted', async () => {
    const c = happyPathClient()
    await grantShareGift(c, BASE_ORDER)
    const logCall = c.query.mock.calls.find(
      ([sql]) => sql && sql.includes('operation_logs'),
    )
    expect(logCall).toBeDefined()
    expect(logCall[1][0]).toBe(BASE_ORDER.saleOrderId)
    const detail = JSON.parse(logCall[1][1])
    expect(detail._v).toBe(1)
    expect(detail.inviter).toBe(INVITER_ID)
    expect(detail.invitee).toBe(BASE_ORDER.clientUserId)
  })

  test('face_value_override = paid×percent（100×0.15=15）', async () => {
    const c = happyPathClient()
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r.value).toBe(15)
    // 检查 INSERT user_coupons 第 5 个参数（face_value_override）
    const couponCall = c.query.mock.calls.find(
      ([sql]) => sql && sql.includes('user_coupons'),
    )
    expect(couponCall[1][4]).toBe(15)
  })
})

describe('grantShareGift — 幂等', () => {
  test('同一 orderId 第二次调用：ON CONFLICT DO NOTHING，仍返回 granted:true', async () => {
    // 第一次
    const c1 = happyPathClient()
    const r1 = await grantShareGift(c1, BASE_ORDER)
    expect(r1.granted).toBe(true)

    // 第二次（rowCount=0 模拟冲突跳过）
    const c2 = makeClient(
      cfgRow(), firstOrder(0), inviterResult(), tplRow(),
      { rowCount: 0 }, { rowCount: 0 },   // 券冲突
      { rowCount: 0 }, { rowCount: 0 },   // 消息冲突
      { rowCount: 0 },                     // log 冲突（如有唯一索引）
    )
    const r2 = await grantShareGift(c2, BASE_ORDER)
    expect(r2.granted).toBe(true)
    // 两次调用的 value 应一致
    expect(r2.value).toBe(r1.value)
  })
})

describe('grantShareGift — clamp', () => {
  test('计算值 < minFaceValue → face_value_override = minFaceValue', async () => {
    // paidAmount=5, percent=0.15 → 0.75 < min=1 → value=1
    const c = happyPathClient({ minFaceValue: 1, maxFaceValue: 500 })
    const r = await grantShareGift(c, { ...BASE_ORDER, paidAmount: 5 })
    expect(r.value).toBe(1)
  })

  test('计算值 > maxFaceValue → face_value_override = maxFaceValue', async () => {
    // paidAmount=10000, percent=0.15 → 1500 > max=500 → value=500
    const c = happyPathClient({ minFaceValue: 1, maxFaceValue: 500 })
    const r = await grantShareGift(c, { ...BASE_ORDER, paidAmount: 10000 })
    expect(r.value).toBe(500)
  })

  test('计算值在区间内 → 精确保留 2 位小数', async () => {
    // paidAmount=99, percent=0.15 → 14.85
    const c = happyPathClient()
    const r = await grantShareGift(c, { ...BASE_ORDER, paidAmount: 99 })
    expect(r.value).toBe(14.85)
  })
})

describe('grantShareGift — 消息文案', () => {
  test('messageInviterTitle 为空 → 跳过邀请人消息，仅 1 条消息 INSERT', async () => {
    const c = makeClient(
      cfgRow({ messageInviterTitle: '' }),
      firstOrder(0), inviterResult(), tplRow(),
      { rowCount: 1 }, { rowCount: 1 },   // 券 ×2
      { rowCount: 1 },                     // 仅新客消息
      { rowCount: 1 },                     // operation_logs
    )
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r.granted).toBe(true)
    const msgCalls = c.query.mock.calls.filter(
      ([sql]) => sql && sql.includes('messages'),
    )
    expect(msgCalls).toHaveLength(1)
    expect(msgCalls[0][1][3]).toBe(`sg-msg-invitee-${BASE_ORDER.saleOrderId}`)
  })

  test('messageInviteeTitle 为空 → 跳过新客消息，仅 1 条消息 INSERT', async () => {
    const c = makeClient(
      cfgRow({ messageInviteeTitle: '' }),
      firstOrder(0), inviterResult(), tplRow(),
      { rowCount: 1 }, { rowCount: 1 },
      { rowCount: 1 },   // 仅邀请人消息
      { rowCount: 1 },
    )
    const r = await grantShareGift(c, BASE_ORDER)
    expect(r.granted).toBe(true)
    const msgCalls = c.query.mock.calls.filter(
      ([sql]) => sql && sql.includes('messages'),
    )
    expect(msgCalls).toHaveLength(1)
    expect(msgCalls[0][1][3]).toBe(`sg-msg-inviter-${BASE_ORDER.saleOrderId}`)
  })

  test('占位符 {paidAmount}/{couponValue}/{validityDays} 被替换', async () => {
    const c = happyPathClient()
    await grantShareGift(c, { ...BASE_ORDER, paidAmount: 99 })
    const msgCalls = c.query.mock.calls.filter(
      ([sql]) => sql && sql.includes('messages'),
    )
    const inviterBody = msgCalls[0][1][2]  // body 参数（第 3 个）
    expect(inviterBody).toContain('99.00')
    expect(inviterBody).toContain('14.85')
    expect(inviterBody).not.toContain('{paidAmount}')
    expect(inviterBody).not.toContain('{couponValue}')
  })
})

describe('grantShareGift — expireAt 计算', () => {
  test('validity_mode=days → 从 NOW() 推 valid_days 天', async () => {
    const before = Date.now()
    const c = happyPathClient({}, { validity_mode: 'days', valid_days: 30, valid_to: null })
    await grantShareGift(c, BASE_ORDER)
    const after = Date.now()

    const couponCall = c.query.mock.calls.find(
      ([sql]) => sql && sql.includes('user_coupons'),
    )
    const expireAt = couponCall[1][3]
    expect(expireAt).toBeInstanceOf(Date)
    const diff = expireAt.getTime() - before
    // 约 30 天的毫秒数，允许 1 秒误差
    expect(diff).toBeGreaterThanOrEqual(30 * 86400000 - 1000)
    expect(diff).toBeLessThanOrEqual(30 * 86400000 + (after - before) + 1000)
  })

  test('validity_mode=fixed → 使用模板 valid_to', async () => {
    const fixedDate = new Date('2027-01-01T00:00:00Z')
    const c = happyPathClient(
      {},
      { validity_mode: 'fixed', valid_days: null, valid_to: fixedDate.toISOString() },
    )
    await grantShareGift(c, BASE_ORDER)
    const couponCall = c.query.mock.calls.find(
      ([sql]) => sql && sql.includes('user_coupons'),
    )
    const expireAt = couponCall[1][3]
    expect(new Date(expireAt).getTime()).toBe(fixedDate.getTime())
  })

  test('两种模式均缺失 → 用 cfg.validityDays 兜底', async () => {
    const before = Date.now()
    const c = happyPathClient(
      { validityDays: 60 },
      { validity_mode: null, valid_days: null, valid_to: null },
    )
    await grantShareGift(c, BASE_ORDER)
    const after = Date.now()
    const couponCall = c.query.mock.calls.find(
      ([sql]) => sql && sql.includes('user_coupons'),
    )
    const expireAt = couponCall[1][3]
    const diff = expireAt.getTime() - before
    expect(diff).toBeGreaterThanOrEqual(60 * 86400000 - 1000)
    expect(diff).toBeLessThanOrEqual(60 * 86400000 + (after - before) + 1000)
  })
})
