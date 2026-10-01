/**
 * 提货记录页（#341）：列表与详情新增「顾客实际单价」「出库金额」；历史记录（上线前未冻结）显示「—」，
 * 不能显示成 ¥0.00（与 0 元赠品的真 0 区分）；导出按钮只带筛选条件。
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const filters: Record<string, string> = {}
vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({ get: (key: string, fallback = '') => filters[key] ?? fallback, set: vi.fn(), setMany: vi.fn() }),
}))
vi.mock('@/components/ui/date-picker', () => ({ DatePicker: () => <input aria-label="日期" /> }))
vi.mock('@/components/market-store-filter', () => ({ default: () => <div /> }))
vi.mock('@/components/delete-action', () => ({ RowDeleteMenu: () => null }))
vi.mock('@/actions/pickup-records', () => ({ deletePickupRecord: vi.fn() }))
const exportRequests: unknown[] = []
vi.mock('@/components/ui/export-button', () => ({
  ExportButton: ({ exportRequest }: { exportRequest: unknown }) => {
    exportRequests.push(exportRequest)
    return <button type="button">导出</button>
  },
}))

import type { AdminPickupRecord } from '@/actions/pickup-records'
import PickupRecordsPage from './pickup-records-page'

function record(overrides: Partial<AdminPickupRecord>): AdminPickupRecord {
  return {
    id: 1,
    saleItemId: 'SI-1',
    pickupQuantity: 2,
    storeId: 'store-1',
    clientUserId: 'CU-1',
    confirmedBy: 'E1',
    remark: null,
    createdAt: '2026-09-25T02:03:04.000Z',
    storeName: '一店',
    clientName: '顾客A',
    skuName: '家居精华',
    pickupUnitPrice: '88.50',
    pickupAmount: '177.00',
    ...overrides,
  }
}

function renderPage(records: AdminPickupRecord[]) {
  return render(
    <PickupRecordsPage
      records={records}
      filterOptions={{ markets: [], stores: [] } as never}
      total={records.length}
      canCreate={false}
    />,
  )
}

beforeEach(() => {
  for (const key of Object.keys(filters)) delete filters[key]
  exportRequests.length = 0
})

describe('提货记录页 · 冻结金额两列（#341）', () => {
  it('表头含两列新增列；冻结值、0 元行、历史行分别显示 ¥177.00 / ¥0.00 / —', () => {
    renderPage([
      record({ id: 1 }),
      record({ id: 2, saleItemId: 'SI-2', pickupQuantity: 1, pickupUnitPrice: '0.00', pickupAmount: '0.00' }),
      record({ id: 3, saleItemId: 'SI-3', pickupUnitPrice: null, pickupAmount: null }),
    ])
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toEqual(expect.arrayContaining(['顾客实际单价', '出库金额']))
    expect(headers.indexOf('出库金额')).toBe(headers.indexOf('顾客实际单价') + 1)

    const unitIndex = headers.indexOf('顾客实际单价')
    const cells = screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))
    expect(cells.map((row) => [row[unitIndex], row[unitIndex + 1]])).toEqual([
      ['¥88.50', '¥177.00'],
      ['¥0.00', '¥0.00'],
      ['—', '—'],
    ])
  })

  it('详情弹窗显示两项；历史行显示 — 而不是 ¥0.00', () => {
    renderPage([record({ pickupUnitPrice: null, pickupAmount: null })])
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    const unitLabel = screen.getAllByText('顾客实际单价').find((node) => node.tagName === 'SPAN')!
    const amountLabel = screen.getAllByText('出库金额').find((node) => node.tagName === 'SPAN')!
    expect(unitLabel.nextElementSibling?.textContent).toBe('—')
    expect(amountLabel.nextElementSibling?.textContent).toBe('—')
  })

  it('导出按钮：类型 pickup-records，只带非空筛选条件，不带分页参数', () => {
    Object.assign(filters, { market: 'M-1', store: 'store-1', q: '顾客', from: '2026-09-01', to: '', page: '3', size: '50' })
    renderPage([record({})])
    expect(exportRequests.at(-1)).toEqual({
      exportType: 'pickup-records',
      payload: { market: 'M-1', store: 'store-1', q: '顾客', from: '2026-09-01' },
    })
  })
})
