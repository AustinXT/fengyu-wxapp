/**
 * STEP 4 — 感恩日权益（迁自 cronTask/__tests__/thanksgiving.test.js）
 *
 * 关键场景：
 *   A 20 号当日命中 → 三件套全发，sentCount=1
 *   B 非 20 号 → skippedNotDay20，全部 0
 *   C 配置缺失 → 0
 *   D 模板停用 → 跳过该券
 *   E 优惠券固定 10 天有效期（不读 validity_mode）
 *   F 幂等冲突积分流水 → balance 不累加
 *   G 多用户单点失败隔离
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

import { grantThanksgivingBenefits } from '../steps/grant-thanksgiving-benefits'

const FULL_CONFIG = {
  黑钻: {
    messageTitle: '感恩黑钻',
    messageBody: '感恩您',
    points: 200,
    couponTemplateIds: ['tpl-1'],
  },
}

function expectFullSequence({
  day = 20,
  yearMonth = '2026-04',
  userId = 'u1',
  level = '黑钻',
  config = FULL_CONFIG,
  templateActive = true,
  pointsInsertConflict = false,
} = {}) {
  // 1) SELECT day
  mockExecute.mockResolvedValueOnce([{ d: day }])
  if (day !== 20) return // 短路

  // 2) loadJsonConfig
  mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(config) }])
  // 3) SELECT yearMonth
  mockExecute.mockResolvedValueOnce([{ ym: yearMonth }])
  // 4) SELECT 命中顾客
  mockExecute.mockResolvedValueOnce([{ user_id: userId, member_level: level }])
  // 5) tx 内：INSERT messages
  mockExecute.mockResolvedValueOnce([])
  // 6) tx 内：INSERT point_transactions RETURNING
  mockExecute.mockResolvedValueOnce(pointsInsertConflict ? [] : [{ id: 1 }])
  if (!pointsInsertConflict) mockExecute.mockResolvedValueOnce([])
  // 7) tx 内：SELECT coupon_templates is_active
  mockExecute.mockResolvedValueOnce([{ is_active: templateActive }])
  if (templateActive) mockExecute.mockResolvedValueOnce([])
  // 8) tx 内：INSERT operation_logs
  mockExecute.mockResolvedValueOnce([])
}

describe('cron-worker STEP 4 — grantThanksgivingBenefits', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(mockDb),
    )
  })

  describe('B. 非 20 号短路返回', () => {
    it('day=15 → skippedNotDay20, 不查配置/不扫描', async () => {
      mockExecute.mockResolvedValueOnce([{ d: 15 }])

      const result = await grantThanksgivingBenefits(mockDb as never)

      expect(result).toEqual({
        total: 0,
        sentCount: 0,
        skippedNoConfig: 0,
        errorCount: 0,
        skippedNotDay20: true,
      })
      expect(mockExecute).toHaveBeenCalledTimes(1)
    })
  })

  describe('A. 20 号命中', () => {
    it('完整三件套，sentCount=1，幂等键含 YYYY-MM', async () => {
      expectFullSequence({ userId: 'u-A', yearMonth: '2026-04' })

      const result = await grantThanksgivingBenefits(mockDb as never)

      expect(result).toEqual({
        total: 1,
        sentCount: 1,
        skippedNoConfig: 0,
        errorCount: 0,
      })
      const allParams = mockExecute.mock.calls.flatMap((c) => paramsOf(c[0]))
      expect(allParams).toContain('thx-msg-2026-04-u-A')
      expect(allParams).toContain('thx-pts-2026-04-u-A')
      expect(allParams).toContain('thx-2026-04-u-A-tpl-1')
    })
  })

  describe('C. 配置缺失', () => {
    it('thanksgiving_benefits 不存在 → total=0, 不扫描', async () => {
      mockExecute.mockResolvedValueOnce([{ d: 20 }])
      mockExecute.mockResolvedValueOnce([])

      const result = await grantThanksgivingBenefits(mockDb as never)

      expect(result).toEqual({
        total: 0,
        sentCount: 0,
        skippedNoConfig: 0,
        errorCount: 0,
      })
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })
  })

  describe('D. 模板停用', () => {
    it('券跳过，消息/积分仍发，sentCount=1', async () => {
      expectFullSequence({ templateActive: false })

      const result = await grantThanksgivingBenefits(mockDb as never)

      expect(result.sentCount).toBe(1)
    })
  })

  describe('E. 优惠券固定 10 天有效期', () => {
    it('expire_at 接近 now+10d，不读 validity_mode', async () => {
      expectFullSequence({ userId: 'u-E' })
      const before = Date.now()

      await grantThanksgivingBenefits(mockDb as never)

      const after = Date.now()
      // INSERT user_coupons 是包含 'thx-2026-04-u-E-tpl-1' 字符串参数的那次调用
      const couponInsertCall = mockExecute.mock.calls.find((c) =>
        paramsOf(c[0]).includes('thx-2026-04-u-E-tpl-1'),
      )
      expect(couponInsertCall).toBeDefined()
      const couponParams = paramsOf(couponInsertCall![0])
      // expireAt 经 beijingTs() 写成北京墙钟字面 'YYYY-MM-DD HH:mm:ss'（::timestamp，见 lib/db-time）
      const expireAtStr = couponParams.find(
        (p): p is string => typeof p === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p),
      )
      expect(expireAtStr).toBeDefined()
      // 按北京时区解析回绝对时刻（与进程 TZ 解耦）
      const expireMs = new Date(expireAtStr!.replace(' ', 'T') + '+08:00').getTime()
      const expectedMin = before + 10 * 86400000
      const expectedMax = after + 10 * 86400000
      expect(expireMs).toBeGreaterThanOrEqual(expectedMin - 1000)
      expect(expireMs).toBeLessThanOrEqual(expectedMax + 1000)
    })

    it('SELECT coupon_templates 不读 validity_mode/valid_days/valid_to（仅 is_active）', async () => {
      expectFullSequence({ userId: 'u' })
      await grantThanksgivingBenefits(mockDb as never)

      const tplCall = mockExecute.mock.calls.find((c) =>
        sqlTextOf(c[0]).includes('SELECT is_active FROM coupon_templates'),
      )
      expect(tplCall).toBeDefined()
    })
  })

  describe('F. 积分流水幂等冲突', () => {
    it('RETURNING 空 → 不 UPDATE points_balance', async () => {
      expectFullSequence({ userId: 'u-F', pointsInsertConflict: true })

      await grantThanksgivingBenefits(mockDb as never)

      const updatePtsCalls = mockExecute.mock.calls.filter((c) =>
        sqlTextOf(c[0]).includes('points_balance ='),
      )
      expect(updatePtsCalls.length).toBe(0)
    })
  })

  describe('G. 多用户单点失败隔离', () => {
    it('第一个用户失败、第二个用户成功 → errorCount=1, sentCount=1', async () => {
      mockExecute.mockResolvedValueOnce([{ d: 20 }])
      mockExecute.mockResolvedValueOnce([{ value: JSON.stringify(FULL_CONFIG) }])
      mockExecute.mockResolvedValueOnce([{ ym: '2026-04' }])
      mockExecute.mockResolvedValueOnce([
        { user_id: 'u-fail', member_level: '黑钻' },
        { user_id: 'u-ok', member_level: '黑钻' },
      ])

      mockDb.transaction
        .mockImplementationOnce(async () => {
          throw new Error('tx fail')
        })
        .mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb))

      // 第二个用户正常事务的 tx.execute 序列
      mockExecute.mockResolvedValueOnce([]) // INSERT messages
      mockExecute.mockResolvedValueOnce([{ id: 2 }]) // INSERT points
      mockExecute.mockResolvedValueOnce([]) // UPDATE balance
      mockExecute.mockResolvedValueOnce([{ is_active: true }]) // template
      mockExecute.mockResolvedValueOnce([]) // INSERT coupon
      mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

      const result = await grantThanksgivingBenefits(mockDb as never)

      expect(result).toEqual({
        total: 2,
        sentCount: 1,
        skippedNoConfig: 0,
        errorCount: 1,
      })
    })
  })
})
