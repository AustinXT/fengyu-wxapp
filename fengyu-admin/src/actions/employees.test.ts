import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: {
    employeeId: 'employee_id',
    phone: 'phone',
    name: 'name',
    gender: 'gender',
    idCard: 'id_card',
    storeId: 'store_id',
    orgNodeId: 'org_node_id',
    positionName: 'position_name',
    birthday: 'birthday',
    skills: 'skills',
    isResigned: 'is_resigned',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name' },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    isVoid: 'is_void',
    voidedAt: 'voided_at',
    updatedBy: 'updated_by',
  },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(
    vi.fn((...args) => ({ type: 'sql', args })),
    { raw: vi.fn() },
  ),
}))

import { createEmployee, updateEmployee } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:create', 'employee:update'], scopeStoreIds: [] },
}

function mockSelectEmpty() {
  const limit = vi.fn().mockResolvedValue([])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

function mockSelectFound(row: any) {
  const limit = vi.fn().mockResolvedValue([row])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

function mockTransactionSuccess(employeeId = 'FY-260315001') {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([{ id: employeeId }]),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
    }
    return fn(tx)
  })
}

describe('createEmployee — 服务端输入校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('姓名为空 → 拒绝', async () => {
    const result = await createEmployee({ name: '', phone: '13812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('姓名不能为空')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号为空 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入手机号')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号格式错误（非 11 位）→ 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '123456' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号不以 1 开头 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '23812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
  })

  it('身份证格式错误 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '12345' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('身份证号格式不正确')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号已被使用 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(
      mockSelectFound({ employeeId: 'FY-001' }),
    )
    const result = await createEmployee({ name: '张三', phone: '13812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 不在 scope 内 → 拒绝，不进事务', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createEmployee({ name: '张三', phone: '13812345678', storeId: 'other-store' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内 → 正常创建', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', storeId: 'store-1' })

    expect(result.success).toBe(true)
  })

  it('storeId 为 null → 跳过 scope 校验，允许创建（未分配门店员工）', async () => {
    ;(isInScope as any).mockReturnValue(false) // 不会被调用
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', storeId: null })

    expect(result.success).toBe(true)
    // isInScope 不应被调用（storeId=null 时跳过校验）
    expect(isInScope).not.toHaveBeenCalled()
  })

  it('正常创建 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(true)
    expect(result.employeeId).toBe('FY-260315001')
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('并发唯一冲突（23505 手机号）→ 友好消息而非 500', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
  })

  it('并发唯一冲突（23505 其他约束）→ 通用提示', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (employee_id)=(FY-260315001) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('数据冲突')
  })

  it('其他 DB 异常重新抛出（非 23505）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(
      createEmployee({ name: '张三', phone: '13812345678' }),
    ).rejects.toThrow('connection lost')
  })
})

describe('updateEmployee — 服务端输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('手机号格式错误 → 拒绝', async () => {
    const result = await updateEmployee('FY-001', { phone: 'abc' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('身份证格式错误 → 拒绝', async () => {
    const result = await updateEmployee('FY-001', { idCard: 'invalid' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('身份证号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('手机号 null → 跳过格式校验（合法清除）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: null })
    // phone=null 时跳过格式校验，直接进入 DB update
    expect(db.update).toHaveBeenCalled()
  })

  it('乐观锁冲突（rowCount=0）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ rowCount: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee(
      'FY-001',
      { name: '李四' },
      '2026-01-01T00:00:00.000Z',
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('DB 唯一冲突（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(pgError) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
  })

  it('正常更新 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
  })

  it('rowCount=0，无乐观锁 → 报告员工不存在或无权（不再静默成功）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ rowCount: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-999', { name: '张三' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('isResigned=true → 同步作废权限角色', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    // 第一次 update：更新员工
    const empWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    // 第二次 update：作废权限
    const roleWhere = vi.fn().mockResolvedValue({})
    const roleSet = vi.fn().mockReturnValue({ where: roleWhere })
    let updateCallCount = 0
    ;(db.update as any).mockImplementation(() => {
      updateCallCount++
      return updateCallCount === 1 ? { set: empSet } : { set: roleSet }
    })

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(2) // 员工 + 权限
  })

  it('权限作废失败 → 重新抛出（不静默忽略）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const empWhere = vi.fn().mockResolvedValue({ rowCount: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    const roleSet = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('connection lost')) })
    let updateCallCount = 0
    ;(db.update as any).mockImplementation(() => {
      updateCallCount++
      return updateCallCount === 1 ? { set: empSet } : { set: roleSet }
    })

    await expect(updateEmployee('FY-001', { isResigned: true })).rejects.toThrow('connection lost')
  })
})
