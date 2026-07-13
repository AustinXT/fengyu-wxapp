/**
 * STEP — resetCrossStoreFlags（仅顾客跨门店临时绑定；2026-07-13 起）
 *
 * 关键场景：
 *   A 重置若干顾客行 → 返回 {customerReset}（postgres.js .count）
 *   B 无标记行 → 计数 0
 *   C SQL 形态：UPDATE ... SET is_cross_store_temp=false WHERE is_cross_store_temp=true（仅命中 true 行）
 *   D 兼容 node-pg 的 .rowCount 字段（rowsAffected 双 driver 兜底）
 *
 * 决议变更（2026-07-13）：员工出差标记不再由本 STEP 重置（改为长期保留，由 admin 手动关闭），
 * 故仅校验顾客侧 UPDATE。
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

import { resetCrossStoreFlags } from '../steps/reset-cross-store-flags'

describe('cron-worker STEP — resetCrossStoreFlags', () => {
  beforeEach(() => {
    mockExecute.mockReset()
  })

  it('A. 重置若干顾客行 → 返回 customerReset（postgres.js .count）', async () => {
    mockExecute.mockResolvedValueOnce({ count: 5 })

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ customerReset: 5 })
    // 仅一次顾客 UPDATE，无其他写入
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('B. 无标记行 → 计数 0', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 })

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ customerReset: 0 })
  })

  it('C. SQL 形态：顾客表 UPDATE is_cross_store_temp=false WHERE is_cross_store_temp=true', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 })

    await resetCrossStoreFlags(mockDb as never)

    const customerSql = sqlTextOf(mockExecute.mock.calls[0][0])
    expect(customerSql).toMatch(/UPDATE\s+client_wechat_users/)
    expect(customerSql).toMatch(/is_cross_store_temp\s*=\s*false/)
    expect(customerSql).toMatch(/WHERE\s+is_cross_store_temp\s*=\s*true/)
  })

  it('D. 兼容 node-pg 的 .rowCount 字段', async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 4 })

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ customerReset: 4 })
  })
})
