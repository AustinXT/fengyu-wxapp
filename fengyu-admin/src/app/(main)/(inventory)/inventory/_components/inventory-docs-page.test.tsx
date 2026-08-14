import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { InventoryDocRow, InventoryLocationFilterOptions } from '@/lib/inventory/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    setMany: vi.fn(),
  }),
}))

vi.mock('@/actions/inventory/docs', () => ({
  approveInventoryCoreDoc: vi.fn(),
  confirmInventoryCoreReceive: vi.fn(),
  createInventoryCoreDoc: vi.fn(),
  rejectInventoryCoreDoc: vi.fn(),
}))

vi.mock('@/actions/inventory/stocks', () => ({ listInventoryLotOptions: vi.fn() }))

import InventoryDocsPage from './inventory-docs-page'

const row: InventoryDocRow = {
  id: 'MBS-260813-0001',
  docType: '市场产品报损',
  status: '待审批',
  sourceLocationId: 'M1',
  sourceLocationName: '南昌市场',
  sourceLocationType: '市场',
  targetLocationId: null,
  targetLocationName: null,
  targetLocationType: null,
  marketId: 'M1',
  supplierId: null,
  docDate: '2026-08-13',
  relatedSaleOrderId: null,
  customerName: null,
  employeeName: null,
  supplierName: null,
  externalPartyName: null,
  logisticsCompany: null,
  trackingNo: null,
  receiptAttachmentUrl: null,
  totalQuantity: 1,
  totalAmount: 100,
  remark: null,
  auditRemark: null,
  createdBy: 'E1',
  confirmedAt: null,
  approvedAt: null,
  rejectedAt: null,
  cancellationRequestReason: null,
  cancellationRequestedBy: null,
  cancellationRequestedAt: null,
  cancellationReason: null,
  cancelledAt: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
}

const baseProps = {
  rows: [row],
  total: 1,
  locations: [],
  skuOptions: [],
  canCreate: true,
  canApprove: true,
  canViewPrice: true,
}

const locationFilterOptions: InventoryLocationFilterOptions = {
  headquarters: [{ locationId: 'HQ', name: '总部' }],
  markets: [{
    locationId: 'M1',
    name: '南昌市场',
    canSelectInventory: true,
    stores: [{ locationId: 'S1', name: '红谷滩店' }],
  }],
  defaultLocationId: 'HQ',
}

describe('InventoryDocsPage 职责边界', () => {
  it('全局单据中心只提供检索和详情', () => {
    render(
      <InventoryDocsPage
        {...baseProps}
        readOnly
        locationFilterOptions={locationFilterOptions}
        selectedLocationId="HQ"
      />,
    )

    expect(screen.getByRole('heading', { name: '单据中心' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('总部（供应链）')).toBeInTheDocument()
    expect(screen.getByDisplayValue('供应链库存')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('全部层级')).not.toBeInTheDocument()
  })

  it('本级单据记录承接业务动作并锁定层级', () => {
    render(
      <InventoryDocsPage
        {...baseProps}
        lockedLevel="market"
        allowedCreateDocTypes={['市场产品报损', '市场产品盘溢']}
      />,
    )

    expect(screen.getByRole('heading', { name: '本级单据记录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
    expect(screen.queryByLabelText('库存市场层级')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: '市场产品报损' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: '内部领用' })).not.toBeInTheDocument()
  })
})
