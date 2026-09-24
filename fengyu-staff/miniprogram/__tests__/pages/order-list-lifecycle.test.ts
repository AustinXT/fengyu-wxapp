import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

vi.mock('../../utils/role', () => ({
  isManager: () => true,
}))

const testApp = { globalData: { staffWfId: 'staff-1' } }
let pageDefinition: Record<string, any>
let originalGetApp: unknown
let originalPage: unknown

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => testApp
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinition = definition
  }
  await import('../../packageOrder/order-list/order-list')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(callStaffApi).mockResolvedValue({
    orders: [],
    page: 1,
    pageSize: 20,
  })
  ;(globalThis as any).wx.showToast = vi.fn()
})

function createPage() {
  const page: Record<string, any> = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(update: Record<string, unknown>) {
      Object.assign(this.data, update)
    },
  }
  return page
}

describe('订单列表生命周期加载', () => {
  test('首次进入时 onLoad 和紧随的 onShow 合计只请求一次', async () => {
    const page = createPage()

    page.onLoad({})
    page.onShow()

    expect(callStaffApi).toHaveBeenCalledTimes(1)
    expect(callStaffApi).toHaveBeenCalledWith('order.list', {
      status: undefined,
      keyword: undefined,
      startDate: undefined,
      endDate: undefined,
      page: 1,
      pageSize: 20,
    })
    await vi.waitFor(() => expect(page.data.loading).toBe(false))
  })

  test('首次 onShow 跳过后，后续 onShow 仍会刷新列表', async () => {
    const page = createPage()

    page.onLoad({})
    page.onShow()
    await vi.waitFor(() => expect(page.data.loading).toBe(false))

    page.onShow()

    expect(callStaffApi).toHaveBeenCalledTimes(2)
  })
})
