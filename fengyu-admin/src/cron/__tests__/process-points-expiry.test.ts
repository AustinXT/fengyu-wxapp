/**
 * STEP — 积分批次过期与提醒
 *
 * 覆盖：
 *   A 到期批次写过期扣减流水、清零批次、重算余额
 *   B 60/30/7 天提醒写 messages(type='points') 且幂等
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sqlTextOf } from './_helpers'

const mockExecute = vi.fn()
const mockDb = {
  execute: mockExecute,
  transaction: vi.fn(),
}

vi.mock('@/db', () => ({
  get db() {
    return mockDb
  },
}))

import { processPointsExpiry } from '../steps/process-points-expiry'

describe('cron-worker — processPointsExpiry', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
  })

  it('A. 处理到期批次并生成 60/30/7 天提醒', async () => {
    mockExecute.mockResolvedValueOnce([
      { expired_batches: 2, expired_points: 150, expired_users: 1 },
    ])
    mockExecute.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // 60 天提醒
    mockExecute.mockResolvedValueOnce([{ id: 3 }]) // 30 天提醒
    mockExecute.mockResolvedValueOnce([]) // 7 天提醒

    const result = await processPointsExpiry(mockDb as never, {
      referenceDate: new Date('2026-07-27T03:00:00+08:00'),
    })

    expect(result).toEqual({
      expiredBatches: 2,
      expiredPoints: 150,
      expiredUsers: 1,
      reminderMessages: 3,
      remindersByDays: { 60: 2, 30: 1, 7: 0 },
    })

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    expect(sqlTexts[0]).toContain("type, amount")
    expect(sqlTexts[0]).toContain("'过期扣减'")
    expect(sqlTexts[0]).toContain('UPDATE point_batches')
    expect(sqlTexts[0]).toContain('UPDATE client_wechat_users')

    const reminderSql = sqlTexts.slice(1).join('\n')
    expect(reminderSql).toContain("message_type")
    expect(reminderSql).toContain("'points'")
    expect(reminderSql).toContain('points-expiry-reminder-')
    expect(reminderSql).toContain('ON CONFLICT (idempotency_key)')
  })
})
