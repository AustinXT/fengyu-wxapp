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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { createExportContent } from './registry'
import { completeExportMeta } from './export-meta'
import { writeStreamXlsx } from './xlsx-writer'
import { DATA_CENTER_BOARD_EXPORT_VIEWS, DATA_CENTER_EXPORT_VIEWS, type DataCenterBoardExportView } from '@/lib/export-job-types'
import { DATA_CENTER_VIEW_CONFIG } from '@/lib/data-center/columns'
const HQ: AuthSession = {
  employeeId: 'FY-ADMIN', name: '管理员', phone: '1',
  roles: [{ role: 'manager', scopeId: 'HQ', scopeType: '总部', actions: ['data_center:dashboard'], scopeStoreIds: [], scopeOrgNodeIds: [] }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [], scopeOrgNodeIds: [] },
} as unknown as AuthSession


beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T04:05:06Z')) })
afterAll(() => vi.useRealTimers())
beforeEach(() => { mockGetSession.mockResolvedValue(HQ); queries.length = 0 })

const periods = [
  { preset: 'today', start: '2026-09-15', end: '2026-09-15', label: '今日' },
  { preset: 'week', start: '2026-09-14', end: '2026-09-15', label: '本周' },
  { preset: 'month', start: '2026-09-01', end: '2026-09-15', label: '本月' },
  { preset: 'year', start: '2026-01-01', end: '2026-09-15', label: '今年' },
  { preset: 'custom', start: '2026-08-01', end: '2026-08-31', label: '自定义' },
]

describe('#296 registry 真实 action 实际期间，与页面解析同源', () => {
  it.each(DATA_CENTER_BOARD_EXPORT_VIEWS.flatMap(view => periods.map(period => ({ view, period }))))('$view $period.preset', async ({ view, period }) => {
    const config = DATA_CENTER_VIEW_CONFIG[view]
    const content = await createExportContent('data-center', {
      view, params: { preset: period.preset, start: period.start, end: period.end },
      metric: config.kind === 'ranking' ? config.metrics[0].key : undefined,
    })
    expect(content.meta?.period).toBe(`${period.start} ~ ${period.end}（${period.label}）`)
    expect(content.meta?.scope).toBe('全部')
    expect(content.meta).not.toHaveProperty('basePeriod')
  })

  it.each(DATA_CENTER_EXPORT_VIEWS)('%s 越权多店先拒绝，不查询元信息', async view => {
    mockGetSession.mockResolvedValue({
      ...HQ,
      roles: [{ role: 'manager', scopeId: 'N1', scopeType: '门店', actions: ['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission'], scopeStoreIds: ['S1'], scopeOrgNodeIds: ['N1'] }],
      permissions: { actions: ['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission'], scopeStoreIds: ['S1'], scopeOrgNodeIds: ['N1'] },
    })
    const config = DATA_CENTER_VIEW_CONFIG[view as DataCenterBoardExportView]
    await expect(createExportContent('data-center', {
      view, params: { scope: 'stores', scopeId: 'S1,S2', month: '2026-08' },
      metric: config?.kind === 'ranking' ? config.metrics[0].key : undefined,
    })).rejects.toThrow('PERMISSION_DENIED')
    expect(queries).toEqual([])
  })

  it.each(DATA_CENTER_BOARD_EXPORT_VIEWS)('%s xlsx 真的生成导出说明 sheet，含期间/范围/时间/人，无基期', async view => {
    const config = DATA_CENTER_VIEW_CONFIG[view]
    const content = await createExportContent('data-center', {
      view, params: { preset: 'custom', start: '2026-08-01', end: '2026-08-31' },
      metric: config.kind === 'ranking' ? config.metrics[0].key : undefined,
    })
    const dir = await mkdtemp(join(tmpdir(), 'fengyu-board-meta-'))
    try {
      const filePath = join(dir, 'export.xlsx')
      await writeStreamXlsx({ filePath, ...content, meta: completeExportMeta(content.meta, { generatedAt: new Date(), exporterName: '张三' }) })
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(filePath)
      const sheet = workbook.getWorksheet('导出说明')!
      expect(sheet).toBeDefined()
      const entries: Record<string, string> = {}
      sheet.eachRow(row => { entries[row.getCell(1).text] = row.getCell(2).text })
      expect(entries).toMatchObject({
        '时间区间': '2026-08-01 ~ 2026-08-31（自定义）', '范围': '全部',
        '导出时间': '2026-09-15 12:05:06', '导出人': '张三',
      })
      expect(entries).not.toHaveProperty('环比基期')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
