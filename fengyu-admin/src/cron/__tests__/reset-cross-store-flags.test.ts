/**
 * STEP — resetCrossStoreFlags（跨门店员工共享 + 顾客跨门店临时绑定，2026-06-24）
 *
 * 关键场景：
 *   A 两表各重置若干行 → 返回 {staffReset, customerReset}（postgres.js .count）
 *   B 无标记行 → 计数 0
 *   C SQL 形态：UPDATE ... SET <flag>=false WHERE <flag>=true（仅命中 true 行）
 *   D 兼容 node-pg 的 .rowCount 字段（rowsAffected 双 driver 兜底）
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

  it('A. 两表各重置若干行 → 返回 staffReset / customerReset（postgres.js .count）', async () => {
    mockExecute.mockResolvedValueOnce({ count: 3 }) // staff
    mockExecute.mockResolvedValueOnce({ count: 5 }) // customer

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ staffReset: 3, customerReset: 5 })
    // 两次 UPDATE：先员工后顾客，无其他写入
    expect(mockExecute).toHaveBeenCalledTimes(2)
  })

  it('B. 无标记行 → 计数 0', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 })
    mockExecute.mockResolvedValueOnce({ count: 0 })

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ staffReset: 0, customerReset: 0 })
  })

  it('C. SQL 形态：员工/顾客表 UPDATE <flag>=false WHERE <flag>=true', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 })
    mockExecute.mockResolvedValueOnce({ count: 0 })

    await resetCrossStoreFlags(mockDb as never)

    const staffSql = sqlTextOf(mockExecute.mock.calls[0][0])
    expect(staffSql).toMatch(/UPDATE\s+staff_wechat_users/)
    expect(staffSql).toMatch(/is_on_business_trip\s*=\s*false/)
    expect(staffSql).toMatch(/WHERE\s+is_on_business_trip\s*=\s*true/)

    const customerSql = sqlTextOf(mockExecute.mock.calls[1][0])
    expect(customerSql).toMatch(/UPDATE\s+client_wechat_users/)
    expect(customerSql).toMatch(/is_cross_store_temp\s*=\s*false/)
    expect(customerSql).toMatch(/WHERE\s+is_cross_store_temp\s*=\s*true/)
  })

  it('D. 兼容 node-pg 的 .rowCount 字段', async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 2 })
    mockExecute.mockResolvedValueOnce({ rowCount: 4 })

    const result = await resetCrossStoreFlags(mockDb as never)

    expect(result).toEqual({ staffReset: 2, customerReset: 4 })
  })
})
