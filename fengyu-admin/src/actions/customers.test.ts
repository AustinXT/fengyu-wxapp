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
  desc: vi.fn((col) => ({ type: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(() => false),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isAdminScope: vi.fn(() => false),
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

import { updateCustomer, createCustomer } from './customers'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

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
})
