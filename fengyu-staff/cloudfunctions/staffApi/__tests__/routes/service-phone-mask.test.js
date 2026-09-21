/**
 * 护理单接口手机号脱敏行为守护
 *
 * 修复背景：service.list / service.detail 曾对所有角色返回数据库原始全号，
 * 导致普通员工在护理单视图能看到完整手机号（与顾客档案脱敏不一致 / PII 泄露）。
 * 现统一走 maskPhoneForAuth：manager 看全号，普通员工脱敏。
 */

const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const serviceRoutes = require('../../routes/service')

const FULL_PHONE = '13812345678'
const MASKED_PHONE = '138****5678'

describe('service.list 手机号脱敏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockListOrder() {
    // 主查询返回 1 条服务单（无 assigned_employee_id / client_user_id，跳过后续姓名查询）
    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-WX-2605220001',
        status: '待服务',
        service_date: '2026-05-22',
        assigned_employee_id: null,
        client_user_id: null,
        appointment_id: null,
        remark: '',
        started_at: null,
        completed_at: null,
        created_at: '2026-05-22T00:00:00Z',
        store_id: 'store-001', // #224：主查询新增 so.store_id，店长特权按「单的门店」判
        client_phone: FULL_PHONE,
      }])
      .mockResolvedValue([]) // itemsSummary 及任何兜底查询
  }

  test('普通员工看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({})
    mockListOrder()
    await serviceRoutes.list(ctx)
    expect(ctx.result[0].customerPhone).toBe(MASKED_PHONE)
  })

  test('店长看到完整手机号', async () => {
    const ctx = createManagerCtx({})
    mockListOrder()
    await serviceRoutes.list(ctx)
    expect(ctx.result[0].customerPhone).toBe(FULL_PHONE)
  })

  // #224：店长身份不再自动等于"对这张单有店长特权"
  test('店长以外援身份拿到他店单 → 仍脱敏（跨组织域 PII 不外泄）', async () => {
    const ctx = createManagerCtx({})
    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-WX-2605220002',
        status: '待服务',
        service_date: '2026-05-22',
        assigned_employee_id: ctx.auth.staffWfId, // 指派给本人 → 能看见
        client_user_id: null,
        appointment_id: null,
        remark: '',
        started_at: null,
        completed_at: null,
        created_at: '2026-05-22T00:00:00Z',
        store_id: 'store-OTHER', // 但单不属本店 → 无店长特权
        client_phone: FULL_PHONE,
      }])
      .mockResolvedValue([])
    await serviceRoutes.list(ctx)
    expect(ctx.result[0].customerPhone).toBe(MASKED_PHONE)
  })
})

describe('service.detail 手机号脱敏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockDetailOrder(assignedEmployeeId) {
    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-WX-2605220001',
        status: '待服务',
        service_date: '2026-05-22',
        store_id: 'store-001', // service.detail 调 isStoreInScope(auth, so.store_id)，须与 ctx.auth.effectiveStoreId 一致
        assigned_employee_id: assignedEmployeeId,
        client_user_id: null,
        appointment_id: null,
        remark: '',
        started_at: null,
        completed_at: null,
        created_at: '2026-05-22T00:00:00Z',
        updated_at: '2026-05-22T00:00:00Z',
        client_phone: FULL_PHONE,
      }])
      .mockResolvedValue([]) // items / staff 姓名查询
  }

  test('普通员工看到脱敏手机号（查看分配给自己的服务单）', async () => {
    const ctx = createBeauticianCtx({ id: 'HLD-WX-2605220001' })
    // 美容师只能查看分配给自己的单，assigned 必须等于其 staffWfId
    mockDetailOrder(ctx.auth.staffWfId)
    await serviceRoutes.detail(ctx)
    expect(ctx.result.customerPhone).toBe(MASKED_PHONE)
  })

  test('店长看到完整手机号', async () => {
    const ctx = createManagerCtx({ id: 'HLD-WX-2605220001' })
    mockDetailOrder(null)
    await serviceRoutes.detail(ctx)
    expect(ctx.result.customerPhone).toBe(FULL_PHONE)
  })
})
