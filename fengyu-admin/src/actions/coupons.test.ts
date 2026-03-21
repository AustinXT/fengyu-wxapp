import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/coupon', () => ({
  couponTemplates: {
    templateId: 'template_id',
    name: 'name',
    couponType: 'coupon_type',
    discountValue: 'discount_value',
    minSpend: 'min_spend',
    maxDiscount: 'max_discount',
    totalCount: 'total_count',
    isActive: 'is_active',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    applicableProductIds: 'applicable_product_ids',
    applicableCategoryIds: 'applicable_category_ids',
    applicableStoreIds: 'applicable_store_ids',
    applicableMarketIds: 'applicable_market_ids',
    validityMode: 'validity_mode',
    validFrom: 'valid_from',
    validTo: 'valid_to',
    validDays: 'valid_days',
    description: 'description',
  },
  userCoupons: {
    templateId: 'template_id',
    couponId: 'coupon_id',
    userId: 'user_id',
    status: 'status',
    expireAt: 'expire_at',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    parentId: 'parent_id',
    sortOrder: 'sort_order',
    isActive: 'is_active',
  },
  stores: {
    storeId: 'store_id',
    orgNodeId: 'org_node_id',
  },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  sql: Object.assign(
    vi.fn(() => ({ type: 'sql' })),
    { raw: vi.fn(() => ({ type: 'sql_raw' })) },
  ),
}))

import { getTemplates, createTemplate, updateTemplate, toggleTemplateActive, issueCoupon, getIssuedCoupons } from './coupons'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

function makeTemplateRow(templateId: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    templateId,
    name: '满100减20',
    couponType: '现金券',
    discountValue: '20.00',
    minSpend: '100.00',
    maxDiscount: null,
    totalCount: 100,
    isActive: true,
    applicableProductIds: null,
    applicableCategoryIds: null,
    applicableStoreIds: null,
    applicableMarketIds: null,
    validityMode: 'fixed',
    validFrom: new Date('2026-01-01'),
    validTo: new Date('2026-12-31'),
    validDays: null,
    description: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  }
}

function setupDbSelect(templateRows: any[], countRows: any[]) {
  let callCount = 0
  ;(db.select as any).mockImplementation(() => {
    callCount++
    const currentCall = callCount

    if (currentCall === 1) {
      // First call: getTemplates → couponTemplates
      const limit = vi.fn().mockResolvedValue(templateRows)
      const orderBy = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ orderBy })
      return { from }
    } else {
      // Second call: count → userCoupons
      const groupBy = vi.fn().mockResolvedValue(countRows)
      const from = vi.fn().mockReturnValue({ groupBy })
      return { from }
    }
  })
}

describe('getTemplates — issuedCount (已发/总量)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  it('无任何已发券时，issuedCount 为 0', async () => {
    setupDbSelect([makeTemplateRow('T-001')], [])

    const result = await getTemplates()

    expect(result).toHaveLength(1)
    expect(result[0].issuedCount).toBe(0)
  })

  it('有已发券时，issuedCount 正确填入', async () => {
    setupDbSelect(
      [makeTemplateRow('T-001'), makeTemplateRow('T-002')],
      [
        { templateId: 'T-001', issuedCount: 42 },
        { templateId: 'T-002', issuedCount: 7 },
      ],
    )

    const result = await getTemplates()

    expect(result[0].issuedCount).toBe(42)
    expect(result[1].issuedCount).toBe(7)
  })

  it('部分模板有已发券，无记录的默认 0', async () => {
    setupDbSelect(
      [makeTemplateRow('T-001'), makeTemplateRow('T-002')],
      [{ templateId: 'T-001', issuedCount: 10 }],
    )

    const result = await getTemplates()

    expect(result[0].issuedCount).toBe(10)
    expect(result[1].issuedCount).toBe(0) // T-002 无记录，默认 0
  })

  it('返回结果含所有必要字段，时间字段转为 ISO 字符串', async () => {
    setupDbSelect([makeTemplateRow('T-001')], [{ templateId: 'T-001', issuedCount: 5 }])

    const result = await getTemplates()

    expect(result[0].templateId).toBe('T-001')
    expect(result[0].name).toBe('满100减20')
    expect(result[0].totalCount).toBe(100)
    expect(result[0].issuedCount).toBe(5)
    expect(result[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(result[0].updatedAt).toBe('2026-01-15T00:00:00.000Z')
  })

  it('空模板列表时返回空数组', async () => {
    setupDbSelect([], [])

    const result = await getTemplates()

    expect(result).toEqual([])
  })
})

// ── createTemplate ─────────────────────────────────────────────────────────────

const baseCreateData = {
  templateId: 'TPL-001',
  name: '满100减20',
  couponType: '现金券',
  discountValue: '20.00',
}

describe('createTemplate — 输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  it('无效券种类型 → 拒绝', async () => {
    const result = await createTemplate({ ...baseCreateData, couponType: '积分券' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无效的券种类型')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('discountValue 为 0 → 拒绝', async () => {
    const result = await createTemplate({ ...baseCreateData, discountValue: '0' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('优惠值必须为正数')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('折扣券 discountValue >= 1 → 拒绝', async () => {
    const result = await createTemplate({ ...baseCreateData, couponType: '折扣券', discountValue: '1.2' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('折扣券的折扣值必须在 0~1 之间')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('validFrom 晚于 validTo → 拒绝', async () => {
    const result = await createTemplate({
      ...baseCreateData,
      validFrom: '2026-12-31',
      validTo: '2026-01-01',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('有效期开始日期不能晚于结束日期')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('正常创建 → 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createTemplate(baseCreateData)
    expect(result.success).toBe(true)
    expect(result.message).toContain('创建成功')
  })

  it('并发唯一冲突（23505）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createTemplate(baseCreateData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('模板编号已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(createTemplate(baseCreateData)).rejects.toThrow('connection lost')
  })
})

// ── updateTemplate ────────────────────────────────────────────────────────────

describe('updateTemplate — rowCount=0 静默成功修复 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告模板不存在（不静默成功）', async () => {
    setupUpdate(0)
    const result = await updateTemplate('TPL-999', { name: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateTemplate('TPL-001', { name: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=1 → 更新成功', async () => {
    setupUpdate(1)
    const result = await updateTemplate('TPL-001', { name: '新名称' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
    await expect(updateTemplate('TPL-001', { name: '新名称' })).rejects.toThrow('connection lost')
  })
})

// ── toggleTemplateActive ──────────────────────────────────────────────────────

describe('toggleTemplateActive — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告模板不存在', async () => {
    setupUpdate(0)
    const result = await toggleTemplateActive('TPL-999', false)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await toggleTemplateActive('TPL-001', true, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('启用 → 成功，消息含"启用"', async () => {
    setupUpdate(1)
    const result = await toggleTemplateActive('TPL-001', true)
    expect(result.success).toBe(true)
    expect(result.message).toContain('启用')
  })

  it('停用 → 成功，消息含"停用"', async () => {
    setupUpdate(1)
    const result = await toggleTemplateActive('TPL-001', false)
    expect(result.success).toBe(true)
    expect(result.message).toContain('停用')
  })
})

// ── issueCoupon ──────────────────────────────────────────────────────────────

describe('issueCoupon — 发放优惠券', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  function setupIssueMocks(opts: {
    template?: any
    countResult?: number
    customer?: any
  }) {
    const hasTotalCount = opts.template?.totalCount !== null && opts.template?.totalCount !== undefined
    let selectCallCount = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallCount++
      const currentCall = selectCallCount

      if (currentCall === 1) {
        // 查模板
        const limit = vi.fn().mockResolvedValue(opts.template ? [opts.template] : [])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      } else if (hasTotalCount && currentCall === 2) {
        // 查发放数量（仅 totalCount 非 null 时有此调用）
        const where = vi.fn().mockResolvedValue([{ count: opts.countResult ?? 0 }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      } else {
        // 查顾客
        const limit = vi.fn().mockResolvedValue(opts.customer ? [opts.customer] : [])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
  }

  it('模板不存在 → 拒绝', async () => {
    setupIssueMocks({ template: null })
    const result = await issueCoupon('TPL-999', '13800000000')
    expect(result.success).toBe(false)
    expect(result.message).toContain('模板不存在')
  })

  it('模板已停用 → 拒绝', async () => {
    setupIssueMocks({ template: makeTemplateRow('TPL-001', { isActive: false }) })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已停用')
  })

  it('发放量已达上限 → 拒绝', async () => {
    setupIssueMocks({
      template: makeTemplateRow('TPL-001', { totalCount: 10 }),
      countResult: 10,
    })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已达上限')
  })

  it('顾客不存在 → 拒绝', async () => {
    setupIssueMocks({
      template: makeTemplateRow('TPL-001', { totalCount: null }),
      customer: null,
    })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(false)
    expect(result.message).toContain('未找到')
  })

  it('正常发放（days 模式） → 成功', async () => {
    setupIssueMocks({
      template: makeTemplateRow('TPL-001', { totalCount: null, validityMode: 'days', validDays: 30 }),
      customer: { userId: 'FYGK-001', name: '李女士' },
    })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(true)
    expect(result.message).toContain('李女士')
    expect(db.insert).toHaveBeenCalled()
  })

  it('正常发放（fixed 模式） → 成功', async () => {
    setupIssueMocks({
      template: makeTemplateRow('TPL-001', { totalCount: 100 }),
      countResult: 50,
      customer: { userId: 'FYGK-001', name: '王女士' },
    })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(true)
    expect(result.message).toContain('王女士')
  })

  it('totalCount 不为 null 但未达上限 → 发放成功', async () => {
    setupIssueMocks({
      template: makeTemplateRow('TPL-001', { totalCount: 10 }),
      countResult: 9,
      customer: { userId: 'FYGK-001', name: '张女士' },
    })
    const result = await issueCoupon('TPL-001', '13800000000')
    expect(result.success).toBe(true)
  })
})

// ── getIssuedCoupons ─────────────────────────────────────────────────────────

describe('getIssuedCoupons — 查询已发放券', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
  })

  it('有记录 → 返回已发放列表', async () => {
    const mockRows = [
      {
        couponId: 'cpn-001',
        customerName: '李女士',
        phone: '13800000001',
        status: '未使用',
        issuedAt: new Date('2026-03-01T10:00:00.000Z'),
        usedAt: null,
      },
      {
        couponId: 'cpn-002',
        customerName: '王女士',
        phone: '13800000002',
        status: '已使用',
        issuedAt: new Date('2026-03-02T10:00:00.000Z'),
        usedAt: new Date('2026-03-10T10:00:00.000Z'),
      },
    ]

    const limit = vi.fn().mockResolvedValue(mockRows)
    const orderBy = vi.fn().mockReturnValue({ limit })
    const where = vi.fn().mockReturnValue({ orderBy })
    const innerJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ innerJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getIssuedCoupons('TPL-001')

    expect(result).toHaveLength(2)
    expect(result[0].couponId).toBe('cpn-001')
    expect(result[0].customerName).toBe('李女士')
    expect(result[0].status).toBe('未使用')
    expect(result[0].issuedAt).toBe('2026-03-01T10:00:00.000Z')
    expect(result[0].usedAt).toBeNull()
    expect(result[1].usedAt).toBe('2026-03-10T10:00:00.000Z')
  })

  it('无记录 → 返回空数组', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn().mockReturnValue({ limit })
    const where = vi.fn().mockReturnValue({ orderBy })
    const innerJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ innerJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getIssuedCoupons('TPL-999')

    expect(result).toEqual([])
  })

  it('customerName 为 null 时显示 "未知"', async () => {
    const mockRows = [{
      couponId: 'cpn-003',
      customerName: null,
      phone: '13800000003',
      status: '未使用',
      issuedAt: new Date('2026-03-01T10:00:00.000Z'),
      usedAt: null,
    }]

    const limit = vi.fn().mockResolvedValue(mockRows)
    const orderBy = vi.fn().mockReturnValue({ limit })
    const where = vi.fn().mockReturnValue({ orderBy })
    const innerJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ innerJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getIssuedCoupons('TPL-001')

    expect(result[0].customerName).toBe('未知')
  })
})
