/**
 * 顾客档案路由测试
 * 覆盖：search / calendar / detail / paidOrders / stats / listByTag / refundHistory / updateName / appointments / phoneChangeLogs / coupons
 * PG 单源架构，非店长脱敏
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx, createManagementCtx } = require('../helpers')
const customerRoutes = require('../../routes/customer')
const { assertPaymentAttributionReady, __resetAttributionGuardCache } = require('../../utils/attribution-guard')

/**
 * #141：年度消费直读款项归属日期，跑 SQL 前会过 attribution-guard 探针。
 * guard **只缓存「已就绪」**，所以这里预热一次，之后整个文件的测试都不再发探针查询，
 * 既有 mock 的调用序列/索引全部不受影响。
 * （预热本身会占一次 pg.query，但它在 beforeAll 里、早于任何用例的 mock 设置。）
 * guard 本身的行为（未就绪时拦截）另有专门用例覆盖。
 */
beforeAll(async () => {
  pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: true }])
  await assertPaymentAttributionReady(pg)
})


// ============================================================
// customer.search
// ============================================================
/**
 * #141：本文件用 beforeAll 预热 guard（使既有用例零改动），
 * 但那样 guard 在全文件变成 no-op —— 把调用挪走也不会有用例变红。
 * 这里补一条**行为**用例，显式重置缓存后验证 fail-closed。
 */
describe('customer.detail 年度消费的迁移就绪守卫（#141）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAttributionGuardCache()
  })

  afterAll(async () => {
    // 复原就绪态，避免影响本文件其余用例
    __resetAttributionGuardCache()
    pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: true }])
    await assertPaymentAttributionReady(pg)
  })

  test('未迁移库拒绝出数（不给运营看负数年度消费）', async () => {
    // 按 SQL 内容分发，不依赖 detail 内部的查询顺序
    pg.query.mockImplementation(async (sql) => {
      if (/has_gap/.test(sql)) return [{ has_gap: true, trigger_ready: false }]
      if (/FROM\s+client_wechat_users/.test(sql)) {
        return [{ user_id: 'u1', customer_id: 'C001', name: '张三', phone: '13800001111' }]
      }
      return []
    })
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    // 确认探针确实发了（守卫真的被调用，不是别的原因抛错）
    expect(pg.query.mock.calls.some(([sql]) => /has_gap/.test(sql)), '守卫未被调用').toBe(true)
  })
})

describe('customer.search', () => {
  test('关键词搜索返回 PG 结果（含 store_name JOIN）', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
        { user_id: 'u2', phone: '13900002222', name: '张四', customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([]) // svcDateRows
      .mockResolvedValueOnce([]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(2)
    const zhangSan = ctx.result.find(r => r.name === '张三')
    expect(zhangSan.source).toBe('both') // customer_id 非空
    expect(zhangSan.clientUserId).toBe('u1')
    expect(zhangSan.storeName).toBe('测试店')
    expect(zhangSan.boundStoreId).toBe('store-001') // 供前端实时比对当前门店
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

  test('管理模式默认列表用 ANY(scopeStoreIds) 且不按员工收紧（回归：effectiveStoreId=null 致空数组）', async () => {
    // loginLevel=management, effectiveStoreId=null, scopeStoreIds=['store-001','store-002']
    const ctx = createManagementCtx({ profileScope: true })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '李一', customer_id: 'C001', member_level: null, bound_store_id: 'store-002', store_name: '二店' },
      ])
      .mockResolvedValueOnce([]) // svcDateRows
      .mockResolvedValueOnce([]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/c\.bound_store_id\s*=\s*ANY\(\$1::text\[\]\)/)
    expect(sql).not.toContain('bound_employee_id') // market 层不按员工收紧
    expect(params).toContainEqual(['store-001', 'store-002'])
    expect(ctx.result).toHaveLength(1) // 修复前 effectiveStoreId=null → 空数组
  })

  test('管理模式 keyword 检索门店范围用 ANY(scopeStoreIds)（$2 起）', async () => {
    const ctx = createManagementCtx({ keyword: '李' })
    pg.query.mockResolvedValueOnce([]) // 主查询空 → 不发后续补充查询
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/c\.bound_store_id\s*=\s*ANY\(\$2::text\[\]\)/)
    expect(params).toEqual(['%李%', ['store-001', 'store-002'], 20, 0])
  })

  test('customerType=会员客 按 customer_type 枚举等值过滤', async () => {
    const ctx = createManagerCtx({ customerType: '会员客' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    // 默认列表分支：$1=门店，$2=customer_type，$3=LIMIT
    expect(sql).toContain('c.customer_type = $2')
    expect(sql).not.toContain('customer_id IS NOT NULL')
    expect(params).toEqual(['store-001', '会员客', 20, 0])
  })

  test('customerType=all 不追加 customer_type 过滤', async () => {
    const ctx = createManagerCtx({ customerType: 'all' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).not.toContain('c.customer_type =')
    expect(params).toEqual(['store-001', 20, 0])
  })

  test('spendingTier / monthlyActivity / customerStatus 多维度 AND 叠加（默认分支）', async () => {
    const ctx = createManagerCtx({
      spendingTier: '10W+',
      monthlyActivity: '一次客活',
      customerStatus: '沉睡',
    })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.spending_tier = $2')
    expect(sql).toContain('c.monthly_activity = $3')
    expect(sql).toContain('c.customer_status = $4')
    expect(sql).toContain('LIMIT $5 OFFSET $6')
    expect(params).toEqual(['store-001', '10W+', '一次客活', '沉睡', 20, 0])
  })

  test('非法枚举值被忽略（不追加条件）', async () => {
    const ctx = createManagerCtx({ spendingTier: '999W', customerStatus: 'foo' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).not.toContain('c.spending_tier')
    expect(sql).not.toContain('c.customer_status')
    expect(params).toEqual(['store-001', 20, 0])
  })

  test('手机号分支叠加枚举筛选（占位符从 $2 起，无 LIMIT）', async () => {
    const ctx = createManagerCtx({ phone: '13800001111', customerStatus: '冰冻' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.phone = $1')
    expect(sql).toContain('c.customer_status = $2')
    expect(sql).not.toContain('LIMIT')
    expect(params).toEqual(['13800001111', '冰冻'])
  })

  // ---------- #181 分页 ----------
  // search 的返回形态是**多态**的：带 page 才返回信封，不带仍是裸数组。
  // 裸数组被开单/充值卡/充值金转入/服务单/提货五处业务流程消费，
  // 下面这组用例是这两种形态的锁：任一形态被改掉都会红。

  test('#181 不传 page：返回裸数组，SQL 仍带 OFFSET 0（等价改造前的 LIMIT 20）', async () => {
    const ctx = createManagerCtx({})
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('ORDER BY c.user_id ASC')
    expect(params).toEqual(['store-001', 20, 0])
    expect(Array.isArray(ctx.result)).toBe(true)
    expect(ctx.result).toEqual([])
  })

  test('#181 传 page：返回分页信封且 OFFSET = (page-1)*pageSize', async () => {
    const ctx = createManagerCtx({ page: 3, pageSize: 20 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [, params] = pg.query.mock.calls[0]
    expect(params).toEqual(['store-001', 20, 40])
    expect(Array.isArray(ctx.result)).toBe(false)
    expect(ctx.result).toMatchObject({ page: 3, pageSize: 20, hasMore: false })
    expect(ctx.result.customers).toEqual([])
  })

  test('#181 hasMore：本页取满为 true，未取满为 false', async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({
      user_id: `u${i}`, phone: `1380000000${i}`, name: `客${i}`,
      customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店',
    }))
    const ctxFull = createManagerCtx({ page: 1, pageSize: 2 })
    pg.query
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await customerRoutes.search(ctxFull)
    expect(ctxFull.result.hasMore).toBe(true)

    const ctxPartial = createManagerCtx({ page: 1, pageSize: 2 })
    pg.query
      .mockResolvedValueOnce(full.slice(0, 1))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await customerRoutes.search(ctxPartial)
    expect(ctxPartial.result.hasMore).toBe(false)
  })

  test('#181 pageSize 越界被夹到 [1,100]，page 非法回落为 1', async () => {
    const ctxBig = createManagerCtx({ page: 1, pageSize: 9999 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctxBig)
    expect(pg.query.mock.calls[0][1]).toEqual(['store-001', 100, 0])

    const ctxBad = createManagerCtx({ page: -5, pageSize: 0 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctxBad)
    // 本 describe 无 clearAllMocks，calls 是累积的：第二次 search 落在 calls[1]
    // pageSize=0 → Number(0)||20 → 20；page=-5 → Math.max(1,-5) → 1
    expect(pg.query.mock.calls[1][1]).toEqual(['store-001', 20, 0])
  })

  test('#181 小数 pageSize 被取整：LIMIT 参数必须是整数（PG 按 int8 解析，2.5 会直接报错）', async () => {
    const ctx = createManagerCtx({ page: 2.7, pageSize: 2.5 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [, params] = pg.query.mock.calls[0]
    // page=2.7→2，pageSize=2.5→2，offset=(2-1)*2=2
    expect(params).toEqual(['store-001', 2, 2])
    expect(Number.isInteger(params[1])).toBe(true)
    expect(Number.isInteger(params[2])).toBe(true)
  })

  test('#181 非安全整数页码回落默认：Infinity / 超大值不得进 OFFSET', async () => {
    // 'Infinity' 经 Math.trunc 仍是 Infinity，Math.max(1, Infinity) 也还是 Infinity，
    // 直接进 OFFSET 会让 PG 报错 —— 必须被 Number.isSafeInteger 挡回默认值。
    const ctxInf = createManagerCtx({ page: 'Infinity', pageSize: 'Infinity' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctxInf)
    expect(pg.query.mock.calls[0][1]).toEqual(['store-001', 20, 0])

    const ctxHuge = createManagerCtx({ page: 1e21, pageSize: 20 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctxHuge)
    // 1e21 超出安全整数范围 → 回落第 1 页
    expect(pg.query.mock.calls[1][1]).toEqual(['store-001', 20, 0])
  })

  test('#181 phone 分支不分页：传 page 也返回信封但 hasMore 恒 false、SQL 无 LIMIT', async () => {
    const ctx = createManagerCtx({ phone: '13800001111', page: 1, pageSize: 1 })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).not.toContain('LIMIT')
    expect(params).toEqual(['13800001111'])
    // 取满 1 条也不得推断出 hasMore=true（phone 分支最多命中 1 条）
    expect(ctx.result.hasMore).toBe(false)
    expect(ctx.result.customers).toHaveLength(1)
  })

  test('#181 keyword 分支同样带 ORDER BY + OFFSET', async () => {
    const ctx = createManagerCtx({ keyword: '张', page: 2, pageSize: 20 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('ORDER BY c.user_id ASC')
    expect(params).toEqual(['%张%', 'store-001', 20, 20])
  })

  test('search 返回 lastPurchaseName 字段', async () => {
    const ctx = createManagerCtx({})
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: null, member_level: null, bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([])   // svcDateRows
      .mockResolvedValueOnce([{ client_user_id: 'u1', last_product_name: '精油SPA套餐' }]) // lastPurchaseRows
    await customerRoutes.search(ctx)
    const item = ctx.result.find(r => r.clientUserId === 'u1')
    expect(item.lastPurchaseName).toBe('精油SPA套餐')
    // SQL 应包含 item_direction 过滤
    const lastPurchaseSql = pg.query.mock.calls[2][0]
    expect(lastPurchaseSql).toContain('item_direction')
  })

  test('svcDateRows 非空时 lastServiceDate 被填充', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: 'VIP', bound_store_id: 'store-001', store_name: '测试店' },
      ])
      .mockResolvedValueOnce([{ client_user_id: 'u1', service_date: '2024-05-10' }]) // svcDateRows 非空
      .mockResolvedValueOnce([])  // lastPurchaseRows

    await customerRoutes.search(ctx)

    // tier 已下沉到 admin cron（customer_status/spending_tier DB 列），search 不再计算
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

  test('crossStore=true 时关键词模糊跨门店检索（开单/充值卡用）', async () => {
    const ctx = createManagerCtx({ keyword: '张', crossStore: true })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    // 模糊匹配手机号 + 姓名
    expect(sql).toContain('(c.phone LIKE $1 OR c.name LIKE $1)')
    // 账户级资产不跟门店绑定：跨店检索含已解绑顾客，不带 bound_store_id 过滤
    expect(sql).not.toContain('c.bound_store_id IS NOT NULL')
    expect(sql).not.toContain('c.bound_store_id = $2')
    expect(params[0]).toBe('%张%')
    expect(params[1]).toBe(20) // LIMIT，无门店参数占位
  })

  test('crossStore=true 可搜索到临时跨店顾客（bound_store_id 为其他门店）', async () => {
    const ctx = createManagerCtx({ keyword: '35960', crossStore: true })
    pg.query
      .mockResolvedValueOnce([
        {
          user_id: 'u1',
          phone: '13800135960',
          name: '李四',
          customer_id: 'C035960',
          member_level: null,
          bound_store_id: 'store-002',  // 绑定其他门店
          is_cross_store_temp: true,     // 临时跨店标记
          store_name: '其他店'
        },
      ])
      .mockResolvedValueOnce([])  // svcDateRows
      .mockResolvedValueOnce([])  // lastPurchaseRows
    await customerRoutes.search(ctx)
    // SQL 不按 bound_store_id 过滤，只按 keyword 匹配 → 能搜到绑定其他门店的临时跨店顾客
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).not.toContain('c.bound_store_id = ')
    expect(sql).toContain('(c.phone LIKE $1 OR c.name LIKE $1)')
    expect(params[0]).toBe('%35960%')
    // 返回结果包含临时跨店标记，前端凭此判断是否允许操作
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].clientUserId).toBe('u1')
    expect(ctx.result[0].isCrossStoreTemp).toBe(true)
    expect(ctx.result[0].boundStoreId).toBe('store-002')
    expect(ctx.result[0].storeName).toBe('其他店')
  })

  test('精确手机号可定位已解绑（bound_store_id=NULL）顾客', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001', member_level: '黑钻', bound_store_id: null, store_name: null },
      ])
      .mockResolvedValueOnce([])  // svcDateRows
      .mockResolvedValueOnce([])  // lastPurchaseRows
    await customerRoutes.search(ctx)
    const [sql] = pg.query.mock.calls[0]
    // 精确手机号分支不再要求 bound_store_id 非空 → 已解绑顾客也能搜到
    expect(sql).toContain('c.phone = $1')
    expect(sql).not.toContain('c.bound_store_id IS NOT NULL')
    expect(ctx.result[0].clientUserId).toBe('u1')
    expect(ctx.result[0].memberLevel).toBe('黑钻')
    expect(ctx.result[0].storeName).toBe('')  // 未绑定门店 → 空串
  })

  test('不带 crossStore 的关键词仍走门店内过滤（回归）', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('(c.phone LIKE $1 OR c.name LIKE $1)')
    expect(sql).toContain('c.bound_store_id = $2')
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

  // ── 交易数据跟顾客走：日历不再按门店过滤（顾客可见性由 assertProfileVisibleByIdentifier 守护）──
  test('门店模式：日历 SQL 不含 store_id 过滤、按 client_user_id 查（跟顾客走）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.calendar(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).not.toMatch(/o\.store_id/)
    expect(sql).toMatch(/o\.client_user_id\s*=\s*\$3/)
    expect(params).not.toContain('store-001')
  })

  test('管理模式：日历 SQL 同样不含 store_id 过滤', async () => {
    const ctx = createManagementCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await customerRoutes.calendar(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).not.toMatch(/o\.store_id/)
  })
})

// ============================================================
// customer.detail
// ============================================================
describe('customer.detail', () => {
  test('按 customer_id 查找返回完整信息（含 gender/storeName/notes）', async () => {
    const legacyPgBirthday = new Date(1990, 2, 15)
    expect(legacyPgBirthday.toISOString()).toBe('1990-03-14T16:00:00.000Z')
    const pgBirthday = '1990-03-15'
    const ctx = createManagerCtx({ id: 'C001' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001',
        member_level: 'VIP', bound_employee_id: 'emp-002', skin_type: '干性', improvement_focus: '保湿',
        skin_issue: '敏感泛红', wellness_preference: '艾灸', gender: '女', notes: '过敏体质',
        customer_source: '老带新', promoter_employee_name: '员工甲', inviter_name: '顾客乙',
        inviter_phone: '13700002222', invited_at: '2026-01-02T03:04:05Z', customer_type: '会员客',
        spending_tier: '5000-9999', monthly_activity: '活跃', customer_status: '正常到店',
        birthday: pgBirthday, occupation: '教师', is_married: true, wechat_name: '小张', points_balance: '88',
        bound_store_id: 'store-001', store_name: '南昌旗舰店',
      }])
      .mockResolvedValueOnce([{ name: '李四' }])  // preferredStaffName
      .mockResolvedValueOnce([{
        total: '5000',
        year_total: '2000',
        total_actual_consumption: '3200',
        year_actual_consumption: '1200',
      }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: '2026-03-10', visit_count_90d: '8' }])  // getVisitInfo
      .mockResolvedValueOnce([{ product_name: '蜜语生玑10次卡', cnt: '5' }])  // getTopProduct
    await customerRoutes.detail(ctx)
    expect(pg.query.mock.calls[0][0]).toContain('COALESCE(promoter.name, c.promoter_employee_name)')
    expect(pg.query.mock.calls[0][0]).toContain('promoter.employee_id = c.promoter_employee_id')
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
    expect(ctx.result).toMatchObject({
      customerSource: '老带新', promoterEmployeeName: '员工甲', inviterName: '顾客乙',
      inviterPhone: '13700002222', customerType: '会员客', birthday: '1990-03-15',
      occupation: '教师', isMarried: true, wechatName: '小张', skinIssue: '敏感泛红',
      wellnessPreference: '艾灸', pointsBalance: 88,
    })
    expect(ctx.result.lastServiceDate).toBe('2026-03-10')
    expect(ctx.result.visitFrequency).toBe('两周一次')  // 8 visits in 90 days
    expect(ctx.result.topProductName).toBe('蜜语生玑10次卡')
    expect(ctx.result.totalConsumption).toBe(5000)
    expect(ctx.result.yearConsumption).toBe(2000)
    expect(ctx.result.totalActualConsumption).toBe(3200)
    expect(ctx.result.yearActualConsumption).toBe(1200)
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

  test('getConsumptionStats 使用单次查询，同时计算消费和实耗年度统计', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query
      .mockResolvedValueOnce([{
        user_id: 'u1', phone: '138', name: '测试', customer_id: null,
        member_level: null, bound_employee_id: null, skin_type: null, improvement_focus: null,
        gender: null, notes: null, bound_store_id: null, store_name: null,
      }])
      .mockResolvedValueOnce([{
        total: '10000',
        year_total: '4000',
        total_actual_consumption: '3200',
        year_actual_consumption: '1200',
      }])  // single query
      .mockResolvedValueOnce([{ last_date: '2026-03-01', visit_count_90d: '3' }])  // getVisitInfo
      .mockResolvedValueOnce([{ product_name: '精油SPA', cnt: '3' }])  // getTopProduct
      .mockResolvedValueOnce([{ cnt: 0 }])  // legacy 历史订单待核对数（phone 非空时触发）

    await customerRoutes.detail(ctx)

    expect(ctx.result.totalConsumption).toBe(10000)
    expect(ctx.result.yearConsumption).toBe(4000)
    expect(ctx.result.totalActualConsumption).toBe(3200)
    expect(ctx.result.yearActualConsumption).toBe(1200)
    expect(ctx.result.visitFrequency).toBe('一月一次')  // 3 visits in 90d
    expect(ctx.result.topProductName).toBe('精油SPA')
    // 验证单次查询同时覆盖历史订单消费和服务单实耗。
    const consumptionCall = pg.query.mock.calls[1]
    const sql = consumptionCall[0]
    expect(sql).toMatch(/CASE[\s\S]*WHEN/)
    expect(sql).toContain('EXISTS (SELECT 1 FROM sale_items')
    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(sql).toContain("o.sale_order_type IN ('销售单', '转换单')")
    expect(sql).toContain('FROM sale_order_payments sop')
    expect(sql).toContain("sop.status = '已支付'")
    expect(sql).toContain('SUM(\n         sop.amount::numeric')
    expect(sql).toContain("o.legacy_source IS DISTINCT FROM 'workfine'")
    expect(sql).toContain("o.legacy_source = 'workfine'")
    // #141 年度消费落年改按业绩归属日期：款项级走 sop、legacy(workfine) 走订单级 o。
    // 归属日期是 date，年区间用半开 [start, start+1year)，不再套北京时区半开区间。
    expect(sql).toContain('sop.performance_attribution_date >= $2::date')
    expect(sql).toContain("sop.performance_attribution_date < ($2::date + INTERVAL '1 year')")
    expect(sql).toContain('o.performance_attribution_date >= $2::date')
    expect(sql).toContain("o.performance_attribution_date < ($2::date + INTERVAL '1 year')")
    // 旧口径必须消失（含时区半开区间形态）
    expect(sql).not.toContain('sop.paid_at >=')
    expect(sql).not.toContain("AT TIME ZONE 'Asia/Shanghai')")
    expect(sql).not.toContain('WHEN o.paid_at >= $2')
    expect(sql).toContain('FROM service_orders so')
    expect(sql).toContain('JOIN service_items sit ON sit.service_order_id = so.service_order_id')
    expect(sql).toContain("so.status = '已完成'")
    expect(sql).toContain('so.service_date >= $2::date')
    expect(sql).toContain('so.remark IS DISTINCT FROM')
    expect(consumptionCall[1][1]).toMatch(/^\d{4}-01-01$/)
    // 5 次 pg.query: detail + consumption + visitInfo + topProduct + legacyCount(phone 非空触发)
    expect(pg.query).toHaveBeenCalledTimes(5)
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
    // assertCustomerInScope 先 SELECT bound_store_id；store-001 命中 scope
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', status: '已支付', paid_at: '2024-06-01T10:00:00Z' },
      { sale_order_id: 'SO-002', status: '已支付', paid_at: '2024-06-15T14:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', sale_item_id: 'item-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', product_name: '面部护理', unit_real_price: '100.00', unit: '次', category_id: 'face-care', category_name: '面部护理', product_kind: '护理项目', order_remark: '  下次重点护理\n敏感区  ' },
      { sale_order_id: 'SO-002', sale_item_id: 'item-002', session_count: 5, remaining_sessions: 5, sku_id: 'sku-2', product_type: '疗程卡', product_name: '身体护理', unit_real_price: '50.00', order_remark: '   ' },
    ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].saleOrderId).toBe('SO-001')
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[0].items[0].itemName).toBe('面部护理')
    expect(ctx.result[0].items[0].remainingSessions).toBe(8)
    expect(ctx.result[0].items[0].unitRealPrice).toBe('100.00')
    expect(ctx.result[0].items[0].orderRemark).toBe('下次重点护理\n敏感区')
    expect(ctx.result[1].items[0].orderRemark).toBeNull()
    expect(ctx.result[0].items[0]).toMatchObject({
      unit: '次',
      productKind: '护理项目',
      categoryId: 'face-care',
      categoryName: '面部护理',
    })
  })

  // issue #122：部分支付且实收不足一次单价 → paid_sessions=0，旧过滤把整张卡剔除，
  // 顾客买了卡却在档案里查无此卡。现在照常下发，可用次数由前端算作 0。
  test('可用次数为 0 的卡仍下发，并带行级欠款', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-unpaid-card' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-UNPAID', status: '部分支付', paid_at: '2026-09-13T10:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'SO-UNPAID', sale_item_id: 'item-unpaid',
        session_count: 15, remaining_sessions: 15, paid_sessions: 0,
        sku_id: 'sku-1', product_type: '疗程卡', product_name: '深层补水',
        sale_amount: '3000.00', received: '150.00', unpaid_amount: '2850.00',
      },
    ])

    await customerRoutes.paidOrders(ctx)

    expect(ctx.result[0].items[0]).toEqual(
      expect.objectContaining({
        saleItemId: 'item-unpaid',
        paidSessions: 0,
        remainingSessions: 15,
        unpaidAmount: 2850,
      }),
    )
  })

  // 订单已付清但行 received 不足 → 行级分摊缺口（已知数据问题），不是顾客欠款。
  // dev 实测 78 行属此类，若按金额差报欠款会伪造债务。
  test('订单已付清的行不下发欠款（行级分摊缺口不算欠款）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-settled-gap' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-PAID', status: '已支付', paid_at: '2026-07-25T10:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'SO-PAID', sale_item_id: 'item-gap',
        session_count: 10, remaining_sessions: 8, paid_sessions: 2,
        sku_id: 'sku-1', product_type: '疗程卡', product_name: '面部护理',
        sale_amount: '3980.00', received: '796.00', unpaid_amount: null,
      },
    ])

    await customerRoutes.paidOrders(ctx)

    expect(ctx.result[0].items[0]).toEqual(
      expect.objectContaining({ saleItemId: 'item-gap', unpaidAmount: null }),
    )
  })

  // ⚠ 退款不减 remaining_sessions（Model X）：paid_sessions 是「已退卡从卡包消失」的唯一机制。
  // 放宽展示门槛时若不保留这条守卫，已退款的卡会重新出现并被标成待付清（实测 87 行 / ¥118605）。
  test('SQL 保留已审批退款守卫，已退卡不因放宽展示而复现', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-1', status: '部分支付', paid_at: '2026-09-13T10:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.paidOrders(ctx)

    const itemSql = pg.query.mock.calls[2][0]
    expect(itemSql).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    expect(itemSql).toContain('OR si.paid_sessions > (si.session_count - si.remaining_sessions)')
    // 欠款也不得落在已退款的单上（received 是净实收，相减必然虚增）：
    // 断言退款短路出现在 unpaid_amount 的 CASE 内部，而非文件别处
    const caseExpr = itemSql.match(/CASE\s+WHEN o\.status = '部分支付'[\s\S]*?END AS unpaid_amount/)?.[0]
    expect(caseExpr).toBeTruthy()
    expect(caseExpr).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    expect(caseExpr).toContain('AND (si.sale_amount::numeric - si.received::numeric) >= 1')
  })

  test('无已支付订单时返回空数组', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-empty' })
    // assertCustomerInScope 先 SELECT bound_store_id
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toEqual([])
  })

  test('缺少 clientUserId 和 clientPhone 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.paidOrders(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('按 clientPhone 查询（解析为 clientUserId 后走 assertCustomerInScope 守卫分支）', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })
    // 1) 手机号→user_id  2) assertCustomerInScope bound_store_id  3) orders  4) items
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u-phone' }])
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([
        { sale_order_id: 'SO-003', status: '已支付', paid_at: '2024-07-01T10:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { sale_order_id: 'SO-003', sale_item_id: 'item-003', session_count: 3, remaining_sessions: 3, sku_id: 'sku-3', product_type: '疗程卡', product_name: '头疗' },
      ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].saleOrderId).toBe('SO-003')
  })

  test('交易数据跟顾客走 — SQL 不含 store_id 过滤、按 client_user_id 查全量（含跨店订单）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-multi-store' })
    let ordersSql = ''
    let ordersParams = []
    pg.query.mockImplementation(async (sql, params) => {
      const s = typeof sql === 'string' ? sql : ''
      // assertCustomerInScope: SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1
      if (/bound_store_id\s+FROM\s+client_wechat_users/.test(s)) {
        return [{ bound_store_id: 'store-001' }]
      }
      // 主订单查询：FROM sale_orders o
      if (/FROM\s+sale_orders\s+o\b/.test(s)) {
        ordersSql = s
        ordersParams = params || []
        return [
          { sale_order_id: 'SO-AWAY', status: '已支付', paid_at: '2024-06-01T10:00:00Z', store_id: 'store-999', store_name: '外店' },
        ]
      }
      // items 查询：FROM sale_items si
      return [
        { sale_order_id: 'SO-AWAY', sale_item_id: 'item-away', store_id: 'store-999', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', product_name: '面部护理' },
      ]
    })
    await customerRoutes.paidOrders(ctx)
    // 不再按门店过滤：SQL 无 o.store_id 条件、仅按 client_user_id ($1)
    expect(ordersSql).not.toMatch(/o\.store_id\s*=/)
    expect(ordersParams).toEqual(['u-multi-store'])
    // 跨店订单（store-999，非当前门店 store-001）也返回
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].storeId).toBe('store-999')
    expect(ctx.result[0].storeName).toBe('外店')
    expect(ctx.result[0].items[0].storeId).toBe('store-999')
  })

  test('部分支付订单的疗程卡也返回（按 paid_sessions 限额核销，与 service.create 后端一致）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-partial' })
    // assertCustomerInScope 先 SELECT bound_store_id；store-001 命中 scope
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    // 订单查询：返回一条部分支付订单（修复前会被 o.status='已支付' 过滤掉）
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-PARTIAL', status: '部分支付', paid_at: '2026-06-29T04:54:01Z' },
    ])
    // items 查询：15 次疗程卡，已付 10 次（数据本身正确，修复前因订单被排除而无法展示）
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'SO-PARTIAL', sale_item_id: 'item-partial', store_id: 'store-001',
        session_count: 15, remaining_sessions: 15, paid_sessions: 10,
        sku_id: 'sku-waist', product_type: '疗程卡', product_name: '温暖SPA·腰腹', unit_real_price: '80.00',
      },
    ])
    await customerRoutes.paidOrders(ctx)
    const orderSql = pg.query.mock.calls.map((c) => c[0]).find((sql) =>
      /FROM\s+sale_orders\s+o/.test(sql) && /ORDER BY\s+o\.paid_at\s+DESC/.test(sql)
    )
    expect(orderSql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].saleOrderId).toBe('SO-PARTIAL')
    expect(ctx.result[0].status).toBe('部分支付')
    expect(ctx.result[0].items[0].totalSessions).toBe(15)
    expect(ctx.result[0].items[0].paidSessions).toBe(10)
    expect(ctx.result[0].items[0].remainingSessions).toBe(15)
  })

  test('已完成销售单仍作为有效订单返回', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-completed' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_order_id: 'SO-WORKFINE-COMPLETED', status: '已完成', paid_at: '2026-07-01T10:00:00Z',
      }])
      .mockResolvedValueOnce([{
        sale_order_id: 'SO-WORKFINE-COMPLETED', sale_item_id: 'item-completed', store_id: 'store-001',
        session_count: 10, remaining_sessions: 6, paid_sessions: 10,
        product_type: '疗程卡', product_name: '历史疗程卡', unit_real_price: '100.00',
      }])

    await customerRoutes.paidOrders(ctx)

    const orderSql = pg.query.mock.calls[1][0]
    expect(orderSql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(ctx.result).toMatchObject([{ saleOrderId: 'SO-WORKFINE-COMPLETED', status: '已完成' }])
  })

  test('paidOrders SQL 守卫：权益明细包含购买行和转换单转入行，排除转出行', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-conv' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-CONV', status: '已支付', paid_at: '2026-07-25T09:12:02Z' },
    ])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.paidOrders(ctx)

    const itemSql = pg.query.mock.calls.map((c) => c[0]).find((sql) =>
      /FROM\s+sale_items\s+si/.test(sql) && /JOIN\s+sale_orders\s+o/.test(sql)
    )
    expect(itemSql).toContain("si.product_type = '疗程卡'")
    expect(itemSql).toContain('o.remark AS order_remark')
    expect(itemSql).toContain("si.item_direction = '购买'")
    expect(itemSql).toContain("o.sale_order_type = '转换单'")
    expect(itemSql).toContain("si.item_direction = '转入'")
    expect(itemSql).not.toContain("si.item_direction = '转出'")
    expect(itemSql).toContain('si.paid_sessions IS NULL')
    // issue #122：改按物理剩余次数下发，可用次数 0 的卡不再整行隐藏。
    // 核销限额仍走 paid_sessions，但由 service.create/start/finalize 独立校验，不在此查询。
    expect(itemSql).toContain('si.remaining_sessions > 0')
    // ⚠ 退款不减 remaining_sessions：paid_sessions 是「已退卡从卡包消失」的唯一机制，
    // 放宽展示后这条守卫必须保留（已审批退款时回退到已付未用口径）。
    expect(itemSql).toContain("AND sop.change_type = '退款' AND sop.status = '已支付'")
    expect(itemSql).toContain('OR si.paid_sessions > (si.session_count - si.remaining_sessions)')
  })
})

describe('customer.homeProducts', () => {
  test('跨店返回顾客家居产品，并拆分真实提货与退款数量', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-HOME', sale_order_id: 'SO-HOME', product_name: '精华液',
        unit: '盒', purchased_quantity: 6, picked_quantity: 2, refunded_quantity: 1,
        paid_quantity: 5, pending_pickup_quantity: 3, remaining_quantity: 3,
        store_id: 'store-999', store_name: '外店',
        purchased_at: '2026-08-01T10:00:00Z', refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    expect(ctx.result).toEqual([
      expect.objectContaining({
        saleItemId: 'SI-HOME', pickedQuantity: 2, refundedQuantity: 1,
        remainingQuantity: 3, status: '部分提货', storeId: 'store-999',
      }),
    ])
    expect(pg.query.mock.calls[1][1]).toEqual(['u-home'])
  })

  test('手机号解析后校验顾客 scope，退款中状态优先', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })
    pg.query
      .mockResolvedValueOnce([{ user_id: 'u-phone' }])
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-PENDING', sale_order_id: 'SO-PENDING', product_name: '面膜',
        purchased_quantity: 1, picked_quantity: 0, refunded_quantity: 0,
        paid_quantity: 1, pending_pickup_quantity: 1, remaining_quantity: 1,
        store_id: 'store-001', purchased_at: '2026-08-02T10:00:00Z',
        refund_pending: true,
      }])

    await customerRoutes.homeProducts(ctx)
    expect(ctx.result[0].status).toBe('退款处理中')
    expect(pg.query.mock.calls[2][1]).toEqual(['u-phone'])
  })

  test('SQL 不按订单门店过滤，且只读有效购买行', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])

    await customerRoutes.homeProducts(ctx)

    const sql = pg.query.mock.calls[1][0]
    // #154：已提货件数直读 sale_items.picked_up_quantity，不再聚合 pickup_records
    expect(sql).toContain('COALESCE(si.picked_up_quantity, 0)')
    expect(sql).not.toContain('FROM pickup_records')
    expect(sql).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(sql).toContain("si.item_direction = '购买'")
    expect(sql).toContain("si.product_type = '家居产品'")
    expect(sql).toMatch(/FLOOR\(GREATEST\(0, si\.received::numeric\) \* si\.quantity \/ NULLIF\(si\.sale_amount::numeric, 0\)\)/)
    expect(sql).toContain('SUM(si.row_pending_pickup)::int AS pending_pickup_quantity')
    expect(sql).not.toMatch(/o\.store_id\s*=/)
  })

  test('部分支付家居产品返回已付整件数和待提数量', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-partial-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-PARTIAL-HOME', sale_order_id: 'SO-PARTIAL-HOME', product_name: '面膜',
        unit: '盒', purchased_quantity: 10, paid_quantity: 2, picked_quantity: 0,
        refunded_quantity: 0, remaining_quantity: 10, pending_pickup_quantity: 2,
        store_id: 'store-001', store_name: '本店', purchased_at: '2026-08-13T10:00:00Z',
        refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    expect(ctx.result).toEqual([
      expect.objectContaining({
        purchasedQuantity: 10,
        paidQuantity: 2,
        pendingPickupQuantity: 2,
        status: '待提货',
      }),
    ])
  })

  // issue #120：买 1 件未付清 → FLOOR(received*1/sale_amount)=0 → pending=0，
  // 旧 WHERE 把整行剔除，顾客档案显示"暂无家居产品"。
  test('未付清整件的行仍返回，状态为待付清并带欠款金额', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-unpaid-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-UNPAID', sale_order_id: 'SO-UNPAID', product_name: '舒缓精华液',
        unit: '盒', purchased_quantity: 1, paid_quantity: 0, picked_quantity: 0,
        refunded_quantity: 0, remaining_quantity: 1, pending_pickup_quantity: 0,
        unpaid_amount: '380.00',
        store_id: 'store-001', store_name: '本店', purchased_at: '2026-09-13T10:00:00Z',
        refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    expect(ctx.result).toEqual([
      expect.objectContaining({
        saleItemId: 'SI-UNPAID',
        purchasedQuantity: 1,
        paidQuantity: 0,
        pendingPickupQuantity: 0,
        unpaidAmount: 380,
        status: '待付清',
      }),
    ])
  })

  test('退款过的行不下发欠款金额，避免净实收口径虚增', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-refunded-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-REFUNDED', sale_order_id: 'SO-REFUNDED', product_name: '面膜',
        unit: '盒', purchased_quantity: 2, paid_quantity: 2, picked_quantity: 1,
        refunded_quantity: 1, remaining_quantity: 0, pending_pickup_quantity: 0,
        unpaid_amount: '120.00',
        store_id: 'store-001', purchased_at: '2026-08-20T10:00:00Z',
        refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    expect(ctx.result[0]).toEqual(
      expect.objectContaining({ unpaidAmount: null, status: '已完成' }),
    )
  })

  // 寄存单的 sale_amount 只是原价快照、received 是历史值，相减不是欠款（SQL 置 NULL）。
  // 放行后若按金额差报欠款，会向顾客伪造一笔不存在的债务（dev 实测 86 行 / ¥44834.30）。
  test('寄存单行不报欠款，状态为待提货而非待付清', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-deposit-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-DEPOSIT', sale_order_id: 'SO-DEPOSIT', product_name: '生物胶原修复面膜',
        unit: '盒', purchased_quantity: 27, paid_quantity: 0, picked_quantity: 0,
        refunded_quantity: 0, remaining_quantity: 27, pending_pickup_quantity: 0,
        unpaid_amount: null,
        store_id: 'store-001', purchased_at: '2026-08-03T10:00:00Z', refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    expect(ctx.result[0]).toEqual(
      expect.objectContaining({ unpaidAmount: null, status: '待提货', purchasedQuantity: 27 }),
    )
  })

  test('退款后仍有剩余份额的行标待提货，不标已完成', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-partial-refund-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-PART-REFUND', sale_order_id: 'SO-PART-REFUND', product_name: '面膜',
        unit: '盒', purchased_quantity: 3, paid_quantity: 0, picked_quantity: 0,
        refunded_quantity: 1, remaining_quantity: 2, pending_pickup_quantity: 0,
        unpaid_amount: '200.00',
        store_id: 'store-001', purchased_at: '2026-08-20T10:00:00Z', refund_pending: false,
      }])

    await customerRoutes.homeProducts(ctx)

    // refunded>0 → 欠款口径不可靠，金额留空；但 2 件未交付，不能叫「已完成」
    expect(ctx.result[0]).toEqual(
      expect.objectContaining({ unpaidAmount: null, status: '待提货', remainingQuantity: 2 }),
    )
  })

  test('放行口径按剩余份额，不再用待提数量整行过滤', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-home' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([])

    await customerRoutes.homeProducts(ctx)

    const sql = pg.query.mock.calls[1][0]
    expect(sql).toContain('WHERE picked_quantity > 0 OR remaining_quantity > 0')
    expect(sql).not.toContain('WHERE picked_quantity > 0 OR pending_pickup_quantity > 0')
    expect(sql).toContain('AS unpaid_amount')
    // 寄存单必须在 SQL 层就把金额列置空，不能只靠前端不显示
    expect(sql).toContain("(o.sale_order_type = '寄存单') AS is_deposit")
    expect(sql).toContain('CASE WHEN is_deposit THEN NULL')
  })

  test('缺少顾客标识时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.homeProducts(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('普通员工不能读取未分配给自己的顾客家居产品', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u-unassigned' })
    pg.query.mockResolvedValueOnce([
      { bound_store_id: 'store-001', bound_employee_id: 'emp-other' },
    ])

    await expect(customerRoutes.homeProducts(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客未分配给当前员工/)

    expect(pg.query).toHaveBeenCalledTimes(1)
    const [scopeSql, scopeParams] = pg.query.mock.calls[0]
    expect(scopeSql).toContain('bound_employee_id')
    expect(scopeParams).toEqual(['u-unassigned'])
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
    // tier 已下沉到 admin cron（customer_status/spending_tier DB 列），listByTag 不再输出
  })

  // ---------- #240 内存分页守卫 ----------
  // listByTag 走 filtered.slice(offset, offset+pageSize)，原先 page/pageSize 零校验：
  //   page='abc' → slice(NaN, NaN) → 空数组（表现为「本店没有顾客」而非报错）
  //   page=-1    → slice(-40,-20) → 静默返回列表尾部的错误一页
  // 与 staff.performanceDetail 早已修掉的坑同型（见 routes/staff.js 的 toPositiveInt 注释）。
  test('#240 page 非法（字符串 / 负数）不得让 slice 走进 NaN 或负索引', async () => {
    const recent = new Date()
    recent.setDate(recent.getDate() - 5)
    const rows = Array.from({ length: 5 }, (_, i) => ({
      user_id: `u${i}`, name: `客${i}`, phone: '13800000000', birthday: null,
      member_level: 'VIP', last_service_date: recent.toISOString().slice(0, 10),
      year_consumption: '25000',
    }))

    // 'abc' → NaN → 旧实现 slice(NaN,NaN) 返回空数组
    const ctxNaN = createManagerCtx({ tag: 'active', page: 'abc', pageSize: 10 })
    pg.query.mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    await customerRoutes.listByTag(ctxNaN)
    expect(ctxNaN.result.customers).toHaveLength(5)
    expect(ctxNaN.result.total).toBe(5)

    // page=-1 → 旧实现 slice(-20,-10) 返回尾部错误数据；应回落第 1 页
    const ctxNeg = createManagerCtx({ tag: 'active', page: -1, pageSize: 2 })
    pg.query.mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    await customerRoutes.listByTag(ctxNeg)
    expect(ctxNeg.result.customers.map(c => c.name)).toEqual(['客0', '客1'])

    // pageSize 小数被取整（内存分页不会打到 PG，但切片长度必须确定）
    const ctxFrac = createManagerCtx({ tag: 'active', page: 1, pageSize: 2.9 })
    pg.query.mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    await customerRoutes.listByTag(ctxFrac)
    expect(ctxFrac.result.customers).toHaveLength(2)
  })

  test('按 sleeping 标签筛选（含无服务记录）', async () => {
    const ctx = createManagerCtx({ tag: 'sleeping', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '沉睡客', phone: '13800001111', birthday: null, member_level: null, last_service_date: null, year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
  })

  test('按 sleeping 标签时与 stats 共用会员 customer_status 口径', async () => {
    const now = new Date()
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }
    const ctx = createManagerCtx({ tag: 'sleeping', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      // 会员客以 customer_status 为准，休眠应进 sleeping 桶。
      { user_id: 'u1', name: '休眠会员', phone: '13800001111', birthday: null, member_level: 'VIP', customer_type: '会员客', customer_status: '休眠', last_service_date: daysAgo(100) },
      // 会员客 customer_status 已归入 active，不应因当前门店的最近服务超过 90 天被旧逻辑误放入 sleeping。
      { user_id: 'u2', name: '活跃会员', phone: '13900002222', birthday: null, member_level: 'VIP', customer_type: '会员客', customer_status: '保有会员-有效', last_service_date: daysAgo(100) },
      // 非会员客继续按最近服务日期实时分桶。
      { user_id: 'u3', name: '沉睡流量客', phone: '13700003333', birthday: null, member_level: null, customer_type: '流量客', customer_status: null, last_service_date: daysAgo(100) },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(2)
    expect(ctx.result.customers.map((customer) => customer.name)).toEqual(['休眠会员', '沉睡流量客'])
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
    expect(birthdayCustomer).toBeTruthy()
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
    /**
     * #181：`filtered.slice()` 是内存分页，行序完全由 SQL 决定。上面的 mock 天然有序，
     * 所以只断言切片结果的话，把 ORDER BY 删掉这个用例照样绿 —— 必须直接锁 SQL 契约，
     * 否则「翻页不重复不漏行」这条验收标准没有任何测试守护。
     */
    expect(pg.query.mock.calls[0][0]).toContain('ORDER BY c.user_id ASC')
  })

  test('缺少 tag 参数时拒绝', async () => {
    const ctx = createManagerCtx({ page: 1 })
    await expect(customerRoutes.listByTag(ctx)).rejects.toThrow(/INVALID_PARAMS.*tag/)
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
  // ---------- #240 分页守卫 ----------
  // 原先零守卫：`refundParams.push(pageSize, (page-1)*pageSize)` 直接把入参推进 SQL，
  // `pageSize=2.5` 即复现本 issue 的 500；无上限时 `pageSize=1e6` 一次吐全部退款流水。
  test('#240 pageSize 小数 / 超上限 / 非安全整数都不得原样进 LIMIT', async () => {
    const mockThree = () => pg.query
      .mockResolvedValueOnce([])   // Q1 退款流水
      .mockResolvedValueOnce([])   // Q2 转换单
      .mockResolvedValueOnce([])   // Q3 转换单明细

    const refundCall = () => pg.query.mock.calls.find(c => /sale_order_payments/.test(c[0]))

    const ctxFrac = createManagerCtx({ clientUserId: 'u1', page: 2.7, pageSize: 2.5 })
    mockThree()
    await customerRoutes.refundHistory(ctxFrac)
    let params = refundCall()[1]
    // 末两位是 LIMIT / OFFSET：pageSize=2.5→2，page=2.7→2，offset=(2-1)*2=2
    expect(params.slice(-2)).toEqual([2, 2])
    expect(params.slice(-2).every(Number.isInteger)).toBe(true)

    pg.query.mockClear()
    const ctxBig = createManagerCtx({ clientUserId: 'u1', page: 1, pageSize: 1e6 })
    mockThree()
    await customerRoutes.refundHistory(ctxBig)
    params = refundCall()[1]
    expect(params.slice(-2)).toEqual([100, 0])   // 夹到 MAX_PAGE_SIZE，不会一次吐全表

    pg.query.mockClear()
    const ctxInf = createManagerCtx({ clientUserId: 'u1', page: 'Infinity', pageSize: 'Infinity' })
    mockThree()
    await customerRoutes.refundHistory(ctxInf)
    params = refundCall()[1]
    expect(params.slice(-2)).toEqual([50, 0])    // 回落默认 50 / 第 1 页
  })

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
      { sale_order_id: 'CVT-001', sale_item_id: 'cvtitem-1', item_direction: '购买', product_name: '身体护理', quantity: 1, received: '300' },
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

  test('交易数据跟顾客走 — 退款流水 SQL 不含 so.store_id 过滤、按 client_user_id 查', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([])  // 退款
    pg.query.mockResolvedValueOnce([])  // 转换单

    await customerRoutes.refundHistory(ctx)

    // 第 1 个 query 是退款流水 SQL，不再按门店过滤
    const [refundSql, refundParams] = pg.query.mock.calls[0]
    expect(refundSql).toMatch(/sop\.change_type\s*=\s*'退款'/)
    expect(refundSql).toMatch(/FROM\s+sale_order_payments\s+sop/i)
    expect(refundSql).toMatch(/sop\.refund_reason/i)
    expect(refundSql).not.toMatch(/so\.store_id\s*=/)
    // params: [clientUserId, pageSize, offset]，不含门店
    expect(refundParams).not.toContain('store-001')
    expect(refundParams[0]).toBe('u1')
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
// customer.searchPromoterEmployees / customer.updateProfile
// ============================================================
describe('customer.searchPromoterEmployees', () => {
  test.each([
    ['姓名', ' 王芳 ', '%王芳%'],
    ['手机号', '13', '%13%'],
  ])('店长可按%s模糊搜索全部在职员工（本店优先）', async (_searchType, keyword, expectedPattern) => {
    const ctx = createManagerCtx({ clientUserId: 'u1', keyword })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ employee_id: 'EMP-1', name: '王芳', phone: '13812345678', store_name: '测试店' }])

    await customerRoutes.searchPromoterEmployees(ctx)

    expect(ctx.result).toEqual([{
      employeeId: 'EMP-1', name: '王芳', phoneMasked: '138****5678', storeName: '测试店',
    }])
    const [sql, params] = pg.query.mock.calls[1]
    expect(sql).not.toContain('AND u.store_id = $1')
    expect(sql).toContain('(u.store_id = $1) DESC')
    expect(sql).toContain('u.is_resigned = false')
    expect(sql).toContain('u.name ILIKE $2 OR u.phone ILIKE $2')
    expect(params).toEqual(['store-001', expectedPattern])
  })

  test('跨店员工也在候选中并携带门店名', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', keyword: '王芳' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ employee_id: 'EMP-9', name: '王芳', phone: '13900000000', store_name: '其他门店' }])

    await customerRoutes.searchPromoterEmployees(ctx)

    expect(ctx.result).toEqual([{
      employeeId: 'EMP-9', name: '王芳', phoneMasked: '139****0000', storeName: '其他门店',
    }])
  })

  test('去除首尾空格后少于2个字符或普通员工调用时拒绝', async () => {
    await expect(customerRoutes.searchPromoterEmployees(createManagerCtx({ clientUserId: 'u1', keyword: ' 王 ' })))
      .rejects.toThrow(/至少2个字符/)
    await expect(customerRoutes.searchPromoterEmployees(createBeauticianCtx({ clientUserId: 'u1', keyword: '13' })))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('customer.updateProfile', () => {
  function mockProfileTransaction(beforeOverrides = {}, updateRows = [{ updated_at: new Date('2026-08-26T03:00:00.000Z') }]) {
    const before = {
      user_id: 'u1',
      bound_store_id: 'store-001',
      promoter_employee_id: null,
      promoter_employee_name: null,
      customer_source: '美团',
      birthday: '1990-01-01',
      occupation: null,
      is_married: null,
      skin_issue: null,
      wellness_preference: null,
      is_cross_store_temp: false,
      workfine_override_fields: [],
      updated_at: new Date('2026-08-26T02:00:00.000Z'),
      ...beforeOverrides,
    }
    const clientQuery = vi.fn(async (sql) => {
      if (sql.includes('FOR UPDATE')) return { rows: [before], rowCount: 1 }
      if (sql.includes('FROM staff_wechat_users')) {
        return { rows: [{ employee_id: 'EMP-1', name: '王员工', store_id: 'store-001' }], rowCount: 1 }
      }
      if (sql.includes('UPDATE client_wechat_users')) return { rows: updateRows, rowCount: updateRows.length }
      return { rows: [], rowCount: 0 }
    })
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))
    return clientQuery
  }

  test('批量更新档案并把实际变化的 WorkFine 字段加入人工覆盖列表', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u1',
      expectedUpdatedAt: '2026-08-26T02:00:00.000Z',
      changes: { customerSource: '抖音', occupation: '教师', isCrossStoreTemp: true },
    })
    const clientQuery = mockProfileTransaction()

    await customerRoutes.updateProfile(ctx)

    expect(ctx.result.changes).toEqual({ customerSource: '抖音', occupation: '教师', isCrossStoreTemp: true })
    const updateCall = clientQuery.mock.calls.find((call) => call[0].includes('UPDATE client_wechat_users'))
    expect(updateCall[0]).toContain('workfine_override_fields = ARRAY')
    expect(updateCall[0]).toContain("date_trunc('milliseconds', updated_at)")
    expect(updateCall[1]).toContainEqual(['customer_source', 'occupation'])
    const auditCall = clientQuery.mock.calls.find((call) => call[0].includes('operation_logs'))
    expect(JSON.parse(auditCall[1][8]).changes.customerSource).toEqual({ from: '美团', to: '抖音' })
  })

  test('推荐员工可为跨店在职员工，并由服务端回填姓名', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u1',
      expectedUpdatedAt: '2026-08-26T02:00:00.000Z',
      changes: { promoterEmployeeId: 'EMP-1' },
    })
    const clientQuery = mockProfileTransaction()
    // mock 返回跨店员工，验证保存不再被本店校验拦截
    const originalQuery = clientQuery.getMockImplementation()
    clientQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM staff_wechat_users')) {
        return { rows: [{ employee_id: 'EMP-1', name: '王员工', store_id: 'store-999' }], rowCount: 1 }
      }
      return originalQuery(sql)
    })

    await customerRoutes.updateProfile(ctx)

    expect(ctx.result.changes).toEqual({ promoterEmployeeId: 'EMP-1', promoterEmployeeName: '王员工' })
    const updateCall = clientQuery.mock.calls.find((call) => call[0].includes('UPDATE client_wechat_users'))
    expect(updateCall[0]).toContain('promoter_employee_name')
    expect(updateCall[1]).toContain('王员工')
  })

  test('乐观锁冲突返回 CONFLICT', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u1',
      expectedUpdatedAt: '2026-08-25T00:00:00.000Z',
      changes: { occupation: '教师' },
    })
    mockProfileTransaction({}, [])

    await expect(customerRoutes.updateProfile(ctx)).rejects.toThrow(/CONFLICT.*已被其他人修改/)
  })

  test.each([
    [{ occupation: 'a'.repeat(51) }, /职业不能超过50个字符/],
    [{ customerSource: '未知渠道' }, /顾客来源不在允许范围/],
    [{ birthday: '2026-02-30' }, /生日日期无效/],
    [{ phone: '13800000000' }, /不允许修改的字段/],
  ])('非法 changes 被拒绝：%o', async (changes, expected) => {
    const ctx = createManagerCtx({ clientUserId: 'u1', expectedUpdatedAt: '2026-08-26T02:00:00.000Z', changes })
    await expect(customerRoutes.updateProfile(ctx)).rejects.toThrow(expected)
  })

  test('普通员工无法更新基本档案', async () => {
    const ctx = createBeauticianCtx({
      clientUserId: 'u1', expectedUpdatedAt: '2026-08-26T02:00:00.000Z', changes: { occupation: '教师' },
    })
    await expect(customerRoutes.updateProfile(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// customer.updateName
// ============================================================
describe('customer.updateName', () => {
  test('店长修改顾客姓名成功并写入审计 diff', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', name: '  新姓名  ' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
      .mockResolvedValueOnce([{ name: '旧姓名' }])
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await customerRoutes.updateName(ctx)

    expect(ctx.result).toEqual({ message: '顾客姓名已更新', name: '新姓名' })
    const [sql, params] = clientQuery.mock.calls[0]
    expect(sql).toContain('UPDATE client_wechat_users SET name = $1')
    expect(params).toEqual(['新姓名', 'u1'])

    const auditCall = clientQuery.mock.calls.find((c) => c[0].includes('operation_logs'))
    expect(auditCall).toBeDefined()
    expect(auditCall[1][5]).toBe('customer.update')
    expect(JSON.parse(auditCall[1][8]).changes.name).toEqual({ from: '旧姓名', to: '新姓名' })
  })

  test.each([
    [{ name: '张三' }, /clientUserId/],
    [{ clientUserId: 'u1', name: 123 }, /name 必须为字符串/],
    [{ clientUserId: 'u1', name: '   ' }, /姓名不能为空/],
    [{ clientUserId: 'u1', name: 'a'.repeat(51) }, /不能超过50个字符/],
  ])('非法参数被拒绝：%o', async (payload, expected) => {
    await expect(customerRoutes.updateName(createManagerCtx(payload))).rejects.toThrow(expected)
  })

  test('顾客跨店时拒绝修改', async () => {
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-002' }])
    await expect(customerRoutes.updateName(createManagerCtx({ clientUserId: 'u1', name: '新姓名' })))
      .rejects.toThrow(/PERMISSION_DENIED.*顾客不在当前门店范围内/)
  })

  test('美容师无法修改顾客姓名', async () => {
    await expect(customerRoutes.updateName(createBeauticianCtx({ clientUserId: 'u1', name: '新姓名' })))
      .rejects.toThrow(/PERMISSION_DENIED/)
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
    // UPDATE + 审计日志走事务 client
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await customerRoutes.updateNotes(ctx)

    expect(ctx.result.message).toContain('备注已保存')
    const [sql, params] = clientQuery.mock.calls[0]
    expect(sql).toContain('UPDATE client_wechat_users')
    expect(sql).toContain('notes = $1')
    expect(params[0]).toBe('过敏体质，注意精油用量')
    expect(params[1]).toBe('u1')
  })

  test('空备注保存为 null', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: '   ' })

    mockScopeOk()
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await customerRoutes.updateNotes(ctx)

    expect(ctx.result.message).toContain('备注已保存')
    expect(clientQuery.mock.calls[0][1][0]).toBeNull()  // trimmed empty → null
  })

  test('备注超过500字截断', async () => {
    const longNotes = 'a'.repeat(600)
    const ctx = createManagerCtx({ clientUserId: 'u1', notes: longNotes })

    mockScopeOk()
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await customerRoutes.updateNotes(ctx)

    expect(clientQuery.mock.calls[0][1][0]).toHaveLength(500)
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
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))
    await customerRoutes.updateNotes(ctx)
    // helper INSERT 参数布局：[5]=action, [6]=targetType, [7]=targetId, [8]=detail
    const auditCall = clientQuery.mock.calls.find((c) => c[0].includes('operation_logs'))
    expect(auditCall).toBeDefined()
    expect(auditCall[1][5]).toBe('customer.updateNotes')
    expect(auditCall[1][7]).toBe('u1')
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
    pg.query.mockResolvedValueOnce([{ name: '李四' }])  // SELECT name（pg.query）
    // UPDATE + 审计日志走事务 client
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await customerRoutes.assign(ctx)

    expect(ctx.result.message).toContain('分配成功')
    expect(ctx.result.employeeName).toBe('李四')
    // 事务 client 首个调用 = UPDATE
    const [sql, params] = clientQuery.mock.calls[0]
    expect(sql).toContain('bound_employee_id = $1')
    expect(sql).toContain('bound_employee_name = $2')
    expect(params[0]).toBe('emp-b1')
    expect(params[1]).toBe('李四')
    expect(params[2]).toBe('u1')
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
    pg.query.mockResolvedValueOnce([{ name: '李四' }])  // SELECT name
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))
    await customerRoutes.assign(ctx)
    // helper INSERT 参数布局：[5]=action, [7]=targetId, [8]=detail
    const auditCall = clientQuery.mock.calls.find((c) => c[0].includes('operation_logs'))
    expect(auditCall).toBeDefined()
    expect(auditCall[1][5]).toBe('customer.assign')
    expect(auditCall[1][7]).toBe('u1')
    const detail = JSON.parse(auditCall[1][8])
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

    // assertCustomerInScope 先 SELECT bound_store_id；store-001 命中 scope
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-001', balance: '320.50' },
    ])

    await customerRoutes.customerBalance(ctx)

    expect(ctx.result.cardId).toBe('card-001')
    expect(ctx.result.balance).toBe(320.5)
    // 查询仅按 user_id（无 store_id 条件），prepaid_cards 调用是第二次
    const [sql, params] = pg.query.mock.calls[1]
    expect(sql).toMatch(/FROM prepaid_cards WHERE user_id = \$1/)
    expect(sql).not.toMatch(/store_id/)
    expect(params).toEqual(['cu-001'])
  })

  test('无卡顾客返回 { cardId: null, balance: 0 }', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-nocard' })
    // assertCustomerInScope: 命中 scope
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.customerBalance(ctx)

    expect(ctx.result).toMatchObject({
      cardId: null,
      balance: 0,
      pointsBalance: 0,
      pointsToYuanRate: 0.01,
      pointsDeductionMaxRate: 0.03,
    })
  })

  test('balance 返回为数字类型（Number 转换）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-002' })
    // assertCustomerInScope: 命中 scope
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001' }])
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

  test('已解绑顾客（bound_store_id=NULL）余额仍可查（账户级，不跟门店绑定）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-unbound' })
    // scope 检查 SELECT bound_store_id → NULL（已解绑）
    pg.query.mockResolvedValueOnce([{ bound_store_id: null }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-x', balance: '100000.00' }])

    await customerRoutes.customerBalance(ctx)

    expect(ctx.result.cardId).toBe('card-x')
    expect(ctx.result.balance).toBe(100000)
  })

  test('仍绑定他店（不在 scope）顾客余额仍拒绝（scope 隔离未破坏）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-otherstore' })
    // scope 检查 SELECT bound_store_id → 他店，不在 scopeStoreIds 内
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-999', is_cross_store_temp: false }])

    await expect(customerRoutes.customerBalance(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('临时跨店顾客（绑定他店）余额仍可查（同 card.recharge/inflow 放行口径）', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-temp' })
    // scope 检查 SELECT → 绑定他店但被标记临时跨店，应放行
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-999', is_cross_store_temp: true }])
    pg.query.mockResolvedValueOnce([{ card_id: 'card-temp', balance: '500.00' }])

    await customerRoutes.customerBalance(ctx)

    expect(ctx.result.cardId).toBe('card-temp')
    expect(ctx.result.balance).toBe(500)
  })

  test('顾客不存在拒绝', async () => {
    const ctx = createManagerCtx({ customerUserId: 'cu-missing' })
    pg.query.mockResolvedValueOnce([])  // scope 检查无行
    await expect(customerRoutes.customerBalance(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// 普通员工"员工级档案 scope"（bound_employee_id = 自己）
// createBeauticianCtx.staffWfId = 'emp-beautician-001'，staffLevel='store_staff'
// ============================================================
describe('普通员工档案可见性（员工级 scope）', () => {
  const detailRow = (boundEmployeeId) => ({
    user_id: 'u1', phone: '13800001111', name: '张三', customer_id: 'C001',
    member_level: 'VIP', bound_employee_id: boundEmployeeId, skin_type: null,
    improvement_focus: null, gender: '女', notes: null,
    bound_store_id: 'store-001', store_name: '测试店',
  })

  test('detail：店员可看绑定本人的顾客', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1' })
    pg.query
      .mockResolvedValueOnce([detailRow('emp-beautician-001')])  // 顾客行（bound 给本人）
      .mockResolvedValueOnce([{ name: '美容师' }])               // preferredStaffName
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])  // getConsumptionStats
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])                                  // getTopProduct
    await customerRoutes.detail(ctx)
    expect(ctx.result.clientUserId).toBe('u1')
  })

  test('detail：店员看未绑定本人的顾客 → PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([detailRow('emp-other-999')])  // bound 给别人
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/PERMISSION_DENIED.*未分配/)
  })

  test('detail：店长不受员工级限制（顾客绑给别人也可看）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query
      .mockResolvedValueOnce([detailRow('emp-other-999')])
      .mockResolvedValueOnce([{ name: '美容师' }])
      .mockResolvedValueOnce([{ total: '0', year_total: '0' }])
      .mockResolvedValueOnce([{ last_date: null, visit_count_90d: '0' }])
      .mockResolvedValueOnce([])
    await customerRoutes.detail(ctx)
    expect(ctx.result.clientUserId).toBe('u1')
  })

  test('search + profileScope：店员 SQL 含 bound_employee_id 且带 staffWfId', async () => {
    const ctx = createBeauticianCtx({ keyword: '张', profileScope: true })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.bound_employee_id =')
    expect(params).toContain('emp-beautician-001')
  })

  test('search 无 profileScope（服务单选顾客）：店员 SQL 不含 bound_employee_id', async () => {
    const ctx = createBeauticianCtx({ keyword: '张' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).not.toContain('bound_employee_id')
  })

  test('search + profileScope：店长不加员工过滤', async () => {
    const ctx = createManagerCtx({ keyword: '张', profileScope: true })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).not.toContain('bound_employee_id')
  })

  test('stats：店员统计 SQL 含 bound_employee_id', async () => {
    const ctx = createBeauticianCtx({})
    pg.query
      .mockResolvedValueOnce([])   // 活跃度分类查询
      .mockResolvedValueOnce([{ cnt: '0' }])  // 会员数
    await customerRoutes.stats(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.bound_employee_id =')
    expect(params).toContain('emp-beautician-001')
  })

  test('listByTag：店员列表 SQL 含 bound_employee_id', async () => {
    const ctx = createBeauticianCtx({ tag: 'active', page: 1, pageSize: 10 })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.listByTag(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('c.bound_employee_id =')
    expect(params).toContain('emp-beautician-001')
  })
})

// ============================================================
// customer.appointments
// ============================================================
describe('customer.appointments', () => {
  test('店长返回顾客预约列表', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([
      { appointment_id: 'A1', status: '已确认', client_user_id: 'u1', client_name: '张三',
        employee_name: '美容师', appointment_time: '2026-05-20T03:00:00Z', notes: '准时',
        checkin_at: null, created_at: '2026-05-19T00:00:00Z', service_name: '面部护理' },
    ])
    await customerRoutes.appointments(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].id).toBe('A1')
    expect(ctx.result[0].statusText).toBe('已确认')
    expect(ctx.result[0].serviceItemName).toBe('面部护理')
  })

  test('店员越权（顾客未绑定本人）→ PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1' })
    // 档案闸门 SELECT bound_store_id, bound_employee_id
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-other-999' }])
    await expect(customerRoutes.appointments(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少标识参数拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.appointments(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })
})

// ============================================================
// customer.phoneChangeLogs
// ============================================================
describe('customer.phoneChangeLogs', () => {
  test('映射 admin(customer.update) 与 client(rebindPhone) 两类记录', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query
      // 档案闸门
      .mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-x' }])
      // operation_logs
      .mockResolvedValueOnce([
        { id: 2, created_at: '2026-05-20T00:00:00Z', action: 'customer.update',
          detail: { changes: { phone: { from: '13800001111', to: '13900002222' } } },
          source: 'admin', operator_employee_id: 'emp-009', operator_name: '王五' },
        { id: 1, created_at: '2026-05-10T00:00:00Z', action: 'auth.rebindPhone',
          detail: { oldPhone: '13700001111', newPhone: '13800001111', clientUserId: 'u1' },
          source: 'client', operator_employee_id: null, operator_name: null },
      ])
    await customerRoutes.phoneChangeLogs(ctx)
    expect(ctx.result).toHaveLength(2)
    // manager 看全号
    expect(ctx.result[0].source).toBe('admin')
    expect(ctx.result[0].oldPhone).toBe('13800001111')
    expect(ctx.result[0].newPhone).toBe('13900002222')
    expect(ctx.result[0].operatorLabel).toBe('王五')
    expect(ctx.result[1].source).toBe('client')
    expect(ctx.result[1].operatorLabel).toBe('顾客自助')
  })

  test('店员越权（顾客未绑定本人）→ PERMISSION_DENIED', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-other-999' }])
    await expect(customerRoutes.phoneChangeLogs(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('解析不到 user_id 返回空数组', async () => {
    const ctx = createManagerCtx({ clientPhone: '19900000000' })
    pg.query.mockResolvedValueOnce([])  // 解析 user_id 无行
    await customerRoutes.phoneChangeLogs(ctx)
    expect(ctx.result).toEqual([])
  })

  // ---------- #240 分页取整 ----------
  // 改前写法 `Math.min(100, Math.max(1, Number(pageSize) || 50))` 不取整：
  // 2.5 既 >1 又 <100，两个夹子双双失效 → 2.5 原样进 LIMIT，
  // PG 按 int8 解析抛 `invalid input syntax for type bigint: "2.5"`（500 级，非降级）。
  test('#240 小数 pageSize 被取整：LIMIT/OFFSET 参数必须是整数', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', page: 2.7, pageSize: 2.5 })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-x' }])
      .mockResolvedValueOnce([])
    await customerRoutes.phoneChangeLogs(ctx)

    // 按 SQL 特征取调用，不硬编码 mock.calls 下标 —— 守卫查询数量将来变化时不会误判
    const logCall = pg.query.mock.calls.find(c => /FROM operation_logs/.test(c[0]))
    expect(logCall[0]).toContain('LIMIT $2 OFFSET $3')
    // pageSize=2.5→2，page=2.7→2，offset=(2-1)*2=2
    expect(logCall[1]).toEqual(['u1', 2, 2])
    expect(Number.isInteger(logCall[1][1])).toBe(true)
    expect(Number.isInteger(logCall[1][2])).toBe(true)
  })

  test("#240 非安全整数回落默认 50：'Infinity' / 1e21 不得进 LIMIT/OFFSET", async () => {
    const ctxInf = createManagerCtx({ clientUserId: 'u1', page: 'Infinity', pageSize: 'Infinity' })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-x' }])
      .mockResolvedValueOnce([])
    await customerRoutes.phoneChangeLogs(ctxInf)
    expect(pg.query.mock.calls.find(c => /FROM operation_logs/.test(c[0]))[1])
      .toEqual(['u1', 50, 0])

    pg.query.mockClear()
    const ctxHuge = createManagerCtx({ clientUserId: 'u1', page: 1e21, pageSize: 1e21 })
    pg.query
      .mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-x' }])
      .mockResolvedValueOnce([])
    await customerRoutes.phoneChangeLogs(ctxHuge)
    // 1e21 超出安全整数范围（pg 会序列化成 "1e+21" 文本）→ 回落默认 50 / 第 1 页
    const hugeParams = pg.query.mock.calls.find(c => /FROM operation_logs/.test(c[0]))[1]
    expect(hugeParams).toEqual(['u1', 50, 0])
    expect(Number.isInteger(hugeParams[2])).toBe(true)
  })
})

// ============================================================
// customer.coupons
// ============================================================
describe('customer.coupons', () => {
  test('店员越权（顾客未绑定本人）→ PERMISSION_DENIED，且不查询优惠券', async () => {
    const ctx = createBeauticianCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([{ bound_store_id: 'store-001', bound_employee_id: 'emp-other-999' }])

    await expect(customerRoutes.coupons(ctx)).rejects.toThrow(/PERMISSION_DENIED.*未分配/)

    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).toContain('bound_employee_id')
  })
})
