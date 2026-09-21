import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
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
    createdAt: 'created_at',
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
    role: 'role',
    scopeId: 'scope_id',
    updatedBy: 'updated_by',
  },
}))

vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn().mockResolvedValue(5),
  isAdminEmployee: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  employeeScopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
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
  gt: vi.fn((col, val) => ({ type: 'gt', col, val })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  sql: Object.assign(
    vi.fn((...args) => ({ type: 'sql', args })),
    {
      raw: vi.fn((s) => ({ type: 'sql.raw', value: s })),
      join: vi.fn((chunks, sep) => ({ type: 'sql.join', chunks, sep })),
      param: vi.fn((value) => ({ type: 'sql.param', value })),
    },
  ),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((_table, aliasName) => ({ _aliasName: aliasName })),
}))

vi.mock('@/actions/skill-tags', () => ({
  getSkillTags: vi.fn(),
  createSkillTag: vi.fn(),
  updateSkillTag: vi.fn(),
  deleteSkillTag: vi.fn(),
}))

import { createEmployee, updateEmployee, getAllocationEmployeeCandidates, getServiceStaffCandidates, getEmployees, getEmployeesPaginated, getOrgLevel2ForFilter, exportEmployees, searchEmployees } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { eq, ilike, inArray, isNull, sql, gt } from 'drizzle-orm'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { getSkillTags } from '@/actions/skill-tags'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:create', 'employee:update'], scopeStoreIds: [] },
}

describe('searchEmployees — 推荐员工检索（全部在职员工，可跨店）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['employee:list'], scopeStoreIds: ['store-1'] },
    })
  })

  it('少于 3 位关键词直接返回空，不查数据库', async () => {
    await expect(searchEmployees('12')).resolves.toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('返回员工编号、门店和脱敏手机号，不泄露完整手机号', async () => {
    const rows = [{
      employeeId: 'EMP-001', name: '王员工', phone: '13812345678',
      storeName: '一店', isResigned: false,
    }]
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)

    const result = await searchEmployees('13812345678')

    expect(result).toEqual([{
      employeeId: 'EMP-001', name: '王员工', phoneMasked: '138****5678',
      storeName: '一店', isResigned: false,
    }])
    expect(chain.limit).toHaveBeenCalledWith(20)
  })
})

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

  it('身份证为空 → 拒绝（必填）', async () => {
    const result = await createEmployee({ name: '张三', phone: '13812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入身份证号')
    expect(db.transaction).not.toHaveBeenCalled()
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
    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 不在 scope 内 → 拒绝，不进事务', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'other-store' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内 → 正常创建', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'store-1' })

    expect(result.success).toBe(true)
  })

  it('storeId 为 null → 跳过 scope 校验，允许创建（未分配门店员工）', async () => {
    ;(isInScope as any).mockReturnValue(false) // 不会被调用
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: null })

    expect(result.success).toBe(true)
    // isInScope 不应被调用（storeId=null 时跳过校验）
    expect(isInScope).not.toHaveBeenCalled()
  })

  it('正常创建 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

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

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

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

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('数据冲突')
  })

  it('其他 DB 异常重新抛出（非 23505）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(
      createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' }),
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

  /** 离职事务 mock：返回员工现有角色列表 + delete + log 链 */
  function mockResignTransaction(roles: any[]) {
    const txDelete = vi.fn().mockResolvedValue({})
    const txLimit = vi.fn() // 不需要
    const txWhere = vi.fn().mockResolvedValue(roles)
    const txFrom = vi.fn().mockReturnValue({ where: txWhere })
    const txSelect = vi.fn().mockReturnValue({ from: txFrom })
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        select: txSelect,
        delete: vi.fn().mockReturnValue({ where: txDelete }),
      }
      return fn(tx)
    })
    return { txDelete }
  }

  it('isResigned=true (非 admin) → 事务清理权限角色 + 逐条 logOperation', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    mockResignTransaction([
      { id: 11, role: 'manager', scopeId: 'store-A' },
      { id: 12, role: 'staff', scopeId: 'store-A' },
    ])

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'permission.revoke',
      'permission_role',
      '11',
      expect.objectContaining({ role: 'manager', scopeId: 'store-A', employeeId: 'FY-001', batch: 'resignation' }),
    )
  })

  it('isResigned=true 但是最后一个活跃 admin → 抛 INVALID_STATE (UPDATE 未发生)', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    ;(isAdminEmployee as any).mockResolvedValueOnce(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(1)

    await expect(
      updateEmployee('FY-001', { isResigned: true }),
    ).rejects.toThrow(/INVALID_STATE: 该员工是系统最后一个活跃 admin/)

    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('isResigned=true admin 但 count=2 → 成功离职 + 角色清理', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    ;(isAdminEmployee as any).mockResolvedValueOnce(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(2)
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    mockResignTransaction([{ id: 99, role: 'admin', scopeId: 'hq-1' }])

    const result = await updateEmployee('FY-002', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'permission.revoke',
      'permission_role',
      '99',
      expect.objectContaining({ role: 'admin', scopeId: 'hq-1', employeeId: 'FY-002', batch: 'resignation' }),
    )
  })

  it('事务内 delete 抛错 → 整个 updateEmployee 抛出（事务回滚由 Drizzle 处理）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 1, role: 'manager', scopeId: 'store-A' }]),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('connection lost')),
        }),
      }
      return fn(tx)
    })

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
    // logOperation 1 次：permission.scopeSync；logUpdate 1 次：employee.update
    expect(logOperation).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync', 'permission_role', 'FY-001',
      expect.objectContaining({ oldStoreId: 'store-A', newStoreId: 'store-B' }),
    )
    expect(logUpdate).toHaveBeenCalledTimes(1)
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
    expect(logOperation).not.toHaveBeenCalled() // scopeSync 被跳过
    expect(logUpdate).toHaveBeenCalledTimes(1) // 仅 employee.update
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

  // admin.sys.spec.md §5 默认排序：最近编辑过的员工浮顶，employeeId 作分页 tiebreaker
  it('默认 orderBy 首键为 desc(updatedAt)，带 createdAt DESC + employeeId ASC', async () => {
    // 专门 mock 以捕获 DATA 查询的 orderBy 参数
    let dataOrderBy: any = null
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        const where = vi.fn().mockResolvedValue([{ count: 0 }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      const offset = vi.fn().mockResolvedValue([])
      const limit = vi.fn().mockReturnValue({ offset })
      dataOrderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy: dataOrderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    await getEmployeesPaginated()

    expect(dataOrderBy).toHaveBeenCalledTimes(1)
    const args = dataOrderBy.mock.calls[0]
    expect(args[0]).toMatchObject({ type: 'desc', col: 'updated_at' })
    expect(args[1]).toMatchObject({ type: 'desc', col: 'created_at' })
    expect(args[2]).toMatchObject({ type: 'asc', col: 'employee_id' })
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

  it('组织筛选覆盖节点自身及任意层级下属员工和门店', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ marketId: 'market-1' })

    expect(db.select).toHaveBeenCalledTimes(2)
    const recursiveSql = (sql as any).mock.calls
      .map((call: any[]) => Array.from(call[0] as TemplateStringsArray).join(''))
      .find((text: string) => text.includes('WITH RECURSIVE descendants'))
    expect(recursiveSql).toContain('child.parent_id = descendants.id')
    expect(recursiveSql).toContain('NOT child.id = ANY(descendants.path)')
  })

  it('skills 筛选（单标签） → sql.join + && ARRAY 模板被调用，标签作为参数化占位传入', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: ['美容师'] })

    // sql.join([sql`美容师`], sql.raw(', ')) 把单标签包成 1 元素数组
    expect((sql as any).join).toHaveBeenCalledWith(
      [{ type: 'sql', args: [expect.anything(), '美容师'] }],
      { type: 'sql.raw', value: ', ' },
    )
    // 外层模板: skills && ARRAY[...]::text[] 被 sql 模板函数调用
    const overlapCalls = (sql as any).mock.results.filter(
      (r: any) => Array.isArray(r.value?.args) && r.value.args.some(
        (a: any) => typeof a === 'object' && a?.type === 'sql.join',
      ),
    )
    expect(overlapCalls.length).toBeGreaterThan(0)
  })

  it('skills 筛选（多标签 OR） → 每个标签作为独立参数化占位传入 sql.join', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: ['美容师', '养生师'] })

    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '美容师'] },
        { type: 'sql', args: [expect.anything(), '养生师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills: [] 空数组 → 不调用 sql.join（短路）', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: [] })

    expect((sql as any).join).not.toHaveBeenCalled()
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

// 2026-05-18 picker LIMIT 截断回归：getEmployees() 是开单/服务单/客户分配 picker
// 共用数据源；曾经写死 .limit(500)，全库 2000+ 员工时按 name 排序后某店员工被截断，
// 导致 admin /orders/create 选南昌万科店时下拉只显示 2 人（其余 14 人因 name 落在 500
// 行之后被截）。这里断言链路不再调 limit，且 select 链路顺序为 from → leftJoin × 4 →
// where → orderBy。
describe('getEmployees — picker 数据源不得有 LIMIT', () => {
  const pickerSession = {
    employeeId: 'ADMIN-001',
    name: 'admin',
    phone: '',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(pickerSession)
  })

  it('链路止于 orderBy（不再链式 .limit），并返回全量行', async () => {
    const allRows = Array.from({ length: 1234 }, (_, i) => ({
      staff_wechat_users: {
        employeeId: `FY-${String(i).padStart(6, '0')}`,
        openid: null,
        phone: null,
        name: `员工${i}`,
        gender: null,
        idCard: null,
        storeId: i % 2 === 0 ? 'store-A' : 'store-B',
        orgNodeId: null,
        positionName: '美容师',
        avatarUrl: null,
        birthday: null,
        skills: ['美容师'],
        isResigned: false,
        hiredAt: null,
        resignedAt: null,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      stores: { storeName: i % 2 === 0 ? '南昌万科店' : '南昌天虹店' },
      org_nodes: null,
    }))

    // orderBy 直接 resolve 全量数据；如果代码意外再调 .limit 会得到 undefined.limit
    // → TypeError，测试失败。
    const orderBy = vi.fn().mockResolvedValue(allRows)
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin4 = vi.fn().mockReturnValue({ where })
    const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
    const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getEmployees()

    expect(result).toHaveLength(1234)
    expect(orderBy).toHaveBeenCalledTimes(1)
    // 防止有人未来再加回 .limit() —— orderBy 返回的 promise 上不应有 .limit 被调
    expect((orderBy.mock.results[0]?.value as any).limit).toBeUndefined()
  })
})

describe('getAllocationEmployeeCandidates — 分配专用最小候选', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isInScope as any).mockReturnValue(true)
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['allocation:list'], scopeStoreIds: ['store-A'] },
    })
  })

  it('返回三级范围字段且不暴露手机号、身份证等档案字段', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        employee_id: 'EMP-CROSS',
        name: '跨市场老师',
        store_id: null,
        position_name: '品项老师',
        skills: ['品项老师'],
        is_on_business_trip: true,
        store_name: null,
        department_name: '品项部',
        market_name: null,
        assignment_scope: 'cross_market_trip',
      },
    ])

    const result = await getAllocationEmployeeCandidates('store-A')

    expect(result).toEqual([expect.objectContaining({
      employeeId: 'EMP-CROSS',
      assignmentScope: 'cross_market_trip',
      skills: ['品项老师'],
    })])
    expect(result[0]).not.toHaveProperty('phone')
    expect(result[0]).not.toHaveProperty('idCard')
    expect(isInScope).toHaveBeenCalledWith(expect.anything(), 'store-A')
  })
})

describe('getServiceStaffCandidates — 服务单专用候选（issue #210）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isInScope as any).mockReturnValue(true)
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['service:create'], scopeStoreIds: ['store-A'] },
    })
  })

  it('返回本店与同市场出差人员，且不暴露手机号、身份证等档案字段', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        employee_id: 'EMP-LOCAL',
        name: '本店美容师',
        store_id: 'store-A',
        position_name: '美容师',
        skills: ['美容师'],
        is_on_business_trip: false,
        store_name: 'A 店',
        department_name: '美容部',
        market_name: '南昌凤御',
        assignment_scope: 'local',
      },
      {
        employee_id: 'EMP-TRIP',
        name: '市场养生师',
        store_id: null,
        position_name: '养生师',
        skills: ['养生师'],
        is_on_business_trip: true,
        store_name: null,
        department_name: '养生部',
        market_name: '南昌凤御',
        assignment_scope: 'same_market_trip',
      },
    ])

    const result = await getServiceStaffCandidates('store-A')

    expect(result.map((r) => [r.employeeId, r.assignmentScope])).toEqual([
      ['EMP-LOCAL', 'local'],
      ['EMP-TRIP', 'same_market_trip'],
    ])
    // store_id 为空的直挂节点员工照样带出锚定市场（旧的客户端过滤做不到）
    expect(result[1]).toMatchObject({ storeId: null, marketName: '南昌凤御' })
    expect(result[0]).not.toHaveProperty('phone')
    expect(result[0]).not.toHaveProperty('idCard')
    expect(isInScope).toHaveBeenCalledWith(expect.anything(), 'store-A')
  })

  it('门店不在 scope 内直接拒绝，不查库', async () => {
    ;(isInScope as any).mockReturnValue(false)

    await expect(getServiceStaffCandidates('store-X')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('缺少 targetStoreId 直接拒绝', async () => {
    await expect(getServiceStaffCandidates('')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('技能白名单四项按固定顺序传入查询（顺序即排序优先级）', async () => {
    ;(db.execute as any).mockResolvedValue([])

    await getServiceStaffCandidates('store-A')

    expect(sql.param).toHaveBeenCalledWith(['店经理', '美容师', '养生师', '品项老师'])
  })
})

// ── exportEmployees — 导出 + 技能标签服务端兜底 ──────────────────────────────────

describe('exportEmployees — 导出 + 技能标签服务端兜底（对称列表 page.tsx）', () => {
  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  /**
   * mock 单次 db.select → exportEmployees 员工数据查询链路：
   * select → from → leftJoin → where → orderBy
   */
  function mockExportChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {})
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
    ;(getSkillTags as any).mockResolvedValue([
      { id: 'tag-1', name: '护理' },
      { id: 'tag-2', name: '美容师' },
    ])
  })

  it('无 skills 筛选 → 返回 rows + truncated=false，getSkillTags 被调一次（防御层始终启用）', async () => {
    mockExportChain([])

    const result = await exportEmployees({})

    expect(result.rows).toEqual([])
    expect(result.truncated).toBe(false)
    // 不传 skill 也会跑服务端兜底（与列表对称），保证逻辑不漂移
    expect(getSkillTags).toHaveBeenCalledTimes(1)
    expect((sql as any).join).not.toHaveBeenCalled()
  })

  it('skills 全字典内 → 原样传入 buildEmployeeConditions（sql.join 含全部标签）', async () => {
    mockExportChain([])

    await exportEmployees({ skill: '护理,美容师' })

    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '护理'] },
        { type: 'sql', args: [expect.anything(), '美容师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills 含字典外标签 → 服务端兜底剔除（防幽灵筛选，对称列表 page.tsx）', async () => {
    mockExportChain([])

    // URL 残留字典外的"旧标签"（已删除，前端 handleExport 漏清洗场景）
    await exportEmployees({ skill: '护理,旧标签,美容师' })

    // sql.join 仅含字典内标签（护理、美容师），字典外"旧标签"被剔除
    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '护理'] },
        { type: 'sql', args: [expect.anything(), '美容师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills 全字典外 → sql.join 不被调用（清洗后为 undefined → no-op，列表不被静默收窄）', async () => {
    mockExportChain([])

    await exportEmployees({ skill: '旧标签' })

    // 全字典外 → filterValidSkillValues 返回 undefined → buildEmployeeConditions 跳过 skills 条件
    expect((sql as any).join).not.toHaveBeenCalled()
  })

  it('字段映射：hiredAt 原样透传（date 列，格式化在 registry 列 map），未填入职日期为 null', async () => {
    // prod 实测 338 名员工里 248 个不同入职日、仅 3 个为空、28 个等于建档日兜底值 —— 即
    // hired_at 是真实维护过的数据。空值是少数情形但必须留空，不能补今天或建档日充数。
    mockExportChain([
      {
        staff_wechat_users: {
          employeeId: 'FY-00001', name: '张美容', gender: '女', phone: '13800000001',
          idCard: '360102199001011234', orgNodeId: 'node-1', positionName: '美容师',
          hiredAt: '2024-03-01', birthday: '1990-01-01', skills: ['护理'],
          socialInsurance: true, isResigned: false, resignationReason: null,
        },
        stores: { storeName: '南昌店' },
      },
      {
        staff_wechat_users: {
          employeeId: 'FY-00002', name: '李未填', gender: null, phone: null,
          idCard: null, orgNodeId: null, positionName: null,
          hiredAt: null, birthday: null, skills: null,
          socialInsurance: false, isResigned: false, resignationReason: null,
        },
        stores: null,
      },
    ])

    const { rows } = await exportEmployees({})

    expect(rows[0]).toMatchObject({
      employeeId: 'FY-00001', name: '张美容', storeName: '南昌店',
      positionName: '美容师', hiredAt: '2024-03-01', birthday: '1990-01-01',
    })
    expect(rows[1].hiredAt).toBeNull()
  })

  it('keyset 分页：按 employee_id 升序 + 游标 gt，不再用可变的 updated_at 排序（否则漏行/重行）', async () => {
    const mkRow = (id: string) => ({
      staff_wechat_users: {
        employeeId: id, name: `员工${id}`, gender: null, phone: null, idCard: null,
        orgNodeId: null, positionName: null, hiredAt: null, birthday: null, skills: null,
        socialInsurance: false, isResigned: false, resignationReason: null,
      },
      stores: null,
    })
    const fetched = [mkRow('FY-00001'), mkRow('FY-00002'), mkRow('FY-00003')]
    const chain: any = Object.assign(Promise.resolve(fetched), {})
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(fetched)
    ;(db.select as any).mockReturnValue(chain)

    const result = await exportEmployees({}, { limit: 2, cursor: 'FY-00000' })

    expect(chain.limit).toHaveBeenCalledWith(3) // limit + 1 探测行
    expect(result.rows).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    // 游标是本页最后一行的员工编号，不是被切掉的探测行
    expect(result.nextCursor).toBe('FY-00002')
    // 不能只断言 gt 被调用过：算了条件却忘了拼进 whereClause 时，固定返回数据的 mock 照样会绿
    expect(gt).toHaveBeenCalledWith('employee_id', 'FY-00000')
    expect(chain.where).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'and',
        args: expect.arrayContaining([{ type: 'gt', col: 'employee_id', val: 'FY-00000' }]),
      }),
    )
    // 排序键只能是 employee_id：updated_at 会被员工每次小程序登录写新值，
    // 行在页间移位就会造成一行重复 + 一行永久漏掉
    expect(chain.orderBy).toHaveBeenCalledWith({ type: 'asc', col: 'employee_id' })
    expect(chain.orderBy).toHaveBeenCalledTimes(1)
  })

  it('keyset 游标是空串/非字符串 → 抛 INVALID_STATE，且在打库之前就拦住', async () => {
    mockExportChain([])

    await expect(exportEmployees({}, { limit: 2, cursor: '' as any })).rejects.toThrow('导出分页游标无效')
    await expect(exportEmployees({}, { limit: 2, cursor: 123 as any })).rejects.toThrow('导出分页游标无效')
    // 畸形游标不该先白打一次 getSkillTags 的库
    expect(getSkillTags).not.toHaveBeenCalled()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('超过旧上限也返回全量且不标记截断', async () => {
    const overflow = Array.from({ length: 10001 }, (_, i) => ({
      staff_wechat_users: {
        employeeId: `FY-${String(i).padStart(5, '0')}`,
        name: `员工${i}`,
        gender: null,
        phone: null,
        idCard: null,
        orgNodeId: null,
        skills: null,
        positionName: null,
        birthday: null,
        socialInsurance: false,
        isResigned: false,
        resignationReason: null,
      },
      stores: null,
    }))
    mockExportChain(overflow)

    const result = await exportEmployees({})

    expect(result.truncated).toBe(false)
    expect(result.rows).toHaveLength(10001)
  })
})
