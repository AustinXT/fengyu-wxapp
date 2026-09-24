import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 经营明细报表（report-*）导出视图的分发守护（#367 记录的坑，#375 补守护）。
 *
 * registry.ts 的板块分发按 `sales-` / `customer-` / `product-` 前缀判定、其余一律落进人效分支。
 * 报表视图若撞上这些前缀、或分发时漏在板块分支之后，会被静默派给板块取数函数——导出件内容是错的，
 * 任务却显示成功。这里从三面钉住：命名（前缀闭集）、登记（每个报表视图都有处理函数）、
 * 行为（真实走一遍 createExportContent，报表处理函数被调用、板块取数函数一个都不被调用）。
 */

const board = vi.hoisted(() => ({
  getSalesBoard: vi.fn(),
  getCustomerBoard: vi.fn(),
  getProductBoard: vi.fn(),
  getEfficiencyBoard: vi.fn(),
}))
const reportHandler = vi.hoisted(() => vi.fn())

vi.mock('@/actions/data-center/sales', () => ({ getSalesBoard: board.getSalesBoard }))
vi.mock('@/actions/data-center/customer', () => ({ getCustomerBoard: board.getCustomerBoard }))
vi.mock('@/actions/data-center/product', () => ({ getProductBoard: board.getProductBoard }))
vi.mock('@/actions/data-center/efficiency', () => ({ getEfficiencyBoard: board.getEfficiencyBoard }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('./report-views', async () => {
  const { DATA_CENTER_REPORT_EXPORT_VIEWS } = await import('@/lib/export-job-types')
  return {
    DATA_CENTER_REPORT_EXPORT_HANDLERS: Object.fromEntries(
      DATA_CENTER_REPORT_EXPORT_VIEWS.map((view) => [view, (params: Record<string, string>) => reportHandler(view, params)]),
    ),
  }
})

import {
  DATA_CENTER_BOARD_EXPORT_VIEWS,
  DATA_CENTER_EXPORT_VIEWS,
  DATA_CENTER_REPORT_EXPORT_VIEWS,
  DATA_CENTER_REPORT_VIEW_PREFIX,
  DATA_CENTER_VIEW_REQUIRED_ACTIONS,
  exportJobLabel,
} from '@/lib/export-job-types'
import { DATA_CENTER_STAFF_COMMISSION_ACTIONS } from '@/lib/data-center/reports'
import { createExportContent, isReportExportView } from './registry'

/** 板块分发认的前缀（registry.ts queryDataCenterBoard）；人效视图走兜底分支，也按前缀列入 */
const BOARD_PREFIXES = ['sales-', 'customer-', 'product-', 'efficiency-'] as const

beforeEach(() => {
  vi.clearAllMocks()
  reportHandler.mockResolvedValue({ sheetName: 'x', columns: [], rows: (async function* () {})() })
})

describe('报表导出视图 · 命名闭集', () => {
  it('报表视图全部以 report- 开头，且不以任何板块前缀开头', () => {
    expect(DATA_CENTER_REPORT_VIEW_PREFIX).toBe('report-')
    for (const view of DATA_CENTER_REPORT_EXPORT_VIEWS) {
      expect(view.startsWith(DATA_CENTER_REPORT_VIEW_PREFIX), view).toBe(true)
      for (const prefix of BOARD_PREFIXES) expect(view.startsWith(prefix), `${view} 撞前缀 ${prefix}`).toBe(false)
    }
  })

  it('板块视图全部落在板块前缀内，且没有一个以 report- 开头', () => {
    for (const view of DATA_CENTER_BOARD_EXPORT_VIEWS) {
      expect(BOARD_PREFIXES.some((prefix) => view.startsWith(prefix)), view).toBe(true)
      expect(view.startsWith(DATA_CENTER_REPORT_VIEW_PREFIX), view).toBe(false)
    }
  })

  it('全部视图 = 板块 ∪ 报表，没有第三类、没有重复', () => {
    expect(new Set(DATA_CENTER_EXPORT_VIEWS).size).toBe(DATA_CENTER_EXPORT_VIEWS.length)
    expect([...DATA_CENTER_EXPORT_VIEWS].sort()).toEqual([...DATA_CENTER_BOARD_EXPORT_VIEWS, ...DATA_CENTER_REPORT_EXPORT_VIEWS].sort())
  })

  it('isReportExportView 与登记表一致：报表视图为真、板块视图为假', () => {
    for (const view of DATA_CENTER_REPORT_EXPORT_VIEWS) expect(isReportExportView(view), view).toBe(true)
    for (const view of DATA_CENTER_BOARD_EXPORT_VIEWS) expect(isReportExportView(view), view).toBe(false)
  })
})

describe('报表导出视图 · 分发行为', () => {
  it.each(DATA_CENTER_REPORT_EXPORT_VIEWS)('%s 走报表处理函数，板块取数函数一个都不调用', async (view) => {
    const params = { month: '2026-08', scope: 'market', scopeId: 'M1' }
    await createExportContent('data-center', { view, params })

    expect(reportHandler).toHaveBeenCalledTimes(1)
    expect(reportHandler).toHaveBeenCalledWith(view, params)
    for (const fn of Object.values(board)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('员工提成类导出视图 · 权限与标签', () => {
  it.each(['report-commission-daily', 'report-commission-detail'] as const)('%s 要求 dashboard + staff_commission，与页面同源', (view) => {
    expect(DATA_CENTER_VIEW_REQUIRED_ACTIONS[view]).toBe(DATA_CENTER_STAFF_COMMISSION_ACTIONS)
    expect(exportJobLabel('data-center', { view, params: {} })).toBeTruthy()
  })
})
