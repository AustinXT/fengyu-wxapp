import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySupplierRow } from '@/lib/inventory/types'

const {
  mockRefresh,
  mockUpdateInventorySupplier,
  mockCountSkus,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockUpdateInventorySupplier: vi.fn(),
  mockCountSkus: vi.fn(),
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
  countInventorySkusBySupplier: mockCountSkus,
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
    mockCountSkus.mockResolvedValue(0)
  })

  it('列表展示关联 SKU 数，无关联时显示占位', () => {
    render(
      <InventorySuppliersPage
        rows={[
          supplier({ supplierId: 'SUP-1', name: '有关联的', linkedSkuCount: 3 }),
          supplier({ supplierId: 'SUP-2', name: '没关联的', linkedSkuCount: 0 }),
        ]}
        total={2}
        canCreate
        canUpdate
      />,
    )

    expect(within(screen.getByText('有关联的').closest('tr')!).getByText('3 个')).toBeInTheDocument()
    expect(within(screen.getByText('没关联的').closest('tr')!).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('停用仍被引用的供应商时提示关联数，但不阻止停用', async () => {
    mockCountSkus.mockResolvedValue(5)
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 5 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))

    // 甲方口径 Q5：提示但不阻止 —— 停用语义是「不再采购」而非「删除」，
    // 阻止停用会逼运营先逐个改 SKU
    expect(await screen.findByText(/仍有 5 个库存商品关联该供应商/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认停用' }))
    await waitFor(() => expect(mockUpdateInventorySupplier).toHaveBeenCalledWith('SUP-1', { isActive: false }))
    expect(mockToastSuccess).toHaveBeenCalledWith('供应商已停用')
  })

  it('停用提示用的是**实时**核对结果，不是页面加载时的旧计数', async () => {
    // 页面加载时是 0，但别人刚关联了 3 个 —— 拿旧值会显示不出提示
    mockCountSkus.mockResolvedValue(3)
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))

    expect(mockCountSkus).toHaveBeenCalledWith('SUP-1')
    expect(await screen.findByText(/仍有 3 个库存商品关联该供应商/)).toBeInTheDocument()
  })

  it('编辑弹窗里切到停用的**当下**重新核对，不用打开弹窗时的旧值', async () => {
    // 打开弹窗时是 0，改了半天电话期间别人关联了 3 个 —— 切停用时必须重新拉
    mockCountSkus.mockResolvedValueOnce(0).mockResolvedValueOnce(3)
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
    await waitFor(() => expect(mockCountSkus).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByLabelText('供应商启用状态'))
    await waitFor(() => expect(mockCountSkus).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/仍有 3 个库存商品关联该供应商/)).toBeInTheDocument()
  })

  it('核对未完成前不能确认停用', () => {
    mockCountSkus.mockReturnValue(new Promise(() => {}))
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))

    expect(screen.getByText(/正在核对关联的库存商品/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认停用' })).toBeDisabled()
  })

  it('从编辑弹窗把开关切到停用时，同样提示关联数（那条入口绕过了 AlertDialog）', async () => {
    // 且用的必须是**实时**值：列表行带的是 0（页面加载时的旧值），实时核对是 7
    mockCountSkus.mockResolvedValue(7)
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
    expect(mockCountSkus).toHaveBeenCalledWith('SUP-1')
    expect(screen.queryByText(/仍有 7 个库存商品关联该供应商/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('供应商启用状态'))
    expect(await screen.findByText(/仍有 7 个库存商品关联该供应商/)).toBeInTheDocument()
  })

  it('切换停用目标时，前一个供应商的慢响应不会覆盖当前目标的结果', async () => {
    // A 的请求慢、B 的先回。没有请求序号的话，A 的 0 回来会把 B 的 5 覆盖掉 ——
    // 警告消失、确认按钮还被放开。
    let resolveA: ((n: number) => void) | undefined
    mockCountSkus
      .mockImplementationOnce(() => new Promise<number>((r) => { resolveA = r }))
      .mockResolvedValueOnce(5)

    render(
      <InventorySuppliersPage
        rows={[
          supplier({ supplierId: 'SUP-A', name: '甲公司' }),
          supplier({ supplierId: 'SUP-B', name: '乙公司' }),
        ]}
        total={1}
        canCreate
        canUpdate
      />,
    )
    const disableButtons = screen.getAllByRole('button', { name: /停用/ })
    fireEvent.click(disableButtons[0])          // A：慢请求
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(disableButtons[1])          // B：快请求
    expect(await screen.findByText(/仍有 5 个库存商品关联该供应商/)).toBeInTheDocument()

    resolveA?.(0)                                // A 的旧响应姗姗来迟
    await waitFor(() => expect(screen.getByText(/仍有 5 个库存商品关联该供应商/)).toBeInTheDocument())
  })

  it('无关联时不显示关联提示', async () => {
    render(
      <InventorySuppliersPage rows={[supplier({ linkedSkuCount: 0 })]} total={1} canCreate canUpdate />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停用/ }))
    await waitFor(() => expect(mockCountSkus).toHaveBeenCalled())

    expect(screen.queryByText(/仍有 .* 个库存商品关联该供应商/)).not.toBeInTheDocument()
    // 通用文案仍在
    expect(screen.getByText(/历史单据不会受影响/)).toBeInTheDocument()
  })
})
