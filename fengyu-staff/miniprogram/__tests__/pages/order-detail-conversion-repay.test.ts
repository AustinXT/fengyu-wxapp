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
  wx.showModal = vi.fn()
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
  test('零首付待支付转换单开放订单级回款入口', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      order: {
        sale_order_id: 'FY-CONV-ZERO',
        sale_order_type: '转换单',
        status: '待支付',
        total_amount: '1500.00',
        received: '0.00',
        refunded_amount: '0.00',
        first_payment_amount: null,
        customer_name: '零首付顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance: 0,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-ZERO')

    expect(page.data.order.hasDebt).toBe(true)
    page.onRepayTap()
    expect(page.data.repayLines).toEqual([{
      saleItemId: '__ORDER__',
      itemName: '转换单剩余欠款',
      repayable: '1500.00',
      real: '1500.00',
    }])
  })

  test('待支付转换单已有冻结支付场次时不开放新回款入口', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      order: {
        sale_order_id: 'FY-CONV-CAPPED',
        sale_order_type: '转换单',
        status: '待支付',
        total_amount: '1500.00',
        received: '0.00',
        refunded_amount: '0.00',
        first_payment_amount: '500.00',
        customer_name: '首付顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance: 0,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-CAPPED')

    expect(page.data.order.hasDebt).toBe(true)
    expect(page.data.order.canInitiateRepayment).toBe(false)
    expect(page.data.order.canResumeOnlinePayment).toBe(true)
    expect(page.data.order.canViewQrcode).toBe(true)
    page.setData({ showRepayPopup: false })
    page.onRepayTap()
    expect(page.data.showRepayPopup).toBe(false)
  })

  test('部分支付转换单可从详情恢复已有 cap 的二维码', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      order: {
        sale_order_id: 'FY-CONV-PARTIAL-CAPPED',
        sale_order_type: '转换单',
        status: '部分支付',
        total_amount: '2000.00',
        received: '500.00',
        refunded_amount: '0.00',
        first_payment_amount: '500.00',
        customer_name: '部分支付顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance: 0,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-PARTIAL-CAPPED')

    expect(page.data.order.remainingPayable).toBe('1500.00')
    expect(page.data.order.activePaymentAmount).toBe('500.00')
    expect(page.data.order.canInitiateRepayment).toBe(false)
    expect(page.data.order.canResumeOnlinePayment).toBe(true)
    page.onShowQrcode()
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: '/packageOrder/order-qrcode/order-qrcode?saleOrderId=FY-CONV-PARTIAL-CAPPED&customerName=%E9%83%A8%E5%88%86%E6%94%AF%E4%BB%98%E9%A1%BE%E5%AE%A2&totalAmount=2000.00',
    })
    expect(vi.mocked(callStaffApi)).toHaveBeenCalledTimes(1)
  })

  test('历史 unrestricted O1 只有拉卡拉单号时仍视为活动意图并恢复二维码', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      order: {
        sale_order_id: 'FY-CONV-OLD-O1',
        sale_order_type: '转换单',
        status: '部分支付',
        total_amount: '2000.00',
        received: '500.00',
        refunded_amount: '0.00',
        first_payment_amount: null,
        lakala_out_order_no: 'FY-CONV-OLD-O1_1500',
        customer_name: '历史支付顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance: 0,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-OLD-O1')

    expect(page.data.order.hasActivePaymentCap).toBe(true)
    expect(page.data.order.canInitiateRepayment).toBe(false)
    expect(page.data.order.canResumeOnlinePayment).toBe(true)
    expect(page.data.order.activePaymentAmount).toBe('1500.00')
  })

  test('待结算储值卡从默认在线欠款扣除', async () => {
    vi.mocked(callStaffApi).mockResolvedValue({
      order: {
        sale_order_id: 'FY-CONV-PENDING-CARD',
        sale_order_type: '转换单',
        status: '待支付',
        total_amount: '2000.00',
        received: '0.00',
        refunded_amount: '0.00',
        pending_prepaid_card_amount: '500.00',
        first_payment_amount: null,
        customer_name: '待扣卡顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance: 500,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-PENDING-CARD')
    expect(page.data.order.remainingPayable).toBe('1500.00')
    expect(page.data.currentRemainingPayable).toBe(1500)

    page.onRepayTap()
    expect(page.data.repayLines[0].real).toBe('2000.00')
    expect(page.data.currentRemainingPayable).toBe(2000)
    expect(page.data.repayCardLocked).toBe(true)
    expect(page.data.repayUseCard).toBe(true)
    expect(page.data.repayCardAmountInput).toBe('500.00')
    expect(page.data.repayNeedPay).toBe('1500.00')

    page.onToggleUseCard()
    page.onRepayCardAmountInput({ detail: '0.00' })
    expect(page.data.repayUseCard).toBe(true)
    expect(page.data.repayCardAmountInput).toBe('500.00')

    page.setData({ repayMethod: '微信' })
    await page.onConfirmRepay()

    expect(vi.mocked(callStaffApi)).toHaveBeenLastCalledWith('order.createRepayment', {
      refSaleOrderId: 'FY-CONV-PENDING-CARD',
      paymentMethod: '储值卡',
      prepaidCardAmount: 500,
      onlinePaymentAmount: 1500,
      note: undefined,
      idempotencyKey: expect.any(String),
    })
  })

  test.each([0, 400])('固定 pending=500 但当前余额=%s 时提交前阻断且不扣卡不出码', async (cardBalance) => {
    vi.mocked(callStaffApi).mockResolvedValue({
      order: {
        sale_order_id: 'FY-CONV-PENDING-INSUFFICIENT',
        sale_order_type: '转换单',
        status: '待支付',
        total_amount: '2000.00',
        received: '0.00',
        refunded_amount: '0.00',
        pending_prepaid_card_amount: '500.00',
        first_payment_amount: null,
        customer_name: '余额不足顾客',
        is_experience_conversion: false,
      },
      items: [],
      payments: [],
      cardBalance,
    } as never)
    const page = createPage()

    await page.loadDetail('FY-CONV-PENDING-INSUFFICIENT')
    page.onRepayTap()
    page.setData({ repayMethod: '微信' })
    await page.onConfirmRepay()

    expect(vi.mocked(callStaffApi).mock.calls).toEqual([
      ['order.detail', { saleOrderId: 'FY-CONV-PENDING-INSUFFICIENT' }],
    ])
    expect(wx.showToast).toHaveBeenCalledWith({
      title: `储值卡余额不足（预选 ¥500.00，当前 ¥${cardBalance.toFixed(2)}）`,
      icon: 'none',
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(page.data.showRepayPopup).toBe(true)
    expect(page.data.submitting).toBe(false)
  })

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

describe('员工端业绩归属日期修改', () => {
  test('详情加载后计算原始订单日前后 7 天，并展示调整记录', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      order: {
        sale_order_id: 'FY-XSD-WX-2608260004',
        sale_order_type: '销售单',
        status: '已支付',
        sale_order_datetime: '2026-08-26T05:38:10.486Z',
        performance_attribution_date: '2026-09-02',
        performance_attribution_adjusted_at: '2026-08-26T06:00:00.000Z',
        performance_attribution_adjusted_by: 'emp-001',
        performance_attribution_adjusted_by_name: '店长甲',
        original_order_date: '2026-08-26',
        min_performance_date: '2026-08-19',
        max_performance_date: '2026-09-02',
        updated_at: '2026-08-26T06:00:00.000Z',
        total_amount: '1000.00',
        received: '1000.00',
      },
      items: [],
      payments: [],
    } as never)
    const page = createPage()

    await page.loadDetail('FY-XSD-WX-2608260004')

    expect(page.data.attributionMinDate).toBe('2026-08-19')
    expect(page.data.attributionMaxDate).toBe('2026-09-02')
    expect(page.data.order.performanceAttributionAdjusted).toBe(true)
    expect(page.data.order.performanceAttributionAdjustedByName).toBe('店长甲')
  })

  test('确认后携带 updatedAt 调用一次性修改 action，并刷新详情', async () => {
    vi.mocked(callStaffApi).mockResolvedValueOnce({ message: '业绩归属日期已修改；该订单不可再次调整' } as never)
    const page = createPage()
    page.setData({
      order: {
        ...page.data.order,
        saleOrderId: 'FY-XSD-WX-2608260004',
        performanceAttributionDate: '2026-08-26',
        updatedAt: '2026-08-26T05:39:21.991Z',
      },
    })
    page.loadDetail = vi.fn().mockResolvedValue(undefined)

    await page._submitPerformanceAttributionDate('2026-09-02')

    expect(vi.mocked(callStaffApi)).toHaveBeenCalledWith('order.updatePerformanceAttribution', {
      saleOrderId: 'FY-XSD-WX-2608260004',
      performanceAttributionDate: '2026-09-02',
      expectedUpdatedAt: '2026-08-26T05:39:21.991Z',
    })
    expect(page.loadDetail).toHaveBeenCalledWith('FY-XSD-WX-2608260004')
    expect(page.data.attributionSubmitting).toBe(false)
  })
})
