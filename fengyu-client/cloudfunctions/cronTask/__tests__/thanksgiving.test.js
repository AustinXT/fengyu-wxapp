/**
 * cronTask STEP 4 感恩日权益发放单测
 *
 * 场景覆盖（对应 ticket §6 PR-2）：
 *   A. 20 号当日已完成 + 有等级 → 消息/积分/券/balance/operation_logs 全发
 *   B. 非 20 号 → skippedNotDay20 短路
 *   C. 20 号当日服务中 → 命中发放（SQL 文本验证 status IN (...) 包含 '服务中'）
 *   D. 20 号待服务/已取消 → 不命中（扫描返回空）
 *   E. 20 号同顾客双服务单 → DISTINCT 去重
 *   F. member_level=NULL → SQL WHERE 过滤
 *   G. 同日重跑 2 次 → 幂等键生效、balance 不重复累加
 *   H. 跨月 → 幂等键 YYYY-MM 不同，新月份新 key
 *   I. 优惠券 expire_at = 发放时 + 10 天（不读 validity_mode）
 *   J. 配置未设置 → console.warn + skippedNoConfig=0 + total=0
 *   K. 同日 STEP 2 升级 + STEP 4 共存 → 读到 STEP 2 更新后的新等级
 */

// Mock wx-server-sdk 以免运行时 cloud.init 报错
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: {
    init: vi.fn(),
    DYNAMIC_CURRENT_ENV: 'dynamic',
    getWXContext: vi.fn(() => ({})),
  },
}

// Mock pg 模块，防止 index.js 加载时创建真实 Pool
const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({
      query: vi.fn(),
      connect: vi.fn(),
      on: vi.fn(),
    })),
  },
}

const { __test__ } = require('../index')
const {
  refreshThanksgivingBenefits,
  grantThanksgivingBenefits,
  loadThanksgivingBenefitsConfig,
} = __test__

/**
 * Mock pg client。按 SQL 文本路由返回值，记录所有调用。
 *
 * @param {object} opts
 * @param {number} [opts.day=20] — SELECT EXTRACT(DAY FROM CURRENT_DATE) 返回值
 * @param {object|null} [opts.config=null] — thanksgiving_benefits JSON（null 表示未配置）
 * @param {string} [opts.yearMonth='2026-04'] — TO_CHAR 返回值
 * @param {Array} [opts.scanRows=[]] — SELECT DISTINCT 扫描返回
 * @param {boolean} [opts.templateActive=true] — coupon_templates.is_active
 * @param {boolean} [opts.pointsInsertConflict=false] — 积分 INSERT 幂等冲突（RETURNING 空）
 * @param {boolean} [opts.messageInsertConflict=false] — 消息 INSERT 幂等冲突（rowCount=0）
 * @param {boolean} [opts.couponInsertConflict=false] — 优惠券 INSERT 幂等冲突
 */
function createMockClient(opts = {}) {
  const {
    day = 20,
    config = null,
    yearMonth = '2026-04',
    scanRows = [],
    templateActive = true,
    pointsInsertConflict = false,
    messageInsertConflict = false,
    couponInsertConflict = false,
  } = opts
  const calls = []
  const client = {
    query: async (sql, params) => {
      const text = typeof sql === 'string' ? sql : (sql && sql.text) || ''
      calls.push({ sql: text, params })
      const trimmed = text.trim()

      if (/EXTRACT\(DAY FROM CURRENT_DATE\)::int AS d/.test(text)) {
        return { rows: [{ d: day }], rowCount: 1 }
      }
      if (/FROM system_configs WHERE key = 'thanksgiving_benefits'/.test(text)) {
        return config === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ value: JSON.stringify(config) }], rowCount: 1 }
      }
      if (/TO_CHAR\(CURRENT_DATE, 'YYYY-MM'\) AS ym/.test(text)) {
        return { rows: [{ ym: yearMonth }], rowCount: 1 }
      }
      if (/SELECT DISTINCT cwu\.user_id, cwu\.member_level/.test(text)) {
        return { rows: scanRows, rowCount: scanRows.length }
      }
      if (/SELECT is_active FROM coupon_templates/.test(text)) {
        return { rows: [{ is_active: templateActive }], rowCount: 1 }
      }
      if (/INSERT INTO point_transactions/.test(text)) {
        return pointsInsertConflict
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: 1 }], rowCount: 1 }
      }
      if (/INSERT INTO messages/.test(text)) {
        return { rows: [], rowCount: messageInsertConflict ? 0 : 1 }
      }
      if (/INSERT INTO user_coupons/.test(text)) {
        return { rows: [], rowCount: couponInsertConflict ? 0 : 1 }
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(trimmed)) {
        return { rows: [], rowCount: 0 }
      }
      // 默认：UPDATE client_wechat_users / INSERT operation_logs
      return { rows: [], rowCount: 1 }
    },
  }
  return { client, calls }
}

function sqlFilter(calls, pattern) {
  return calls.filter((c) => pattern.test(c.sql))
}

const BLACK_DIAMOND_CONFIG = {
  points: 500,
  couponTemplateIds: ['tpl-black-1'],
  messageTitle: '💝 感恩回馈 · 黑钻专享',
  messageBody: '您本月 20 号已到店护理，专享感恩礼已送达',
}
const STAR_DIAMOND_CONFIG = {
  points: 100,
  couponTemplateIds: [],
  messageTitle: '💝 感恩回馈 · 星钻专享',
  messageBody: '',
}

describe('STEP 4 · 场景 A — 20 号当日已完成服务单 + 有等级 → 全套发放', () => {
  test('消息/积分/券/balance/operation_logs 均发放，幂等键含 YYYY-MM', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      yearMonth: '2026-04',
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-1', member_level: '黑钻' }],
    })

    const result = await refreshThanksgivingBenefits(client)

    expect(result).toEqual({ total: 1, sentCount: 1, skippedNoConfig: 0, errorCount: 0 })

    const msgCall = sqlFilter(calls, /INSERT INTO messages/)[0]
    expect(msgCall.params[3]).toBe('thx-msg-2026-04-u-1')

    const pointsCall = sqlFilter(calls, /INSERT INTO point_transactions/)[0]
    expect(pointsCall.params[2]).toBe('thx-pts-2026-04-u-1')
    expect(pointsCall.sql).toMatch(/'感恩回馈'/)

    const balanceCall = sqlFilter(calls, /UPDATE client_wechat_users/)[0]
    expect(balanceCall.params).toEqual(['u-1', 500])
    expect(balanceCall.sql).toMatch(/points_balance = points_balance \+/)

    const couponCall = sqlFilter(calls, /INSERT INTO user_coupons/)[0]
    expect(couponCall.params[0]).toBe('thx-2026-04-u-1-tpl-black-1')

    const logCall = sqlFilter(calls, /INSERT INTO operation_logs/)[0]
    expect(logCall.sql).toMatch(/'customer\.thanksgivingBenefits'/)
    const detail = JSON.parse(logCall.params[1])
    expect(detail).toMatchObject({
      _v: 1,
      _t: 'thanksgiving',
      yearMonth: '2026-04',
      memberLevel: '黑钻',
      config: { points: 500, couponTemplateCount: 1, messageTitle: '💝 感恩回馈 · 黑钻专享' },
    })

    // 事务闭合
    expect(sqlFilter(calls, /^BEGIN/).length).toBe(1)
    expect(sqlFilter(calls, /^COMMIT/).length).toBe(1)
    expect(sqlFilter(calls, /^ROLLBACK/).length).toBe(0)
  })
})

describe('STEP 4 · 场景 B — 非 20 号短路', () => {
  test('day=21 → skippedNotDay20=true；不读配置/不扫描', async () => {
    const { client, calls } = createMockClient({ day: 21 })

    const result = await refreshThanksgivingBenefits(client)

    expect(result).toEqual({
      total: 0,
      sentCount: 0,
      skippedNoConfig: 0,
      errorCount: 0,
      skippedNotDay20: true,
    })
    // 仅一次 DAY 检查；无配置查询、无扫描
    expect(calls.length).toBe(1)
    expect(sqlFilter(calls, /system_configs/).length).toBe(0)
    expect(sqlFilter(calls, /SELECT DISTINCT/).length).toBe(0)
  })
})

describe('STEP 4 · 场景 C — 服务中状态命中 + SQL 文本验证', () => {
  test('扫描 SQL 同时允许"已完成"和"服务中"', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-svc', member_level: '黑钻' }],
    })

    const result = await refreshThanksgivingBenefits(client)
    expect(result.sentCount).toBe(1)

    const scanCall = sqlFilter(calls, /SELECT DISTINCT cwu\.user_id/)[0]
    expect(scanCall.sql).toMatch(/status IN \('已完成', '服务中'\)/)
    expect(scanCall.sql).toMatch(/service_date = CURRENT_DATE/)
  })
})

describe('STEP 4 · 场景 D — 待服务/已取消不命中', () => {
  test('SQL WHERE 过滤后扫描为空 → 无发放', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [],
    })

    const result = await refreshThanksgivingBenefits(client)
    expect(result).toEqual({ total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 })
    expect(sqlFilter(calls, /INSERT INTO messages/).length).toBe(0)
    expect(sqlFilter(calls, /INSERT INTO point_transactions/).length).toBe(0)
    expect(sqlFilter(calls, /INSERT INTO operation_logs/).length).toBe(0)
  })
})

describe('STEP 4 · 场景 E — DISTINCT 去重', () => {
  test('扫描 SQL 含 DISTINCT；同顾客多单仅发一份', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-dup', member_level: '黑钻' }],
    })

    const result = await refreshThanksgivingBenefits(client)
    expect(result).toEqual({ total: 1, sentCount: 1, skippedNoConfig: 0, errorCount: 0 })

    const scanCall = sqlFilter(calls, /SELECT DISTINCT cwu\.user_id/)[0]
    expect(scanCall.sql).toMatch(/SELECT DISTINCT/)
    // 只发一份消息（用 messageInsertConflict=false 默认）
    expect(sqlFilter(calls, /INSERT INTO messages/).length).toBe(1)
  })
})

describe('STEP 4 · 场景 F — member_level=NULL 被 SQL 过滤', () => {
  test('扫描 SQL 含 cwu.member_level IS NOT NULL', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [],
    })

    await refreshThanksgivingBenefits(client)
    const scanCall = sqlFilter(calls, /SELECT DISTINCT cwu\.user_id/)[0]
    expect(scanCall.sql).toMatch(/cwu\.member_level IS NOT NULL/)
    expect(scanCall.sql).toMatch(/so\.client_user_id IS NOT NULL/)
  })
})

describe('STEP 4 · 场景 G — 同日重跑 2 次幂等', () => {
  test('第二次 INSERT ON CONFLICT 生效；balance 不重复累加', async () => {
    // 第二次模拟：积分 INSERT 幂等冲突 → UPDATE balance 跳过
    const { client, calls } = createMockClient({
      day: 20,
      yearMonth: '2026-04',
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-1', member_level: '黑钻' }],
      pointsInsertConflict: true,
      messageInsertConflict: true,
      couponInsertConflict: true,
    })

    const result = await refreshThanksgivingBenefits(client)
    expect(result.sentCount).toBe(1) // operation_log 仍写，但幂等键防止重复业务副作用

    // 关键：balance UPDATE 不被触发（pointsInsertConflict=true 时 rowCount=0 跳过）
    expect(sqlFilter(calls, /UPDATE client_wechat_users/).length).toBe(0)

    // INSERT 仍被发起（ON CONFLICT 由 DB 层处理）
    const msgCall = sqlFilter(calls, /INSERT INTO messages/)[0]
    expect(msgCall.sql).toMatch(/ON CONFLICT \(idempotency_key\)/)
    expect(msgCall.params[3]).toBe('thx-msg-2026-04-u-1')

    const pointsCall = sqlFilter(calls, /INSERT INTO point_transactions/)[0]
    expect(pointsCall.sql).toMatch(/ON CONFLICT \(external_ref\)/)

    const couponCall = sqlFilter(calls, /INSERT INTO user_coupons/)[0]
    expect(couponCall.sql).toMatch(/ON CONFLICT \(coupon_id\) DO NOTHING/)
  })
})

describe('STEP 4 · 场景 H — 跨月幂等键切换', () => {
  test('4/20 和 5/20 生成不同的 thx-{YYYY-MM}-* 键', async () => {
    const scenarioApr = createMockClient({
      day: 20,
      yearMonth: '2026-04',
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-1', member_level: '黑钻' }],
    })
    await refreshThanksgivingBenefits(scenarioApr.client)
    const aprCoupon = sqlFilter(scenarioApr.calls, /INSERT INTO user_coupons/)[0]
    const aprMsg = sqlFilter(scenarioApr.calls, /INSERT INTO messages/)[0]
    expect(aprCoupon.params[0]).toBe('thx-2026-04-u-1-tpl-black-1')
    expect(aprMsg.params[3]).toBe('thx-msg-2026-04-u-1')

    const scenarioMay = createMockClient({
      day: 20,
      yearMonth: '2026-05',
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-1', member_level: '黑钻' }],
    })
    await refreshThanksgivingBenefits(scenarioMay.client)
    const mayCoupon = sqlFilter(scenarioMay.calls, /INSERT INTO user_coupons/)[0]
    const mayMsg = sqlFilter(scenarioMay.calls, /INSERT INTO messages/)[0]
    expect(mayCoupon.params[0]).toBe('thx-2026-05-u-1-tpl-black-1')
    expect(mayMsg.params[3]).toBe('thx-msg-2026-05-u-1')
  })
})

describe('STEP 4 · 场景 I — 优惠券有效期固定 10 天', () => {
  test('expire_at ≈ NOW + 10 天，不读 validity_mode', async () => {
    const before = Date.now()
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG },
      scanRows: [{ user_id: 'u-1', member_level: '黑钻' }],
    })

    await refreshThanksgivingBenefits(client)
    const after = Date.now()

    const couponCall = sqlFilter(calls, /INSERT INTO user_coupons/)[0]
    const expireAt = couponCall.params[3]
    expect(expireAt).toBeInstanceOf(Date)
    const expireMs = expireAt.getTime()
    const tenDays = 10 * 86400000
    expect(expireMs).toBeGreaterThanOrEqual(before + tenDays - 1000)
    expect(expireMs).toBeLessThanOrEqual(after + tenDays + 1000)

    // 模板查询只取 is_active，不含 validity_mode/valid_days
    const tplCall = sqlFilter(calls, /SELECT is_active FROM coupon_templates/)[0]
    expect(tplCall.sql).toMatch(/SELECT is_active FROM coupon_templates WHERE template_id = \$1/)
    expect(tplCall.sql).not.toMatch(/validity_mode/)
    expect(tplCall.sql).not.toMatch(/valid_days/)
  })
})

describe('STEP 4 · 场景 J — thanksgiving_benefits 未配置', () => {
  test('config 缺失 → console.warn + 返回零值，不读扫描', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, calls } = createMockClient({ day: 20, config: null })

    const result = await refreshThanksgivingBenefits(client)

    expect(result).toEqual({ total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('thanksgiving_benefits 配置不存在')
    )
    // 未配置即短路，不发起扫描
    expect(sqlFilter(calls, /SELECT DISTINCT/).length).toBe(0)
    expect(sqlFilter(calls, /INSERT INTO/).length).toBe(0)

    warnSpy.mockRestore()
  })
})

describe('STEP 4 · 场景 K — STEP 2 升级 + STEP 4 共存', () => {
  test('扫描读到的是 STEP 2 更新后的新等级（星钻），按新等级配置发放', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      yearMonth: '2026-04',
      config: { 黑钻: BLACK_DIAMOND_CONFIG, 星钻: STAR_DIAMOND_CONFIG },
      // STEP 2 刚升级到星钻 → STEP 4 扫描拿到 member_level='星钻'
      scanRows: [{ user_id: 'u-up', member_level: '星钻' }],
    })

    const result = await refreshThanksgivingBenefits(client)
    expect(result.sentCount).toBe(1)

    const logCall = sqlFilter(calls, /INSERT INTO operation_logs/)[0]
    const detail = JSON.parse(logCall.params[1])
    expect(detail.memberLevel).toBe('星钻')
    expect(detail.config.points).toBe(100)

    // 发的是星钻档的消息标题（而非黑钻）
    const msgCall = sqlFilter(calls, /INSERT INTO messages/)[0]
    expect(msgCall.params[1]).toBe('💝 感恩回馈 · 星钻专享')

    // 星钻无优惠券 → 不查模板、不插 user_coupons
    expect(sqlFilter(calls, /SELECT is_active FROM coupon_templates/).length).toBe(0)
    expect(sqlFilter(calls, /INSERT INTO user_coupons/).length).toBe(0)
  })
})

describe('STEP 4 · 额外 — 无对应等级配置 → skippedNoConfig 累加', () => {
  test('扫描到的顾客等级不在配置 keys 中 → 跳过且不报错', async () => {
    const { client, calls } = createMockClient({
      day: 20,
      config: { 黑钻: BLACK_DIAMOND_CONFIG }, // 仅配黑钻
      scanRows: [
        { user_id: 'u-no-cfg', member_level: '粉钻' }, // 未配置粉钻
      ],
    })
    const result = await refreshThanksgivingBenefits(client)
    expect(result).toEqual({ total: 1, sentCount: 0, skippedNoConfig: 1, errorCount: 0 })
    expect(sqlFilter(calls, /INSERT INTO messages/).length).toBe(0)
    expect(sqlFilter(calls, /INSERT INTO operation_logs/).length).toBe(0)
  })
})

describe('STEP 4 · loadThanksgivingBenefitsConfig', () => {
  test('JSON 解析失败 → 返回 null 并 console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenClient = {
      query: async () => ({ rows: [{ value: '{not-json' }], rowCount: 1 }),
    }
    const result = await loadThanksgivingBenefitsConfig(brokenClient)
    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('thanksgiving_benefits 解析失败'),
      expect.any(String)
    )
    errorSpy.mockRestore()
  })
})
