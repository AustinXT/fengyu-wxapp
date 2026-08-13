import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

let pageDefinition: Record<string, any>
let originalGetApp: unknown
let originalPage: unknown

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => ({ globalData: {} })
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinition = definition
  }
  await import('../../pages/order-create/order-create')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

describe('开单商品目录刷新', () => {
  test('切换门店后，旧 shopInit 响应不会覆盖新门店目录', async () => {
    const oldRequest = deferred<any>()
    const newRequest = deferred<any>()
    const callStaffApiMock = vi.mocked(callStaffApi)
    callStaffApiMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)

    const page = {
      ...pageDefinition,
      data: {
        ...pageDefinition.data,
        productKindChoice: '普通商品',
        catalogLoading: false,
      },
      _allCategories: [],
      _allGroupedCategories: [],
      _allSkus: [],
      _experienceSkus: [],
      _spuCache: {},
      _catalogGeneration: 0,
      applyKindChoice: vi.fn(),
      resetOrderState: vi.fn(),
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
    }
    const originalShowToast = (globalThis as any).wx.showToast
    ;(globalThis as any).wx.showToast = vi.fn()

    try {
      const oldLoad = page.loadShopInit()
      page.onStoreChanged()

      newRequest.resolve({
        categories: [{ id: 'category-new', name: '新门店分类', productKind: '普通商品' }],
        groupedCategories: [],
        skuList: [{ skuId: 'sku-new' }],
        mallBundleGroups: [{ productId: 'bundle-new' }],
        experienceSkus: [],
      })
      await vi.waitFor(() => {
        expect(page._allCategories).toEqual([{ id: 'category-new', name: '新门店分类', productKind: '普通商品' }])
      })

      oldRequest.resolve({
        categories: [{ id: 'category-old', name: '旧门店分类', productKind: '普通商品' }],
        groupedCategories: [],
        skuList: [{ skuId: 'sku-old' }],
        mallBundleGroups: [{ productId: 'bundle-old' }],
        experienceSkus: [],
      })
      await oldLoad

      expect(page._allCategories).toEqual([{ id: 'category-new', name: '新门店分类', productKind: '普通商品' }])
      expect(page._allSkus).toEqual([{ skuId: 'sku-new' }])
      expect(page.data.bundleSpus).toEqual([{ productId: 'bundle-new' }])
      expect(page.data.catalogLoading).toBe(false)
    } finally {
      ;(globalThis as any).wx.showToast = originalShowToast
    }
  })
})

describe('普通商品跨分类搜索', () => {
  function createSearchPage() {
    return {
      ...pageDefinition,
      data: {
        ...pageDefinition.data,
        productKindChoice: '普通商品',
        productKeyword: '一维',
        activeCategoryId: 'category-current',
        buyerIsMember: false,
        searching: false,
        catalogLoading: false,
        spuList: [],
      },
      _allSkus: [{ skuId: 'sku-current', categoryId: 'category-current' }],
      _spuCache: {
        '普通商品:category-current': [{ spuId: 'sku-current', spuName: '当前分类商品' }],
      },
      _kwTimer: null,
      _productSearchGeneration: 0,
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
    } as any
  }

  test('搜索请求不携带 categoryId，并展示其他二级分类的普通商品', async () => {
    const callStaffApiMock = vi.mocked(callStaffApi)
    callStaffApiMock.mockReset().mockResolvedValueOnce([
      {
        skuId: 'sku-other',
        specName: '一维紧肤护理',
        categoryId: 'category-other',
        categoryName: '绝对招牌',
        productKind: '招牌',
        salesCategory: '',
        price: 680,
        specialPrice: null,
        sessionCount: 1,
        unit: '次',
        productType: '疗程卡',
        serviceFee: 0,
        isShengmei: false,
        isExperience: false,
      },
    ])
    const page = createSearchPage()

    await page.applyProductSearch()

    expect(callStaffApiMock).toHaveBeenCalledWith('product.skuList', {
      keyword: '一维',
      excludeCards: true,
    })
    expect(callStaffApiMock.mock.calls[0][1]).not.toHaveProperty('categoryId')
    expect(page.data.spuList).toHaveLength(1)
    expect(page.data.spuList[0]).toMatchObject({
      spuId: 'sku-other',
      spuName: '一维紧肤护理',
      categoryId: 'category-other',
    })
  })

  test('清空关键词后恢复当前分类，旧搜索响应不能覆盖', async () => {
    const request = deferred<any[]>()
    vi.mocked(callStaffApi).mockReset().mockReturnValueOnce(request.promise)
    const page = createSearchPage()

    const pendingSearch = page.applyProductSearch()
    page.onProductKeywordClear()
    request.resolve([
      {
        skuId: 'sku-stale',
        specName: '一维旧结果',
        categoryId: 'category-other',
        price: 100,
        specialPrice: null,
        isExperience: false,
      },
    ])
    await pendingSearch

    expect(page.data.searching).toBe(false)
    expect(page.data.catalogLoading).toBe(false)
    expect(page.data.spuList).toEqual([{ spuId: 'sku-current', spuName: '当前分类商品' }])
  })
})
