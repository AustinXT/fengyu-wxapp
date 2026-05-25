/**
 * STEP 8 — closeExpiredAppointments（D-Q4-2026-04-26）
 *
 * 关键场景：
 *   A 无超期预约 → closed=0，不写日志
 *   B 有超期预约 → UPDATE + 单条聚合 operation_logs
 *   C SQL 形态：status IN ('待确认','已确认') + checkin_at IS NULL + appointment_time < date_trunc('day', NOW())
 *   D 不调 notifyOps（常规清扫）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sqlTextOf, paramsOf } from './_helpers'

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

import { closeExpiredAppointments } from '../steps/close-expired-appointments'

describe('cron-worker STEP 8 — closeExpiredAppointments', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 无超期预约 → closed=0，不写 operation_logs', async () => {
    mockExecute.mockResolvedValueOnce([])

    const result = await closeExpiredAppointments(mockDb as never)

    expect(result).toEqual({ closed: 0, ids: [] })
    // 仅 1 次调用：UPDATE RETURNING；无后续 INSERT log
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(notifyOpsMock).not.toHaveBeenCalled()
  })

  it('B. 有超期预约 → UPDATE + 单条聚合 operation_logs', async () => {
    mockExecute.mockResolvedValueOnce([
      { appointment_id: 'apt-1' },
      { appointment_id: 'apt-2' },
      { appointment_id: 'apt-3' },
    ])
    mockExecute.mockResolvedValueOnce([])

    const result = await closeExpiredAppointments(mockDb as never)

    expect(result.closed).toBe(3)
    expect(result.ids).toEqual(['apt-1', 'apt-2', 'apt-3'])

    // 第二次调用是 INSERT log
    const logCall = mockExecute.mock.calls[1]
    const sqlText = sqlTextOf(logCall[0])
    expect(sqlText).toContain('cron.close_expired_appointments')
    expect(sqlText).toContain('appointment')

    // detail 参数含 count + ids 数组
    const params = paramsOf(logCall[0])
    const jsonParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(jsonParam).toBeDefined()
    expect(jsonParam).toContain('"count":3')
    expect(jsonParam).toContain('apt-1')
    expect(jsonParam).toContain('apt-3')
  })

  it("C. SQL 形态：UPDATE appointments SET status='已关闭' WHERE status IN ('待确认','已确认') + 时间窗", async () => {
    mockExecute.mockResolvedValueOnce([])

    await closeExpiredAppointments(mockDb as never)

    const sqlText = sqlTextOf(mockExecute.mock.calls[0][0])
    expect(sqlText).toMatch(/UPDATE\s+appointments/)
    expect(sqlText).toMatch(/status\s*=\s*'已关闭'/)
    expect(sqlText).toMatch(/status\s+IN\s*\(\s*'待确认'\s*,\s*'已确认'\s*\)/)
    expect(sqlText).toMatch(/checkin_at\s+IS\s+NULL/)
    expect(sqlText).toMatch(/appointment_time\s*<\s*date_trunc\(\s*'day'/)
    expect(sqlText).toMatch(/RETURNING\s+appointment_id/)
  })

  it('D. 不调 notifyOps（常规清扫，非告警）', async () => {
    mockExecute.mockResolvedValueOnce([{ appointment_id: 'apt-1' }])
    mockExecute.mockResolvedValueOnce([])

    await closeExpiredAppointments(mockDb as never)

    expect(notifyOpsMock).not.toHaveBeenCalled()
  })

  it('E. ids 列表过长时，operation_logs 仅记前 100 条', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => ({ appointment_id: `apt-${i}` }))
    mockExecute.mockResolvedValueOnce(ids)
    mockExecute.mockResolvedValueOnce([])

    const result = await closeExpiredAppointments(mockDb as never)

    expect(result.closed).toBe(150)
    expect(result.ids.length).toBe(150)

    const logCall = mockExecute.mock.calls[1]
    const params = paramsOf(logCall[0])
    const jsonParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    ) as string

    const detail = JSON.parse(jsonParam) as { count: number; ids: string[] }
    expect(detail.count).toBe(150)
    expect(detail.ids.length).toBe(100)
  })
})
