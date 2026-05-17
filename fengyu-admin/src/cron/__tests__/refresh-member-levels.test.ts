/**
 * STEP 2 — member_level 重算 + 升降级（新增；原 cronTask 缺测）
 *
 * 关键场景：
 *   A 升级路径：UPDATE + memberLevelChange 日志 + 三件套权益 + 150d 锁
 *   B 降级路径（保级期内）：仅 memberLevelHeld 日志，不更新 member_level
 *   C 降级路径（保级期已过）：UPDATE + memberLevelChange 日志，清 locked_until
 *   D 配置缺失：仍执行等级更新和日志，跳过权益发放
 *   E 等级未变 → unchanged++
 *   F 单用户失败不影响其他用户
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

// 把 getMemberThreshold 直接 mock 成同步常量
vi.mock('../config', () => ({
  getMemberThreshold: vi.fn(async () => 1980),
  invalidateCache: vi.fn(),
  FALLBACK_THRESHOLD: 1980,
}))

import { refreshMemberLevels } from '../steps/refresh-member-levels'

const BLACK_BENEFITS = {
  黑钻: {
    messageTitle: '黑钻特权',
    messageBody: '感谢',
    points: 1000,
    couponTemplateIds: ['tpl-1'],
  },
}

describe('cron-worker STEP 2 — refreshMemberLevels', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(mockDb),
    )
  })

  describe('A. 升级路径', () => {
    it('从星钻升到黑钻 → upgradeCount=1，写日志+权益', async () => {
      // load benefits config
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(BLACK_BENEFITS) }])
      // SELECT memberClients（含 spend，单条批量查询）
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u1',
          member_level: '星钻',
          member_level_locked_until: null,
          spend: '120000',
        },
      ])

      // tx 内：UPDATE level + INSERT operation_logs + grantUpgradeBenefits 三件套
      mockExecute.mockResolvedValueOnce([]) // UPDATE
      mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs
      mockExecute.mockResolvedValueOnce([]) // INSERT messages
      mockExecute.mockResolvedValueOnce([{ id: 1 }]) // INSERT points
      mockExecute.mockResolvedValueOnce([]) // UPDATE points_balance
      mockExecute.mockResolvedValueOnce([
        { validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true },
      ]) // SELECT coupon_templates
      mockExecute.mockResolvedValueOnce([]) // INSERT user_coupons

      const result = await refreshMemberLevels(mockDb as never)

      expect(result).toEqual({
        total: 1,
        upgradeCount: 1,
        downgradeCount: 0,
        heldCount: 0,
        unchangedCount: 0,
        errorCount: 0,
      })
      // 验证 transaction 被调用一次（升级事务）
      expect(mockDb.transaction).toHaveBeenCalledTimes(1)
      // 升级幂等键（在 sql 模板的参数列表中）
      const allParams = mockExecute.mock.calls.flatMap((c) => paramsOf(c[0]))
      expect(allParams).toContain('member-upgrade-u1-黑钻')
      expect(allParams).toContain('cpn-up-u1-黑钻-tpl-1')
      // 150 天保级期写在 SQL 文本里（INTERVAL '150 days'）
      const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
      expect(sqlTexts.some((t) => t.includes("INTERVAL '150 days'"))).toBe(true)
    })

    it('配置缺失也仍升级（仅跳过权益）', async () => {
      mockExecute.mockResolvedValueOnce([]) // member_level_benefits 不存在
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u1',
          member_level: null,
          member_level_locked_until: null,
          spend: '12000',
        },
      ])
      mockExecute.mockResolvedValueOnce([]) // UPDATE level
      mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

      const result = await refreshMemberLevels(mockDb as never)

      expect(result.upgradeCount).toBe(1)
      // 仅 transaction 内 2 次 execute（UPDATE + INSERT log）；权益 3 件套不发
    })
  })

  describe('B. 降级路径（保级期内）', () => {
    it('lockedUntil 在未来 → heldCount=1，不更新 member_level', async () => {
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(BLACK_BENEFITS) }])
      const future = new Date(Date.now() + 10 * 86400000)
      // spend 较低 → 触发降级判定
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u1',
          member_level: '黑钻',
          member_level_locked_until: future,
          spend: '5000',
        },
      ])
      // 单条 INSERT memberLevelHeld（无事务）
      mockExecute.mockResolvedValueOnce([])

      const result = await refreshMemberLevels(mockDb as never)

      expect(result).toEqual({
        total: 1,
        upgradeCount: 0,
        downgradeCount: 0,
        heldCount: 1,
        unchangedCount: 0,
        errorCount: 0,
      })
      // 保级期内不进事务路径
      expect(mockDb.transaction).not.toHaveBeenCalled()
      const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
      expect(sqlTexts.some((t) => t.includes('customer.memberLevelHeld'))).toBe(true)
    })
  })

  describe('C. 降级路径（保级期已过）', () => {
    it('lockedUntil 已过期 → downgradeCount=1，UPDATE level + 清 locked_until', async () => {
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(BLACK_BENEFITS) }])
      const past = new Date(Date.now() - 10 * 86400000)
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u1',
          member_level: '黑钻',
          member_level_locked_until: past,
          spend: '5000',
        },
      ])
      // tx 内：UPDATE + INSERT log
      mockExecute.mockResolvedValueOnce([])
      mockExecute.mockResolvedValueOnce([])

      const result = await refreshMemberLevels(mockDb as never)

      expect(result).toEqual({
        total: 1,
        upgradeCount: 0,
        downgradeCount: 1,
        heldCount: 0,
        unchangedCount: 0,
        errorCount: 0,
      })
      expect(mockDb.transaction).toHaveBeenCalledTimes(1)
      const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
      expect(sqlTexts.some((t) => t.includes('member_level_locked_until = NULL'))).toBe(true)
      // direction:downgrade 写在 detail JSON 字符串参数里
      const detailParams = mockExecute.mock.calls
        .flatMap((c) => paramsOf(c[0]))
        .filter((p): p is string => typeof p === 'string' && p.startsWith('{'))
      expect(detailParams.some((d) => d.includes('"direction":"downgrade"'))).toBe(true)
    })
  })

  describe('E. 等级未变', () => {
    it('newLevel === oldLevel → unchangedCount++', async () => {
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(BLACK_BENEFITS) }])
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u1',
          member_level: '黑钻',
          member_level_locked_until: null,
          spend: '120000',
        },
      ])

      const result = await refreshMemberLevels(mockDb as never)

      expect(result).toEqual({
        total: 1,
        upgradeCount: 0,
        downgradeCount: 0,
        heldCount: 0,
        unchangedCount: 1,
        errorCount: 0,
      })
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })
  })

  describe('F. 单用户失败不影响其他用户', () => {
    it('某用户事务内 UPDATE 抛错 → 该用户 errorCount++，下个用户继续', async () => {
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(BLACK_BENEFITS) }])
      // 批量 SELECT memberClients（含 spend）
      mockExecute.mockResolvedValueOnce([
        {
          user_id: 'u-fail',
          member_level: '初钻',
          member_level_locked_until: null,
          spend: '12000',
        },
        {
          user_id: 'u-ok',
          member_level: '初钻',
          member_level_locked_until: null,
          spend: '12000',
        },
      ])

      // u-fail：升级事务的 UPDATE level 抛错
      mockExecute.mockRejectedValueOnce(new Error('update fail'))

      // u-ok：tx 内 UPDATE + INSERT log + 三件套
      mockExecute.mockResolvedValueOnce([])
      mockExecute.mockResolvedValueOnce([])
      mockExecute.mockResolvedValueOnce([])
      mockExecute.mockResolvedValueOnce([{ id: 1 }])
      mockExecute.mockResolvedValueOnce([])
      mockExecute.mockResolvedValueOnce([
        { validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true },
      ])
      mockExecute.mockResolvedValueOnce([])

      const result = await refreshMemberLevels(mockDb as never)

      expect(result.total).toBe(2)
      expect(result.errorCount).toBe(1)
      expect(result.upgradeCount).toBe(1)
    })
  })
})
