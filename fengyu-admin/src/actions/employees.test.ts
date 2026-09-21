import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  isOrgNodeInScope: vi.fn(() => true),
  // 默认 false = 非 admin：本文件演的全是「受 scope 限制的角色」。
  // admin 短路语义在此测不到（判据被整体 mock），见 employees.scope-integration.test.ts。
  isAdminScope: vi.fn(() => false),
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
import { isInScope, isOrgNodeInScope, isAdminScope } from '@/lib/permissions'
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

/**
 * updateEmployee 的第 1 次 select = 读旧员工行。#228 之后「查不到」与「不可见」合并成了
 * 同一个立即返回分支（零写入），所以凡是期望流程走到 UPDATE 的用例都必须让这一次查到行。
 * 后续 select（手机号唯一性 / §AFF-03 的两次 org_node 查询）仍返回空。
 */
function mockSelectExistingEmployee(row: Record<string, unknown> = { storeId: 'store-A', orgNodeId: 'org-store-A' }) {
  let call = 0
  return vi.fn().mockImplementation(() => {
    call++
    const current = call
    const limit = vi.fn().mockImplementation(() => Promise.resolve(current === 1 ? [row] : []))
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    return { from }
  })
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
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
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

  /**
   * 手机号唯一性已不做事务外预查重（那是零写入探测信道），改由 DB 的
   * `uq_staff_users_phone` 约束 + 23505 转译承担 —— 所以这条现在**必须**进事务。
   */
  it('手机号已被使用 → DB 抛 23505 → 友好文案（不再事务外预查）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_staff_users_phone',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'store-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    // 冲突必须由真实写入触发 —— 这正是「不再有零写入探测」的体现
    expect(db.transaction).toHaveBeenCalled()
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
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
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
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: null })
    // phone=null 时跳过格式校验，直接进入 DB update
    expect(db.update).toHaveBeenCalled()
  })

  it('乐观锁冲突（rowCount=0）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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

  /**
   * ⚠️ 这条曾经变成过假阳性（codex 谱系第 3 轮发现）：当手机号查重排在读旧行**之前**时，
   * 第一次 select 就是查重，而 `mockSelectExistingEmployee` 恰好在第一次返回一行 ——
   * 于是函数提前返回「手机号已被使用」，mock 的 23505 根本不执行，删掉生产代码里的
   * 23505 catch 测试照样绿。查重移到可见性拦截之后就恢复了有效性，
   * 下面那条 `db.update` 断言是为了让这种失效下次能被直接看出来。
   */
  it('DB 唯一冲突（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(pgError) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    // 必须真的走到 UPDATE 才谈得上「DB 抛 23505」——否则这条测的是别的分支
    expect(db.update).toHaveBeenCalled()
  })

  it('正常更新 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
  })

  it('rowCount=0，无乐观锁 → 报告员工不存在或无权（不再静默成功）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(isAdminEmployee as any).mockResolvedValueOnce(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(1)

    await expect(
      updateEmployee('FY-001', { isResigned: true }),
    ).rejects.toThrow(/INVALID_STATE: 该员工是系统最后一个活跃 admin/)

    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('isResigned=true admin 但 count=2 → 成功离职 + 角色清理', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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

// ── #228 员工归属变更的 scope 校验 ───────────────────────────────────────────

/**
 * 唯一的生产调用方 `employee-detail-page.tsx:181-196` **永远**整表回传 15 个字段
 * 并携带 `expectedUpdatedAt`。早先这组用例全是 `updateEmployee('FY-001', { storeId })`
 * 两参极简调用 —— 于是给守卫套一层 `if (expectedUpdatedAt === undefined)` 或
 * `if (data.positionName === undefined)` 就能让它在 100% 真实请求上失效而测试全绿。
 * 现在负例一律走 FULL_FORM + 乐观锁，正例保留极简形态覆盖别的调用形状。
 */
const FULL_FORM = {
  // idCard 必须给真值：`data.idCard !== undefined && !trim()` 会先一步拒「请输入身份证号」。
  // phone 保持 null（前端手机号为空时确实传 null），这样不触发多余的唯一性 select，
  // mockCurrentEmployee 的「第 1 次 select = 读旧值」假设才成立；带 phone 的形态另有一条用例。
  name: '张三', gender: '男', phone: null, idCard: '110101199003078888',
  storeId: 'store-A', orgNodeId: 'org-store-A', positionName: '美容师',
  avatarUrl: null, birthday: null, hiredAt: null,
  leaveStart: null, leaveEnd: null, isOnBusinessTrip: false,
  skills: null, socialInsurance: true,
} as const
const EXPECTED_AT = '2026-01-01T00:00:00.000Z'

/**
 * 判据按 id 区分，而不是整体 true / false。
 *
 * #228 的校验现在既看**新值**（能不能调过去）也看**旧值**（这行本来是否可见）——
 * 整体 mock 成 false 会把旧行一起判成不可见，用例就只能测到「员工不存在或无权修改」
 * 那条统一兜底，表达不出「旧值可见 + 新值越界」这个真正要锁的组合。
 */
const IN_SCOPE_STORES = new Set(['store-A', 'store-B'])
const IN_SCOPE_NODES = new Set(['org-store-A', 'org-store-B', 'dept-A', 'market-1'])
/** 取某个判据被问过的 id 列表（用于断言「除旧值外没问过别的」） */
function askedIds(fn: unknown): string[] {
  return ((fn as { mock: { calls: unknown[][] } }).mock.calls).map((c) => c[1] as string)
}
function applyScopeFixture() {
  ;(isInScope as any).mockImplementation((_s: unknown, id: string) => IN_SCOPE_STORES.has(id))
  ;(isOrgNodeInScope as any).mockImplementation((_s: unknown, id: string) => IN_SCOPE_NODES.has(id))
}

describe('updateEmployee — #228 归属变更必须落在 scope 内', () => {
  /**
   * `db.select` 第 1 次调用 = 读旧值（currentEmployee）。
   * 传了 `phone` 的用例会多一次「手机号唯一性」select 抢在前面，故 FULL_FORM 的 phone 恒为 null。
   */
  function mockCurrentEmployee(row: Record<string, unknown>) {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() =>
        Promise.resolve(current === 1 ? [row] : []),
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
  }

  function mockUpdateOk() {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
  })

  /**
   * 核心回归：断言**精确到本条修复的文案**，不写成「包含『无权』」的宽松匹配。
   *
   * ⚠️ #200 的教训：`updateEmployee` 里另有 `employeeScopeCondition` 拼进 UPDATE 的 WHERE，
   * 越权调店在真库里也可能因旧记录不在 scope 而命中 0 行、退化成「员工不存在或无权修改」。
   * 断言若放宽到「无权」二字，回退掉本条校验后测试会被那条兜底文案蒙混过关而依然全绿。
   * 同时断言 `db.update` 完全没被调用 —— 锁住「校验早于任何写入」。
   */
  it('storeId 改到 scope 外门店 → 拒绝（完整表单 + 乐观锁的真实调用形态），且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(isInScope).toHaveBeenCalledWith(mockSession, 'store-OTHER')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('orgNodeId 改到 scope 外组织节点 → 拒绝（完整表单 + 乐观锁），且零写入', async () => {
    mockCurrentEmployee({ storeId: null, orgNodeId: 'dept-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001',
      { ...FULL_FORM, storeId: null, orgNodeId: 'market-OTHER' },
      EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-OTHER')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 职能岗员工（store_id 为 NULL、靠 org_node_id 命中 scope）—— issue 点名的人群。
   * 早先零覆盖：给守卫加 `oldStoreId !== null` 前置条件即可让它对这批人整体失效而测试全绿。
   */
  it('职能岗员工（storeId 为 null）被调到 scope 外门店 → 仍拒绝', async () => {
    mockCurrentEmployee({ storeId: null, orgNodeId: 'dept-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER', orgNodeId: 'dept-A' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('storeId 合法但 orgNodeId 越界 → 仍被拒（两条校验都在，不是二选一）', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-B', orgNodeId: 'dept-OTHER' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
    expect(db.update).not.toHaveBeenCalled()
  })

  /** 越权调店常与「顺手标离职」等组合提交同批出现，守卫不得被其它字段的存在与否开关掉 */
  it('越权调店 + 同批标离职 → 仍拒绝，且离职清角色的事务也不执行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER', isResigned: true }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 同批改手机号会多一次「唯一性」select，把函数推进另一条分支序列。
   * 守卫不得因此被跳过（给它套 `if (data.phone === undefined)` 这类前置条件时本例变红）。
   *
   * 注意查重现在排在**可见性拦截之后**（它查全表，放在前面会变成「任意手机号是否注册」
   * 的探测器），所以 select 顺序是 1=旧员工行、2=手机号唯一性。
   */
  it('越权调店 + 同批改手机号（多一次 select）→ 仍拒绝', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() =>
        // 1=旧员工行 2=手机号唯一性（无冲突）
        Promise.resolve(current === 1 ? [{ storeId: 'store-A', orgNodeId: 'org-store-A' }] : []),
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001',
      { ...FULL_FORM, phone: '13900000001', storeId: 'store-OTHER' },
      EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * GLM 谱系第 2 轮：手机号查重查的是**全表**，排在可见性拦截之前就是又一个同构 oracle ——
   * 拿任意不可见/不存在的 employeeId 提交 `{ phone: X }`，X 被占用 → 「该手机号已被其他员工使用」，
   * 未被占用 → 「员工不存在或无权修改」，据此可枚举任意手机号是否注册为员工。
   */
  it('对不可见员工提交已被占用的手机号 → 仍返回统一文案，不泄露手机号是否已注册', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() =>
        current === 1
          ? Promise.resolve([{ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' }])  // 不可见的旧行
          : Promise.resolve([{ employeeId: 'FY-SOMEONE' }]),                          // 手机号确实被占用
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-OTHER', { ...FULL_FORM, phone: '13900000002' }, EXPECTED_AT,
    )

    expect(result.message).toBe('员工不存在或无权修改')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('storeId 改到 scope 内门店 → 放行，且 §AFF-03 的 permission_roles 同步照常发生', async () => {
    // 1=旧员工行 2=旧门店 org_node 3=新门店 org_node
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() => {
        if (current === 1) return Promise.resolve([{ storeId: 'store-A', orgNodeId: 'org-store-A' }])
        if (current === 2) return Promise.resolve([{ orgNodeId: 'org-store-A' }])
        if (current === 3) return Promise.resolve([{ orgNodeId: 'org-store-B' }])
        return Promise.resolve([])
      })
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 2 次：员工行 UPDATE + §AFF-03 的 permission_roles UPDATE。
    // 只断言 >=1 的话，把 scope 同步整段删掉测试照样绿（AC 第 2 条后半段就失锁了）。
    expect(db.update).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync', 'permission_role', 'FY-001',
      expect.objectContaining({ oldStoreId: 'store-A', newStoreId: 'store-B' }),
    )
  })

  /**
   * boundary-critic P1-2：§AFF-03 会越权改写 permission_roles。
   *
   * `employeeScopeCondition` 是 `store_id ∈ scope` **OR** `org_node_id ∈ scope` ——
   * 员工靠 org_node_id 命中即可被更新，此时它的 store_id 可以指向操作者看不见的门店。
   * 于是「把外店员工调进自己店」会执行
   * `UPDATE permission_roles SET scope_id=<我的店> WHERE scope_id=<外店>`：
   * 既剥夺了他对外店的角色、又授予了他对我店的角色，而操作者不持 permission:assign/revoke。
   */
  it('旧门店在 scope 外 → 员工归属照改，但 permission_roles 同步被跳过并留痕', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() => {
        // 旧 store 是 scope 外的 store-OUT，但 org_node 在 scope 内 → 行可见
        if (current === 1) return Promise.resolve([{ storeId: 'store-OUT', orgNodeId: 'org-store-A' }])
        if (current === 2) return Promise.resolve([{ orgNodeId: 'org-store-OUT' }])
        if (current === 3) return Promise.resolve([{ orgNodeId: 'org-store-A' }])
        return Promise.resolve([])
      })
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    // 只有员工行那一次 UPDATE；permission_roles 不许被动
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'old_store_out_of_scope', oldStoreId: 'store-OUT' }),
    )
  })

  /**
   * 边界①：编辑表单会把未改动的归属字段一并回传。对 no-op 提交报「无权」是纯误伤，
   * 所以新值校验只在 `next !== old` 时触发。
   *
   * 判据仍会被调用一次 —— 那是「旧行是否可见」那道（见下方信息 oracle 用例），
   * 所以这里断言的是**没有以任何新值去问过判据**，而不是「完全没调用」。
   */
  it('归属字段回传旧值（no-op 整表提交）→ 不对新值做 scope 校验，放行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { ...FULL_FORM }, EXPECTED_AT)

    expect(result.success).toBe(true)
    // 只可能以**旧值**被问过（可见性判定，且它是短路 OR —— store 命中后就不再问 org）。
    // 断言「除旧值外没问过别的」，不依赖短路顺序。
    expect(askedIds(isInScope).filter((id) => id !== 'store-A')).toEqual([])
    expect(askedIds(isOrgNodeInScope).filter((id) => id !== 'org-store-A')).toEqual([])
  })

  /**
   * 边界②：单端清空放行。市场级 manager 把门店员工转市场直属岗正是
   * 「storeId 清空 + orgNodeId 设为市场节点」—— 清空后仍靠 orgNodeId 可见。
   */
  it('storeId 置 null 且 orgNodeId 给 scope 内市场节点（转市场直属岗）→ 放行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: 'market-1' }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-1')
  })

  /**
   * 边界③：变更后必须仍可见。两端同时清空是最直白的一种 ——
   * 双空的行对所有非 admin 都不命中（含操作者自己 → 不可逆），而 permission_roles 一字不动，
   * 等于把一个仍持有效角色、仍能登录的账号从所有非 admin 名册里永久抹掉。
   */
  it('两端同时清空 → 拒绝，且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: null }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('员工必须归属门店或组织节点之一')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 边界③的另一半（GLM 谱系发现）：写成「两端不能都空」会漏掉这一整类 ——
   * 员工 `(storeId=本店, orgNodeId=外市场节点)` 靠 store 维度可见，单清 storeId 后
   * 另一端虽**非空**却在 scope 外，员工同样永久消失且不可逆。
   */
  it('单端清空后另一端在 scope 外 → 拒绝（非空也不行），且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-MX' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: 'org-MX' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('变更后该员工将不在你的管理范围内，请先转交给有权管理该归属的同事')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('admin 两端同时清空 → 放行（不受限）', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()
    ;(isAdminScope as any).mockReturnValue(true)

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: null }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
  })

  /**
   * codex 谱系 P2：「新旧值相同则跳过校验」会把响应差异变成**归属信息 oracle**。
   *
   * 拿 scope 外的员工编号反复提交不同的 storeId —— 猜错时返回「无权将员工调至该门店」，
   * 猜中其真实旧门店时因 `next === old` 跳过校验、最终由 UPDATE 命中 0 行返回
   * 「员工不存在或无权修改」。两句话的差异就能枚举出任意员工的真实归属。
   *
   * 修复是：旧行存在但不可见时立刻返回与「员工不存在」**完全相同**的一句话。
   * 下面两条断言的正是「猜中」与「猜错」不可区分。
   */
  /**
   * codex 谱系两轮追出来的信息泄露，最终形态是**三方等价**。
   *
   * 第 1 轮：「新旧值相同则跳过校验」把响应差异变成归属 oracle —— 拿 scope 外的员工编号
   * 反复提交不同 storeId，猜错返回「无权将员工调至该门店」、猜中其真实旧门店时跳过校验
   * 并最终由 UPDATE 命中 0 行返回「员工不存在或无权修改」，据此可枚举任意员工的真实归属。
   *
   * 第 2 轮：只拦「存在但不可见」还不够 —— 那只是把 oracle 换成「employeeId 是否存在」：
   * 不存在的记录会一路走到 UPDATE，带乐观锁时返回「数据已被其他人修改」、不带时返回
   * 「无权将员工调至该门店」，而且它多跑了一次 db.update（调用次数/耗时差异）。
   *
   * 所以这里断言三种输入的响应**逐字相同且都零写入**：
   * ① 员工不存在 ② 存在但不可见 + 猜错旧门店 ③ 存在但不可见 + 猜中旧门店。
   */
  it('不存在 / 不可见猜错 / 不可见猜中 → 三者响应逐字相同且均零写入（无信息泄露）', async () => {
    const probe = async (opts: { exists: boolean; guess: string | null }) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (opts.exists) {
        mockCurrentEmployee({ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      mockUpdateOk()
      const result = await updateEmployee(
        'FY-PROBE',
        { ...FULL_FORM, storeId: opts.guess, orgNodeId: 'org-SECRET' },
        EXPECTED_AT,
      )
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    const notFound = await probe({ exists: false, guess: 'store-GUESS' })
    const wrongGuess = await probe({ exists: true, guess: 'store-GUESS' })
    const rightGuess = await probe({ exists: true, guess: 'store-SECRET' })

    expect(wrongGuess.result).toEqual(notFound.result)
    expect(rightGuess.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    // 三条路径都不许触碰 db.update —— 否则调用次数/耗时本身就是信道
    expect([notFound.wrote, wrongGuess.wrote, rightGuess.wrote]).toEqual([0, 0, 0])
  })

  /** 不带乐观锁时同样三方等价（第 2 轮指出这是另一条可区分路径） */
  it('不带 expectedUpdatedAt 时，不存在与不可见仍然响应相同且零写入', async () => {
    const probe = async (exists: boolean) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (exists) {
        mockCurrentEmployee({ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      mockUpdateOk()
      const result = await updateEmployee('FY-PROBE', { storeId: 'store-OTHER' })
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    const notFound = await probe(false)
    const invisible = await probe(true)

    expect(invisible.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    expect([notFound.wrote, invisible.wrote]).toEqual([0, 0])
  })

  /**
   * codex 谱系第 3 轮给的更精确攻击：泄露的不只是「手机号是否注册」，而是
   * **手机号与员工编号的对应关系**。手机号查重带 `employee_id != $target`：
   *   - 拿一个**不存在**的 employeeId 提交手机号 P → 查重命中 P 的主人 → 「该手机号已被其他员工使用」
   *   - 拿 P 的**真正主人**（scope 外）的 employeeId 提交同一个 P → `!= 自己` 把该行排除 → 另一句话
   * 两句话的差异即可确认「P 属于哪个 employeeId」。查重移到可见性拦截之后后，两者同句。
   */
  it('同一手机号 × 不存在的编号 / 其真正主人的编号 → 响应逐字相同', async () => {
    const probe = async (targetId: string, oldRow: Record<string, unknown> | null) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      let call = 0
      ;(db.select as any).mockImplementation(() => {
        call++
        const current = call
        const limit = vi.fn().mockImplementation(() =>
          current === 1
            ? Promise.resolve(oldRow ? [oldRow] : [])
            // 查重：手机号确实被 scope 外的某人占用
            : Promise.resolve([{ employeeId: 'FY-OWNER' }]),
        )
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      })
      mockUpdateOk()
      const result = await updateEmployee(targetId, { ...FULL_FORM, phone: '13900000003' }, EXPECTED_AT)
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    // 不存在的编号
    const notFound = await probe('FY-NOPE', null)
    // 该手机号真正主人的编号（scope 外 → 不可见）
    const realOwner = await probe('FY-OWNER', { storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })

    expect(realOwner.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    expect([notFound.wrote, realOwner.wrote]).toEqual([0, 0])
  })

  /**
   * 连追五轮的终局：**手机号查重整体删除**，改由 DB 唯一约束 + 23505 转译承担。
   *
   * 每一轮的修复都"看起来完整"，下一轮都能找到同构变体：
   *   轮 3：查重在可见性前 → 任意 employeeId 可探测，且能确认「P 属于哪个 employeeId」
   *   轮 4：移到可见性后 → 可见员工 + 越界门店，两条路径都零写入
   *   轮 5：再移到归属校验后 → **仍有** 乐观锁命中 0 行、离职前 admin 守卫这些零写入失败路径可配对
   * 只要那次全表预查排在任何可能失败的步骤之前，就总能配出一对「零写入但响应不同」。
   *
   * 下面三组对照分别覆盖轮 3/4/5 的攻击形态，全部要求响应逐字相同且零写入。
   */
  it('手机号探测的三种配对（不可见 / 越界门店 / 乐观锁未命中）均无零写入信道', async () => {
    const probe = async (opts: {
      oldRow: Record<string, unknown> | null
      storeId: string | null
      updateCount: number
    }) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (opts.oldRow) {
        ;(db.select as any).mockImplementation(mockSelectExistingEmployee(opts.oldRow))
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      const where = vi.fn().mockResolvedValue({ count: opts.updateCount })
      ;(db.update as any).mockReturnValue({ set: vi.fn().mockReturnValue({ where }) })
      const result = await updateEmployee(
        'FY-PROBE',
        { ...FULL_FORM, phone: '13900000006', storeId: opts.storeId ?? undefined },
        EXPECTED_AT,
      )
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    // 轮 3 形态：目标不可见 —— 不管手机号占没占用都同一句话、零写入
    const invisible = await probe({
      oldRow: { storeId: 'store-SECRET', orgNodeId: 'org-SECRET' }, storeId: null, updateCount: 1,
    })
    expect(invisible.result.message).toBe('员工不存在或无权修改')
    expect(invisible.wrote).toBe(0)

    // 轮 4 形态：目标可见但门店越界 —— 拒绝发生在任何手机号相关查询之前
    const outOfScope = await probe({
      oldRow: { storeId: 'store-A', orgNodeId: 'org-store-A' }, storeId: 'store-OTHER', updateCount: 1,
    })
    expect(outOfScope.result.message).toBe('无权将员工调至该门店')
    expect(outOfScope.wrote).toBe(0)

    // 轮 5 形态：一路合法但乐观锁未命中 —— 这条**必须**真的发起 UPDATE
    // （手机号冲突与否现在都只能由这次 UPDATE 的结果体现，探测不再免费）
    const staleLock = await probe({
      oldRow: { storeId: 'store-A', orgNodeId: 'org-store-A' }, storeId: 'store-B', updateCount: 0,
    })
    expect(staleLock.result.message).toBe('数据已被其他人修改，请刷新后重试')
    expect(staleLock.wrote).toBe(1)
  })

  /** 源码里不得再出现事务外的全表手机号预查（防复发） */
  it('updateEmployee / createEmployee 都不再做事务外手机号预查重', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/actions/employees.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    // 特征是「以 phone 做**等值**条件」；`searchEmployees` 的列选择与 ilike 模糊搜索不算
    expect(src, '事务外的全表手机号等值预查又回来了 —— 它是零写入探测信道')
      .not.toMatch(/eq\(staffWechatUsers\.phone/)
  })

  /** 空串是「不填」而非「一个叫 '' 的门店」，与 createEmployee 的 truthiness 口径对齐 */
  it('storeId 传空串 → 按清空处理（不报无权），且写库值归一为 null', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: '', orgNodeId: 'org-store-A' }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
    expect(isInScope).not.toHaveBeenCalledWith(mockSession, '')
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ storeId: null }))
  })

  it('不涉及归属字段的编辑（改姓名）→ 不以任何新值询问判据', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(askedIds(isInScope).filter((id) => id !== 'store-A')).toEqual([])
    expect(askedIds(isOrgNodeInScope).filter((id) => id !== 'org-store-A')).toEqual([])
  })

  // admin 不受限（isInScope / isOrgNodeInScope 内部的 isAdminScope 短路）与真实 session 塑形
  // 由 employees.scope-integration.test.ts 覆盖 —— 本文件把这些判据整体 mock 掉了。
})

describe('createEmployee — #228 归属同样受 scope 约束', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
  })

  const BASE = { name: '张三', phone: '13812345678', idCard: '110101199003078888' }

  /**
   * `employeeScopeCondition` 是 store_id ∪ org_node_id 的 OR，只挡 storeId 等于没挡：
   * `{ storeId: null, orgNodeId: <别的市场节点> }` 能在他人 scope 里凭空造一条员工记录，
   * 目标市场的 manager 看得见也编辑得了，创建者自己反而看不见。
   */
  it('orgNodeId 不在 scope 内 → 拒绝，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: 'market-OTHER' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权在该组织节点下创建员工')
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-OTHER')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内但 orgNodeId 越界 → 仍拒绝（两条校验都在）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: 'dept-OTHER' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权在该组织节点下创建员工')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('两端都在 scope 内 → 正常创建', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: 'dept-A' })

    expect(result.success).toBe(true)
  })

  it('orgNodeId 为 null 但 storeId 在 scope 内 → 跳过组织节点校验，正常创建', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: null })

    expect(result.success).toBe(true)
    expect(isOrgNodeInScope).not.toHaveBeenCalled()
  })

  /**
   * 两个谱系独立命中的 P1：两条校验都以字段 truthy 为前提，双空时一条都不触发。
   * 普通 manager 提交空表单即可建出一条对**所有非 admin** 永不命中的员工记录 ——
   * 创建成功却立刻从自己名册消失，且此后任何非 admin 都无法修复（scopeCond 命中 0 行），
   * 而该手机号仍可被员工端 bindPhone 绑定。这是 updateEmployee 侧同一条不变量的 create 面。
   */
  it('两端都不填 → 非 admin 拒绝，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: null })

    expect(result.success).toBe(false)
    expect(result.message).toBe('员工必须归属门店或组织节点之一')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('两端都不填 + admin → 放行', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')
    ;(isAdminScope as any).mockReturnValue(true)

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: null })

    expect(result.success).toBe(true)
  })
})

describe('updateEmployee — §AFF-03 门店变更 scope 同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
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
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
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

  /**
   * codex 谱系第 4 轮 P3：既有 §AFF-03 用例都不传手机号。这条把「改手机号 + 调店」合法路径
   * 锁住（第 5 轮删掉事务外预查重后，查询序列从四次回落为三次）。
   */
  it('改手机号 + scope 内调店 → 员工更新、角色 scope 同步、审计日志三者都发生', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() => {
        // 预查重删除后回落为三次：旧员工行 → 旧门店 org_node → 新门店 org_node
        if (current === 1) return Promise.resolve([{ storeId: 'store-A', orgNodeId: 'org-store-A' }])
        if (current === 2) return Promise.resolve([{ orgNodeId: 'org-store-A' }])
        if (current === 3) return Promise.resolve([{ orgNodeId: 'org-store-B' }])
        return Promise.resolve([])
      })
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { phone: '13900000005', storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(2)   // 员工行 + permission_roles
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync', 'permission_role', 'FY-001',
      expect.objectContaining({ oldStoreId: 'store-A', newStoreId: 'store-B' }),
    )
    expect(logUpdate).toHaveBeenCalledTimes(1)
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
