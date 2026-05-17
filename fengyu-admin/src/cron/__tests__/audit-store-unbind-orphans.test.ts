/**
 * STEP 10 — auditStoreUnbindOrphans（store_unbind_requests 孤儿巡检）
 *
 * 关键场景：
 *   A 4 类 count 全为 0 → totalOrphans=0；零 INSERT；零 notifyOps
 *   B 仅 O1 命中 → 单条 INSERT operation_logs(action='cron.audit_store_unbind_orphans') + notifyOps
 *   C 4 类全部命中 → byKind 4 个 key；notifyOps message 含全部 kind 名
 *   D 永不修补（无 UPDATE / DELETE FROM SQL）
 *   E SAMPLE_LIMIT cap：count 与 samples.length 解耦（count 可大于 samples.length）
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

import { auditStoreUnbindOrphans } from '../steps/audit-store-unbind-orphans'

type SampleRow = {
  request_id: string
  user_id: string
  from_store_id: string
  created_at: string
}

interface Cat {
  c: number
  s?: SampleRow[]
}

/** 按 O1 sample, O1 count, O2 sample, O2 count, O3 sample, O3 count, O4 sample, O4 count 顺序排队 mock 返回 */
function queueAll(o1: Cat, o2: Cat, o3: Cat, o4: Cat) {
  const cats = [o1, o2, o3, o4]
  for (const cat of cats) {
    mockExecute.mockResolvedValueOnce(cat.s ?? [])
    mockExecute.mockResolvedValueOnce([{ cnt: cat.c }])
  }
}

const sampleOf = (rid: string): SampleRow => ({
  request_id: rid,
  user_id: `u-${rid}`,
  from_store_id: `s-${rid}`,
  created_at: '2026-05-01T00:00:00Z',
})

describe('cron-worker STEP 10 — auditStoreUnbindOrphans', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 4 类 count 全为 0 → totalOrphans=0；零 INSERT；零 notifyOps', async () => {
    queueAll({ c: 0 }, { c: 0 }, { c: 0 }, { c: 0 })

    const result = await auditStoreUnbindOrphans(mockDb as never)

    expect(result.totalOrphans).toBe(0)
    expect(result.byKind).toEqual({})
    // 4 类 × (sample + count) = 8 次 execute；无 INSERT
    expect(mockExecute).toHaveBeenCalledTimes(8)
    expect(notifyOpsMock).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('B. 仅 O1 命中 → 单条 INSERT operation_logs + notifyOps 1 次', async () => {
    queueAll(
      { c: 1, s: [sampleOf('r1')] },
      { c: 0 },
      { c: 0 },
      { c: 0 },
    )
    // INSERT operation_logs 的返回
    mockExecute.mockResolvedValueOnce([])

    const result = await auditStoreUnbindOrphans(mockDb as never)

    expect(result.totalOrphans).toBe(1)
    expect(result.byKind).toEqual({ unbound_but_pending: 1 })

    // 单条聚合 INSERT
    const logCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('cron.audit_store_unbind_orphans'),
    )
    expect(logCalls.length).toBe(1)

    // detail 参数（jsonb 字符串）含 kind 名
    const params = paramsOf(logCalls[0][0])
    const jsonParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(jsonParam).toContain('unbound_but_pending')
    expect(jsonParam).toContain('unbind_orphans')

    // target_id 是日期戳
    const dateParam = params.find(
      (p): p is string => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p),
    )
    expect(dateParam).toBeDefined()

    // notifyOps 调用 1 次，message 含 kind 名 + 标题
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('cron.audit_store_unbind_orphans')
    expect(msg).toContain('unbound_but_pending')
    expect(msg).toContain('1 条异常')
  })

  it('C. 4 类全部命中 → byKind 4 个 key；notifyOps message 含全部 kind 名', async () => {
    queueAll(
      { c: 2, s: [sampleOf('r1'), sampleOf('r2')] },
      { c: 1, s: [sampleOf('r3')] },
      { c: 3, s: [sampleOf('r4'), sampleOf('r5'), sampleOf('r6')] },
      { c: 4, s: [sampleOf('r7'), sampleOf('r8'), sampleOf('r9'), sampleOf('r10')] },
    )
    mockExecute.mockResolvedValueOnce([]) // INSERT

    const result = await auditStoreUnbindOrphans(mockDb as never)

    expect(result.totalOrphans).toBe(10) // 2 + 1 + 3 + 4
    expect(result.byKind).toEqual({
      unbound_but_pending: 2,
      bound_to_other_store: 1,
      target_store_closed: 3,
      pending_over_30d: 4,
    })

    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('unbound_but_pending')
    expect(msg).toContain('bound_to_other_store')
    expect(msg).toContain('target_store_closed')
    expect(msg).toContain('pending_over_30d')
    expect(msg).toContain('10 条异常')
  })

  it('D. 永不修补：全程零 UPDATE / DELETE FROM SQL', async () => {
    queueAll(
      { c: 1, s: [sampleOf('r1')] },
      { c: 1, s: [sampleOf('r2')] },
      { c: 1, s: [sampleOf('r3')] },
      { c: 1, s: [sampleOf('r4')] },
    )
    mockExecute.mockResolvedValueOnce([])

    await auditStoreUnbindOrphans(mockDb as never)

    const writeCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return /\bUPDATE\s+\w|\bDELETE\s+FROM\b/.test(s)
    })
    expect(writeCalls.length).toBe(0)
  })

  it('E. SAMPLE_LIMIT cap：count 12 但 samples 仅 10 条', async () => {
    const samples10 = Array.from({ length: 10 }, (_, i) => sampleOf(`r${i}`))
    queueAll(
      { c: 12, s: samples10 },
      { c: 0 },
      { c: 0 },
      { c: 0 },
    )
    mockExecute.mockResolvedValueOnce([])

    const result = await auditStoreUnbindOrphans(mockDb as never)

    expect(result.totalOrphans).toBe(12)
    expect(result.byKind.unbound_but_pending).toBe(12)

    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('12 条')
    expect(msg).toContain('样例 10 条')
  })

  it('F. SQL 模板检查：4 类 SELECT 包含预期字面量', async () => {
    queueAll({ c: 0 }, { c: 0 }, { c: 0 }, { c: 0 })

    await auditStoreUnbindOrphans(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    // O1: bound_store_id IS NULL
    expect(sqlTexts.some((s) => s.includes('cwu.bound_store_id IS NULL'))).toBe(true)
    // O2: bound_store_id <> sur.from_store_id
    expect(sqlTexts.some((s) => s.includes('cwu.bound_store_id <> sur.from_store_id'))).toBe(true)
    // O3: is_closed
    expect(sqlTexts.some((s) => s.includes('is_closed'))).toBe(true)
    // O4: 30 days
    expect(sqlTexts.some((s) => s.includes("INTERVAL '30 days'"))).toBe(true)
    // 全部 pending 限定
    expect(sqlTexts.filter((s) => s.includes("sur.status = '待处理'")).length).toBeGreaterThanOrEqual(8)
  })
})
