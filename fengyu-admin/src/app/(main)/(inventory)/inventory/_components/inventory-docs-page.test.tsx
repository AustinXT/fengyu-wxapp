import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  InventoryDocRow,
  InventoryLocationFilterOptions,
  InventoryLocationRow,
  InventoryLotRow,
  InventorySkuRow,
} from '@/lib/inventory/types'

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

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import InventoryDocsPage, { SOURCE_LOT_DOC_TYPES } from './inventory-docs-page'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'

// vitest.config.ts 没开 clearMocks，不显式清会让调用记录跨用例累积、
// 也会让忘记设 mock 的新用例继承上一个用例的 mockRejectedValue。
beforeEach(() => vi.clearAllMocks())

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

// 页内标题块已由 6c6d375c 移除（面包屑已经给了「单据中心」，页内 h1 是重复），
// 故这里断言的是页面的检索与动作能力，不再断言页内 heading。
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

    expect(screen.getByPlaceholderText('搜索单据 / 顾客 / 员工 / 备注')).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: '市场产品报损' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: '内部领用' })).not.toBeInTheDocument()
  })
})

// ── #129 回归 ──────────────────────────────────────────────────────────────
// 原实现把 effect 自己 set 的 loadingLotKeys / lotOptionsByKey 放进依赖数组，
// 导致首次请求的回调被 cleanup 的 cancelled 全部跳过，批次下拉永久 disabled。

const locations: InventoryLocationRow[] = [
  { locationId: 'LOC-M1', locationType: '市场', name: '南昌市场', orgNodeId: 'M1', storeId: null, parentLocationId: null, isActive: true },
  { locationId: 'LOC-M2', locationType: '市场', name: '自贡市场', orgNodeId: 'M2', storeId: null, parentLocationId: null, isActive: true },
]

function sku(skuId: string, productCode: string, productName: string): InventorySkuRow {
  return {
    skuId,
    productCode,
    productName,
    specName: null,
    supplier: null,
    manufacturer: null,
    brand: null,
    productSeries: null,
    purchaseCategory: null,
    sourceType: '供应链',
    ownerMarketId: null,
    ownerMarketName: null,
    retailPrice: null,
    accountingPrice: null,
    supplyChainPurchasePrice: null,
    marketPurchasePrice: null,
    marketPurchasePriceMode: null,
    marketPurchasePriceOverrideReason: null,
    storePurchasePrice: null,
    marketStaffPurchasePrice: null,
    marketPurchaseDiscount: null,
    storePurchaseDiscount: null,
    staffPurchaseDiscount: null,
    itemCompanyPurchasePrice: null,
    isReportable: true,
    isActive: true,
    remark: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  }
}

const skuOptions = [sku('SKU-1', 'P001', '精华液'), sku('SKU-2', 'P002', '面膜')]

function lot(id: number, skuId: string, batchNo: string, quantityOnHand: number): InventoryLotRow {
  return {
    id,
    locationId: 'LOC-M1',
    locationName: '南昌市场',
    locationType: '市场',
    skuId,
    skuName: '精华液',
    specName: null,
    supplier: null,
    productSeries: null,
    batchNo,
    expiryDate: null,
    isGift: false,
    quantityOnHand,
    availableQuantity: quantityOnHand,
    remark: null,
    updatedAt: '2026-08-13T00:00:00.000Z',
  }
}

/**
 * 按「首个 option 的文案」定位弹窗里的下拉，而不是按索引 ——
 * 索引会随 DatePicker 等组件的内部结构变化而错位，且错位后断言会静默地打在别的控件上。
 * 批次下拉例外：它有 aria-label（多明细行时文案完全相同，只有 label 能区分），走 getByLabelText。
 */
function dialogSelect(firstOptionText: RegExp): HTMLSelectElement {
  const selects = Array.from(screen.getByRole('dialog').querySelectorAll('select'))
  const hit = selects.find((el) => firstOptionText.test(el.options[0]?.textContent ?? ''))
  if (!hit) throw new Error(`弹窗里找不到首项文案匹配 ${firstOptionText} 的下拉`)
  return hit
}

const lotSelect = (index = 1) => screen.getByLabelText(`明细 ${index} 来源批次`) as HTMLSelectElement
const lotPlaceholder = (index = 1) => lotSelect(index).options[0]?.textContent?.trim() ?? ''
const skuSelect = () => dialogSelect(/^库存 SKU$/)
const sourceSelect = () => dialogSelect(/^出库\/发起主体$/)

/** 打开「市场产品报损」（属 SOURCE_LOT_DOC_TYPES）建单弹窗，并选好出库主体 + SKU。 */
function openDialogAndPickSource() {
  render(
    <InventoryDocsPage
      {...baseProps}
      locations={locations}
      skuOptions={skuOptions}
      allowedCreateDocTypes={['市场产品报损']}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '新建' }))
  fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
  fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
}

describe('InventoryDocsPage 来源批次下拉（#129 回归）', () => {
  it('选定出库主体与 SKU 后，批次下拉会解除禁用并渲染真实批次', async () => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30)])

    openDialogAndPickSource()

    expect(listInventoryLotOptions).toHaveBeenCalledWith('LOC-M1', 'SKU-1')
    // 修复前这里会永远停在 disabled + 「加载库存批次...」
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-001 · 可用 30/ })).toBeInTheDocument()
  })

  it('切换 SKU 会按新入参重拉，且期间不会闪出上一个 SKU 的批次', async () => {
    vi.mocked(listInventoryLotOptions).mockImplementation(async (_locationId, skuId) =>
      skuId === 'SKU-1' ? [lot(11, 'SKU-1', 'B-001', 30)] : [lot(22, 'SKU-2', 'B-002', 7)],
    )

    openDialogAndPickSource()
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())

    fireEvent.change(skuSelect(), { target: { value: 'SKU-2' } })

    // 入参一变即判定为加载中：旧批次不会残留
    expect(lotSelect()).toBeDisabled()
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: /B-001/ })).not.toBeInTheDocument()

    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(listInventoryLotOptions).toHaveBeenLastCalledWith('LOC-M1', 'SKU-2')
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-002 · 可用 7/ })).toBeInTheDocument()
  })

  it('批次加载失败时给出可见提示，而不是静默退化成空列表', async () => {
    // 业务错误按 actionErrorMessage 口径剥掉前缀后展示
    vi.mocked(listInventoryLotOptions).mockRejectedValue(new Error('PERMISSION_DENIED: 无权查看该主体库存'))

    openDialogAndPickSource()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('无权查看该主体库存'))
    // 失败态必须和「该主体该 SKU 真的没批次」在文案上区分开，否则用户会误判为「没货」
    await waitFor(() => expect(lotPlaceholder()).toBe('批次加载失败，点此重试'))
  })

  it('失败后点一下批次框即可重试，不必靠「切到别的 SKU 再切回来」', async () => {
    vi.mocked(listInventoryLotOptions)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30)])

    openDialogAndPickSource()
    await waitFor(() => expect(lotPlaceholder()).toBe('批次加载失败，点此重试'))

    fireEvent.focus(lotSelect())

    await waitFor(() => expect(lotPlaceholder()).toBe('选择库存批次'))
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-001/ })).toBeInTheDocument()
  })

  it('同一 (主体, SKU) 被多行选中时只发一次请求（弹窗级 Promise 缓存）', async () => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30)])

    openDialogAndPickSource()
    await waitFor(() => expect(lotSelect(1)).not.toBeDisabled())

    fireEvent.click(screen.getByRole('button', { name: '添加明细' }))
    fireEvent.change(within(screen.getByRole('dialog')).getAllByRole('combobox')
      .filter((el) => (el as HTMLSelectElement).options[0]?.textContent === '库存 SKU')[1], {
      target: { value: 'SKU-1' },
    })

    await waitFor(() => expect(lotSelect(2)).not.toBeDisabled())
    // 去掉共享缓存会在这里变成 2 次；明细多、又删过中间行时会放大成一串串行请求
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)
    expect(within(lotSelect(2)).getByRole('option', { name: /B-001/ })).toBeInTheDocument()
  })

  it('脱敏/框架级异常退回业务兜底文案，不把英文技术话术甩给用户', async () => {
    vi.mocked(listInventoryLotOptions).mockRejectedValue(
      new Error('An error occurred in the Server Components render.'),
    )

    openDialogAndPickSource()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('加载可用批次失败'))
  })
})

// 前端的 SOURCE_LOT_DOC_TYPES 与服务端 engine.ts 的 shouldCaptureSourceLot 是两份真相。
// 今天一致（交集正好这 6 项），但给 OUTBOUND_DOC_TYPES + INVENTORY_GENERIC_DOC_TYPES 加了类型
// 却漏加 SOURCE_LOT_DOC_TYPES 时，弹窗不渲染批次下拉 → 提交必撞
// 「出库类明细必须选择库存批次」且用户无法补救。这条断言就是拿来卡住那次漂移的。
describe('通用建单入口里需要来源批次的单据类型', () => {
  it('恰好是 SOURCE_LOT × 通用类型的这 6 项', () => {
    const intersection = INVENTORY_GENERIC_DOC_TYPES.filter((t) => SOURCE_LOT_DOC_TYPES.has(t))
    expect(intersection).toEqual([
      '分院调货出库',
      '市场间调货出库',
      '内部领用',
      '院顾客产品出库',
      '市场产品报损',
      '院产品报损',
    ])
  })
})
