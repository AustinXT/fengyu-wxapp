/**
 * 提货核销页按销售单分组（#350）。
 *
 * 会议 §2.11「选顾客 → 选销售单 → 领取」：同一顾客多张销售单待提时，每组组头要能对上是哪张单，
 * 点「录入提货」必须按 saleItemId 定位 —— 分组后内层 index 只是组内序号，按 index 取会录错商品。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({ callStaffApi: vi.fn() }))

const appState = {
  globalData: {
    staffWfId: 'staff-self',
    loginLevel: 'store',
    currentStoreId: 'store-1',
    managerStoreIds: ['store-1'],
    managerStores: [],
  } as Record<string, unknown>,
}
let definition: Record<string, any> = {}
let originalGetApp: unknown
let originalPage: unknown

function createPage() {
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) } as Record<string, any>
  page.setData = (update: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(update)) {
      if (!key.includes('.')) { page.data[key] = value; continue }
      const [head, ...rest] = key.split('.')
      let target = page.data[head]
      for (const part of rest.slice(0, -1)) target = target[part]
      target[rest[rest.length - 1]] = value
    }
  }
  return page
}

function row(overrides: Record<string, unknown>) {
  return {
    saleItemId: 'SI-1', saleItemGroupId: null, sourceSaleItemIds: ['SI-1'],
    saleOrderId: 'ORDER-A', skuId: 'sku-1', productName: '面霜', specName: null,
    quantity: 2, pickedUpQuantity: 0, paidQuantity: 2, remaining: 2,
    unitRealPrice: '199.00', storeId: 'store-1', storeName: '红谷滩店', orderDate: '2026-09-20',
    ...overrides,
  }
}

const TWO_ORDERS = [
  row({ saleItemId: 'SI-A1', saleOrderId: 'ORDER-A' }),
  row({ saleItemId: 'SI-B1', saleOrderId: 'ORDER-B', productName: '精华', unitRealPrice: null }),
  row({ saleItemId: 'SI-B2', saleOrderId: 'ORDER-B', productName: '面膜', remaining: 5 }),
]

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => appState
  ;(globalThis as any).Page = (def: Record<string, any>) => { definition = def }
  await import('../../packageMy/pickup/pickup-by-customer')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.mocked(callStaffApi).mockReset()
  const wxMock = (globalThis as any).wx || ((globalThis as any).wx = {})
  wxMock.showToast = vi.fn()
  wxMock.navigateBack = vi.fn()
})

async function selectCustomer(page: Record<string, any>, clientUserId = 'customer-1') {
  page.data.customers = [{ clientUserId, name: '顾客甲', phone: '138' }]
  await page.onSelectCustomer({ currentTarget: { dataset: { idx: 0 } } })
}

describe('提货核销页按销售单分组（#350）', () => {
  test('两张销售单 → 两个分组；组头带单号、下单日期、开单门店；单价缺失显示 --', async () => {
    const page = createPage()
    vi.mocked(callStaffApi).mockResolvedValueOnce(TWO_ORDERS)
    await selectCustomer(page)

    expect(page.data.groups.map((g: any) => g.saleOrderId)).toEqual(['ORDER-A', 'ORDER-B'])
    expect(page.data.groups[0]).toMatchObject({ orderDate: '2026-09-20', storeName: '红谷滩店' })
    expect(page.data.groups[1].items.map((i: any) => i.saleItemId)).toEqual(['SI-B1', 'SI-B2'])
    expect(page.data.groups[0].items[0].unitRealPriceText).toBe('¥199.00')
    // null 不能被 Number() 成 0 冒充 ¥0.00 的赠品
    expect(page.data.groups[1].items[0].unitRealPriceText).toBe('--')
  })

  test('录入提货按 saleItemId 定位：点第二组第 2 行，弹窗是那一行而不是全局第 2 行', async () => {
    const page = createPage()
    vi.mocked(callStaffApi).mockResolvedValueOnce(TWO_ORDERS).mockResolvedValue([])
    await selectCustomer(page)

    await page.onPickupTap({ currentTarget: { dataset: { saleItemId: 'SI-B2' } } })

    expect(page.data.pickupDialog.visible).toBe(true)
    expect(page.data.pickupDialog.saleItemId).toBe('SI-B2')
    expect(page.data.pickupDialog.remaining).toBe(5)
  })

  test('请求在途时已改选别的顾客：旧顾客的清单丢弃，不挂到新顾客头下', async () => {
    const page = createPage()
    let resolveA: (v: unknown) => void = () => {}
    vi.mocked(callStaffApi).mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
    const pendingA = selectCustomer(page, 'customer-A')
    // A 还没返回，用户改选 B
    page.data.selectedCustomer = { clientUserId: 'customer-B', name: '顾客乙', phone: '139' }
    resolveA(TWO_ORDERS)
    await pendingA

    expect(page.data.items).toEqual([])
    expect(page.data.groups).toEqual([])
  })

  test('提货成功但清单刷新失败：提示刷新失败，不能说成「提货失败」诱导重复提交', async () => {
    const page = createPage()
    vi.mocked(callStaffApi).mockResolvedValueOnce(TWO_ORDERS).mockResolvedValue([])
    await selectCustomer(page)
    await page.onPickupTap({ currentTarget: { dataset: { saleItemId: 'SI-A1' } } })
    page.data.pickupDialog.inventorySkuOptions = [{ availableQuantity: 9, requiredQuantity: 1, productName: '面霜' }]
    page.data.pickupDialog.inventoryReady = true

    vi.mocked(callStaffApi).mockReset()
    vi.mocked(callStaffApi)
      .mockResolvedValueOnce({ pickedUp: 1 })               // order.createPickup
      .mockRejectedValueOnce(new Error('网络超时'))          // order.availablePickupItems 刷新
    await page.submitPickup()

    const titles = vi.mocked((globalThis as any).wx.showToast).mock.calls.map((c: any[]) => c[0].title)
    expect(titles).toContain('提货成功')
    expect(titles).not.toContain('网络超时')
    expect(titles.some((t: string) => t.includes('提货已成功') && t.includes('刷新失败'))).toBe(true)
    expect(page.data.pickupDialog.submitting).toBe(false)
  })
})
