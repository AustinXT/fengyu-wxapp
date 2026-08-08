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
})
