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

/** 按 actions/auth.ts 的真实产出形状构造 session（roles + 展开后的两个 scope 集合） */
function session(over: {
  role: string
  scopeType: '总部' | '市场' | '门店'
  scopeId: string
  scopeStoreIds: string[]
  scopeOrgNodeIds?: string[]
}): AuthSession {
  return {
    employeeId: 'OP-001',
    name: '操作者',
    phone: '13800000000',
    roles: [{ role: over.role, scopeId: over.scopeId, scopeType: over.scopeType }],
    permissions: {
      actions: ['employee:create', 'employee:update'],
      scopeStoreIds: over.scopeStoreIds,
      scopeOrgNodeIds: over.scopeOrgNodeIds ?? [],
    },
  } as AuthSession
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
