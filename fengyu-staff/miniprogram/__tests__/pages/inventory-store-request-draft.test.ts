/**
 * staff 小程序门店报货草稿（#348 · 348a）：表单存草稿 / 继续编辑 / 提交，详情页继续编辑 / 删除草稿。
 * Page 运行时跑不起来，捕获 Page(definition) 后用最小 setData 模拟页面实例（同 inventory-stocktake.test.ts）。
 */
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({ callStaffApi: vi.fn() }))
vi.mock('../../utils/role', () => ({
  canAccessInventory: () => true,
  canOperateStoreInventory: () => true,
  getCurrentStoreId: () => 'store-001',
  requireInventoryStoreOperate: () => true,
}))

const mockedCall = vi.mocked(callStaffApi)
const pages: Record<string, Record<string, any>> = {}
let originalPage: unknown
let originalGetApp: unknown
let originalWx: Record<string, unknown>

async function capture(name: string, modulePath: string) {
  ;(globalThis as any).Page = (definition: Record<string, any>) => { pages[name] = definition }
  await import(modulePath)
}

beforeAll(async () => {
  originalPage = (globalThis as any).Page
  originalGetApp = (globalThis as any).getApp
  originalWx = { ...(globalThis as any).wx }
  ;(globalThis as any).getApp = () => ({
    globalData: { scopedStores: [{ storeId: 'store-001', storeName: '测试门店' }], boundStoreName: '' },
  })
  await capture('form', '../../packageMy/inventory/form')
  await capture('detail', '../../packageMy/inventory/detail')
})

afterAll(() => {
  ;(globalThis as any).Page = originalPage
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).wx = originalWx
})

beforeEach(() => {
  mockedCall.mockReset()
  Object.assign((globalThis as any).wx, {
    showToast: vi.fn(),
    setNavigationBarTitle: vi.fn(),
    navigateTo: vi.fn(),
    navigateBack: vi.fn(),
    redirectTo: vi.fn(),
    showModal: vi.fn(),
  })
})

function instance(name: string) {
  const def = pages[name]
  const page: Record<string, any> = {
    ...def,
    data: JSON.parse(JSON.stringify(def.data)),
    setData(patch: Record<string, any>) { page.data = { ...page.data, ...patch } },
  }
  return page
}

const draftDetail = {
  id: 'DBH-260926-0001', docType: '门店报货', status: '草稿', remark: '先存着',
  sourceLocationId: 'store-001', updatedAt: '2026-09-26T01:02:03.456Z',
  items: [{ skuId: 'sku-1', skuName: '产品1', specName: '50ml', quantity: 3, remark: '急用' }],
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('门店报货表单的草稿', () => {
  test('门店报货才显示「存草稿」；盘点等其它业务不支持', () => {
    const report = instance('form')
    report.onLoad({ docType: encodeURIComponent('门店报货') })
    expect(report.data.canDraft).toBe(true)
    const stocktake = instance('form')
    stocktake.onLoad({ docType: encodeURIComponent('分院库存盘点') })
    expect(stocktake.data.canDraft).toBe(false)
  })

  test('新建时存草稿走 createDoc(draft: true)，存完留在本页并记住草稿单号；再存走 updateDraft', async () => {
    const page = instance('form')
    page.onLoad({ docType: encodeURIComponent('门店报货') })
    page.setData({ items: [{ key: 'sku-1', skuId: 'sku-1', skuName: '产品1', specName: null, batchNo: '', quantity: 2, stockReference: 0, reason: '' }] })
    mockedCall.mockResolvedValueOnce({ id: 'DBH-NEW', draft: true })
    await page.submitDoc(true)
    expect(mockedCall).toHaveBeenCalledWith('inventory.createDoc', expect.objectContaining({ docType: '门店报货', draft: true, storeId: 'store-001' }))
    expect(page.data).toMatchObject({ draftId: 'DBH-NEW', submitting: false })
    expect((globalThis as any).wx.redirectTo).not.toHaveBeenCalled()

    mockedCall.mockResolvedValueOnce({ id: 'DBH-NEW', draft: true })
    await page.submitDoc(true)
    expect(mockedCall).toHaveBeenLastCalledWith('inventory.updateDraft', expect.objectContaining({ draftId: 'DBH-NEW' }))
    expect(mockedCall.mock.calls.at(-1)![1]).not.toHaveProperty('draft', true)
  })

  test('继续编辑：按 id 回填明细与备注；提交走 submitDraft 并跳详情', async () => {
    vi.useFakeTimers()
    try {
      const page = instance('form')
      mockedCall.mockImplementation(async (action: string) => (action === 'inventory.docDetail' ? draftDetail : { id: draftDetail.id }) as never)
      page.onLoad({ docType: encodeURIComponent('门店报货'), id: draftDetail.id })
      await vi.runAllTicks()
      await Promise.resolve()
      await Promise.resolve()
      expect(mockedCall).toHaveBeenCalledWith('inventory.docDetail', { id: draftDetail.id })
      expect(page.data).toMatchObject({ draftId: draftDetail.id, remark: '先存着' })
      expect(page.data.items).toEqual([expect.objectContaining({ skuId: 'sku-1', quantity: 3 })])

      await page.submitDoc(false)
      expect(mockedCall).toHaveBeenLastCalledWith('inventory.submitDraft', expect.objectContaining({
        draftId: draftDetail.id,
        docType: '门店报货',
        // 乐观锁：回传打开草稿时的版本；行备注（admin 代建的）原样带回
        expectedUpdatedAt: draftDetail.updatedAt,
        items: [expect.objectContaining({ skuId: 'sku-1', quantity: 3, remark: '急用' })],
      }))
      vi.advanceTimersByTime(800)
      expect((globalThis as any).wx.redirectTo).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining(draftDetail.id) }))
    } finally {
      vi.useRealTimers()
    }
  })

  test('别的门店的草稿：提示切换门店并返回，不回填', async () => {
    const page = instance('form')
    page.setData({ sourceStoreId: 'store-001' })
    mockedCall.mockResolvedValueOnce({ ...draftDetail, sourceLocationId: 'store-002' } as never)
    await page.loadDraft(draftDetail.id)
    expect(page.data.draftId).toBe('')
    expect(((globalThis as any).wx.showToast as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.title).toMatch(/其它门店/)
  })

  test('草稿加载失败：返回上一页，不停在空表单（否则提交会另建一张单）', async () => {
    vi.useFakeTimers()
    try {
      const page = instance('form')
      mockedCall.mockRejectedValueOnce(new Error('网络异常'))
      await page.loadDraft(draftDetail.id)
      vi.advanceTimersByTime(1500)
      expect((globalThis as any).wx.navigateBack).toHaveBeenCalled()
      expect(page.data.draftId).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  test('回填到的已不是草稿（别处已提交 / 删除）：提示并返回，不回填', async () => {
    const page = instance('form')
    mockedCall.mockImplementation(async (action: string) => (action === 'inventory.docDetail' ? { ...draftDetail, status: '已完成' } : {}) as never)
    await page.loadDraft(draftDetail.id)
    expect(page.data.draftId).toBe('')
    expect(page.data.items).toHaveLength(0)
  })
})

describe('门店报货详情的草稿动作', () => {
  test('草稿显示继续编辑 / 删除；已完成不显示', async () => {
    const page = instance('detail')
    page.setData({ id: draftDetail.id })
    mockedCall.mockResolvedValueOnce({ ...draftDetail, lineage: [] })
    await page.load()
    expect(page.data.canEditDraft).toBe(true)
    page.onEditDraftTap()
    expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith({
      url: `/packageMy/inventory/form?docType=${encodeURIComponent('门店报货')}&id=${encodeURIComponent(draftDetail.id)}`,
    })

    mockedCall.mockResolvedValueOnce({ ...draftDetail, status: '已完成', lineage: [] })
    await page.load()
    expect(page.data.canEditDraft).toBe(false)

    // 别的门店的草稿：不给入口（云端按当前门店核对，点进去必报错）
    mockedCall.mockResolvedValueOnce({ ...draftDetail, sourceLocationId: 'store-002', lineage: [] })
    await page.load()
    expect(page.data.canEditDraft).toBe(false)
  })

  test('删除草稿先确认，确认后调 deleteDraft 并刷新', async () => {
    const page = instance('detail')
    page.setData({ id: draftDetail.id })
    mockedCall.mockResolvedValueOnce({ ...draftDetail, lineage: [] })
    await page.load()
    ;(globalThis as any).wx.showModal.mockImplementation((options: any) => options.success({ confirm: true }))
    mockedCall.mockResolvedValueOnce({ id: draftDetail.id })
    mockedCall.mockResolvedValueOnce({ ...draftDetail, status: '已取消', lineage: [] })
    page.onDeleteDraftTap()
    await flush()
    await flush()
    expect(mockedCall).toHaveBeenCalledWith('inventory.deleteDraft', { id: draftDetail.id })
    expect(page.data.canEditDraft).toBe(false)
  })
})
