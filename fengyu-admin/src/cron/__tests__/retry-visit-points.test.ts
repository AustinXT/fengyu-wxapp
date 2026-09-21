import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('@/lib/visit-points', () => ({
  loadVisitPointsReward: vi.fn(),
  grantVisitPointsEntry: vi.fn(),
  markVisitPointsFailureRecovered: vi.fn(),
  normalizeServiceDate: vi.fn((value: unknown) => {
    const s = String(value || '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
  }),
  buildVisitPointsExternalRef: vi.fn((userId: string, date: string) => `visit-points:${userId}:${date}`),
}))

import { retryVisitPoints } from '../steps/retry-visit-points'
import {
  grantVisitPointsEntry,
  loadVisitPointsReward,
  markVisitPointsFailureRecovered,
} from '@/lib/visit-points'

describe('cron visitPointsRetry', () => {
  const oldFlag = process.env.POINTS_ACCRUAL_ENABLED

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.POINTS_ACCRUAL_ENABLED
    vi.mocked(loadVisitPointsReward).mockResolvedValue(20)
    vi.mocked(grantVisitPointsEntry).mockResolvedValue({
      granted: true,
      amount: 20,
      externalRef: 'visit-points:u-1:2026-08-13',
    })
    vi.mocked(markVisitPointsFailureRecovered).mockResolvedValue()
  })

  afterAll(() => {
    if (oldFlag === undefined) delete process.env.POINTS_ACCRUAL_ENABLED
    else process.env.POINTS_ACCRUAL_ENABLED = oldFlag
  })

  it('全局开关关闭时暂停，不查失败日志', async () => {
    process.env.POINTS_ACCRUAL_ENABLED = 'false'
    const db = { execute: vi.fn(), transaction: vi.fn() }
    const result = await retryVisitPoints(db as never)
    expect(result.paused).toBe(true)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('配置为 0 时暂停', async () => {
    vi.mocked(loadVisitPointsReward).mockResolvedValue(0)
    const db = { execute: vi.fn(), transaction: vi.fn() }
    const result = await retryVisitPoints(db as never)
    expect(result.paused).toBe(true)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('仅处理失败日志，使用日志冻结的积分数并记录 recovered', async () => {
    const failure = {
      id: 101,
      target_id: 'SVC-1',
      detail: {
        rewardAmount: 25,
        externalRef: 'tampered-value',
        userId: 'u-1',
        serviceDate: '2026-08-13',
      },
    }
    const db = {
      execute: vi.fn().mockResolvedValue([failure]),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: vi.fn() })),
    }

    const result = await retryVisitPoints(db as never)

    expect(result).toEqual({ candidateCount: 1, recoveredCount: 1, errorCount: 0, paused: false })
    expect(grantVisitPointsEntry).toHaveBeenCalledWith(
      expect.anything(), 'u-1', '2026-08-13', 25, expect.any(Date),
    )
    expect(markVisitPointsFailureRecovered).toHaveBeenCalledWith(
      expect.anything(), 101, 'SVC-1', expect.objectContaining({ granted: true }),
    )
  })

  // 补发口径守护（2026-09-22 拍板）：流水锚在**原服务日北京零点**，不是补发当刻。
  // 传 new Date() 会让 8 月的到店显示成补发日到账、365 天有效期顺延。
  it('补发时间锚在原服务日的北京零点，而非补发当刻', async () => {
    const failure = {
      id: 102,
      target_id: 'SVC-2',
      detail: { rewardAmount: 20, userId: 'u-2', serviceDate: '2026-08-13' },
    }
    const db = {
      execute: vi.fn().mockResolvedValue([failure]),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: vi.fn() })),
    }

    await retryVisitPoints(db as never)

    const grantedAt = vi.mocked(grantVisitPointsEntry).mock.calls[0][4]
    // 北京 2026-08-13 00:00:00 == UTC 2026-08-12 16:00:00
    expect(grantedAt.toISOString()).toBe('2026-08-12T16:00:00.000Z')
  })

  it('非法失败日志不补发，也不扫描服务单', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ id: 1, target_id: 'SVC-OLD', detail: null }]),
      transaction: vi.fn(),
    }
    const result = await retryVisitPoints(db as never)
    expect(result).toEqual({ candidateCount: 1, recoveredCount: 0, errorCount: 1, paused: false })
    expect(db.transaction).not.toHaveBeenCalled()
    expect(grantVisitPointsEntry).not.toHaveBeenCalled()
  })

  it('单条重试失败不影响后续候选', async () => {
    const failures = [1, 2].map((id) => ({
      id,
      target_id: `SVC-${id}`,
      detail: { rewardAmount: 20, userId: `u-${id}`, serviceDate: '2026-08-13' },
    }))
    let call = 0
    const db = {
      execute: vi.fn().mockResolvedValue(failures),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        call++
        if (call === 1) throw new Error('temporary error')
        return fn({ execute: vi.fn() })
      }),
    }

    const result = await retryVisitPoints(db as never)
    expect(result).toEqual({ candidateCount: 2, recoveredCount: 1, errorCount: 1, paused: false })
    expect(db.transaction).toHaveBeenCalledTimes(2)
  })
})
