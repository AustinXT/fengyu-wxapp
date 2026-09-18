import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    phone: 'phone',
    name: 'name',
    boundStoreId: 'bound_store_id',
    boundEmployeeId: 'bound_employee_id',
    promoterEmployeeId: 'promoter_employee_id',
    promoterEmployeeName: 'promoter_employee_name',
    updatedAt: 'updated_at',
    memberLevel: 'member_level',
    customerType: 'customer_type',
    spendingTier: 'spending_tier',
    monthlyActivity: 'monthly_activity',
    customerStatus: 'customer_status',
    workfineOverrideFields: 'workfine_override_fields',
  },
  staffWechatUsers: {
    employeeId: 'employee_id', name: 'name', storeId: 'store_id',
    orgNodeId: 'org_node_id', isResigned: 'is_resigned',
  },
}))

vi.mock('@db/prepaid-card', () => ({
  prepaidCards: { cardId: 'card_id', userId: 'user_id', balance: 'balance' },
}))

vi.mock('@db/order', () => ({
  saleOrders: {
    saleOrderId: 'sale_order_id',
    clientUserId: 'client_user_id',
    storeId: 'store_id',
    openedBy: 'opened_by',
    saleOrderDatetime: 'sale_order_datetime',
    status: 'status',
    totalAmount: 'total_amount',
    paidAt: 'paid_at',
    saleOrderType: 'sale_order_type',
  },
  saleItems: {
    saleOrderId: 'sale_order_id',
    saleItemId: 'sale_item_id',
    skuId: 'sku_id',
    itemDirection: 'item_direction',
    productName: 'product_name',
    quantity: 'quantity',
    received: 'received',
  },
  saleOrderPayments: {
    saleOrderId: 'sale_order_id',
    amount: 'amount',
    status: 'status',
    createdAt: 'created_at',
    paidAt: 'paid_at',
    refundReason: 'refund_reason',
    note: 'note',
    changeType: 'change_type',
  },
}))

vi.mock('@db/coupon', () => ({
  userCoupons: { userId: 'user_id' },
  couponTemplates: { couponId: 'coupon_id' },
}))

vi.mock('@db/points', () => ({
  pointTransactions: { userId: 'user_id' },
  pointBatches: { userId: 'user_id', remainingAmount: 'remaining_amount', expireAt: 'expire_at' },
}))

vi.mock('@db/appointment', () => ({
  appointments: { clientUserId: 'client_user_id' },
}))

vi.mock('@db/message', () => ({
  messages: { recipientType: 'recipient_type', recipientId: 'recipient_id' },
}))

vi.mock('@db/service', () => ({
  serviceOrders: {
    serviceOrderId: 'service_order_id',
    clientUserId: 'client_user_id',
    status: 'status',
    serviceDate: 'service_date',
    createdAt: 'created_at',
    storeId: 'store_id',
    assignedEmployeeId: 'assigned_employee_id',
  },
  serviceItems: { serviceOrderId: 'service_order_id', saleItemId: 'sale_item_id' },
}))

vi.mock('@db/pickup', () => ({
  pickupRecords: { clientUserId: 'client_user_id' },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name', type: 'type', parentId: 'parent_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  gt: vi.fn((col, val) => ({ type: 'gt', col, val })),
  isNull: vi.fn((col) => ({ type: 'isNull', col })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), {
    raw: vi.fn((value) => ({ type: 'raw', value })),
    join: vi.fn((chunks, separator) => ({ type: 'join', chunks, separator })),
  }),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  getTableColumns: vi.fn(() => ({})),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(() => false),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  employeeScopeCondition: vi.fn(() => undefined),
  isAdminScope: vi.fn(() => false),
  isInScope: vi.fn(() => true), // 默认允许
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'aabbcc112233' })),
}))

import { updateCustomer, createCustomer, getCustomersPaginated, getCustomers, getCustomerById, searchCustomerByPhone, searchCustomers, getCustomerRefundHistory, getCustomerServiceOrders, assignCustomer, getCustomerPrepaidBalance, exportCustomers, mergeClientProfile } from './customers'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope, requirePermission, scopeCondition } from '@/lib/permissions'
import { hasRole } from '@/lib/auth'
import { logUpdate } from '@/lib/operation-log'
import { clientWechatUsers } from '@db/user'
import { pointBatches } from '@db/points'
import { eq, ilike, isNotNull, sql, gt } from 'drizzle-orm'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['customer:list', 'customer:update', 'customer:create'], scopeStoreIds: ['store-1'] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const chain: any = { where }
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
  return vi.fn().mockReturnValue({ from })
}

/** mock db.select() 链用于 logUpdate 获取旧值：.from().where().limit() */
function mockSelectBefore(rows: any[] = [{}]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValue(chain)
}

// ── updateCustomer ────────────────────────────────────────────────────────────

describe('updateCustomer — 校验 + scope + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ userId: 'user-1', name: '张三', phone: '13800000000' }])
  })

  it('手机号格式错误 → 拒绝，不调用 DB', async () => {
    const result = await updateCustomer('user-1', { phone: 'abc' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('boundStoreId 只允许新增时设置 → 编辑拒绝，不调用 DB', async () => {
    const result = await updateCustomer('user-1', { boundStoreId: 'store-2' } as any)

    expect(result.success).toBe(false)
    expect(result.message).toContain('绑定门店仅允许新增顾客时设置')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('手机号为 null → 跳过格式校验，进入 DB 更新', async () => {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { phone: null })

    expect(db.update).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('scope 不符（rowCount=0，无 expectedUpdatedAt）→ 失败，提示不存在或无权', async () => {
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { name: '张三' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('乐观锁冲突（rowCount=0，有 expectedUpdatedAt）→ 失败，提示已被修改', async () => {
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { name: '张三' }, '2026-01-01T00:00:00.000Z')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('DB 唯一冲突（23505，手机号重复）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(pgError) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { phone: '13900001111' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他顾客使用')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('connection lost')) })
    ;(db.update as any).mockReturnValue({ set })

    await expect(updateCustomer('user-1', { name: '张三' })).rejects.toThrow('connection lost')
  })

  it('正常更新（rowCount=1）→ 成功', async () => {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { name: '李四' })

    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })

  it('人工修改 WorkFine 档案字段时追加覆盖标记，未改字段不标记', async () => {
    mockSelectBefore([{
      userId: 'user-1',
      customerSource: '美团',
      occupation: '教师',
      workfineOverrideFields: ['birthday'],
    }])
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', {
      customerSource: '抖音',
      occupation: '教师',
    })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      workfineOverrideFields: ['birthday', 'customer_source'],
    }))
  })

  it('绑定推荐员工 → 只信任 employeeId，并写入服务端查询到的姓名快照', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const rows = selectCall === 1
        ? [{ userId: 'user-1', promoterEmployeeId: null, promoterEmployeeName: '旧快照' }]
        : [{ employeeId: 'EMP-001', name: '王员工' }]
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(rows)
      return chain
    })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { promoterEmployeeId: 'EMP-001' })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      promoterEmployeeId: 'EMP-001',
      promoterEmployeeName: '王员工',
    }))
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession, 'customer.update', 'customer', 'user-1',
      expect.anything(),
      expect.objectContaining({ promoterEmployeeId: 'EMP-001', promoterEmployeeName: '王员工' }),
    )
  })

  it('仅注入 promoterEmployeeName → 运行时白名单拒绝，不写入自由文本', async () => {
    const result = await updateCustomer('user-1', {
      promoterEmployeeName: '任意推荐人文本',
    } as any)

    expect(result).toEqual({
      success: false,
      message: '包含不允许修改的字段：promoterEmployeeName',
    })
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('不存在或离职推荐员工 → 拒绝且不更新顾客', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const rows = selectCall === 1 ? [{ userId: 'user-1' }] : []
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(rows)
      return chain
    })

    const result = await updateCustomer('user-1', { promoterEmployeeId: 'INVALID' })

    expect(result).toEqual({ success: false, message: '推荐员工不存在或已离职' })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('显式清空推荐员工 → ID 与姓名快照同时清空并进入审计 diff', async () => {
    mockSelectBefore([{
      userId: 'user-1', promoterEmployeeId: 'EMP-001', promoterEmployeeName: '王员工',
    }])
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { promoterEmployeeId: null })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      promoterEmployeeId: null,
      promoterEmployeeName: null,
    }))
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession, 'customer.update', 'customer', 'user-1',
      expect.anything(),
      expect.objectContaining({ promoterEmployeeId: null, promoterEmployeeName: null }),
    )
  })

  // ── admin 修改顾客手机号专项（P2 — admin-only 换绑）────────────────────────
  it('admin 改 phone（仅 phone 字段）→ 成功 + logUpdate 记录 phone diff', async () => {
    mockSelectBefore([{ userId: 'user-1', phone: '13800000000', name: '张三' }])
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer(
      'user-1',
      { phone: '13911112222' },
      '2026-04-16T00:00:00.000Z',
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
    // logUpdate 被调用：customer.update + before/after 中含 phone
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession,
      'customer.update',
      'customer',
      'user-1',
      expect.objectContaining({ phone: '13800000000' }),
      expect.objectContaining({ phone: '13911112222' }),
    )
  })

  it('改 phone 时新号已被占用（23505）→ 提示文案"已被其他顾客使用"', async () => {
    mockSelectBefore([{ userId: 'user-1', phone: '13800000000' }])
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(pgError) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { phone: '13911112222' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('该手机号已被其他顾客使用')
    // 唯一冲突不应写审计日志
    expect(logUpdate).not.toHaveBeenCalled()
  })

  it('权限拒绝：requirePermission 抛出时整个 action 失败', async () => {
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 缺少 customer:update 权限')
    })

    await expect(
      updateCustomer('user-1', { phone: '13911112222' }),
    ).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('改 phone 时乐观锁不匹配（rowCount=0 + expectedUpdatedAt）→ 提示"已被其他人修改"', async () => {
    mockSelectBefore([{ userId: 'user-1', phone: '13800000000' }])
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer(
      'user-1',
      { phone: '13911112222' },
      '2025-01-01T00:00:00.000Z',
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('数据已被其他人修改')
  })
})

// ── createCustomer ────────────────────────────────────────────────────────────

describe('createCustomer — 输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('姓名为空 → 拒绝，不查 DB', async () => {
    const result = await createCustomer({ name: '', phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('姓名不能为空')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('手机号为空 → 拒绝', async () => {
    const result = await createCustomer({ name: '张三', phone: '' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入手机号')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('手机号格式错误（非 11 位）→ 拒绝', async () => {
    const result = await createCustomer({ name: '张三', phone: '123456' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('手机号不以 1 开头 → 拒绝', async () => {
    const result = await createCustomer({ name: '张三', phone: '23812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
  })

  it('手机号已存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ userId: 'existing-user' }]))

    const result = await createCustomer({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('并发唯一冲突（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })

    const result = await createCustomer({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他顾客使用')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    ;(db.insert as any).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('connection lost')),
    })

    await expect(
      createCustomer({ name: '张三', phone: '13812345678' }),
    ).rejects.toThrow('connection lost')
  })

  it('正常创建 → 返回 userId（FYGK- 前缀）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    const result = await createCustomer({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(true)
    expect(result.userId).toMatch(/^FYGK-/)
    expect(result.message).toContain('顾客创建成功')
  })

  it('boundStoreId 不在 scope 内 → 拒绝，不查 DB', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createCustomer({
      name: '张三', phone: '13812345678', boundStoreId: 'store-other',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.select).not.toHaveBeenCalled()
    ;(isInScope as any).mockReturnValue(true)  // 恢复默认
  })

  it('boundStoreId 在 scope 内 → 允许创建', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    const result = await createCustomer({
      name: '张三', phone: '13812345678', boundStoreId: 'store-1',
    })

    expect(result.success).toBe(true)
  })

  it('boundStoreId 为空 → 跳过 scope 校验', async () => {
    ;(isInScope as any).mockReturnValue(false) // 不应被调用
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    const result = await createCustomer({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(true)
    expect(isInScope).not.toHaveBeenCalled()
  })
})

// ── getCustomersPaginated 服务端分页 ──────────────────────────────────────────

describe('getCustomersPaginated — 服务端分页', () => {
  const mockCustomerRow = {
    userId: 'FYGK-001',
    openid: null,
    phone: '13812345678',
    customerId: null,
    name: '李女士',
    gender: '女',
    boundStoreId: 'store-1',
    boundEmployeeId: 'EMP-001',
    boundEmployeeName: '张三',
    memberLevel: '金钻',
    customerSource: null,
    promoterEmployeeName: null,
    customerType: '流量客',
    spendingTier: '<1990',
    monthlyActivity: null,
    customerStatus: null,
    birthday: null,
    occupation: null,
    isMarried: null,
    wechatName: null,
    skinType: null,
    improvementFocus: null,
    skinIssue: null,
    wellnessPreference: null,
    notes: null,
    createdAt: new Date('2026-01-15T08:00:00Z'),
    updatedAt: new Date('2026-03-15T10:00:00Z'),
    storeName: '南昌旗舰店',
    marketName: '南昌市场',
  }

  /** mock 2 个并行 select：COUNT + DATA */
  function mockPaginatedChain(total: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // COUNT
        const where = vi.fn().mockResolvedValue([{ count: total }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA: select(customerColumns) → from → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无筛选 → 返回 data + total', async () => {
    mockPaginatedChain(1, [mockCustomerRow])

    const result = await getCustomersPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].userId).toBe('FYGK-001')
    expect(result.data[0].name).toBe('李女士')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].employeeName).toBe('张三')
    expect(result.data[0].memberLevel).toBe('金钻')
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getCustomersPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('bound_store_id', 'store-2')
  })

  it('memberLevel 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ memberLevel: '黑钻' })

    expect(eq).toHaveBeenCalledWith('member_level', '黑钻')
  })

  it('search 筛选 → ilike(name) + ilike(phone)', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ search: '李' })

    expect(ilike).toHaveBeenCalledWith('name', '%李%')
    expect(ilike).toHaveBeenCalledWith('phone', '%李%')
  })

  it('page/pageSize → 2 次 select', async () => {
    mockPaginatedChain(50, [])

    const result = await getCustomersPaginated({ page: 3, pageSize: 10 })

    expect(result.total).toBe(50)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('storeName/marketName 为 null → undefined', async () => {
    const noStore = {
      ...mockCustomerRow,
      boundEmployeeName: null,
      storeName: null,
      marketName: null,
    }
    mockPaginatedChain(1, [noStore])

    const result = await getCustomersPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].employeeName).toBeUndefined()
    expect(result.data[0].marketName).toBeUndefined()
  })

  it('新字段序列化 → customerType/spendingTier/marketName', async () => {
    mockPaginatedChain(1, [mockCustomerRow])

    const result = await getCustomersPaginated()

    expect(result.data[0].customerType).toBe('流量客')
    expect(result.data[0].spendingTier).toBe('<1990')
    expect(result.data[0].monthlyActivity).toBeNull()
    expect(result.data[0].customerStatus).toBeNull()
    expect(result.data[0].marketName).toBe('南昌市场')
  })

  it('customerType 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ customerType: '会员客' })

    expect(eq).toHaveBeenCalledWith('customer_type', '会员客')
  })

  it('spendingTier 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ spendingTier: '3-6W' })

    expect(eq).toHaveBeenCalledWith('spending_tier', '3-6W')
  })

  it('monthlyActivity 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ monthlyActivity: '二次客活' })

    expect(eq).toHaveBeenCalledWith('monthly_activity', '二次客活')
  })

  it('customerStatus 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getCustomersPaginated({ customerStatus: '保有会员-稳定' })

    expect(eq).toHaveBeenCalledWith('customer_status', '保有会员-稳定')
  })
})

// ── 读函数覆盖（getCustomers / getCustomerById / searchCustomerByPhone）─────

const mockFullRow = {
  userId: 'FYGK-001', openid: null, phone: '13812345678', customerId: null,
  name: '李女士', gender: '女', boundStoreId: 'store-1', boundEmployeeId: 'EMP-001',
  boundEmployeeName: '张三',
  memberLevel: '金钻', customerSource: null, promoterEmployeeName: null,
  memberLevelUpgradedAt: new Date('2026-03-15T14:32:00Z'),
  memberLevelLockedUntil: new Date('2026-08-12T14:32:00Z'),
  customerType: '流量客', spendingTier: '<1990', monthlyActivity: null, customerStatus: null,
  birthday: null, occupation: null, isMarried: null, wechatName: null, skinType: null,
  improvementFocus: null, skinIssue: null, wellnessPreference: null, notes: null,
  createdAt: new Date('2026-01-15T08:00:00Z'),
  updatedAt: new Date('2026-03-15T10:00:00Z'),
  storeName: '南昌旗舰店',
  marketName: '南昌市场',
}

/** mock: select(customerColumns) → from → where → orderBy，兼容旧 .limit 收口 */
function mockFullSelectChain(rows: any[]) {
  const chain: any = Object.assign(Promise.resolve(rows), {})
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

describe('getCustomers — 全量列表（旧接口）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回序列化的顾客列表', async () => {
    mockFullSelectChain([mockFullRow])

    const result = await getCustomers()

    expect(result).toHaveLength(1)
    expect(result[0].userId).toBe('FYGK-001')
    expect(result[0].name).toBe('李女士')
    expect(result[0].storeName).toBe('南昌旗舰店')
  })

  it('空结果 → 返回 []', async () => {
    mockFullSelectChain([])

    const result = await getCustomers()

    expect(result).toEqual([])
  })
})

describe('getCustomerById — 单顾客查询', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(hasRole as any).mockReturnValue(false)
  })

  it('找到 → 返回 Customer', async () => {
    mockFullSelectChain([mockFullRow])

    const result = await getCustomerById('FYGK-001')

    expect(result).not.toBeNull()
    expect(result!.userId).toBe('FYGK-001')
  })

  it('未找到 → 返回 null', async () => {
    mockFullSelectChain([])

    const result = await getCustomerById('FYGK-999')

    expect(result).toBeNull()
  })

  it('admin 纯角色（无 manager/customer_mgr/finance）→ 直接返回 null', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    // hasSessionRole 直读 session.roles，mockSession 含 manager 角色会导致 isAdminOnly=false
    // 需用空 roles 真实模拟纯 admin 场景
    const adminOnlySession = { ...mockSession, roles: [] }
    ;(getSession as any).mockResolvedValue(adminOnlySession)

    const result = await getCustomerById('FYGK-001')

    expect(result).toBeNull()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('serializeCustomer 带出保级日和升级时间 ISO 字符串', async () => {
    mockFullSelectChain([mockFullRow])

    const result = await getCustomerById('FYGK-001')

    expect(result).not.toBeNull()
    expect(result!.memberLevelUpgradedAt).toBe('2026-03-15T14:32:00.000Z')
    expect(result!.memberLevelLockedUntil).toBe('2026-08-12T14:32:00.000Z')
  })

  it('保级字段为 null 时序列化为 null（不抛异常）', async () => {
    const rowNoLock = { ...mockFullRow, memberLevelUpgradedAt: null, memberLevelLockedUntil: null }
    mockFullSelectChain([rowNoLock])

    const result = await getCustomerById('FYGK-001')

    expect(result!.memberLevelUpgradedAt).toBeNull()
    expect(result!.memberLevelLockedUntil).toBeNull()
  })
})

describe('searchCustomerByPhone — 手机号搜索', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('找到 → 返回 Customer', async () => {
    mockFullSelectChain([mockFullRow])

    const result = await searchCustomerByPhone('13812345678')

    expect(result).not.toBeNull()
    expect(result!.phone).toBe('13812345678')
  })

  it('未找到 → 返回 null', async () => {
    mockFullSelectChain([])

    const result = await searchCustomerByPhone('13900000000')

    expect(result).toBeNull()
  })
})

describe('searchCustomers — 模糊搜索（收紧：bound_store_id 必须非空）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('空白关键字 → 直接返回 []，不查 DB', async () => {
    const result = await searchCustomers('   ')
    expect(result).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('where 子句包含 isNotNull(boundStoreId) — 未绑店顾客被过滤', async () => {
    mockFullSelectChain([mockFullRow])
    await searchCustomers('李')
    expect(isNotNull).toHaveBeenCalledWith(clientWechatUsers.boundStoreId)
  })

  it('命中已绑店顾客 → 返回序列化结果', async () => {
    mockFullSelectChain([mockFullRow])
    const result = await searchCustomers('13812')
    expect(result).toHaveLength(1)
    expect(result[0].phone).toBe('13812345678')
    expect(result[0].storeName).toBe('南昌旗舰店')
  })
})

// ── getCustomerRefundHistory（退换记录 Tab）────────────────────────────────────
// getCustomerRefundHistory 先调 getCustomerById（scope 守卫）再查退款 / 转换单：
//   call 1 = getCustomerById(.from→.where→.limit)；call 2 = 退款流水(.from→.innerJoin→.where→.orderBy)；
//   call 3 = 转换单(.from→.where→.orderBy)
function mockRefundFlow(customerRows: any[], refundRows: any[] = [], convRows: any[] = []) {
  let call = 0
  ;(db.select as any).mockImplementation(() => {
    call += 1
    if (call === 1) {
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(customerRows) }) }) }
    }
    if (call === 2) {
      const c: any = {}
      c.from = vi.fn().mockReturnValue(c)
      c.innerJoin = vi.fn().mockReturnValue(c)
      c.where = vi.fn().mockReturnValue(c)
      c.orderBy = vi.fn().mockResolvedValue(refundRows)
      return c
    }
    const c: any = {}
    c.from = vi.fn().mockReturnValue(c)
    c.where = vi.fn().mockReturnValue(c)
    c.orderBy = vi.fn().mockResolvedValue(convRows)
    return c
  })
}

describe('getCustomerRefundHistory — scope 守卫 + 空结果', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(hasRole as any).mockReturnValue(false)
  })

  it('顾客在 scope → 放行，按顾客跨门店查退款 / 转换单 → 空结果返回 []', async () => {
    mockRefundFlow([mockFullRow])
    const result = await getCustomerRefundHistory('user-1')
    expect(result).toEqual([])
    // getCustomerById + 退款 + 转换单 共 3 次 select
    expect((db.select as any).mock.calls.length).toBe(3)
  })

  it('顾客不在 scope（getCustomerById 返回 null）→ 返回 []，不再查退款流水（防越权 IDOR）', async () => {
    mockRefundFlow([]) // getCustomerById → null
    const result = await getCustomerRefundHistory('user-1')
    expect(result).toEqual([])
    // 仅 getCustomerById 一次 select，提前 return，未进入退款查询
    expect((db.select as any).mock.calls.length).toBe(1)
    // scope 守卫生效：getCustomerById 内部应用了 scopeCondition
    expect(scopeCondition).toHaveBeenCalled()
  })
})

// ── getCustomerServiceOrders（服务记录 Tab）───────────────────────────────────
// call 1 = getCustomerById；call 2 = 服务单(.from→.leftJoin→.where→.orderBy)
function mockServiceFlow(customerRows: any[], serviceRows: any[] = []) {
  let call = 0
  ;(db.select as any).mockImplementation(() => {
    call += 1
    if (call === 1) {
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(customerRows) }) }) }
    }
    const c: any = {}
    c.from = vi.fn().mockReturnValue(c)
    c.leftJoin = vi.fn().mockReturnValue(c)
    c.where = vi.fn().mockReturnValue(c)
    c.orderBy = vi.fn().mockResolvedValue(serviceRows)
    return c
  })
}

describe('getCustomerServiceOrders — scope 守卫 + 空结果', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(hasRole as any).mockReturnValue(false)
  })

  it('顾客在 scope → 放行，按顾客跨门店查服务单 → 空结果返回 []', async () => {
    mockServiceFlow([mockFullRow])
    const result = await getCustomerServiceOrders('user-1')
    expect(result).toEqual([])
    expect((db.select as any).mock.calls.length).toBe(2)
  })

  it('顾客不在 scope（getCustomerById 返回 null）→ 返回 []，不再查服务单（防越权 IDOR）', async () => {
    mockServiceFlow([]) // getCustomerById → null
    const result = await getCustomerServiceOrders('user-1')
    expect(result).toEqual([])
    expect((db.select as any).mock.calls.length).toBe(1)
    expect(scopeCondition).toHaveBeenCalled()
  })
})

// ── assignCustomer（客户分配）─────────────────────────────────────────────────

describe('assignCustomer — 校验 + scope + 审计', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('缺少 employeeId → 拒绝，不查 DB', async () => {
    const result = await assignCustomer('user-1', '')
    expect(result.success).toBe(false)
    expect(result.message).toContain('请选择美容师')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('员工不存在 → 拒绝，不更新', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await assignCustomer('user-1', 'EMP-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('员工不存在')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('员工不在 session scope（非 admin）→ 拒绝，不更新', async () => {
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isInScope as any).mockReturnValue(false) // 员工 store-2 不在 scope
    ;(db.select as any).mockImplementation(makeSelectChain([{ name: '李美容师', storeId: 'store-2' }]))
    const result = await assignCustomer('user-1', 'EMP-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权分配给该门店的员工')
    expect(isInScope).toHaveBeenCalledWith(mockSession, 'store-2')
    expect(db.update).not.toHaveBeenCalled()
    ;(isInScope as any).mockReturnValue(true) // 恢复默认
  })

  it('admin session → 任意门店员工放行（isInScope 对 admin 返回 true）', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true) // admin 天然放行
    ;(db.select as any).mockImplementation(makeSelectChain([{ name: '赵美容师', storeId: 'store-99' }]))
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await assignCustomer('user-1', 'EMP-3')
    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalled()
    ;(isAdminScope as any).mockReturnValue(false) // 恢复默认
  })

  it('正常分配（rowCount=1）→ 成功 + 写冗余姓名 + 审计日志', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(makeSelectChain([{ name: '王美容师', storeId: 'store-1' }]))
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await assignCustomer('user-1', 'EMP-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('王美容师')
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ boundEmployeeId: 'EMP-1', boundEmployeeName: '王美容师' }),
    )
    const { logOperation } = await import('@/lib/operation-log')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'customer.assign',
      'customer',
      'user-1',
      expect.objectContaining({ employeeId: 'EMP-1', employeeName: '王美容师' }),
    )
  })

  it('scope 不符（rowCount=0）→ 失败，提示不存在或无权', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(makeSelectChain([{ name: '王美容师', storeId: 'store-1' }]))
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await assignCustomer('user-1', 'EMP-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('权限拒绝：requirePermission 抛出 → action 失败', async () => {
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 缺少 customer:update 权限')
    })
    await expect(assignCustomer('user-1', 'EMP-1')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.update).not.toHaveBeenCalled()
  })
})

// ── getCustomerPrepaidBalance（储值卡余额）──────────────────────────────────────

describe('getCustomerPrepaidBalance — 账户级、未绑定放行', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('有卡 → 返回 cardId + balance', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ cardId: 'CARD-1', balance: '188.50' }]))
    const result = await getCustomerPrepaidBalance('user-1')
    expect(result).toEqual({ cardId: 'CARD-1', balance: '188.50' })
  })

  it('无卡 → 返回 { cardId: null, balance: "0" }', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await getCustomerPrepaidBalance('user-1')
    expect(result).toEqual({ cardId: null, balance: '0' })
  })

  it('不施加 scope 过滤（账户级资产）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    await getCustomerPrepaidBalance('user-1')
    expect(scopeCondition).not.toHaveBeenCalled()
  })
})

// ── mergeClientProfile（孤儿档案合并）──────────────────────────────────────────

describe('mergeClientProfile — 积分批次余额重算', () => {
  function singleRowSelect(row: Record<string, unknown>) {
    const limit = vi.fn().mockResolvedValue([row])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    return { from }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(true)
    ;(hasRole as any).mockReturnValue(false)
  })

  it('迁移积分批次后，在同一事务内按批次重算目标顾客余额缓存', async () => {
    ;(db.select as any)
      .mockReturnValueOnce(singleRowSelect({
        userId: 'active-user',
        openid: 'openid-active',
        boundStoreId: 'store-1',
        pointsBalance: 100,
      }))
      .mockReturnValueOnce(singleRowSelect({
        userId: 'orphan-user',
        openid: null,
        boundStoreId: 'store-1',
        pointsBalance: 50,
      }))

    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    const tx = {
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values })
          return { where: vi.fn().mockResolvedValue({ count: 1 }) }
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue({ count: 1 }) })),
    }
    ;(db.transaction as any).mockImplementation(async (fn: (arg: typeof tx) => Promise<void>) => fn(tx))

    const result = await mergeClientProfile('active-user', 'orphan-user')

    expect(result.success).toBe(true)
    const pointBatchMove = updates.findIndex(
      ({ table, values }) => table === pointBatches && values.userId === 'active-user',
    )
    const balanceRecompute = updates.findIndex(
      ({ table, values }) => table === clientWechatUsers && 'pointsBalance' in values,
    )
    expect(pointBatchMove).toBeGreaterThanOrEqual(0)
    expect(balanceRecompute).toBeGreaterThan(pointBatchMove)
    expect(updates[balanceRecompute]?.values).toEqual(expect.objectContaining({
      pointsBalance: expect.anything(),
      pointsUpdatedAt: expect.anything(),
    }))
  })

  it('迁移孤儿人工档案时传递对应覆盖标记，并保留显式清空标记', async () => {
    ;(db.select as any)
      .mockReturnValueOnce(singleRowSelect({
        userId: 'active-user',
        openid: 'openid-active',
        boundStoreId: 'store-1',
        customerSource: null,
        occupation: null,
        skinIssue: '活跃档案已有值',
        workfineOverrideFields: ['birthday'],
      }))
      .mockReturnValueOnce(singleRowSelect({
        userId: 'orphan-user',
        openid: null,
        boundStoreId: 'store-1',
        customerSource: '抖音',
        occupation: null,
        skinIssue: '孤儿档案值',
        workfineOverrideFields: ['customer_source', 'occupation', 'skin_issue'],
      }))

    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    const tx = {
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values })
          return { where: vi.fn().mockResolvedValue({ count: 1 }) }
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue({ count: 1 }) })),
    }
    ;(db.transaction as any).mockImplementation(async (fn: (arg: typeof tx) => Promise<void>) => fn(tx))

    const result = await mergeClientProfile('active-user', 'orphan-user')

    expect(result.success).toBe(true)
    const profilePatch = updates.find(
      ({ table, values }) => table === clientWechatUsers && 'customerSource' in values,
    )?.values
    expect(profilePatch).toEqual(expect.objectContaining({
      customerSource: '抖音',
      workfineOverrideFields: expect.anything(),
    }))
    expect(profilePatch).not.toHaveProperty('skinIssue')
    expect((sql as any).join).toHaveBeenCalledTimes(1)
    expect((sql as any).join.mock.calls[0][0]).toHaveLength(2)
    expect((sql as any).raw).toHaveBeenCalledWith(', ')
    const transferValues = (sql as any).mock.calls
      .map((call: unknown[]) => call[1])
      .filter((value: unknown) => value === 'customer_source' || value === 'occupation')
    expect(transferValues).toEqual(expect.arrayContaining(['customer_source', 'occupation']))
    expect(transferValues).toHaveLength(2)
    const markerUnionCall = (sql as any).mock.calls.find((call: unknown[]) =>
      call[1] === clientWechatUsers.workfineOverrideFields
      && call[2] === (sql as any).join.mock.results[0].value,
    )
    expect(markerUnionCall).toBeDefined()
  })
})

describe('exportCustomers — 顾客导出（14 列 + spending_tier 口径累计消费）', () => {
  /**
   * mock 两次 db.select：
   *   1) 主查询 .from().where().orderBy() → customerRows
   *   2) 消费补查 .from().where().groupBy() → spendRows（仅 customerRows 非空时触发）
   * spendRows=null 表示不挂第二次 mock（空结果用例）。
   */
  function mockExportChains(customerRows: any[], spendRows: any[] | null) {
    const mainChain: any = Object.assign(Promise.resolve(customerRows), {})
    mainChain.from = vi.fn().mockReturnValue(mainChain)
    mainChain.where = vi.fn().mockReturnValue(mainChain)
    mainChain.orderBy = vi.fn().mockReturnValue(mainChain)
    mainChain.limit = vi.fn().mockResolvedValue(customerRows)
    ;(db.select as any).mockReturnValueOnce(mainChain)

    if (spendRows !== null) {
      const spendChain: any = {}
      spendChain.from = vi.fn().mockReturnValue(spendChain)
      spendChain.where = vi.fn().mockReturnValue(spendChain)
      spendChain.groupBy = vi.fn().mockResolvedValue(spendRows)
      ;(db.select as any).mockReturnValueOnce(spendChain)
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('字段映射 + 累计消费回填（spending_tier 口径；无消费记录回退 0；birthday 按 Asia/Shanghai）', async () => {
    const customerRows = [
      {
        userId: 'u1', name: '张三', phone: '13800000001', storeName: '南昌店',
        customerType: '会员客', memberLevel: '金钻', spendingTier: '3-6W', customerStatus: '保有会员-稳定',
        boundEmployeeName: '李美容', promoterName: '王推荐', customerSource: '老带新',
        // birthday 是 drizzle date() 列 → 真实取出来是 string，不是 Date（别改回 Date，会让
        // mock 与真实类型漂移，掩盖「date 列被当 UTC 午夜换算」这类缺陷）
        birthday: '1990-05-20',
        // created_at / became_member_at 是 timestamptz（withTimezone）→ 真实取出来是 Date。
        // 这两个值的 UTC 日期都比北京日期早一天，裸 slice(0,10) 会各偏一天，
        // 只有走 fmtDate（Asia/Shanghai 还原）才对。
        createdAt: new Date('2026-01-14T17:30:00.000Z'),
        becameMemberAt: new Date('2026-03-01T23:00:00.000Z'),
      },
      {
        userId: 'u2', name: null, phone: null, storeName: null,
        customerType: '流量客', memberLevel: null, spendingTier: '<1990', customerStatus: null,
        boundEmployeeName: null, promoterName: null, customerSource: null, birthday: null,
        createdAt: new Date('2026-02-10T03:00:00.000Z'),
        becameMemberAt: null, // 流量客从未成为会员
      },
    ]
    mockExportChains(customerRows, [{ clientUserId: 'u1', total: '35000.00' }])

    const { rows, truncated } = await exportCustomers({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      name: '张三', phone: '13800000001', storeName: '南昌店',
      customerType: '会员客', memberLevel: '金钻', spendingTier: '3-6W', customerStatus: '保有会员-稳定',
      employeeName: '李美容', promoterName: '王推荐', customerSource: '老带新',
      totalSpend: '35000.00', // 与 spendingTier '3-6W' 自洽
    })
    expect(rows[0].birthday).toBe('1990-05-20') // date 列：fmtDate 走 slice 分支，与时区无关
    // #183 新增两列：timestamptz 必须按北京日期落地，不是 UTC 日期
    expect(rows[0].createdAt).toBe('2026-01-15')
    expect(rows[0].becameMemberAt).toBe('2026-03-02')
    // u2 无消费记录 → totalSpend 回退 '0'；null 字段透传
    expect(rows[1].totalSpend).toBe('0')
    expect(rows[1].name).toBeNull()
    expect(rows[1].birthday).toBeNull()
    expect(rows[1].createdAt).toBe('2026-02-10')
    expect(rows[1].becameMemberAt).toBeNull() // 非会员客留空，不回退成建档日
  })

  it('超过旧上限也返回全量且不标记截断（大批量下格式化路径照样跑）', async () => {
    const customerRows = Array.from({ length: 10001 }, (_, i) => ({
      userId: `u${i}`, name: `顾客${i}`, phone: null, storeName: null,
      customerType: '流量客', memberLevel: null, spendingTier: '<1990', customerStatus: null,
      boundEmployeeName: null, promoterName: null, customerSource: null, birthday: null,
      // created_at 是 NOT NULL 列，给 null 会让这一万行全走短路分支、fmtDate 一次都不执行
      createdAt: new Date('2026-02-10T03:00:00.000Z'), becameMemberAt: null,
    }))
    mockExportChains(customerRows, [])

    const { rows, truncated } = await exportCustomers({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(10001)
    expect(rows[10000].createdAt).toBe('2026-02-10')
  })

  it('keyset 分页：按不可变 user_id 排序 + 游标 gt，切掉探测行，游标取本页末行', async () => {
    const mkRow = (id: string) => ({
      userId: id, name: `顾客${id}`, phone: null, storeName: null, customerType: '流量客',
      memberLevel: null, spendingTier: '<1990', customerStatus: null, boundEmployeeName: null,
      promoterName: null, customerSource: null, birthday: null,
      createdAt: new Date('2026-02-10T03:00:00.000Z'), becameMemberAt: null,
    })
    // 请求 2 条 → 查询取 3 条（探测行），末行应被切掉且不参与游标
    const fetched = [mkRow('u1'), mkRow('u2'), mkRow('u3')]
    const mainChain: any = Object.assign(Promise.resolve(fetched), {})
    mainChain.from = vi.fn().mockReturnValue(mainChain)
    mainChain.where = vi.fn().mockReturnValue(mainChain)
    mainChain.orderBy = vi.fn().mockReturnValue(mainChain)
    mainChain.limit = vi.fn().mockResolvedValue(fetched)
    ;(db.select as any).mockReturnValueOnce(mainChain)
    const spendChain: any = {}
    spendChain.from = vi.fn().mockReturnValue(spendChain)
    spendChain.where = vi.fn().mockReturnValue(spendChain)
    spendChain.groupBy = vi.fn().mockResolvedValue([])
    ;(db.select as any).mockReturnValueOnce(spendChain)

    const result = await exportCustomers({}, { limit: 2, cursor: 'u0' })

    expect(mainChain.limit).toHaveBeenCalledWith(3) // limit + 1 探测行
    expect(result.rows).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    // 游标取本页最后一行（u2），不是被切掉的探测行（u3）
    expect(result.nextCursor).toBe('u2')
    expect(gt).toHaveBeenCalledWith(clientWechatUsers.userId, 'u0')
    // 排序键只能是 user_id：name 可被 updateCustomer 改写，拿它当游标首键会让
    // 改名后的顾客移到游标之前、永久漏掉
    expect(mainChain.orderBy).toHaveBeenCalledWith({ type: 'asc', col: 'user_id' })
    expect(mainChain.orderBy).toHaveBeenCalledTimes(1)
    expect(gt).not.toHaveBeenCalledWith(clientWechatUsers.name, expect.any(String))
    // 补查累计消费只针对本页两人，不含探测行
    expect(spendChain.where).toHaveBeenCalledWith({ type: 'inArray', col: 'client_user_id', vals: ['u1', 'u2'] })
  })

  it('keyset 游标是空串/非字符串 → 抛 INVALID_STATE，不静默从头重扫', async () => {
    mockExportChains([], null)

    await expect(exportCustomers({}, { limit: 2, cursor: '' as any })).rejects.toThrow('导出分页游标无效')
    await expect(exportCustomers({}, { limit: 2, cursor: 0 as any })).rejects.toThrow('导出分页游标无效')
    await expect(exportCustomers({}, { limit: 2, cursor: { userId: 'u9' } as any })).rejects.toThrow('导出分页游标无效')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('空结果 → rows=[] truncated=false，不触发消费补查（db.select 仅 1 次）', async () => {
    mockExportChains([], null)

    const { rows, truncated } = await exportCustomers({})

    expect(rows).toEqual([])
    expect(truncated).toBe(false)
    expect(db.select).toHaveBeenCalledTimes(1)
  })
})
