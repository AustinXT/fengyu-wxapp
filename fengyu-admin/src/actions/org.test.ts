import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    parentId: 'parent_id',
    sortOrder: 'sort_order',
    isActive: 'is_active',
    updatedAt: 'updated_at',
  },
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', orgNodeId: 'org_node_id' },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: { id: 'id', scopeId: 'scope_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { createOrgNode, updateOrgNode, deleteOrgNode } from './org'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['org:list', 'org:create', 'org:update', 'org:delete'], scopeStoreIds: [] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

function setupUpdate(rowCount: number) {
  const where = vi.fn().mockResolvedValue({ rowCount })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
}

// ── createOrgNode ─────────────────────────────────────────────────────────────

describe('createOrgNode — 输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无效节点类型 → 拒绝，不查 DB', async () => {
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: 'invalid' as any, parentId: null, sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无效的节点类型')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('父节点不存在 → 拒绝，不插入', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: 'market', parentId: 'nonexistent', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('父节点不存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('department 下不能再建 department → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'department' }]))
    const result = await createOrgNode({ id: 'n-1', name: '子部门', type: 'department', parentId: 'dept-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('部门不可嵌套')
  })

  it('store 下只能建 department → 拒绝非 department 类型', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'store' }]))
    const result = await createOrgNode({ id: 'n-1', name: '子市场', type: 'market', parentId: 'store-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店节点下只能创建部门')
  })

  it('节点编号重复（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'market' }]))
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: 'store', parentId: 'market-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('节点编号已存在')
  })

  it('父节点 FK 违反（23503）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'market' }]))
    const pgError = Object.assign(new Error('FK violation'), { code: '23503' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: 'store', parentId: 'market-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('父节点不存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'market' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createOrgNode({ id: 'n-1', name: '测试', type: 'store', parentId: 'market-1', sortOrder: 0, isActive: true })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建（无父节点）→ 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createOrgNode({ id: 'hq-1', name: '总部', type: 'headquarters', parentId: null, sortOrder: 0, isActive: true })
    expect(result.success).toBe(true)
    expect(result.message).toContain('节点创建成功')
  })

  it('正常创建（有父节点）→ 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: 'headquarters' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createOrgNode({ id: 'market-1', name: '华南市场', type: 'market', parentId: 'hq-1', sortOrder: 1, isActive: true })
    expect(result.success).toBe(true)
  })
})

// ── updateOrgNode ─────────────────────────────────────────────────────────────

describe('updateOrgNode — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('rowCount=0，无乐观锁 → 报告节点不存在（而非静默成功）', async () => {
    setupUpdate(0)
    const result = await updateOrgNode('nonexistent', { name: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('节点不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateOrgNode('n-1', { name: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('无效节点类型 → 拒绝，不调用 DB', async () => {
    const result = await updateOrgNode('n-1', { type: 'invalid' as any })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无效的节点类型')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)
    const result = await updateOrgNode('n-1', { name: '新名称' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })
})

// ── deleteOrgNode ─────────────────────────────────────────────────────────────

describe('deleteOrgNode — 前置校验 + rowCount=0 修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('有子节点 → 拒绝，不执行软删除', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ id: 'child-1' }]))
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('子节点')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('有员工绑定 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([])() // 无子节点
      return makeSelectChain([{ employeeId: 'EMP-001' }])() // 有员工
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('员工')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('有门店绑定 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([])() // 无子节点
      if (callCount === 2) return makeSelectChain([])() // 无员工
      return makeSelectChain([{ storeId: 'store-1' }])() // 有门店
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('有权限角色引用 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount <= 3) return makeSelectChain([])()
      return makeSelectChain([{ id: 1 }])() // 有权限角色
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('权限角色')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('rowCount=0，无乐观锁 → 报告节点不存在（而非静默成功）', async () => {
    // 所有前置检查均通过（无引用）
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    setupUpdate(0)
    const result = await deleteOrgNode('nonexistent')
    expect(result.success).toBe(false)
    expect(result.message).toContain('节点不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    setupUpdate(0)
    const result = await deleteOrgNode('n-1', '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('正常软删除 → 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    setupUpdate(1)
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已停用')
    expect(db.update).toHaveBeenCalledOnce()
  })
})
