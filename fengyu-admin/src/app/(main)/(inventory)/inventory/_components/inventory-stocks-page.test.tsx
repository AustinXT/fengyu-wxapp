import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InventoryLocationFilterOptions, InventoryLotRow } from '@/lib/inventory/types'

const { mockExportInventoryLots, mockExportToXlsx } = vi.hoisted(() => ({
  mockExportInventoryLots: vi.fn(),
  mockExportToXlsx: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('q=面膜&type=市场'),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    setMany: vi.fn(),
  }),
}))

vi.mock('@/actions/inventory/stocks', () => ({
  exportInventoryLots: mockExportInventoryLots,
}))

vi.mock('@/lib/export-xlsx', () => ({ exportToXlsx: mockExportToXlsx }))

import InventoryStocksPage from './inventory-stocks-page'

const locationFilterOptions: InventoryLocationFilterOptions = {
  headquarters: [],
  markets: [{
    locationId: 'M1',
    name: '南昌市场',
    canSelectInventory: true,
    stores: [{ locationId: 'S1', name: '红谷滩店' }],
  }],
  defaultLocationId: 'M1',
}

const LOT_ROW: InventoryLotRow = {
  id: 1,
  locationId: 'S1',
  locationName: '红谷滩店',
  locationType: '门店',
  skuId: 'SKU-1',
  skuName: '玻尿酸面膜',
  specName: '25ml*5',
  supplier: '供应商A',
  productSeries: '院线',
  batchNo: 'B202609',
  expiryDate: '2027-01-01',
  isGift: false,
  quantityOnHand: 10,
  availableQuantity: 7,
  remark: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

describe('InventoryStocksPage', () => {
  it('导出使用页面解析后的精确主体并丢弃旧 type 参数', async () => {
    mockExportInventoryLots.mockResolvedValue({
      rows: [],
      truncated: false,
      hasMore: false,
      canViewPrice: false,
    })
    render(
      <InventoryStocksPage
        rows={[]}
        total={0}
        canViewPrice={false}
        canExport
        locationFilterOptions={locationFilterOptions}
        selectedLocationId="M1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '导出' }))

    await waitFor(() => expect(mockExportInventoryLots).toHaveBeenCalledWith({
      q: '面膜',
      location: 'M1',
    }))
  })

  it('列表展示可用量列（在手 − 未完成预留）', () => {
    render(
      <InventoryStocksPage
        rows={[LOT_ROW]}
        total={1}
        canViewPrice={false}
        canExport={false}
        locationFilterOptions={locationFilterOptions}
        selectedLocationId="M1"
      />,
    )

    expect(screen.getByText('可用量')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('xlsx 导出包含可用量列', async () => {
    mockExportInventoryLots.mockResolvedValue({
      rows: [LOT_ROW],
      truncated: false,
      hasMore: false,
      canViewPrice: false,
    })
    mockExportToXlsx.mockResolvedValue(undefined)
    render(
      <InventoryStocksPage
        rows={[LOT_ROW]}
        total={1}
        canViewPrice={false}
        canExport
        locationFilterOptions={locationFilterOptions}
        selectedLocationId="M1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '导出' }))

    await waitFor(() => expect(mockExportToXlsx).toHaveBeenCalled())
    const call = mockExportToXlsx.mock.calls[0][0] as {
      columns: Array<{ header: string; accessor: (row: InventoryLotRow) => unknown }>
    }
    const headers = call.columns.map((column) => column.header)
    expect(headers).toContain('可用量')
    const availableColumn = call.columns.find((column) => column.header === '可用量')!
    expect(availableColumn.accessor(LOT_ROW)).toBe(7)
  })
})
