import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  InventoryLocationRow,
  InventoryPriceVisibility,
  InventorySkuRow,
  InventorySupplierOption,
} from '@/lib/inventory/types'

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
  priceVisibility?: InventoryPriceVisibility
  markets?: InventoryLocationRow[]
  canManageMarketSkus?: boolean
  canManageSupplySkus?: boolean
} = {}) {
  const priceVisibility = overrides.priceVisibility ?? 'all'
  return render(
    <InventorySkusPage
      rows={overrides.rows ?? [row]}
      total={1}
      markets={overrides.markets ?? []}
      supplierOptions={overrides.supplierOptions ?? SUPPLIER_OPTIONS}
      canCreate
      canUpdate
      canCreateSupplier={overrides.canCreateSupplier ?? true}
      canViewPrice={priceVisibility !== 'none'}
      priceVisibility={priceVisibility}
      canManageMarketSkus={overrides.canManageMarketSkus ?? true}
      canManageSupplySkus={overrides.canManageSupplySkus ?? true}
    />,
  )
}

function market(locationId: string, name: string): InventoryLocationRow {
  return { locationId, locationType: '市场', name, orgNodeId: locationId, storeId: null, parentLocationId: null, isActive: true }
}

/** 表单里的「来源」下拉。 */
function sourceSelect() {
  return screen.getByLabelText(/^来源/) as HTMLSelectElement
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
    // #135 把价格输入改成 type="number" 后，jest-dom 的 toHaveValue 返回的是
    // **number**（对 text input 才是 string）。这里断言 78 而不是 '78' 是预期的。
    expect(input).toHaveValue(78)
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

    it('存量文本的 SKU：选了档案又改回「未指定」时提交 null（能把旧文本清掉）', async () => {
      // 「没碰过」与「选了又改回未指定」的 form.supplierId 都是 ''，不靠 touched 标记区分的话，
      // 后者也会走「两列都不动」—— 那段没匹配上的旧文本就永远删不掉了（改造前的自由输入框能删）
      const legacyText: InventorySkuRow = {
        ...row, supplier: '某个没建档的供应商', supplierId: null, supplierName: null,
      }
      renderPage({ rows: [legacyText] })
      fireEvent.click(screen.getByTitle('编辑库存商品'))

      fireEvent.change(supplierSelect(), { target: { value: 'SUP-1' } })
      fireEvent.change(supplierSelect(), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalled())
      expect(mockUpdateInventorySku.mock.calls[0][1].supplierId).toBeNull()
    })

    it('一个可选档案都没有时，仍能通过「清空原文本」按钮清掉存量文本', async () => {
      // 下拉当前就停在「未指定」，再点一次不触发 change —— 没有其它选项时
      // （市场角色 + 档案表为空）用户根本没法把 supplierTouched 置上，
      // 那段旧文本就永远删不掉。必须有个显式入口。
      const legacyText: InventorySkuRow = {
        ...row, supplier: '某个没建档的供应商', supplierId: null, supplierName: null,
      }
      renderPage({ rows: [legacyText], supplierOptions: [], canCreateSupplier: false })
      fireEvent.click(screen.getByTitle('编辑库存商品'))

      expect(Array.from(supplierSelect().options)).toHaveLength(1)   // 只有「未指定」
      fireEvent.click(screen.getByRole('button', { name: '清空原文本' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalled())
      expect(mockUpdateInventorySku.mock.calls[0][1].supplierId).toBeNull()
    })

    it('取消新建弹窗后重开，快捷建档草稿不残留', () => {
      // 走**新建**路径才真正依赖那几行重置：key 恒为 'create'，
      // editing 从 null 变 undefined 不会让组件卸载，state 不会自然清空。
      //（编辑路径的 key 会从 skuId 变 create 而重建，测不出重置代码有没有用。）
      renderPage()

      fireEvent.click(screen.getByRole('button', { name: /新建/ }))
      fireEvent.click(screen.getByRole('button', { name: '+ 新建供应商' }))
      fireEvent.change(screen.getByLabelText('新供应商名称 *'), { target: { value: '放弃的草稿' } })
      // 此时有两个「取消」：快捷建档区块的、和弹窗底部的。要点的是**外层弹窗**那个
      const cancels = screen.getAllByRole('button', { name: '取消' })
      fireEvent.click(cancels[cancels.length - 1])

      fireEvent.click(screen.getByRole('button', { name: /新建/ }))
      // 快捷建档面板应已收起、草稿应已清空，否则用户会拿上次放弃的内容建出档案
      expect(screen.queryByLabelText('新供应商名称 *')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+ 新建供应商' })).toBeInTheDocument()
    })

    it('点了「清空原文本」后取消、再打开，不会残留清空意图', async () => {
      // 这条守的是**行为**：当前由「关闭时 key 从 skuId 变 create、组件重建」保证
      //（删掉重置代码本条仍绿 —— 真正依赖重置的是上面那条新建路径）。
      const legacyText: InventorySkuRow = {
        ...row, supplier: '某个没建档的供应商', supplierId: null, supplierName: null,
      }
      renderPage({ rows: [legacyText], supplierOptions: [], canCreateSupplier: false })

      fireEvent.click(screen.getByTitle('编辑库存商品'))
      fireEvent.click(screen.getByRole('button', { name: '清空原文本' }))
      fireEvent.click(screen.getByRole('button', { name: '取消' }))

      fireEvent.click(screen.getByTitle('编辑库存商品'))
      expect(screen.getByRole('button', { name: '清空原文本' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalled())
      expect(mockUpdateInventorySku.mock.calls[0][1].supplierId).toBeUndefined()
    })

    it('选中的档案不在选项里时补占位，不让显示值与提交值分裂', async () => {
      // ⚠️ 夹具必须让 row.supplierId **为空**：若把待测 id 放在 row 上，
      // `formFromRow` 会让 form.supplierId === row.supplierId，于是「（已停用）」补回分支
      // 先把它塞进 options，占位分支的 `!merged.has(...)` 恒为 false —— 删掉占位实现
      // 测试照样绿（两个谱系的评审都抓到了这一点）。
      // 真正要覆盖的是：**用户选中的 id 异于 row**，随后服务端重新下发的选项里没有它。
      const noSupplier: InventorySkuRow = {
        ...row, supplier: null, supplierId: null, supplierName: null,
      }
      const props = (options: InventorySupplierOption[]) => (
        <InventorySkusPage
          rows={[noSupplier]}
          total={1}
          markets={[]}
          supplierOptions={options}
          canCreate
          canUpdate
          canCreateSupplier
          canViewPrice
          priceVisibility="all"
          canManageMarketSkus
          canManageSupplySkus
        />
      )
      const { rerender } = render(props(SUPPLIER_OPTIONS))
      fireEvent.click(screen.getByTitle('编辑库存商品'))
      fireEvent.change(supplierSelect(), { target: { value: 'SUP-2' } })

      // 服务端重新下发，SUP-2 已不在选项里（被停用 / 被过滤）。
      // editing 不变 → 弹窗 key 不变 → 组件不重挂 → form.supplierId 仍是 SUP-2。
      rerender(props([]))

      const select = supplierSelect()
      expect(select.value).toBe('SUP-2')
      expect(Array.from(select.options).map((o) => o.textContent))
        .toContain('已选供应商（刷新后可见）')

      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(mockUpdateInventorySku).toHaveBeenCalledWith(
        'SKU-1',
        expect.objectContaining({ supplierId: 'SUP-2' }),
      ))
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

      // label 带 * 且有 required：快捷建档的 3 个输入用 aria-label（不是 <Field> 包裹的
      // <label>），必填标记只能落在可及名称上，否则读屏用户无从得知名称是必填的
      const nameInput = screen.getByLabelText('新供应商名称 *')
      expect(nameInput).toBeRequired()
      fireEvent.change(nameInput, { target: { value: '新建的供应商' } })
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

  describe('价格列按档位裁剪（#135）', () => {
    // 判据是 engine.ts skuRow() 的遮蔽口径，两侧必须一致：
    //   supplyChainPurchasePrice → supplyVisible（all / supply_chain）
    //   marketPurchasePrice      → anyPriceVisible（≠ none）
    //   storePurchasePrice       → marketVisible（all / market）
    //   marketStaffPurchasePrice → marketVisible
    //   retailPrice              → 仅 all
    // 渲染了服务端必然遮蔽成 null 的列，用户看到的就是一整列「—」。
    const header = (name: string) => screen.queryByRole('columnheader', { name })

    it('market 档不渲染供应链采购价列（原症状：列头在、整列都是「—」）', () => {
      renderPage({ priceVisibility: 'market' })
      expect(header('供应链采购价')).not.toBeInTheDocument()
      expect(header('门店进货价')).toBeInTheDocument()
      expect(header('市场员工购价')).toBeInTheDocument()
      expect(header('市场进货价')).toBeInTheDocument()
      // 零售价只有 all 档看得到
      expect(header('零售价')).not.toBeInTheDocument()
    })

    it('supply_chain 档不渲染门店/员工购价与零售价', () => {
      renderPage({ priceVisibility: 'supply_chain' })
      expect(header('供应链采购价')).toBeInTheDocument()
      expect(header('市场进货价')).toBeInTheDocument()
      expect(header('门店进货价')).not.toBeInTheDocument()
      expect(header('市场员工购价')).not.toBeInTheDocument()
      expect(header('零售价')).not.toBeInTheDocument()
    })

    it('all 档五列齐全', () => {
      renderPage({ priceVisibility: 'all' })
      for (const name of ['供应链采购价', '市场进货价', '门店进货价', '市场员工购价', '零售价']) {
        expect(header(name)).toBeInTheDocument()
      }
    })

    it('none 档一个价格列都不渲染', () => {
      renderPage({ priceVisibility: 'none' })
      for (const name of ['供应链采购价', '市场进货价', '门店进货价', '市场员工购价', '零售价']) {
        expect(header(name)).not.toBeInTheDocument()
      }
      // 非价格列不受影响
      expect(header('来源')).toBeInTheDocument()
    })
  })
  describe('#355 新建的来源初值按权限决定', () => {
    it('只有市场权限：初值为「市场自采」，归属市场可见且唯一市场已预选，不切来源直接提交成功', async () => {
      renderPage({ canManageSupplySkus: false, markets: [market('MKT-1', '南昌市场')] })
      fireEvent.click(screen.getByRole('button', { name: /新建/ }))

      // 显示值与表单 state 必须一致：下拉只剩「市场自采 / 转让店」，选中的是第一项。
      // ⚠️ 这两条在改前代码下也是绿的（value 不在 option 里时原生 select 显示首项），
      // 真正锁住 #355 的是下面的「归属市场已落定」与提交参数断言，别删。
      const select = sourceSelect()
      expect(Array.from(select.options, (option) => option.value)).toEqual(['市场自采', '转让店'])
      expect(select.value).toBe('市场自采')
      // 归属市场只在来源不是供应链时渲染；唯一候选由 InventorySubjectSelect 落进表单（#189）
      const owner = screen.getByText('南昌市场')
      await waitFor(() => expect(owner).toHaveAttribute('data-fixed-subject', 'MKT-1'))

      fireEvent.change(screen.getAllByLabelText(/^产品名称/).find((element) => element.tagName === 'INPUT')!, { target: { value: '市场自采面膜' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() => expect(mockCreateInventorySku).toHaveBeenCalledTimes(1))
      expect(mockCreateInventorySku.mock.calls[0][0]).toMatchObject({
        productName: '市场自采面膜',
        sourceType: '市场自采',
        ownerMarketId: 'MKT-1',
        marketPurchasePriceMode: null,
      })
    })

    it('只有市场权限且可选市场不止一个：归属市场留空待选，不替用户挑', () => {
      renderPage({ canManageSupplySkus: false, markets: [market('MKT-1', '南昌市场'), market('MKT-2', '赣州市场')] })
      fireEvent.click(screen.getByRole('button', { name: /新建/ }))

      expect(sourceSelect().value).toBe('市场自采')
      const owner = screen.getByLabelText(/^归属市场/) as HTMLSelectElement
      expect(owner.value).toBe('')
      expect(mockCreateInventorySku).not.toHaveBeenCalled()
    })

    it('两把权限都有：初值仍为「供应链」，不渲染归属市场（回归）', () => {
      renderPage({ markets: [market('MKT-1', '南昌市场')] })
      fireEvent.click(screen.getByRole('button', { name: /新建/ }))

      const select = sourceSelect()
      expect(Array.from(select.options, (option) => option.value)).toEqual(['供应链', '市场自采', '转让店'])
      expect(select.value).toBe('供应链')
      expect(screen.queryByLabelText(/^归属市场/)).not.toBeInTheDocument()
    })

    it('只有供应链权限：初值为「供应链」，下拉只有这一项', () => {
      renderPage({ canManageMarketSkus: false })
      fireEvent.click(screen.getByRole('button', { name: /新建/ }))

      const select = sourceSelect()
      expect(Array.from(select.options, (option) => option.value)).toEqual(['供应链'])
      expect(select.value).toBe('供应链')
    })
  })
})
