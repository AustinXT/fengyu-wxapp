const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')
const orderRoutes = require('../../routes/order')
const appointmentRoutes = require('../../routes/appointment')
const serviceRoutes = require('../../routes/service')
const allocationRoutes = require('../../routes/allocation')
const serviceCommissionRoutes = require('../../routes/serviceCommission')
const { __resetAttributionGuardCache } = require('../../utils/attribution-guard')

/**
 * 带日期筛选的路由会先跑 attribution-guard 探针（#139），它占用第一次 pg.query。
 * 每个用例显式 mock 探针 + 重置模块级缓存，保证断言不依赖用例执行顺序
 * （guard 只缓存"已就绪"，若靠缓存跳过探针，改测试顺序就会漂）。
 */
const mockAttributionReady = () => pg.query.mockResolvedValueOnce([{ has_gap: false }])
/** 探针之后那一次 query 才是被测列表 SQL */
const listCall = () => pg.query.mock.calls[1]

describe('业务列表统一筛选', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAttributionGuardCache()
  })

  test('order.list 组合姓名、手机号、业绩归属日期并倒序', async () => {
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ keyword: '138-12', startDate: '2026-08-01', endDate: '2026-08-26' })
    await orderRoutes.list(ctx)
    const [sql, params] = listCall()
    const flat = sql.replace(/\s+/g, ' ')
    expect(sql).toContain("COALESCE(c.name, o.customer_name, '') ILIKE")
    expect(sql).toContain('regexp_replace')
    // #139 订单粒度：EXISTS 半连接命中订单。status='已支付' 是语义闸门不是优化——
    // 未入账行的归属日期由 created_at 占位、首次支付行又是订单级镜像，缺它会带进未入账款项。
    // 条件与闸门绑成整句断言，避免别处出现同名片段稀释本用例。
    expect(flat).toContain(
      "EXISTS ( SELECT 1 FROM sale_order_payments pf WHERE pf.sale_order_id = o.sale_order_id AND pf.status = '已支付'",
    )
    // 归属日期是 date，闭区间比较（不得退回 timestamptz 半开区间）
    expect(flat).toMatch(/pf\.performance_attribution_date >= \$\d+::date/)
    expect(flat).toMatch(/pf\.performance_attribution_date <= \$\d+::date/)
    // 归属日期只许在这个 EXISTS 里出现两次、且别名恒为 pf：
    // 数量与别名一起锁死，既挡"多挂一处筛选"也挡"改走别的表/别名"
    expect(flat.match(/\w+\.performance_attribution_date/g)).toEqual([
      'pf.performance_attribution_date',
      'pf.performance_attribution_date',
    ])
    // 旧口径必须消失：下单时间不再参与筛选（仍是排序字段，故只断言比较形态）
    expect(flat).not.toContain('o.sale_order_datetime >=')
    expect(flat).not.toContain('o.sale_order_datetime <')
    expect(sql).toContain('ORDER BY o.sale_order_datetime DESC, o.sale_order_id DESC')
    expect(params).toContain('%13812%')
    expect(params).toContain('2026-08-01')
    expect(params).toContain('2026-08-26')
  })

  test('order.list 只传结束日期时只挂上界，不留悬空 AND', async () => {
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ endDate: '2026-08-26' })
    await orderRoutes.list(ctx)
    const [sql, params] = listCall()
    const flat = sql.replace(/\s+/g, ' ')
    expect(flat).toMatch(/pf\.performance_attribution_date <= \$\d+::date/)
    expect(flat).not.toContain('performance_attribution_date >=')
    expect(flat).not.toMatch(/AND\s+\)/)
    expect(params).toContain('2026-08-26')
  })

  // concurrency-adversary P2-2：唯一在日期条件**之后**才 push 的分支是美容师的
  // preferred_employee_id，且既有断言全是 toContain（不校验位置）。这里把位置钉死。
  test('order.list 美容师 + 日期：LIMIT/OFFSET 编号不被新条件挤错位', async () => {
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ startDate: '2026-08-01', endDate: '2026-08-26' })
    ctx.auth.roles = ['store_staff']
    ctx.auth.staffWfId = 'EMP-0007'
    await orderRoutes.list(ctx)
    const [sql, params] = listCall()
    // 期望绑定顺序：$1 门店 → $2 起 → $3 止 → $4 员工 → $5 pageSize → $6 offset
    expect(params).toEqual([ctx.auth.effectiveStoreId, '2026-08-01', '2026-08-26', 'EMP-0007', 20, 0])
    const limitMatch = sql.match(/LIMIT \$(\d+) OFFSET \$(\d+)/)
    expect(limitMatch).not.toBeNull()
    expect(Number(limitMatch[1])).toBe(params.length - 1)
    expect(Number(limitMatch[2])).toBe(params.length)
    // 员工条件必须排在两个日期参数之后（顺序错了上面的 toEqual 也会红，这里再钉一次语义）
    expect(params.indexOf('EMP-0007')).toBeGreaterThan(params.indexOf('2026-08-26'))
    expect(sql).toContain(`o.preferred_employee_id = $${params.indexOf('EMP-0007') + 1}`)
  })

  test('order.list 未迁移库（首次支付行归属日期为 NULL）拒绝返回空结果', async () => {
    pg.query.mockResolvedValueOnce([{ has_gap: true }])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    // 只跑了探针，没发出列表查询——宁可报错也不出错数据
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('order.list 不带日期时不触发迁移探针', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ keyword: '138' })
    await orderRoutes.list(ctx)
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).not.toContain('has_gap')
  })

  test('appointment.list 支持状态、搜索和日期组合', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ status: 'completed', keyword: '李女士', startDate: '2026-08-01' })
    await appointmentRoutes.list(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('a.status =')
    expect(sql).toContain("COALESCE(a.client_name, wu.name, '') ILIKE")
    expect(sql).toContain('ORDER BY a.appointment_time DESC, a.appointment_id DESC')
    expect(params).toContain('已完成')
  })

  test('service.list 支持全部状态、顾客搜索和服务日期', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ keyword: '张', endDate: '2026-08-26', pageSize: 20 })
    await serviceRoutes.list(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).toContain('EXISTS (')
    expect(sql).toContain('so.service_date <=')
    expect(sql).toContain('ORDER BY so.service_date DESC, so.created_at DESC, so.service_order_id DESC')
  })

  test('allocation.pendingPayments 支持全部状态与业绩归属日期', async () => {
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({
      allocationStatus: '全部',
      keyword: '138',
      startDate: '2026-08-01',
      endDate: '2026-08-26',
    })
    await allocationRoutes.pendingPayments(ctx)
    const [sql, params] = listCall()
    const flat = sql.replace(/\s+/g, ' ')
    expect(sql).toContain('p.allocation_status IS NOT NULL')
    expect(sql).not.toContain('p.allocation_status = $2')
    // #139 款项粒度：约束当前这一行款项的归属日期，闭区间
    expect(flat).toMatch(/p\.performance_attribution_date >= \$\d+::date/)
    expect(flat).toMatch(/p\.performance_attribution_date <= \$\d+::date/)
    // 不得退化成订单级 EXISTS 半连接（会把同订单里区间外的其他回款一并带出）：
    // 锁死归属日期只出现两次且别名恒为 p——套进任何子查询都会换别名或增加出现次数
    expect(flat.match(/\w+\.performance_attribution_date/g)).toEqual([
      'p.performance_attribution_date',
      'p.performance_attribution_date',
    ])
    // 旧口径消失：paid_at 只剩 SELECT 与 ORDER BY，不再参与筛选
    expect(flat).not.toContain('p.paid_at >=')
    expect(flat).not.toContain('p.paid_at <')
    expect(flat).toContain('ORDER BY p.paid_at DESC NULLS LAST, p.id DESC')
    expect(params).toContain('2026-08-01')
    expect(params).toContain('2026-08-26')
  })

  test('serviceCommission.pendingList 支持全部状态与服务日期', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ commissionStatus: '全部', keyword: '王', endDate: '2026-08-26' })
    await serviceCommissionRoutes.pendingList(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).not.toContain('so.commission_status =')
    expect(sql).toContain('so.service_date <=')
    expect(sql).toContain('ORDER BY so.service_date DESC, so.updated_at DESC, so.service_order_id DESC')
  })
})
