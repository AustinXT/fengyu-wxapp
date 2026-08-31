import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { InventoryDocRow, InventoryLocationFilterOptions } from '@/lib/inventory/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/inventory/docs',
  useSearchParams: () => new URLSearchParams('status=待审批&page=2'),
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
  sourceOrgNodeId: 'M1',
  sourceOrgNodeName: '南昌市场',
  sourceOrgNodeType: '市场',
  targetOrgNodeId: null,
  targetOrgNodeName: null,
  targetOrgNodeType: null,
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
  canReceive: true,
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
  it('单据中心统一提供检索和业务动作', () => {
    render(
      <InventoryDocsPage
        {...baseProps}
        locationFilterOptions={locationFilterOptions}
        selectedOrgNodeId="HQ"
        allowedCreateDocTypes={['市场产品报损', '市场产品盘溢']}
      />,
    )

    expect(screen.getByRole('heading', { name: '单据中心' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
  })

  it('新建窗口只展示当前权限允许的单据类型', () => {
    render(
      <InventoryDocsPage
        {...baseProps}
        allowedCreateDocTypes={['市场产品报损', '市场产品盘溢']}
      />,
    )

    expect(screen.getByRole('heading', { name: '单据中心' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: '市场产品报损' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: '内部领用' })).not.toBeInTheDocument()
  })
})
