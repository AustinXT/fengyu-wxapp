import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { InventorySettlementReport } from '@/lib/inventory/types'

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    setMany: vi.fn(),
  }),
}))

vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ value, 'aria-label': ariaLabel }: { value?: string; 'aria-label'?: string }) => (
    <input aria-label={ariaLabel} value={value ?? ''} readOnly />
  ),
}))

import InventorySettlementsPage from './inventory-settlements-page'

const BASE_REPORT: InventorySettlementReport = {
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  priceVisibility: 'market',
  canViewMarketSettlement: true,
  canViewStoreSettlement: true,
  marketRows: [{
    sourceOrgNodeId: 'M1',
    sourceOrgNodeName: '南昌市场',
    targetOrgNodeId: 'HQ',
    targetOrgNodeName: '供应链总部',
    docCount: 2,
    totalQuantity: 30,
    payableAmount: 1234.5,
  }],
  storeRows: [{
    sourceOrgNodeId: 'M1',
    sourceOrgNodeName: '南昌市场',
    targetOrgNodeId: 'S1',
    targetOrgNodeName: '红谷滩店',
    docCount: 3,
    totalQuantity: 12,
    payableAmount: 888,
  }],
}

describe('InventorySettlementsPage', () => {
  it('市场价格档同时渲染市场结算与分院结算及应付金额', () => {
    render(<InventorySettlementsPage report={BASE_REPORT} />)

    expect(screen.getByText('市场货款结算（市场应付供应链）')).toBeTruthy()
    expect(screen.getByText('分院货款结算（门店应付市场）')).toBeTruthy()
    // 金额同时出现在区块合计与明细行，至少各一次。
    expect(screen.getAllByText('¥1234.50').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('¥888.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('红谷滩店')).toBeTruthy()
  })

  it('供应链价格档隐藏分院结算区块', () => {
    render(
      <InventorySettlementsPage
        report={{
          ...BASE_REPORT,
          priceVisibility: 'supply_chain',
          canViewStoreSettlement: false,
          storeRows: [],
        }}
      />,
    )

    expect(screen.getByText('市场货款结算（市场应付供应链）')).toBeTruthy()
    expect(screen.queryByText('分院货款结算（门店应付市场）')).toBeNull()
    expect(screen.queryByText('¥888.00')).toBeNull()
  })
})
