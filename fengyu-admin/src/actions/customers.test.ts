import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    phone: 'phone',
    name: 'name',
    boundStoreId: 'bound_store_id',
    boundEmployeeId: 'bound_employee_id',
    updatedAt: 'updated_at',
    memberLevel: 'member_level',
    customerType: 'customer_type',
    spendingTier: 'spending_tier',
    monthlyActivity: 'monthly_activity',
    customerStatus: 'customer_status',
  },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

vi.mock('@db/prepaid-card', () => ({
  prepaidCards: { cardId: 'card_id', userId: 'user_id', balance: 'balance' },
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
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), { raw: vi.fn() }),
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

import { updateCustomer, createCustomer, getCustomersPaginated, getCustomers, getCustomerById, searchCustomerByPhone, searchCustomers, getCustomerRefundHistory, assignCustomer, getCustomerPrepaidBalance } from './customers'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope, requirePermission, scopeCondition } from '@/lib/permissions'
import { hasRole } from '@/lib/auth'
import { logUpdate } from '@/lib/operation-log'
import { clientWechatUsers } from '@db/user'
import { eq, ilike, isNotNull } from 'drizzle-orm'

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
    promoterEmployeeId: null,
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
  memberLevel: '金钻', customerSource: null, promoterEmployeeId: null,
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

/** mock: select(customerColumns) → from → where → orderBy → limit */
function mockFullSelectChain(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy, limit })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
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
function mockRefundChain() {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockResolvedValue([])
  ;(db.select as any).mockReturnValue(chain)
}

describe('getCustomerRefundHistory — scope + 空结果', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无退款/转换单 → 返回空数组', async () => {
    mockRefundChain()
    const result = await getCustomerRefundHistory('user-1')
    expect(result).toEqual([])
  })

  it('退换记录跟顾客走 — 不再按 sale_orders.store_id 应用 scopeCondition', async () => {
    mockRefundChain()
    await getCustomerRefundHistory('user-1')
    // 交易数据跟顾客走：退换记录跨门店全量，不施加门店 scope（顾客可见性由 getCustomerById 守护）
    expect(scopeCondition).not.toHaveBeenCalled()
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
