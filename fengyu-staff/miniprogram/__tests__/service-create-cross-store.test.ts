import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../utils/cloud', () => ({ callStaffApi: vi.fn() }))

let pageDefinition: any

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('getApp', () => ({ globalData: {} }))
  vi.stubGlobal('Page', (definition: any) => { pageDefinition = definition })
  await import('../packageService/service-create/service-create')
})

function makePage() {
  return {
    ...pageDefinition,
    data: { ...pageDefinition.data, selectedCustomer: { clientUserId: 'current-customer' } },
    _allPaidItems: [],
    _pendingPreloadedItems: [],
    setData(update: Record<string, unknown>) { Object.assign(this.data, update) },
  }
}

describe('服务单跨店疗程列表', () => {
  test('原店寄存项目在现归属店的顾客列表中可选，家居产品不参与', async () => {
    const { callStaffApi } = await import('../utils/cloud')
    vi.mocked(callStaffApi).mockResolvedValueOnce([{
      saleOrderId: 'source-order', status: '已支付', saleOrderType: '寄存单',
      storeId: 'source-store', storeName: '原购买店', paidAt: '2026-07-28',
      items: [
        { saleItemId: 'treatment', itemName: '护理项目', productType: '疗程卡',
          totalSessions: 1, remainingSessions: 1, paidSessions: 1, quantity: 1 },
        { saleItemId: 'home', itemName: '家居单品', productType: '家居产品',
          totalSessions: 1, remainingSessions: 1, paidSessions: 1, quantity: 1 },
      ],
    }] as any)
    const page = makePage()

    await page.loadPaidOrders('current-customer')

    expect(callStaffApi).toHaveBeenCalledWith('customer.paidOrders', { clientUserId: 'current-customer' })
    expect(page.data.paidItemsLoaded).toBe(true)
    expect(page.data.paidItemsError).toBe('')
    expect(page.data.paidItems).toHaveLength(1)
    expect(page.data.paidItems[0].storeName).toBe('原购买店')
    expect(page.data.paidItems[0].consumableSessions).toBe(1)
  })

  test('接口失败显示错误并允许重试，不误报为顾客无卡', async () => {
    const { callStaffApi } = await import('../utils/cloud')
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('请求超时'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = makePage()

    await page.loadPaidOrders('current-customer')

    expect(page.data.paidItemsError).toBe('网络或服务异常，请重试')
    expect(page.data.paidItems).toHaveLength(0)
    expect(page.data.paidItemsLoaded).toBe(true)
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })
})
