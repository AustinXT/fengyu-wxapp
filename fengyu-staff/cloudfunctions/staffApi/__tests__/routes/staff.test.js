/**
 * 员工路由测试
 * 覆盖：list / departments / todayCommission / monthlyCalendar / todoList / bindStore
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('../../db/mssql', () => require('../mocks/mssql'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))


const pg = require('../../db/pg')
const { createManagerCtx, createBeauticianCtx, createCtx, resetPgMock } = require('../helpers')
const staffRoutes = require('../../routes/staff')

beforeEach(() => {
  resetPgMock(pg)
})

// ============================================================
// staff.list
// ============================================================
describe('staff.list', () => {
  test('返回门店在职员工列表', async () => {
    const ctx = createManagerCtx()

    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-001', name: '张三', position: '门店经理', department: '美容部', store_name: '凤御A店', market_name: '华东市场' },
      { employee_id: 'emp-002', name: '李四', position: '美容师', department: '美容部', store_name: '凤御A店', market_name: '华东市场' },
    ])

    await staffRoutes.list(ctx)

    expect(ctx.result.staffList).toHaveLength(2)
    expect(ctx.result.staffList[0].staffWfId).toBe('emp-001')
    expect(ctx.result.staffList[0].name).toBe('张三')
    expect(ctx.result.staffList[0].isManager).toBe(true)
    expect(ctx.result.staffList[1].isManager).toBe(false)
  })

  test('payload.storeId 覆盖默认门店', async () => {
    const ctx = createManagerCtx({ storeId: 'store-other' })

    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-010', name: '王五', position: '美容师', department: '美容部', store_name: '凤御B店', market_name: '华南市场' },
    ])

    await staffRoutes.list(ctx)

    expect(pg.query.mock.calls[0][1]).toContain('store-other')
    expect(ctx.result.staffList).toHaveLength(1)
    expect(ctx.result.staffList[0].storeName).toBe('凤御B店')
  })

  test('空门店返回空数组', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([])
    await staffRoutes.list(ctx)
    expect(ctx.result.staffList).toEqual([])
  })

  test('缺少门店信息抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({}, { storeId: null })
    await expect(staffRoutes.list(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店/)
  })
})

// ============================================================
// staff.departments
// ============================================================
describe('staff.departments', () => {
  test('返回按部门分组的员工', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-001', name: '张三', position: '美容师', department: '美容部' },
      { employee_id: 'emp-002', name: '李四', position: '美容师', department: '美容部' },
    ])
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-010', name: '王五', position: '顾问', department: '咨询部', store_name: '凤御A店' },
    ])

    await staffRoutes.departments(ctx)

    expect(ctx.result.departments).toHaveLength(2)
    const beautyDept = ctx.result.departments.find(d => d.departmentName === '美容部')
    expect(beautyDept.members).toHaveLength(2)
    const otherDept = ctx.result.departments.find(d => d.departmentName === '咨询部')
    expect(otherDept.members).toHaveLength(1)
    expect(otherDept.members[0].storeName).toBe('凤御A店')
  })

  test('无美容部时只返回其他部门', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-010', name: '赵六', position: '顾问', department: '咨询部', store_name: '凤御A店' },
    ])
    await staffRoutes.departments(ctx)
    expect(ctx.result.departments).toHaveLength(1)
    expect(ctx.result.departments[0].departmentName).toBe('咨询部')
  })

  test('marketName 为空时不查询其他部门', async () => {
    const ctx = createManagerCtx({}, { marketName: null })
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-001', name: '张三', position: '美容师', department: '美容部' },
    ])
    await staffRoutes.departments(ctx)
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(ctx.result.departments).toHaveLength(1)
  })

  test('缺少门店信息抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({}, { storeId: null })
    await expect(staffRoutes.departments(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店/)
  })
})

// ============================================================
// staff.todayCommission
// ============================================================
describe('staff.todayCommission', () => {
  test('返回今日分成数据', async () => {
    const ctx = createBeauticianCtx()
    pg.query.mockResolvedValueOnce([{ today_amount: '350.00', order_count: '3' }])
    pg.query.mockResolvedValueOnce([{ service_count: '2' }])
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.todayAmount).toBe('350.00')
    expect(ctx.result.orderCount).toBe(3)
    expect(ctx.result.serviceCount).toBe(2)
    expect(ctx.result.storeTodayRevenue).toBeUndefined()
  })

  test('店长额外获取门店今日营收', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([{ today_amount: '500.00', order_count: '5' }])
    pg.query.mockResolvedValueOnce([{ service_count: '3' }])
    pg.query.mockResolvedValueOnce([{ store_revenue: '8000.00' }])
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.todayAmount).toBe('500.00')
    expect(ctx.result.storeTodayRevenue).toBe('8000.00')
  })

  test('美容师不包含门店营收', async () => {
    const ctx = createBeauticianCtx()
    pg.query.mockResolvedValueOnce([{ today_amount: '0', order_count: '0' }])
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.storeTodayRevenue).toBeUndefined()
    expect(pg.query).toHaveBeenCalledTimes(2)
  })
})

// ============================================================
// staff.monthlyCalendar
// ============================================================
describe('staff.monthlyCalendar', () => {
  test('返回指定月份日历数据和汇总', async () => {
    const ctx = createManagerCtx({ yearMonth: '2024-06' })
    pg.query.mockResolvedValueOnce([
      { date: '2024-06-01', amount: 200 },
      { date: '2024-06-15', amount: 350 },
    ])
    pg.query.mockResolvedValueOnce([{ total_amount: '550', total_order_count: '4' }])
    pg.query.mockResolvedValueOnce([{ total_service_count: '6' }])
    await staffRoutes.monthlyCalendar(ctx)
    expect(ctx.result.dailyData).toHaveLength(2)
    expect(ctx.result.dailyData[0].date).toBe('2024-06-01')
    expect(ctx.result.dailyData[0].amount).toBe(200)
    expect(ctx.result.totalAmount).toBe(550)
    expect(ctx.result.totalOrderCount).toBe(4)
    expect(ctx.result.totalServiceCount).toBe(6)
  })

  test('缺少 yearMonth 时默认当前月', async () => {
    const ctx = createManagerCtx({})
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{ total_amount: '0', total_order_count: '0' }])
    pg.query.mockResolvedValueOnce([{ total_service_count: '0' }])
    await staffRoutes.monthlyCalendar(ctx)
    expect(ctx.result.dailyData).toEqual([])
    expect(ctx.result.totalAmount).toBe(0)
    expect(ctx.result.totalOrderCount).toBe(0)
    expect(ctx.result.totalServiceCount).toBe(0)
  })
})

// ============================================================
// staff.todoList
// ============================================================
describe('staff.todoList', () => {
  test('美容师获取基础待办计数', async () => {
    const ctx = createBeauticianCtx()
    pg.query.mockResolvedValueOnce([{ cnt: '2' }])
    pg.query.mockResolvedValueOnce([{ cnt: '1' }])
    await staffRoutes.todoList(ctx)
    expect(ctx.result.pendingAppointmentCount).toBe(2)
    expect(ctx.result.pendingServiceCount).toBe(1)
    expect(ctx.result.pendingOfflineOrderCount).toBeUndefined()
    expect(ctx.result.pendingCreateOrderCount).toBeUndefined()
    expect(ctx.result.pendingUnbindCount).toBeUndefined()
    expect(ctx.result.pendingAllocationCount).toBeUndefined()
  })

  test('店长获取额外待办计数', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([{ cnt: '3' }])
    pg.query.mockResolvedValueOnce([{ cnt: '2' }])
    pg.query.mockResolvedValueOnce([{ cnt: '1' }])
    pg.query.mockResolvedValueOnce([{ cnt: '4' }])
    pg.query.mockResolvedValueOnce([{ cnt: '0' }])
    pg.query.mockResolvedValueOnce([{ cnt: '5' }])
    await staffRoutes.todoList(ctx)
    expect(ctx.result.pendingAppointmentCount).toBe(3)
    expect(ctx.result.pendingServiceCount).toBe(2)
    expect(ctx.result.pendingOfflineOrderCount).toBe(1)
    expect(ctx.result.pendingCreateOrderCount).toBe(4)
    expect(ctx.result.pendingUnbindCount).toBe(0)
    expect(ctx.result.pendingAllocationCount).toBe(5)
  })
})

// ============================================================
// staff.bindStore
// ============================================================
describe('staff.bindStore', () => {
  test('有效门店绑定成功', async () => {
    const ctx = createManagerCtx({ storeId: 'store-new' })
    pg.query.mockResolvedValueOnce([{ store_id: 'store-new', store_name: '凤御C店' }])
    await staffRoutes.bindStore(ctx)
    expect(ctx.result.success).toBe(true)
    expect(ctx.result.storeId).toBe('store-new')
    expect(ctx.result.storeName).toBe('凤御C店')
  })

  test('门店不存在或已关闭时拒绝', async () => {
    const ctx = createManagerCtx({ storeId: 'store-invalid' })
    pg.query.mockResolvedValueOnce([])
    await expect(staffRoutes.bindStore(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店不存在/)
  })

  test('缺少 storeId 参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(staffRoutes.bindStore(ctx)).rejects.toThrow(/INVALID_PARAMS.*storeId/)
  })
})
