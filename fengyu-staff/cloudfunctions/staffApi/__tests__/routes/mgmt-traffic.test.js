/**
 * mgmtTraffic 路由测试 — summary action（客量数据子页）
 *
 * 覆盖 5 段 SQL 形态：
 *   - 注册情况 4 项
 *   - 到店客流 traffic + sessions
 *   - 会员状态 5 项截面 + 2 项区间客活 + 3 项本月激活
 *   - 会员被经营 6 桶 CTE
 *   - 新会员经营 + trialFootfall
 * + 入参/权限校验、scope 三档 SQL 拼接
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createManagerCtx } = require('../helpers')
const { summary } = require('../../routes/mgmt-traffic')

// ---- ctx 构造 ----
function makeHqCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'headquarters',
      loginLevel: 'management',
      roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      scopeStoreIds: ['store-001', 'store-002'],
      scopeOrgNodeIds: ['org-hq', 'mkt-A', 'mkt-B'],
    },
  })
}

function makeMarketCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'market',
      loginLevel: 'management',
      roleBindings: [{ role: 'manager', scopeId: 'mkt-A', scopeType: '市场' }],
      scopeStoreIds: ['store-001'],
      scopeOrgNodeIds: ['mkt-A'],
    },
  })
}

function expectRecursiveDescendantScope(sql, rootParamIndex) {
  expect(sql).toMatch(/WITH RECURSIVE descendants\(id, path\) AS/)
  if (rootParamIndex == null) {
    expect(sql).toMatch(/SELECT \$\d+::text, ARRAY\[\$\d+::text\]/)
  } else {
    expect(sql).toMatch(new RegExp('SELECT \\$' + rootParamIndex + '::text, ARRAY\\[\\$' + rootParamIndex + '::text\\]'))
  }
  expect(sql).toMatch(/JOIN descendants ON child\.parent_id = descendants\.id/)
  expect(sql).toMatch(/WHERE NOT child\.id = ANY\(descendants\.path\)/)
  expect(sql).toMatch(/JOIN descendants ON s\.org_node_id = descendants\.id/)
}

// ---- 默认 mock：根据 SQL 形态返回对应 shape ----
function setupDefaultMocks({
  marketName = '华东市场',
  storeName = '凤御A店',
} = {}) {
  pg.query.mockReset().mockImplementation(async (sql) => {
    if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) {
      return [{ name: marketName }]
    }
    if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) {
      return [{ store_name: storeName }]
    }
    // 客流 traffic SQL（ROLLUP）
    if (/GROUP BY ROLLUP\(c\.customer_type\)/.test(sql) && /SUM\(sit\.session_used\)/.test(sql)) {
      return [
        { customer_type: '体验客', sessions: 10 },
        { customer_type: '小美客', sessions: 20 },
        { customer_type: '会员客', sessions: 30 },
        { customer_type: null, sessions: 60 },
      ]
    }
    if (/GROUP BY ROLLUP\(c\.customer_type\)/.test(sql) && /COUNT\(DISTINCT so\.client_user_id\)/.test(sql)) {
      return [
        { customer_type: '体验客', cnt: 5, users: 3 },
        { customer_type: '小美客', cnt: 6, users: 4 },
        { customer_type: '会员客', cnt: 9, users: 5 },
        { customer_type: null, cnt: 20, users: 12 },
      ]
    }
    // 会员状态 5 项截面（normalRows: 4 项分组）
    if (/customer_status IN \('保有会员-稳定'/.test(sql) && /GROUP BY c\.customer_status/.test(sql)) {
      return [
        { s: '保有会员-稳定', v: 50 },
        { s: '保有会员-有效', v: 60 },
        { s: '冰冻', v: 150 },
        { s: '休眠', v: 200 },
      ]
    }
    // 会员被经营 6 桶
    if (/WITH member_spend AS/.test(sql) && /bucket1_count/.test(sql)) {
      return [{
        bucket1_count: 50, bucket1_spend: 25000,
        bucket2_count: 20, bucket2_spend: 50000,
        bucket3_count: 5, bucket3_spend: 75000,
        bucket4_count: 1, bucket4_spend: 35000,
        bucket5_count: 0, bucket5_spend: 0,
        bucket6_count: 0, bucket6_spend: 0,
        total_spend: 185000,
        total_count: 76,
      }]
    }
    // 注册 / 客活 / 新会员 / 激活 等单值返回
    return [{ v: 7 }]
  })
}

describe('mgmtTraffic.summary 入参/权限校验', () => {
  test('缺 period 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
  })

  test('不合法 period 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'today', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*时间维度/)
  })

  test('不合法 scopeType 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scopeType: 'foo' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围类型/)
  })

  test('scopeType=market 缺 scopeId 抛 INVALID_PARAMS', async () => {
    const ctx = makeHqCtx({ period: 'month', scopeType: 'market' })
    await expect(summary(ctx)).rejects.toThrow(/INVALID_PARAMS.*范围 ID/)
  })

  test('门店模式调用管理层接口被 requireManagementLevel 拦截', async () => {
    const ctx = createManagerCtx({ period: 'month', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market 账号选 all → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'all' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*全部市场/)
  })

  test('market 账号越权选其他 market → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'market', scopeId: 'mkt-B' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*市场/)
  })

  test('market 账号越权选其他 store → PERMISSION_DENIED', async () => {
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'store', scopeId: 'store-X' })
    await expect(summary(ctx)).rejects.toThrow(/PERMISSION_DENIED.*越权.*门店/)
  })

  test('market 账号选自己市场 → 通过', async () => {
    setupDefaultMocks()
    const ctx = makeMarketCtx({ period: 'month', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)
    expect(ctx.result.scope).toEqual({ type: 'market', id: 'mkt-A', name: '华东市场' })
  })
})

describe('mgmtTraffic.summary 注册情况 SQL 形态', () => {
  test('3 段用 created_at <=（regTotal/regOnly/regTrial），regMember 单独用 became_member_at', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const regSqls = sqlList.filter(
      (s) =>
        /FROM client_wechat_users c/.test(s) &&
        /c\.created_at::date\s*<=/.test(s),
    )
    expect(regSqls.length).toBe(3)

    // 1 段不含 customer_type=（regTotal）
    const noTypeSqls = regSqls.filter((s) => !/c\.customer_type\s*=\s*'/.test(s))
    expect(noTypeSqls.length).toBe(1)

    // 2 段分别命中流量客 / 体验客
    expect(regSqls.some((s) => /c\.customer_type\s*=\s*'流量客'/.test(s))).toBe(true)
    expect(regSqls.some((s) => /c\.customer_type\s*=\s*'体验客'/.test(s))).toBe(true)

    // regMember 单独用 became_member_at IS NOT NULL + became_member_at::date <=
    const memberSql = sqlList.find(
      (s) =>
        /FROM client_wechat_users c/.test(s) &&
        /c\.became_member_at\s+IS\s+NOT\s+NULL/.test(s) &&
        /c\.became_member_at::date\s*<=/.test(s),
    )
    expect(memberSql).toBeTruthy()
  })

  test('返回 registration 4 项数字', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.registration).toEqual({
      regTotal: 7, regOnly: 7, regTrial: 7, regMember: 7,
    })
  })
})

describe('mgmtTraffic.summary 到店客流 SQL 形态', () => {
  test('traffic SQL 含 JOIN client_wechat_users + service_date BETWEEN + 已完成', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const trafficCountSql = sqlList.find(
      (s) =>
        /FROM service_orders so/.test(s) &&
        /JOIN client_wechat_users c\b/.test(s) &&
        /COUNT\(DISTINCT so\.client_user_id\)/.test(s) &&
        /GROUP BY ROLLUP/.test(s),
    )
    expect(trafficCountSql).toBeDefined()
    expect(trafficCountSql).toMatch(/so\.status\s*=\s*'已完成'/)
    expect(trafficCountSql).toMatch(/so\.service_date\s+BETWEEN/)

    const sessSql = sqlList.find(
      (s) =>
        /JOIN service_items sit/.test(s) &&
        /SUM\(sit\.session_used\)/.test(s) &&
        /GROUP BY ROLLUP/.test(s),
    )
    expect(sessSql).toBeDefined()
    expect(sessSql).toMatch(/sit\.sales_category\s+IN\s*\('自销自耗',\s*'他销自耗'\)/)
    expect(sessSql).toMatch(/so\.service_date\s+BETWEEN/)
  })

  test('返回 traffic 4 行：total/trial/xiaomei/member 各含 count/users/sessions', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.traffic).toHaveLength(4)
    const types = ctx.result.traffic.map((t) => t.type)
    expect(types).toEqual(['total', 'trial', 'xiaomei', 'member'])
    // total 行（customer_type=null 走 ROLLUP）
    const total = ctx.result.traffic.find((t) => t.type === 'total')
    expect(total).toEqual({ type: 'total', label: '总', count: 20, users: 12, sessions: 60 })
    const trial = ctx.result.traffic.find((t) => t.type === 'trial')
    expect(trial.sessions).toBe(10)
  })
})

describe('mgmtTraffic.summary 会员状态 + 客活 SQL 形态', () => {
  test('5 项截面含 customer_status IN 4 值 + warn 段含 customer_type 会员客', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const breakdownSql = sqlList.find(
      (s) =>
        /customer_status IN \('保有会员-稳定'/.test(s) &&
        /GROUP BY c\.customer_status/.test(s),
    )
    expect(breakdownSql).toBeDefined()
    expect(breakdownSql).toMatch(/'保有会员-有效'/)
    expect(breakdownSql).toMatch(/'冰冻'/)
    expect(breakdownSql).toMatch(/'休眠'/)

    const warnSql = sqlList.find(
      (s) =>
        /c\.customer_status\s*=\s*'(预警沉睡|沉睡)'/.test(s) &&
        /c\.customer_type\s*=\s*'会员客'/.test(s),
    )
    expect(warnSql).toBeDefined()

    expect(ctx.result.status.retainedStable).toBe(50)
    expect(ctx.result.status.retainedActive).toBe(60)
    expect(ctx.result.status.dormantFrozen).toBe(150)
    expect(ctx.result.status.dormantDeep).toBe(200)
  })

  test('客活 SQL 含 visit_count CTE + n=1 / n>=2', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const onceSql = sqlList.find(
      (s) =>
        /WITH visit_count AS/.test(s) &&
        /vc\.n\s*=\s*1/.test(s),
    )
    expect(onceSql).toBeDefined()
    expect(onceSql).toMatch(/c\.customer_status IN \('保有会员-稳定',\s*'保有会员-有效'\)/)

    const twiceSql = sqlList.find(
      (s) =>
        /WITH visit_count AS/.test(s) &&
        /vc\.n\s*>=\s*2/.test(s),
    )
    expect(twiceSql).toBeDefined()
  })

  test('本月激活 3 项含 anchor=startDate-1 展开 + visits_90d_prev=0', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const reactivatedSqls = sqlList.filter(
      (s) =>
        /WITH visited_in_period AS/.test(s) &&
        /anchor_stats AS/.test(s) &&
        /visits_90d_prev\s*=\s*0/.test(s),
    )
    expect(reactivatedSqls.length).toBe(3)

    for (const s of reactivatedSqls) {
      expect(s).toMatch(/\$1::date\s*-\s*1\s*-\s*INTERVAL\s+'90 days'/)
      expect(s).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
      expect(s).toMatch(/c\.became_member_at::date\s*<=\s*\(\$1::date\s*-\s*1\)/)
    }

    // warn 段含 6 months
    expect(reactivatedSqls.some((s) => /a\.last_dt\s*>=\s*\(\$1::date\s*-\s*1\s*-\s*INTERVAL\s+'6 months'\)/.test(s))).toBe(true)
    // frozen 段含 12 months 上界
    expect(reactivatedSqls.some((s) => /a\.last_dt\s*>=\s*\(\$1::date\s*-\s*1\s*-\s*INTERVAL\s+'12 months'\)/.test(s))).toBe(true)
    // deep 段允许 last_dt IS NULL
    expect(reactivatedSqls.some((s) => /a\.last_dt\s+IS\s+NULL/.test(s))).toBe(true)
  })
})

describe('mgmtTraffic.summary 会员被经营 6 桶 SQL 形态', () => {
  test('SQL 含 WITH member_spend / customer_type=会员客 / 6 个 FILTER (WHERE spend ...)', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const opsSql = sqlList.find(
      (s) =>
        /WITH member_spend AS/.test(s) &&
        /bucket1_count/.test(s),
    )
    expect(opsSql).toBeDefined()
    expect(opsSql).toMatch(/c\.customer_type\s*=\s*'会员客'/)
    // #138：spend 从「订单快照 received - refunded_amount @ paid_at」
    // 改为「已入账款项流水 SUM(spe.amount) @ performance_date」，与业绩 KPI 同源
    expect(opsSql).toMatch(/SUM\(spe\.amount::numeric\)\s+AS\s+spend/)
    expect(opsSql).toMatch(/FROM sale_order_performance_events spe/)
    expect(opsSql).toMatch(/spe\.sale_order_type IN \('销售单',\s*'转换单'\)/)
    expect(opsSql).toMatch(/spe\.status\s*=\s*'已支付'/)
    expect(opsSql).toMatch(/spe\.change_type IN \('首次支付',\s*'回款',\s*'退款'\)/)
    expect(opsSql).toMatch(/spe\.performance_date\s+BETWEEN/)
    // 旧口径必须消失（订单快照 + paid_at + 父订单状态过滤）
    expect(opsSql).not.toMatch(/received::numeric\s*-\s*COALESCE/)
    expect(opsSql).not.toMatch(/o\.paid_at::date\s+BETWEEN/)
    expect(opsSql).not.toMatch(/o\.status\s*=\s*'已支付'/)
    // #292：最低档下界 = 会员门槛，走参数占位（不再写死 1990）；占位号 = 最后一个参数
    const opsCall = pg.query.mock.calls.find((c) => c[0] === opsSql)
    const th = `\\$${opsCall[1].length}`
    expect(opsCall[1][opsCall[1].length - 1]).toBe(1980) // setup.js 全局 mock 的默认门槛
    expect(opsSql).not.toMatch(/(?<!\d)1990(?!\d)/)
    expect(opsSql).toMatch(new RegExp(`FILTER \\(WHERE spend\\s*<\\s*${th}\\)`))
    expect(opsSql).toMatch(new RegExp(`FILTER \\(WHERE spend\\s*>=\\s*${th}\\s+AND\\s+spend\\s*<\\s*10000\\)`))
    expect(opsSql).toMatch(/FILTER \(WHERE spend\s*>=\s*10000\s+AND\s+spend\s*<\s*30000\)/)
    expect(opsSql).toMatch(/FILTER \(WHERE spend\s*>=\s*30000\s+AND\s+spend\s*<\s*60000\)/)
    expect(opsSql).toMatch(/FILTER \(WHERE spend\s*>=\s*60000\s+AND\s+spend\s*<\s*100000\)/)
    expect(opsSql).toMatch(/FILTER \(WHERE spend\s*>=\s*100000\)/)
  })

  test('#292 会员门槛读 system_configs：改配置值后分桶下界同步变化', async () => {
    setupDefaultMocks()
    globalThis.__mocks__.config.getMemberThreshold.mockResolvedValue(2990)
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)
    const call = pg.query.mock.calls.find((c) => /WITH member_spend AS/.test(c[0]) && /bucket1_count/.test(c[0]))
    expect(call).toBeDefined()
    const params = call[1]
    expect(params[params.length - 1]).toBe(2990)
    const th = `$${params.length}`
    expect(call[0]).toContain(`FILTER (WHERE spend < ${th}) AS bucket1_count`)
    expect(call[0]).toContain(`FILTER (WHERE spend >= ${th} AND spend < 10000) AS bucket2_count`)
  })

  test('返回 6 桶 + avgTicket（防除零）', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.memberOps.buckets).toHaveLength(6)
    const tiers = ctx.result.memberOps.buckets.map((b) => b.tier)
    expect(tiers).toEqual(['<1990', '1990-1W', '1-3W', '3-6W', '6-10W', '10W+'])
    // 总 spend=185000 / count=76 = 2434.21
    expect(ctx.result.memberOps.avgTicket).toBeCloseTo(2434.21, 2)
  })

  test('avgTicket 防除零（total_count=0 → 0）', async () => {
    pg.query.mockReset().mockImplementation(async (sql) => {
      if (/FROM org_nodes\b/.test(sql) && /SELECT name\b/.test(sql)) return [{ name: '' }]
      if (/FROM stores\b/.test(sql) && /SELECT store_name/.test(sql)) return [{ store_name: '' }]
      if (/WITH member_spend AS/.test(sql) && /bucket1_count/.test(sql)) {
        return [{
          bucket1_count: 0, bucket1_spend: 0,
          bucket2_count: 0, bucket2_spend: 0,
          bucket3_count: 0, bucket3_spend: 0,
          bucket4_count: 0, bucket4_spend: 0,
          bucket5_count: 0, bucket5_spend: 0,
          bucket6_count: 0, bucket6_spend: 0,
          total_spend: 0, total_count: 0,
        }]
      }
      // 客流 ROLLUP mock 兜底
      if (/GROUP BY ROLLUP/.test(sql)) return []
      if (/customer_status IN/.test(sql)) return []
      return [{ v: 0 }]
    })

    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.memberOps.avgTicket).toBe(0)
    expect(Number.isNaN(ctx.result.memberOps.avgTicket)).toBe(false)
  })
})

describe('mgmtTraffic.summary 新会员经营 + trialFootfall', () => {
  test('newMemberCount SQL 含 became_member_at IS NOT NULL ∩ became_member_at::date BETWEEN', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const newMemSql = sqlList.find(
      (s) =>
        /FROM client_wechat_users c/.test(s) &&
        /c\.became_member_at\s+IS\s+NOT\s+NULL/.test(s) &&
        /c\.became_member_at::date\s+BETWEEN/.test(s) &&
        !/JOIN sale_orders/.test(s) &&
        !/FROM sale_orders/.test(s),
    )
    expect(newMemSql).toBeDefined()
  })

  test('newMemberSpend SQL 走款项流水视图 + became_member_at + performance_date BETWEEN', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const spendSql = sqlList.find(
      (s) =>
        /FROM sale_order_performance_events spe/.test(s) &&
        /JOIN client_wechat_users c/.test(s) &&
        /c\.became_member_at::date\s+BETWEEN/.test(s) &&
        /spe\.performance_date\s+BETWEEN/.test(s),
    )
    expect(spendSql).toBeDefined()
    // #138 同 memberOps：款项流水 @ 归属日期
    expect(spendSql).toMatch(/SUM\(spe\.amount::numeric\)/)
    expect(spendSql).toMatch(/spe\.sale_order_type IN \('销售单',\s*'转换单'\)/)
    expect(spendSql).toMatch(/spe\.status\s*=\s*'已支付'/)
    expect(spendSql).toMatch(/spe\.change_type IN \('首次支付',\s*'回款',\s*'退款'\)/)
    expect(spendSql).not.toMatch(/received::numeric\s*-\s*COALESCE/)
    expect(spendSql).not.toMatch(/o\.paid_at::date\s+BETWEEN/)
  })

  /**
   * #284（2026-09-22 拍板 D-conv-denom=1c，推翻原 D-2=B）：
   * 分母 = ① 期初未达会员的到店活跃池 ∪ ② 本期全部新增会员。
   *
   * ⚠ 只断言「含 `customer_type IN ('体验客','小美客')`」是**无效守护** —— 回退到旧口径
   * （删掉 OR 分支和整个 ② 分支）后该字面量依然在 ① 里，断言照样绿。因此这里逐条锁住
   * 两个分支各自的结构性特征。
   */
  function findTrialSql() {
    return pg.query.mock.calls.find((c) => /COUNT\(DISTINCT t\.uid\)/.test(c[0]))
  }

  test('trialFootfall ① 到店活跃池：期初未达会员 = 当前仍未达会员 OR 本期内才转化', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const call = findTrialSql()
    expect(call, 'trialFootfall 查询未找到（分母外层不是 COUNT(DISTINCT t.uid)）').toBeDefined()
    const trialSql = call[0]
    expect(trialSql).toMatch(/FROM service_orders so/)
    expect(trialSql).toMatch(/JOIN client_wechat_users c/)
    expect(trialSql).toMatch(/so\.status\s*=\s*'已完成'/)
    expect(trialSql).toMatch(/so\.service_date\s+BETWEEN/)
    // OR 缺失 = 回到「只升不降的当前快照」，本期已转化者被整体抹掉（#284 的原始缺陷）
    expect(
      trialSql,
      '① 分支缺 became_member_at OR 分支 —— 本期已转化的人会被重新抹出分母',
    ).toMatch(
      /c\.customer_type\s+IN\s*\('体验客',\s*'小美客'\)\s*OR\s+c\.became_member_at::date\s+BETWEEN/,
    )
  })

  test('trialFootfall ② 本期全部新增会员 UNION 进分母（保证分子 ⊆ 分母，成交率 ≤ 100%）', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const trialSql = findTrialSql()[0]
    // ② 分支缺失 = 退回方案 1a：本期无已完成服务单的新增会员进分子不进分母 → 单店仍可能 > 100%
    expect(trialSql, '② 分支（本期全部新增会员）缺失，成交率上限不再成立').toMatch(
      /UNION[\s\S]*?SELECT c\.user_id AS uid[\s\S]*?FROM client_wechat_users c/,
    )

    // ⚠ 必须切出 UNION 之后的 ② 分支再断言日期条件：`became_member_at::date BETWEEN`
    // 在 ① 的 OR 右半边也有，对整条 SQL toMatch 时，把 ② 的日期限定删掉
    // （分母纳入全部历史会员、回溯到 2022-08）守护照样全绿。
    const branch2 = trialSql.split(/\bUNION\b/)[1] || ''
    expect(branch2, 'UNION ② 分支切不出来').toBeTruthy()
    expect(branch2, '② 缺 became_member_at IS NOT NULL 守卫').toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
    expect(branch2, '② 缺本期限定 —— 分母会纳入全部历史会员').toMatch(/c\.became_member_at::date\s+BETWEEN/)
    // ⚠ 不在这里断言 ② 的 scope 列：本用例是 scopeType='all'，
    // buildManagementStoreScope 此档返回字面量 'TRUE'，SQL 里根本不出现 bound_store_id。
    // 「② 按 bound_store_id 取 scope」由下面 market/store 两档的 test.each 覆盖。
  })

  test.each([
    ['market', 'mkt-A', /so\.store_id\s+IN\s*\(/, /c\.bound_store_id\s+IN\s*\(/],
    ['store', 'store-001', /so\.store_id\s*=\s*\$1\b/, /c\.bound_store_id\s*=\s*\$2\b/],
  ])(
    'trialFootfall 两段 scope 参数连号（scopeType=%s）',
    async (scopeType, scopeId, visitRe, memberRe) => {
      setupDefaultMocks()
      const ctx = makeHqCtx({ period: 'month', scopeType, scopeId })
      await summary(ctx)

      const [trialSql, params] = findTrialSql()
      // ① so.store_id 用 $1、② c.bound_store_id 用 $2；两段各绑一个根节点参数
      expect(params, '两段 scope 的参数未按序拼接').toEqual([scopeId, scopeId])
      expect(trialSql).toMatch(visitRe)
      expect(trialSql).toMatch(memberRe)
      // 第二段起始下标写死成 1 时 $2 不会出现 → PG 运行期报 "bind message supplies 2 parameters"
      expect(trialSql, '② 分支未使用 $2 —— 第二段 scope 起始下标没有按 ① 的 params 长度接续').toMatch(
        /\$2\b/,
      )
    },
  )

  test('返回 newMembers { count, spend, trialFootfall }', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.newMembers).toEqual({ count: 7, spend: 7, trialFootfall: 7 })
  })
})

describe('mgmtTraffic.summary scope 三档 SQL 拼接', () => {
  test('scopeType=all：所有 metric SQL 含 WHERE TRUE，无 store_id 过滤', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])
    const metricSqls = sqlList.filter(
      (s) =>
        /(sale_orders|service_orders|client_wechat_users)/.test(s) &&
        !/SELECT store_name FROM stores\b/.test(s),
    )
    expect(metricSqls.length).toBeGreaterThan(0)
    for (const s of metricSqls) {
      expect(s).toMatch(/WHERE\s+TRUE/)
      expect(s).not.toMatch(/store_id\s*=\s*\$/)
      expect(s).not.toMatch(/bound_store_id\s*=\s*\$/)
    }
  })

  test('scopeType=market：service/sale/client 类均通过递归后代组织树过滤', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'market', scopeId: 'mkt-A' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    // service_orders / sale_orders（不含 client_wechat_users 表的纯 client SQL）类
    const saleServiceSqls = sqlList.filter(
      (s) =>
        (/(FROM|JOIN)\s+sale_orders/.test(s) || /(FROM|JOIN)\s+service_orders/.test(s)) &&
        !/SELECT store_name FROM stores\b/.test(s),
    )
    expect(saleServiceSqls.length).toBeGreaterThan(0)
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/(so|o)\.store_id\s+IN\s*\(/)
      expectRecursiveDescendantScope(s)
    }

    // 纯 client_wechat_users SQL（注册情况、会员状态、激活、新会员 count）
    const pureClientSqls = sqlList.filter(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        !/FROM\s+(sale_orders|service_orders)/.test(s) &&
        !/JOIN\s+(sale_orders|service_orders)/.test(s),
    )
    expect(pureClientSqls.length).toBeGreaterThan(0)
    for (const s of pureClientSqls) {
      expect(s).toMatch(/c\.bound_store_id\s+IN\s*\(/)
      expectRecursiveDescendantScope(s)
    }
  })

  test('scopeType=store：含 store_id = $n / bound_store_id = $n 单值过滤', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'store', scopeId: 'store-001' })
    await summary(ctx)

    const sqlList = pg.query.mock.calls.map((c) => c[0])

    const saleServiceSqls = sqlList.filter(
      (s) =>
        (/(FROM|JOIN)\s+sale_orders/.test(s) || /(FROM|JOIN)\s+service_orders/.test(s)) &&
        !/SELECT store_name FROM stores\b/.test(s),
    )
    for (const s of saleServiceSqls) {
      expect(s).toMatch(/(so|o)\.store_id\s*=\s*\$\d/)
      expect(s).not.toMatch(/store_id\s+IN\s*\(/)
    }

    const pureClientSqls = sqlList.filter(
      (s) =>
        /FROM\s+client_wechat_users\s+c/.test(s) &&
        !/FROM\s+(sale_orders|service_orders)/.test(s) &&
        !/JOIN\s+(sale_orders|service_orders)/.test(s),
    )
    for (const s of pureClientSqls) {
      expect(s).toMatch(/c\.bound_store_id\s*=\s*\$\d/)
    }
  })
})

describe('mgmtTraffic.summary 返回结构 + period 解析', () => {
  test('返回完整结构（period/scope/startDate/endDate/registration/traffic/status/memberOps/newMembers/computedAt）', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.period).toBe('month')
    expect(ctx.result.scope).toEqual({ type: 'all', id: null, name: '全部市场' })
    expect(typeof ctx.result.startDate).toBe('string')
    expect(typeof ctx.result.endDate).toBe('string')
    expect(ctx.result.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.result.registration).toBeDefined()
    expect(ctx.result.traffic).toHaveLength(4)
    expect(ctx.result.status).toBeDefined()
    expect(ctx.result.memberOps.buckets).toHaveLength(6)
    expect(ctx.result.newMembers).toBeDefined()
    expect(typeof ctx.result.computedAt).toBe('string')
  })

  test('period=year：startDate 为本年 1 月 1 号', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'year', scopeType: 'all' })
    await summary(ctx)

    const y = new Date().getFullYear()
    expect(ctx.result.startDate).toBe(`${y}-01-01`)
  })

  test('period=month：startDate 为当月 1 号', async () => {
    setupDefaultMocks()
    const ctx = makeHqCtx({ period: 'month', scopeType: 'all' })
    await summary(ctx)

    expect(ctx.result.startDate).toMatch(/^\d{4}-\d{2}-01$/)
  })
})
