import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@db/commission', () => ({
  commissionRateMatrix: {
    id: 'id',
    orgId: 'org_id',
    orderType: 'order_type',
    roleType: 'role_type',
    salesCategory: 'sales_category',
    amountTierMin: 'amount_tier_min',
    amountTierMax: 'amount_tier_max',
    commissionRate: 'commission_rate',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', type: 'type', sortOrder: 'sort_order' },
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
  or: vi.fn((...args) => ({ type: 'or', args })),
  gt: vi.fn((a, b) => ({ type: 'gt', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  ne: vi.fn((a, b) => ({ type: 'ne', a, b })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), { raw: vi.fn((s: string) => s) }),
}))

import { createRate, updateRate, deleteRate, getRates, getMarkets } from './commission'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
}

const baseData = {
  orgId: 'market-1',
  orderType: '销售单',
  roleType: 'manager',
  salesCategory: '自采自销',
}

// 设置 hasTierOverlap 内部的 DB select 调用
function setupOverlapCheck(overlapping: boolean) {
  const limit = vi.fn().mockResolvedValue(overlapping ? [{ id: 1 }] : [])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return { select: vi.fn().mockReturnValue({ from }), limit }
}

// 设置 insert 成功
function setupInsertSuccess() {
  const values = vi.fn().mockResolvedValue({})
  return { insert: vi.fn().mockReturnValue({ values }) }
}

// 设置 update 成功，rowCount=1
function setupUpdateSuccess(count = 1) {
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  return { update: vi.fn().mockReturnValue({ set }) }
}

describe('createRate — 金额阶段重叠校验 (AC-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无重叠时：插入成功', async () => {
    const overlapSelect = setupOverlapCheck(false)
    const insertMock = setupInsertSuccess()

    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      return overlapSelect.select()
    })
    ;(db.insert as any).mockImplementation(insertMock.insert)

    const result = await createRate({
      ...baseData,
      amountTierMin: '0',
      amountTierMax: '1000',
      commissionRate: '0.08',
    })

    expect(result.success).toBe(true)
    expect(result.message).toBe('提成规则创建成功')
  })

  it('有重叠时：拒绝并返回提示', async () => {
    const overlapSelect = setupOverlapCheck(true)
    ;(db.select as any).mockReturnValue(overlapSelect.select())

    const result = await createRate({
      ...baseData,
      amountTierMin: '500',
      amountTierMax: '1500',
      commissionRate: '0.10',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('重叠')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('新区间无上限（+∞）有重叠时：拒绝', async () => {
    const overlapSelect = setupOverlapCheck(true)
    ;(db.select as any).mockReturnValue(overlapSelect.select())

    const result = await createRate({
      ...baseData,
      amountTierMin: '2000',
      amountTierMax: null, // 无上限
      commissionRate: '0.12',
    })

    expect(result.success).toBe(false)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('无重叠时：lt 不被调用（newMax 为 null）', async () => {
    const overlapSelect = setupOverlapCheck(false)
    const insertMock = setupInsertSuccess()

    ;(db.select as any).mockReturnValue(overlapSelect.select())
    ;(db.insert as any).mockImplementation(insertMock.insert)

    const { lt } = await import('drizzle-orm')

    await createRate({
      ...baseData,
      amountTierMin: '0',
      amountTierMax: null,
      commissionRate: '0.05',
    })

    // newMax IS NULL → 不需要 existMin < newMax 条件
    expect(lt).not.toHaveBeenCalled()
  })
})

describe('updateRate — 金额阶段重叠校验（排除自身）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('更新后无重叠：成功', async () => {
    const overlapSelect = setupOverlapCheck(false)
    const updateMock = setupUpdateSuccess(1)

    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      return overlapSelect.select()
    })
    ;(db.update as any).mockImplementation(updateMock.update)

    const result = await updateRate(
      42,
      { ...baseData, amountTierMin: '0', amountTierMax: '1000', commissionRate: '0.08' },
      '2026-01-01T00:00:00.000Z',
    )

    expect(result.success).toBe(true)
  })

  it('更新后与其他规则重叠：拒绝', async () => {
    const overlapSelect = setupOverlapCheck(true)
    ;(db.select as any).mockReturnValue(overlapSelect.select())

    const result = await updateRate(
      42,
      { ...baseData, amountTierMin: '500', amountTierMax: '1500', commissionRate: '0.10' },
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('重叠')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('仅更新 commissionRate（无分类键）时：跳过重叠检查', async () => {
    const updateMock = setupUpdateSuccess(1)
    ;(db.update as any).mockImplementation(updateMock.update)

    // 只传 commissionRate，不传分类键字段 → 跳过 hasTierOverlap
    const result = await updateRate(42, { commissionRate: '0.09' })

    expect(result.success).toBe(true)
    expect(db.select).not.toHaveBeenCalled() // 未触发重叠查询
  })

  it('乐观锁冲突时：返回修改提示', async () => {
    const overlapSelect = setupOverlapCheck(false)
    const updateMock = setupUpdateSuccess(0) // rowCount=0

    ;(db.select as any).mockReturnValue(overlapSelect.select())
    ;(db.update as any).mockImplementation(updateMock.update)

    const result = await updateRate(
      42,
      { ...baseData, amountTierMin: '0', amountTierMax: '500', commissionRate: '0.06' },
      '2026-01-01T00:00:00.000Z',
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=0，无乐观锁 → 报告规则不存在（不静默成功）', async () => {
    const overlapSelect = setupOverlapCheck(false)
    const updateMock = setupUpdateSuccess(0)

    ;(db.select as any).mockReturnValue(overlapSelect.select())
    ;(db.update as any).mockImplementation(updateMock.update)

    const result = await updateRate(99, { commissionRate: '0.09' }) // 无 expectedUpdatedAt

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('DB 异常 → 重新抛出', async () => {
    const overlapSelect = setupOverlapCheck(false)
    ;(db.select as any).mockReturnValue(overlapSelect.select())

    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(updateRate(42, { commissionRate: '0.09' })).rejects.toThrow('connection lost')
  })
})

// ── createRate 错误处理 ────────────────────────────────────────────────────────

describe('createRate — DB 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('并发唯一冲突（23505）→ 友好消息', async () => {
    const overlapSelect = setupOverlapCheck(false)
    ;(db.select as any).mockReturnValue(overlapSelect.select())

    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })

    const result = await createRate({ ...baseData, amountTierMin: '0', commissionRate: '0.08' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    const overlapSelect = setupOverlapCheck(false)
    ;(db.select as any).mockReturnValue(overlapSelect.select())
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })

    await expect(
      createRate({ ...baseData, amountTierMin: '0', commissionRate: '0.08' })
    ).rejects.toThrow('connection lost')
  })
})

// ── deleteRate ─────────────────────────────────────────────────────────────────

describe('deleteRate — rowCount=0 + DB 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupDelete(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    ;(db.delete as any).mockReturnValue({ where })
  }

  it('rowCount=1 → 删除成功', async () => {
    setupDelete(1)
    const result = await deleteRate(42)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
  })

  it('rowCount=0 → 规则不存在（不静默成功）', async () => {
    setupDelete(0)
    const result = await deleteRate(999)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    ;(db.delete as any).mockReturnValue({ where })

    await expect(deleteRate(42)).rejects.toThrow('connection lost')
  })
})

// ── getRates / getMarkets（读函数覆盖）────────────────────────────────────────

describe('getRates — 全量提成比例列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回序列化的提成比例列表', async () => {
    const limit = vi.fn().mockResolvedValue([{
      id: 1, orgId: 'market-1', orderType: '销售单', roleType: '美容师',
      salesCategory: '自采自销', amountTierMin: '0', amountTierMax: '1000',
      commissionRate: '0.08',
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-03-15'),
      orgName: '南昌市场',
    }])
    const orderBy = vi.fn().mockReturnValue({ limit })
    const leftJoin = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ leftJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getRates()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(1)
    expect(result[0].orgName).toBe('南昌市场')
  })
})

describe('getMarkets — 市场列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回市场选项列表', async () => {
    const orderBy = vi.fn().mockResolvedValue([
      { id: 'market-1', name: '南昌市场' },
      { id: 'market-2', name: '九江市场' },
    ])
    const where = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getMarkets()

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ orgId: 'market-1', name: '南昌市场' })
  })
})
