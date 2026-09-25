/**
 * staff 小程序门店盘点入口（#352）：表单 / 列表 / 详情 / 首页入口的页面逻辑。
 *
 * Page 运行时跑不起来，这里把 Page(definition) 捕获下来，用一个最小 setData 模拟页面实例。
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
  await capture('list', '../../packageMy/inventory/list')
  await capture('home', '../../packageMy/inventory/inventory')
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

function instance(name: string, data: Record<string, any> = {}) {
  const def = pages[name]
  const page: Record<string, any> = {
    ...def,
    data: { ...JSON.parse(JSON.stringify(def.data)), ...data },
    setData(patch: Record<string, any>) { page.data = { ...page.data, ...patch } },
  }
  return page
}

const toastTitle = () => ((globalThis as any).wx.showToast as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.title

function sku(skuId: string) {
  return {
    skuId, productCode: `P-${skuId}`, skuName: `产品${skuId}`, specName: null, supplier: null,
    productSeries: null, stockReference: 0, inStock: true, displayName: `产品${skuId}`,
  }
}

function stocktakeForm() {
  const page = instance('form')
  page.onLoad({ docType: encodeURIComponent('分院库存盘点') })
  return page
}

describe('门店盘点表单', () => {
  test('入口配置：盘点模式、不预拉批次、标题「门店盘点」', () => {
    const page = stocktakeForm()
    expect(page.data).toMatchObject({ docType: '分院库存盘点', itemMode: 'stocktakeSku', isStocktake: true, title: '门店盘点' })
    expect(mockedCall).not.toHaveBeenCalledWith('inventory.stockList', expect.anything())
  })

  test('候选走 stocktakeSkuOptions，不走可报货口径', async () => {
    const page = stocktakeForm()
    mockedCall.mockResolvedValueOnce({ items: [{ ...sku('A'), inStock: true }], total: 1 })
    const result = await (page.skuSearch() as any).deps.fetchPage('凝胶', 1)
    expect(mockedCall).toHaveBeenCalledWith('inventory.stocktakeSkuOptions', expect.objectContaining({ locationId: 'store-001', keyword: '凝胶', page: 1 }))
    expect(mockedCall).not.toHaveBeenCalledWith('inventory.reportableSkuOptions', expect.anything())
    expect(result.items[0]).toMatchObject({ skuId: 'A', inStock: true, stockReference: 0 })
  })

  test('实盘留空不能加入，填 0 可以', () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '' })
    page.onAddItem()
    expect(page.data.items).toHaveLength(0)
    expect(toastTitle()).toMatch(/实盘数/)

    page.setData({ quantityInput: '  ' })
    page.onAddItem()
    expect(page.data.items).toHaveLength(0)

    page.setData({ quantityInput: '0' })
    page.onAddItem()
    expect(page.data.items).toEqual([expect.objectContaining({ skuId: 'A', quantity: 0 })])
    expect(page.data.addedSkuIds).toEqual({ A: true })
    expect(page.data.selectedSku).toBeNull()
    expect(page.data.quantityInput).toBe('')
  })

  test('负数 / 三位小数被拒', () => {
    const page = stocktakeForm()
    for (const input of ['-1', '1.234']) {
      page.setData({ selectedSku: sku('A'), quantityInput: input })
      page.onAddItem()
      expect(page.data.items).toHaveLength(0)
    }
  })

  test('同一 SKU：选品时就拦住，绕过选品直接加也拒绝，不合并数量', () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '3' })
    page.onAddItem()

    page.setData({ skuOptions: [sku('A'), sku('B')], showSkuPicker: true })
    page.onSelectSku({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.selectedSku).toBeNull()
    expect(page.data.showSkuPicker).toBe(true)
    expect(toastTitle()).toMatch(/已在盘点明细中/)

    page.setData({ selectedSku: sku('A'), quantityInput: '5' })
    page.onAddItem()
    expect(page.data.items).toEqual([expect.objectContaining({ skuId: 'A', quantity: 3 })])

    page.onSelectSku({ currentTarget: { dataset: { index: 1 } } })
    expect(page.data.selectedSku).toMatchObject({ skuId: 'B' })
  })

  test('删除明细后该 SKU 可重新加入', () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '3' })
    page.onAddItem()
    page.onRemoveItem({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.items).toHaveLength(0)
    expect(page.data.addedSkuIds).toEqual({})
    page.setData({ selectedSku: sku('A'), quantityInput: '4' })
    page.onAddItem()
    expect(page.data.items).toEqual([expect.objectContaining({ skuId: 'A', quantity: 4 })])
  })

  test('提交：docType=分院库存盘点，只传 SKU 与实盘数，不传账面数 / 批次 / 金额', async () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '0' })
    page.onAddItem()
    page.setData({ selectedSku: sku('B'), quantityInput: '2.5' })
    page.onAddItem()
    mockedCall.mockResolvedValueOnce({ id: 'YPD-1' })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await page.onSubmit()
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }
    const redirectArg = ((globalThis as any).wx.redirectTo as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(redirectArg.url).toBe('/packageMy/inventory/detail?id=YPD-1')
    // 跳转失败（页面栈满等）：单已建成，只提示去列表，不复位 submitting（复位会引出重复建单）
    expect(typeof redirectArg.fail).toBe('function')
    redirectArg.fail()
    expect(toastTitle()).toMatch(/已提交.*库存记录/)
    expect(page.data.submitting).toBe(true)
    const [action, payload] = mockedCall.mock.calls.at(-1) as [string, any]
    expect(action).toBe('inventory.createDoc')
    expect(payload).toMatchObject({ docType: '分院库存盘点', storeId: 'store-001' })
    expect(payload.targetOrgNodeId).toBeUndefined()
    expect(payload.items).toEqual([
      { lotId: undefined, skuId: 'A', quantity: 0, reason: undefined },
      { lotId: undefined, skuId: 'B', quantity: 2.5, reason: undefined },
    ])
    expect(JSON.stringify(payload)).not.toMatch(/stockSnapshot|stock_snapshot|price|amount/i)
  })

  test('提交成功后保持 submitting，跳转前不能再提交第二张；失败才复位', async () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '1' })
    page.onAddItem()
    mockedCall.mockResolvedValueOnce({ id: 'YPD-1' })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await page.onSubmit()
      expect(page.data.submitting).toBe(true)
      await page.onSubmit()
      expect(mockedCall.mock.calls.filter(([action]) => action === 'inventory.createDoc')).toHaveLength(1)
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }

    const failed = stocktakeForm()
    failed.setData({ selectedSku: sku('A'), quantityInput: '1' })
    failed.onAddItem()
    mockedCall.mockRejectedValueOnce(new Error('INVALID_PARAMS: x'))
    await failed.onSubmit()
    expect(failed.data.submitting).toBe(false)
  })

  test('选了产品却没加入明细就提交：拦下提示，清除所选后可提交', async () => {
    const page = stocktakeForm()
    page.setData({ selectedSku: sku('A'), quantityInput: '1' })
    page.onAddItem()
    page.setData({ selectedSku: sku('B'), quantityInput: '0' })
    await page.onSubmit()
    expect(mockedCall).not.toHaveBeenCalledWith('inventory.createDoc', expect.anything())
    expect(toastTitle()).toMatch(/未加入/)

    page.onClearSelectedSku()
    expect(page.data).toMatchObject({ selectedSku: null, quantityInput: '' })
    mockedCall.mockRejectedValueOnce(new Error('stop'))
    await page.onSubmit()
    expect(mockedCall).toHaveBeenCalledWith('inventory.createDoc', expect.objectContaining({ docType: '分院库存盘点' }))
  })

  test('门店报货不受影响：仍走可报货候选、数量必须 > 0', async () => {
    const page = instance('form')
    page.onLoad({ docType: encodeURIComponent('门店报货') })
    expect(page.data.isStocktake).toBe(false)
    mockedCall.mockResolvedValueOnce({ items: [], total: 0 })
    await (page.skuSearch() as any).deps.fetchPage('', 1)
    expect(mockedCall).toHaveBeenCalledWith('inventory.reportableSkuOptions', expect.anything())
    page.setData({ selectedSku: sku('A'), quantityInput: '0' })
    page.onAddItem()
    expect(page.data.items).toHaveLength(0)
  })
})

describe('库存首页与列表', () => {
  test('首页有「门店盘点」办理入口与「盘点记录」分类', () => {
    const home = pages.home
    expect(home.data.operations.map((op: any) => op.docType)).toContain('分院库存盘点')
    expect(home.data.categories.map((c: any) => c.key)).toContain('stocktake')
  })

  test('盘点分类只查分院库存盘点，并提供发起入口', async () => {
    const page = instance('list')
    mockedCall.mockImplementation(async (action: string) => (
      action === 'inventory.docOrgOptions' ? { items: [] } : { items: [], total: 0, page: 1, pageSize: 20 }
    ))
    page.onLoad({ docCategory: 'stocktake' })
    await vi.waitFor(() => expect(mockedCall).toHaveBeenCalledWith('inventory.docList', expect.anything()))
    const [, payload] = mockedCall.mock.calls.find(([action]) => action === 'inventory.docList') as [string, any]
    expect(payload.docTypes).toEqual(['分院库存盘点'])
    expect(page.data).toMatchObject({ title: '库存盘点', createDocType: '分院库存盘点' })
  })

  test('列表行预算 isStocktake（WXML 据此显示「实盘合计」，不硬编码类型名）', async () => {
    const page = instance('list')
    mockedCall.mockImplementation(async (action: string) => (
      action === 'inventory.docOrgOptions'
        ? { items: [] }
        : { items: [{ id: 'YPD-1', docType: '分院库存盘点', status: '已完成' }, { id: 'BS-1', docType: '院产品报损', status: '已完成' }], total: 2 }
    ))
    page.onLoad({ docCategory: 'stocktake' })
    await vi.waitFor(() => expect(page.data.items).toHaveLength(2))
    expect(page.data.items.map((row: any) => row.isStocktake)).toEqual([true, false])
  })
})

describe('盘点单详情', () => {
  function detailResponse(items: any[]) {
    return {
      id: 'YPD-1', docType: '分院库存盘点', status: '已完成', sourceOrgNodeId: 'org-1', sourceOrgNodeName: '测试门店',
      targetOrgNodeId: 'org-1', targetOrgNodeName: '测试门店', docDate: '2026-09-25', totalQuantity: 5,
      remark: null, confirmedAt: null, customerName: null, employeeName: null, supplierName: null,
      trackingNo: null, relatedSaleOrderId: null, auditRemark: null, lineage: [], items,
    }
  }

  test('账面 / 实盘 / 差异 + 结论', async () => {
    const page = instance('detail', { id: 'YPD-1' })
    mockedCall.mockResolvedValueOnce(detailResponse([
      { id: 1, skuId: 'A', skuName: 'A', specName: null, batchNo: '', quantity: 4, stockSnapshot: 4 },
      { id: 2, skuId: 'B', skuName: 'B', specName: null, batchNo: '', quantity: 0, stockSnapshot: 3 },
      { id: 3, skuId: 'C', skuName: 'C', specName: null, batchNo: '', quantity: 1, stockSnapshot: 0 },
    ]))
    await page.load()
    expect(page.data.isStocktake).toBe(true)
    expect(page.data.stocktakeSummary).toBe('盘盈 1 项 / 盘亏 1 项 / 相符 1 项')
    expect(page.data.detail.items.map((item: any) => [item.diffText, item.diffKey])).toEqual([
      ['0', 'matched'], ['-3', 'shortage'], ['+1', 'surplus'],
    ])
  })

  test('历史盘点单缺账面：差异显示 —，结论单列「未记账面」，不算成全额盘盈', async () => {
    const page = instance('detail', { id: 'YPD-2' })
    mockedCall.mockResolvedValueOnce(detailResponse([
      { id: 1, skuId: 'A', skuName: 'A', specName: null, batchNo: '', quantity: 4, stockSnapshot: null },
      { id: 2, skuId: 'B', skuName: 'B', specName: null, batchNo: '', quantity: 2 },
    ]))
    await page.load()
    expect(page.data.detail.items.map((item: any) => [item.stockSnapshot, item.diffText])).toEqual([[null, '—'], [null, '—']])
    expect(page.data.stocktakeSummary).toBe('盘盈 0 项 / 盘亏 0 项 / 相符 0 项 / 未记账面 2 项')
  })

  test('非盘点单不派生差异', async () => {
    const page = instance('detail', { id: 'BS-1' })
    mockedCall.mockResolvedValueOnce({
      ...detailResponse([{ id: 1, skuId: 'A', skuName: 'A', specName: null, batchNo: 'B1', quantity: 2, stockSnapshot: 9 }]),
      docType: '院产品报损',
    })
    await page.load()
    expect(page.data.isStocktake).toBe(false)
    expect(page.data.stocktakeSummary).toBe('')
    expect(page.data.detail.items[0].diffText).toBeUndefined()
  })
})

describe('列表同主体单据不显示对端（WXML 静态守护）', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../packageMy/inventory/list.wxml'), 'utf8')

  test('对端只在 target ≠ source 时显示（报损 / 盘点同主体隐藏，调货异主体照常显示）', () => {
    const counterpart = wxml.match(/<text wx:if="\{\{([^"]*)\}\}" class="counterpart">/)
    expect(counterpart, '找不到 counterpart 行').toBeTruthy()
    expect(counterpart![1].replace(/\s+/g, ' ')).toBe(
      '(item.targetOrgNodeName || item.targetOrgNodeId) && item.targetOrgNodeId !== item.sourceOrgNodeId',
    )
  })

  test('合计文案按预算的 item.isStocktake 切换，不硬编码类型名', () => {
    expect(wxml).toContain("{{item.isStocktake ? '实盘合计' : '总数量'}}")
    expect(wxml).not.toContain('分院库存盘点')
  })
})
