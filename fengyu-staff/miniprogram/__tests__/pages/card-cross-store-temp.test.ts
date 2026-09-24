import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

vi.mock('../../utils/role', () => ({
  isManager: () => true,
  getCurrentStoreId: () => 'store-current',
}))

const appState = {
  globalData: {
    boundStoreId: 'store-current',
    boundStoreName: '当前门店',
  },
}
const pageDefinitions: Record<string, Record<string, any>> = {}
let registeringPage = ''
let originalGetApp: unknown
let originalPage: unknown

function createPage(name: string) {
  const definition = pageDefinitions[name]
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
  } as Record<string, any>
  page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    Object.assign(page.data, update)
    callback?.()
  }
  return page
}

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => appState
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinitions[registeringPage] = definition
  }

  registeringPage = 'orderCreate'
  await import('../../pages/order-create/order-create')
  registeringPage = 'cardRecharge'
  await import('../../packageOrder/card-recharge/card-recharge')
  registeringPage = 'cardInflow'
  await import('../../packageOrder/card-inflow/card-inflow')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  const wxMock = (globalThis as any).wx
  wxMock.showModal = vi.fn()
  wxMock.showToast = vi.fn()
  wxMock.navigateTo = vi.fn()
  wxMock.redirectTo = vi.fn()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('开单页进入充值卡', () => {
  test('临时跨店顾客放行并传递完整门店上下文', () => {
    const page = createPage('orderCreate')
    page.data.productKindChoiceIndex = 0
    page.data.customerInfo = {
      id: null,
      clientUserId: 'cu-temp',
      name: '临时跨店顾客',
      phone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      crossStore: true,
      isCrossStoreTemp: true,
    }

    page.onBigCategoryChange({ detail: 3 })

    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith({
      url: expect.stringMatching(
        /card-recharge\?clientUserId=cu-temp.*boundStoreId=store-bound.*storeName=.*isCrossStoreTemp=1/,
      ),
    })
  })

  test('普通外店顾客仍在入口被拒绝', () => {
    const page = createPage('orderCreate')
    page.data.productKindChoiceIndex = 0
    page.data.customerInfo = {
      clientUserId: 'cu-other',
      storeName: '其他门店',
      crossStore: true,
      isCrossStoreTemp: false,
    }

    page.onBigCategoryChange({ detail: 3 })

    expect((globalThis as any).wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: '无法充值' }),
    )
    expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled()
  })
})

describe('充值卡提交', () => {
  test('预填的临时跨店顾客可提交充值', async () => {
    const page = createPage('cardRecharge')
    page.loadConfig = vi.fn()
    page.onLoad({
      clientUserId: 'cu-temp',
      customerName: '临时跨店顾客',
      customerPhone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      isCrossStoreTemp: '1',
    })
    page.data.ctaDisabled = false
    page.data.selectedFaceValue = 500
    page.data.tiers = [{ faceValue: 500, payAmount: 495 }]
    page.data.paymentMethod = '线下'
    vi.mocked(callStaffApi).mockResolvedValueOnce({ saleOrderId: 'FY-XSD-WX-TEST' })

    await page.onSubmit()

    expect(page.data.customerInfo).toMatchObject({
      crossStore: true,
      isCrossStoreTemp: true,
      boundStoreId: 'store-bound',
    })
    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect(callStaffApi).toHaveBeenCalledWith('card.recharge', {
      clientUserId: 'cu-temp',
      faceValue: 500,
      paymentMethod: '线下',
    })
  })

  test('普通外店顾客仍在提交时被拒绝', async () => {
    const page = createPage('cardRecharge')
    page.data.isManager = true
    page.data.ctaDisabled = false
    page.data.customerInfo = {
      clientUserId: 'cu-other',
      storeName: '其他门店',
      crossStore: true,
      isCrossStoreTemp: false,
    }

    await page.onSubmit()

    expect((globalThis as any).wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: '无法充值' }),
    )
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('进入旧系统转入页时继续携带临时跨店标记', () => {
    const page = createPage('cardRecharge')
    page.data.customerInfo = {
      clientUserId: 'cu-temp',
      name: '临时跨店顾客',
      phone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      isCrossStoreTemp: true,
    }

    page.goInflow()

    expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith({
      url: expect.stringMatching(/card-inflow\?clientUserId=cu-temp.*isCrossStoreTemp=1/),
    })
  })

  test('空名顾客进入转入页仍携带完整上下文', () => {
    const page = createPage('cardRecharge')
    page.data.customerInfo = {
      clientUserId: 'cu-temp',
      name: '',
      phone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      isCrossStoreTemp: true,
    }

    page.goInflow()

    expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith({
      url: expect.stringMatching(/card-inflow\?clientUserId=cu-temp.*isCrossStoreTemp=1/),
    })
  })
})

describe('旧系统充值金转入', () => {
  test('预填的临时跨店顾客可确认转入', async () => {
    const page = createPage('cardInflow')
    page.onLoad({
      clientUserId: 'cu-temp',
      customerName: '临时跨店顾客',
      customerPhone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      isCrossStoreTemp: '1',
    })
    page.data.amountInput = '500'
    page.data.amountError = ''
    page.data.ctaDisabled = false
    ;(globalThis as any).wx.showModal.mockImplementation((options: Record<string, any>) => {
      options.success?.({ confirm: true })
    })
    vi.mocked(callStaffApi).mockResolvedValueOnce({ saleOrderId: 'FY-XSD-WX-INFLOW' })

    await page.onSubmit()

    expect(page.data.customerInfo).toMatchObject({
      crossStore: true,
      isCrossStoreTemp: true,
      boundStoreId: 'store-bound',
    })
    expect(callStaffApi).toHaveBeenCalledWith('card.inflow', expect.objectContaining({
      clientUserId: 'cu-temp',
      amount: 500,
      requestId: expect.any(String),
    }))
  })

  test('空名顾客（customerName 为空串）仍预填，isCrossStoreTemp 不丢失', () => {
    const page = createPage('cardInflow')
    page.onLoad({
      clientUserId: 'cu-temp',
      customerName: '',
      customerPhone: '13800000000',
      boundStoreId: 'store-bound',
      storeName: '绑定门店',
      isCrossStoreTemp: '1',
    })

    expect(page.data.customerInfo).toMatchObject({
      clientUserId: 'cu-temp',
      name: '',
      crossStore: true,
      isCrossStoreTemp: true,
      boundStoreId: 'store-bound',
    })
  })

  test('普通外店顾客仍在提交时被拒绝', async () => {
    const page = createPage('cardInflow')
    page.data.isManager = true
    page.data.ctaDisabled = false
    page.data.customerInfo = {
      clientUserId: 'cu-other',
      storeName: '其他门店',
      crossStore: true,
      isCrossStoreTemp: false,
    }

    await page.onSubmit()

    expect((globalThis as any).wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: '无法转入' }),
    )
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})
