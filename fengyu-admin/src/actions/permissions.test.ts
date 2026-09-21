import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB and schema modules before importing the action
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn().mockResolvedValue([{}]),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoleDefinitions: {
    roleKey: 'role_key',
    name: 'role_name',
    canAccessAdmin: 'can_access_admin',
    isSuperAdmin: 'is_super_admin',
    isStoreManager: 'is_store_manager',
  },
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
  staffWechatUsers: {
    name: 'name', employeeId: 'employee_id',
    storeId: 'store_id', orgNodeId: 'org_node_id', isResigned: 'is_resigned',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name', type: 'type' },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(),
}))

// ⚠️ isEmployeeRowVisible 取**真实实现**（importActual），不 mock 成固定值。
// 它是 employeeScopeCondition 的内存版（#228 commit 6fa5b8dd 专门抽出做同源保障），
// 把它替换成假实现，assignRole 的可见性用例就变成在测 mock 而不是测 scope 口径。
// 它是纯函数（只读 session + 两个入参），唯一的外部依赖 isAdminScope 在其内部直接调用，
// 因此这里连同 isAdminScope 一起用真实实现，语义与生产一致。
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/permissions')>('@/lib/permissions')
  return {
    requirePermission: vi.fn(),
    requireAdmin: vi.fn(),
    requireAnyPermission: vi.fn(),
    hasPermission: vi.fn(() => true),
    isAdminScope: vi.fn((session: any) => session.roles.some((role: any) => (
      role.isSuperAdmin ?? role.role === 'admin'
    ))),
    isEmployeeRowVisible: actual.isEmployeeRowVisible,
  }
})

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
  const orderBy = vi.fn().mockResolvedValue(returnValue)
  const where = vi.fn().mockReturnValue({ orderBy })
  const leftJoin2 = vi.fn().mockReturnValue({ where })
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
  const innerJoin = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
  const from = vi.fn().mockReturnValue({ innerJoin })
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

  it('非 admin 用户：inArray 使用已展开的下属节点集合', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'market-42' }],
      permissions: {
        scopeOrgNodeIds: ['market-42', 'store-42', 'store-child-42'],
      },
    })
    ;(hasRole as any).mockReturnValue(false)
    setupDbSelect([makeRow('store-42'), makeRow('store-child-42')])

    const result = await getRoles()

    expect(result).toHaveLength(2)
    expect(inArray).toHaveBeenCalledOnce()
    const [, scopeIds] = (inArray as any).mock.calls[0]
    expect(scopeIds).toEqual(['market-42', 'store-42', 'store-child-42'])
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
    const orderBy = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin2 = vi.fn().mockReturnValue({ where })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const innerJoin = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    const from = vi.fn().mockReturnValue({ innerJoin })
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

/**
 * 对 adminSession 与 hrSession 都可见、且在职的被授权人。
 *
 * 刻意用 `storeId: null` + `orgNodeId` 命中 —— 这正是 `assignRole` 必须用
 * `isEmployeeRowVisible`（store ∪ orgNode）而不是 `isInScope`（仅 store）的原因：
 * 职能部门员工 `store_id IS NULL`，只按门店判会把他们整体挡在授权之外。
 * hrSession 也没有 `scopeStoreIds`，换成带 storeId 的员工会走进 `isInScope` 读到 undefined。
 */
const VISIBLE_EMPLOYEE = { storeId: null, orgNodeId: 'market-1', isResigned: false }

/**
 * `assignRole` 的 `db.select` 调用序列 —— #250 之后固定为三段：
 *   ① orgNodes 节点类型校验 → ② staff_wechat_users 被授权人校验 → ③ permission_roles 重复检查
 *
 * 既有用例原先写死「第 1 次是节点、其余都是重复检查」，插入第 ② 段后全部错位
 * （12 条一起变红）。统一收到这个 helper 里，下次再插入查询只改一处。
 */
function mockAssignRoleSelects(opts: { node?: any; employee?: any; existing?: any } = {}) {
  const { node = { type: '市场' }, employee = VISIBLE_EMPLOYEE, existing = null } = opts
  let call = 0
  ;(db.select as any).mockImplementation(() => {
    call++
    if (call === 1) return mockSelectOnce(node)()
    if (call === 2) return mockSelectOnce(employee)()
    return mockSelectOnce(existing)()
  })
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
    permissions: {
      actions: ['permission:assign'],
      // ⚠️ scopeStoreIds 是 AuthSession 的**必填**字段（types.ts:762），生产 session
      // 恒为数组。fixture 原先漏了它，导致「hr + 带 storeId 的员工」这条最常见的生产路径
      // 一测就在 isInScope 里 TypeError，只能另建 storeManagerSession 绕道。补齐后两条维度都可测。
      scopeStoreIds: ['store-fengyu', 'store-jincheng'],
      scopeOrgNodeIds: ['market-1', 'store-fengyu', 'store-jincheng'],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin 分配 admin 角色到 headquarters 节点 → 成功', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)

    mockAssignRoleSelects({ node: { type: '总部' }, existing: null })
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

    mockAssignRoleSelects({ node: { type: '市场' }, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(true)
  })

  it('hr 可向下属门店分配角色', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)

    mockAssignRoleSelects({ node: { type: '门店' }, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({
      employeeId: 'EMP-WU',
      role: 'manager',
      scopeId: 'store-jincheng',
    })

    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
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

    mockAssignRoleSelects({ node: { type: '市场' }, existing: { id: 99 } })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已拥有相同的角色')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('并发唯一冲突（23505）→ 友好消息而非 500', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({ node: { type: '市场' }, existing: null })

    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })

    const result = await assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已拥有相同的角色和权限范围')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({ node: { type: '市场' }, existing: null })
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

  it.each(['hr', 'finance', 'product', 'customer_mgr'])(
    '%s 分配到 门店 型 scope → 成功（非 admin 角色均允许门店 scope）',
    async (role) => {
      ;(getSession as any).mockResolvedValue(adminSession)
      ;(hasRole as any).mockReturnValue(true)

      mockAssignRoleSelects({ node: { type: '门店' }, existing: null })
      const values = vi.fn().mockResolvedValue({})
      ;(db.insert as any).mockReturnValue({ values })

      const result = await assignRole({ employeeId: 'EMP-Z', role, scopeId: 'store-1' })

      expect(result.success).toBe(true)
      expect(values).toHaveBeenCalledOnce()
    },
  )

  it('普通动态角色可分配到市场 scope', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({ node: { type: '市场' }, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-Z', role: 'staff', scopeId: 'market-1' })
    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('manager 分配到 总部 型 scope → 成功 (manager 三 type 全允许)', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({ node: { type: '总部' }, existing: null })
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

  // ── 被授权人（第二主体）校验（#250）──────────────────────────────────────
  // 此前只校验 data.scopeId，data.employeeId 完全不过闸。

  /** 绑单门店的 manager：用来走通 isEmployeeRowVisible 的 store 维度（hrSession 无 scopeStoreIds） */
  const storeManagerSession = {
    employeeId: 'MGR-001',
    roles: [{ role: 'manager', scopeId: 'store-fengyu' }],
    permissions: {
      actions: ['permission:assign'],
      scopeStoreIds: ['store-fengyu'],
      scopeOrgNodeIds: ['store-fengyu'],
    },
  }

  it('hr 分配给 scope 外的真实员工 → 拒绝，零写入', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: null, orgNodeId: 'other-market', isResigned: false },
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-N', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('分配给不存在的 employeeId → 友好文案，不落到 FK 23503 裸抛 500', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({ employee: null })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-GHOST', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('信息 oracle：不存在 / 存在但 scope 外 → 响应逐字相同、写入与查询次数都相同', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    mockAssignRoleSelects({ employee: null })
    const notFound = await assignRole({ employeeId: 'EMP-GHOST', role: 'manager', scopeId: 'market-1' })
    const selectsForNotFound = (db.select as any).mock.calls.length

    ;(db.select as any).mockClear()
    mockAssignRoleSelects({ employee: { storeId: null, orgNodeId: 'other-market', isResigned: false } })
    const outOfScope = await assignRole({ employeeId: 'EMP-REAL-N', role: 'manager', scopeId: 'market-1' })
    const selectsForOutOfScope = (db.select as any).mock.calls.length

    expect(notFound).toEqual(outOfScope)
    // 两条都必须停在第 ② 段：不能有一条多跑一次 existing 查询（调用次数本身是信道）
    expect(selectsForNotFound).toBe(2)
    expect(selectsForOutOfScope).toBe(2)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('校验前置于重复检查：scope 外员工 + 已有同角色 → 报「不在权限范围」而非「已拥有相同角色」', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: null, orgNodeId: 'other-market', isResigned: false },
      existing: { id: 99 },
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-N', role: 'manager', scopeId: 'market-1' })

    // 「该员工已拥有相同的角色和权限范围」对 scope 外员工同样是可探测的信道
    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
  })

  it('已离职员工 → 拒绝（判定排在可见性之后，专属文案）', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: null, orgNodeId: 'market-1', isResigned: true },
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-LEFT', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '该员工已离职，无法分配角色' })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('不可见 + 已离职 → 只报「不在权限范围」，不泄露其在职状态', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: null, orgNodeId: 'other-market', isResigned: true },
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-N-LEFT', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
  })

  it('职能部门员工（store_id IS NULL，靠 org_node_id 命中）→ 放行', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: null, orgNodeId: 'store-jincheng', isResigned: false },
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-DEPT', role: 'manager', scopeId: 'market-1' })

    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('store 维度：本店员工放行 / 他店员工拒绝', async () => {
    ;(getSession as any).mockResolvedValue(storeManagerSession)
    ;(hasRole as any).mockReturnValue(false)

    mockAssignRoleSelects({
      node: { type: '门店' },
      employee: { storeId: 'store-fengyu', orgNodeId: null, isResigned: false },
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })
    const own = await assignRole({ employeeId: 'EMP-OWN', role: 'manager', scopeId: 'store-fengyu' })
    expect(own.success).toBe(true)

    mockAssignRoleSelects({
      node: { type: '门店' },
      employee: { storeId: 'store-other', orgNodeId: null, isResigned: false },
    })
    const other = await assignRole({ employeeId: 'EMP-OTHER', role: 'manager', scopeId: 'store-fengyu' })
    expect(other).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
    expect(values).toHaveBeenCalledOnce() // 只有放行那次写了
  })

  it('admin → 任意员工放行（isEmployeeRowVisible 对 admin 短路）', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({
      node: { type: '总部' },
      employee: { storeId: 'store-anywhere', orgNodeId: 'any-node', isResigned: false },
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-ANY', role: 'manager', scopeId: 'hq-1' })

    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('并发删员工导致 employee_id FK 23503 → 友好文案，与前置校验逐字相同', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects()
    const fkError = Object.assign(new Error('violates foreign key constraint'), {
      code: '23503',
      constraint_name: 'permission_roles_employee_id_staff_wechat_users_employee_id_fk',
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(fkError) })

    const result = await assignRole({ employeeId: 'EMP-RACE', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
  })

  it('scope_id FK 23503（组织节点被并发删）→ 照旧抛出，不误报成「员工不存在」', async () => {
    // permission_roles 有三条 FK。只判 23503 不判约束名，会把「节点/角色定义被删」
    // 说成「员工不存在」—— 把响亮的 500 变成静默且主体错误的业务拒绝。
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects()
    const fkError = Object.assign(new Error('violates foreign key constraint'), {
      code: '23503',
      constraint_name: 'permission_roles_scope_id_org_nodes_id_fk',
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(fkError) })

    await expect(
      assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' }),
    ).rejects.toThrow('violates foreign key constraint')
  })

  it('hr + 带 storeId 的本市场门店员工 → 放行（store 维度，非 org 维度）', async () => {
    // hrSession 现已带 scopeStoreIds，这条生产上最常见的路径此前测不了
    // （fixture 缺该字段时 isInScope 会 TypeError，只能另建 storeManagerSession 绕道）
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      node: { type: '门店' },
      employee: { storeId: 'store-jincheng', orgNodeId: null, isResigned: false },
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-STORE', role: 'manager', scopeId: 'store-jincheng' })

    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledOnce()
  })

  it('hr + 他市场门店员工（store 维度）→ 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects({
      employee: { storeId: 'store-of-other-market', orgNodeId: null, isResigned: false },
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn() })

    const result = await assignRole({ employeeId: 'EMP-OTHER', role: 'manager', scopeId: 'market-1' })

    expect(result).toEqual({ success: false, message: '员工不存在或不在您的权限范围内' })
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
    permissions: {
      actions: ['permission:revoke'],
      scopeOrgNodeIds: ['market-1', 'store-fengyu', 'store-jincheng'],
    },
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

  it('hr 可撤销下属门店的角色', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    setupRevokeDbCalls({ role: 'manager', scopeId: 'store-jincheng', employeeId: 'EMP-WU' })

    const result = await revokeRole(31)

    expect(result.success).toBe(true)
    expect(db.delete).toHaveBeenCalledOnce()
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
