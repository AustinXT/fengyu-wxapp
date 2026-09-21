/**
 * #228 组合层用例：`updateEmployee` / `createEmployee` × **真实的** scope 判据。
 *
 * 为什么单独开一个文件：`employees.test.ts` 把 `@/lib/permissions` 整体 mock 成
 * `isInScope: () => true` 之类，于是那边测到的只是「判据返回 false 时 action 会 return」——
 * 「admin 不受限」这条验收标准（靠 `isAdminScope` 在判据内部短路）以及
 * 「`withPermission` 传下来的 session 形状能被判据正确消费」在那里结构上测不到。
 *
 * 这里只 mock 数据访问层（`@/db` + schema 列对象 + 审计日志），
 * **`@/lib/permissions` 用真实实现**，session 按 `actions/auth.ts` 的真实产出形状构造。
 */
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
    employeeId: 'employee_id', phone: 'phone', name: 'name', gender: 'gender',
    idCard: 'id_card', storeId: 'store_id', orgNodeId: 'org_node_id',
    positionName: 'position_name', birthday: 'birthday', skills: 'skills',
    isResigned: 'is_resigned', createdAt: 'created_at', updatedAt: 'updated_at',
  },
}))
vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name', type: 'type', sortOrder: 'sort_order', parentId: 'parent_id' },
}))
vi.mock('@db/permission', () => ({
  permissionRoles: { id: 'id', employeeId: 'employee_id', role: 'role', scopeId: 'scope_id', updatedBy: 'updated_by' },
}))
vi.mock('@db/admin-auth', () => ({ adminPasswords: { employeeId: 'employee_id' } }))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn(), logTransition: vi.fn() }))
vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn().mockResolvedValue(5),
  isAdminEmployee: vi.fn().mockResolvedValue(false),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/actions/skill-tags', () => ({ getSkillTags: vi.fn() }))

// ⚠️ 刻意不 mock '@/lib/permissions' —— 本文件的全部价值就在于用它的真实实现。

import { createEmployee, updateEmployee } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import type { AuthSession } from '@/lib/types'

/**
 * 按 actions/auth.ts 的真实产出形状构造 session。
 *
 * ⚠️ 每条 role 上的 `actions` / `scopeStoreIds` / `scopeOrgNodeIds` **必须齐全**：
 * `scopeSessionToActions`（withPermission 内部）只有在三者都是数组时才走严格收紧路径，
 * 缺任何一个就整段退回旧会话兼容分支、原样返回顶层 scope —— 那样「多角色账号不得跨角色
 * 串用 scope」这条接缝就完全没被测到（codex 谱系指出）。
 */
type RoleSpec = {
  role: string
  scopeType: '总部' | '市场' | '门店'
  scopeId: string
  actions: string[]
  scopeStoreIds: string[]
  scopeOrgNodeIds: string[]
}

function sessionOf(...roles: RoleSpec[]): AuthSession {
  return {
    employeeId: 'OP-001',
    name: '操作者',
    phone: '13800000000',
    roles: roles.map((r) => ({
      role: r.role, scopeId: r.scopeId, scopeType: r.scopeType,
      actions: r.actions, scopeStoreIds: r.scopeStoreIds, scopeOrgNodeIds: r.scopeOrgNodeIds,
    })),
    permissions: {
      actions: Array.from(new Set(roles.flatMap((r) => r.actions))),
      scopeStoreIds: Array.from(new Set(roles.flatMap((r) => r.scopeStoreIds))),
      scopeOrgNodeIds: Array.from(new Set(roles.flatMap((r) => r.scopeOrgNodeIds))),
    },
  } as AuthSession
}

const EMPLOYEE_ACTIONS = ['employee:create', 'employee:update']

function session(over: {
  role: string
  scopeType: '总部' | '市场' | '门店'
  scopeId: string
  scopeStoreIds: string[]
  scopeOrgNodeIds?: string[]
}): AuthSession {
  return sessionOf({
    role: over.role, scopeType: over.scopeType, scopeId: over.scopeId,
    actions: EMPLOYEE_ACTIONS,
    scopeStoreIds: over.scopeStoreIds,
    scopeOrgNodeIds: over.scopeOrgNodeIds ?? [],
  })
}

const STORE_MANAGER = session({
  role: 'manager', scopeType: '门店', scopeId: 'org-s1',
  scopeStoreIds: ['S001'], scopeOrgNodeIds: ['org-s1'],
})
const MARKET_MANAGER = session({
  role: 'manager', scopeType: '市场', scopeId: 'm1',
  scopeStoreIds: ['S001', 'S002'], scopeOrgNodeIds: ['m1', 'org-s1', 'org-s2'],
})
/** admin：scope 集合**故意留空**，验证 isAdminScope 短路而非靠集合命中 */
const ADMIN = session({
  role: 'admin', scopeType: '总部', scopeId: 'hq',
  scopeStoreIds: [], scopeOrgNodeIds: [],
})

function mockCurrentEmployee(row: Record<string, unknown>) {
  let call = 0
  ;(db.select as any).mockImplementation(() => {
    call++
    const current = call
    const limit = vi.fn().mockImplementation(() => Promise.resolve(current === 1 ? [row] : []))
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    return { from }
  })
}

function mockUpdateOk() {
  const where = vi.fn().mockResolvedValue({ count: 1 })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
  return { set }
}

function mockSelectEmpty() {
  const limit = vi.fn().mockResolvedValue([])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
}

function mockTransactionOk(employeeId = 'FY-260315001') {
  ;(db.transaction as any).mockImplementation(async (fn: any) =>
    fn({
      execute: vi.fn().mockResolvedValue([{ id: employeeId }]),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
    }),
  )
}

describe('#228 组合层 — updateEmployee × 真实 scope 判据', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('门店 manager 把本店员工调到 scope 外门店 → 被真实判据拒绝，零写入', async () => {
    ;(getSession as any).mockResolvedValue(STORE_MANAGER)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S999' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('门店 manager 把员工挂到 scope 外组织节点 → 被真实判据拒绝', async () => {
    ;(getSession as any).mockResolvedValue(STORE_MANAGER)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { orgNodeId: 'm9' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
    expect(db.update).not.toHaveBeenCalled()
  })

  /** AC5：市场级 manager 的 scopeStoreIds 由 expandRoleScope 展开为辖下全部门店 */
  it('市场 manager 在本市场两家门店之间调动 → 放行', async () => {
    ;(getSession as any).mockResolvedValue(MARKET_MANAGER)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S002' })

    expect(result.success).toBe(true)
  })

  it('市场 manager 调到另一市场的门店 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(MARKET_MANAGER)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S777' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
  })

  /**
   * AC3：admin 不受限。注意 ADMIN 的 scopeStoreIds / scopeOrgNodeIds 都是空数组 ——
   * 若哪天 isInScope / isOrgNodeInScope 丢掉 isAdminScope 短路而改为纯集合判断，本例立刻变红。
   */
  it('admin 调到任意门店 + 任意组织节点 → 放行（靠 isAdminScope 短路，不是靠集合命中）', async () => {
    ;(getSession as any).mockResolvedValue(ADMIN)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S999', orgNodeId: 'whatever' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalled()
  })

  it('admin 把归属两端清空 → 放行；同一操作换门店 manager → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(ADMIN)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()
    await expect(updateEmployee('FY-001', { storeId: null, orgNodeId: null }))
      .resolves.toMatchObject({ success: true })

    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(STORE_MANAGER)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()
    await expect(updateEmployee('FY-001', { storeId: null, orgNodeId: null }))
      .resolves.toMatchObject({ success: false, message: '员工必须归属门店或组织节点之一' })
  })
})

/**
 * codex 谱系 P3：多角色账号的 scope 不得跨角色串用。
 *
 * `withPermission('employee:update', ...)` 会先跑 `scopeSessionToActions` 把 session 收紧到
 * **持有该动作的那些角色**。若某个不持 `employee:update` 的第二角色把别的门店带进顶层 scope，
 * 收紧后它必须消失 —— 否则「用 A 角色的动作 + B 角色的范围」就能越权。
 */
describe('#228 组合层 — 多角色 scope 收紧（不得跨角色串用）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const MIXED = sessionOf(
    {
      role: 'hr', scopeType: '门店', scopeId: 'org-s1',
      actions: ['employee:create', 'employee:update'],
      scopeStoreIds: ['S001'], scopeOrgNodeIds: ['org-s1'],
    },
    {
      // 第二角色能看见 S002，但**不持** employee:update
      role: 'customer_mgr', scopeType: '门店', scopeId: 'org-s2',
      actions: ['customer:list'],
      scopeStoreIds: ['S002'], scopeOrgNodeIds: ['org-s2'],
    },
  )

  it('调到「只有另一个无权角色才看得见」的门店 → 拒绝', async () => {
    ;(getSession as any).mockResolvedValue(MIXED)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S002' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('调到持有该动作的角色自己的门店 → 放行', async () => {
    ;(getSession as any).mockResolvedValue(MIXED)
    mockCurrentEmployee({ storeId: null, orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'S001' })

    expect(result.success).toBe(true)
  })

  it('组织节点维度同样收紧：另一角色的 org 节点不可用', async () => {
    ;(getSession as any).mockResolvedValue(MIXED)
    mockCurrentEmployee({ storeId: 'S001', orgNodeId: 'org-s1' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { orgNodeId: 'org-s2' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
  })
})

describe('#228 组合层 — createEmployee × 真实 scope 判据', () => {
  const BASE = { name: '张三', phone: '13812345678', idCard: '110101199003078888' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSelectEmpty()
    mockTransactionOk()
  })

  it('门店 manager 在 scope 外组织节点建员工 → 拒绝，不进事务', async () => {
    ;(getSession as any).mockResolvedValue(STORE_MANAGER)

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: 'm9' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权在该组织节点下创建员工')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('门店 manager 在本店 + 本店节点建员工 → 成功', async () => {
    ;(getSession as any).mockResolvedValue(STORE_MANAGER)

    const result = await createEmployee({ ...BASE, storeId: 'S001', orgNodeId: 'org-s1' })

    expect(result.success).toBe(true)
  })

  it('admin 在任意组织节点建员工 → 成功（scope 集合为空仍放行）', async () => {
    ;(getSession as any).mockResolvedValue(ADMIN)

    const result = await createEmployee({ ...BASE, storeId: 'S999', orgNodeId: 'whatever' })

    expect(result.success).toBe(true)
  })
})
