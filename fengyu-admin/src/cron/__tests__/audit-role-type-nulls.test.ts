/**
 * STEP 6 — role_type NULL 行回归监控
 *
 * 关键场景：
 *   A 双表 0 NULL → alertedCount=0，仅 1 次 SELECT
 *   B sale_allocations > 0 NULL → 写 1 条 operation_logs(action='dataIntegrity.roleTypeNull')
 *   C 双表都 > 0 NULL → 写 2 条
 *   D 永远不 UPDATE 业务表（只读审计）
 *   E source 字段写 'cronTask'（保留语义）
 *   F string 类型 count 也能正确处理（PG bigint cast）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { paramsOf, sqlTextOf } from './_helpers'

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

import { auditRoleTypeNulls } from '../steps/audit-role-type-nulls'

describe('cron-worker STEP 6 — auditRoleTypeNulls', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 双表 0 NULL → alertedCount=0，仅 1 次 SELECT', async () => {
    mockExecute.mockResolvedValueOnce([{ sale_alloc_null: 0, svc_comm_null: 0 }])

    const result = await auditRoleTypeNulls(mockDb as never)

    expect(result.alertedCount).toBe(0)
    expect(result.checks).toEqual([
      { table: 'sale_allocations', column: 'role_type', nullCount: 0 },
      { table: 'service_commissions', column: 'role_type', nullCount: 0 },
    ])
    // 只 1 次（SELECT），无 INSERT
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockDb.transaction).not.toHaveBeenCalled()
    // 0 NULL → 不外推 webhook
    expect(notifyOpsMock).not.toHaveBeenCalled()
  })

  it('B. sale_allocations > 0 NULL → 写 1 条 operation_logs', async () => {
    mockExecute.mockResolvedValueOnce([{ sale_alloc_null: 5, svc_comm_null: 0 }])
    mockExecute.mockResolvedValueOnce([]) // INSERT log

    const result = await auditRoleTypeNulls(mockDb as never)

    expect(result.alertedCount).toBe(1)
    expect(result.checks[0].nullCount).toBe(5)
    expect(result.checks[1].nullCount).toBe(0)

    const insertCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('dataIntegrity.roleTypeNull'),
    )
    expect(insertCalls.length).toBe(1)

    const params = paramsOf(insertCalls[0][0])
    expect(params).toContain('sale_allocations')
    const detailParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(detailParam).toBeDefined()
    expect(detailParam).toContain('"table":"sale_allocations"')
    expect(detailParam).toContain('"nullCount":5')

    // alertedCount > 0 → webhook 推送一次（无论命中几张表都合并 1 次）
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('dataIntegrity.roleTypeNull')
    expect(msg).toContain('sale_allocations.role_type NULL 行数：5')
  })

  it('C. 双表都 > 0 NULL → 写 2 条 operation_logs', async () => {
    mockExecute.mockResolvedValueOnce([{ sale_alloc_null: 3, svc_comm_null: 7 }])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    const result = await auditRoleTypeNulls(mockDb as never)

    expect(result.alertedCount).toBe(2)

    const insertCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('dataIntegrity.roleTypeNull'),
    )
    expect(insertCalls.length).toBe(2)

    const allParams = insertCalls.flatMap((c) => paramsOf(c[0]))
    expect(allParams).toContain('sale_allocations')
    expect(allParams).toContain('service_commissions')

    // 双表命中也只推一次 webhook，消息含两行明细
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('sale_allocations.role_type NULL 行数：3')
    expect(msg).toContain('service_commissions.role_type NULL 行数：7')
  })

  it('D. 永远不 UPDATE 业务表（只读审计）', async () => {
    mockExecute.mockResolvedValueOnce([{ sale_alloc_null: 10, svc_comm_null: 10 }])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    await auditRoleTypeNulls(mockDb as never)

    const updateCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return (
        s.includes('UPDATE sale_allocations') ||
        s.includes('UPDATE service_commissions')
      )
    })
    expect(updateCalls.length).toBe(0)
  })

  it("E. source 字段写 'cronTask'（保留语义）", async () => {
    mockExecute.mockResolvedValueOnce([{ sale_alloc_null: 1, svc_comm_null: 0 }])
    mockExecute.mockResolvedValueOnce([])

    await auditRoleTypeNulls(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    expect(sqlTexts.some((t) => t.includes("'cronTask'"))).toBe(true)
  })

  it('F. string 类型 count（PG bigint cast）也能正确处理', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_alloc_null: '4', svc_comm_null: '0' },
    ])
    mockExecute.mockResolvedValueOnce([])

    const result = await auditRoleTypeNulls(mockDb as never)

    expect(result.checks[0].nullCount).toBe(4)
    expect(result.checks[1].nullCount).toBe(0)
    expect(result.alertedCount).toBe(1)
  })

  it('G. 无 row 返回（容错） → 视作 0 NULL', async () => {
    mockExecute.mockResolvedValueOnce([])

    const result = await auditRoleTypeNulls(mockDb as never)

    expect(result.alertedCount).toBe(0)
    expect(result.checks.every((c) => c.nullCount === 0)).toBe(true)
  })
})
