import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySkuRow, InventorySupplierOption } from '@/lib/inventory/types'

const {
  mockRefresh,
  mockCreateInventorySku,
  mockUpdateInventorySku,
  mockCreateInventorySupplier,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockCreateInventorySku: vi.fn(),
  mockUpdateInventorySku: vi.fn(),
  mockCreateInventorySupplier: vi.fn(),
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
  createInventorySku: mockCreateInventorySku,
  updateInventorySku: mockUpdateInventorySku,
}))

vi.mock('@/actions/inventory/suppliers', () => ({
  createInventorySupplier: mockCreateInventorySupplier,
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
  supplierId: null,
  supplierName: null,
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
  marketPurchasePriceMode: '手工覆盖',
  marketPurchasePriceOverrideReason: '测试数据',
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

const SUPPLIER_OPTIONS: InventorySupplierOption[] = [
  { supplierId: 'SUP-1', name: '广州美姿贺生物科技' },
  { supplierId: 'SUP-2', name: '南昌凤御供应商' },
]

function renderPage(overrides: {
  rows?: InventorySkuRow[]
  supplierOptions?: InventorySupplierOption[]
  canCreateSupplier?: boolean
} = {}) {
  return render(
    <InventorySkusPage
      rows={overrides.rows ?? [row]}
      total={1}
      markets={[]}
      supplierOptions={overrides.supplierOptions ?? SUPPLIER_OPTIONS}
      canCreate
      canUpdate
      canCreateSupplier={overrides.canCreateSupplier ?? true}
      canViewPrice
      canManageMarketSkus
      canManageSupplySkus
    />,
  )
}

/** 表单里的「供货商」下拉。label 只裹 Select，按钮与提示都在 label 外。 */
function supplierSelect() {
  return screen.getByLabelText('供货商') as HTMLSelectElement
}

describe('InventorySkusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateInventorySku.mockResolvedValue({ success: true })
    mockCreateInventorySku.mockResolvedValue({ success: true, skuId: 'SKU-NEW' })
    mockCreateInventorySupplier.mockResolvedValue({ supplierId: 'SUP-NEW' })
  })

  it('允许直接编辑并提交已有市场进货价', async () => {
    renderPage()
    fireEvent.click(screen.getByTitle('编辑库存商品'))

    const input = screen.getAllByLabelText(/^市场进货价/).find((element) => element.tagName === 'INPUT')!
    expect(input).toHaveValue('78')
    expect(input).not.toHaveAttribute('readonly')

    fireEvent.change(input, { target: { value: '79.5' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalledWith(
      'SKU-1',
      expect.objectContaining({
        marketPurchasePrice: 79.5,
        marketPurchasePriceMode: '手工覆盖',
        marketPurchasePriceOverrideReason: '测试数据',
      }),
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

  describe('供货商关联供应商档案（#132）', () => {
    it('供货商是下拉选择而不是自由文本，选项来自启用中的档案', () => {
      renderPage()
      fireEvent.click(screen.getByTitle('编辑库存商品'))

      const select = supplierSelect()
      // 这条守的是 issue 的根因本身：一旦有人把它改回 <Input>，同一个 label 会返回
      // INPUT，断言立刻失败。
      expect(select.tagName).toBe('SELECT')
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        '未指定',
        '广州美姿贺生物科技',
        '南昌凤御供应商',
      ])
    })

    it('选中档案后提交 supplierId，而不是供应商名称文本', async () => {
      renderPage()
      fireEvent.click(screen.getByTitle('编辑库存商品'))
      fireEvent.change(supplierSelect(), { target: { value: 'SUP-2' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalledWith(
        'SKU-1',
        expect.objectContaining({ supplierId: 'SUP-2' }),
      ))
      // 名称文本快照由 engine 从档案派生，前端不该再往上传自由文本
      expect(mockUpdateInventorySku.mock.calls[0][1]).not.toHaveProperty('supplier')
    })

    it('已关联的档案被停用后，下拉仍带上它，保存不会把关联清掉', async () => {
      const linkedToDisabled: InventorySkuRow = {
        ...row,
        supplier: '已停用的老供应商',
        supplierId: 'SUP-GONE',
        supplierName: '已停用的老供应商',
      }
      renderPage({ rows: [linkedToDisabled] })
      fireEvent.click(screen.getByTitle('编辑库存商品'))

      const select = supplierSelect()
      expect(select.value).toBe('SUP-GONE')
      expect(Array.from(select.options).map((option) => option.textContent)).toContain(
        '已停用的老供应商（已停用）',
      )

      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalledWith(
        'SKU-1',
        expect.objectContaining({ supplierId: 'SUP-GONE' }),
      ))
    })

    it('存量文本没匹配上档案时不提交 supplierId，避免把原文本清空', async () => {
      const legacyText: InventorySkuRow = {
        ...row,
        supplier: '某个没建档的供应商',
        supplierId: null,
        supplierName: null,
      }
      renderPage({ rows: [legacyText] })
      fireEvent.click(screen.getByTitle('编辑库存商品'))

      expect(supplierSelect().value).toBe('')
      expect(screen.getByText(/原填写「某个没建档的供应商」未匹配到供应商档案/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalled())
      // undefined 而不是 null：engine 的三态里，undefined 才是「两列都别动」
      expect(mockUpdateInventorySku.mock.calls[0][1].supplierId).toBeUndefined()
    })

    it('主动清空已有关联时提交 null', async () => {
      const linked: InventorySkuRow = {
        ...row,
        supplier: '广州美姿贺生物科技',
        supplierId: 'SUP-1',
        supplierName: '广州美姿贺生物科技',
      }
      renderPage({ rows: [linked] })
      fireEvent.click(screen.getByTitle('编辑库存商品'))
      fireEvent.change(supplierSelect(), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalled())
      expect(mockUpdateInventorySku.mock.calls[0][1].supplierId).toBeNull()
    })

    it('快捷建档后新供应商立刻可选并自动选中', async () => {
      renderPage()
      fireEvent.click(screen.getByTitle('编辑库存商品'))
      fireEvent.click(screen.getByRole('button', { name: '+ 新建供应商' }))

      fireEvent.change(screen.getByLabelText('新供应商名称'), { target: { value: '新建的供应商' } })
      fireEvent.change(screen.getByLabelText('新供应商联系电话'), { target: { value: '13800000000' } })
      fireEvent.click(screen.getByRole('button', { name: '创建并选中' }))

      await waitFor(() => expect(mockCreateInventorySupplier).toHaveBeenCalledWith({
        name: '新建的供应商',
        contactName: null,
        phone: '13800000000',
      }))
      await waitFor(() => expect(supplierSelect().value).toBe('SUP-NEW'))
      expect(Array.from(supplierSelect().options).map((option) => option.textContent))
        .toContain('新建的供应商')
      // 建档不能触发 router.refresh()：refresh 会重新下发 row，把填到一半的 SKU 表单重置掉
      expect(mockRefresh).not.toHaveBeenCalled()
    })

    it('没有供应商建档权限时不显示快捷入口', () => {
      renderPage({ canCreateSupplier: false })
      fireEvent.click(screen.getByTitle('编辑库存商品'))
      expect(screen.queryByRole('button', { name: '+ 新建供应商' })).not.toBeInTheDocument()
    })

    it('列表展示关联档案名；未关联的存量文本标注出来', () => {
      const linked: InventorySkuRow = {
        ...row, skuId: 'SKU-L', productCode: 'L-001', productName: '已关联',
        supplier: '关联时的旧名', supplierId: 'SUP-1', supplierName: '改名后的档案名',
      }
      const legacy: InventorySkuRow = {
        ...row, skuId: 'SKU-T', productCode: 'T-001', productName: '仅文本',
        supplier: '某个没建档的供应商', supplierId: null, supplierName: null,
      }
      renderPage({ rows: [linked, legacy] })

      const linkedRow = screen.getByText('已关联').closest('tr')!
      // 展示实时关联名而非 supplier 快照：档案改名后列表应立刻跟随
      expect(within(linkedRow).getByText('改名后的档案名')).toBeInTheDocument()
      expect(within(linkedRow).queryByText('关联时的旧名')).not.toBeInTheDocument()

      const legacyRow = screen.getByText('仅文本').closest('tr')!
      expect(within(legacyRow).getByText('某个没建档的供应商')).toBeInTheDocument()
      expect(within(legacyRow).getByText('未关联档案')).toBeInTheDocument()
    })
  })
})
