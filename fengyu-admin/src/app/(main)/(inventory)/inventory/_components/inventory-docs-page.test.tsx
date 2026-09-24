import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  InventoryDocRow,
  InventoryDocType,
  InventoryLocationFilterOptions,
  InventoryLocationRow,
  InventoryLotRow,
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
vi.mock('./inventory-sku-search-select', () => import('./__stubs__/inventory-sku-search-select.stub'))

import { toast } from 'sonner'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import {
  approveInventoryCoreDoc,
  confirmInventoryCoreReceive,
  createInventoryCoreDoc,
  rejectInventoryCoreDoc,
} from '@/actions/inventory/docs'
import InventoryDocsPage, {
  SOURCE_LOT_DOC_TYPES,
  genericDocEndpointMode,
  type GenericDocEndpointMode,
} from './inventory-docs-page'
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
  canCreate: true,
  canApprove: true,
  canReceive: true,
  receivableTargetOrgNodeIds: null,
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
const targetSelect = () => dialogSelect(/^入库\/接收主体$/)
/**
 * 单据类型下拉同样按首项文案定位 —— 它的首项就是 `allowedCreateDocTypes[0]`。
 * 传进来的类型名不会与任何占位文案撞车（占位都是「出库/发起主体」这类固定短语）。
 */
const docTypeSelect = (firstType: string) => dialogSelect(new RegExp(`^${firstType}$`))

/** 打开「市场产品报损」（属 SOURCE_LOT_DOC_TYPES）建单弹窗，并选好出库主体 + SKU。 */
function openDialogAndPickSource() {
  render(
    <InventoryDocsPage
      {...baseProps}
      locations={locations}
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

/**
 * #200：服务端现在会拒绝「单边单据收到另一边的主体」（改前是静默忽略）。
 * 这个弹窗用 `useState('')` 存两个主体，且原生 `<dialog>` 关闭不卸载组件 ——
 * 用同一个弹窗连着建两张不同类型的单时，上一张的主体残留会让新单以
 * 「XX 不接受入库主体」失败，而那个下拉在新类型下根本不该有值。
 */
describe('#200 切换单据类型时复位主体字段', () => {
  const targetSelect = () => dialogSelect(/^入库\/接收主体$/)

  function openWithTypes(types: InventoryDocType[]) {
    render(
      <InventoryDocsPage
        {...baseProps}
        locations={locations}
        allowedCreateDocTypes={types}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
  }

  it('换类型后出库/入库主体都回到未选状态，不把上一张单的残留带进新单', () => {
    openWithTypes(['分院调货出库', '院顾客退货'])

    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    fireEvent.change(targetSelect(), { target: { value: 'M2' } })
    expect(sourceSelect().value).toBe('M1')
    expect(targetSelect().value).toBe('M2')

    fireEvent.change(dialogSelect(/^分院调货出库$/), { target: { value: '院顾客退货' } })

    // 院顾客退货是单边（只走 target）单据，残留的 source 会被服务端直接拒
    expect(sourceSelect().value).toBe('')
    expect(targetSelect().value).toBe('')
  })

  /**
   * 必须走 **target-only 提交** 来断言 payload —— 这是唯一能锁住「切类型清 lotId」的路径：
   * 只有出库主体的 onChange 清 lotId，入库主体的不清。所以「切完类型只选入库主体就提交」
   * 时，旧 lotId 会一路带进 payload，而同主体单据的服务端会把 target 归一成 source、
   * 按出库批次锁定并写入它。只断言 DOM 上批次框显示为空是锁不住的（受控 select 的值
   * 不在 options 里时本来就显示空，state 里那个旧 id 还在）。
   */
  it('换类型后只选入库主体就提交，payload 不得带上一张单的 lotId', async () => {
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(11, 'SKU-1', 'B-001', 30)])
    vi.mocked(createInventoryCoreDoc).mockResolvedValue(undefined as never)
    // #350 前第一张用「院顾客产品出库」；它移出通用白名单后换成同样要选来源批次的分院调货出库
    openWithTypes(['分院调货出库', '院产品报损'])

    // 第一张单：选好出库主体 + SKU + 批次
    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    fireEvent.change(lotSelect(), { target: { value: '11' } })
    expect(lotSelect().value).toBe('11')

    // 切到同主体单据，然后**只动入库主体**（它的 onChange 不清 lotId）
    fireEvent.change(dialogSelect(/^分院调货出库$/), { target: { value: '院产品报损' } })
    expect(sourceSelect().value).toBe('')
    expect(targetSelect().value).toBe('')
    fireEvent.change(targetSelect(), { target: { value: 'M1' } })
    fireEvent.change(within(screen.getByRole('dialog')).getByPlaceholderText('数量'), { target: { value: '2' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '提交' }))

    await waitFor(() => expect(createInventoryCoreDoc).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(createInventoryCoreDoc).mock.calls[0][0]
    expect(payload.docType).toBe('院产品报损')
    expect(payload.items[0].lotId).toBeNull()
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
  it('恰好是 SOURCE_LOT × 通用类型的这 5 项（#350 院顾客产品出库只走提货）', () => {
    const intersection = INVENTORY_GENERIC_DOC_TYPES.filter((t) => SOURCE_LOT_DOC_TYPES.has(t))
    expect(intersection).toEqual([
      '分院调货出库',
      '市场间调货出库',
      '内部领用',
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

// ── #200 S6：建单表单按单据类型收窄库存主体端点 ──────────────────────────
//
// 服务端（engine.ts `createInventoryCoreDoc` 里的端点校验段）从「静默吃掉多余端点」改成了
// 「多给一个端点就拒单」（AC5）、「同主体两端不一致就拒单」（AC4）。表单不跟着收窄的话，
// 用户在界面上点得出来的组合会直接撞服务端报错，而报错文案说的是他看不懂的端点术语。
//
// ⚠️ 收窄方式刻意**不删 `<select>` 节点、也不禁用任何合法端点**：
// tests/e2e-inventory-ui/_helpers/ui.ts 按 `selects.nth(n)` 定位弹窗里的下拉，
// 删节点会整体位移（打挂 inv-02 / inv-05 / inv-06 / inv-90），
// 禁用同主体类型的 target 会打挂 inv-02（直接对「市场产品盘溢」选 nth(2)）
// 与 inv-06（createGenericDoc 同时传两端）。

function openCreateDialog(allowed: InventoryDocType[]) {
  render(
    <InventoryDocsPage
      {...baseProps}
      locations={locations}
      allowedCreateDocTypes={allowed}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '新建' }))
}

const createdDoc = { success: true, id: 'MPY-260921-0001' }

function fillLineAndSubmit(quantity: string) {
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByPlaceholderText('数量'), { target: { value: quantity } })
  fireEvent.click(dialog.getByRole('button', { name: '提交' }))
}

const lastCreatePayload = () => vi.mocked(createInventoryCoreDoc).mock.calls[0][0]

describe('建单表单按单据类型收窄库存主体端点（#200 S6）', () => {
  it('同主体类型：选了出库主体，入库主体镜像同值', () => {
    // 「市场产品报损」属 INTERNAL_SAME_NODE_DOC_TYPES：两端必须是同一个主体，
    // 否则服务端 createInventoryCoreDoc 的端点校验段直接拒单（AC4）。
    openCreateDialog(['市场产品报损'])
    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    expect(targetSelect().value).toBe('M1')
  })

  it('同主体类型：反过来先点入库主体，出库主体同样镜像', () => {
    // 这一侧才是 inv-02 的真实路径（它对「市场产品盘溢」直接操作 nth(2)）：
    // 只做 source→target 单向镜像的话，两端仍会一空一满。
    openCreateDialog(['市场产品盘溢'])
    fireEvent.change(targetSelect(), { target: { value: 'M2' } })
    expect(sourceSelect().value).toBe('M2')
  })

  it('两端独立的调货出库不镜像，两个下拉都可用', () => {
    // 「分院调货出库」属 RECEIVE_REQUIRED：source 出货、target 收货，本就是两个主体。
    // 误当成同主体去镜像，就会把用户选的收货方悄悄改成发货方。
    openCreateDialog(['分院调货出库'])
    expect(sourceSelect()).toBeEnabled()
    expect(targetSelect()).toBeEnabled()

    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    expect(targetSelect().value).toBe('')
  })

  it('只进不出的「院顾客退货」禁用出库主体，入库主体照常可选', () => {
    openCreateDialog(['院顾客退货'])
    expect(sourceSelect()).toBeDisabled()
    expect(targetSelect()).toBeEnabled()
  })

  it('#350 后通用类型里没有「只出不进」的单边类型：院顾客产品出库已移出白名单', () => {
    // 它曾是唯一的 source-only 通用类型；顾客出库改由提货服务产生后，端点口径表里不应再有 source-only
    expect(INVENTORY_GENERIC_DOC_TYPES).not.toContain('院顾客产品出库')
    for (const docType of INVENTORY_GENERIC_DOC_TYPES) {
      expect(genericDocEndpointMode(docType), docType).not.toBe('source-only')
    }
  })

  it('换单据类型会清空两端主体', () => {
    // 不清的话：先在「院产品报损」填了出库主体，再切「院顾客退货」，
    // 用户看着一个禁用且空的出库主体，却收到服务端的「只能指定入库主体」。
    openCreateDialog(['院产品报损', '院顾客退货'])
    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    expect(sourceSelect().value).toBe('M1')

    fireEvent.change(docTypeSelect('院产品报损'), { target: { value: '院顾客退货' } })
    expect(sourceSelect().value).toBe('')
    expect(targetSelect().value).toBe('')
  })

  it('换单据类型会清掉各行已选批次，不让它漏进下一个类型的 payload', async () => {
    /*
     * 「市场产品报损」要选来源批次、「院顾客退货」不要 —— 切过去以后批次下拉整个消失，
     * 但 `item.lotId` 还在 state 里。此时 target-only 的入库主体 onChange **不**清批次
     * （只有 same-node 的那一支才清），于是上一个类型选的 lotId 一路混进 payload，
     * 变成一张「带来源批次的退货单」。只清主体挡不住这条路径。
     */
    vi.mocked(listInventoryLotOptions).mockResolvedValue([lot(77, 'SKU-1', 'B-777', 30)])
    vi.mocked(createInventoryCoreDoc).mockResolvedValue(createdDoc as never)
    openCreateDialog(['市场产品报损', '院顾客退货'])

    fireEvent.change(sourceSelect(), { target: { value: 'M1' } })
    fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
    await waitFor(() => expect(lotSelect()).not.toBeDisabled())
    fireEvent.change(lotSelect(), { target: { value: '77' } })
    expect(lotSelect().value).toBe('77')

    fireEvent.change(docTypeSelect('市场产品报损'), { target: { value: '院顾客退货' } })
    expect(screen.queryByLabelText('明细 1 来源批次')).toBeNull()

    // 刻意**不**重选 SKU —— 换 SKU 的 onChange 自己会清 lotId，重选一次就把这条路径盖住了
    expect(skuSelect().value).toBe('SKU-1')
    fireEvent.change(targetSelect(), { target: { value: 'M2' } })
    fillLineAndSubmit('2')

    await waitFor(() => expect(createInventoryCoreDoc).toHaveBeenCalledTimes(1))
    expect(lastCreatePayload().items[0].lotId).toBeNull()
  })

  /*
   * ⚠️ 下面两条钉的是**对外契约**（只有合法端点进得了 payload），不是 submit() 里那两个
   * `mode === 'x-only' ? null` 三元 —— 有 `disabled` 挡着，非法端点今天根本填不进 state，
   * 把三元删掉这两条照样绿。三元是第二道闸：将来谁把 `disabled` 拆了（或 InventorySubjectSelect
   * 改成 disabled 也自动选中），它才是最后拦住「多送一个端点直接被服务端拒单」的那一道。
   */
  it('payload：target-only 类型把出库主体送 null', async () => {
    vi.mocked(createInventoryCoreDoc).mockResolvedValue(createdDoc as never)
    openCreateDialog(['院顾客退货'])

    fireEvent.change(targetSelect(), { target: { value: 'M2' } })
    fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
    fillLineAndSubmit('2')

    await waitFor(() => expect(createInventoryCoreDoc).toHaveBeenCalledTimes(1))
    expect(lastCreatePayload().sourceOrgNodeId).toBeNull()
    expect(lastCreatePayload().targetOrgNodeId).toBe('M2')
  })

  // #350：原「payload：source-only 类型把入库主体送 null」已删 —— 唯一的 source-only 通用类型
  // （院顾客产品出库）移出白名单，通用入口已无此类型可测；submit() 里的 source-only 三元保留，
  // 与服务端按 locationRole 推导的单边规则同构，将来新增 source-only 类型时仍生效。

  it('payload：同主体类型两端送同一个主体，不再让服务端靠 source ?? target 猜', async () => {
    vi.mocked(createInventoryCoreDoc).mockResolvedValue(createdDoc as never)
    openCreateDialog(['市场产品盘溢'])

    // 只点了入库主体这一端 —— 改前 payload 会是 (null, M2)，服务端靠 `source ?? target` 兜底；
    // 改后服务端对两端不一致是拒单，所以镜像必须发生在表单里。
    fireEvent.change(targetSelect(), { target: { value: 'M2' } })
    fireEvent.change(skuSelect(), { target: { value: 'SKU-1' } })
    fillLineAndSubmit('10')

    await waitFor(() => expect(createInventoryCoreDoc).toHaveBeenCalledTimes(1))
    expect(lastCreatePayload().sourceOrgNodeId).toBe('M2')
    expect(lastCreatePayload().targetOrgNodeId).toBe('M2')
  })
})

// 前端的 genericDocEndpointMode 与服务端 engine.ts 的建单端点口径是两份真相
// （engine.ts 第 2 行是 `import 'server-only'`，前端不能直接 import），所以照搬同目录
// SOURCE_LOT_DOC_TYPES 那条守护的做法：直接读 engine.ts 的源码字面量，逐项比对。
//
// 服务端那份口径**没有单独的函数**，是 createInventoryCoreDoc 里的一段内联规则：
//   1) INTERNAL_SAME_NODE_DOC_TYPES —— 两端都给且不一致就拒，否则归一成同一个主体
//   2) RECEIVE_REQUIRED_DOC_TYPES —— 两端都要（并豁免下面的单边规则）
//   3) 其余且 `movementPlan(docType, defaultStatusForDoc(docType))` 非空 ——
//      locationRole==='target' 时传了出库主体就拒、==='source' 时传了入库主体就拒
// 所以本守护要同时钉住：四个方向集合的成员、movementPlan / defaultStatusForDoc 的分支顺序，
// 以及建单段里那条单边规则的形状。任何一处动了都会红。
//
// 光把 10 项映射抄成常量断言挡不住真正的漏改：给 OUTBOUND_DOC_TYPES +
// INVENTORY_GENERIC_DOC_TYPES 同时加一个新类型、却漏加前端映射，常量断言照样绿，
// 而表单会按兜底的 'both' 放行入库主体 → 提交必撞服务端「…不接受入库主体」。
describe('前端端点口径与服务端建单规则不漂移（#200 S6-a）', () => {
  const engineSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/engine.ts'), 'utf8')

  /** 与同目录 SOURCE_LOT_DOC_TYPES 守护同一个正则：集合的声明写法一变，这里立刻抛错 */
  function readSet(name: string): Set<string> {
    const block = engineSrc.match(
      new RegExp(`const ${name} = new Set<InventoryDocType>\\(\\[([\\s\\S]*?)\\]\\)`),
    )?.[1]
    expect(block, `engine.ts 里找不到 ${name}`).toBeTruthy()
    const values = [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(values.length, `${name} 读出来是空的`).toBeGreaterThan(0)
    return new Set(values)
  }

  /** 截出函数体：函数内的 `}` 都有缩进，行首的 `}` 只可能是它自己的收尾 */
  function readFnBody(signature: string): string {
    const body = engineSrc.match(
      new RegExp(`${signature.replace(/[(){}[\]]/g, '\\$&')}[\\s\\S]*?\\n}`),
    )?.[0]
    expect(body, `engine.ts 里找不到 ${signature}`).toBeTruthy()
    return body!
  }

  /**
   * 截出 createInventoryCoreDoc 里的「端点校验段」：从两个端点变量落地，
   * 到开始查 location 为止 —— 端点口径整段都在这里，没有别的地方能改它。
   */
  function readCreateEndpointSection(): string {
    const start = engineSrc.indexOf('let sourceOrgNodeId = normalizeText(input.sourceOrgNodeId)')
    expect(start, 'engine.ts 里找不到建单端点校验段的起点').toBeGreaterThan(0)
    const end = engineSrc.indexOf('const sourceLocationRow = sourceOrgNodeId ?', start)
    expect(end, 'engine.ts 里找不到建单端点校验段的终点').toBeGreaterThan(start)
    return engineSrc.slice(start, end)
  }

  const setChecksIn = (body: string) =>
    [...body.matchAll(/([A-Z_]+_DOC_TYPES)\.has\(docType\)/g)].map((m) => m[1])

  it('defaultStatusForDoc 的分支顺序没变（它决定建单那一刻的 status）', () => {
    // status 是 movementPlan 的入参：报损/退货类建单即「待审批」→ plan 为 null → 单边规则整条不生效。
    // 把这条分支挪走（比如让报损单建单即「已完成」），下面 serverMode 的推导就不再成立。
    const body = readFnBody('function defaultStatusForDoc(')
    expect(setChecksIn(body)).toEqual(['APPROVAL_DOC_TYPES', 'RECEIVE_REQUIRED_DOC_TYPES'])
    expect(body).toMatch(/APPROVAL_DOC_TYPES\.has\(docType\)\) return '待审批'/)
    expect(body).toMatch(/RECEIVE_REQUIRED_DOC_TYPES\.has\(docType\)\) return '待收货'/)
    expect(body).toMatch(/return '已完成'/)
  })

  it('movementPlan 的分支顺序与角色映射没变（本守护的推导前提）', () => {
    const body = readFnBody('function movementPlan(')
    // 不落流水的四个状态先短路成 null
    expect(body).toMatch(
      /status === '草稿' \|\| status === '待审批' \|\| status === '已驳回' \|\| status === '已取消'/,
    )
    expect(setChecksIn(body)).toEqual([
      'NO_MOVEMENT_DOC_TYPES',
      'RECEIVE_REQUIRED_DOC_TYPES',
      'INBOUND_DOC_TYPES',
      'OUTBOUND_DOC_TYPES',
    ])
    const roleOf = (setName: string) =>
      body.match(
        new RegExp(`${setName}\\.has\\(docType\\)\\)\\s*return\\s*\\{\\s*locationRole:\\s*'(source|target)'`),
      )?.[1]
    expect(roleOf('RECEIVE_REQUIRED_DOC_TYPES')).toBe('source')
    expect(roleOf('INBOUND_DOC_TYPES')).toBe('target')
    expect(roleOf('OUTBOUND_DOC_TYPES')).toBe('source')
  })

  it('建单段仍是「同主体归一 + 单边拒另一边（两类豁免）」', () => {
    const section = readCreateEndpointSection()

    // 1) 同主体：两端都给且不一致 → 拒；否则归一成同一个（改回无条件 `source ?? target` 立刻红）
    expect(section).toMatch(/INTERNAL_SAME_NODE_DOC_TYPES\.has\(input\.docType\)/)
    expect(section).toMatch(/sourceOrgNodeId && targetOrgNodeId && sourceOrgNodeId !== targetOrgNodeId/)
    expect(section).toMatch(/const orgNodeId = sourceOrgNodeId \?\? targetOrgNodeId/)

    // 2) 待收货单据两端都要
    expect(section).toMatch(/RECEIVE_REQUIRED_DOC_TYPES\.has\(input\.docType\) && !targetOrgNodeId/)

    // 3) 单边规则：挂在 `plan` 非空上，且恰好豁免同主体 / 待收货两类
    expect(section).toMatch(/\bplan\s*\n\s*&& !INTERNAL_SAME_NODE_DOC_TYPES\.has\(input\.docType\)/)
    expect(
      [...section.matchAll(/&& !([A-Z_]+_DOC_TYPES)\.has\(input\.docType\)/g)].map((m) => m[1]),
      '单边规则的豁免集合变了（多一类 = 少收窄一种，少一类 = 会打挂正常调货）',
    ).toEqual(['INTERNAL_SAME_NODE_DOC_TYPES', 'RECEIVE_REQUIRED_DOC_TYPES'])
    expect(section).toMatch(/plan\.locationRole === 'target' && sourceOrgNodeId/)
    expect(section).toMatch(/plan\.locationRole === 'source' && targetOrgNodeId/)
  })

  it('10 种通用类型的端点模式逐项等于服务端口径', () => {
    const sameNode = readSet('INTERNAL_SAME_NODE_DOC_TYPES')
    const receiveRequired = readSet('RECEIVE_REQUIRED_DOC_TYPES')
    const approval = readSet('APPROVAL_DOC_TYPES')
    const inbound = readSet('INBOUND_DOC_TYPES')
    const outbound = readSet('OUTBOUND_DOC_TYPES')
    const noMovement = readSet('NO_MOVEMENT_DOC_TYPES')

    /** 复刻 defaultStatusForDoc */
    function createStatus(docType: string): string {
      if (approval.has(docType)) return '待审批'
      if (receiveRequired.has(docType)) return '待收货'
      return '已完成'
    }

    /** 复刻 movementPlan 在**建单那一刻**的取值 */
    function planRole(docType: string): 'source' | 'target' | null {
      const status = createStatus(docType)
      if (status === '草稿' || status === '待审批' || status === '已驳回' || status === '已取消') {
        return null
      }
      if (noMovement.has(docType)) return null
      if (receiveRequired.has(docType)) return 'source'
      if (inbound.has(docType)) return 'target'
      if (outbound.has(docType)) return 'source'
      return null
    }

    /** 复刻建单段那条内联的端点规则 */
    function serverMode(docType: string): GenericDocEndpointMode {
      if (sameNode.has(docType)) return 'same-node'
      if (receiveRequired.has(docType)) return 'both'
      const role = planRole(docType)
      // plan 为空 = 单边规则整条不生效，服务端两端都收得下
      if (role === null) return 'both'
      return role === 'target' ? 'target-only' : 'source-only'
    }

    /*
     * #200 的残余缺口检查：单边规则挂在 `plan` 非空上，所以「plan 为空又不走同主体归一」
     * 的类型会两端全收 —— 用户就能传一个自己有权的无关主体去过 assertOrgNodeVisible。
     * 今天 10 种通用类型里 plan 为空的只有报损两种，而它们先被 INTERNAL_SAME_NODE 归一拦住，
     * 所以没有缺口。将来谁往 APPROVAL / NO_MOVEMENT 加一个非同主体的通用类型，这条先红。
     */
    expect(
      INVENTORY_GENERIC_DOC_TYPES.filter((t) => !sameNode.has(t) && planRole(t) === null),
      '出现了 plan 为空又不归一同主体的通用类型：服务端单边规则对它整条失效',
    ).toEqual([])

    for (const docType of INVENTORY_GENERIC_DOC_TYPES) {
      expect(genericDocEndpointMode(docType), `${docType} 的端点口径漂移了`).toBe(serverMode(docType))
    }
  })
})

// ── #134：原生 alert / prompt 换成页内组件 ────────────────────────────────
// 原实现用 prompt('驳回原因') 收集备注：不可样式化、阻塞 JS、**且无法做必填校验**
// （prompt 取消或留空都得到 ''，代码 `|| ''` 直接放过，空驳回原因就这么提交了）。

// targetOrgNodeId 必须非空：收货按钮按行判定，target 为空的单不给按钮（#340）
const receivableRow: InventoryDocRow = { ...row, id: 'DTO-260813-0002', docType: '内部领用', status: '待收货', targetOrgNodeId: 'M2' }

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

    // 行内红字故意不带 role="alert"：同文案的 toast 已经在 live region 里播报过一次。
    // 局限：sonner 在这里是 mock（没有真实 DOM），所以「toast 确实播报了」这个前提
    // 单测验不到；这条断言只证明「行内红字没再挂一个 alert」。
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

  // ⚠️ 这条（以及下面两条）真正钉住的是 `anyDialogOpen`（`pendingAction !== null || open`），
  // 不是 `submitting` 专属的 `actionDialogBusy` / `createDialogBusy` —— 把后两个整个删掉，
  // 这些用例照样全绿（组件注释里也这么写了）。那两个是「拆掉不许并存约束」时的第二道闸，
  // 有意保留、有意无独立断言。
  it('降级路径下弹窗开着（含提交在途）时，背景的行操作按钮被锁住', async () => {
    forceNonModalFallback()
    const gate = deferred<void>()
    vi.mocked(rejectInventoryCoreDoc).mockReturnValue(gate.promise as never)
    const rowB: InventoryDocRow = { ...row, id: 'MBS-260813-0009' }
    renderDocs([row, rowB])

    fireEvent.click(screen.getAllByRole('button', { name: '驳回' })[0])
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    // 背景里 B 单的「通过」点了必须没反应，否则 A 的「处理中」界面会被顶掉，用户以为 A 取消了。
    // 断言的是**行为**不是 disabled 属性 —— 开窗入口刻意不用 disabled（见组件注释：
    // 那样会让 showModal 记不到可聚焦的触发元素，关闭后焦点回不去）。
    fireEvent.click(screen.getAllByRole('button', { name: '通过' })[1])
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(actionDialog()).getByText('驳回单据')).toBeInTheDocument()
    // 「详情」是链接，光给按钮加 disabled 拦不住导航 —— 这时整个换成禁用按钮
    for (const btn of screen.getAllByRole('button', { name: '详情' })) expect(btn).toBeDisabled()
    expect(screen.queryByRole('link', { name: '详情' })).not.toBeInTheDocument()

    await act(async () => { gate.resolve(); await gate.promise })
    // 解锁那条腿也要钉住：在途结束后入口必须恢复，否则页面就永久锁死了
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '新建' })).toBeEnabled()
    for (const btn of screen.getAllByRole('button', { name: '通过' })) expect(btn).toBeEnabled()
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

  it.each([
    // 业务层抛的 ApiError：digest 是带冒号的完整 message，剥前缀后原样透出
    ['PERMISSION_DENIED: 无权审批该单据', 'ApiError 形态', '无权审批该单据'],
    // HOF 层 requireAnyPermission 抛的 PermissionError：digest 是**裸前缀**，无冒号无文案。
    // 这才是「权限被收回」最直接的那条路径；交给 actionErrorMessage 会原样吐英文 token，
    // 所以这里要给统一说法。
    ['PERMISSION_DENIED', 'PermissionError 裸前缀形态', '单据状态或权限已变化，已为你刷新列表'],
  ])('权限被收回也给出路：关窗 + 刷新（%s / %s）', async (digest, _label, expectedToast) => {
    vi.mocked(approveInventoryCoreDoc).mockRejectedValue(
      Object.assign(new Error('sanitized'), { digest }),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    // 文案必须断死：只断言「调过 toast」的话，裸前缀形态下显示什么完全放空 ——
    // 而那正好是会把英文 PERMISSION_DENIED 甩给用户的那条路径
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expectedToast))
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

  it('降级路径下同时只能开一个弹窗：弹窗开着时所有开窗入口都锁住', () => {
    // 共用一个布尔 busy 的话，先结束的请求会把另一个仍在途的锁提前解开；
    // 而两个非模态弹窗叠开又会让焦点与输入归属混乱。所以从状态上就禁止并存。
    const { show } = forceNonModalFallback()
    const rowB: InventoryDocRow = { ...row, id: 'MBS-260813-0009' }
    renderDocs([row, rowB])

    fireEvent.click(screen.getAllByRole('button', { name: '驳回' })[0])
    expect(show).toHaveBeenCalled()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    // 点了没反应，而且始终只有一个 dialog
    fireEvent.click(screen.getAllByRole('button', { name: '通过' })[1])
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(actionDialog()).getByText('驳回单据')).toBeInTheDocument()

    // 关掉之后入口恢复
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(within(actionDialog()).getByText('新建库存单据')).toBeInTheDocument()
  })

  it('建单弹窗开着时，行操作入口同样锁住', () => {
    forceNonModalFallback()
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(actionDialog()).getByText('新建库存单据')).toBeInTheDocument()
    for (const btn of screen.getAllByRole('button', { name: '详情' })) expect(btn).toBeDisabled()
  })

  it('建单弹窗开着时权限被收回：弹窗不消失、输入还在、关掉后页面自行解锁', () => {
    // `{canCreate && <CreateDocDialog/>}` 在 canCreate 翻 false 时会把正开着的弹窗整个卸载：
    // 用户填的表单没了，而父组件的 `open` 仍是 true → 所有入口被点击闸锁死，只能整页重载。
    const { rerender } = render(
      <InventoryDocsPage {...baseProps} allowedCreateDocTypes={['市场产品报损']} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const remark = within(actionDialog()).getByPlaceholderText('备注')
    fireEvent.change(remark, { target: { value: '填了一半' } })

    rerender(
      <InventoryDocsPage {...baseProps} canCreate={false} allowedCreateDocTypes={['市场产品报损']} />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(actionDialog()).getByPlaceholderText('备注')).toHaveValue('填了一半')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // 解锁：行操作入口恢复可用（点得开动作弹窗）
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(within(actionDialog()).getByText('驳回单据')).toBeInTheDocument()
  })

  it('开窗入口不能用 disabled —— 那会让原生 dialog 记不到可聚焦的触发元素', () => {
    // codex 第 8 轮抓到的回归：点「驳回」那一刻按钮就变 disabled，而 showModal() 在随后的
    // layout effect 里才记录「打开前的焦点」，记到的已经不是可聚焦元素，关闭后焦点回不去。
    renderDocs()
    const opener = screen.getByRole('button', { name: '驳回' })
    fireEvent.click(opener)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(opener).toBeEnabled()
  })
})

describe('建单失败的提示（#134）', () => {
  it('可读的业务 digest：剥前缀后原样透出，且不再弹原生 alert', async () => {
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

  // 上一条同时给了可读 digest 与脱敏 message，走的其实只是「digest 优先」那一支 ——
  // 真正的兜底路径（Next 自动生成的数字编号 / 裸前缀）得单独造。
  it.each([
    ['1738462912', '创建单据失败', 'Next 自动生成的数字编号'],
    ['1956068727@E263', '创建单据失败', '带错误码后缀的数字编号'],
    ['PERMISSION_DENIED', '单据状态或权限已变化，已为你刷新列表', '权限被收回（裸前缀）'],
  ])('不可读的信号（%s / %s）不能端给用户', async (digest, expected) => {
    vi.mocked(createInventoryCoreDoc).mockRejectedValue(
      Object.assign(
        new Error(
          'An error occurred in the Server Components render. The specific message is omitted in production builds.',
        ),
        { digest },
      ),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected))
    // 建单弹窗**不关**：表单里是用户敲进去的内容，关掉就全没了
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('状态/权限已变化时刷新列表（但不关建单弹窗）', async () => {
    vi.mocked(createInventoryCoreDoc).mockRejectedValue(
      Object.assign(new Error('sanitized'), { digest: 'CONFLICT: 单据号已被占用' }),
    )
    renderDocs()
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('单据号已被占用'))
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('「收货」按钮按行判定：只给能收这张单 target 的账号（#340 评审 P1）', () => {
  /** M1 → M2 的市场间调货，待收货 */
  const mto: InventoryDocRow = {
    ...row,
    id: 'MTO-260924-0001',
    docType: '市场间调货出库',
    status: '待收货',
    sourceOrgNodeId: 'M1',
    targetOrgNodeId: 'M2',
    targetOrgNodeName: '九江市场',
    targetOrgNodeType: '市场',
  }

  function renderWithReceivable(ids: readonly string[] | null) {
    render(
      <InventoryDocsPage
        {...baseProps}
        rows={[mto]}
        receivableTargetOrgNodeIds={ids}
        allowedCreateDocTypes={['市场产品报损']}
      />,
    )
  }

  it('调出市场（scope 只有 M1）看得到这张单，但没有「收货」按钮', () => {
    renderWithReceivable(['M1', 'N-S1'])
    expect(screen.getByText('MTO-260924-0001')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '收货' })).toBeNull()
  })

  it('调入市场（scope 含 M2）有「收货」按钮', () => {
    renderWithReceivable(['M2'])
    expect(screen.getByRole('button', { name: '收货' })).toBeTruthy()
  })

  it('不受限（超管，null）有「收货」按钮', () => {
    renderWithReceivable(null)
    expect(screen.getByRole('button', { name: '收货' })).toBeTruthy()
  })

  it.each([['受限', ['M2']], ['超管（null）', null]] as const)(
    'target 为空的单不给按钮（服务端必拒「缺少收货主体」）：%s',
    (_label, ids) => {
      render(
        <InventoryDocsPage
          {...baseProps}
          rows={[{ ...mto, targetOrgNodeId: null }]}
          receivableTargetOrgNodeIds={ids}
          allowedCreateDocTypes={['市场产品报损']}
        />,
      )
      expect(screen.queryByRole('button', { name: '收货' })).toBeNull()
    },
  )
})

describe('单据列表「关联销售单」列（#350）', () => {
  const gckRow: InventoryDocRow = {
    ...row,
    id: 'GCK-20260924-0001',
    docType: '院顾客产品出库',
    status: '已完成',
    relatedSaleOrderId: 'FY-XSD-WX-2609240001',
  }

  it('有订单查看权限：显示为指向订单详情的链接', () => {
    render(<InventoryDocsPage {...baseProps} rows={[gckRow]} canOpenOrderDetail />)
    const link = screen.getByRole('link', { name: 'FY-XSD-WX-2609240001' })
    expect(link.getAttribute('href')).toBe('/orders/FY-XSD-WX-2609240001')
  })

  it('缺省（未传 / 无权限）只显示单号文本，fail-closed', () => {
    render(<InventoryDocsPage {...baseProps} rows={[gckRow]} />)
    expect(screen.getByText('FY-XSD-WX-2609240001')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'FY-XSD-WX-2609240001' })).toBeNull()
  })

  it('没有关联销售单的单据显示占位符', () => {
    render(<InventoryDocsPage {...baseProps} rows={[{ ...row, relatedSaleOrderId: null }]} canOpenOrderDetail />)
    expect(screen.getByRole('columnheader', { name: '关联销售单' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /FY-XSD/ })).toBeNull()
  })
})
