/**
 * 顾客档案路由测试
 * 覆盖：search / calendar / detail / paidOrders
 * 双源架构：WorkFine (MSSQL) + PG，手机号去重，非店长脱敏
 */



const pg = globalThis.__mocks__.pg
const mssql = globalThis.__mocks__.mssql
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const customerRoutes = require('../../routes/customer')

beforeEach(() => {
  mssql.query.mockReset().mockResolvedValue([])
})

// ============================================================
// customer.search
// ============================================================
describe('customer.search', () => {
  test('关键词搜索返回 WorkFine + PG 合并结果', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', bound_store_id: 'store-001' },
      { user_id: 'u2', phone: '13900002222', name: '张四', bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(2)
    const zhangSan = ctx.result.find(r => r.name === '张三')
    expect(zhangSan.source).toBe('both')
    expect(zhangSan.clientUserId).toBe('u1')
    const zhangSi = ctx.result.find(r => r.name === '张四')
    expect(zhangSi.source).toBe('miniprogram')
    expect(zhangSi.clientUserId).toBe('u2')
  })

  test('手机号搜索返回精确匹配', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('13800001111')
  })

  test('美容师看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('138****1111')
    expect(ctx.result[0].phoneMasked).toBe('138****1111')
  })

  test('无结果时返回空数组', async () => {
    const ctx = createManagerCtx({ keyword: '不存在的人' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(ctx.result).toEqual([])
  })

  test('customerType=member 只返回会员客（WorkFine + PG customer_id 非空）', async () => {
    const ctx = createManagerCtx({ customerType: 'member' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '会员张', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '会员张', customer_id: 'C001', bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    // WorkFine 会员 + PG 去重 → 1条
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].source).toBe('both')
    // PG SQL 应包含 customer_id IS NOT NULL 过滤
    const pgSql = pg.query.mock.calls[0][0]
    expect(pgSql).toContain('customer_id IS NOT NULL')
  })

  test('customerType=flow 跳过 WorkFine 只返回流量客', async () => {
    const ctx = createManagerCtx({ customerType: 'flow' })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u3', phone: '13700003333', name: '流量客', customer_id: null, bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    // 不查 WorkFine
    expect(mssql.query).not.toHaveBeenCalled()
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].source).toBe('miniprogram')
    // PG SQL 应包含 customer_id IS NULL 过滤
    const pgSql = pg.query.mock.calls[0][0]
    expect(pgSql).toContain('customer_id IS NULL')
  })

  test('MSSQL 查询使用参数化而非字符串拼接', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    // MSSQL 查询应传递参数对象（第二个参数）
    expect(mssql.query).toHaveBeenCalledTimes(1)
    const [sql, params] = mssql.query.mock.calls[0]
    expect(sql).toContain('@phone')
    expect(sql).toContain('@limit')
    expect(sql).not.toContain("'13800001111'")
    expect(params).toEqual(expect.objectContaining({ phone: '13800001111', limit: 1 }))
  })

  test('MSSQL 关键词搜索使用参数化 LIKE', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(mssql.query).toHaveBeenCalledTimes(1)
    const [sql, params] = mssql.query.mock.calls[0]
    expect(sql).toContain('@keyword')
    expect(sql).toContain('@storeName')
    expect(params.keyword).toBe('%张%')
    expect(params.storeName).toBeTruthy()
  })

  test('search 返回 lastPurchaseName 字段', async () => {
    const ctx = createManagerCtx({})
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: null, store_name: '测试店', main_staff_id: null, register_date: null },
    ])
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u1', phone: '13800001111', name: '张三', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])   // spendRows
      .mockResolvedValueOnce([])   // svcDateRows
      .mockResolvedValueOnce([{ client_user_id: 'u1', last_product_name: '精油SPA套餐' }]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    const item = ctx.result.find(r => r.clientUserId === 'u1')
    expect(item.lastPurchaseName).toBe('精油SPA套餐')
    // SQL 应包含 item_direction 过滤（C2：不引用当前商品价格，而是从订单行读取）
    const lastPurchaseSql = pg.query.mock.calls[3][0]
    expect(lastPurchaseSql).toContain('item_direction')
  })

  test('spendRows/svcDateRows 非空时 tier 和 lastServiceDate 被填充（lines 169-170, 183-184）', async () => {
    // 让 spendRows 和 svcDateRows 返回数据，触发 for...of 循环体
    const ctx = createManagerCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP',
        store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ client_user_id: 'u1', annual_spend: '25000' }])  // spendRows 非空
      .mockResolvedValueOnce([{ client_user_id: 'u1', service_date: '2024-05-10' }]) // svcDateRows 非空
      .mockResolvedValueOnce([])  // lastPurchaseRows

    await customerRoutes.search(ctx)

    expect(ctx.result[0].tier).toBe('diamond')          // 25000 >= 20000 → diamond
    expect(ctx.result[0].lastServiceDate).toBe('2024-05-10')
  })

  test('PG-only 用户无姓名时从 sale_orders 补全（lines 106-113）', async () => {
    // pgOnly 用户 name=null → phonesWithoutName 非空 → 查 sale_orders 补名
    const ctx = createManagerCtx({ keyword: '匿名' })
    mssql.query.mockResolvedValueOnce([]) // WorkFine 无结果
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u-anon', phone: '13700007777', name: null, customer_id: null, bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ client_phone: '13700007777', customer_name: '匿名客' }]) // nameRows 非空
      .mockResolvedValueOnce([])   // spendRows
      .mockResolvedValueOnce([])   // svcDateRows
      .mockResolvedValueOnce([])   // lastPurchaseRows

    await customerRoutes.search(ctx)

    expect(ctx.result[0].name).toBe('匿名客')
    expect(ctx.result[0].clientUserId).toBe('u-anon')
  })
})

// ============================================================
// customer.calendar
// ============================================================
describe('customer.calendar', () => {
  test('返回月度消费日历和订单', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([
      { pay_date: '2024-06-01', order_count: '2', total_received: '500.00' },
      { pay_date: '2024-06-15', order_count: '1', total_received: '300.00' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', sale_order_type: '正式', store_id: 'store-001', payment_method: '微信支付', paid_at: '2024-06-01T10:00:00Z', client_phone: '138', customer_name: '张三', pay_date: '2024-06-01', total_received: '250.00' },
    ])
    await customerRoutes.calendar(ctx)
    expect(ctx.result.year).toBe(2024)
    expect(ctx.result.month).toBe(6)
    expect(ctx.result.dailySummary).toHaveLength(2)
    expect(ctx.result.dailySummary[0].orderCount).toBe(2)
    expect(ctx.result.dailySummary[0].totalReceived).toBe(500)
    expect(ctx.result.orders).toHaveLength(1)
  })

  test('缺少 clientUserId 和 clientPhone 时拒绝', async () => {
    const ctx = createManagerCtx({ year: 2024, month: 6 })
    await expect(customerRoutes.calendar(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('缺少 year 或 month 时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    await expect(customerRoutes.calendar(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('使用 clientPhone 查询日历（lines 244-246 else 分支）', async () => {
    // clientUserId 未提供，走 else 分支用 client_phone 过滤
    const ctx = createManagerCtx({ clientPhone: '13800001111', year: 2024, month: 6 })
    pg.query
      .mockResolvedValueOnce([
        { pay_date: '2024-06-10', order_count: '1', total_received: '200.00' },
      ])
      .mockResolvedValueOnce([
        { sale_order_id: 'SO-X01', sale_order_type: '正式', store_id: 'store-001',
          payment_method: '微信支付', paid_at: '2024-06-10T12:00:00Z',
          client_phone: '13800001111', customer_name: '李四',
          pay_date: '2024-06-10', total_received: '200.00' },
      ])

    await customerRoutes.calendar(ctx)

    expect(ctx.result.dailySummary).toHaveLength(1)
    expect(ctx.result.dailySummary[0].totalReceived).toBe(200)
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('client_phone')
  })
})

// ============================================================
// customer.detail
// ============================================================
describe('customer.detail', () => {
  test('WorkFine 中找到顾客返回完整信息', async () => {
    const ctx = createManagerCtx({ id: 'C001' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: 'emp-002' },
    ])
    pg.query.mockResolvedValueOnce([{ user_id: 'u1' }])
    pg.query.mockResolvedValueOnce([{ name: '李四' }])
    pg.query.mockResolvedValueOnce([{ total: '5000' }])
    pg.query.mockResolvedValueOnce([{ total: '2000' }])
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBe('C001')
    expect(ctx.result.name).toBe('张三')
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.preferredStaffName).toBe('李四')
    expect(ctx.result.totalConsumption).toBe(5000)
    expect(ctx.result.yearConsumption).toBe(2000)
    expect(ctx.result.source).toBe('both')
  })

  test('WorkFine 无记录但 PG 有，返回 miniprogram 源', async () => {
    const ctx = createManagerCtx({ phone: '13900002222' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{ user_id: 'u2', phone: '13900002222', name: 'PG顾客', bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([{ total: '1000' }])
    pg.query.mockResolvedValueOnce([{ total: '500' }])
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBeNull()
    expect(ctx.result.clientUserId).toBe('u2')
    expect(ctx.result.name).toBe('PG顾客')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('两边都找不到时抛出错误', async () => {
    const ctx = createManagerCtx({ phone: '19900009999' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('缺少所有标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('MSSQL detail 查询使用参数化', async () => {
    const ctx = createManagerCtx({ id: 'C001' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null },
    ])
    pg.query.mockResolvedValueOnce([{ user_id: 'u1' }])
    pg.query.mockResolvedValueOnce([{ total: '0' }])
    pg.query.mockResolvedValueOnce([{ total: '0' }])
    await customerRoutes.detail(ctx)
    const [sql, params] = mssql.query.mock.calls[0]
    expect(sql).toContain('@id')
    expect(sql).not.toContain("'C001'")
    expect(params).toEqual({ id: 'C001' })
  })

  test('WorkFine 有客户但无 PG 账号时按 phone 查询消费统计（lines 480-496）', async () => {
    // 场景：WorkFine 老客户，未注册小程序，clientUserId 为 null
    const ctx = createManagerCtx({ id: 'C002' })

    mssql.query.mockResolvedValueOnce([{
      customer_id: 'C002', name: '老客户', phone: '138001', // 6位短号，同时覆盖 maskPhone line 582
      member_level: 'VIP', store_name: '测试店', main_staff_id: null,
    }])
    pg.query
      .mockResolvedValueOnce([])               // client_wechat_users → 无 PG 账号 → clientUserId 保持 null
      .mockResolvedValueOnce([{ total: '8000' }])  // getConsumptionStats else if(phone): 总消费
      .mockResolvedValueOnce([{ total: '3000' }])  // getConsumptionStats else if(phone): 年消费

    await customerRoutes.detail(ctx)

    expect(ctx.result.id).toBe('C002')
    expect(ctx.result.clientUserId).toBeNull()
    expect(ctx.result.totalConsumption).toBe(8000)
    expect(ctx.result.yearConsumption).toBe(3000)
    // maskPhone('138001') → length=6, ≤7 → '1****01'（line 582 覆盖）
    expect(ctx.result.phoneMasked).toBe('1****01')
    expect(ctx.result.source).toBe('workfine')
  })

  test('手机号全为空白时拒绝（line 411 TRUE 分支）', async () => {
    // queryPhone = '   '（空白）：truthy 通过 line 317，但 trim 后为空 → if (!phone) throw
    const ctx = createManagerCtx({ phone: '   ' })
    // mssql 默认返回 [] (beforeEach reset)，WorkFine 无记录 → 进入 PG 回退路径
    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*顾客不存在/)
  })

  test('PG 用户无姓名时从 sale_orders 补全姓名（lines 428-435）', async () => {
    const ctx = createManagerCtx({ phone: '13900003333' })
    // WorkFine 无记录（mssql 默认 []）→ PG 路径
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u3', phone: '13900003333', name: null, bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ customer_name: '陈六' }])    // sale_orders 补全名
      .mockResolvedValueOnce([{ total: '500' }])              // getConsumptionStats total
      .mockResolvedValueOnce([{ total: '200' }])              // getConsumptionStats year

    await customerRoutes.detail(ctx)

    expect(ctx.result.name).toBe('陈六')
    expect(ctx.result.clientUserId).toBe('u3')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('phone 和 clientUserId 同时提供时直接构造 pgUser（line 408 TRUE 分支）', async () => {
    // resolvedPhone='138' 且 queryClientUserId='u3' → if(resolvedPhone && queryClientUserId) TRUE
    // pgUser 由两个参数直接构造，无需再查 client_wechat_users
    const ctx = createManagerCtx({ phone: '138', clientUserId: 'u3' })
    // mssql 默认返回 [] → WorkFine 无记录 → 进入 PG 回退
    // pgUser = { user_id: 'u3', phone: '138' }，无 name 字段 → !name → 查 sale_orders
    pg.query
      .mockResolvedValueOnce([{ customer_name: '王七' }])  // sale_orders 名字
      .mockResolvedValueOnce([{ total: '300' }])           // getConsumptionStats total
      .mockResolvedValueOnce([{ total: '100' }])           // getConsumptionStats year

    await customerRoutes.detail(ctx)

    expect(ctx.result.id).toBeNull()
    expect(ctx.result.clientUserId).toBe('u3')
    expect(ctx.result.name).toBe('王七')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('仅传 clientUserId 且 PG 中不存在时拒绝（line 330-331 TRUE 分支）', async () => {
    // !id && !queryPhone && queryClientUserId → 进 line 325 分支，pg 查询为空 → throw
    const ctx = createManagerCtx({ clientUserId: 'u-nonexist' })
    pg.query.mockResolvedValueOnce([]) // client_wechat_users 无结果

    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*顾客不存在/)
  })

  test('仅传 clientUserId 且 PG 存在时回填 phone（line 333）', async () => {
    // !id && !queryPhone && queryClientUserId → 查 PG → resolvedPhone 回填
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    // 1. client_wechat_users by user_id → 回填 resolvedPhone
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u1', phone: '13800001111', name: null, bound_store_id: 'store-001' }])
      // WorkFine 默认 [] → 无记录 → resolvedPhone && resolvedClientUserId → pgUser 构造
      // pgUser.name undefined → !name → sale_orders 补名
      .mockResolvedValueOnce([{ customer_name: '赵八' }])
      .mockResolvedValueOnce([{ total: '1500' }])  // total
      .mockResolvedValueOnce([{ total: '600' }])   // year

    await customerRoutes.detail(ctx)

    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.name).toBe('赵八')
    expect(ctx.result.source).toBe('miniprogram')
  })
})

// ============================================================
// customer.paidOrders
// ============================================================
describe('customer.paidOrders', () => {
  test('按 clientUserId 返回已支付订单及明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', status: '已支付', paid_at: '2024-06-01T10:00:00Z' },
      { sale_order_id: 'SO-002', status: '已支付', paid_at: '2024-06-15T14:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', sale_item_id: 'item-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', sku_spec_name: '基础款', product_name: '面部护理' },
      { sale_order_id: 'SO-002', sale_item_id: 'item-002', session_count: 5, remaining_sessions: 5, sku_id: 'sku-2', product_type: '疗程卡', sku_spec_name: '高级款', product_name: '身体护理' },
    ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].saleOrderId).toBe('SO-001')
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[0].items[0].itemName).toBe('面部护理')
    expect(ctx.result[0].items[0].remainingSessions).toBe(8)
  })

  test('无已支付订单时返回空数组', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-empty' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toEqual([])
  })

  test('缺少 clientUserId 和 clientPhone 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.paidOrders(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('按 clientPhone 查询已支付订单', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-003', status: '已支付', paid_at: '2024-07-01T10:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-003', sale_item_id: 'item-003', session_count: 3, remaining_sessions: 3, sku_id: 'sku-3', product_type: '疗程卡', sku_spec_name: '标准', product_name: '头疗' },
    ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].saleOrderId).toBe('SO-003')
  })
})

// ============================================================
// customer.stats
// ============================================================
describe('customer.stats', () => {
  test('正确分类顾客活跃度和生日', async () => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const currentMonth = now.getMonth() + 1
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

    const ctx = createManagerCtx({})

    // 构造不同活跃度的顾客
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', birthday: `2000-${String(currentMonth).padStart(2, '0')}-15`, last_service_date: daysAgo(10) },  // active + birthday
        { user_id: 'u2', birthday: `2000-${String(nextMonth).padStart(2, '0')}-20`, last_service_date: daysAgo(40) },    // atRisk + birthdayNext
        { user_id: 'u3', birthday: null, last_service_date: daysAgo(70) },        // lost
        { user_id: 'u4', birthday: null, last_service_date: daysAgo(100) },       // sleeping
        { user_id: 'u5', birthday: null, last_service_date: null },               // sleeping (无服务记录)
      ])
      .mockResolvedValueOnce([{ cnt: '3' }]) // memberCount

    await customerRoutes.stats(ctx)

    expect(ctx.result.active).toBe(1)
    expect(ctx.result.atRisk).toBe(1)
    expect(ctx.result.lost).toBe(1)
    expect(ctx.result.sleeping).toBe(2)
    expect(ctx.result.birthday).toBe(1)
    expect(ctx.result.birthdayNext).toBe(1)
    expect(ctx.result.total).toBe(5)
    expect(ctx.result.memberCount).toBe(3)
    expect(ctx.result.flowCount).toBe(2)
  })

  test('空门店返回全零统计', async () => {
    const ctx = createManagerCtx({})

    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: '0' }])

    await customerRoutes.stats(ctx)

    expect(ctx.result.active).toBe(0)
    expect(ctx.result.atRisk).toBe(0)
    expect(ctx.result.lost).toBe(0)
    expect(ctx.result.sleeping).toBe(0)
    expect(ctx.result.total).toBe(0)
    expect(ctx.result.memberCount).toBe(0)
    expect(ctx.result.flowCount).toBe(0)
  })

  test('12月时 nextMonth 回绕到1月（覆盖 line 597 TRUE 分支）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-15'))
    try {
      const ctx = createManagerCtx({})

      pg.query
        .mockResolvedValueOnce([
          // 1月生日 → 在12月时应计入 birthdayNext
          { user_id: 'u1', birthday: '1990-01-10', last_service_date: null },
          // 12月生日 → 在12月时应计入 birthday（本月）
          { user_id: 'u2', birthday: '1990-12-05', last_service_date: null },
        ])
        .mockResolvedValueOnce([{ cnt: '0' }])

      await customerRoutes.stats(ctx)

      expect(ctx.result.birthdayNext).toBe(1)  // 1月生日在12月时算下月
      expect(ctx.result.birthday).toBe(1)      // 12月生日在12月时算本月
      expect(ctx.result.sleeping).toBe(2)      // 无服务记录→沉睡
    } finally {
      vi.useRealTimers()
    }
  })
})

// ============================================================
// customer.listByTag
// ============================================================
describe('customer.listByTag', () => {
  test('按 active 标签筛选', async () => {
    const now = new Date()
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    const ctx = createManagerCtx({ tag: 'active', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '活跃客', phone: '13800001111', birthday: null, member_level: 'VIP', last_service_date: daysAgo(5), year_consumption: '25000' },
      { user_id: 'u2', name: '流失客', phone: '13900002222', birthday: null, member_level: null, last_service_date: daysAgo(80), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers).toHaveLength(1)
    expect(ctx.result.customers[0].name).toBe('活跃客')
    expect(ctx.result.customers[0].tier).toBe('diamond') // 25000 >= 20000
  })

  test('按 sleeping 标签筛选（含无服务记录）', async () => {
    const ctx = createManagerCtx({ tag: 'sleeping', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '沉睡客', phone: '13800001111', birthday: null, member_level: null, last_service_date: null, year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers[0].tier).toBeNull() // 0 消费无 tier
  })

  test('按 birthday 标签筛选当月生日', async () => {
    const now = new Date()
    const currentMonth = now.getMonth() + 1
    const ctx = createManagerCtx({ tag: 'birthday', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '生日客', phone: '13800001111', birthday: `1990-${String(currentMonth).padStart(2, '0')}-15`, member_level: 'VIP', last_service_date: null, year_consumption: '6000' },
      { user_id: 'u2', name: '非生日客', phone: '13900002222', birthday: '1990-01-01', member_level: null, last_service_date: null, year_consumption: '100' },
    ])

    await customerRoutes.listByTag(ctx)

    // 只有当月生日的被筛选出来
    const hasBirthday = ctx.result.customers.some(c => c.name === '生日客')
    expect(hasBirthday).toBe(true)
    // 6000 >= 5000 → iron
    const birthdayCustomer = ctx.result.customers.find(c => c.name === '生日客')
    expect(birthdayCustomer.tier).toBe('iron')
  })

  test('美容师看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({ tag: 'active', page: 1, pageSize: 10 })
    const now = new Date()
    const d = new Date(now)
    d.setDate(d.getDate() - 5)

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '客户', phone: '13800001111', birthday: null, member_level: null, last_service_date: d.toISOString().slice(0, 10), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.customers[0].phone).not.toBe('13800001111')
    expect(ctx.result.customers[0].phoneMasked).toBe('138****1111')
  })

  test('分页功能正确', async () => {
    const now = new Date()
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    const ctx = createManagerCtx({ tag: 'active', page: 2, pageSize: 1 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '客A', phone: '13800001111', birthday: null, member_level: null, last_service_date: daysAgo(5), year_consumption: '0' },
      { user_id: 'u2', name: '客B', phone: '13900002222', birthday: null, member_level: null, last_service_date: daysAgo(10), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(2)
    expect(ctx.result.customers).toHaveLength(1)
    expect(ctx.result.customers[0].name).toBe('客B')
  })

  test('缺少 tag 参数时拒绝', async () => {
    const ctx = createManagerCtx({ page: 1 })
    await expect(customerRoutes.listByTag(ctx)).rejects.toThrow(/INVALID_PARAMS.*tag/)
  })

  test('tier 分级正确：fan', async () => {
    const now = new Date()
    const d = new Date(now)
    d.setDate(d.getDate() - 5)

    const ctx = createManagerCtx({ tag: 'active', page: 1 })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '粉丝客', phone: '138', birthday: null, member_level: null, last_service_date: d.toISOString().slice(0, 10), year_consumption: '100' },
    ])

    await customerRoutes.listByTag(ctx)
    expect(ctx.result.customers[0].tier).toBe('fan') // 0 < 100 < 5000
  })

  test('listByTag 返回 lastPurchaseName 字段', async () => {
    const now = new Date()
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }
    const ctx = createManagerCtx({ tag: 'active', page: 1, pageSize: 10 })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', name: '活跃客', phone: '138', birthday: null, member_level: null,
          last_service_date: daysAgo(10), year_consumption: '0' },
      ])
      // lastPurchaseRows
      .mockResolvedValueOnce([{ client_user_id: 'u1', last_product_name: '面部护理套餐' }])
    await customerRoutes.listByTag(ctx)
    expect(ctx.result.customers[0].lastPurchaseName).toBe('面部护理套餐')
  })

  test('按 birthdayNext 标签筛选下月生日客户（覆盖 lines 697-698）', async () => {
    const now = new Date()
    const currentMonth = now.getMonth() + 1
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

    const ctx = createManagerCtx({ tag: 'birthdayNext', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      // 下月生日 → 应被筛选出
      { user_id: 'u1', name: '下月生日客', phone: '13800001111',
        birthday: `1990-${String(nextMonth).padStart(2, '0')}-20`,
        member_level: null, last_service_date: null, year_consumption: '0' },
      // 本月生日 → 不应被 birthdayNext 筛选
      { user_id: 'u2', name: '本月生日客', phone: '13900002222',
        birthday: `1990-${String(currentMonth).padStart(2, '0')}-15`,
        member_level: null, last_service_date: null, year_consumption: '0' },
      // 无生日 → 不应被筛选
      { user_id: 'u3', name: '无生日客', phone: '15000003333',
        birthday: null, member_level: null, last_service_date: null, year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers[0].name).toBe('下月生日客')
  })
})

// ============================================================
// customer.refundHistory
// ============================================================
describe('customer.refundHistory', () => {
  test('返回退款和转换订单及明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    // 退换订单
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'REF-001', status: '已完成', sale_order_type: '退款',
        total_amount: '500', refund_reason: '质量问题', handling_fee: '50',
        ref_sale_order_id: 'FY-001', approved_by: 'emp-001', approved_at: '2024-06-20',
        rejected_reason: null, created_at: '2024-06-15', paid_at: null,
      },
      {
        sale_order_id: 'CVT-001', status: '已完成', sale_order_type: '转换',
        total_amount: '300', refund_reason: '更换项目', handling_fee: null,
        ref_sale_order_id: 'FY-002', approved_by: 'emp-001', approved_at: '2024-06-22',
        rejected_reason: null, created_at: '2024-06-18', paid_at: null,
      },
    ])
    // 明细
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'REF-001', sale_item_id: 'refitem-1', item_direction: 'refund', product_name: '面部护理', sku_spec_name: '基础款', quantity: 1, received: '500' },
      { sale_order_id: 'CVT-001', sale_item_id: 'cvtitem-1', item_direction: 'purchase', product_name: '身体护理', sku_spec_name: '高级款', quantity: 1, received: '300' },
    ])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].saleOrderId).toBe('REF-001')
    expect(ctx.result[0].type).toBe('退款')
    expect(ctx.result[0].handlingFee).toBe(50)
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[1].type).toBe('转换')
    expect(ctx.result[1].handlingFee).toBeNull()
  })

  test('按 clientPhone 查询', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })

    pg.query.mockResolvedValueOnce([])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toEqual([])
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('client_phone')
  })

  test('缺少标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.refundHistory(ctx)).rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('无退换记录返回空数组', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-clean' })
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.refundHistory(ctx)
    expect(ctx.result).toEqual([])
  })
})

// ============================================================
// customer.giftHistory
// ============================================================
describe('customer.giftHistory', () => {
  test('返回福利活动订单和赠品明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    // 福利活动订单
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'PROMO-001', status: '已支付', sale_order_type: '福利活动',
        total_amount: '0', created_at: '2024-06-01', paid_at: '2024-06-01',
      },
    ])
    // 赠品明细（received=0 的行）
    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'gift-001', sale_order_id: 'FY-001', product_name: '赠送面膜',
        sku_spec_name: '体验装', quantity: 1, session_count: 3, remaining_sessions: 3,
        received: '0', created_at: '2024-06-05', paid_at: '2024-06-05',
      },
    ])
    // 福利活动订单的明细
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'PROMO-001', sale_item_id: 'promo-item-1',
        product_name: '活动面部护理', sku_spec_name: '体验版',
        quantity: 1, session_count: 5, remaining_sessions: 5, received: '0',
      },
    ])

    await customerRoutes.giftHistory(ctx)

    expect(ctx.result.promoOrders).toHaveLength(1)
    expect(ctx.result.promoOrders[0].saleOrderId).toBe('PROMO-001')
    expect(ctx.result.promoOrders[0].items).toHaveLength(1)
    expect(ctx.result.promoOrders[0].items[0].productName).toBe('活动面部护理')
    expect(ctx.result.giftItems).toHaveLength(1)
    expect(ctx.result.giftItems[0].productName).toBe('赠送面膜')
  })

  test('无福利活动时 promoOrders 为空', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    pg.query.mockResolvedValueOnce([]) // 无福利活动
    pg.query.mockResolvedValueOnce([]) // 无赠品

    await customerRoutes.giftHistory(ctx)

    expect(ctx.result.promoOrders).toEqual([])
    expect(ctx.result.giftItems).toEqual([])
  })

  test('按 clientPhone 查询', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.giftHistory(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('client_phone')
  })

  test('缺少标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.giftHistory(ctx)).rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })
})
