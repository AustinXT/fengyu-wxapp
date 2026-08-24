import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySkuRow } from '@/lib/inventory/types'

const { mockRefresh, mockUpdateInventorySku, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockUpdateInventorySku: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    setMany: vi.fn(),
  }),
}))

vi.mock('@/actions/inventory/skus', () => ({
  createInventorySku: vi.fn(),
  updateInventorySku: mockUpdateInventorySku,
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}))

import InventorySkusPage from './inventory-skus-page'

const row: InventorySkuRow = {
  skuId: 'SKU-1',
  productCode: 'ANJL-001',
  productName: '安吉丽美肌净透卸妆油',
  specName: '90ml/瓶',
  supplier: null,
  manufacturer: '广州美姿贺',
  brand: null,
  productSeries: null,
  purchaseCategory: null,
  sourceType: '供应链',
  ownerMarketId: null,
  ownerMarketName: null,
  retailPrice: 260,
  accountingPrice: null,
  supplyChainPurchasePrice: 24.9,
  marketPurchasePrice: 78,
  storePurchasePrice: 78,
  marketStaffPurchasePrice: 65,
  marketPurchaseDiscount: null,
  storePurchaseDiscount: null,
  staffPurchaseDiscount: null,
  itemCompanyPurchasePrice: null,
  isReportable: true,
  isActive: true,
  remark: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

function renderPage() {
  return render(
    <InventorySkusPage
      rows={[row]}
      total={1}
      markets={[]}
      canCreate
      canUpdate
      canViewPrice
      canManageMarketSkus
    />,
  )
}

describe('InventorySkusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateInventorySku.mockResolvedValue({ success: true })
  })

  it('允许直接编辑并提交已有市场进货价', async () => {
    renderPage()
    fireEvent.click(screen.getByTitle('编辑库存商品'))

    const input = screen.getByLabelText(/^市场进货价/)
    expect(input).toHaveValue('78')
    expect(input).not.toHaveAttribute('readonly')

    fireEvent.change(input, { target: { value: '79.5' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalledWith(
      'SKU-1',
      expect.objectContaining({ marketPurchasePrice: 79.5 }),
    ))
    expect(mockToastSuccess).toHaveBeenCalledWith('库存商品已更新')
  })

  it('从 Server Action digest 展示中文业务错误', async () => {
    mockUpdateInventorySku.mockRejectedValue({
      message: 'An error occurred in the Server Components render.',
      digest: 'INVALID_PARAMS: 设置核算价或市场折扣时，必须同时具备两项数据',
    })
    renderPage()
    fireEvent.click(screen.getByTitle('编辑库存商品'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      '设置核算价或市场折扣时，必须同时具备两项数据',
    ))
  })
})
