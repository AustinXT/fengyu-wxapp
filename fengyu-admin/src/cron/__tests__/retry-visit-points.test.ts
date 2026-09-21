import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

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

    expect(result).toEqual({
      candidateCount: 1, recoveredCount: 1, expiredCount: 0, errorCount: 0, paused: false,
    })
    expect(grantVisitPointsEntry).toHaveBeenCalledWith(
      expect.anything(), 'u-1', '2026-08-13', 25, expect.any(Date), expect.any(Date),
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

    const [, , , , occurredAt, balanceUpdatedAt] = vi.mocked(grantVisitPointsEntry).mock.calls[0]
    // 北京 2026-08-13 00:00:00 == UTC 2026-08-12 16:00:00
    expect(occurredAt.toISOString()).toBe('2026-08-12T16:00:00.000Z')

    // 但**余额变更时间必须是真实当下**，不能跟着锚点倒退回历史时刻：
    // 顾客若在失败之后、补发之前还有过积分变动，倒退会让按 points_updated_at
    // 做增量同步/对账的下游漏掉那次真实变更。
    expect(balanceUpdatedAt).toBeInstanceOf(Date)
    expect(balanceUpdatedAt!.getTime()).toBeGreaterThan(occurredAt.getTime())
    expect(Math.abs(balanceUpdatedAt!.getTime() - Date.now())).toBeLessThan(60_000)
  })

  // 按服务日回填带来的新边界：超出有效期的候选补发出来就是"当场不可用的积分"，
  // 且批次 expire_at 落在过去 → points_balance > Σ 未过期批次（I2/I3 被撕开）。
  it('服务日已超出 365 天有效期时不补发，写处理记录摘出队列', async () => {
    const stale = new Date(Date.now() - 400 * 86_400_000)
    const serviceDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(stale)

    const db = {
      execute: vi.fn().mockResolvedValue([
        { id: 201, target_id: 'SVC-OLD', detail: { rewardAmount: 20, userId: 'u-3', serviceDate } },
      ]),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: vi.fn() })),
    }

    const result = await retryVisitPoints(db as never)

    expect(result).toEqual({
      candidateCount: 1, recoveredCount: 0, expiredCount: 1, errorCount: 0, paused: false,
    })
    expect(grantVisitPointsEntry).not.toHaveBeenCalled()
    expect(markVisitPointsFailureRecovered).toHaveBeenCalledWith(
      expect.anything(), 201, 'SVC-OLD',
      expect.objectContaining({ granted: false, skipped: 'expired' }),
    )
  })

  // normalizeServiceDate 只校验 YYYY-MM-DD 形态，JS 会把 2026-02-31 静默归一成 3 月 3 日 ——
  // 那样落库日期会与 external_ref 里的幂等键自相矛盾。往返比对把它挡在补发之前。
  it('日历非法的 serviceDate 不补发（2026-02-31 会被 JS 归一成 3 月 3 日）', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { id: 202, target_id: 'SVC-BAD', detail: { rewardAmount: 20, userId: 'u-4', serviceDate: '2026-02-31' } },
      ]),
      transaction: vi.fn(),
    }

    const result = await retryVisitPoints(db as never)

    expect(result).toEqual({
      candidateCount: 1, recoveredCount: 0, expiredCount: 0, errorCount: 1, paused: false,
    })
    expect(grantVisitPointsEntry).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // 有效期天数在两处出现：本 STEP 的 JS 常量（判"要不要补发"）与发放 SQL 的 INTERVAL 字面量
  // （决定 expire_at）。SQL 受跨端 snapshot 守护、不能把常量插进去，只能镜像，所以要防漂移。
  it('VISIT_POINTS_VALID_DAYS 与发放 SQL 的 INTERVAL 字面量一致', () => {
    const stepSrc = readFileSync(path.resolve(__dirname, '../steps/retry-visit-points.ts'), 'utf8')
    const grantSrc = readFileSync(path.resolve(__dirname, '../../lib/visit-points.ts'), 'utf8')
    const days = stepSrc.match(/VISIT_POINTS_VALID_DAYS = (\d+)/)?.[1]
    expect(days).toBe('365')
    expect(grantSrc).toContain(`INTERVAL '${days} days'`)
  })

  it('非法失败日志不补发，也不扫描服务单', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ id: 1, target_id: 'SVC-OLD', detail: null }]),
      transaction: vi.fn(),
    }
    const result = await retryVisitPoints(db as never)
    expect(result).toEqual({
      candidateCount: 1, recoveredCount: 0, expiredCount: 0, errorCount: 1, paused: false,
    })
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
    expect(result).toEqual({
      candidateCount: 2, recoveredCount: 1, expiredCount: 0, errorCount: 1, paused: false,
    })
    expect(db.transaction).toHaveBeenCalledTimes(2)
  })
})
