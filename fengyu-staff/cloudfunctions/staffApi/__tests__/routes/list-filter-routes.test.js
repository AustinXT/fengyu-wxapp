const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')
const orderRoutes = require('../../routes/order')
const appointmentRoutes = require('../../routes/appointment')
const serviceRoutes = require('../../routes/service')
const allocationRoutes = require('../../routes/allocation')
const serviceCommissionRoutes = require('../../routes/serviceCommission')

describe('业务列表统一筛选', () => {
  beforeEach(() => vi.clearAllMocks())

  test('order.list 组合姓名、手机号、业务日期并倒序', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ keyword: '138-12', startDate: '2026-08-01', endDate: '2026-08-26' })
    await orderRoutes.list(ctx)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain("COALESCE(c.name, o.customer_name, '') ILIKE")
    expect(sql).toContain('regexp_replace')
    expect(sql).toContain('o.sale_order_datetime >=')
    expect(sql).toContain('ORDER BY o.sale_order_datetime DESC, o.sale_order_id DESC')
    expect(params).toContain('%13812%')
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

  test('allocation.pendingPayments 支持全部状态与到账日期', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createManagerCtx({ allocationStatus: '全部', keyword: '138', startDate: '2026-08-01' })
    await allocationRoutes.pendingPayments(ctx)
    const [sql] = pg.query.mock.calls[0]
    expect(sql).toContain('p.allocation_status IS NOT NULL')
    expect(sql).not.toContain('p.allocation_status = $2')
    expect(sql).toContain('p.paid_at >=')
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
