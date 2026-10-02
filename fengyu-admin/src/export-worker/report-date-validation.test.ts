import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

const { mockGetSession, queries } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}))

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params })
    return { rows: [] }
  })
  return { db: Object.assign(db, { transaction: async (fn: (tx: typeof db) => unknown) => fn(db) }) }
})

import { createExportContent } from './registry'
import { parseReportMonth, parseReportRange } from '@/lib/data-center/report-period'
const HQ: AuthSession = {
  employeeId: 'FY-ADMIN', name: '管理员', phone: '1',
  roles: [{ role: 'manager', scopeId: 'HQ', scopeType: '总部', actions: ['data_center:dashboard', 'data_center:staff_commission'], scopeStoreIds: [], scopeOrgNodeIds: [] }],
  permissions: { actions: ['data_center:dashboard', 'data_center:staff_commission'], scopeStoreIds: [], scopeOrgNodeIds: [] },
} as unknown as AuthSession


beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T04:00:00Z')) })
afterAll(() => vi.useRealTimers())
beforeEach(() => { mockGetSession.mockResolvedValue(HQ); queries.length = 0 })

describe('#452 提成导出月份复检', () => {
  const views = ['report-commission-daily', 'report-commission-detail'] as const
  it.each(views.flatMap(view => [undefined, '', '2099-99', '1999-12', '2026-9', '2099-12', '2026-10'].map(month => ({ view, month }))))('$view 拒绝 $month 且不查库', async ({ view, month }) => {
    await expect(createExportContent('data-center', { view, params: month === undefined ? {} : { month } })).rejects.toThrow(/^INVALID_PARAMS: /)
    expect(queries).toEqual([])
  })
  it.each(views.flatMap(view => ['2026-08', '2026-09'].map(month => ({ view, month }))))('$view 合法 $month 不回落', async ({ view, month }) => {
    const content = await createExportContent('data-center', { view, params: { month } })
    expect(content.meta?.period).toMatch(new RegExp(`^${month}-01 ~ ${month}-`))
    expect(queries.some(q => q.params.includes(`${month}-01`))).toBe(true)
  })
})

describe('#452 日常一览表 custom 复检', () => {
  it.each([
    ['2026-02-30', '2026-03-01'], ['2026-13-01', '2026-12-31'],
    ['2026-01-01', '2026-01-32'], ['1899-12-31', '1900-01-01'],
    ['2100-12-31', '2101-01-01'], ['2026-03-02', '2026-03-01'],
    ['2024-01-01', '2025-01-01'], ['', '2026-08-01'],
    ['2026-08-01', ''], ['2026-10-01', '2026-10-02'],
  ])('拒绝 %s ~ %s 且不查库', async (start, end) => {
    await expect(createExportContent('data-center', { view: 'report-daily-overview', params: { period: 'custom', start, end } })).rejects.toThrow(/^INVALID_PARAMS: /)
    expect(queries).toEqual([])
  })
  it.each([
    ['2024-02-29', '2024-02-29', '2024-02-29'],
    ['2024-01-01', '2024-12-31', '2024-12-31'],
    ['1900-01-01', '1900-01-02', '1900-01-02'],
    ['2026-09-01', '2026-09-30', '2026-09-15'],
  ])('合法 %s ~ %s，导出实际区间到 %s', async (start, end, actualEnd) => {
    const content = await createExportContent('data-center', { view: 'report-daily-overview', params: { period: 'custom', start, end } })
    expect(content.meta?.period).toBe(`${start} ~ ${actualEnd}`)
    expect(queries.some(q => q.params.includes(start) && q.params.includes(actualEnd))).toBe(true)
  })
  it('缺省预设仍可导出，页面解析仍按原有规则回落', async () => {
    const content = await createExportContent('data-center', { view: 'report-daily-overview', params: {} })
    expect(content.meta?.period).toBe('2026-08-01 ~ 2026-08-31')
    expect(parseReportMonth({ month: '2099-99' }).month).toBe('2026-08')
    expect(parseReportMonth({ month: '2099-12' }).month).toBe('2026-08')
    expect(parseReportRange({ period: 'custom', start: '2026-02-30', end: '2026-03-01' }).preset).toBe('lastMonth')
  })
})
