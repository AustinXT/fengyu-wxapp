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
  orgNodes: { id: 'id', name: 'name', type: 'type', sortOrder: 'sort_order', parentId: 'parent_id' },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
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
  or: vi.fn((...args) => ({ type: 'or', args })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
  sql: Object.assign(
    vi.fn((...args) => ({ type: 'sql', args })),
    { raw: vi.fn() },
  ),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((_table, aliasName) => ({ _aliasName: aliasName })),
}))

import { createEmployee, updateEmployee, getEmployeesPaginated, getOrgLevel2ForFilter } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { eq, ilike, inArray, isNull } from 'drizzle-orm'

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
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: null })
    // phone=null 时跳过格式校验，直接进入 DB update
    expect(db.update).toHaveBeenCalled()
  })

  it('乐观锁冲突（rowCount=0）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ count: 0 })
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
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
  })

  it('rowCount=0，无乐观锁 → 报告员工不存在或无权（不再静默成功）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-999', { name: '张三' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('isResigned=true → 删除权限角色', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    // update：更新员工
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    // delete：删除权限
    const deleteWhere = vi.fn().mockResolvedValue({})
    ;(db.delete as any).mockReturnValue({ where: deleteWhere })

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.delete).toHaveBeenCalledOnce()
  })

  it('权限删除失败 → 重新抛出（不静默忽略）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('connection lost')) })

    await expect(updateEmployee('FY-001', { isResigned: true })).rejects.toThrow('connection lost')
  })
})

describe('updateEmployee — §AFF-03 门店变更 scope 同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  /**
   * 构建 mock chain，支持 storeId 变更场景的多次 db.select / db.update 序列。
   *
   * db.select 调用顺序：
   *   1. 获取旧 storeId（仅 data.storeId !== undefined 时）
   *   2. 手机号唯一性校验（仅 data.phone 时）
   *   3. 获取旧门店 orgNodeId（scope sync）
   *   4. 获取新门店 orgNodeId（scope sync）
   *
   * db.update 调用顺序：
   *   1. 更新员工记录
   *   2. 更新 permission_roles scope
   */
  function setupScopeSyncMocks(opts: {
    oldStoreId: string
    oldOrgNodeId: string
    newOrgNodeId: string
    scopeUpdateRowCount?: number
  }) {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const current = selectCall
      const limit = vi.fn().mockImplementation(() => {
        if (current === 1) return Promise.resolve([{ storeId: opts.oldStoreId }])
        if (current === 2) return Promise.resolve([{ orgNodeId: opts.oldOrgNodeId }])
        if (current === 3) return Promise.resolve([{ orgNodeId: opts.newOrgNodeId }])
        return Promise.resolve([])
      })
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    let updateCall = 0
    ;(db.update as any).mockImplementation(() => {
      updateCall++
      const current = updateCall
      const where = vi.fn().mockImplementation(() => {
        if (current === 1) return Promise.resolve({ count: 1 }) // employee update
        if (current === 2) return Promise.resolve({ count: opts.scopeUpdateRowCount ?? 1 }) // scope sync
        return Promise.resolve({ count: 0 })
      })
      const set = vi.fn().mockReturnValue({ where })
      return { set }
    })
  }

  it('storeId 变更 → 触发 scope 同步 + 审计日志', async () => {
    setupScopeSyncMocks({
      oldStoreId: 'store-A',
      oldOrgNodeId: 'org-store-A',
      newOrgNodeId: 'org-store-B',
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // db.update 应被调用 2 次：员工更新 + scope 同步
    expect(db.update).toHaveBeenCalledTimes(2)
    // logOperation 应被调用 2 次：permission.scopeSync + employee.update
    expect(logOperation).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync', 'permission_role', 'FY-001',
      expect.objectContaining({ oldStoreId: 'store-A', newStoreId: 'store-B' }),
    )
  })

  it('storeId 未变更（编辑其他字段）→ 不触发 scope 同步', async () => {
    // data 中不含 storeId → 不查旧值，不做 scope sync
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1) // 仅员工更新
    expect(logOperation).not.toHaveBeenCalledWith(
      expect.anything(), 'permission.scopeSync', expect.anything(), expect.anything(), expect.anything(),
    )
  })

  it('storeId 设为相同值 → 不触发 scope 同步', async () => {
    // 旧 storeId 与新值相同
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1 ? [{ storeId: 'store-A' }] : [],
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1) // 仅员工更新
  })

  it('原无门店（oldStoreId=null）→ 不触发 scope 同步', async () => {
    // 旧 storeId 为 null（新入职未分配门店的员工）
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1 ? [{ storeId: null }] : [],
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 旧门店为 null，不做 scope 同步
    expect(db.update).toHaveBeenCalledTimes(1)
  })

  it('scope 同步无匹配行（rowCount=0）→ 不写审计日志', async () => {
    setupScopeSyncMocks({
      oldStoreId: 'store-A',
      oldOrgNodeId: 'org-store-A',
      newOrgNodeId: 'org-store-B',
      scopeUpdateRowCount: 0, // 无匹配的 store 级 scope
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // scope UPDATE 执行了但 rowCount=0 → 不写 scopeSync 日志
    expect(logOperation).toHaveBeenCalledTimes(1) // 仅 employee.update
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'employee.update', 'employee', 'FY-001', expect.anything(),
    )
  })
})

// ── getEmployeesPaginated 服务端分页 ──────────────────────────────────────────

describe('getEmployeesPaginated — 服务端分页', () => {
  const mockEmployeeRow = {
    staff_wechat_users: {
      employeeId: 'FY-260315001',
      openid: null,
      phone: '13812345678',
      name: '张三',
      gender: '男',
      idCard: null,
      storeId: 'store-1',
      orgNodeId: 'dept-1',
      positionName: '美容师',
      birthday: null,
      skills: ['美容师'],
      isResigned: false,
      lastLoginAt: null,
      createdAt: new Date('2026-01-15T08:00:00Z'),
      updatedAt: new Date('2026-03-15T10:00:00Z'),
    },
    stores: { storeId: 'store-1', storeName: '南昌旗舰店' },
    org_nodes: { id: 'dept-1', name: '美容部' },
    store_node: { id: 'org-store-1', name: '南昌旗舰店节点' },
    market_node: { id: 'market-1', name: '南昌市场' },
  }

  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list', 'employee:create', 'employee:update'], scopeStoreIds: [] },
  }

  /** mock 2 个并行 select：COUNT + DATA */
  function mockPaginatedChain(total: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        const where = vi.fn().mockResolvedValue([{ count: total }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA: select → from → leftJoin × 4 → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
  })

  it('无筛选 → 返回 data + total', async () => {
    mockPaginatedChain(1, [mockEmployeeRow])

    const result = await getEmployeesPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].employeeId).toBe('FY-260315001')
    expect(result.data[0].name).toBe('张三')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].departmentName).toBe('美容部')
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getEmployeesPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-2')
  })

  it('status=active → eq(isResigned, false)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ status: 'active' })

    expect(eq).toHaveBeenCalledWith('is_resigned', false)
  })

  it('status=resigned → eq(isResigned, true)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ status: 'resigned' })

    expect(eq).toHaveBeenCalledWith('is_resigned', true)
  })

  it('search 筛选 → ilike(name, employeeId, phone)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ search: '张' })

    expect(ilike).toHaveBeenCalledWith('name', '%张%')
    expect(ilike).toHaveBeenCalledWith('employee_id', '%张%')
    expect(ilike).toHaveBeenCalledWith('phone', '%张%')
  })

  it('page/pageSize → 2 次 select', async () => {
    mockPaginatedChain(100, [])

    const result = await getEmployeesPaginated({ page: 5, pageSize: 10 })

    expect(result.total).toBe(100)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('stores/org_nodes JOIN 为 null → undefined', async () => {
    const noJoins = {
      ...mockEmployeeRow,
      stores: null,
      org_nodes: null,
      store_node: null,
      market_node: null,
    }
    mockPaginatedChain(1, [noJoins])

    const result = await getEmployeesPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].departmentName).toBeUndefined()
  })

  it('marketName 从 market_node JOIN 映射', async () => {
    mockPaginatedChain(1, [mockEmployeeRow])

    const result = await getEmployeesPaginated()

    expect(result.data[0].marketName).toBe('南昌市场')
  })

  it('market_node null → marketName undefined', async () => {
    const noMarket = {
      ...mockEmployeeRow,
      market_node: null,
    }
    mockPaginatedChain(1, [noMarket])

    const result = await getEmployeesPaginated()

    expect(result.data[0].marketName).toBeUndefined()
  })

  it('marketId 筛选（市场类型） → inArray 被调用', async () => {
    // marketId 筛选会先查 org_node type，再建 subquery，再执行 COUNT + DATA
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 查询节点类型: select → from → where → limit
        const limit = vi.fn().mockResolvedValue([{ type: '市场' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      if (callIndex === 2) {
        // subquery: select → from → innerJoin → where (返回 subquery 对象)
        const subWhere = vi.fn().mockReturnValue({ _subquery: true })
        const innerJoin = vi.fn().mockReturnValue({ where: subWhere })
        const from = vi.fn().mockReturnValue({ innerJoin })
        return { from }
      }
      if (callIndex === 3) {
        // COUNT query
        const where = vi.fn().mockResolvedValue([{ count: 0 }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA query: select → from → leftJoin × 4 → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue([])
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    await getEmployeesPaginated({ marketId: 'market-1' })

    expect(inArray).toHaveBeenCalledWith('store_id', expect.anything())
  })

  it('marketId 筛选（部门类型） → eq(orgNodeId) 被调用', async () => {
    // 先查节点类型返回 department，然后直接按 orgNodeId 过滤
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 查询节点类型: select → from → where → limit
        const limit = vi.fn().mockResolvedValue([{ type: '部门' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      if (callIndex === 2) {
        // COUNT query
        const where = vi.fn().mockResolvedValue([{ count: 0 }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA query
      const offset = vi.fn().mockResolvedValue([])
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    await getEmployeesPaginated({ marketId: 'dept-1' })

    expect(eq).toHaveBeenCalledWith('org_node_id', 'dept-1')
  })
})

// ── getOrgLevel2ForFilter ──────────────────────────────────────────────────────

describe('getOrgLevel2ForFilter', () => {
  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
  })

  it('返回 headquarters 子节点（市场 + 总部部门）', async () => {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 查询 headquarters: select → from → where → limit
        const limit = vi.fn().mockResolvedValue([{ id: 'hq-1' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // 查询子节点: select → from → where → orderBy
      const orderBy = vi.fn().mockResolvedValue([
        { id: 'market-1', name: '南昌市场', type: '市场' },
        { id: 'market-2', name: '九江市场', type: '市场' },
        { id: 'dept-1', name: '人事部', type: '部门' },
      ])
      const where = vi.fn().mockReturnValue({ orderBy })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await getOrgLevel2ForFilter()

    expect(result).toEqual([
      { id: 'market-1', name: '南昌市场', type: '市场' },
      { id: 'market-2', name: '九江市场', type: '市场' },
      { id: 'dept-1', name: '人事部', type: '部门' },
    ])
  })

  it('无 headquarters 节点 → 返回空数组', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getOrgLevel2ForFilter()

    expect(result).toEqual([])
  })
})
