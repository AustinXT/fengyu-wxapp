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
const mockAttributionReady = () =>
  pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: true }])
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
    pg.query.mockResolvedValueOnce([{ has_gap: true, trigger_ready: false }])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    // 只跑了探针，没发出列表查询——宁可报错也不出错数据
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  // codex round-2 P2：光看数据会漏判——一个几乎空的 0038 库同样没有 NULL 行，
  // 探针会放行并永久缓存 ready，而 0038 的 trigger 仍不给新首次支付行赋值。
  test('order.list 数据无缺口但 trigger 仍是 0038 版本时照样拦截', async () => {
    pg.query.mockResolvedValueOnce([{ has_gap: false, trigger_ready: false }])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('探针返回空行时 fail-closed，不放行可能漏数的查询', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
  })

  // codex round-3 P2：缺这条真值用例，删掉 `probe.has_gap` 判断不会被任何测试抓住
  test('trigger 已就绪但存量仍有缺口时照样拦截', async () => {
    pg.query.mockResolvedValueOnce([{ has_gap: true, trigger_ready: true }])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  /**
   * codex round-3 P2：上面所有用例都直接 mock `trigger_ready`，等于只测了 guard 的 JS 分支，
   * 没测 SQL 本身——把 PROBE_SQL 改成 `true AS trigger_ready`、删掉 pg_proc 子查询、
   * 或把函数名写错，这些用例统统照常绿，而空的 0038 库会再次被永久缓存成 ready。
   * 所以这里直接守护探针 SQL 的实质内容。
   */
  /**
   * 对**实际传给数据库**的探针 SQL 做逐字精确快照（codex round-5 P2）。
   *
   * 为什么不能只快照源码里的 `PROBE_SQL` 常量：那条断言提取的是「源码中第一个含 has_gap
   * 的反引号字符串」，可以保留原常量让它命中，另建一个恶意探针传给 pg.query。
   * 断言这里的 `mock.calls[0][0]` 才真正绑定到执行路径。
   *
   * 与 cross-end-sql-snapshot 那条源码快照互补：这条管「执行的是什么」，
   * 那条管「源码常量有没有被悄悄改」。实现一变两条同时红，不存在一绿一红的漂移。
   */
  test('实际执行的探针 SQL 精确快照', async () => {
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    await orderRoutes.list(createManagerCtx({ startDate: '2026-08-01' }))
    const executed = pg.query.mock.calls[0][0].replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
    expect(executed).toBe(
      "SELECT EXISTS (SELECT 1 FROM sale_order_payments WHERE change_type = '首次支付'"
      + " AND status = '已支付' AND performance_attribution_date IS NULL) AS has_gap,"
      + " COALESCE((SELECT pg_get_functiondef(p.oid) LIKE '%IF NEW.change_type = ''首次支付'' THEN%'"
      + " FROM pg_proc p WHERE p.proname = 'initialize_payment_performance_attribution_date'"
      + ' LIMIT 1), false) AS trigger_ready',
    )
  })

  // GLM round-2 P3：异常路径（探针 reject → finally 清 inflight → 下次重探成功）无用例守护，
  // 将来有人把 .finally 「简化」掉，回归不会被任何测试抓住。
  test('探针瞬时故障后不会钉死后续请求', async () => {
    pg.query.mockRejectedValueOnce(new Error('connection terminated'))
    const ctxFail = createManagerCtx({ startDate: '2026-08-01' })
    await expect(orderRoutes.list(ctxFail)).rejects.toThrow(/connection terminated/)

    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    const ctxOk = createManagerCtx({ startDate: '2026-08-01' })
    await orderRoutes.list(ctxOk)
    expect(ctxOk.result.orders).toEqual([])
    // 第一次故障 + 第二次重探 = 2 次探针（失败不缓存，也不复用 rejected promise）
    const probeCalls = pg.query.mock.calls.filter(([sql]) => sql.includes('has_gap'))
    expect(probeCalls).toHaveLength(2)
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

  // 与 order.list 的未迁移库用例对称（GLM 评审 P3）：
  // 此前 allocation 侧只有 snapshot 的「文件里出现过这行调用」字面断言兜底，
  // 把守卫弱化成空操作不会有任何功能测试变红。
  test('allocation.pendingPayments 未迁移库拒绝返回空结果', async () => {
    pg.query.mockResolvedValueOnce([{ has_gap: true, trigger_ready: false }])
    const ctx = createManagerCtx({ startDate: '2026-08-01' })
    await expect(allocationRoutes.pendingPayments(ctx)).rejects.toThrow(/INVALID_STATE: MIGRATION_REQUIRED/)
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('allocation.pendingPayments 不带日期时不触发迁移探针', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ allocationStatus: '待分配' })
    await allocationRoutes.pendingPayments(ctx)
    expect(pg.query).toHaveBeenCalledTimes(1)
    expect(pg.query.mock.calls[0][0]).not.toContain('has_gap')
  })

  test('并发冷请求共享同一次迁移探针，不重复占用连接池', async () => {
    // codex 评审 P3：两个请求都在第一个 await 前看到 ready=false
    // 用三个 Once 精确覆盖（探针 1 次 + 两个 list 各 1 次）——
    // 持久的 mockResolvedValue 只被 clearAllMocks 清调用记录、不清实现，会悄悄改本文件的 mock 契约
    mockAttributionReady()
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    const ctxA = createManagerCtx({ startDate: '2026-08-01' })
    const ctxB = createManagerCtx({ startDate: '2026-08-01' })
    await Promise.all([orderRoutes.list(ctxA), orderRoutes.list(ctxB)])
    const probeCalls = pg.query.mock.calls.filter(([sql]) => sql.includes('has_gap'))
    expect(probeCalls, '并发冷请求重复发探针').toHaveLength(1)
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
