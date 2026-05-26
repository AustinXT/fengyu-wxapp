/**
 * utils/member-level 单元测试 — 支付结算时即时重算会员等级（只升不降）
 *
 * 背景：member_level 原只由 cron 每日重算，顾客达标后最多滞后 ~24h；本 helper 在结算点即时升级。
 * 三端字节一致副本，行为一致；本测试以 clientApi 副本为代表验证逻辑。
 */

const {
  determineMemberLevel,
  rank,
  recalcMemberLevel,
} = require('../../utils/member-level')

/**
 * 构造 mock pg client：按 SQL 关键字分发结果，并记录所有 query。
 * @param {object} opts
 * @param {string|null} opts.memberLevel   - 当前 member_level
 * @param {string} opts.customerType        - 当前 customer_type
 * @param {number} opts.spend               - 滚动 12 月消费额
 * @param {number} opts.updateRowCount      - UPDATE 影响行数
 */
function buildMockClient({
  memberLevel = null,
  customerType = '会员客',
  spend = 0,
  updateRowCount = 1,
} = {}) {
  const queries = []
  const client = {
    query: vi.fn(async (sql, params) => {
      queries.push({ sql: String(sql), params })
      const s = String(sql)
      if (/SELECT\s+member_level,\s*customer_type/i.test(s)) {
        return { rows: [{ member_level: memberLevel, customer_type: customerType }] }
      }
      if (/AS spend/i.test(s)) {
        return { rows: [{ spend }] }
      }
      if (/UPDATE client_wechat_users/i.test(s)) {
        return { rowCount: updateRowCount }
      }
      if (/INSERT INTO operation_logs/i.test(s)) {
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  return { client, queries }
}

const hasUpdate = (queries) =>
  queries.some((q) => /UPDATE client_wechat_users/i.test(q.sql))
const hasLog = (queries) =>
  queries.some((q) => /INSERT INTO operation_logs/i.test(q.sql))
const updatedLevel = (queries) => {
  const u = queries.find((q) => /UPDATE client_wechat_users/i.test(q.sql))
  return u ? u.params[1] : null
}

describe('determineMemberLevel 阈值（与 db/utils/member-level.ts 一致）', () => {
  test.each([
    [140000, '黑钻'],
    [100000, '黑钻'],
    [99999, '金钻'],
    [60000, '金钻'],
    [30000, '粉钻'],
    [10000, '星钻'],
    [1990, '初钻'],
    [1989, null],
    [0, null],
  ])('spend=%i → %s', (spend, expected) => {
    expect(determineMemberLevel(spend, 1990)).toBe(expected)
  })
})

describe('rank（null=0，黑钻=5）', () => {
  test('排序正确', () => {
    expect(rank(null)).toBe(0)
    expect(rank('初钻')).toBe(1)
    expect(rank('黑钻')).toBe(5)
    expect(rank('星钻')).toBeLessThan(rank('黑钻'))
  })
})

describe('recalcMemberLevel 只升不降', () => {
  test('会员客消费 14 万、当前无等级 → 升级黑钻 + 写审计日志', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: null,
      customerType: '会员客',
      spend: 140000,
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(hasUpdate(queries)).toBe(true)
    expect(updatedLevel(queries)).toBe('黑钻')
    expect(hasLog(queries)).toBe(true)
  })

  test('非会员客（流量客）→ 不升级、不写库', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: null,
      customerType: '流量客',
      spend: 140000,
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(hasUpdate(queries)).toBe(false)
    expect(hasLog(queries)).toBe(false)
  })

  test('算出等级不高于当前（黑钻顾客退款后消费降到金钻档）→ 不降级', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: '黑钻',
      customerType: '会员客',
      spend: 60000, // 金钻档，低于当前黑钻
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(hasUpdate(queries)).toBe(false)
  })

  test('同档（金钻顾客继续消费仍金钻）→ 不重复写', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: '金钻',
      customerType: '会员客',
      spend: 65000,
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(hasUpdate(queries)).toBe(false)
  })

  test('跨档升级（星钻 → 黑钻）→ 升级到黑钻', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: '星钻',
      customerType: '会员客',
      spend: 120000,
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(updatedLevel(queries)).toBe('黑钻')
  })

  test('clientUserId 为空 → 直接返回，不查库', async () => {
    const { client, queries } = buildMockClient({})
    await recalcMemberLevel(client, null, 1990, 'clientApi')
    expect(queries.length).toBe(0)
  })

  test('UPDATE 命中 0 行（并发已被其它结算升级）→ 不写审计日志', async () => {
    const { client, queries } = buildMockClient({
      memberLevel: null,
      customerType: '会员客',
      spend: 140000,
      updateRowCount: 0,
    })
    await recalcMemberLevel(client, 'u1', 1990, 'clientApi')
    expect(hasUpdate(queries)).toBe(true)
    expect(hasLog(queries)).toBe(false)
  })
})
