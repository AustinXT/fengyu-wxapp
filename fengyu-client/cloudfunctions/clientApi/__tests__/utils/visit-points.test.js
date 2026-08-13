const {
  isVisitPointsEligible,
  grantVisitPointsSafe,
} = require('../../utils/visit-points')

const now = new Date('2026-08-13T10:00:00.000Z')
const so = {
  service_order_id: 'HLD-WX-2608130001',
  service_order_type: '售后',
  service_date: '2026-08-13',
  client_user_id: 'client-001',
  remark: '',
}
const items = [{ unit_real_price: '100.00' }]

describe('会员到店积分（clientApi）', () => {
  const oldFlag = process.env.POINTS_ACCRUAL_ENABLED

  beforeEach(() => {
    delete process.env.POINTS_ACCRUAL_ENABLED
  })

  afterAll(() => {
    if (oldFlag === undefined) delete process.env.POINTS_ACCRUAL_ENABLED
    else process.env.POINTS_ACCRUAL_ENABLED = oldFlag
  })

  test('顾客最终确认的合格服务单可发放', () => {
    expect(isVisitPointsEligible(so, items)).toBe(true)
  })

  test('失败日志使用 clientApi 来源，且异常不阻断 finalize', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('SELECT value FROM system_configs')) return { rows: [{ value: '20' }], rowCount: 1 }
      if (sql.includes('WITH inserted AS')) throw new Error('insert failed')
      return { rows: [], rowCount: 1 }
    })

    const result = await grantVisitPointsSafe({ query }, so, items, now)

    expect(result.skipped).toBe('failed')
    const logCall = query.mock.calls.find(([sql]) => sql.includes("'points.visitGrantFailed'"))
    expect(logCall).toBeDefined()
    expect(logCall[0]).toContain("'clientApi'")
  })
})
