/**
 * cronTask STEP 3 — 生日权益发放单元测试
 *
 * 覆盖 ticket §6 PR-2 验收矩阵 8 个场景：
 *   A 命中顾客三件套全发
 *   B member_level=NULL 被 SQL 过滤
 *   C birthday=NULL 被 SQL 过滤
 *   D cron 重跑幂等（外部 ref 冲突时不重复加积分）
 *   E 闰年 2/29 非闰年自然跳过（SQL 静态断言）
 *   F birthday_benefits 配置缺失 → 直接返回
 *   G 升级与生日逻辑分离：birthday 幂等键与 upgrade 完全隔离
 *   H 跨年年份键：幂等键带年份，次年独立
 *   额外：优惠券模板停用 → 跳过该券且 warn
 *
 * 被测函数通过 index.js 的 __test__ 导出访问；直接注入 mock client。
 */

// wx-server-sdk 在 index.js 顶层执行 cloud.init，需要 stub 避免真实网络依赖
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'test-env',
  },
}

// pg 模块只在 getPool() 内部使用；被测函数接收外部 client，不触发 Pool 构造，但顶层 require('pg') 仍需可用
const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({ query: vi.fn(), on: vi.fn(), connect: vi.fn() })),
  },
}

const { loadBirthdayBenefitsConfig, grantBirthdayBenefits, refreshBirthdayBenefits } =
  require('../index').__test__

/**
 * 构造 mock pg client
 *  - queries 累积记录每次调用（便于断言 SQL/参数）
 *  - setResponses 按顺序注入响应；未命中时返回默认 { rows: [], rowCount: 0 }
 */
function makeMockClient() {
  const queries = []
  const responses = []
  return {
    queries,
    setResponses(arr) {
      responses.length = 0
      responses.push(...arr)
    },
    query: vi.fn(async (sql, params) => {
      queries.push({ sql, params })
      if (responses.length > 0) return responses.shift()
      return { rows: [], rowCount: 0 }
    }),
  }
}

/** 标准黑钻生日配置（含消息/积分/1 张券） */
const DEFAULT_CONFIG_JSON = JSON.stringify({
  '黑钻': {
    messageTitle: '生日快乐',
    messageBody: '祝您生日快乐！',
    points: 500,
    couponTemplateIds: ['tpl-1'],
  },
})

/** 为 refreshBirthdayBenefits 正常命中 1 个顾客的场景构造一组完整 mock 响应 */
function buildHitResponses({ year = 2026, userId = 'u1', level = '黑钻', configJson = DEFAULT_CONFIG_JSON } = {}) {
  return [
    // 1) loadBirthdayBenefitsConfig → SELECT system_configs
    { rows: [{ value: configJson }] },
    // 2) SELECT year
    { rows: [{ year }] },
    // 3) SELECT 命中顾客
    { rows: [{ user_id: userId, member_level: level }] },
    // 4) BEGIN
    { rows: [], rowCount: 0 },
    // 5) INSERT messages
    { rows: [], rowCount: 1 },
    // 6) INSERT point_transactions RETURNING（rowCount=1 表示新插入）
    { rows: [{ id: 1 }], rowCount: 1 },
    // 7) UPDATE points_balance
    { rows: [], rowCount: 1 },
    // 8) SELECT coupon_templates
    { rows: [{ validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true }] },
    // 9) INSERT user_coupons
    { rows: [], rowCount: 1 },
    // 10) INSERT operation_logs
    { rows: [], rowCount: 1 },
    // 11) COMMIT
    { rows: [], rowCount: 0 },
  ]
}

describe('cronTask STEP 3 — 生日权益发放', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  // ========== A. 完整命中：三件套全发 ==========
  describe('A. 命中顾客 + 有等级 + 完整配置 → 消息/积分/券 全发', () => {
    it('sentCount=1，幂等键与参数正确', async () => {
      const client = makeMockClient()
      client.setResponses(buildHitResponses({ year: 2026, userId: 'u1' }))

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 1, sentCount: 1, skippedNoConfig: 0, errorCount: 0 })

      // 断言：message 幂等键正确
      const msgInsert = client.queries.find((q) => /INSERT INTO messages/.test(q.sql))
      expect(msgInsert).toBeDefined()
      expect(msgInsert.params).toEqual(['u1', '生日快乐', '祝您生日快乐！', 'birthday-msg-2026-u1'])

      // 断言：point_transactions 外部 ref 正确 + type='生日积分'
      const ptInsert = client.queries.find((q) => /INSERT INTO point_transactions/.test(q.sql))
      expect(ptInsert).toBeDefined()
      expect(ptInsert.sql).toMatch(/'生日积分'/)
      expect(ptInsert.params).toEqual(['u1', 500, 'birthday-pts-2026-u1'])

      // 断言：points_balance 已累加
      const balUpdate = client.queries.find((q) =>
        /UPDATE client_wechat_users\s+SET points_balance = points_balance/.test(q.sql)
      )
      expect(balUpdate).toBeDefined()
      expect(balUpdate.params).toEqual(['u1', 500])

      // 断言：user_coupons coupon_id 正确
      const cpnInsert = client.queries.find((q) => /INSERT INTO user_coupons/.test(q.sql))
      expect(cpnInsert).toBeDefined()
      expect(cpnInsert.params[0]).toBe('bday-2026-u1-tpl-1')
      expect(cpnInsert.params[1]).toBe('tpl-1')
      expect(cpnInsert.params[2]).toBe('u1')

      // 断言：operation_logs action='customer.birthdayBenefits'
      const opLog = client.queries.find((q) => /INSERT INTO operation_logs/.test(q.sql))
      expect(opLog).toBeDefined()
      expect(opLog.sql).toMatch(/'customer\.birthdayBenefits'/)

      // 断言：事务 BEGIN/COMMIT 配对
      expect(client.queries.some((q) => q.sql === 'BEGIN')).toBe(true)
      expect(client.queries.some((q) => q.sql === 'COMMIT')).toBe(true)
      expect(client.queries.some((q) => q.sql === 'ROLLBACK')).toBe(false)
    })
  })

  // ========== B. member_level=NULL 被 SQL 过滤 ==========
  describe('B. 顾客 member_level=NULL', () => {
    it('不在扫描集，不发放任何权益', async () => {
      const client = makeMockClient()
      client.setResponses([
        { rows: [{ value: DEFAULT_CONFIG_JSON }] }, // load config
        { rows: [{ year: 2026 }] },                  // year
        { rows: [] },                                 // 扫描结果为空（SQL 已过滤 member_level IS NOT NULL）
      ])

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 })
      // 没有 BEGIN / INSERT 发放调用
      expect(client.queries.some((q) => q.sql === 'BEGIN')).toBe(false)
      expect(client.queries.some((q) => /INSERT INTO messages/.test(q.sql))).toBe(false)
      expect(client.queries.some((q) => /INSERT INTO point_transactions/.test(q.sql))).toBe(false)
      expect(client.queries.some((q) => /INSERT INTO user_coupons/.test(q.sql))).toBe(false)
    })
  })

  // ========== C. birthday=NULL 被 SQL 过滤 ==========
  describe('C. 顾客 birthday=NULL', () => {
    it('不在扫描集，不发放任何权益', async () => {
      const client = makeMockClient()
      client.setResponses([
        { rows: [{ value: DEFAULT_CONFIG_JSON }] },
        { rows: [{ year: 2026 }] },
        { rows: [] }, // SQL 过滤 birthday IS NOT NULL
      ])

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 })
      expect(client.queries.some((q) => q.sql === 'BEGIN')).toBe(false)
    })
  })

  // ========== D. cron 同日重跑幂等 ==========
  describe('D. cron 同日第二次执行（幂等）', () => {
    it('INSERT point_transactions ON CONFLICT rowCount=0 时不累加余额', async () => {
      const client = makeMockClient()
      // 直接单测 grantBirthdayBenefits：积分插入命中 ON CONFLICT → rowCount=0 → 不应 UPDATE points_balance
      client.setResponses([
        { rows: [], rowCount: 0 }, // INSERT messages（ON CONFLICT 命中）
        { rows: [], rowCount: 0 }, // INSERT point_transactions（ON CONFLICT 命中，RETURNING 空）
        // 注意：rowCount=0 时不会再 UPDATE points_balance
        { rows: [{ validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true }] }, // SELECT coupon_templates
        { rows: [], rowCount: 0 }, // INSERT user_coupons（ON CONFLICT 命中）
      ])

      await grantBirthdayBenefits(
        client,
        'u1',
        2026,
        '黑钻',
        { messageTitle: 't', messageBody: 'b', points: 500, couponTemplateIds: ['tpl-1'] }
      )

      // 断言：UPDATE points_balance 未被调用
      expect(
        client.queries.some((q) => /UPDATE client_wechat_users\s+SET points_balance/.test(q.sql))
      ).toBe(false)

      // 断言：所有幂等 INSERT 都带有 ON CONFLICT 子句
      const msgInsert = client.queries.find((q) => /INSERT INTO messages/.test(q.sql))
      expect(msgInsert.sql).toMatch(/ON CONFLICT/)
      const ptInsert = client.queries.find((q) => /INSERT INTO point_transactions/.test(q.sql))
      expect(ptInsert.sql).toMatch(/ON CONFLICT/)
      const cpnInsert = client.queries.find((q) => /INSERT INTO user_coupons/.test(q.sql))
      expect(cpnInsert.sql).toMatch(/ON CONFLICT/)
    })
  })

  // ========== E. 闰年 SQL 策略静态断言 ==========
  describe('E. 闰年 2/29 策略（非闰年自然跳过）', () => {
    it('SELECT 命中顾客 SQL 用 EXTRACT(MONTH/DAY) 精确匹配', async () => {
      // 注释说明：SQL 使用 EXTRACT(MONTH)=MONTH + EXTRACT(DAY)=DAY 精确匹配，
      // 非闰年 2/29 出生者当日 CURRENT_DATE=2/28 或 3/1，月日均不匹配 → 自然跳过，无需 JS 分支
      const client = makeMockClient()
      client.setResponses([
        { rows: [{ value: DEFAULT_CONFIG_JSON }] },
        { rows: [{ year: 2026 }] },
        { rows: [] },
      ])

      await refreshBirthdayBenefits(client)

      const scanSql = client.queries.find(
        (q) => /FROM client_wechat_users/.test(q.sql) && /EXTRACT/.test(q.sql)
      )
      expect(scanSql).toBeDefined()
      expect(scanSql.sql).toMatch(/birthday IS NOT NULL/)
      expect(scanSql.sql).toMatch(/member_level IS NOT NULL/)
      expect(scanSql.sql).toMatch(/EXTRACT\(MONTH FROM birthday\)/)
      expect(scanSql.sql).toMatch(/EXTRACT\(DAY FROM birthday\)/)
      expect(scanSql.sql).toMatch(/EXTRACT\(MONTH FROM CURRENT_DATE\)/)
      expect(scanSql.sql).toMatch(/EXTRACT\(DAY FROM CURRENT_DATE\)/)
    })
  })

  // ========== F. birthday_benefits 配置不存在 ==========
  describe('F. 配置缺失', () => {
    it('system_configs 无行 → 直接返回零值，不扫描顾客，并 warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const client = makeMockClient()
      client.setResponses([
        { rows: [] }, // load config：空
      ])

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 })
      // 未扫描顾客（只有 1 次 SELECT system_configs）
      expect(client.queries).toHaveLength(1)
      expect(client.queries[0].sql).toMatch(/system_configs/)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('loadBirthdayBenefitsConfig 独立调用：空行返回 null 并 warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const client = makeMockClient()
      client.setResponses([{ rows: [] }])

      const cfg = await loadBirthdayBenefitsConfig(client)

      expect(cfg).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('loadBirthdayBenefitsConfig JSON 解析失败返回 null', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const client = makeMockClient()
      client.setResponses([{ rows: [{ value: '{invalid-json' }] }])

      const cfg = await loadBirthdayBenefitsConfig(client)

      expect(cfg).toBeNull()
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  // ========== G. 同日既升级又生日（逻辑分离 / 幂等键前缀隔离） ==========
  describe('G. 升级与生日逻辑分离', () => {
    it('birthday 幂等键前缀与 upgrade 完全不同', async () => {
      const client = makeMockClient()
      client.setResponses([
        { rows: [], rowCount: 1 }, // INSERT messages
        { rows: [{ id: 1 }], rowCount: 1 }, // INSERT point_transactions
        { rows: [], rowCount: 1 }, // UPDATE points_balance
        { rows: [{ validity_mode: 'days', valid_days: 30, valid_to: null, is_active: true }] }, // SELECT coupon_templates
        { rows: [], rowCount: 1 }, // INSERT user_coupons
      ])

      await grantBirthdayBenefits(
        client,
        'u1',
        2026,
        '黑钻',
        { messageTitle: 't', messageBody: 'b', points: 500, couponTemplateIds: ['tpl-1'] }
      )

      const msgKey = client.queries.find((q) => /INSERT INTO messages/.test(q.sql)).params[3]
      const ptRef = client.queries.find((q) => /INSERT INTO point_transactions/.test(q.sql)).params[2]
      const cpnId = client.queries.find((q) => /INSERT INTO user_coupons/.test(q.sql)).params[0]

      // birthday 前缀
      expect(msgKey).toMatch(/^birthday-msg-/)
      expect(ptRef).toMatch(/^birthday-pts-/)
      expect(cpnId).toMatch(/^bday-/)

      // 不同于 upgrade 的 member-upgrade-* / cpn-up-* 前缀
      expect(msgKey).not.toMatch(/^member-upgrade-/)
      expect(ptRef).not.toMatch(/^member-upgrade-/)
      expect(cpnId).not.toMatch(/^cpn-up-/)
    })
  })

  // ========== H. 跨年年份键 ==========
  describe('H. 跨年年份键', () => {
    it('year=2027 时幂等键带 2027，与 2026 完全隔离', async () => {
      const client = makeMockClient()
      client.setResponses(buildHitResponses({ year: 2027, userId: 'u1' }))

      const result = await refreshBirthdayBenefits(client)

      expect(result.sentCount).toBe(1)

      const msgInsert = client.queries.find((q) => /INSERT INTO messages/.test(q.sql))
      const ptInsert = client.queries.find((q) => /INSERT INTO point_transactions/.test(q.sql))
      const cpnInsert = client.queries.find((q) => /INSERT INTO user_coupons/.test(q.sql))

      expect(msgInsert.params[3]).toBe('birthday-msg-2027-u1')
      expect(ptInsert.params[2]).toBe('birthday-pts-2027-u1')
      expect(cpnInsert.params[0]).toBe('bday-2027-u1-tpl-1')

      // 证明：幂等键带年份，次年独立，不与 2026 冲突
      expect(msgInsert.params[3]).not.toMatch(/2026/)
      expect(ptInsert.params[2]).not.toMatch(/2026/)
      expect(cpnInsert.params[0]).not.toMatch(/2026/)
    })
  })

  // ========== 额外：无等级配置 → skippedNoConfig++ ==========
  describe('额外: 顾客等级无对应 benefits 配置', () => {
    it('skippedNoConfig++ 且不进入事务', async () => {
      const client = makeMockClient()
      // 配置只有 黑钻，但顾客是 星钻 → 跳过
      const cfgJson = JSON.stringify({ '黑钻': { points: 500 } })
      client.setResponses([
        { rows: [{ value: cfgJson }] },
        { rows: [{ year: 2026 }] },
        { rows: [{ user_id: 'u-star', member_level: '星钻' }] },
      ])

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 1, sentCount: 0, skippedNoConfig: 1, errorCount: 0 })
      expect(client.queries.some((q) => q.sql === 'BEGIN')).toBe(false)
    })
  })

  // ========== 额外：券模板停用 → 跳过该券并 warn ==========
  describe('额外: 优惠券模板已停用', () => {
    it('is_active=false 时不插入 user_coupons 并 warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const client = makeMockClient()
      client.setResponses([
        { rows: [], rowCount: 1 }, // INSERT messages
        { rows: [{ id: 1 }], rowCount: 1 }, // INSERT point_transactions
        { rows: [], rowCount: 1 }, // UPDATE points_balance
        { rows: [{ validity_mode: 'days', valid_days: 30, valid_to: null, is_active: false }] }, // SELECT coupon_templates 停用
        // 不应再有 INSERT user_coupons
      ])

      await grantBirthdayBenefits(
        client,
        'u1',
        2026,
        '黑钻',
        { messageTitle: 't', messageBody: 'b', points: 500, couponTemplateIds: ['tpl-1'] }
      )

      expect(client.queries.some((q) => /INSERT INTO user_coupons/.test(q.sql))).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  // ========== 额外：事务异常 → ROLLBACK + errorCount++ ==========
  describe('额外: 单个顾客发放失败', () => {
    it('异常时 ROLLBACK 且 errorCount++，不影响 total 计数', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const client = makeMockClient()

      // 手动编排 query：模拟 grantBirthdayBenefits 中 INSERT messages 抛错
      let callIdx = 0
      const scripted = [
        async () => ({ rows: [{ value: DEFAULT_CONFIG_JSON }] }), // load config
        async () => ({ rows: [{ year: 2026 }] }),                  // year
        async () => ({ rows: [{ user_id: 'u1', member_level: '黑钻' }] }), // 扫描
        async () => ({ rows: [], rowCount: 0 }),                    // BEGIN
        async () => { throw new Error('db-fail') },                 // INSERT messages → 抛错
        async () => ({ rows: [], rowCount: 0 }),                    // ROLLBACK
      ]
      client.query = vi.fn(async (sql, params) => {
        client.queries.push({ sql, params })
        const handler = scripted[callIdx++]
        if (!handler) return { rows: [], rowCount: 0 }
        return handler()
      })

      const result = await refreshBirthdayBenefits(client)

      expect(result).toEqual({ total: 1, sentCount: 0, skippedNoConfig: 0, errorCount: 1 })
      expect(client.queries.some((q) => q.sql === 'ROLLBACK')).toBe(true)
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })
})
