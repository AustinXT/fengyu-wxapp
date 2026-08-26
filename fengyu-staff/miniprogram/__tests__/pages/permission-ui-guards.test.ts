import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

const appState = { globalData: {} as Record<string, unknown> }
const pageDefinitions: Record<string, Record<string, any>> = {}
let registeringPage = ''
let originalGetApp: unknown
let originalPage: unknown

function setGlobalData(globalData: Record<string, unknown>) {
  appState.globalData = {
    staffWfId: 'staff-self',
    loginLevel: 'store',
    currentStoreId: 'store-1',
    managerStoreIds: [],
    managerStores: [],
    ...globalData,
  }
}

function createPage(name: string) {
  const definition = pageDefinitions[name]
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
  } as Record<string, any>
  page.setData = (update: Record<string, unknown>) => {
    Object.assign(page.data, update)
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

  registeringPage = 'customerDetail'
  await import('../../packageCustomer/customer-detail/customer-detail')
  registeringPage = 'customerList'
  await import('../../pages/customer-list/customer-list')
  registeringPage = 'orderDetail'
  await import('../../packageOrder/order-detail/order-detail')
  registeringPage = 'serviceDetail'
  await import('../../packageService/service-detail/service-detail')
  registeringPage = 'allocationList'
  await import('../../packageOrder/allocation-list/allocation-list')
  registeringPage = 'unbindRequests'
  await import('../../packageService/unbind-requests/unbind-requests')
  registeringPage = 'pickupByCustomer'
  await import('../../packageMy/pickup/pickup-by-customer')
  registeringPage = 'pickupList'
  await import('../../packageMy/pickup/pickup-list')
  registeringPage = 'workbench'
  await import('../../pages/workbench/workbench')
  registeringPage = 'service'
  await import('../../pages/service/service')
  registeringPage = 'appointment'
  await import('../../packageService/appointment/appointment')
  registeringPage = 'appointmentDetail'
  await import('../../packageService/appointment-detail/appointment-detail')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.clearAllMocks()
  setGlobalData({})
  const wxMock = (globalThis as any).wx || ((globalThis as any).wx = {})
  wxMock.showToast = vi.fn()
  wxMock.showModal = vi.fn()
  wxMock.navigateTo = vi.fn()
  wxMock.navigateBack = vi.fn()
  wxMock.reLaunch = vi.fn()
  wxMock.switchTab = vi.fn()
})

describe('顾客详情权限门禁', () => {
  test('非当前门店有效店长不请求储值卡余额', async () => {
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1' }

    await page.loadCardBalance()

    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.cardBalanceLoaded).toBe(false)
  })

  test('余额接口拒绝时不将余额标记为已加载的零值', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1' }
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('PERMISSION_DENIED: 无权限'))

    await page.loadCardBalance()

    expect(callStaffApi).toHaveBeenCalledWith('customer.customerBalance', { customerUserId: 'customer-1' })
    expect(page.data.cardBalanceLoaded).toBe(false)
  })

  test('普通员工不能打开姓名或指定美容师编辑入口', async () => {
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1', name: '顾客甲' }

    page.onEditCustomerName()
    await page.onEditPreferredStaff()

    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.showAssignSheet).toBe(false)
  })

  test('店长可修改顾客姓名并即时回填页面', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1', name: '顾客甲' }
    vi.mocked(callStaffApi).mockResolvedValueOnce({ message: 'success', name: '顾客乙' })

    await page.saveCustomerName('  顾客乙  ')

    expect(callStaffApi).toHaveBeenCalledWith('customer.updateName', {
      clientUserId: 'customer-1',
      name: '顾客乙',
    })
    expect(page.data.customer.name).toBe('顾客乙')
    expect(page.data.profileSaving).toBe(false)
  })

  test('店长选择本店美容师后调用 customer.assign 并即时回填', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1', name: '顾客甲', preferredStaffName: '美容师甲' }
    vi.mocked(callStaffApi)
      .mockResolvedValueOnce({
        staffList: [
          { staffWfId: 'employee-2', name: '美容师乙', department: '美容部', storeId: 'store-1' },
          { staffWfId: 'employee-away', name: '外店支援', department: '美容部', storeId: 'store-2' },
        ],
      })
      .mockResolvedValueOnce({ employeeName: '美容师乙', message: 'success' })

    await page.onEditPreferredStaff()
    expect(page.data.staffActions).toEqual([
      { name: '美容师乙', subname: '美容部', staffWfId: 'employee-2' },
    ])
    expect(page.data.showAssignSheet).toBe(true)

    await page.onAssignSelect({ detail: page.data.staffActions[0] })

    expect(callStaffApi).toHaveBeenLastCalledWith('customer.assign', {
      clientUserId: 'customer-1',
      employeeId: 'employee-2',
    })
    expect(page.data.customer.preferredStaffName).toBe('美容师乙')
    expect(page.data.profileSaving).toBe(false)
  })

  test('普通员工不能打开基本档案编辑器', () => {
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1', updatedAt: '2026-08-26T00:00:00.000Z' }

    page.onOpenProfileEditor()

    expect(page.data.showProfileEditor).toBe(false)
  })

  test('店长保存时只提交实际变化字段并即时回填', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerDetail')
    page.data.customer = {
      clientUserId: 'customer-1', updatedAt: '2026-08-26T00:00:00.000Z',
      promoterEmployeeId: null, promoterEmployeeName: null, customerSource: '美团', birthday: null,
      occupation: null, isMarried: null, skinIssue: null, wellnessPreference: null, isCrossStoreTemp: false,
    }
    page.onOpenProfileEditor()
    page.data.profileForm = { ...page.data.profileForm, occupation: '教师', isCrossStoreTemp: true }
    vi.mocked(callStaffApi).mockResolvedValueOnce({
      updatedAt: '2026-08-26T01:00:00.000Z',
      changes: { occupation: '教师', isCrossStoreTemp: true },
    })

    await page.onSaveProfile()

    expect(callStaffApi).toHaveBeenCalledWith('customer.updateProfile', {
      clientUserId: 'customer-1',
      expectedUpdatedAt: '2026-08-26T00:00:00.000Z',
      changes: { occupation: '教师', isCrossStoreTemp: true },
    })
    expect(page.data.customer.occupation).toBe('教师')
    expect(page.data.customer.isCrossStoreTemp).toBe(true)
    expect(page.data.showProfileEditor).toBe(false)
  })

  test('推荐员工搜索结果只提交 employeeId', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerDetail')
    page.data.customer = { clientUserId: 'customer-1' }
    page.data.promoterSearchKeyword = '138'
    vi.mocked(callStaffApi).mockResolvedValueOnce([
      { employeeId: 'EMP-1', name: '王员工', phoneMasked: '138****5678', storeName: '测试店' },
    ])

    await page.onSearchPromoterEmployees()
    page.onSelectPromoterEmployee({ currentTarget: { dataset: { id: 'EMP-1' } } })

    expect(callStaffApi).toHaveBeenCalledWith('customer.searchPromoterEmployees', {
      clientUserId: 'customer-1', keyword: '138',
    })
    expect(page.data.profileForm.promoterEmployeeId).toBe('EMP-1')
    expect(page.data.profileForm.promoterEmployeeName).toBe('王员工')
  })
})

describe('顾客分配数据契约', () => {
  test('使用 staffList.staffWfId 作为 customer.assign 的 employeeId', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('customerList')
    vi.mocked(callStaffApi)
      .mockResolvedValueOnce({ staffList: [{ staffWfId: 'employee-1', name: '美容师甲' }] })
      .mockResolvedValueOnce({ employeeName: '美容师甲', message: 'success' })

    await page.onLongPressAssign({
      currentTarget: { dataset: { clientUserId: 'customer-1', name: '顾客甲' } },
    })

    expect(page.data.staffActions).toEqual([{ staffWfId: 'employee-1', name: '美容师甲' }])

    await page.onAssignSelect({ detail: page.data.staffActions[0] })

    expect(callStaffApi).toHaveBeenLastCalledWith('customer.assign', {
      clientUserId: 'customer-1',
      employeeId: 'employee-1',
    })
  })
})

describe('管理层详情只读', () => {
  test('管理层订单详情拒绝写操作入口', () => {
    setGlobalData({ loginLevel: 'management', currentStoreId: '' })
    const page = createPage('orderDetail')
    page.onLoad({})

    page.onConfirmOffline()
    page.onCreateService()
    page.onCreateRefund()
    page.onRepayTap()

    expect(page.data.isReadOnly).toBe(true)
    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled()
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('管理层服务详情拒绝写操作入口', async () => {
    setGlobalData({ loginLevel: 'management', currentStoreId: '' })
    const page = createPage('serviceDetail')
    page.onLoad({})
    page.data.detail = { id: 'service-1', status: '待服务' }

    await page.onStartService()
    page.onCompleteService()
    page.onConfirmService()
    page.onCancelService()

    expect(page.data.isReadOnly).toBe(true)
    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})

describe('店长专属直达页门禁', () => {
  test('普通员工不能通过直达路径加载分配、转店审批或提货页面', async () => {
    const allocationList = createPage('allocationList')
    const unbindRequests = createPage('unbindRequests')
    const pickupByCustomer = createPage('pickupByCustomer')
    const pickupList = createPage('pickupList')

    allocationList.onLoad()
    unbindRequests.onShow()
    pickupByCustomer.onLoad()
    pickupList.onLoad()

    expect((globalThis as any).wx.navigateBack).toHaveBeenCalledTimes(4)
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('普通员工直接触发转店审批 handler 不会打开确认框或调用 API', async () => {
    const page = createPage('unbindRequests')

    await page.onApprove({
      currentTarget: { dataset: { requestId: 'unbind-1', fromStore: 'A 店', toStore: 'B 店' } },
    })
    page.onReject({ currentTarget: { dataset: { requestId: 'unbind-1' } } })
    await page.onRejectDialogConfirm()

    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('当前门店有效店长仍可搜索提货顾客', async () => {
    setGlobalData({ managerStoreIds: ['store-1'] })
    const page = createPage('pickupByCustomer')
    page.onLoad()
    page.data.keyword = '顾客甲'
    vi.mocked(callStaffApi).mockResolvedValueOnce([])

    await page.onSearch()

    expect(page.data.isManager).toBe(true)
    expect(callStaffApi).toHaveBeenCalledWith('customer.search', {
      keyword: '顾客甲',
      phone: undefined,
      crossStore: true,
    })
  })
})

describe('管理层工作台与预约只读门禁', () => {
  test('管理层访问门店工作台或服务 Tab 时返回管理层工作台，不加载门店数据', () => {
    setGlobalData({ loginLevel: 'management', currentStoreId: '' })
    const workbench = createPage('workbench')
    const service = createPage('service')

    workbench.onShow()
    service.onShow()

    expect((globalThis as any).wx.reLaunch).toHaveBeenCalledWith({
      url: '/pages/mgmt-dashboard/mgmt-dashboard',
    })
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('管理层预约列表和详情不执行确认、签到或创建服务单', async () => {
    setGlobalData({ loginLevel: 'management', currentStoreId: '' })
    const appointment = createPage('appointment')
    const appointmentDetail = createPage('appointmentDetail')
    const event = { currentTarget: { dataset: { id: 'appointment-1' } } }

    appointment.onLoad({})
    await appointment.onConfirmAppt(event)
    await appointment.onCheckin(event)
    appointment.onCreateService(event)

    appointmentDetail.onLoad({})
    appointmentDetail.data.appt = { id: 'appointment-1', status: 'pending' }
    appointmentDetail.onConfirm()
    await appointmentDetail.onCheckin()
    appointmentDetail.onCreateService()
    appointmentDetail.onBackToWorkbench()

    expect(appointment.data.isReadOnly).toBe(true)
    expect(appointmentDetail.data.isReadOnly).toBe(true)
    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled()
    expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled()
    expect((globalThis as any).wx.reLaunch).toHaveBeenCalledWith({
      url: '/pages/mgmt-dashboard/mgmt-dashboard',
    })
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})
