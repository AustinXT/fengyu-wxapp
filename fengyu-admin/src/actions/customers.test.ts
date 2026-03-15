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
  },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
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
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'aabbcc112233' })),
}))

import { updateCustomer, createCustomer, getCustomersPaginated, getCustomers, getCustomerById, searchCustomerByPhone } from './customers'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope } from '@/lib/permissions'
import { hasRole } from '@/lib/auth'
import { eq, ilike } from 'drizzle-orm'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['customer:list', 'customer:update', 'customer:create'], scopeStoreIds: ['store-1'] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

// ── updateCustomer ────────────────────────────────────────────────────────────

describe('updateCustomer — 校验 + scope + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('手机号格式错误 → 拒绝，不调用 DB', async () => {
    const result = await updateCustomer('user-1', { phone: 'abc' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('手机号为 null → 跳过格式校验，进入 DB 更新', async () => {
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { phone: null })

    expect(db.update).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('scope 不符（rowCount=0，无 expectedUpdatedAt）→ 失败，提示不存在或无权', async () => {
    const where = vi.fn().mockResolvedValue({ rowCount: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { name: '张三' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('乐观锁冲突（rowCount=0，有 expectedUpdatedAt）→ 失败，提示已被修改', async () => {
    const where = vi.fn().mockResolvedValue({ rowCount: 0 })
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
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateCustomer('user-1', { name: '李四' })

    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
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
    client_wechat_users: {
      userId: 'FYGK-001',
      openid: null,
      phone: '13812345678',
      customerId: null,
      name: '李女士',
      boundStoreId: 'store-1',
      boundEmployeeId: 'EMP-001',
      memberLevel: '金卡',
      customerSource: null,
      category: null,
      birthday: null,
      occupation: null,
      isMarried: null,
      wechatName: null,
      skinType: null,
      improvementFocus: null,
      skinIssue: null,
      wellnessPreference: null,
      createdAt: new Date('2026-01-15T08:00:00Z'),
      updatedAt: new Date('2026-03-15T10:00:00Z'),
    },
    stores: { storeId: 'store-1', storeName: '南昌旗舰店' },
    staff_wechat_users: { employeeId: 'EMP-001', name: '张三' },
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
      // DATA: select → from → leftJoin × 2 → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin2 = vi.fn().mockReturnValue({ where })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
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
    expect(result.data[0].memberLevel).toBe('金卡')
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

    await getCustomersPaginated({ memberLevel: '钻石' })

    expect(eq).toHaveBeenCalledWith('member_level', '钻石')
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

  it('stores/staff JOIN 为 null → undefined', async () => {
    const noJoins = {
      ...mockCustomerRow,
      stores: null,
      staff_wechat_users: null,
    }
    mockPaginatedChain(1, [noJoins])

    const result = await getCustomersPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].employeeName).toBeUndefined()
  })
})

// ── 读函数覆盖（getCustomers / getCustomerById / searchCustomerByPhone）─────

const mockFullRow = {
  client_wechat_users: {
    userId: 'FYGK-001', openid: null, phone: '13812345678', customerId: null,
    name: '李女士', boundStoreId: 'store-1', boundEmployeeId: 'EMP-001',
    memberLevel: '金卡', customerSource: null, category: null, birthday: null,
    occupation: null, isMarried: null, wechatName: null, skinType: null,
    improvementFocus: null, skinIssue: null, wellnessPreference: null,
    createdAt: new Date('2026-01-15T08:00:00Z'),
    updatedAt: new Date('2026-03-15T10:00:00Z'),
  },
  stores: { storeId: 'store-1', storeName: '南昌旗舰店' },
  staff_wechat_users: { employeeId: 'EMP-001', name: '张三' },
}

/** mock: select → from → leftJoin × 2 → where → orderBy → limit */
function mockFullSelectChain(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy, limit })
  const leftJoin2 = vi.fn().mockReturnValue({ where })
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
  const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
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
