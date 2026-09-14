import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  InventoryDocRow,
  InventoryLocationFilterOptions,
  InventoryLocationRow,
  InventoryLotRow,
  InventorySkuRow,
} from '@/lib/inventory/types'

// refresh 必须是共享引用：原先每次调用 useRouter 都新建一个 vi.fn()，测试拿不到它，
// 于是「关弹窗 + **刷新列表**」这条修复只有前半截被守住（同目录 inventory-skus-page.test.tsx 已是此写法）。
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
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
import {
  approveInventoryCoreDoc,
  confirmInventoryCoreReceive,
  createInventoryCoreDoc,
  rejectInventoryCoreDoc,
} from '@/actions/inventory/docs'
import InventoryDocsPage, { SOURCE_LOT_DOC_TYPES } from './inventory-docs-page'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'

// vitest.config.ts 没开 clearMocks/restoreMocks。这里必须用 resetAllMocks 而不是 clearAllMocks ——
// 后者只清调用记录、不清 implementation，忘记设 mock 的新用例会静默继承上一条的 mockRejectedValue。
beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mockRefresh.mockClear()
})

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

function lot(
  id: number,
  skuId: string,
  batchNo: string,
  quantityOnHand: number,
  availableQuantity = quantityOnHand,
): InventoryLotRow {
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
    availableQuantity,
    remark: null,
    updatedAt: '2026-08-13T00:00:00.000Z',
  }
}

/** 手工可控的 Promise，用来制造「请求尚未返回」的在途窗口 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
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

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('无权查看该主体库存', expect.objectContaining({ id: expect.any(String) })))
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

  it('旧请求还在途时切 SKU，先到的旧结果不会覆盖当前选项', async () => {
    const first = deferred<InventoryLotRow[]>()
    const second = deferred<InventoryLotRow[]>()
    vi.mocked(listInventoryLotOptions).mockImplementation(async (_locationId, skuId) =>
      skuId === 'SKU-1' ? first.promise : second.promise,
    )

    openDialogAndPickSource()
    // SKU-1 的请求尚未 resolve 就切到 SKU-2 —— 这才是真正的在途竞态
    expect(lotSelect()).toBeDisabled()
    fireEvent.change(skuSelect(), { target: { value: 'SKU-2' } })

    // 旧请求后到：cleanup 已把它的 cancelled 置 true，结果必须被丢弃
    await act(async () => { first.resolve([lot(11, 'SKU-1', 'B-001', 30)]) })
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: /B-001/ })).not.toBeInTheDocument()
    expect(lotSelect()).toBeDisabled()

    await act(async () => { second.resolve([lot(22, 'SKU-2', 'B-002', 7)]) })
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-002/ })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: /B-001/ })).not.toBeInTheDocument()
  })

  it('展示的是可用量（扣掉未完成预留）而不是在手量', async () => {
    // 在手 30、预留 10 → 可用 20。显示在手量会出现「界面写着 30、提交却报库存不足」
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30, 20)])

    openDialogAndPickSource()

    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-001 · 可用 20/ })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: /可用 30/ })).not.toBeInTheDocument()
  })

  it('批次接口返回非数组时走失败路径，而不是伪装成空列表', async () => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue(undefined as never)

    openDialogAndPickSource()

    await waitFor(() => expect(lotPlaceholder()).toBe('批次加载失败，点此重试'))
    expect(toast.error).toHaveBeenCalled()
  })

  it('弹窗关闭后不再取数，重开时每个 (主体,SKU) 恰好重拉一次', async () => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30)])

    openDialogAndPickSource()
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)

    // 关闭：原生 <dialog> 不卸载 children，关着时绝不能因为代次推进而白发请求
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(listInventoryLotOptions).toHaveBeenCalledTimes(1))

    // 重开：代次已在关闭时推进，渲染期即判为过期 → 恰好重拉一次，不闪旧批次
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(lotSelect()).toBeDisabled()
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(2)
  })

  it('请求还在途时关掉再打开，复用同一个在途请求而不是重发', async () => {
    // Server Action 不可 abort。关闭时无条件清缓存，等于把还在 FIFO 队列里排队的请求作废；
    // 用户秒关秒开就会再发一遍，新请求还排在旧请求后面，等待时间翻倍 —— 又是 #129 的观感。
    const first = deferred<InventoryLotRow[]>()
    vi.mocked(listInventoryLotOptions).mockReturnValue(first.promise as never)

    openDialogAndPickSource()
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)
    expect(lotSelect()).toBeDisabled()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    // 在途的那次没被作废，也没有第二次
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)

    await act(async () => { first.resolve([lot(11, 'SKU-1', 'B-001', 30)]) })
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-001/ })).toBeInTheDocument()
  })

  it('请求在「关闭后、重开前」落地的，重开时不当新鲜结果复用', async () => {
    // 上一条的反面：按「关闭当刻是否 settled」一刀切会漏掉这批 —— 关闭当刻还在途、躲过清理，
    // 重开时又已完成，于是被当成新鲜结果复用，展示的是可能已经过期的可用量。
    const first = deferred<InventoryLotRow[]>()
    vi.mocked(listInventoryLotOptions)
      .mockReturnValueOnce(first.promise as never)
      .mockResolvedValue([lot(22, 'SKU-1', 'B-NEW', 5)] as never)

    openDialogAndPickSource()
    expect(listInventoryLotOptions).toHaveBeenCalledTimes(1)

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    // 关闭期间落地
    await act(async () => { first.resolve([lot(11, 'SKU-1', 'B-OLD', 30)]) })

    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())

    expect(listInventoryLotOptions).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: /B-NEW/ })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: /B-OLD/ })).not.toBeInTheDocument()
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

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('加载可用批次失败', expect.objectContaining({ id: expect.any(String) })))
  })
})

// issue #129 的验收标准之一是「6 种单据类型均能在单据中心成功创建并落库」。
// 只断言「批次加载出来了」挡不住后续回归：onChange 不再写 item.lotId、
// 或 payload 映射漏掉 lotId，批次照样能加载，6 种出库单却全部撞服务端必填校验。
// 所以这里对 6 种类型逐个走完整提交，断言 action 收到的是**数值型** lotId。
describe('6 种需选来源批次的通用单据都能走完提交（#129 验收）', () => {
  const NEED_LOT_GENERIC = INVENTORY_GENERIC_DOC_TYPES.filter((t) => SOURCE_LOT_DOC_TYPES.has(t))

  it.each(NEED_LOT_GENERIC)('%s：选批次后提交，payload 带数值 lotId', async (docType) => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(77, 'SKU-1', 'B-777', 30)])
    vi.mocked(createInventoryCoreDoc).mockResolvedValue(undefined as never)

    render(
      <InventoryDocsPage
        {...baseProps}
        locations={locations}
        skuOptions={skuOptions}
        allowedCreateDocTypes={[docType]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())

    fireEvent.change(lotSelect(), { target: { value: '77' } })
    fireEvent.change(within(screen.getByRole('dialog')).getByPlaceholderText('数量'), { target: { value: '3' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '提交' }))

    await waitFor(() => expect(createInventoryCoreDoc).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(createInventoryCoreDoc).mock.calls[0][0]
    expect(payload.docType).toBe(docType)
    expect(payload.items[0].lotId).toBe(77)
    expect(payload.items[0].quantity).toBe(3)
  })
})

// 前端的 SOURCE_LOT_DOC_TYPES 与服务端 engine.ts 的 shouldCaptureSourceLot 是两份真相。
// 光断言交集是 6 项挡不住真正的漏加：给 OUTBOUND_DOC_TYPES + INVENTORY_GENERIC_DOC_TYPES
// 同时加一个新类型、却漏加前端 SOURCE_LOT_DOC_TYPES，交集仍是原来的 6 项，测试照样绿，
// 而弹窗不渲染批次框 → 提交必撞「出库类明细必须选择库存批次」且用户无法补救。
// 所以这里还要直接读 engine.ts 的字面量做单向包含检查。
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

  it('前端集合的形状本身不漂移（全集 14 项）', () => {
    const expected = [
      '品项公司发货',
      '分院配货',
      '分院调货出库',
      '市场间调货出库',
      '员工购出库',
      '供应链员工购出库',
      '内部领用',
      '非凤御市场出库',
      '市场退货',
      '院退货',
      '院顾客产品出库',
      '市场产品报损',
      '院产品报损',
      '库存转换出库',
    ]
    expect([...SOURCE_LOT_DOC_TYPES].sort()).toEqual([...expected].sort())
  })

  it('与服务端「需要来源批次」的判定逐项等值', () => {
    // 不 import engine.ts（它是 server-only，会把 @/db 拖进来），改读源码字面量。
    //
    // 服务端真实判定（engine.ts:2715）：
    //   shouldCaptureSourceLot = plan?.locationRole === 'source'
    //                            || (status === '待审批' && OUTBOUND_DOC_TYPES.has(docType))
    // 而 movementPlan 判 locationRole='source' 的来源有两处：
    //   RECEIVE_REQUIRED_DOC_TYPES（分院调货出库 / 市场间调货出库走的正是这条）与 OUTBOUND_DOC_TYPES。
    // 只守 OUTBOUND 会漏掉前者 —— 往 RECEIVE_REQUIRED + GENERIC 同时加类型却漏加前端集合时，
    // 交集仍是 6、形状仍是 14，三条断言全绿，弹窗却不渲染批次框。
    const engineSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/engine.ts'), 'utf8')
    const readSet = (name: string): string[] => {
      const block = engineSrc.match(
        new RegExp(`const ${name} = new Set<InventoryDocType>\\(\\[([\\s\\S]*?)\\]\\)`),
      )?.[1]
      expect(block, `engine.ts 里找不到 ${name}`).toBeTruthy()
      return [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1])
    }

    const serverNeedsSourceLot = new Set([
      ...readSet('RECEIVE_REQUIRED_DOC_TYPES'),
      ...readSet('OUTBOUND_DOC_TYPES'),
    ])
    expect(serverNeedsSourceLot.size).toBeGreaterThan(0)

    const generic = INVENTORY_GENERIC_DOC_TYPES as readonly string[]
    expect(
      generic.filter((t) => serverNeedsSourceLot.has(t)).sort(),
      '前端 SOURCE_LOT_DOC_TYPES 与服务端 shouldCaptureSourceLot 在通用建单类型上漂移了',
    ).toEqual(generic.filter((t) => SOURCE_LOT_DOC_TYPES.has(t as never)).sort())
  })
})

// ── #134：原生 alert / prompt 换成页内组件 ────────────────────────────────
// 原实现用 prompt('驳回原因') 收集备注：不可样式化、阻塞 JS、**且无法做必填校验**
// （prompt 取消或留空都得到 ''，代码 `|| ''` 直接放过，空驳回原因就这么提交了）。

const receivableRow: InventoryDocRow = { ...row, id: 'DTO-260813-0002', docType: '内部领用', status: '待收货' }

function renderDocs(rows: InventoryDocRow[] = [row]) {
  render(<InventoryDocsPage {...baseProps} rows={rows} allowedCreateDocTypes={['市场产品报损']} />)
}

/**
 * happy-dom 不实现 window.alert / prompt / confirm（`vi.spyOn` 会报
 * 「can only spy on a function」）—— 顺带说明原实现的 `alert(...)` / `prompt(...)`
 * 在单测里根本跑不起来，这也是这几条路径此前零覆盖的原因之一。
 * 这里显式塞进去，好让「不再被调用」这件事真的可断言。
 */
function stubNativeDialogs() {
  const spies = { alert: vi.fn(), prompt: vi.fn(() => ''), confirm: vi.fn(() => true) }
  for (const [name, fn] of Object.entries(spies)) vi.stubGlobal(name, fn)
  return spies
}

const actionDialog = () => screen.getByRole('dialog')
/**
 * 走 `<label htmlFor>` ↔ `id` 的真实配对（组件上已去掉 aria-label —— 它优先级高于
 * label，留着的话把 htmlFor 或 id 写错都测不出来）。必填项的可及名带着 `*`，故用正则。
 */
const remarkBox = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label}`)) as HTMLTextAreaElement

describe('审批 / 驳回 / 收货的备注弹窗（#134）', () => {
  // 守护正则必须连**带接收者**的写法一起认：仓内域外残留的 6 处用的全是
  // `window.confirm(` / `window.prompt(` 这种形式，只认裸调用的守护恰好看不见
  // 最可能长出来的那种回归。
  const NATIVE_DIALOG_RE =
    /(?:^|[^.\w$])(?:(?:window|globalThis|self|top|parent)\s*\??\s*\.\s*)?(?:alert|prompt|confirm)\s*\(|\[\s*['"](?:alert|prompt|confirm)['"]\s*\]\s*\(/

  it('整个库存域组件目录都不再出现原生弹窗调用', () => {
    // 只守单个文件的话，同目录的 inventory-operations-page.tsx / inventory-skus-page.tsx
    // 新写一个 window.confirm 照样过 —— 而域外残留的 7 处恰好证明这种写法是会自然长出来的。
    const dir = import.meta.dirname
    const files = readdirSync(dir).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    )
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const src = readFileSync(resolve(dir, file), 'utf8')
      expect(src, `${file} 里出现了原生弹窗调用`).not.toMatch(NATIVE_DIALOG_RE)
    }
  })

  it('守护正则本身盖得住带接收者的写法（元测试）', () => {
    const shouldCatch = [
      "alert('x')",
      "prompt('驳回原因')",
      "window.alert('x')",
      "window.prompt('驳回原因')",
      "window.confirm('确定?')",
      "globalThis.prompt('x')",
      "self.alert('x')",
      "window?.alert('x')",
      "window['alert']('x')",
      'alert\n(\'x\')',
    ]
    const shouldPass = [
      'confirmInventoryCoreReceive(docId, remark)',
      'onConfirm()',
      'setAlert(true)',
      'this.alert(',
      'foo.confirm2(',
    ]
    for (const bad of shouldCatch) expect(bad, `应命中：${bad}`).toMatch(NATIVE_DIALOG_RE)
    for (const ok of shouldPass) expect(ok, `不应命中：${ok}`).not.toMatch(NATIVE_DIALOG_RE)
  })

  it('点「驳回」开的是页内弹窗，不是原生 prompt', () => {
    const { prompt: promptSpy } = stubNativeDialogs()
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))

    expect(promptSpy).not.toHaveBeenCalled()
    expect(within(actionDialog()).getByText('驳回单据')).toBeInTheDocument()
    // 单据号要出现在弹窗里 —— 原生 prompt 只给一句「驳回原因」，操作员不知道在驳哪张单
    expect(within(actionDialog()).getByText(`单据号 ${row.id}`)).toBeInTheDocument()
  })

  it('驳回原因为空时阻止提交，并给出可见校验提示', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    // 行内红字故意不带 role="alert"：同文案的 toast 已经在 live region 里播报过一次
    await waitFor(() =>
      expect(within(actionDialog()).getByText('请填写驳回原因')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(rejectInventoryCoreDoc).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('请填写驳回原因')
    expect(remarkBox('驳回原因')).toHaveAttribute('aria-invalid', 'true')
  })

  it('只填空白字符同样算空', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '   \n  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('请填写驳回原因'))
    expect(rejectInventoryCoreDoc).not.toHaveBeenCalled()
  })

  it('填了原因才提交，且传给 action 的是 trim 后的值', async () => {
    vi.mocked(rejectInventoryCoreDoc).mockResolvedValue(undefined as never)
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '  数量与实物不符  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() =>
      expect(rejectInventoryCoreDoc).toHaveBeenCalledWith(row.id, '数量与实物不符'),
    )
    expect(toast.success).toHaveBeenCalledWith('单据已驳回')
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
  })

  it('审批备注选填：留空也能提交', async () => {
    vi.mocked(approveInventoryCoreDoc).mockResolvedValue(undefined as never)
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(approveInventoryCoreDoc).toHaveBeenCalledWith(row.id, ''))
    expect(toast.success).toHaveBeenCalledWith('单据已通过，库存已扣减')
  })

  it('收货备注选填，且调的是收货 action', async () => {
    vi.mocked(confirmInventoryCoreReceive).mockResolvedValue({
      success: true,
      inboundDocId: 'CGRK-260813-0007',
    } as never)
    renderDocs([receivableRow])
    fireEvent.click(screen.getByRole('button', { name: '收货' }))
    fireEvent.change(remarkBox('收货备注'), { target: { value: '少收 1 件' } })
    fireEvent.click(screen.getByRole('button', { name: '确认收货' }))

    await waitFor(() =>
      expect(confirmInventoryCoreReceive).toHaveBeenCalledWith(receivableRow.id, '少收 1 件'),
    )
    // 收货会生成入库单，单号要带进提示里 —— 那是用户下一步要找的东西
    expect(toast.success).toHaveBeenCalledWith('收货已确认，已生成入库单 CGRK-260813-0007')
  })

  it('取消就是取消：不调用任何 action', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '写了一半又反悔' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(rejectInventoryCoreDoc).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('换一个动作重开，上一次输入不会串味', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '写了一半又反悔' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(remarkBox('审批备注')).toHaveValue('')
  })

  it('服务端报错走 toast + actionErrorMessage，不再是原生 alert', async () => {
    const { alert: alertSpy } = stubNativeDialogs()
    vi.mocked(approveInventoryCoreDoc).mockRejectedValue(
      Object.assign(new Error('sanitized'), { digest: 'INVALID_STATE: 只有待审批单据可以审批' }),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('只有待审批单据可以审批'))
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('提交期间按钮禁用，点第二下不会重复调 action', async () => {
    const gate = deferred<void>()
    vi.mocked(rejectInventoryCoreDoc).mockReturnValue(gate.promise as never)
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '处理中…' }))
    await act(async () => { gate.resolve(); await gate.promise })
    expect(rejectInventoryCoreDoc).toHaveBeenCalledTimes(1)
  })
})

describe('弹窗在异常与并发下的出路（#134 评审补）', () => {
  it('状态型错误（单据已被别人改过）→ 关弹窗 + 刷新列表，不把人困在必失败的按钮上', async () => {
    vi.mocked(approveInventoryCoreDoc).mockRejectedValue(
      Object.assign(new Error('sanitized'), { digest: 'INVALID_STATE: 只有待审批单据可以审批' }),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('只有待审批单据可以审批'))
    // 留着弹窗只会让人反复点同一个必失败的按钮 —— 列表也还是旧状态，按钮照样在
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // 「刷新」是这条修复的另一半：不刷的话回到列表看到的还是「待审批」
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
  })

  it('非状态型错误（网络抖动）→ 弹窗留着让人重试', async () => {
    vi.mocked(approveInventoryCoreDoc).mockRejectedValue(new Error('Failed to fetch'))
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('审批失败'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  /**
   * happy-dom 的 `getBoundingClientRect()` 恒为全 0，而组件在判「点击落点是否在框外」之前
   * 就会因 `rect.width === 0` 提前 return —— 不打桩的话，把 `if (!dismissible) return`
   * 整行删掉测试照样绿。这里给它一个真实矩形，并从框外坐标点下去。
   */
  function clickBackdrop(dialog: HTMLElement) {
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, width: 400, height: 300,
      top: 100, left: 100, right: 500, bottom: 400,
      toJSON: () => ({}),
    } as DOMRect)
    fireEvent.click(dialog, { clientX: 10, clientY: 10 })
  }

  it('空闲时点遮罩能关（对照组：证明上面那条确实走到了 dismissible 分支）', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    clickBackdrop(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('提交在途时遮罩与 ESC 都关不掉（「关掉了」≠「取消了」）', async () => {
    const gate = deferred<void>()
    vi.mocked(approveInventoryCoreDoc).mockReturnValue(gate.promise as never)
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    const dialog = screen.getByRole('dialog')
    clickBackdrop(dialog)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // ESC 走 cancel；不可关闭时应被 preventDefault
    const cancelEvent = new Event('cancel', { cancelable: true, bubbles: true })
    fireEvent(dialog, cancelEvent)
    expect(cancelEvent.defaultPrevented).toBe(true)
    // 光断言 defaultPrevented 不够：万一将来有人既 preventDefault 又 onOpenChange(false)，
    // 这条用例照样绿。把「弹窗仍在 + action 没被重复调」也钉住。
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(approveInventoryCoreDoc).toHaveBeenCalledTimes(1)

    await act(async () => { gate.resolve(); await gate.promise })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  /**
   * 真机上 `showModal()` 会让背景 inert，行按钮点不到；只有 dialog.tsx 降级到 `.show()`
   * 那条退路才可达。让 `showModal` 抛错，把降级路径真正打开 —— 否则用例名声称的
   * 「降级路径」其实只是 fireEvent 不遵守 inert 而已，删掉 fallback 分支照样绿。
   */
  function forceNonModalFallback() {
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, 'showModal')
      .mockImplementation(function (this: HTMLDialogElement) {
        throw new Error('showModal unsupported')
      })
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show')
    return { showModal, show }
  }

  it('降级路径确实走到了 .show()（前置条件自检）', () => {
    const { show } = forceNonModalFallback()
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(show).toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('降级路径下提交在途时，背景的行操作按钮被锁住', async () => {
    forceNonModalFallback()
    const gate = deferred<void>()
    vi.mocked(rejectInventoryCoreDoc).mockReturnValue(gate.promise as never)
    const rowB: InventoryDocRow = { ...row, id: 'MBS-260813-0009' }
    renderDocs([row, rowB])

    fireEvent.click(screen.getAllByRole('button', { name: '驳回' })[0])
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    // 背景里 B 单的「通过」必须点不动，否则 A 的「处理中」界面会被顶掉，用户以为 A 取消了
    for (const btn of screen.getAllByRole('button', { name: '通过' })) expect(btn).toBeDisabled()
    for (const btn of screen.getAllByRole('button', { name: '驳回' })) expect(btn).toBeDisabled()

    await act(async () => { gate.resolve(); await gate.promise })
  })

  it('提交的是用户原样输入，不因必填校验顺手改写正文', async () => {
    vi.mocked(rejectInventoryCoreDoc).mockResolvedValue(undefined as never)
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    // ZWJ 组合 emoji：清 Cf 只能用于「看起来是不是空的」，不能拿去落库
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '  已联系 👩\u200D⚕️ 复核  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() =>
      expect(rejectInventoryCoreDoc).toHaveBeenCalledWith(row.id, '已联系 👩\u200D⚕️ 复核'),
    )
  })

  it('弹窗有可及名称，读屏不会只念一句「对话框」', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(screen.getByRole('dialog', { name: '驳回单据' })).toBeInTheDocument()
  })

  it('零宽字符不算数：只粘一个零宽空格照样判空', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '\u200B\uFEFF' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('请填写驳回原因'))
    expect(rejectInventoryCoreDoc).not.toHaveBeenCalled()
  })

  it('审批弹窗写明不可撤销的后果（它是三个动作里唯一实扣库存的）', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(within(actionDialog()).getByText(/实扣库存/)).toBeInTheDocument()
    expect(within(actionDialog()).getByText(/不可撤销/)).toBeInTheDocument()
  })

  it('错误提示与输入框用 aria-describedby 关联（焦点在框里时读屏才念得到）', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    const errorText = await waitFor(() => within(actionDialog()).getByText('请填写驳回原因'))
    const box = remarkBox('驳回原因')
    expect(errorText.id).toBeTruthy()
    expect(box).toHaveAttribute('aria-describedby', errorText.id)
  })

  it('打开弹窗时焦点直接落在备注输入框，而不是右上角的关闭按钮', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    await waitFor(() => expect(remarkBox('驳回原因')).toHaveFocus())
  })

  it('关掉再打开（含换动作）焦点仍然落在输入框 —— 常驻挂载后这才是真正的风险点', async () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    await waitFor(() => expect(remarkBox('驳回原因')).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    // 把焦点挪走，确保下面断言的是「重新聚焦」而不是「焦点恰好还在原处」
    screen.getByRole('button', { name: '新建' }).focus()

    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    await waitFor(() => expect(remarkBox('审批备注')).toHaveFocus())
  })

  it('弹窗把单据号与不可撤销后果作为可及描述播报出来', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(screen.getByRole('dialog', { name: '确认审批通过？' })).toHaveAccessibleDescription(
      /实扣库存/,
    )
  })

  it('权限被收回（PERMISSION_DENIED）也给出路：关窗 + 刷新', async () => {
    vi.mocked(approveInventoryCoreDoc).mockRejectedValue(
      Object.assign(new Error('sanitized'), { digest: 'PERMISSION_DENIED: 无权审批该单据' }),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('无权审批该单据'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
  })

  it('字数计数随输入更新', () => {
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(within(actionDialog()).getByText('0/300')).toBeInTheDocument()
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    expect(within(actionDialog()).getByText('4/300')).toBeInTheDocument()
  })

  it('从 A 单的驳回直接切到 B 单的通过：备注清空、标题与单据号都跟着换', () => {
    // 真机上 showModal() 会让背景 inert 点不到行按钮，但 dialog.tsx 有降级到 .show() 的退路，
    // 那条路下这个直切是可达的 —— 组件不卸载，全靠 resetKey effect 兜。
    const rowB: InventoryDocRow = { ...row, id: 'MBS-260813-0009' }
    renderDocs([row, rowB])
    fireEvent.click(screen.getAllByRole('button', { name: '驳回' })[0])
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '写给 A 的原因' } })
    fireEvent.click(screen.getAllByRole('button', { name: '通过' })[1])

    expect(within(actionDialog()).getByText('确认审批通过？')).toBeInTheDocument()
    expect(actionDialog()).toHaveTextContent(`单据号 ${rowB.id}`)
    expect(remarkBox('审批备注')).toHaveValue('')
  })
})

describe('建单失败的提示（#134）', () => {
  it('用 toast + actionErrorMessage，不再弹原生 alert，也不再吐脱敏英文', async () => {
    const { alert: alertSpy } = stubNativeDialogs()
    vi.mocked(createInventoryCoreDoc).mockRejectedValue(
      Object.assign(
        new Error(
          'An error occurred in the Server Components render. The specific message is omitted in production builds.',
        ),
        { digest: 'INVALID_STATE: 库存期初尚未导入并核验完成，暂不可办理库存业务' },
      ),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('库存期初尚未导入并核验完成，暂不可办理库存业务'),
    )
    expect(alertSpy).not.toHaveBeenCalled()
  })
})
