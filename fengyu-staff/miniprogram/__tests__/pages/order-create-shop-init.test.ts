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
