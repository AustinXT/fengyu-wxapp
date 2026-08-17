import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

vi.mock('../../utils/role', () => ({
  isManager: () => true,
  getStaffWfId: () => 'emp-001',
  isManagementMode: () => false,
}))

let pageDefinition: Record<string, any>
let originalPage: unknown

beforeAll(async () => {
  originalPage = (globalThis as any).Page
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinition = definition
  }
  await import('../../packageOrder/order-detail/order-detail')
})

afterAll(() => {
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.clearAllMocks()
  wx.navigateTo = vi.fn()
  wx.showToast = vi.fn()
})

function createPage() {
  const page: Record<string, any> = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      order: {
        saleOrderId: 'FY-CONV-REPAY',
        customerName: '测试顾客',
        totalAmount: '2000.00',
        orderType: '转换单',
      },
      repayLines: [{
        saleItemId: '__ORDER__',
        itemName: '转换单剩余欠款',
        repayable: '1500.00',
        real: '500.00',
      }],
      repayMethod: '微信',
      repayNote: '',
      currentRemainingPayable: 1500,
      repayUseCard: true,
      repayCardBalance: 1000,
      repayCardAmountInput: '200.00',
      repayIdempKey: 'repay-key',
      showRepayPopup: true,
      submitting: false,
      _saleOrderId: 'FY-CONV-REPAY',
    },
    setData(update: Record<string, unknown>) {
      Object.assign(this.data, update)
    },
  }
  return page
}

describe('转换单订单级在线回款', () => {
  test('同一事务扣储值卡并冻结本次在线金额，再跳转二维码页', async () => {
    vi.mocked(callStaffApi).mockResolvedValue({} as never)
    const page = createPage()

    await page.onConfirmRepay()

    expect(vi.mocked(callStaffApi).mock.calls).toEqual([
      ['order.createRepayment', {
        refSaleOrderId: 'FY-CONV-REPAY',
        paymentMethod: '储值卡',
        prepaidCardAmount: 200,
        onlinePaymentAmount: 300,
        note: undefined,
        idempotencyKey: 'repay-key',
      }],
    ])
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: '/packageOrder/order-qrcode/order-qrcode?saleOrderId=FY-CONV-REPAY&customerName=%E6%B5%8B%E8%AF%95%E9%A1%BE%E5%AE%A2&totalAmount=2000.00',
    })
  })

  test('原子回款响应失败时立即刷新且保留弹层幂等键', async () => {
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('CONFLICT: 网络响应丢失'))
    const page = createPage()
    page.loadDetail = vi.fn().mockResolvedValue(undefined)

    await page.onConfirmRepay()

    expect(page.loadDetail).toHaveBeenCalledWith('FY-CONV-REPAY')
    expect(page.data.showRepayPopup).toBe(true)
    expect(page.data.repayIdempKey).toBe('repay-key')
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })
})
