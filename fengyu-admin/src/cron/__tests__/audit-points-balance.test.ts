/**
 * STEP 5 — 积分余额一致性校验（新增；原 cronTask 缺测）
 *
 * 关键场景：
 *   A 无偏差 → mismatchCount=0，仅 SELECT
 *   B 有偏差 → 写 operation_logs(action='points.balanceMismatch')
 *   C 永远不更新 client_wechat_users.points_balance（决策 D7）
 *   D delta 计算正确（expected - cached）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { paramsOf, sqlTextOf, flatParamsOfCalls } from './_helpers'

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

const notifyOpsMock = vi.fn<(msg: string) => Promise<void>>()
vi.mock('../lib/notify', () => ({
  notifyOps: (msg: string) => notifyOpsMock(msg),
}))

import { auditPointsBalance } from '../steps/audit-points-balance'

describe('cron-worker STEP 5 — auditPointsBalance', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 无偏差 → mismatchCount=0', async () => {
    // SELECT mismatches → 空
    mockExecute.mockResolvedValueOnce([])
    // SELECT COUNT(*)
    mockExecute.mockResolvedValueOnce([{ cnt: 100 }])

    const result = await auditPointsBalance(mockDb as never)

    expect(result).toEqual({ mismatchCount: 0, checkedCount: 100 })
    // 仅 2 次调用：SELECT mismatch + SELECT count
    expect(mockExecute).toHaveBeenCalledTimes(2)
    // 永不进 transaction
    expect(mockDb.transaction).not.toHaveBeenCalled()
    // 无偏差 → 不外推 webhook
    expect(notifyOpsMock).not.toHaveBeenCalled()
  })

  it('B. 有偏差 → 每条偏差写一条 operation_logs', async () => {
    mockExecute.mockResolvedValueOnce([
      { user_id: 'u1', cached_balance: 100, expected_balance: 150 },
      { user_id: 'u2', cached_balance: 50, expected_balance: 30 },
    ])
    mockExecute.mockResolvedValueOnce([]) // INSERT log u1
    mockExecute.mockResolvedValueOnce([]) // INSERT log u2
    mockExecute.mockResolvedValueOnce([{ cnt: 100 }])

    const result = await auditPointsBalance(mockDb as never)

    expect(result).toEqual({ mismatchCount: 2, checkedCount: 100 })

    // 找出两条 INSERT operation_logs 调用
    const logCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('points.balanceMismatch'),
    )
    expect(logCalls.length).toBe(2)

    // 从所有 INSERT 调用中提取 detail 参数（JSON 字符串），断言 delta 计算
    const detailParams = logCalls
      .flatMap((c) => paramsOf(c[0]))
      .filter((p): p is string => typeof p === 'string' && p.startsWith('{'))
    // u1 delta = 150 - 100 = 50（expected - cached）
    expect(detailParams.some((d) => d.includes('"delta":50'))).toBe(true)
    // u2 delta = 30 - 50 = -20
    expect(detailParams.some((d) => d.includes('"delta":-20'))).toBe(true)

    // 有偏差 → 调用一次 webhook，消息含 action 标签 + 偏差总数
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('points.balanceMismatch')
    expect(msg).toContain('偏差用户数：2')
  })

  it('C. 永远不更新 client_wechat_users.points_balance', async () => {
    mockExecute.mockResolvedValueOnce([
      { user_id: 'u1', cached_balance: 100, expected_balance: 150 },
    ])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([{ cnt: 1 }])

    await auditPointsBalance(mockDb as never)

    const updateCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return s.includes('UPDATE client_wechat_users') && s.includes('points_balance')
    })
    expect(updateCalls.length).toBe(0)
  })

  it('D. cached_balance 为 string 时也能正确计算 delta', async () => {
    mockExecute.mockResolvedValueOnce([
      { user_id: 'u1', cached_balance: '200', expected_balance: '180' },
    ])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([{ cnt: 1 }])

    await auditPointsBalance(mockDb as never)

    const detailParams = flatParamsOfCalls(mockExecute.mock.calls).filter(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(detailParams.some((d) => d.includes('"cachedBalance":200'))).toBe(true)
    expect(detailParams.some((d) => d.includes('"expectedBalance":180'))).toBe(true)
    expect(detailParams.some((d) => d.includes('"delta":-20'))).toBe(true)
  })

  it('source 字段写 cronTask 字符串（保留语义）', async () => {
    mockExecute.mockResolvedValueOnce([
      { user_id: 'u1', cached_balance: 0, expected_balance: 1 },
    ])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([{ cnt: 1 }])

    await auditPointsBalance(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    expect(sqlTexts.some((t) => t.includes("'cronTask'"))).toBe(true)
  })
})
