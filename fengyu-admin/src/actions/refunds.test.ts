import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    memberLevel: 'member_level',
    memberLevelUpgradedAt: 'member_level_upgraded_at',
    memberLevelLockedUntil: 'member_level_locked_until',
  },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

vi.mock('@db/order', () => ({
  saleOrders: {},
  saleItems: {},
  saleOrderPayments: {},
}))

// 2026-04-26 sale-order-domain-refactor：refunds.ts 引入 cascadeRefund
vi.mock('@/lib/refund-cascade', () => ({
  cascadeRefund: vi.fn(async () => ({
    voidedAllocations: 0,
    voidedCommissions: 0,
    refundedCoupons: 0,
    revokedShareGiftCoupons: 0,
    reversedPoints: 0,
    rolledBackPickups: 0,
  })),
}))

vi.mock('@db/org', () => ({ stores: {} }))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  desc: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray) => ({ __sqlText: strings.join('?'), as: vi.fn().mockReturnValue({ type: 'sql-as' }) })), { raw: vi.fn(), join: vi.fn(() => ({})) }),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((t) => t),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('@/lib/member-threshold', () => ({ getMemberThreshold: vi.fn(async () => 1990) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/system-config', () => ({ getPointsToYuanRate: vi.fn(async () => 0.01) }))

import { estimateRefundOverdraft, createRefund } from './refunds'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = { employeeId: 'EMP-1', roles: ['manager'] } as any

function mockUserRow(row: {
  memberLevel: string | null
  memberLevelUpgradedAt: Date | null
  memberLevelLockedUntil: Date | null
}) {
  const limit = vi.fn().mockResolvedValue([row])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
}

/**
 * db.execute 按调用顺序分发返回值：
 *   [1] 滚动 12 月消费：[{ spend }]
 *   [2] 升级权益配置：[{ value: JSON }]
 *   [3] coupon_templates 价值：[{ template_id, discount_value }]
 *   [4] 已核销券：[{ coupon_id, template_id, discount_value, used_at }]
 *   [5] 升级发放积分：[{ granted }]
 *   [6] 已扣积分：[{ used }]
 */
function mockExecSeq(...results: any[][]) {
  let i = 0
  ;(db.execute as any).mockImplementation(async () => {
    const r = results[i] ?? []
    i++
    return r
  })
}

describe('estimateRefundOverdraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('顾客无会员等级 → willDowngrade=false, suggestedOverdraftDeduction=0', async () => {
    mockUserRow({ memberLevel: null, memberLevelUpgradedAt: null, memberLevelLockedUntil: null })

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 500,
      originalSaleOrderId: 'FY-XSD-1',
    })

    expect(result.willDowngrade).toBe(false)
    expect(result.suggestedOverdraftDeduction).toBe(0)
    expect(result.currentLevel).toBeNull()
  })

  it('保级期内 → willDowngrade=false 即便消费跌至低档', async () => {
    const upgradedAt = new Date('2026-03-01T00:00:00Z')
    const lockedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    mockUserRow({
      memberLevel: '星钻',
      memberLevelUpgradedAt: upgradedAt,
      memberLevelLockedUntil: lockedUntil,
    })
    // 消费跌到初钻档（8000 - 5000 = 3000）
    mockExecSeq(
      [{ spend: '8000' }],
      [{ value: JSON.stringify({ 星钻: { points: 500, couponTemplateIds: [] }, 初钻: { points: 100, couponTemplateIds: [] } }) }],
      [],
    )

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 5000,
      originalSaleOrderId: 'FY-XSD-1',
    })

    expect(result.lockedUntilStatus).toBe('in_lock')
    expect(result.willDowngrade).toBe(false)
    expect(result.suggestedOverdraftDeduction).toBe(0)
  })

  it('跌档 + 有已核销券 + 已用升级积分 → suggestedOverdraftDeduction = usedCoupon + usedPointsValue', async () => {
    const upgradedAt = new Date('2025-10-01T00:00:00Z')
    const lockedUntil = new Date('2026-03-01T00:00:00Z') // 已到期（today=04-24）
    mockUserRow({
      memberLevel: '星钻',
      memberLevelUpgradedAt: upgradedAt,
      memberLevelLockedUntil: lockedUntil,
    })
    mockExecSeq(
      [{ spend: '12000' }],        // 12000 - 7000 = 5000 (< 10000 → 初钻)
      [{                            // 权益配置：星钻 500 积分 + tpl A 券; 初钻 100 积分 + 无券
        value: JSON.stringify({
          星钻: { points: 500, couponTemplateIds: ['TPL-A'] },
          初钻: { points: 100, couponTemplateIds: [] },
        }),
      }],
      [{ template_id: 'TPL-A', discount_value: '200' }],
      [{ coupon_id: 'cpn-up-FYGK-1-星钻-TPL-A', template_id: 'TPL-A', discount_value: '200', used_at: new Date('2026-01-15T00:00:00Z') }],
      [{ granted: '500' }],       // 升级时发了 500 分
      [{ used: '300' }],          // 升级以来用掉 300 分
    )

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 7000,
      originalSaleOrderId: 'FY-XSD-1',
    })

    expect(result.willDowngrade).toBe(true)
    expect(result.currentLevel).toBe('星钻')
    expect(result.recomputedLevel).toBe('初钻')
    expect(result.usedCouponValue).toBe(200)                  // 已核销 200
    expect(result.usedPointsValue).toBe(3)                    // 300 * 0.01 = 3
    expect(result.currentBenefitsValue).toBe(205)             // 500*0.01 + 200 = 205
    expect(result.newBenefitsValue).toBe(1)                   // 100*0.01 = 1
    expect(result.benefitValueDiff).toBe(204)                 // 205 - 1
    expect(result.suggestedOverdraftDeduction).toBe(203)      // min(200+3, 204, 7000)
  })

  it('已用积分 150 > 升级发放 100 → FIFO 近似取 100', async () => {
    const upgradedAt = new Date('2025-10-01T00:00:00Z')
    mockUserRow({
      memberLevel: '星钻',
      memberLevelUpgradedAt: upgradedAt,
      memberLevelLockedUntil: null,
    })
    mockExecSeq(
      [{ spend: '12000' }],
      [{
        value: JSON.stringify({
          星钻: { points: 100, couponTemplateIds: [] },
          初钻: { points: 0, couponTemplateIds: [] },
        }),
      }],
      // allTemplateIds=[] → tpl 查询跳过
      [],                                // no used coupons
      [{ granted: '100' }],              // 只发了 100
      [{ used: '150' }],                 // 但用了 150（含自然积分）
    )

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 7000,
      originalSaleOrderId: 'FY-XSD-1',
    })

    expect(result.willDowngrade).toBe(true)
    expect(result.detail.usedPoints).toBe(100)  // FIFO 近似，不超过发放
    expect(result.usedPointsValue).toBe(1)      // 100 * 0.01
  })

  it('refundAmount 小于建议额 → suggestedOverdraftDeduction 按 refundAmount 封顶', async () => {
    mockUserRow({
      memberLevel: '星钻',
      memberLevelUpgradedAt: new Date('2025-10-01T00:00:00Z'),
      memberLevelLockedUntil: null,
    })
    // spend 10020, refund 50 → projected 9970 < 10000 跌至初钻
    mockExecSeq(
      [{ spend: '10020' }],
      [{
        value: JSON.stringify({
          星钻: { points: 10000, couponTemplateIds: [] },
          初钻: { points: 0, couponTemplateIds: [] },
        }),
      }],
      // allTemplateIds=[] → tpl 查询跳过
      [],
      [{ granted: '10000' }],
      [{ used: '10000' }],
    )

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 50,        // 实际只退 50 元
      originalSaleOrderId: 'FY-XSD-1',
    })

    // usedPointsValue = 10000*0.01 = 100
    // benefitValueDiff = 100
    // min(100, 100, 50) = 50 → 不会让顾客倒付
    expect(result.willDowngrade).toBe(true)
    expect(result.suggestedOverdraftDeduction).toBe(50)
  })

  it('当前等级在库无对应权益配置 → 以 0 计，不扣', async () => {
    mockUserRow({
      memberLevel: '金钻',
      memberLevelUpgradedAt: new Date('2025-10-01T00:00:00Z'),
      memberLevelLockedUntil: null,
    })
    mockExecSeq(
      [{ spend: '70000' }],          // 70000 - 15000 = 55000 (粉钻)
      [{ value: JSON.stringify({}) }],
      // allTemplateIds=[] → tpl 查询跳过
      [],
      [{ granted: '0' }],
      [{ used: '0' }],
    )

    const result = await estimateRefundOverdraft({
      userId: 'FYGK-1',
      refundAmount: 15000,
      originalSaleOrderId: 'FY-XSD-1',
    })

    expect(result.willDowngrade).toBe(true)
    expect(result.currentBenefitsValue).toBe(0)
    expect(result.benefitValueDiff).toBe(0)
    expect(result.suggestedOverdraftDeduction).toBe(0)
  })
})


describe('createRefund — 寄存申请的真实取数展开与锁内复核', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })
  it.each([false, true])('同单A已转换，B快照变化=%s', async (changed) => {
    const item = (id: string, remaining: number, paid: number) => ({
      saleItemId: id, productName: id, productType: '疗程卡', sessionCount: 6,
      remainingSessions: remaining, paidSessions: paid, unitPrice: '80', unitRealPrice: '80',
      quantity: 1, saleAmount: '480', received: id === 'A' ? '320' : '480',
      pickedUpQuantity: 0, refundedQuantity: 0, convertedQuantity: 0, serviceFee: '0',
    })
    const a = item('A', 2, 4), b = item('B', 6, 6)
    const selects = [
      [{ saleOrderId: 'deposit', saleOrderType: '寄存单', status: '已支付', received: '960', refundedAmount: '160', totalAmount: '0', paymentMethod: '线下' }],
      [],
      [
        { item: a, rightsReceived: '320', pickedQuantity: 0, convertedAmount: '240', convertedQuantity: 3 },
        { item: b, rightsReceived: '480', pickedQuantity: 0, convertedAmount: '0', convertedQuantity: 0 },
      ],
    ]
    let index = 0
    ;(db.select as any).mockImplementation(() => {
      const rows = selects[index++] ?? []
      const q: any = {}
      for (const name of ['from', 'where', 'limit', 'leftJoin', 'innerJoin', 'orderBy']) q[name] = () => q
      q.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject)
      return q
    })
    ;(db.execute as any).mockImplementation(async (q: any) => q.__sqlText.includes('AS net') ? [{ net: '800' }] : [])
    const inserted: any[] = []
    ;(db.transaction as any).mockImplementation(async (cb: any) => cb({
      execute: async (q: any) => {
        if (q.__sqlText.includes('SELECT status')) return [{ status: '已支付' }]
        return [a, b].map((it) => ({
          sale_item_id: it.saleItemId, remaining_sessions: it.saleItemId === 'B' && changed ? 5 : it.remainingSessions,
          paid_sessions: it.paidSessions, unit_real_price: it.unitRealPrice, session_count: 6,
          quantity: 1, picked_up_quantity: 0, refunded_quantity: 0, converted_quantity: 0,
        }))
      },
      insert: () => ({ values: (v: any) => {
        inserted.push(v)
        return { returning: async () => [{ id: 1001 }] }
      } }),
    }))
    const result = await createRefund({ refSaleOrderId: 'deposit', refundReason: '退B', items: [{ saleItemId: 'B', refundQuantity: 6 }] })
    if (changed) {
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CONFLICT')
      expect(result.error?.message).toContain('寄存权益已变化')
      expect(inserted).toEqual([])
    } else {
      expect(result.success).toBe(true)
      expect(inserted).toHaveLength(1)
      expect(inserted[0].refSaleItemId).toBe('B')
      expect(inserted[0].amount).toBe('-480.00')
    }
  })
})
