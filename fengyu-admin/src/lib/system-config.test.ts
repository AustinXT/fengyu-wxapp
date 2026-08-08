import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

import { getPointsToYuanRate, getPointsDeductionMaxRate } from './system-config'
import { db } from '@/db'

describe('getPointsDeductionMaxRate — 积分抵扣上限比例读取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DB 有合法值 0.05 → 返回 0.05（活动期）', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0.05' }])
    expect(await getPointsDeductionMaxRate()).toBe(0.05)
  })

  it('DB 有合法值 0.03 → 返回 0.03（日常）', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0.03' }])
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('DB 无记录 → 返回默认 0.03', async () => {
    ;(db.execute as any).mockResolvedValue([])
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('DB 异常 → 返回默认 0.03（静默降级）', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('conn refused'))
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('越界值 >1（1.5）→ 返回默认 0.03', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '1.5' }])
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('越界值 <0（-0.1）→ 返回默认 0.03', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '-0.1' }])
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('非数字（NaN）→ 返回默认 0.03', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: 'foo' }])
    expect(await getPointsDeductionMaxRate()).toBe(0.03)
  })

  it('下边界 0 → 返回 0（合法，表示禁用积分抵扣）', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0' }])
    expect(await getPointsDeductionMaxRate()).toBe(0)
  })

  it('上边界 1 → 返回 1（合法，表示可 100% 抵扣）', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '1' }])
    expect(await getPointsDeductionMaxRate()).toBe(1)
  })
})

describe('getPointsToYuanRate — 积分折算汇率读取（既有函数补覆盖）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DB 有合法值 0.01 → 返回 0.01', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0.01' }])
    expect(await getPointsToYuanRate()).toBe(0.01)
  })

  it('DB 无记录 → 返回默认 0.01', async () => {
    ;(db.execute as any).mockResolvedValue([])
    expect(await getPointsToYuanRate()).toBe(0.01)
  })

  it('DB 异常 → 返回默认 0.01', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('conn refused'))
    expect(await getPointsToYuanRate()).toBe(0.01)
  })

  it('越界值 0 / 负数 → 返回默认 0.01（须 > 0）', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0' }])
    expect(await getPointsToYuanRate()).toBe(0.01)
    ;(db.execute as any).mockResolvedValue([{ value: '-1' }])
    expect(await getPointsToYuanRate()).toBe(0.01)
  })
})
