/**
 * 顾客档案路由测试
 * 覆盖：search / calendar / detail / paidOrders / stats / listByTag / refundHistory / giftHistory
 * PG 单源架构，非店长脱敏
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx, createManagementCtx } = require('../helpers')
const customerRoutes = require('../../routes/customer')

// ============================================================
// customer.search
// ============================================================
describe('customer.search', () => {
  test('关键词搜索返回 PG 结果（含 store_name JOIN）', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
        { user_id: 'u2', phone: '13900002222', name: '张四', customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([]) // spendRows
      .mockResolvedValueOnce([]) // svcDateRows
      .mockResolvedValueOnce([]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(2)
    const zhangSan = ctx.result.find(r => r.name === '张三')
    expect(zhangSan.source).toBe('both') // customer_id 非空
    expect(zhangSan.clientUserId).toBe('u1')
    expect(zhangSan.storeName).toBe('测试店')
    const zhangSi = ctx.result.find(r => r.name === '张四')
    expect(zhangSi.source).toBe('miniprogram') // customer_id 为空
    expect(zhangSi.clientUserId).toBe('u2')
  })

  test('手机号搜索返回精确匹配', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('13800001111')
    // SQL 应使用参数化
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.phone = $1')
    expect(params).toEqual(['13800001111'])
  })

  test('美容师看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({ phone: '13800001111' })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('138****1111')
    expect(ctx.result[0].phoneMasked).toBe('138****1111')
  })

  test('无结果时返回空数组', async () => {
    const ctx = createManagerCtx({ keyword: '不存在的人' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(ctx.result).toEqual([])
  })

  test('customerType=member 只返回会员客（customer_id 非空）', async () => {
    const ctx = createManagerCtx({ customerType: 'member' })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '会员张', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].source).toBe('both')
    // PG SQL 应包含 customer_id IS NOT NULL 过滤
    const pgSql = pg.query.mock.calls[0][0]
    expect(pgSql).toContain('customer_id IS NOT NULL')
  })

  test('customerType=flow 只返回流量客（customer_id 为空）', async () => {
    const ctx = createManagerCtx({ customerType: 'flow' })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u3', phone: '13700003333', name: '流量客', customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].source).toBe('miniprogram')
    // PG SQL 应包含 customer_id IS NULL 过滤
    const pgSql = pg.query.mock.calls[0][0]
    expect(pgSql).toContain('customer_id IS NULL')
  })

  test('search 返回 lastPurchaseName 字段', async () => {
    const ctx = createManagerCtx({})
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([])   // spendRows
      .mockResolvedValueOnce([])   // svcDateRows
      .mockResolvedValueOnce([{ client_user_id: 'u1', last_product_name: '精油SPA套餐' }]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    const item = ctx.result.find(r => r.clientUserId === 'u1')
    expect(item.lastPurchaseName).toBe('精油SPA套餐')
    // SQL 应包含 item_direction 过滤
    const lastPurchaseSql = pg.query.mock.calls[3][0]
    expect(lastPurchaseSql).toContain('item_direction')
  })

  test('spendRows/svcDateRows 非空时 tier 和 lastServiceDate 被填充', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([{ client_user_id: 'u1', annual_spend: '25000' }])  // spendRows 非空
      .mockResolvedValueOnce([{ client_user_id: 'u1', service_date: '2024-05-10' }]) // svcDateRows 非空
      .mockResolvedValueOnce([])  // lastPurchaseRows

    await customerRoutes.search(ctx)

    expect(ctx.result[0].tier).toBe('diamond')          // 25000 >= 20000 → diamond
    expect(ctx.result[0].lastServiceDate).toBe('2024-05-10')
  })

  test('PG 查询使用参数化且 JOIN stores', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('LEFT JOIN stores')
    expect(sql).toContain('s.store_name')
    expect(sql).toContain('$1')
    expect(sql).toContain('$2')
    expect(params[0]).toBe('%张%')
    expect(params[1]).toBe(ctx.auth.storeId)
  })

  test('默认列表按 bound_store_id 过滤', async () => {
    const ctx = createManagerCtx({})
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.bound_store_id = $1')
    expect(params[0]).toBe(ctx.auth.storeId)
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
      { sale_order_id: 'SO-001', sale_order_type: '销售单', store_id: 'store-001', payment_method: '微信支付', paid_at: '2024-06-01T10:00:00Z', client_phone: '138', customer_name: '张三', pay_date: '2024-06-01', total_received: '250.00' },
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

  test('使用 clientPhone 查询日历（else 分支）', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111', year: 2024, month: 6 })
    pg.query
      .mockResolvedValueOnce([
        { pay_date: '2024-06-10', order_count: '1', total_received: '200.00' },
      ])
      .mockResolvedValueOnce([
        { sale_order_id: 'SO-X01', sale_order_type: '销售单', store_id: 'store-001',
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

  // ── scope isolation ──
  test('SQL 包含 store_id scope 条件（门店模式 = 单值）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.calendar(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/o\.store_id\s*=\s*\$/)
    expect(params).toContain('store-001')
  })

  test('管理模式 SQL 使用 ANY(scopeStoreIds)', async () => {
    const ctx = createManagementCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.calendar(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/o\.store_id\s*=\s*ANY\(\$/)
    expect(params).toContainEqual(['store-001', 'store-002'])
  })
})

// ============================================================
// customer.detail
// ============================================================
describe('customer.detail', () => {
  test('按 customer_id 查找返回完整信息（含 gender/storeName/notes）', async () => {
    const ctx = createManagerCtx({ id: 'C001' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001',
        member_level: 'VIP', bound_employee_id: 'emp-002', skin_type: '干性', improvement_focus: '保湿',
        gender: '女', notes: '过敏体质', bound_store_id: 'store-001', store_name: '南昌旗舰店',
      }])
      .mockResolvedValueOnce([{ name: '李四' }])  // preferredStaffName
      .mockResolvedValueOnce([{ total: '5000', year_total: '2000' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: '2026-03-10', visit_count_90d: '8' }])  // getVisitInfo
      .mockResolvedValueOnce([{ product_name: '蜜语生玑10次卡', cnt: '5' }])  // getTopProduct
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBe('C001')
    expect(ctx.result.name).toBe('张三')
    expect(ctx.result.gender).toBe('女')
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.storeName).toBe('南昌旗舰店')
    expect(ctx.result.preferredStaffName).toBe('李四')
    expect(ctx.result.skinType).toBe('干性')
    expect(ctx.result.focusAreas).toBe('保湿')
    expect(ctx.result.notes).toBe('过敏体质')
    expect(ctx.result.lastServiceDate).toBe('2026-03-10')
    expect(ctx.result.visitFrequency).toBe('两周一次')  // 8 visits in 90 days
    expect(ctx.result.topProductName).toBe('蜜语生玑10次卡')
    expect(ctx.result.totalConsumption).toBe(5000)
    expect(ctx.result.yearConsumption).toBe(2000)
    expect(ctx.result.source).toBe('both')
  })

  test('按 clientUserId 查找返回 miniprogram 源', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u2' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u2', phone: '13900002222', name: 'PG顾客', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '1000', year_total: '500' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])  // getVisitInfo
      .mockResolvedValueOnce([])  // getTopProduct — 无购买记录
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBeNull()
    expect(ctx.result.clientUserId).toBe('u2')
    expect(ctx.result.name).toBe('PG顾客')
    expect(ctx.result.gender).toBeNull()
    expect(ctx.result.storeName).toBe('')
    expect(ctx.result.notes).toBeNull()
    expect(ctx.result.lastServiceDate).toBeNull()
    expect(ctx.result.visitFrequency).toBeNull()  // 0 visits → null
    expect(ctx.result.topProductName).toBeNull()
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('按 phone 查找（customer_id 存在时 source=both）', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001',
        member_level: 'VIP', bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '3000', year_total: '1500' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])  // getVisitInfo
      .mockResolvedValueOnce([])  // getTopProduct
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBe('C001')
    expect(ctx.result.source).toBe('both')
  })

  test('找不到顾客时抛出错误', async () => {
    const ctx = createManagerCtx({ phone: '19900009999' })
    pg.query.mockResolvedValueOnce([])
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('缺少所有标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('PG 查询使用参数化且 JOIN stores', async () => {
    const ctx = createManagerCtx({ id: 'C001' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '138', name: '张三', customer_id: 'C001',
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])
    await customerRoutes.detail(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('$1')
    expect(sql).toContain('LEFT JOIN stores')
    expect(sql).toContain('s.store_name')
    expect(sql).not.toContain("'C001'")
    expect(params).toEqual(['C001'])
  })

  test('无 bound_employee_id 时 preferredStaffName 为 null', async () => {
    const ctx = createManagerCtx({ id: 'C002' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '138001', name: '老客户', customer_id: 'C002',
        member_level: 'VIP', bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '8000', year_total: '3000' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])

    await customerRoutes.detail(ctx)

    expect(ctx.result.id).toBe('C002')
    expect(ctx.result.preferredStaffName).toBeNull()
    expect(ctx.result.totalConsumption).toBe(8000)
    expect(ctx.result.yearConsumption).toBe(3000)
    // 新 maskPhone（pii.js v2，2026-05-18 起）：length 6 ≤ 7 走"首末保留"分支，
    // 返回 s[0] + '*' × (len-2) + s[-1] = '1****1'（6 字符，与输入等长）。
    // 旧实现返回 '1****01'（7 字符，比输入还长）— 是 bug，本 ticket 一并修正。
    expect(ctx.result.phoneMasked).toBe('1****1')
  })

  test('手机号全为空白时拒绝', async () => {
    const ctx = createManagerCtx({ phone: '   ' })
    pg.query.mockResolvedValueOnce([])  // phone.trim() = '' → 查不到
    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*顾客不存在/)
  })

  test('PG 用户无姓名时从 sale_orders 补全姓名', async () => {
    const ctx = createManagerCtx({ phone: '13900003333' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u3', phone: '13900003333', name: null, customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ customer_name: '陈六' }])    // sale_orders 补全名
      .mockResolvedValueOnce([{ total: '500', year_total: '200' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])

    await customerRoutes.detail(ctx)

    expect(ctx.result.name).toBe('陈六')
    expect(ctx.result.clientUserId).toBe('u3')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('clientUserId 不存在时 fallback 到 phone 查找', async () => {
    const ctx = createManagerCtx({ phone: '13800001111', clientUserId: 'u-nonexist' })
    pg.query
      .mockResolvedValueOnce([])  // by customer_id: skip (no id)
      // Actually: no id → skip first if; then clientUserId → query → empty
    // Correction: no `id`, so skip first block. Then `clientUserId='u-nonexist'` → query PG → empty.
    // Then phone='13800001111' → query PG → found
    pg.query.mockReset()
    pg.query
      .mockResolvedValueOnce([])  // by user_id u-nonexist → not found
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '13800001111', name: '王七', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '300', year_total: '100' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])

    await customerRoutes.detail(ctx)

    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.name).toBe('王七')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('仅传 clientUserId 且不存在时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-nonexist' })
    pg.query.mockResolvedValueOnce([]) // by user_id → not found

    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*顾客不存在/)
  })

  test('getConsumptionStats 使用单次查询（含 CASE WHEN 年度过滤）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '138', name: '测试', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '10000', year_total: '4000' }])  // single query
      .mockResolvedValueOnce([{ last_date: '2026-03-01', visit_count_90d: '3' }])  // getVisitInfo
      .mockResolvedValueOnce([{ product_name: '精油SPA', cnt: '3' }])  // getTopProduct

    await customerRoutes.detail(ctx)

    expect(ctx.result.totalConsumption).toBe(10000)
    expect(ctx.result.yearConsumption).toBe(4000)
    expect(ctx.result.visitFrequency).toBe('一月一次')  // 3 visits in 90d
    expect(ctx.result.topProductName).toBe('精油SPA')
    // 验证 getConsumptionStats 使用 CASE WHEN
    const consumptionCall = pg.query.mock.calls[1]
    expect(consumptionCall[0]).toContain('CASE WHEN')
    // 4 次 pg.query: detail + consumption + visitInfo + topProduct
    expect(pg.query).toHaveBeenCalledTimes(4)
  })

  test('到店频率分级：12次→一周一次以上，1次→偶尔到店', async () => {
    // 高频客户
    const ctx1 = createManagerCtx({ clientUserId: 'u-freq' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u-freq', phone: '138', name: '高频客', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])
      .mockResolvedValueOnce([{ last_date: '2026-03-14', visit_count_90d: '15' }])  // 15次 → 一周一次以上
      .mockResolvedValueOnce([])
    await customerRoutes.detail(ctx1)
    expect(ctx1.result.visitFrequency).toBe('一周一次以上')

    // 低频客户
    const ctx2 = createManagerCtx({ clientUserId: 'u-rare' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u-rare', phone: '139', name: '低频客', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])
      .mockResolvedValueOnce([{ last_date: '2026-02-01', visit_count_90d: '1' }])  // 1次 → 偶尔到店
      .mockResolvedValueOnce([])
    await customerRoutes.detail(ctx2)
    expect(ctx2.result.visitFrequency).toBe('偶尔到店')
  })

  test('仅传 clientUserId 时正确返回', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '13800001111', name: '赵八', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{ total: '1500', year_total: '600' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])

    await customerRoutes.detail(ctx)

    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.name).toBe('赵八')
    expect(ctx.result.source).toBe('miniprogram')
  })

  // ── scope isolation ──
  test('跨店顾客被拒绝（bound_store_id 不匹配）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-other-store' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'u-other-store', phone: '138', name: '他店客', customer_id: null,
      member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
      gender: null, notes: null, bound_store_id: 'store-999', store_name: '他店',
    }])
    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不在当前门店范围内/)
  })

  test('管理模式下 scope 内多店顾客可访问', async () => {
    const ctx = createManagementCtx({ clientUserId: 'u-store2' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u-store2', phone: '139', name: '二店客', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: 'store-002', store_name: '二店',
      }])
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])
    await customerRoutes.detail(ctx)
    expect(ctx.result.clientUserId).toBe('u-store2')
  })

  test('管理模式下 scope 外顾客被拒绝', async () => {
    const ctx = createManagementCtx({ clientUserId: 'u-out' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'u-out', phone: '137', name: '范围外', customer_id: null,
      member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
      gender: null, notes: null, bound_store_id: 'store-999', store_name: '远店',
    }])
    await expect(customerRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不在当前门店范围内/)
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

  test('跨店过滤 — SQL WHERE 含 store_id 且用当前员工门店；返回含 storeId/storeName', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-multi-store' })
    let ordersSql = ''
    let ordersParams = []
    pg.query.mockImplementation(async (sql, params) => {
      const s = typeof sql === 'string' ? sql : ''
      // 主订单查询：FROM sale_orders o
      if (/FROM\s+sale_orders\s+o\b/.test(s)) {
        ordersSql = s
        ordersParams = params || []
        return [
          { sale_order_id: 'SO-HOME', status: '已支付', paid_at: '2024-06-01T10:00:00Z', store_id: 'store-001', store_name: '测试店' },
        ]
      }
      // items 查询：FROM sale_items si
      return [
        { sale_order_id: 'SO-HOME', sale_item_id: 'item-home', store_id: 'store-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', sku_spec_name: '基础', product_name: '面部护理' },
      ]
    })
    await customerRoutes.paidOrders(ctx)
    // SQL 含 store_id 过滤
    expect(ordersSql).toMatch(/o\.store_id\s*=\s*\$2/)
    // 参数带上当前员工门店
    expect(ordersParams).toContain('store-001')
    // 返回字段含 storeId/storeName
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].storeId).toBe('store-001')
    expect(ctx.result[0].storeName).toBe('测试店')
    expect(ctx.result[0].items[0].storeId).toBe('store-001')
  })
})

// ============================================================
// customer.stats
// ============================================================
describe('customer.stats', () => {
  test('正确分类顾客活跃度和生日', async () => {
    const now = new Date()
    const currentMonth = now.getMonth() + 1
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

    const ctx = createManagerCtx({})

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

  test('12月时 nextMonth 回绕到1月', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-15'))
    try {
      const ctx = createManagerCtx({})

      pg.query
        .mockResolvedValueOnce([
          { user_id: 'u1', birthday: '1990-01-10', last_service_date: null },
          { user_id: 'u2', birthday: '1990-12-05', last_service_date: null },
        ])
        .mockResolvedValueOnce([{ cnt: '0' }])

      await customerRoutes.stats(ctx)

      expect(ctx.result.birthdayNext).toBe(1)
      expect(ctx.result.birthday).toBe(1)
      expect(ctx.result.sleeping).toBe(2)
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

    const hasBirthday = ctx.result.customers.some(c => c.name === '生日客')
    expect(hasBirthday).toBe(true)
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

  test('按 birthdayNext 标签筛选下月生日客户', async () => {
    const now = new Date()
    const currentMonth = now.getMonth() + 1
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

    const ctx = createManagerCtx({ tag: 'birthdayNext', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '下月生日客', phone: '13800001111',
        birthday: `1990-${String(nextMonth).padStart(2, '0')}-20`,
        member_level: null, last_service_date: null, year_consumption: '0' },
      { user_id: 'u2', name: '本月生日客', phone: '13900002222',
        birthday: `1990-${String(currentMonth).padStart(2, '0')}-15`,
        member_level: null, last_service_date: null, year_consumption: '0' },
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
  // refundHistory 拆分为 3 query —
  //   1) sale_order_payments[change_type='退款'] JOIN sale_orders（refund_reason / audit_* / note 在主表）
  //   2) sale_orders[type='转换单']
  //   3) sale_items（按 convOrderIds ANY）
  // 返回扁平数组，按 createdAt 倒序合并退款和转换单。

  test('返回退款流水（sale_order_payments）和转换单（sale_orders）— 新模型', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    // Q1: 退款流水（来自 sale_order_payments JOIN sale_orders）
    pg.query.mockResolvedValueOnce([
      {
        payment_id: 101, sale_order_id: 'FY-001',
        amount: '-500', status: '已支付',
        created_at: '2024-06-15T10:00:00Z', paid_at: '2024-06-20T10:00:00Z',
        payment_method: '线下',
        refund_reason: '质量问题',
        audit_at: '2024-06-20T10:00:00Z',
        audit_remark: null,
        detail_note: JSON.stringify({
          _v: 1,
          handlingFee: 50,
          refundByCard: 0,
          refundByOrigin: 500,
          items: [{
            refSaleItemId: 'refitem-1',
            quantity: 1,
            refundAmount: 500,
            productType: '疗程卡',
          }],
        }),
        client_user_id: 'u1',
        store_id: 'store-001',
      },
    ])
    // Q2: 转换单（来自 sale_orders）
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'CVT-001', status: '已完成', sale_order_type: '转换单',
        total_amount: '300', created_at: '2024-06-18T10:00:00Z', paid_at: '2024-06-22T10:00:00Z',
      },
    ])
    // Q3: 转换单明细
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'CVT-001', sale_item_id: 'cvtitem-1', item_direction: '购买', product_name: '身体护理', sku_spec_name: '高级款', quantity: 1, received: '300' },
    ])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toHaveLength(2)
    // 排序：退款 createdAt 2024-06-18（CVT）> 2024-06-15（refund）→ CVT 在前
    const cvt = ctx.result.find(r => r.saleOrderId === 'CVT-001')
    const refund = ctx.result.find(r => r.paymentId === 101)
    expect(cvt).toBeDefined()
    expect(cvt.type).toBe('转换单')
    expect(cvt.items).toHaveLength(1)
    expect(refund).toBeDefined()
    expect(refund.type).toBe('退款')
    expect(refund.totalAmount).toBe(-500)
    expect(refund.handlingFee).toBe(50)
    expect(refund.items).toHaveLength(1)
    expect(refund.items[0].refSaleItemId).toBe('refitem-1')
  })

  test('退款流水 4 状态完整展示（待审批 / 已支付 / 已作废）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([
      {
        payment_id: 1, sale_order_id: 'FY-001',
        amount: '-100', status: '待审批',
        created_at: '2024-06-15T10:00:00Z', paid_at: null,
        payment_method: '线下',
        refund_reason: '原因A', audit_at: null, audit_remark: null,
        detail_note: null,
        client_user_id: 'u1', store_id: 'store-001',
      },
      {
        payment_id: 2, sale_order_id: 'FY-002',
        amount: '-200', status: '已支付',
        created_at: '2024-06-16T10:00:00Z', paid_at: '2024-06-17T10:00:00Z',
        payment_method: '线下',
        refund_reason: '原因B', audit_at: '2024-06-17T10:00:00Z', audit_remark: '同意',
        detail_note: null,
        client_user_id: 'u1', store_id: 'store-001',
      },
      {
        payment_id: 3, sale_order_id: 'FY-003',
        amount: '-300', status: '已作废',
        created_at: '2024-06-17T10:00:00Z', paid_at: null,
        payment_method: '线下',
        refund_reason: '原因C', audit_at: '2024-06-17T11:00:00Z', audit_remark: '驳回原因',
        detail_note: null,
        client_user_id: 'u1', store_id: 'store-001',
      },
    ])
    pg.query.mockResolvedValueOnce([])  // 转换单

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toHaveLength(3)
    const pending = ctx.result.find(r => r.paymentId === 1)
    const paid = ctx.result.find(r => r.paymentId === 2)
    const voided = ctx.result.find(r => r.paymentId === 3)
    expect(pending.status).toBe('待审批')
    expect(paid.status).toBe('已支付')
    expect(paid.approvedAt).toBe('2024-06-17T10:00:00Z')
    expect(voided.status).toBe('已作废')
    expect(voided.rejectedReason).toBe('驳回原因')
    // 待审批 / 已支付 状态下 rejectedReason 为 null（按源码：仅已作废返回 audit_remark）
    expect(pending.rejectedReason).toBeNull()
    expect(paid.rejectedReason).toBeNull()
  })

  test('store_id scope 过滤生效 — SQL WHERE 含 so.store_id', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([])  // 退款
    pg.query.mockResolvedValueOnce([])  // 转换单

    await customerRoutes.refundHistory(ctx)

    // 第 1 个 query 应该是退款 SQL，包含 store_id 过滤（effectiveStoreId='store-001'）
    const [refundSql, refundParams] = pg.query.mock.calls[0]
    expect(refundSql).toMatch(/sop\.change_type\s*=\s*'退款'/)
    expect(refundSql).toMatch(/FROM\s+sale_order_payments\s+sop/i)
    expect(refundSql).toMatch(/sop\.refund_reason/i)
    expect(refundSql).toMatch(/so\.store_id\s*=/)
    // params: [clientUserId, storeId, pageSize, offset]
    expect(refundParams).toContain('store-001')
  })

  test('detail_note 解析失败时 items=[]，不抛错', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([
      {
        payment_id: 1, sale_order_id: 'FY-001',
        amount: '-100', status: '已支付',
        created_at: '2024-06-15T10:00:00Z', paid_at: '2024-06-15T10:00:00Z',
        payment_method: '线下',
        refund_reason: '原因', audit_at: null, audit_remark: null,
        detail_note: 'invalid-json{{{',  // 触发 try-catch
        client_user_id: 'u1', store_id: 'store-001',
      },
    ])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].items).toEqual([])
    expect(ctx.result[0].handlingFee).toBeNull()
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
  test('返回组合套餐订单和赠品明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'PROMO-001', status: '已支付', sale_order_type: '销售单',
        total_amount: '0', created_at: '2024-06-01', paid_at: '2024-06-01',
      },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'gift-001', sale_order_id: 'FY-001', product_name: '赠送面膜',
        sku_spec_name: '体验装', quantity: 1, session_count: 3, remaining_sessions: 3,
        received: '0', created_at: '2024-06-05', paid_at: '2024-06-05',
      },
    ])
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

  test('无组合套餐时 promoOrders 为空', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    pg.query.mockResolvedValueOnce([]) // 无组合套餐
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

  // ── scope isolation ──
  test('SQL 包含 store_id scope 条件', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.giftHistory(ctx)
    // giftItems 查询是第 2 个 call（第 1 个是 promoOrders）
    const giftSql = pg.query.mock.calls[1][0]
    expect(giftSql).toMatch(/o\.store_id\s*=\s*\$/)
  })

  test('管理模式 SQL 使用 ANY(scopeStoreIds)', async () => {
    const ctx = createManagementCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.giftHistory(ctx)
    const giftSql = pg.query.mock.calls[1][0]
    expect(giftSql).toMatch(/o\.store_id\s*=\s*ANY\(\$/)
  })
})

// ============================================================
// customer.updateNotes
// ============================================================
describe('customer.updateNotes', () => {
  // 调用流：assertCustomerInScope(SELECT bound_store_id) → UPDATE → INSERT operation_logs
  // helper 期望 pg.query 返回数组（与 db/pg.js wrapper 一致）
  const mockScopeOk = (storeId = 'store-001') =>
    pg.query.mockResolvedValueOnce([{ bound_store_id: storeId }])

  test('保存备注成功', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: '过敏体质，注意精油用量' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([]) // UPDATE
    pg.query.mockResolvedValueOnce([]) // audit log

    await customerRoutes.updateNotes(ctx)

    expect(ctx.result.message).toContain('备注已保存')
    const [sql, params] = pg.query.mock.calls[1]
    expect(sql).toContain('UPDATE client_wechat_users')
    expect(sql).toContain('notes = $1')
    expect(params[0]).toBe('过敏体质，注意精油用量')
    expect(params[1]).toBe('u1')
  })

  test('空备注保存为 null', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: '   ' })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.updateNotes(ctx)

    expect(ctx.result.message).toContain('备注已保存')
    expect(pg.query.mock.calls[1][1][0]).toBeNull()  // trimmed empty → null
  })

  test('备注超过500字截断', async () => {
    const longNotes = 'a'.repeat(600)
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: longNotes })

    mockScopeOk()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.updateNotes(ctx)

    expect(pg.query.mock.calls[1][1][0]).toHaveLength(500)
  })

  test('顾客不存在时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-nonexist', notes: 'test' })

    pg.query.mockResolvedValueOnce([])  // helper SELECT 命中 0 行

    await expect(customerRoutes.updateNotes(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不存在/)
  })

  test('顾客跨店时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-other', notes: 'test' })

    mockScopeOk('store-002')  // 不在当前 scope（store-001）

    await expect(customerRoutes.updateNotes(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不在当前门店范围内/)
  })

  test('缺少 clientUserId 时拒绝', async () => {
    const ctx = createManagerCtx({ notes: 'test' })
    await expect(customerRoutes.updateNotes(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('notes 非字符串时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: 123 })
    await expect(customerRoutes.updateNotes(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*notes/)
  })

  // ── scope isolation ──
  test('scope 守卫：先调用 assertCustomerInScope（SELECT bound_store_id）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: 'test' })
    mockScopeOk()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.updateNotes(ctx)
    const [scopeSql, scopeParams] = pg.query.mock.calls[0]
    expect(scopeSql).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
    expect(scopeParams).toEqual(['u1'])
  })

  test('成功时写入 operation_logs 审计日志', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: '审计测试' })
    mockScopeOk()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.updateNotes(ctx)
    const [auditSql, auditParams] = pg.query.mock.calls[2]
    expect(auditSql).toContain('operation_logs')
    expect(auditParams[0]).toBe('customer.updateNotes')
    expect(auditParams[2]).toBe('u1')
  })

  test('美容师无法操作（requireManager）', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1', notes: 'test' })
    await expect(customerRoutes.updateNotes(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// customer.assign
// ============================================================
describe('customer.assign', () => {
  // 调用流：
  //   1. assertCustomerInScope → SELECT bound_store_id FROM client_wechat_users
  //   2. assertEmployeeInScope → SELECT store_id FROM staff_wechat_users
  //      （ctx.auth.staffWfId === targetEmployeeId 时 helper 不查 DB，直接返回）
  //   3. SELECT name FROM staff_wechat_users
  //   4. UPDATE client_wechat_users
  //   5. INSERT operation_logs
  const mockAssertChain = (boundStoreId = 'store-001', empStoreId = 'store-001') => {
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: boundStoreId }])  // assertCustomerInScope
      .mockResolvedValueOnce([{ store_id: empStoreId }])           // assertEmployeeInScope
  }

  test('店长分配顾客给美容师成功', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', employeeId: 'emp-b1' })

    mockAssertChain()
    pg.query
      .mockResolvedValueOnce([{ name: '李四' }])  // SELECT name
      .mockResolvedValueOnce([])                  // UPDATE
      .mockResolvedValueOnce([])                  // audit

    await customerRoutes.assign(ctx)

    expect(ctx.result.message).toContain('分配成功')
    expect(ctx.result.employeeName).toBe('李四')
    // call[3] = UPDATE
    const [sql, params] = pg.query.mock.calls[3]
    expect(sql).toContain('bound_employee_id = $1')
    expect(params[0]).toBe('emp-b1')
    expect(params[1]).toBe('u1')
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1', employeeId: 'emp-b1' })
    await expect(customerRoutes.assign(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('员工不在 scope 时拒绝（assertEmployeeInScope）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', employeeId: 'emp-other' })

    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])  // customer OK
      .mockResolvedValueOnce([{ store_id: 'store-002' }])         // employee in other store

    await expect(customerRoutes.assign(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*员工不在当前门店范围内/)
  })

  test('顾客不存在时拒绝（assertCustomerInScope）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-nonexist', employeeId: 'emp-b1' })

    pg.query.mockResolvedValueOnce([])  // customer not found

    await expect(customerRoutes.assign(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不存在/)
  })

  test('缺少 clientUserId 时拒绝', async () => {
    const ctx = createManagerCtx({ employeeId: 'emp-b1' })
    await expect(customerRoutes.assign(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('缺少 employeeId 时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    await expect(customerRoutes.assign(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*employeeId/)
  })

  // ── scope isolation ──
  test('scope 守卫：assertCustomerInScope + assertEmployeeInScope 双查', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', employeeId: 'emp-b1' })
    mockAssertChain()
    pg.query
      .mockResolvedValueOnce([{ name: '李四' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await customerRoutes.assign(ctx)
    const [customerScopeSql, customerScopeParams] = pg.query.mock.calls[0]
    expect(customerScopeSql).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
    expect(customerScopeParams).toEqual(['u1'])
    const [empScopeSql, empScopeParams] = pg.query.mock.calls[1]
    expect(empScopeSql).toMatch(/store_id\s+FROM\s+staff_wechat_users/i)
    expect(empScopeParams).toEqual(['emp-b1'])
  })

  test('成功时写入 operation_logs 审计日志', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', employeeId: 'emp-b1' })
    mockAssertChain()
    pg.query
      .mockResolvedValueOnce([{ name: '李四' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await customerRoutes.assign(ctx)
    const [auditSql, auditParams] = pg.query.mock.calls[4]
    expect(auditSql).toContain('operation_logs')
    expect(auditParams[0]).toBe('customer.assign')
    expect(auditParams[2]).toBe('u1')
    const detail = JSON.parse(auditParams[3])
    expect(detail.employeeId).toBe('emp-b1')
    expect(detail.employeeName).toBe('李四')
  })
})

// ============================================================
// customer.customerBalance — 2026-04-24 新增：店长查顾客储值卡余额（跨店共享）
// ============================================================
describe('customer.customerBalance', () => {
  test('店长查询已有卡的顾客余额（跨店统一）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-001' })

    pg.query.mockResolvedValueOnce([
      { card_id: 'card-001', balance: '320.50' },
    ])

    await customerRoutes.customerBalance(ctx)

    expect(ctx.result.cardId).toBe('card-001')
    expect(ctx.result.balance).toBe(320.5)
    // 查询仅按 user_id（无 store_id 条件）
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/FROM prepaid_cards WHERE user_id = \$1/)
    expect(sql).not.toMatch(/store_id/)
    expect(params).toEqual(['cu-001'])
  })

  test('无卡顾客返回 { cardId: null, balance: 0 }', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-nocard' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.customerBalance(ctx)

    expect(ctx.result).toEqual({ cardId: null, balance: 0 })
  })

  test('balance 返回为数字类型（Number 转换）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-002' })
    pg.query.mockResolvedValueOnce([{ card_id: 'card-002', balance: '1500.00' }])
    await customerRoutes.customerBalance(ctx)

    expect(typeof ctx.result.balance).toBe('number')
    expect(ctx.result.balance).toBe(1500)
  })

  test('非店长（美容师）拒绝', async () => {
    const ctx = createBeauticianCtx({ customerUserId: 'cu-001' })
    await expect(customerRoutes.customerBalance(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 customerUserId 拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.customerBalance(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*customerUserId/)
  })
})
