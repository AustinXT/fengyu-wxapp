import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InventoryLocationFilterOptions } from '@/lib/inventory/types'

const { mockExportInventoryLots } = vi.hoisted(() => ({
  mockExportInventoryLots: vi.fn(),
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

vi.mock('@/lib/export-xlsx', () => ({ exportToXlsx: vi.fn() }))

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
})
