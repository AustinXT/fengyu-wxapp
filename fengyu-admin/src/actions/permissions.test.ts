import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB and schema modules before importing the action
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
    scopeId: 'scope_id',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    updatedBy: 'updated_by',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { name: 'name', employeeId: 'employee_id' },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', type: 'type' },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn().mockResolvedValue(5),
  isAdminEmployee: vi.fn().mockResolvedValue(false),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), { raw: vi.fn((s: string) => s) }),
}))

import { getRoles, assignRole, revokeRole } from './permissions'
import { db } from '@/db'
import { getSession, hasRole } from '@/lib/auth'
import { inArray } from 'drizzle-orm'
import { countActiveAdmins } from '@/lib/admin-guard'
import { logOperation } from '@/lib/operation-log'

function makeRow(scopeId: string) {
  return {
    id: 1,
    employeeId: 'EMP-001',
    role: 'manager',
    scopeId,
    createdBy: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    employeeName: '张三',
    scopeName: '门店A',
  }
}

function setupDbSelect(returnValue: any[]) {
  const limit = vi.fn().mockResolvedValue(returnValue)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy })
  const leftJoin2 = vi.fn().mockReturnValue({ where })
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
  const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
  ;(db.select as any).mockReturnValue({ from })
  return { where }
}

describe('getRoles — scope filtering (AC-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin 用户：不加 scope 过滤，inArray 不被调用', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
    ;(hasRole as any).mockReturnValue(true)
    setupDbSelect([makeRow('store-1'), makeRow('store-2')])

    const result = await getRoles()

    expect(result).toHaveLength(2)
    expect(inArray).not.toHaveBeenCalled()
  })

  it('非 admin 用户：inArray 被调用，仅传入自身 scopeIds', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'store-42' }],
    })
    ;(hasRole as any).mockReturnValue(false)
    setupDbSelect([makeRow('store-42')])

    const result = await getRoles()

    expect(result).toHaveLength(1)
    expect(inArray).toHaveBeenCalledOnce()
    const [, scopeIds] = (inArray as any).mock.calls[0]
    expect(scopeIds).toEqual(['store-42'])
  })

  it('非 admin 用户 scopeIds 为空：直接返回空数组，不查 DB', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'EMP-002',
      roles: [],
    })
    ;(hasRole as any).mockReturnValue(false)

    const result = await getRoles()

    expect(result).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('返回结果字段映射正确（createdAt 转 ISO 字符串）', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
    ;(hasRole as any).mockReturnValue(true)
    setupDbSelect([makeRow('store-1')])

    const result = await getRoles()

    expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(result[0].updatedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(result[0].employeeName).toBe('张三')
    expect(result[0].scopeName).toBe('门店A')
  })

  // admin.sys.spec.md §5 默认排序：最近分配/修改的角色浮顶
  it('默认 orderBy 首键为 desc(updatedAt)，带 createdAt + id tiebreaker', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
    ;(hasRole as any).mockReturnValue(true)
    const limit = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn().mockReturnValue({ limit })
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin2 = vi.fn().mockReturnValue({ where })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    ;(db.select as any).mockReturnValue({ from })

    await getRoles()

    expect(orderBy).toHaveBeenCalledTimes(1)
    const args = orderBy.mock.calls[0]
    expect(args[0]).toMatchObject({ type: 'desc', col: 'updated_at' })
    expect(args[1]).toMatchObject({ type: 'desc', col: 'created_at' })
    expect(args[2]).toMatchObject({ type: 'desc', col: 'id' })
  })
})

// ── assignRole ──────────────────────────────────────────────────────────────

/** 为 select().from().where().limit() 链构建 mock，返回指定数据 */
function mockSelectLimit(returnValue: any[]) {
  const limit = vi.fn().mockResolvedValue(returnValue)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

/** 为 select().from().where().limit(1) 返回第一条记录 mock */
function mockSelectOnce(returnValue: any) {
  return mockSelectLimit(returnValue === null ? [] : [returnValue])
}

describe('assignRole — AC-09 & scope constraint', () => {
  const adminSession = {
    employeeId: 'ADMIN-001',
    roles: [{ role: 'admin', scopeId: 'hq-1' }],
    permissions: { actions: ['permission:assign_admin', 'permission:assign'] },
  }
  const hrSession = {
    employeeId: 'HR-001',
    roles: [{ role: 'hr', scopeId: 'market-1' }],
    permissions: { actions: ['permission:assign'] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin 分配 admin 角色到 headquarters 节点 → 成功', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)

    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return mockSelectOnce({ type: '总部' })() // HQ check
      return mockSelectOnce(null)() // no existing role
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-X', role: 'admin', scopeId: 'hq-1' })

    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('admin 分配 admin 角色到非 headquarters 节点 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)

    // HQ check 返回 market 类型
    ;(db.select as any).mockImplementation(() => mockSelectOnce({ type: '市场' })())

    const result = await assignRole({ employeeId: 'EMP-X', role: 'admin', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('总部')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('admin 分配 admin 角色到不存在的节点 → 抛 INVALID_PARAMS', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)

    ;(db.select as any).mockImplementation(() => mockSelectOnce(null)())

    await expect(
      assignRole({ employeeId: 'EMP-X', role: 'admin', scopeId: 'ghost-node' })
    ).rejects.toThrow(/INVALID_PARAMS: 组织节点不存在/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('hr 在自身 scope 内分配 manager 角色 → 成功', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false) // not admin

    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      // 第1次：node.type 校验（manager 允许市场）
      if (callCount === 1) return mockSelectOnce({ type: '市场' })()
      // 第2次：duplicate check
      return mockSelectOnce(null)()
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(true)
  })

  it('hr 分配超出自身 scope 的角色 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'other-market' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不能分配超出自身权限范围')
    expect(db.select).not.toHaveBeenCalled() // 提前返回
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('已存在相同角色时 → 拒绝重复分配', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)

    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return mockSelectOnce({ type: '市场' })() // node.type 校验通过
      return mockSelectOnce({ id: 99 })() // 重复
    })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已拥有相同的角色')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('并发唯一冲突（23505）→ 友好消息而非 500', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return mockSelectOnce({ type: '市场' })()
      return mockSelectOnce(null)()
    })

    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已拥有相同的角色和权限范围')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return mockSelectOnce({ type: '市场' })()
      return mockSelectOnce(null)()
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })

    await expect(
      assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })
    ).rejects.toThrow('connection lost')
  })

  // ── 新增 (audit-22 P0-22-01) role × scope.type 配对 ───────────────────────
  it('manager 分配到 部门 型 scope → 抛 INVALID_PARAMS', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(() => mockSelectOnce({ type: '部门' })())

    await expect(
      assignRole({ employeeId: 'EMP-Z', role: 'manager', scopeId: 'dept-1' })
    ).rejects.toThrow(/INVALID_PARAMS: 角色不能绑定到部门型 scope/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('hr 分配到 门店 型 scope → 抛 INVALID_PARAMS (hr 仅允许 总部/市场)', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(() => mockSelectOnce({ type: '门店' })())

    await expect(
      assignRole({ employeeId: 'EMP-Z', role: 'hr', scopeId: 'store-1' })
    ).rejects.toThrow(/INVALID_PARAMS: 角色 hr 不能绑定到 门店 型 scope/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('staff 分配到 市场 型 scope → 抛 INVALID_PARAMS (staff 仅允许 门店)', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(() => mockSelectOnce({ type: '市场' })())

    await expect(
      assignRole({ employeeId: 'EMP-Z', role: 'staff', scopeId: 'market-1' })
    ).rejects.toThrow(/INVALID_PARAMS: 角色 staff 不能绑定到 市场 型 scope/)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('manager 分配到 总部 型 scope → 成功 (manager 三 type 全允许)', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return mockSelectOnce({ type: '总部' })()
      return mockSelectOnce(null)()
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-Z', role: 'manager', scopeId: 'hq-1' })
    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('scopeId 不存在 (node=null) → 抛 INVALID_PARAMS', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(() => mockSelectOnce(null)())

    await expect(
      assignRole({ employeeId: 'EMP-Z', role: 'manager', scopeId: 'ghost-node' })
    ).rejects.toThrow(/INVALID_PARAMS: 组织节点不存在/)
    expect(db.insert).not.toHaveBeenCalled()
  })
})

describe('revokeRole — scope + admin-only for admin roles', () => {
  const adminSession = {
    employeeId: 'ADMIN-001',
    roles: [{ role: 'admin', scopeId: 'hq-1' }],
    permissions: { actions: ['permission:revoke'] },
  }
  const hrSession = {
    employeeId: 'HR-001',
    roles: [{ role: 'hr', scopeId: 'market-1' }],
    permissions: { actions: ['permission:revoke'] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setupRevokeDbCalls(target: any, deleteRowCount = 1) {
    ;(db.select as any).mockImplementation(() => mockSelectOnce(target)())
    const where = vi.fn().mockResolvedValue({ count: deleteRowCount })
    ;(db.delete as any).mockReturnValue({ where })
  }

  it('admin 撤销任意角色 → 成功', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    setupRevokeDbCalls({ role: 'manager', scopeId: 'market-1' })

    const result = await revokeRole(10)

    expect(result.success).toBe(true)
    expect(db.delete).toHaveBeenCalledOnce()
  })

  it('admin 撤销 admin 角色 → 成功（admin-only 规则允许）', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1' })

    const result = await revokeRole(20)

    expect(result.success).toBe(true)
  })

  it('非 admin 撤销 admin 角色 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1' })

    const result = await revokeRole(20)

    expect(result.success).toBe(false)
    expect(result.message).toContain('只有系统管理员')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('hr 撤销超出自身 scope 的角色 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    setupRevokeDbCalls({ role: 'manager', scopeId: 'other-market' })

    const result = await revokeRole(30)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不能撤销超出自身权限范围')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('角色不存在 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    setupRevokeDbCalls(null)

    const result = await revokeRole(99)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('deleteRowCount=0 → 报告不存在', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    setupRevokeDbCalls({ role: 'manager', scopeId: 'hq-1' }, 0)

    const result = await revokeRole(50)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('DB 异常 → 重新抛出', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(() => mockSelectOnce({ role: 'manager', scopeId: 'hq-1' })())
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    ;(db.delete as any).mockReturnValue({ where })

    await expect(revokeRole(52)).rejects.toThrow('connection lost')
  })

  // ── 新增 (audit-22 P0-22-03 / D-Q12-2026-04-26) admin 守卫 ───────────────────
  it('admin 撤销自己的 admin 角色 → 抛 INVALID_STATE (自删保护)', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-001' })

    await expect(revokeRole(20)).rejects.toThrow(/INVALID_STATE: 不能撤销自己的 admin 角色/)
    expect(db.delete).not.toHaveBeenCalled()
    expect(countActiveAdmins).not.toHaveBeenCalled()
  })

  it('撤销最后一个活跃 admin → 抛 INVALID_STATE', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(1)
    setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

    await expect(revokeRole(21)).rejects.toThrow(/INVALID_STATE: 系统至少需保留 1 个活跃 admin/)
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('倒数第二 admin (count=2) 跨员工撤销 → 成功 + logOperation detail 含 employeeId/scopeId', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(2)
    setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

    const result = await revokeRole(22)

    expect(result.success).toBe(true)
    expect(db.delete).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      adminSession,
      'permission.revoke',
      'permission_role',
      '22',
      expect.objectContaining({
        role: 'admin',
        scopeId: 'hq-1',
        employeeId: 'ADMIN-002',
      }),
    )
  })
})
