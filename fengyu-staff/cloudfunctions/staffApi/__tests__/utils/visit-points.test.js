const {
  DEFAULT_VISIT_POINTS_REWARD,
  buildVisitPointsExternalRef,
  isVisitPointsEligible,
  parseVisitPointsReward,
  normalizeServiceDate,
  grantVisitPoints,
  grantVisitPointsSafe,
} = require('../../utils/visit-points')
const { DEPOSIT_REFUND_REMARK } = require('../../utils/consume-filter')

const now = new Date('2026-08-13T10:00:00.000Z')
const so = {
  service_order_id: 'HLD-WX-2608130001',
  service_order_type: '售后',
  service_date: '2026-08-13',
  client_user_id: 'client-001',
  remark: '',
}
const items = [{ service_item_id: 'sit-1', unit_real_price: '100.00' }]

describe('会员到店积分（staffApi）', () => {
  const oldFlag = process.env.POINTS_ACCRUAL_ENABLED

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.POINTS_ACCRUAL_ENABLED
  })

  afterAll(() => {
    if (oldFlag === undefined) delete process.env.POINTS_ACCRUAL_ENABLED
    else process.env.POINTS_ACCRUAL_ENABLED = oldFlag
  })

  test('默认配置 20；仅接受非负安全整数', () => {
    expect(parseVisitPointsReward(undefined)).toBe(DEFAULT_VISIT_POINTS_REWARD)
    expect(parseVisitPointsReward('0')).toBe(0)
    expect(parseVisitPointsReward('30')).toBe(30)
    expect(parseVisitPointsReward('-1')).toBe(0)
    expect(parseVisitPointsReward('1.5')).toBe(0)
  })

  test('资格：售后 + 顾客 + 正价项目 + 非寄存退款', () => {
    expect(isVisitPointsEligible(so, items)).toBe(true)
    expect(isVisitPointsEligible({ ...so, service_order_type: '售前' }, items)).toBe(false)
    expect(isVisitPointsEligible({ ...so, client_user_id: null }, items)).toBe(false)
    expect(isVisitPointsEligible({ ...so, remark: DEPOSIT_REFUND_REMARK }, items)).toBe(false)
    expect(isVisitPointsEligible(so, [{ unit_real_price: '0' }])).toBe(false)
  })

  test('external_ref 按顾客 + service_date 日去重', () => {
    expect(buildVisitPointsExternalRef('u-1', '2026-08-13')).toBe('visit-points:u-1:2026-08-13')
    expect(normalizeServiceDate(new Date('2026-08-13T16:30:00.000Z'))).toBe('2026-08-14')
  })

  test('配置缺失时发 20 分，并且只有 INSERT 成功才增加余额', async () => {
    const query = vi.fn(async (sql) => {
      if (sql === 'SAVEPOINT visit_points_reward' || sql === 'RELEASE SAVEPOINT visit_points_reward') {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT value FROM system_configs')) return { rows: [], rowCount: 0 }
      if (sql.includes('WITH inserted AS')) return { rows: [{ points_balance: 120 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    const result = await grantVisitPointsSafe({ query }, so, items, { auth: {} }, now)

    expect(result).toMatchObject({ granted: true, amount: 20 })
    const grantCall = query.mock.calls.find(([sql]) => sql.includes('WITH inserted AS'))
    expect(grantCall[1]).toEqual(['client-001', 20, 'visit-points:client-001:2026-08-13', now])
  })

  test('同日重复发放由 ON CONFLICT 返回 duplicate，余额不再增加', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const result = await grantVisitPoints({ query }, so, items, now, 20)

    expect(result).toMatchObject({ granted: false, skipped: 'duplicate', amount: 20 })
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING')
    expect(query.mock.calls[0][0]).toContain('EXISTS (SELECT 1 FROM inserted)')
  })

  test('积分 SQL 异常回滚 SAVEPOINT、记录失败日志且不向外抛错', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(sql)
      if (sql.includes('SELECT value FROM system_configs')) return { rows: [{ value: '25' }], rowCount: 1 }
      if (sql.includes('WITH inserted AS')) throw new Error('points insert failed')
      return { rows: [], rowCount: 1 }
    })

    const result = await grantVisitPointsSafe({ query }, so, items, { auth: { staffWfId: 'EMP-1' } }, now)

    expect(result).toMatchObject({ granted: false, skipped: 'failed', amount: 25 })
    expect(calls).toContain('ROLLBACK TO SAVEPOINT visit_points_reward')
    const logCall = query.mock.calls.find(([sql]) => sql.includes("'points.visitGrantFailed'"))
    expect(logCall).toBeDefined()
    expect(logCall[0]).toContain("'staffApi'")
    expect(JSON.parse(logCall[1][6])).toMatchObject({ rewardAmount: 25, serviceDate: '2026-08-13' })
  })

  test('全局积分开关关闭时不访问数据库', async () => {
    process.env.POINTS_ACCRUAL_ENABLED = 'false'
    const query = vi.fn()
    const result = await grantVisitPointsSafe({ query }, so, items, { auth: {} }, now)
    expect(result.skipped).toBe('ineligible-or-disabled')
    expect(query).not.toHaveBeenCalled()
  })
})
