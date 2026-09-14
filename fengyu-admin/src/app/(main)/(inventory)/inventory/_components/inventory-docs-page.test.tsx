import { readFileSync } from 'node:fs'
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
import { createInventoryCoreDoc } from '@/actions/inventory/docs'
import InventoryDocsPage, { SOURCE_LOT_DOC_TYPES } from './inventory-docs-page'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'

// vitest.config.ts 没开 clearMocks/restoreMocks。这里必须用 resetAllMocks 而不是 clearAllMocks ——
// 后者只清调用记录、不清 implementation，忘记设 mock 的新用例会静默继承上一条的 mockRejectedValue。
beforeEach(() => vi.resetAllMocks())

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
