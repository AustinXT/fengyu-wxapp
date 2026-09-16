import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySupplierRow } from '@/lib/inventory/types'

const { mockRefresh, mockUpdateInventorySupplier, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockUpdateInventorySupplier: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({ get: (_key: string, defaultValue = '') => defaultValue, setMany: vi.fn() }),
}))

vi.mock('@/actions/inventory/suppliers', () => ({
  createInventorySupplier: vi.fn(),
  updateInventorySupplier: mockUpdateInventorySupplier,
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError, success: mockToastSuccess } }))

import InventorySuppliersPage from './inventory-suppliers-page'

function supplier(overrides: Partial<InventorySupplierRow> = {}): InventorySupplierRow {
  return {
    supplierId: 'SUP-1',
    name: '广州美姿贺生物科技',
    contactName: '张三',
    phone: '13800000000',
    address: '广州市',
    isActive: true,
    remark: null,
    linkedSkuCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('InventorySuppliersPage（#132 关联 SKU 计数）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateInventorySupplier.mockResolvedValue({ success: true })
  })

  it('列表展示关联 SKU 数，无关联时显示占位', () => {
    render(
      <InventorySuppliersPage
        rows={[
          supplier({ supplierId: 'SUP-1', name: '有关联的', linkedSkuCount: 3 }),
          supplier({ supplierId: 'SUP-2', name: '没关联的', linkedSkuCount: 0 }),
        ]}
        canCreate
        canUpdate
      />,
    )

    expect(within(screen.getByText('有关联的').closest('tr')!).getByText('3 个')).toBeInTheDocument()
    expect(within(screen.getByText('没关联的').closest('tr')!).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('停用仍被引用的供应商时提示关联数，但不阻止停用', async () => {
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 5 })]} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))

    // 甲方口径 Q5：提示但不阻止 —— 停用语义是「不再采购」而非「删除」，
    // 阻止停用会逼运营先逐个改 SKU
    expect(screen.getByText(/仍有 5 个库存商品关联该供应商/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认停用' }))
    await waitFor(() => expect(mockUpdateInventorySupplier).toHaveBeenCalledWith('SUP-1', { isActive: false }))
    expect(mockToastSuccess).toHaveBeenCalledWith('供应商已停用')
  })

  it('从编辑弹窗把开关切到停用时，同样提示关联数（那条入口绕过了 AlertDialog）', () => {
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 7 })]} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
    expect(screen.queryByText(/仍有 7 个库存商品关联该供应商/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('供应商启用状态'))
    expect(screen.getByText(/仍有 7 个库存商品关联该供应商/)).toBeInTheDocument()
  })

  it('无关联时不显示关联提示', () => {
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))

    expect(screen.queryByText(/仍有 .* 个库存商品关联该供应商/)).not.toBeInTheDocument()
    // 通用文案仍在
    expect(screen.getByText(/历史单据不会受影响/)).toBeInTheDocument()
  })
})
