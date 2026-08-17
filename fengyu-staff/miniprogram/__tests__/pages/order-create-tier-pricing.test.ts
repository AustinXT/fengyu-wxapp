import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

let pageDefinition: Record<string, any>
let originalGetApp: unknown
let originalPage: unknown

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

function createCartItem(skuId: string, sessionCount: number, price: number) {
  return {
    spuId: skuId,
    skuId,
    spuName: '年轻态·慕慕霜(轻享套)-ZX',
    specName: '年轻态·慕慕霜(轻享套)-ZX',
    categoryId: 'cat-zx',
    categoryName: '美在东方(自销)',
    price,
    listPrice: price,
    specialPrice: null,
    quantity: 1,
    sessionCount,
    productType: '疗程卡',
    workfineItemId: '',
    priceLine: '',
    couponShare: '0.00',
    saleAmount: '',
    halfPriceSaleAmount: '',
    received: '',
  }
}

describe('开单疗程卡阶梯价', () => {
  test('单卖的 1 次加 2 次按 2 次档计价', () => {
    const cart = [
      createCartItem('sku-zx-1', 1, 580),
      createCartItem('sku-zx-2', 2, 596),
    ]
    const page = {
      ...pageDefinition,
      data: {
        saleOrderType: '销售单',
        buyerIsMember: false,
        couponDiscount: 0,
        cartPopupVisible: false,
      },
      _allSkus: [
        {
          skuId: 'sku-zx-1', specName: '年轻态·慕慕霜(轻享套)-ZX', categoryId: 'cat-zx',
          categoryName: '美在东方(自销)', productKind: '护理项目', salesCategory: '自销自耗',
          price: 580, specialPrice: 398, sessionCount: 1, productType: '疗程卡',
          serviceFee: 0, isShengmei: false,
        },
        {
          skuId: 'sku-zx-2', specName: '年轻态·慕慕霜(轻享套)-ZX', categoryId: 'cat-zx',
          categoryName: '美在东方(自销)', productKind: '护理项目', salesCategory: '自销自耗',
          price: 596, specialPrice: null, sessionCount: 2, productType: '疗程卡',
          serviceFee: 0, isShengmei: false,
        },
      ],
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
      revalidateCoupon: vi.fn(),
      recomputePrepaidAmounts: vi.fn(),
    }

    page.updateCart(cart)

    expect(page.data.cart[0]).toMatchObject({ priceLine: '298.00', saleAmount: '298.00', received: '298.00' })
    expect(page.data.cart[1]).toMatchObject({ priceLine: '596.00', saleAmount: '596.00', received: '596.00' })
    expect(page.data.payableTotal).toBe('894.00')
  })

  test('30 次 8800 套餐购买 2 份，按总次数线性累计为 17600', () => {
    const cart = [createCartItem('sku-zx-30', 30, 8800)]
    cart[0].quantity = 2
    const page = {
      ...pageDefinition,
      data: {
        saleOrderType: '销售单',
        buyerIsMember: false,
        couponDiscount: 0,
        cartPopupVisible: false,
      },
      _allSkus: [
        {
          skuId: 'sku-zx-30', specName: '年轻态·慕慕霜(轻享套)-ZX', categoryId: 'cat-zx',
          categoryName: '美在东方(自销)', productKind: '护理项目', salesCategory: '自销自耗',
          price: 8800, specialPrice: null, sessionCount: 30, productType: '疗程卡',
          serviceFee: 0, isShengmei: false,
        },
      ],
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
      revalidateCoupon: vi.fn(),
      recomputePrepaidAmounts: vi.fn(),
    }

    page.updateCart(cart)

    expect(page.data.cart[0]).toMatchObject({
      priceLine: '17600.00',
      saleAmount: '17600.00',
      received: '17600.00',
    })
    expect(page.data.payableTotal).toBe('17600.00')
  })

  test('转换单优惠券按正补差额封顶，折抵抵平时自动清除', () => {
    const cart = [createCartItem('sku-conversion', 1, 300)]
    const page = {
      ...pageDefinition,
      data: {
        saleOrderType: '转换单',
        buyerIsMember: false,
        selectedCoupon: { couponId: 'coupon-001', name: '满减券', discount: 250 },
        couponDiscount: 0,
        conversionDeductibleSum: 200,
        cartPopupVisible: false,
      },
      _allSkus: [],
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
      revalidateCoupon: vi.fn(),
      recomputePrepaidAmounts: vi.fn(),
    }

    page.updateCart(cart)

    expect(page.data.conversionCouponBaseTotal).toBe(300)
    expect(page.data.conversionCouponEnabled).toBe(true)
    expect(page.data.couponDiscount).toBe(100)
    expect(page.data.cart[0]).toMatchObject({ couponShare: '100.00', saleAmount: '200.00' })

    page.data.conversionDeductibleSum = 300
    page.updateCart(page.data.cart)

    expect(page.data.conversionCouponEnabled).toBe(false)
    expect(page.data.selectedCoupon).toBeNull()
    expect(page.data.couponDiscount).toBe(0)
    expect(page.data.cart[0]).toMatchObject({ couponShare: '0.00', saleAmount: '300.00' })
  })

  test('转换单提交透传所选优惠券', async () => {
    const callStaffApiMock = vi.mocked(callStaffApi)
    callStaffApiMock.mockResolvedValueOnce({
      saleOrderId: 'FY-XSD-WX-2608080001',
      priceDiff: 0,
      prepaidCardCredit: 0,
      prepaidCardAmount: 0,
      status: '已支付',
    })
    const page = {
      ...pageDefinition,
      data: {
        customerInfo: { clientUserId: 'client-001' },
        cart: [createCartItem('sku-conversion', 1, 300)],
        remark: '',
        submitting: false,
        conversionSelectedSaleItemIds: ['sale-item-old-001'],
        conversionPriceDiff: 0,
        conversionPaymentMethod: null,
        conversionPrepaidCardAmount: 0,
        conversionRemaining: 0,
        conversionIsActivity: false,
        preferredStaffWfId: '',
        selectedCoupon: { couponId: 'coupon-001', name: '满减券', discount: 100 },
      },
      saveRecentCustomer: vi.fn(),
      updateCart: vi.fn(),
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
    }
    const wxMock = globalThis.wx as any
    const originalShowToast = wxMock.showToast
    const originalNavigateTo = wxMock.navigateTo
    wxMock.showToast = vi.fn()
    wxMock.navigateTo = vi.fn()

    try {
      await page._submitConversion()
    } finally {
      wxMock.showToast = originalShowToast
      wxMock.navigateTo = originalNavigateTo
    }

    expect(callStaffApiMock).toHaveBeenCalledWith(
      'order.createConversion',
      expect.objectContaining({
        clientUserId: 'client-001',
        couponId: 'coupon-001',
        convertOutSaleItemIds: ['sale-item-old-001'],
      }),
    )
  })

  test('组合套餐转换提交透传套餐主商品 ID', async () => {
    const callStaffApiMock = vi.mocked(callStaffApi)
    callStaffApiMock.mockReset().mockResolvedValueOnce({
      saleOrderId: 'FY-XSD-WX-2608160038',
      priceDiff: 2940,
      prepaidCardCredit: 0,
      prepaidCardAmount: 0,
      status: '待支付',
    })
    const bundleItem = {
      ...createCartItem('sku-bundle-neck', 1, 1980),
      quantity: 3,
      refBundleId: 'prod-body-bundle',
    }
    const page = {
      ...pageDefinition,
      data: {
        customerInfo: { clientUserId: 'client-001' },
        cart: [bundleItem],
        remark: '',
        submitting: false,
        conversionSelectedSaleItemIds: ['sale-item-old-001'],
        conversionPriceDiff: 2940,
        conversionPaymentMethod: '线下',
        conversionPrepaidCardAmount: 0,
        conversionRemaining: 2940,
        conversionReceivedAmount: 2940,
        conversionIsExperience: false,
        conversionIsActivity: false,
        preferredStaffWfId: '',
        selectedCoupon: null,
      },
      saveRecentCustomer: vi.fn(),
      updateCart: vi.fn(),
      setData(update: Record<string, unknown>) {
        Object.assign(this.data, update)
      },
    }
    const wxMock = globalThis.wx as any
    const originalShowToast = wxMock.showToast
    const originalNavigateTo = wxMock.navigateTo
    wxMock.showToast = vi.fn()
    wxMock.navigateTo = vi.fn()

    try {
      await page._submitConversion()
    } finally {
      wxMock.showToast = originalShowToast
      wxMock.navigateTo = originalNavigateTo
    }

    expect(callStaffApiMock).toHaveBeenCalledWith(
      'order.createConversion',
      expect.objectContaining({
        bundleProductId: 'prod-body-bundle',
        convertInItems: [expect.objectContaining({ skuId: 'sku-bundle-neck', quantity: 3 })],
      }),
    )
  })
})
