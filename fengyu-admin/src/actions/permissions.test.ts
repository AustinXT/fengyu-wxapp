import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB and schema modules before importing the action
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn().mockResolvedValue([{}]),
    insert: vi.fn(),
    delete: vi.fn(),
    // revokeRole 的守卫 + DELETE + 审计走事务（#318）
    transaction: vi.fn(),
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
    // ⚠️ 刻意与 staffWechatUsers.employeeId 的 mock 值（'employee_id'）区分开。
    // 两表都写 'employee_id' 时，「被授权人查询用了正确谓词」那条断言会被
    // 紧随其后的 existing 重复检查（同样 eq(permissionRoles.employeeId, ...)）满足 →
    // 即使员工查询改成错列也恒真，断言锁不住任何东西（红检 T 实测）。
    employeeId: 'pr_employee_id',
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
import { inArray, eq } from 'drizzle-orm'
import { countActiveAdmins } from '@/lib/admin-guard'
import { hasPermission } from '@/lib/permissions'
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
/**
 * `assignRole` 的 select 序列：① 事务外读节点类型 ② 读被授权人 ③ 查重复绑定
 * ④ **锁内重读节点类型**（#318 第 4 轮：节点类型会被 updateOrgNode 改类型那条路径改掉）。
 *
 * `lockedNode` 默认与 `node` 同值；给不同值就能造出「事务外合法、锁内已被改成别的类型」。
 */
function mockAssignRoleSelects(
  opts: { node?: any; employee?: any; existing?: any; lockedNode?: any } = {},
) {
  const { node = { type: '市场' }, employee = VISIBLE_EMPLOYEE, existing = null } = opts
  const lockedNode = opts.lockedNode === undefined ? node : opts.lockedNode
  let call = 0
  ;(db.select as any).mockImplementation(() => {
    call++
    if (call === 1) return mockSelectOnce(node)()
    if (call === 2) return mockSelectOnce(employee)()
    if (call === 3) return mockSelectOnce(existing)()
    return mockSelectOnce(lockedNode)()
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

  /**
   * INSERT + 审计 + 锁内重读角色定义都在事务里了（#318 第 2 轮）。
   * tx 一律委托给全局 `db` 的桩，这样既有用例照旧 mock `db.insert` / `db.execute` 即可。
   * @returns 记录调用的 `txExecute`（断言取锁用）
   */
  function mockAssignTx() {
    const txExecute = vi.fn((...a: unknown[]) => (db as any).execute(...a))
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: txExecute,
      select: (...a: unknown[]) => (db as any).select(...a),
      insert: (...a: unknown[]) => (db as any).insert(...a),
    }))
    return { txExecute }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // ⚠️ clearAllMocks 不清 mockImplementation —— 上一条用例给 execute / hasPermission
    // 设的分派会泄漏到后面所有用例
    ;(db.execute as any).mockReset().mockResolvedValue([{}])
    ;(hasPermission as any).mockReset().mockReturnValue(true)
    mockAssignTx()
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

  /**
   * ## 分配侧的授权闸门也按**锁内**重读的定义判（#318 第 2 轮，与 revokeRole 对称）
   *
   * 只持 `permission:assign`（无 `assign_admin`）的人，趁「读定义」与 INSERT 之间角色被
   * `updateRoleDefinition` 升级成超管，就能把一个现已属超管的角色绑给别人。
   */
  it('事务外读到非超管、锁内读到超管 → 无 assign_admin 者被拒，不 INSERT', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(true)
    // 本文件把 hasPermission 整体桩成恒 true；这条用例要的正是「没有 assign_admin」
    ;(hasPermission as any).mockImplementation((_s: unknown, a: string) => a !== 'permission:assign_admin')
    mockAssignRoleSelects({ node: { type: '市场' }, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })
    // 按 SQL 内容分派：取锁那条也走 execute，用 Once 排队会被它吃掉一个
    let defReads = 0
    ;(db.execute as any).mockImplementation((arg: unknown) => {
      if (!JSON.stringify(arg).includes('permission_role_definitions')) return Promise.resolve([{}])
      defReads += 1
      return Promise.resolve([
        { role_key: 'role-x', name: 'X', is_super_admin: defReads > 1, allowed_scope_types: ['总部', '市场', '门店'] },
      ])
    })

    const result = await assignRole({ employeeId: 'EMP-X', role: 'role-x', scopeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权分配系统管理员角色')
    expect(values, '闸门没过就不该 INSERT').not.toHaveBeenCalled()
  })

  /** 分配也取那把锁 —— 它守的是「谁是活跃超管」，绑定与角色定义的超管位共同决定这个集合 */
  it('分配路径取 admin:active_count 锁（与另外三个入口同一把）', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({ node: { type: '总部' }, existing: null })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const t = mockAssignTx()

    await assignRole({ employeeId: 'EMP-X', role: 'admin', scopeId: 'hq-1' })

    const locks = t.txExecute.mock.calls.map((c) => JSON.stringify(c[0]))
    // 锁序 ① 组织树 → ② admin 计数（判的是「节点类型 ∈ 角色白名单」，两把都要）
    expect(locks[0]).toContain('org_nodes:reparent')
    expect(locks[1]).toContain('admin:active_count')
  })

  /**
   * 节点类型按**锁内**那次判（#318 第 4 轮 codex P1）：事务外读到「市场」（合法），
   * 锁内重读已被 `updateOrgNode` 改成「部门」—— 必须拒，否则留下一条 DB trigger 在
   * INSERT 时点本该拒掉的绑定。
   */
  it('事务外节点是市场、锁内已被改成部门 → 拒绝且不 INSERT', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({ node: { type: '市场' }, lockedNode: { type: '部门' }, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-X', role: 'manager', scopeId: 'node-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不能绑定到部门节点')
    expect(values).not.toHaveBeenCalled()
  })

  it('锁内重读发现节点已被删除 → 拒绝且不 INSERT', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    mockAssignRoleSelects({ node: { type: '市场' }, lockedNode: null, existing: null })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await assignRole({ employeeId: 'EMP-X', role: 'manager', scopeId: 'node-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('组织节点不存在')
    expect(values).not.toHaveBeenCalled()
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

  it('被授权人查询的谓词必须是 employee_id = 请求值（防 where 被改空/改错列）', async () => {
    // codex 谱系指出：mockAssignRoleSelects 按「第几次查询」返回，
    // 谓词改成 .where(undefined) 或错列时测试依然全绿，而生产里
    // FK 只保证「提交的 ID 真实存在」，不保证它就是被校验的那一个。
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects()
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    await assignRole({ employeeId: 'EMP-TARGET', role: 'manager', scopeId: 'market-1' })

    expect(eq).toHaveBeenCalledWith('employee_id', 'EMP-TARGET')
  })

  it('created_by 式的 FK 23503（约束名含 employee_id 但引用列不是它）→ 照旧抛出', async () => {
    // 判据用前缀而非裸 includes('employee_id')：将来若新增
    // created_by → staff_wechat_users.employee_id 的 FK，其约束名同样含该子串。
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(false)
    mockAssignRoleSelects()
    const fkError = Object.assign(new Error('violates foreign key constraint'), {
      code: '23503',
      constraint_name: 'permission_roles_created_by_staff_wechat_users_employee_id_fk',
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(fkError) })

    await expect(
      assignRole({ employeeId: 'EMP-Y', role: 'manager', scopeId: 'market-1' }),
    ).rejects.toThrow('violates foreign key constraint')
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
    // ⚠️ clearAllMocks 不清 mockImplementation —— 双快照那条用例设的分派会泄漏
    ;(db.execute as any).mockReset().mockResolvedValue([{}])
  })

  /**
   * 撤销走事务了（#318）：守卫 + DELETE + 审计整体在一个事务内，并与 employees 侧共用
   * 那把 `admin:active_count` advisory lock。所以 tx 上要有 `execute`（取锁）、
   * `select`（`countActiveAdmins` 传 tx）、`delete`、`insert`（审计）。
   *
   * @returns `tx()` 交出句柄 —— 审计的 executor 断言要用**同一性**，
   *   形状匹配对全局 `db` 也成立（#249/#259 那轮的教训）。
   */
  function setupRevokeDbCalls(target: any, deleteRowCount = 1) {
    ;(db.select as any).mockImplementation(() => mockSelectOnce(target)())
    const where = vi.fn().mockResolvedValue({ count: deleteRowCount })
    ;(db.delete as any).mockReturnValue({ where })
    let handedTx: any
    /**
     * ⚠️ 委托给全局 `db.execute`（工厂里默认 `[{}]`）而不是自己 resolve `[]` ——
     * 锁内要用 `tx.execute` **重读角色定义**（#318 第 2 轮），返回空数组会被当成
     * 「角色定义不存在」，于是每条用例都在一个假原因上失败。
     * 外面套一层 `vi.fn` 只为记录调用，便于断言取锁。
     */
    const txExecute = vi.fn((...a: unknown[]) => (db as any).execute(...a))
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      handedTx = {
        execute: txExecute,
        select: (db as any).select,
        delete: (db as any).delete,
        insert: (db as any).insert,
      }
      return fn(handedTx)
    })
    return { tx: () => handedTx, txExecute, deleteWhere: where }
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

  /**
   * ## 「先删再数」（#318）
   *
   * 判据是**删完之后** `countActiveAdmins === 0`，而不是删之前 `<= 1`。
   * 前一版那个判据过紧：目标已离职（本就不在计数里）或还持另一个超管角色时，
   * 删这条绑定一个活跃超管都不减，却会被拒 —— 离职残留绑定永远清不掉。
   *
   * 拒绝要回滚删除，所以走抛哨兵 + 外层 `.catch` 转文案（哨兵已登记进跨端 `TX_SENTINELS`）。
   * 断言因此是「返回 failure + 事务整体被回滚（对调用方而言就是没提交）+ 取过那把锁」。
   */
  it('删完发现零活跃 admin → 拒绝（回滚），且取过 advisory lock', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(0)
    const t = setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

    const result = await revokeRole(21)

    expect(result.success).toBe(false)
    expect(result.message).toBe('系统至少需保留 1 个活跃 admin')
    expect(JSON.stringify(t.txExecute.mock.calls[0][0]), 'DELETE 前必须先取锁')
      .toContain('pg_advisory_xact_lock')
    expect((countActiveAdmins as any).mock.calls[0][0], '计数必须走 tx').toBe(t.tx())
    expect(logOperation, '被回滚的撤销不该留审计').not.toHaveBeenCalled()
  })

  /**
   * 目标已离职 / 还持另一个超管角色 → 删这条**不减少**活跃超管数，必须放行。
   * 这两种情形合起来就是「删完还 ≥ 1」，用「先删再数」天然覆盖，不必枚举。
   */
  it('删完仍有活跃 admin（目标已离职或另持超管角色）→ 放行', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(1)
    const t = setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

    const result = await revokeRole(21)

    expect(result.success).toBe(true)
    expect(t.deleteWhere).toHaveBeenCalled()
  })

  /**
   * 与 employees 侧**同一把锁**（#318）—— 这条不变量的守卫散落在三个 action：
   * `updateEmployee` 标离职、`deleteEmployee` 物理删除、这里撤超管角色。
   * 前两个在 #249/#259 已收进锁，这里当时没跟上：并发「撤 A 的 admin」+「标 B 离职」
   * 会双双读到 count=2 → 零管理员。
   */
  it('撤超管角色取的是 admin:active_count 那把锁（与 employees 侧同一把）', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(5)
    const t = setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

    await revokeRole(23)

    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('admin:active_count')
  })

  /**
   * 锁**无条件**取（#318 第 2 轮）—— 「按事务外读到的 isSuperAdmin 决定要不要取锁」是个
   * 自指的死结：判据本身会被 `updateRoleDefinition` 并发改掉。所以撤普通角色也取锁，
   * 但**不查计数**（撤它确实不影响活跃 admin 数，白查一次没意义）。
   */
  it('撤销普通角色 → 仍取锁，但按锁内重读的定义判定后不查 admin 计数', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    const t = setupRevokeDbCalls({ role: 'manager', scopeId: 'market-1', employeeId: 'EMP-1' })

    const result = await revokeRole(24)

    expect(result.success).toBe(true)
    expect(JSON.stringify(t.txExecute.mock.calls[0][0]), '锁无条件先取')
      .toContain('admin:active_count')
    expect(countActiveAdmins, '非超管角色不必查计数').not.toHaveBeenCalled()
  })

  /**
   * ## 授权判据取的是**锁内**重读的 `is_super_admin`（两谱系第 2 轮共识的 P1）
   *
   * 击穿路径：T0 本请求读到角色 R 非超管 → T1 `updateRoleDefinition` 把 R 升级为超管
   * → T2 另一笔把唯一的另一名超管标离职（锁内看到「A 还持 R」所以放行）
   * → T3 本事务既不取锁也不数数地删掉 A 的 R 绑定 → 零活跃超管。
   * 这里用「事务外读到非超管、锁内读到超管」的双快照直接验判据用的是哪一份。
   */
  it('事务外读到非超管、锁内读到超管 → 按锁内那份判（非 admin 撤不动）', async () => {
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(hasRole as any).mockReturnValue(true)
    const t = setupRevokeDbCalls({ role: 'role-x', scopeId: 'market-1', employeeId: 'EMP-1' })
    /**
     * 按 SQL 内容分派，而不是 `mockResolvedValueOnce` 排队 —— 取锁那条也走 `execute`，
     * 会把队列里的值吃掉一个（第一版就是这么假绿的）。
     * 第 1 次读定义（事务外早拒）给非超管，第 2 次（锁内）给已升级成超管。
     */
    let defReads = 0
    ;(db.execute as any).mockImplementation((arg: unknown) => {
      if (!JSON.stringify(arg).includes('permission_role_definitions')) return Promise.resolve([{}])
      defReads += 1
      return Promise.resolve([
        { role_key: 'role-x', name: 'X', is_super_admin: defReads > 1 },
      ])
    })

    const result = await revokeRole(25)

    expect(result.success, '锁内已是超管 → hr 撤不动').toBe(false)
    expect(result.message).toContain('只有系统管理员')
    expect(t.deleteWhere, '判据没过就不该删').not.toHaveBeenCalled()
  })

  it('倒数第二 admin (count=2) 跨员工撤销 → 成功 + logOperation detail 含 employeeId/scopeId', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(hasRole as any).mockReturnValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(2)
    const revokeTx = setupRevokeDbCalls({ role: 'admin', scopeId: 'hq-1', employeeId: 'ADMIN-002' })

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
      // 第 6 参是 executor —— 审计与 DELETE 必须同生共死，用**同一性**断言（形状匹配对 db 也成立）
      revokeTx.tx(),
    )
  })
})
