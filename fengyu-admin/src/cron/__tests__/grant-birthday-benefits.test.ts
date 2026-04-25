/**
 * STEP 3 — 生日权益发放（迁自 cronTask/__tests__/birthday.test.js）
 *
 * 关键场景（精简自原 ticket §6 PR-2 验收矩阵）：
 *   A 命中顾客三件套全发
 *   B 配置缺失 → 直接返回 (total/sent/skipped/error 全 0)
 *   C 命中但当前等级无配置 → skippedNoConfig++
 *   D 模板停用 → 跳过该券（仍 sentCount++）
 *   E 单用户失败不影响下个用户
 *   F 幂等冲突（积分流水 RETURNING 空）→ balance 不累加
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { paramsOf, sqlTextOf } from './_helpers'

const mockExecute = vi.fn()
const mockDb = {
  execute: mockExecute,
  transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
}

vi.mock('@/db', () => ({
  get db() {
    return mockDb
  },
}))

import { grantBirthdayBenefits } from '../steps/grant-birthday-benefits'

const FULL_CONFIG = {
  黑钻: {
    messageTitle: '生日快乐',
    messageBody: '祝您生日快乐！',
    points: 500,
    couponTemplateIds: ['tpl-1'],
  },
}

/** 一个完整命中场景的执行序列（mockResolvedValueOnce 按顺序消费） */
function expectHitSequence({
  year = 2026,
  userId = 'u1',
  level = '黑钻',
  config = FULL_CONFIG,
  templateActive = true,
  pointsInsertConflict = false,
} = {}) {
  // 1) loadJsonConfig (birthday_benefits)
  mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(config) }])
  // 2) SELECT year
  mockExecute.mockResolvedValueOnce([{ year }])
  // 3) SELECT 命中顾客
  mockExecute.mockResolvedValueOnce([{ user_id: userId, member_level: level }])
  // 4) tx 内：INSERT messages
  mockExecute.mockResolvedValueOnce([])
  // 5) tx 内：INSERT point_transactions RETURNING
  mockExecute.mockResolvedValueOnce(pointsInsertConflict ? [] : [{ id: 1 }])
  // 6) tx 内：UPDATE points_balance（仅当流水插入成功）
  if (!pointsInsertConflict) mockExecute.mockResolvedValueOnce([])
  // 7) tx 内：SELECT coupon_templates
  mockExecute.mockResolvedValueOnce([
    {
      validity_mode: 'days',
      valid_days: 30,
      valid_to: null,
      is_active: templateActive,
    },
  ])
  // 8) tx 内：INSERT user_coupons（仅当模板有效）
  if (templateActive) mockExecute.mockResolvedValueOnce([])
  // 9) tx 内：INSERT operation_logs
  mockExecute.mockResolvedValueOnce([])
}

describe('cron-worker STEP 3 — grantBirthdayBenefits', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
  })

  describe('A. 命中顾客 + 完整配置', () => {
    it('sentCount=1，三件套全发', async () => {
      expectHitSequence({ userId: 'u1', year: 2026 })

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result).toEqual({
        total: 1,
        sentCount: 1,
        skippedNoConfig: 0,
        errorCount: 0,
      })
      expect(mockDb.transaction).toHaveBeenCalledTimes(1)
    })

    it('幂等键含年份（YYYY）', async () => {
      expectHitSequence({ userId: 'u-A', year: 2027 })
      await grantBirthdayBenefits(mockDb as never)

      const allParams = mockExecute.mock.calls.flatMap((c) => paramsOf(c[0]))
      expect(allParams).toContain('birthday-msg-2027-u-A')
      expect(allParams).toContain('birthday-pts-2027-u-A')
      expect(allParams).toContain('bday-2027-u-A-tpl-1')
    })
  })

  describe('B. 配置缺失', () => {
    it('birthday_benefits 不存在 → total=0，不查 year/不扫描', async () => {
      mockExecute.mockResolvedValueOnce([])

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result).toEqual({
        total: 0,
        sentCount: 0,
        skippedNoConfig: 0,
        errorCount: 0,
      })
      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })

    it('birthday_benefits 解析失败 → total=0', async () => {
      mockExecute.mockResolvedValueOnce([{ value: '{ broken json' }])

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result.total).toBe(0)
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })
  })

  describe('C. 命中顾客但等级无配置', () => {
    it('skippedNoConfig=1，sentCount=0', async () => {
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify({ 金钻: FULL_CONFIG.黑钻 }) }])
      mockExecute.mockResolvedValueOnce([{ year: 2026 }])
      mockExecute.mockResolvedValueOnce([{ user_id: 'u1', member_level: '黑钻' }])

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result).toEqual({
        total: 1,
        sentCount: 0,
        skippedNoConfig: 1,
        errorCount: 0,
      })
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })
  })

  describe('D. 优惠券模板停用', () => {
    it('券跳过但消息/积分/operation_logs 仍发放，sentCount=1', async () => {
      expectHitSequence({ userId: 'u1', templateActive: false })

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result.sentCount).toBe(1)
    })
  })

  describe('E. 多用户单点失败隔离', () => {
    it('第一个用户事务抛错，第二个仍正常发放', async () => {
      // load config + year
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(FULL_CONFIG) }])
      mockExecute.mockResolvedValueOnce([{ year: 2026 }])
      // SELECT 两个顾客
      mockExecute.mockResolvedValueOnce([
        { user_id: 'u-fail', member_level: '黑钻' },
        { user_id: 'u-ok', member_level: '黑钻' },
      ])

      // 第一次 transaction：tx.execute 中抛错
      mockDb.transaction
        .mockImplementationOnce(async () => {
          throw new Error('tx fail')
        })
        // 第二次 transaction：正常执行 callback
        .mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb))

      // 第二次 transaction 内的 tx.execute 序列（按 grantOneBirthday 顺序）
      mockExecute.mockResolvedValueOnce([]) // INSERT messages
      mockExecute.mockResolvedValueOnce([{ id: 2 }]) // INSERT points
      mockExecute.mockResolvedValueOnce([]) // UPDATE points_balance
      mockExecute.mockResolvedValueOnce([
        { validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true },
      ])
      mockExecute.mockResolvedValueOnce([]) // INSERT user_coupons
      mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

      const result = await grantBirthdayBenefits(mockDb as never)

      expect(result).toEqual({
        total: 2,
        sentCount: 1,
        skippedNoConfig: 0,
        errorCount: 1,
      })
    })
  })

  describe('F. 积分流水幂等冲突', () => {
    it('RETURNING 空时不再 UPDATE points_balance', async () => {
      expectHitSequence({ userId: 'u1', pointsInsertConflict: true })

      await grantBirthdayBenefits(mockDb as never)

      // 验证：未出现一条 UPDATE client_wechat_users SET points_balance 的调用
      const updatePtsCalls = mockExecute.mock.calls.filter((c) =>
        sqlTextOf(c[0]).includes('points_balance ='),
      )
      // pointsInsertConflict=true 时少了一次 UPDATE
      expect(updatePtsCalls.length).toBe(0)
    })
  })
})
