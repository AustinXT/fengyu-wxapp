/**
 * 员工路由测试
 * 覆盖：list / departments / todayCommission / monthlyCalendar / todoList / bindStore
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx, createCtx, createManagementCtx } = require('../helpers')
const staffRoutes = require('../../routes/staff')


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

  test('养生师入选并透出 skills（供前端派生身份标签）', async () => {
    const ctx = createManagerCtx()

    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-001', name: '张三', position: '美容师', skills: ['美容师'], department: '美容部', store_name: '凤御A店', market_name: '华东市场' },
      { employee_id: 'emp-003', name: '王五', position: '养生师', skills: ['养生师'], department: '养生部', store_name: '凤御A店', market_name: '华东市场' },
    ])

    await staffRoutes.list(ctx)

    // SQL 用 skills && ARRAY['美容师','养生师'] 过滤
    expect(pg.query.mock.calls[0][0]).toMatch(/skills\s*&&\s*ARRAY\['美容师','养生师'\]::text\[\]/)
    expect(ctx.result.staffList).toHaveLength(2)
    expect(ctx.result.staffList[1].name).toBe('王五')
    expect(ctx.result.staffList[1].skills).toEqual(['养生师'])
  })

  test('payload.storeId 覆盖默认门店', async () => {
    const ctx = createManagerCtx(
      { storeId: 'store-other' },
      // 多店店长管理层模式：scope 内含 store-other，payload.storeId 才不会被守卫拦截
      { loginLevel: 'management', staffLevel: 'market', scopeStoreIds: ['store-001', 'store-other'] },
    )

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
  test('返回按部门分组的员工（含 P2-14 skills）', async () => {
    // 跨部门"市场维度其他部门"分支仅 headquarters / market 级可见
    const ctx = createManagerCtx({}, { staffLevel: 'market' })
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-001', name: '张三', position: '美容师', skills: ['美容师'], department: '美容部' },
      { employee_id: 'emp-002', name: '李四', position: '美容师', skills: ['美容师', '推广师'], department: '美容部' },
    ])
    pg.query.mockResolvedValueOnce([
      { employee_id: 'emp-010', name: '王五', position: '顾问', skills: [], department: '咨询部', store_name: '凤御A店' },
    ])

    await staffRoutes.departments(ctx)

    expect(ctx.result.departments).toHaveLength(2)
    const beautyDept = ctx.result.departments.find(d => d.departmentName === '美容部')
    expect(beautyDept.members).toHaveLength(2)
    // P2-14：每个 member 都带 skills，供前端按 skill 重新桶化
    expect(beautyDept.members[0].skills).toEqual(['美容师'])
    expect(beautyDept.members[1].skills).toEqual(['美容师', '推广师'])
    const otherDept = ctx.result.departments.find(d => d.departmentName === '咨询部')
    expect(otherDept.members).toHaveLength(1)
    expect(otherDept.members[0].storeName).toBe('凤御A店')
    expect(otherDept.members[0].skills).toEqual([])
  })

  test('无美容部时只返回其他部门', async () => {
    // 跨部门"市场维度其他部门"分支仅 headquarters / market 级可见
    const ctx = createManagerCtx({}, { staffLevel: 'market' })
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
    pg.query.mockResolvedValueOnce([{ today_amount: '350.00', order_count: '3' }])  // 今日分成
    pg.query.mockResolvedValueOnce([{ service_count: '2' }])                        // 今日服务
    pg.query.mockResolvedValueOnce([{ amount: '900.00', order_count: '7' }])        // 本月分成
    pg.query.mockResolvedValueOnce([{ service_count: '5' }])                        // 本月服务
    pg.query.mockResolvedValueOnce([{ amount: '1200.00', order_count: '10' }])      // 上月分成
    pg.query.mockResolvedValueOnce([{ service_count: '8' }])                        // 上月服务
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.todayAmount).toBe('350.00')
    expect(ctx.result.orderCount).toBe(3)
    expect(ctx.result.serviceCount).toBe(2)
    expect(ctx.result.thisMonthAmount).toBe('900.00')
    expect(ctx.result.thisMonthOrderCount).toBe(7)
    expect(ctx.result.thisMonthServiceCount).toBe(5)
    expect(ctx.result.lastMonthAmount).toBe('1200.00')
    expect(ctx.result.lastMonthOrderCount).toBe(10)
    expect(ctx.result.lastMonthServiceCount).toBe(8)
    expect(ctx.result.storeTodayRevenue).toBeUndefined()
  })

  test('店长额外获取门店今日营收', async () => {
    const ctx = createManagerCtx()
    pg.query.mockResolvedValueOnce([{ today_amount: '500.00', order_count: '5' }])  // 今日分成
    pg.query.mockResolvedValueOnce([{ service_count: '3' }])                        // 今日服务
    pg.query.mockResolvedValueOnce([{ amount: '0', order_count: '0' }])             // 本月分成
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])                        // 本月服务
    pg.query.mockResolvedValueOnce([{ amount: '0', order_count: '0' }])             // 上月分成
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])                        // 上月服务
    pg.query.mockResolvedValueOnce([{ store_revenue: '8000.00' }])                  // 门店营收
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.todayAmount).toBe('500.00')
    expect(ctx.result.storeTodayRevenue).toBe('8000.00')
  })

  test('美容师不包含门店营收', async () => {
    const ctx = createBeauticianCtx()
    pg.query.mockResolvedValueOnce([{ today_amount: '0', order_count: '0' }])   // 今日分成
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])                    // 今日服务
    pg.query.mockResolvedValueOnce([{ amount: '0', order_count: '0' }])         // 本月分成
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])                    // 本月服务
    pg.query.mockResolvedValueOnce([{ amount: '0', order_count: '0' }])         // 上月分成
    pg.query.mockResolvedValueOnce([{ service_count: '0' }])                    // 上月服务
    await staffRoutes.todayCommission(ctx)
    expect(ctx.result.storeTodayRevenue).toBeUndefined()
    expect(pg.query).toHaveBeenCalledTimes(6)
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
    pg.query.mockResolvedValueOnce([{ cnt: '7' }])  // 待审批退款
    await staffRoutes.todoList(ctx)
    expect(ctx.result.pendingAppointmentCount).toBe(3)
    expect(ctx.result.pendingServiceCount).toBe(2)
    expect(ctx.result.pendingOfflineOrderCount).toBe(1)
    expect(ctx.result.pendingCreateOrderCount).toBe(4)
    expect(ctx.result.pendingUnbindCount).toBe(0)
    expect(ctx.result.pendingAllocationCount).toBe(5)
    expect(ctx.result.pendingRefundCount).toBe(7)
  })
})

// ============================================================
// staff.bindStore
// ============================================================
describe('staff.bindStore', () => {
  test('有效门店绑定成功并持久化 store_id', async () => {
    // 总部账号可任意切店（绕过 scope guard）
    const ctx = createManagerCtx({ storeId: 'store-new' }, { staffLevel: 'headquarters' })
    pg.query.mockResolvedValueOnce([{ store_id: 'store-new', store_name: '凤御C店' }])
    pg.query.mockResolvedValueOnce([]) // UPDATE staff_wechat_users
    await staffRoutes.bindStore(ctx)
    expect(ctx.result.success).toBe(true)
    expect(ctx.result.storeId).toBe('store-new')
    expect(ctx.result.storeName).toBe('凤御C店')
    // 校验落库调用：UPDATE 参数为 [storeId, staffWfId]
    const updateCall = pg.query.mock.calls[1]
    expect(updateCall[0]).toMatch(/UPDATE\s+staff_wechat_users/i)
    expect(updateCall[0]).toMatch(/store_id\s*=\s*\$1/i)
    expect(updateCall[1]).toEqual(['store-new', 'emp-001'])
  })

  test('门店不存在或已关闭时拒绝', async () => {
    // 总部账号可任意切店：scope 不拦，stores 表查空 → INVALID_PARAMS
    const ctx = createManagerCtx({ storeId: 'store-invalid' }, { staffLevel: 'headquarters' })
    pg.query.mockResolvedValueOnce([])
    await expect(staffRoutes.bindStore(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店不存在/)
  })

  test('缺少 storeId 参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(staffRoutes.bindStore(ctx)).rejects.toThrow(/INVALID_PARAMS.*storeId/)
  })
})

// ============================================================
// staff.performanceDetail
// ============================================================
describe('staff.performanceDetail', () => {
  test('返回销售+服务提成明细和汇总', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
    })

    // allocRows (销售分配)
    pg.query.mockResolvedValueOnce([
      {
        alloc_amount: '300', commission_amount: '300', allocation_ratio: 0.3, department_name: '美容部',
        product_name: '面部护理', sales_category: '自销自耗',
        unit_real_price: '1000', received: '1000',
        sale_order_id: 'FY-001', customer_name: '张三', client_phone: '138',
        paid_at: '2024-06-15', store_id: 'store-001',
      },
    ])
    // svcRows (服务提成，新口径：读 service_commissions.commission_amount)
    // 双字段：fixed_fee=120 + consume_amount=80 = commission_amount=200
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '200.00', fixed_fee: '120.00', consume_amount: '80.00',
        role_type: '美容师', commission_rate: '0.0800',
        session_used: 2, service_unit_price: '500.00',
        product_name: '身体护理', sales_category: '自销自耗',
        service_order_id: 'SVC-001', service_date: '2024-06-20',
        store_id: 'store-001', customer_name: '李四', client_phone: '139',
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalSalesAlloc).toBe(300)
    expect(ctx.result.totalServiceCommission).toBe(200)
    expect(ctx.result.totalServiceFee).toBe(200) // 向后兼容字段
    expect(ctx.result.totalCommission).toBe(500)
    expect(ctx.result.items).toHaveLength(2)
    expect(ctx.result.categorySummary['自销自耗'].sales).toBe(300)
    expect(ctx.result.categorySummary['自销自耗'].service).toBe(200)
  })

  test('filterType=sale 只返回销售明细', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      filterType: 'sale',
    })

    pg.query.mockResolvedValueOnce([
      {
        alloc_amount: '500', allocation_ratio: 0.5, department_name: '美容部',
        product_name: 'P1', sales_category: '自销自耗',
        unit_real_price: '1000', received: '1000',
        sale_order_id: 'FY-001', customer_name: 'C1', client_phone: '138',
        paid_at: '2024-06-10', store_id: 'store-001',
      },
    ])
    pg.query.mockResolvedValueOnce([
      {
        service_price: '80', session_used: 1,
        product_name: 'P2', sales_category: '自销自耗',
        service_order_id: 'SVC-001', service_date: '2024-06-20',
        store_id: 'store-001', customer_name: 'C2', client_phone: '139',
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    // filterType=sale 只包含 sale 类型
    expect(ctx.result.items.every(i => i.type === 'sale')).toBe(true)
    expect(ctx.result.items).toHaveLength(1)
  })

  test('filterType=service 只返回服务明细', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      filterType: 'service',
    })

    pg.query.mockResolvedValueOnce([
      {
        alloc_amount: '300', allocation_ratio: 0.3, department_name: '美容部',
        product_name: 'P1', sales_category: '自销自耗',
        unit_real_price: '1000', received: '1000',
        sale_order_id: 'FY-001', customer_name: 'C1', client_phone: '138',
        paid_at: '2024-06-10', store_id: 'store-001',
      },
    ])
    pg.query.mockResolvedValueOnce([
      {
        service_price: '100', session_used: 1,
        product_name: 'P2', sales_category: '自销自耗',
        service_order_id: 'SVC-001', service_date: '2024-06-20',
        store_id: 'store-001', customer_name: 'C2', client_phone: '139',
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.items.every(i => i.type === 'service')).toBe(true)
    expect(ctx.result.items).toHaveLength(1)
  })

  test('美容师只能查自己的绩效', async () => {
    const ctx = createBeauticianCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      employeeId: 'emp-other', // 尝试查他人
    })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    // 应使用美容师自己的 staffWfId，不是 emp-other
    expect(pg.query.mock.calls[0][1][0]).toBe('emp-beautician-001')
  })

  test('店长可查询他人绩效', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      employeeId: 'emp-target',
    })

    pg.query.mockResolvedValueOnce([{ store_id: 'store-001' }]) // scope guard: target employee in same store
    pg.query.mockResolvedValueOnce([]) // allocation query
    pg.query.mockResolvedValueOnce([]) // service query

    await staffRoutes.performanceDetail(ctx)

    // scope guard query uses target employee id
    expect(pg.query.mock.calls[0][1][0]).toBe('emp-target')
  })

  test('缺少日期参数时拒绝', async () => {
    const ctx = createManagerCtx({ startDate: '2024-06-01' })
    await expect(staffRoutes.performanceDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*endDate/)
  })

  test('salesCategory 过滤生效', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      salesCategory: '他销自耗',
    })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    // SQL 应包含 salesCategory 过滤
    const allocSql = pg.query.mock.calls[0][0]
    expect(allocSql).toContain('sales_category')
    expect(pg.query.mock.calls[0][1]).toContain('他销自耗')
  })

  test('分页功能正确', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
      page: 2,
      pageSize: 1,
    })

    pg.query.mockResolvedValueOnce([
      {
        alloc_amount: '100', allocation_ratio: 0.1, department_name: '美容部',
        product_name: 'P1', sales_category: '自销自耗',
        unit_real_price: '1000', received: '1000',
        sale_order_id: 'FY-001', customer_name: 'C1', client_phone: '138',
        paid_at: '2024-06-10', store_id: 'store-001',
      },
      {
        alloc_amount: '200', allocation_ratio: 0.2, department_name: '美容部',
        product_name: 'P2', sales_category: '自销自耗',
        unit_real_price: '1000', received: '1000',
        sale_order_id: 'FY-002', customer_name: 'C2', client_phone: '139',
        paid_at: '2024-06-05', store_id: 'store-001',
      },
    ])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.total).toBe(2)
    expect(ctx.result.page).toBe(2)
  })

  test('空结果返回零值', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
    })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalSalesAlloc).toBe(0)
    expect(ctx.result.totalServiceFee).toBe(0)
    expect(ctx.result.totalCommission).toBe(0)
    expect(ctx.result.items).toEqual([])
    expect(ctx.result.categorySummary).toEqual({})
  })

  test('sales_category 为 null 时归入"未分类"', async () => {
    const ctx = createManagerCtx({
      startDate: '2024-06-01',
      endDate: '2024-06-30',
    })

    pg.query.mockResolvedValueOnce([]) // allocRows 空
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '150.00', fixed_fee: '150.00', consume_amount: '0.00',
        role_type: '美容师', commission_rate: '0.0000',
        session_used: 1, service_unit_price: '500.00',
        product_name: 'P-null',
        sales_category: null, // || '未分类' 分支
        service_order_id: 'SVC-null', service_date: '2024-06-25',
        store_id: 'store-001', customer_name: '客户X', client_phone: '138',
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalServiceCommission).toBe(150)
    expect(ctx.result.categorySummary['未分类'].service).toBe(150)
  })
})

// ============================================================
// staff.performanceDetail
// 修复 Bug：原实现把 unit_real_price × session_used（消耗业绩金额）
// 冒充"服务提成"累加返回，导致员工绩效页数字虚高 3-5 倍。
// 新实现改查 service_commissions 表，直接读 commission_amount
// （= fixed_fee + consume_amount 双字段拆分）。
// ============================================================
describe('staff.performanceDetail', () => {
  const rangePayload = { startDate: '2026-03-01', endDate: '2026-03-31' }

  test('服务提成汇总读 service_commissions.commission_amount（而非 unit_real_price × session_used）', async () => {
    const ctx = createManagerCtx(rangePayload)

    // allocRows：空销售提成，聚焦服务维度
    pg.query.mockResolvedValueOnce([])
    // svcRows：10 行 service_commissions，每行 commission_amount=130 (fixed_fee=80 + consume_amount=50)
    // 旧错误实现会返回 unit_real_price × session_used = 500 × 10 = 5000
    // 新正确实现应返回 130 × 10 = 1300
    pg.query.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({
        commission_amount: '130.00',
        fixed_fee: '80.00',
        consume_amount: '50.00',
        role_type: '美容师',
        commission_rate: '0.1000',
        session_used: 1,
        service_unit_price: '500.00',
        product_name: '面部护理',
        sales_category: '自销自耗',
        service_order_id: `HLD-WX-2603${String(i).padStart(4, '0')}`,
        service_date: '2026-03-10',
        store_id: 'store-001',
        customer_name: '张三',
        client_phone: '13800000001',
      }))
    )

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalServiceCommission).toBe(1300)
    expect(ctx.result.totalServiceCommission).not.toBe(5000) // 旧 Bug 值
    expect(ctx.result.totalSalesAlloc).toBe(0)
    expect(ctx.result.totalCommission).toBe(1300)
  })

  test('categorySummary 按分类汇总使用 commission_amount 口径', async () => {
    const ctx = createManagerCtx(rangePayload)

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '130.00', fixed_fee: '80.00', consume_amount: '50.00',
        role_type: '美容师', commission_rate: '0.1000', session_used: 1, service_unit_price: '500.00',
        product_name: '面部护理', sales_category: '自销自耗',
        service_order_id: 'HLD-WX-2603-0001', service_date: '2026-03-10', store_id: 'store-001',
        customer_name: '张三', client_phone: null,
      },
      {
        commission_amount: '200.00', fixed_fee: '100.00', consume_amount: '100.00',
        role_type: '推广师', commission_rate: '0.1000', session_used: 1, service_unit_price: '1000.00',
        product_name: '家居产品', sales_category: '他销他耗',
        service_order_id: 'HLD-WX-2603-0002', service_date: '2026-03-11', store_id: 'store-001',
        customer_name: '李四', client_phone: null,
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.categorySummary['自销自耗'].service).toBe(130)
    expect(ctx.result.categorySummary['他销他耗'].service).toBe(200)
    // 两分类之间不互相污染
    expect(ctx.result.categorySummary['自销自耗'].sales).toBe(0)
    expect(ctx.result.categorySummary['他销他耗'].sales).toBe(0)
  })

  test('totalCommission === totalSalesAlloc + totalServiceCommission', async () => {
    const ctx = createManagerCtx(rangePayload)

    // 销售提成 800
    pg.query.mockResolvedValueOnce([
      {
        alloc_amount: '800.00', commission_amount: '800.00', allocation_ratio: '0.80', department_name: '美容部',
        product_name: '销售商品', sales_category: '自销自耗',
        unit_real_price: '1000.00', received: '1000.00',
        sale_order_id: 'FY-XSD-WX-260310-0001', customer_name: '张三', client_phone: null,
        paid_at: new Date('2026-03-10'), store_id: 'store-001',
      },
    ])
    // 服务提成 130
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '130.00', fixed_fee: '80.00', consume_amount: '50.00',
        role_type: '美容师', commission_rate: '0.1000', session_used: 1, service_unit_price: '500.00',
        product_name: '护理项目', sales_category: '自销自耗',
        service_order_id: 'HLD-WX-2603-0001', service_date: '2026-03-10', store_id: 'store-001',
        customer_name: '张三', client_phone: null,
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalSalesAlloc).toBe(800)
    expect(ctx.result.totalServiceCommission).toBe(130)
    expect(ctx.result.totalCommission).toBe(930) // 800 + 130
  })

  test('serviceItems 明细返回 fixedFee / consumeAmount / roleType 字段', async () => {
    const ctx = createManagerCtx({ ...rangePayload, filterType: 'service' })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '130.00', fixed_fee: '80.00', consume_amount: '50.00',
        role_type: '美容师', commission_rate: '0.1200', session_used: 2, service_unit_price: '500.00',
        product_name: '面部护理', sales_category: '自销自耗',
        service_order_id: 'HLD-WX-2603-0001', service_date: '2026-03-10', store_id: 'store-001',
        customer_name: '张三', client_phone: null,
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    const svc = ctx.result.items[0]
    expect(svc.type).toBe('service')
    expect(svc.amount).toBe(130)
    expect(svc.fixedFee).toBe(80)
    expect(svc.consumeAmount).toBe(50)
    expect(svc.roleType).toBe('美容师')
    expect(svc.commissionRate).toBe(0.12)
    // fixedFee + consumeAmount === amount（保证两字段拆分恒等）
    expect(svc.fixedFee + svc.consumeAmount).toBe(svc.amount)
  })

  test('保留 totalServiceFee 字段向后兼容老版本前端', async () => {
    const ctx = createManagerCtx(rangePayload)

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      {
        commission_amount: '130.00', fixed_fee: '80.00', consume_amount: '50.00',
        role_type: '美容师', commission_rate: '0.1000', session_used: 1, service_unit_price: '500.00',
        product_name: '面部护理', sales_category: '自销自耗',
        service_order_id: 'HLD-WX-2603-0001', service_date: '2026-03-10', store_id: 'store-001',
        customer_name: '张三', client_phone: null,
      },
    ])

    await staffRoutes.performanceDetail(ctx)

    // 双字段返回，值相同，老版本前端读 totalServiceFee 也能拿到正确值
    expect(ctx.result.totalServiceFee).toBe(130)
    expect(ctx.result.totalServiceCommission).toBe(130)
    expect(ctx.result.totalServiceFee).toBe(ctx.result.totalServiceCommission)
  })

  test('服务提成 SQL 查 service_commissions 表（带 is_void=false 过滤）', async () => {
    const ctx = createManagerCtx(rangePayload)
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    // 第二次 pg.query 查的是服务提成
    const svcSql = pg.query.mock.calls[1][0]
    expect(svcSql).toContain('service_commissions')
    expect(svcSql).toContain('sc.commission_amount')
    expect(svcSql).toContain('sc.fixed_fee')
    expect(svcSql).toContain('sc.consume_amount')
    expect(svcSql).toContain('is_void = false')
    // 不应再使用 unit_real_price × session_used 作为口径
    expect(svcSql).not.toMatch(/sit\.unit_real_price\s+AS\s+service_price/)
  })

  test('空数据正确返回', async () => {
    const ctx = createManagerCtx(rangePayload)
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await staffRoutes.performanceDetail(ctx)

    expect(ctx.result.totalSalesAlloc).toBe(0)
    expect(ctx.result.totalServiceCommission).toBe(0)
    expect(ctx.result.totalServiceFee).toBe(0)
    expect(ctx.result.totalCommission).toBe(0)
    expect(ctx.result.items).toEqual([])
    expect(ctx.result.total).toBe(0)
  })
})
