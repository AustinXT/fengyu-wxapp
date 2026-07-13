import { describe, it, expect, vi, beforeEach } from 'vitest'

// 退款前置检查（service-commissions.ts batchSaveServiceCommissions 调 hasPendingRefundByServiceOrder）：
// 默认 false（无退款审批中），让现有用例走正常分支；不 mock 会跑真实实现拿 mock 的 db 误判。
vi.mock('@/lib/refund-cascade', () => ({
  hasPendingRefund: vi.fn().mockResolvedValue(false),
  hasPendingRefundByServiceOrder: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/service-commission', () => ({
  serviceCommissions: {
    id: 'id',
    serviceItemId: 'service_item_id',
    employeeId: 'employee_id',
    roleType: 'role_type',
    allocationRatio: 'allocation_ratio',
    commissionRate: 'commission_rate',
    commissionAmount: 'commission_amount',
    isVoid: 'is_void',
  },
}))

vi.mock('@db/service', () => ({
  serviceOrders: {
    serviceOrderId: 'service_order_id',
    storeId: 'store_id',
    commissionStatus: 'commission_status',
  },
  serviceItems: {
    serviceOrderId: 'service_order_id',
    serviceItemId: 'service_item_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isAdminScope: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { batchSaveServiceCommissions } from './service-commissions'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['allocation:list', 'allocation:save'], scopeStoreIds: ['store-1'] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const whereResult = Object.assign(Promise.resolve(result), { limit, orderBy })
  const where = vi.fn().mockReturnValue(whereResult)
  // innerJoin/leftJoin 自引用 → 支持任意层 JOIN（如 serviceItems×saleItems×saleOrders 两次 innerJoin）
  const chain: any = { where }
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
  return vi.fn().mockReturnValue({ from })
}

// ============================================================
// batchSaveServiceCommissions 的池校验（P2-14 Q5 镜像 allocations）
// ============================================================
describe('batchSaveServiceCommissions — 技能标签池校验（P2-14）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  function mockScopeAndItems(items: Array<{ serviceItemId: string }>) {
    // 生产 batchSaveServiceCommissions 的 db.select 调用序（4 步，须与生产逐一对齐）：
    //   call1: verifyServiceOrderScope → [{ storeId }]
    //   call2: remark 反查（service-commissions.ts:103）→ [{ remark: null }] 建模正常消费核销单
    //          （含寄存单正常核销；remark 字段非 DEPOSIT_REFUND_REMARK → 不命中退款专用拦截）
    //   call3: validItems 校验（:116）→ items
    //   call4: pricing JOIN serviceItems × saleItems（:176）→ pricingRows
    // Pricing rows mirror serviceItems with sessionUsed=0/unitRealPrice='0' so
    // consumeBase=0 → rate-lookup result of 0 is acceptable (no INVALID_STATE).
    const pricingRows = items.map((i) => ({
      serviceItemId: i.serviceItemId,
      unitRealPrice: '0',
      sessionUsed: 0,
      salesCategory: null,
      serviceFee: '0',
      sessionCount: 0,
      quantity: 1,
    }))
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      if (callCount === 2) return makeSelectChain([{ remark: null }])()
      if (callCount === 3) return makeSelectChain(items)()
      // 4th call: pricing JOIN serviceItems × saleItems
      return makeSelectChain(pricingRows)()
    })
  }

  function mockTx() {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
        // commission-rate lookup inside the tx loop — empty array is fine because
        // consumeBase=0 (see pricingRows above) so rate=0 will not throw.
        select: makeSelectChain([]),
      }
      return fn(tx)
    })
  }

  it('分配比例非整十 → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.15', commissionRate: '0.30', commissionAmount: '30.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('整十')
  })

  it('寄存单正常消费服务单（remark 非退款标记）→ 允许分配', async () => {
    // remark 查询返回的行无 remark 字段（undefined）= 正常消费核销单（含寄存单正常核销），不命中退款专用单拦截
    mockScopeAndItems([{ serviceItemId: 'si-1' }])
    mockTx()

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('寄存单退款专用服务单（remark 命中）→ 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope
      return makeSelectChain([{ remark: DEPOSIT_REFUND_REMARK }])() // remark 反查
    })

    const result = await batchSaveServiceCommissions('so-dep', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('寄存单退款专用服务单')
  })

  it('同技能标签超过 3 人 → 拒绝（P2-14 Q5）', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-003', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-004', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('最多分配 3 人')
  })

  it('美容师与养生师三池独立校验（P2-14 Q5）', async () => {
    // P2-14 前合并同一池；现独立池，两角色各 70% + 30% 分别属两池皆合法
    mockScopeAndItems([{ serviceItemId: 'si-1' }])
    mockTx()

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', commissionRate: '0.30', commissionAmount: '21.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '养生师', allocationRatio: '0.30', commissionRate: '0.30', commissionAmount: '9.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('同技能标签分配比例超 100% → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', commissionRate: '0.30', commissionAmount: '21.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.40', commissionRate: '0.30', commissionAmount: '12.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('超过 100%')
  })

  it('同技能标签重复员工 → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('重复')
  })
})

// ============================================================
// batchSaveServiceCommissions — per-session consumeBase 计算
// service_items.unit_real_price 已是 per-session 单次价（schema 恒等式
// 疗程卡 sale_amount = unit_real_price × session_count），直接取用不再 ÷session_count。
// 金额按 allocationRatio 拆分：consumeAmount = consumeBase × ratio × rate。
// ============================================================
describe('batchSaveServiceCommissions — per-session consumeBase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  /**
   * 注入一条带真实卡数据的 pricing 行；rate 矩阵返回 0.30。
   * 捕获最终 INSERT 的 values 数组以验证 consume/commission 金额。
   */
  function setupCardScenario(pricingRow: any, rate: string = '0.3000') {
    // 4 步调用序对齐 mockScopeAndItems：scope → remark(null) → items → pricing
    const items = [{ serviceItemId: pricingRow.serviceItemId }]
    let selectCalls = 0
    ;(db.select as any).mockImplementation(() => {
      selectCalls++
      if (selectCalls === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      if (selectCalls === 2) return makeSelectChain([{ remark: null }])()
      if (selectCalls === 3) return makeSelectChain(items)()
      return makeSelectChain([pricingRow])()
    })

    const insertedValues: any[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((vals: any) => {
            insertedValues.push(...(Array.isArray(vals) ? vals : [vals]))
            return Promise.resolve({})
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
        // commission_rate_matrix 查档：返回非零 rate，避免 INVALID_STATE
        select: makeSelectChain([{ commissionRate: rate }]),
      }
      return fn(tx)
    })

    return insertedValues
  }

  it('5次卡 × 2 → unit_real_price 已是 per-session 700 + sessionUsed=1 → consumeBase = 700', async () => {
    // per-session 模型：service_items.unit_real_price 存单次价（整卡 3500 × 2 / 10次 = 700/次）。
    //   per_session = unit_real_price = 700（直接取用，不再 ÷session_count）
    //   consumeBase = 700 × sessionUsed(1) = 700
    //   consumeAmount = 700 × 0.30 = 210, fixedFee=0, commissionAmount=210
    const inserted = setupCardScenario({
      serviceItemId: 'si-card',
      unitRealPrice: '700',
      sessionUsed: 1,
      salesCategory: '护理项目',
      serviceFee: '0',
      sessionCount: 10,
      quantity: 2,
    })

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-card', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1.00', commissionRate: '0.30', commissionAmount: '210.00' },
    ])

    expect(result.success).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(210, 2) // 700 × 0.30
    expect(Number(inserted[0].commissionAmount)).toBeCloseTo(210, 2) // fixedFee=0 + 210
  })

  it('5次卡 per-session 700 + sessionUsed=2 → consumeBase = 1400', async () => {
    const inserted = setupCardScenario({
      serviceItemId: 'si-card-2',
      unitRealPrice: '700',
      sessionUsed: 2,
      salesCategory: '护理项目',
      serviceFee: '0',
      sessionCount: 10,
      quantity: 2,
    })

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-card-2', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1.00', commissionRate: '0.30', commissionAmount: '420.00' },
    ])

    expect(result.success).toBe(true)
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(420, 2) // 1400 × 0.30
    expect(Number(inserted[0].commissionAmount)).toBeCloseTo(420, 2)
  })

  it('单次体验 (49.80/1/quantity=1) → consumeBase 退化为 unitRealPrice = 49.80', async () => {
    // 非卡场景 session_count=quantity=1，per_session = unit_real_price
    const inserted = setupCardScenario({
      serviceItemId: 'si-single',
      unitRealPrice: '49.80',
      sessionUsed: 1,
      salesCategory: '护理项目',
      serviceFee: '0',
      sessionCount: 1,
      quantity: 1,
    })

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-single', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1.00', commissionRate: '0.30', commissionAmount: '14.94' },
    ])

    expect(result.success).toBe(true)
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(14.94, 2) // 49.80 × 0.30
  })

  it('sessionCount 缺失 (null) → fallback 用 unitRealPrice', async () => {
    const inserted = setupCardScenario({
      serviceItemId: 'si-null',
      unitRealPrice: '100',
      sessionUsed: 1,
      salesCategory: '护理项目',
      serviceFee: '0',
      sessionCount: null,
      quantity: 1,
    })

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-null', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1.00', commissionRate: '0.30', commissionAmount: '30.00' },
    ])

    expect(result.success).toBe(true)
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(30, 2) // 100 × 0.30
  })

  it('按 allocationRatio 拆分：ratio=0.30 → consumeAmount = consumeBase × 0.30 × rate', async () => {
    // consumeBase = 888 × 1 = 888（tier 命中用整池基数，不乘 ratio）
    // allocAmount = 888 × 0.30 = 266.4；consumeAmount = 266.4 × 0.12 = 31.97
    const inserted = setupCardScenario({
      serviceItemId: 'si-ratio',
      unitRealPrice: '888',
      sessionUsed: 1,
      salesCategory: '护理项目',
      serviceFee: '0',
      sessionCount: 1,
      quantity: 1,
    }, '0.1200')

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-ratio', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.30', commissionRate: '0.12', commissionAmount: '31.97' },
    ])

    expect(result.success).toBe(true)
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(31.97, 2) // 888 × 0.30 × 0.12
    expect(Number(inserted[0].commissionAmount)).toBeCloseTo(31.97, 2) // fixedFee=0 + 31.97
    expect(String(inserted[0].allocationRatio)).toBe('0.30')
  })

  it('fixed_fee 也按 ratio 拆分', async () => {
    // serviceFee=20, sessionUsed=2 → fixedFeeBase=40；ratio=0.50 → fixedFee=20
    // consumeBase = 100 × 2 = 200；consumeAmount = 200 × 0.50 × 0.30 = 30；commissionAmount = 20 + 30 = 50
    const inserted = setupCardScenario({
      serviceItemId: 'si-fee',
      unitRealPrice: '100',
      sessionUsed: 2,
      salesCategory: '护理项目',
      serviceFee: '20',
      sessionCount: 1,
      quantity: 1,
    }, '0.3000')

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-fee', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '50.00' },
    ])

    expect(result.success).toBe(true)
    expect(Number(inserted[0].fixedFee)).toBeCloseTo(20, 2) // 20 × 2 × 0.50
    expect(Number(inserted[0].consumeAmount)).toBeCloseTo(30, 2) // 200 × 0.50 × 0.30
    expect(Number(inserted[0].commissionAmount)).toBeCloseTo(50, 2) // 20 + 30
  })
})
