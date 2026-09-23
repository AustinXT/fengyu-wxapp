import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // 事务外的 checkIsDescendant 走它（org.ts:44）。⚠️ 返回**空数组**表示「不是子孙」——
    // 它判的是 `rows.length > 0`，给一行（哪怕是 `[{c:0}]`）就等于「成环」，改挂会被提前驳回。
    execute: vi.fn().mockResolvedValue([]),
    // 改挂走事务（取组织树锁 + 复核子树员工归属自洽，#318）
    transaction: vi.fn(),
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
  // 保留模板实参：取锁那条断言要能看见 SQL 文本里的 lock key（#318）
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), { raw: vi.fn((s: string) => s) }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  isAdminScope: vi.fn(() => true), // 默认 admin（不限 scope）
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

/** 改挂复核走这个纯查询（#318）—— 它的 SQL 语义由真库冒烟负责，这里只测分支 */
vi.mock('@/lib/org-ancestry', () => ({
  findSubtreeOwnershipConflicts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/invariant-locks', async (orig) => await orig())

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { createOrgNode, updateOrgNode, deleteOrgNode } from './org'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { findSubtreeOwnershipConflicts } from '@/lib/org-ancestry'

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

function setupUpdate(count: number) {
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
}

function setupDelete(count: number) {
  const where = vi.fn().mockResolvedValue({ count })
  ;(db.delete as any).mockReturnValue({ where })
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
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: '市场', parentId: 'nonexistent', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('父节点不存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('department 下不能再建 department → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '部门' }]))
    const result = await createOrgNode({ id: 'n-1', name: '子部门', type: '部门', parentId: 'dept-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('部门不可嵌套')
  })

  it('store 下只能建 department → 拒绝非 department 类型', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '门店' }]))
    const result = await createOrgNode({ id: 'n-1', name: '子市场', type: '市场', parentId: 'store-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店节点下只能创建部门')
  })

  it('节点编号重复（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '市场' }]))
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: '门店', parentId: 'market-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('节点编号已存在')
  })

  it('父节点 FK 违反（23503）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '市场' }]))
    const pgError = Object.assign(new Error('FK violation'), { code: '23503' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createOrgNode({ id: 'n-1', name: '测试', type: '门店', parentId: 'market-1', sortOrder: 0, isActive: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('父节点不存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '市场' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createOrgNode({ id: 'n-1', name: '测试', type: '门店', parentId: 'market-1', sortOrder: 0, isActive: true })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建（无父节点）→ 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createOrgNode({ id: 'hq-1', name: '总部', type: '总部', parentId: null, sortOrder: 0, isActive: true })
    expect(result.success).toBe(true)
    expect(result.message).toContain('节点创建成功')
  })

  it('正常创建（有父节点）→ 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '总部' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createOrgNode({ id: 'market-1', name: '华南市场', type: '市场', parentId: 'hq-1', sortOrder: 1, isActive: true })
    expect(result.success).toBe(true)
  })
})

// ── updateOrgNode ─────────────────────────────────────────────────────────────

/**
 * 改挂父节点必须复核子树内员工的归属自洽（issue #318 —— #259 的另一侧）。
 *
 * #259 只在员工侧守了「`org_node_id` 的最近门店祖先 = `store_id` 所指门店」；
 * 这一侧不守的话，把部门 D 从市场改挂到 B 店节点下，挂着 D 的员工就成了
 * 「仍属 A 店、组织却在 B 店子树」—— 通过 store / org 两维同时出现在两个门店的 scope。
 */
describe('updateOrgNode — 结构性变更后复核子树员工归属自洽（#318）', () => {
  /** 被改的节点：市场下的部门 */
  const NODE_ROW = { parentId: 'market-1', type: '部门' }
  /** 目标父节点：市场（部门挂市场合法） */
  const PARENT_ROW = { type: '市场' }

  /**
   * 合法改挂的默认 select 序列：① 事务外快照 ② 事务外读目标父节点
   * ③ 锁内重读本节点 ④ 锁内读目标父节点。层级校验事务内外各跑一次，所以是四次。
   */
  function mockLegalReparent() {
    mockSelectSequence([[NODE_ROW], [PARENT_ROW], [NODE_ROW], [PARENT_ROW]])
  }

  /**
   * 按调用次序给 select 不同返回值 —— 事务外快照、锁内重读、目标父节点类型是三次不同的查询，
   * 「锁内重读拿不到行」这类场景必须能分别喂。
   */
  function mockSelectSequence(sequence: any[][]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => {
      const rows = sequence[i] ?? sequence[sequence.length - 1]
      i++
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(rows)
      chain.leftJoin = vi.fn().mockReturnValue(chain)
      chain.orderBy = vi.fn().mockReturnValue(chain)
      return chain
    })
  }

  /**
   * @returns `txExecute` 断言取过组织树锁；`order` 断言「先 UPDATE 再复核」；
   *   `tx()` 交出句柄本身（executor 同一性断言要用它，形状匹配对全局 `db` 也成立）
   */
  function setupTx(updateCount = 1) {
    let handedTx: any
    const txExecute = vi.fn().mockResolvedValue([])
    const order: string[] = []
    const txUpdate = vi.fn().mockImplementation(() => {
      order.push('update')
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ count: updateCount }),
        }),
      }
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      handedTx = { execute: txExecute, update: txUpdate, select: (...a: any[]) => (db as any).select(...a) }
      return fn(handedTx)
    })
    return { tx: () => handedTx, txExecute, txUpdate, order }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({ conflicts: [], total: 0 })
    mockLegalReparent()
  })

  it('改挂后子树内有员工归属不自洽 → 拒绝并列出姓名，事务回滚', async () => {
    const t = setupTx()
    ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({
      conflicts: [
        { employeeId: 'FY-001', name: '张三', storeId: 'S001' },
        { employeeId: 'FY-002', name: '李四', storeId: 'S001' },
      ],
      total: 2,
    })

    const result = await updateOrgNode('dept-1', { parentId: 'store-b-node' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('张三')
    expect(result.message).toContain('李四')
    expect(result.message).toContain('请先调整他们的归属')
    // 名单没被截断时不要画蛇添足地加「共 N 人」
    expect(result.message).not.toContain('共 2 人')
    // 复核查的必须是被改的那个节点，且走同一个 tx
    expect(findSubtreeOwnershipConflicts).toHaveBeenCalledWith('dept-1', t.tx())
  })

  /** 名单被 limit 截断时必须告诉总数，否则管理员改完 5 个再点一次又冒出 5 个 */
  it('冲突人数超过名单上限 → 文案带总人数', async () => {
    setupTx()
    ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({
      conflicts: [{ employeeId: 'FY-001', name: '张三', storeId: 'S001' }],
      total: 9,
    })

    const result = await updateOrgNode('dept-1', { parentId: 'store-b-node' })

    expect(result.message).toContain('共 9 人')
  })

  /** 姓名空串会渲染出孤零零的顿号；兜底成工号 */
  it('冲突员工姓名为空 → 用工号兜底', async () => {
    setupTx()
    ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({
      conflicts: [{ employeeId: 'FY-007', name: '   ', storeId: 'S001' }],
      total: 1,
    })

    const result = await updateOrgNode('dept-1', { parentId: 'store-b-node' })

    expect(result.message).toContain('FY-007')
  })

  it('改挂后子树自洽 → 放行', async () => {
    setupTx()

    const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(result.success).toBe(true)
    expect(findSubtreeOwnershipConflicts).toHaveBeenCalled()
  })

  /**
   * **只改 type 也必须复核**（两谱系第 1 轮都报了这条）：市场下的部门 D 改成「门店」，
   * 挂 D 的员工的最近门店祖先立刻变成 D 自己 —— 与 `store_id` 所指门店不符。
   * 生产 74 人挂部门型节点，正是这个形态。
   */
  it('只改 type（不动 parentId）→ 同样进事务、取锁、复核', async () => {
    const t = setupTx()
    // 事务外快照 / 锁内重读都是「市场下的部门」；第三次是目标父节点（市场）
    mockLegalReparent()

    const result = await updateOrgNode('dept-1', { type: '门店' })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalled()
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
    expect(findSubtreeOwnershipConflicts).toHaveBeenCalledWith('dept-1', t.tx())
  })

  it('改挂路径取的是与员工侧同一把组织树锁', async () => {
    const t = setupTx()

    await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('pg_advisory_xact_lock')
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
  })

  /**
   * **先 UPDATE 再复核** —— 这样查的是改完**之后**的真实树形态，
   * 不必在 SQL 里模拟新父节点。顺序反了就会按旧形态判，等于没判。
   */
  it('复核发生在 UPDATE 之后（按变更后的树形态判）', async () => {
    const t = setupTx()
    ;(findSubtreeOwnershipConflicts as any).mockImplementation(() => {
      t.order.push('check')
      return Promise.resolve({ conflicts: [], total: 0 })
    })

    await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(t.order).toEqual(['update', 'check'])
  })

  it('CAS 未命中（rowCount=0）→ 不做复核（没改到行就没有新形态）', async () => {
    setupTx(0)

    const result = await updateOrgNode('dept-1', { parentId: 'market-2' }, '2026-01-01T00:00:00.000Z')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
    expect(findSubtreeOwnershipConflicts).not.toHaveBeenCalled()
  })

  /**
   * 锁内重读拿不到行 = 事务外读到过、取到锁时已被并发删除。
   * 必须在 UPDATE **之前**就退出，别拿事务外快照当真相继续写。
   */
  it('锁内重读节点已不存在 → 报节点不存在，且不 UPDATE', async () => {
    const t = setupTx()
    // ① 事务外快照有 ② 锁内重读空
    mockSelectSequence([[NODE_ROW], [PARENT_ROW], []])

    const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('节点不存在')
    expect(t.txUpdate).not.toHaveBeenCalled()
    expect(findSubtreeOwnershipConflicts).not.toHaveBeenCalled()
  })

  /**
   * 层级校验在锁内**重跑**（事务外那次只是早拒）：并发把目标父节点改成了「部门」型，
   * 锁内必须发现并拒掉，而不是沿用事务外读到的合法类型。
   */
  it('锁内层级校验失败 → 拒绝且不 UPDATE（事务外读到的是合法类型）', async () => {
    const t = setupTx()
    mockSelectSequence([
      [NODE_ROW],          // ① 事务外快照
      [PARENT_ROW],        // ② 事务外读目标父节点：合法（市场）
      [NODE_ROW],          // ③ 锁内重读本节点
      [{ type: '部门' }],  // ④ 锁内读目标父节点：已被并发改成部门
    ])

    const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('部门不可嵌套')
    expect(t.txUpdate).not.toHaveBeenCalled()
  })

  it('非结构性的普通更新（改名）→ 不进事务、不取锁、不复核', async () => {
    setupTx()
    setupUpdate(1)

    const result = await updateOrgNode('dept-1', { name: '新名称' })

    expect(result.success).toBe(true)
    expect(db.transaction).not.toHaveBeenCalled()
    expect(findSubtreeOwnershipConflicts).not.toHaveBeenCalled()
  })
})

describe('updateOrgNode — rowCount=0 静默成功修复', () => {
  /** mock db.select() 链，用于 update 前获取旧值 */
  function mockSelectBefore(rows: any[] = [{}]) {
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    ;(db.select as any).mockReturnValue(chain)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
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

describe('deleteOrgNode — 真实删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('有子节点 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ id: 'child-1' }]))
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('子节点')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('有员工绑定 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([])()
      return makeSelectChain([{ employeeId: 'EMP-001' }])()
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('员工')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('有门店绑定 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount <= 2) return makeSelectChain([])()
      return makeSelectChain([{ storeId: 'store-1' }])()
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('有权限角色引用 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount <= 3) return makeSelectChain([])()
      return makeSelectChain([{ id: 1 }])()
    })
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('权限角色')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('rowCount=0 → 节点不存在', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    setupDelete(0)
    const result = await deleteOrgNode('nonexistent')
    expect(result.success).toBe(false)
    expect(result.message).toContain('节点不存在')
  })

  it('正常删除 → 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    setupDelete(1)
    const result = await deleteOrgNode('n-1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.delete).toHaveBeenCalledOnce()
  })
})

// ── scope 隔离测试 ───────────────────────────────────────────────────────────

describe('org scope 隔离 — 非 admin 用户', () => {
  const hrSession = {
    employeeId: 'HR-001',
    roles: [{ role: 'hr', scopeId: 'store-nc01' }],
    permissions: { actions: ['org:list', 'org:create', 'org:update', 'org:delete'], scopeStoreIds: ['store-nc01'] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  it('createOrgNode — parentId 在 scope 内 → 允许', async () => {
    // select call 1: parent type check → returns store type
    // select call 2: isNodeInScope → scopeId matches nodeId directly
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1 ? [{ type: '门店' }] : []
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await createOrgNode({
      id: 'dept-new', name: '美容部', type: '部门',
      parentId: 'store-nc01', sortOrder: 1, isActive: true,
    })
    expect(result.success).toBe(true)
  })

  it('createOrgNode — parentId 不在 scope 内 → 拒绝', async () => {
    // select call 1: parent type → store
    // select call 2+: isNodeInScope walks up but never matches
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1
          ? [{ type: '门店' }]
          : selectCall === 2
            ? [{ parentId: 'market-other' }]
            : selectCall === 3
              ? [{ parentId: 'hq' }]
              : [{ parentId: null }]
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await createOrgNode({
      id: 'dept-bad', name: '非法部门', type: '部门',
      parentId: 'store-other', sortOrder: 1, isActive: true,
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
  })

  it('updateOrgNode — 节点不在 scope 内 → 拒绝', async () => {
    // isNodeInScope: walks up but never matches hrSession.roles[0].scopeId
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1
          ? [{ parentId: 'market-other' }]
          : selectCall === 2
            ? [{ parentId: 'hq' }]
            : [{ parentId: null }]
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await updateOrgNode('store-other', { name: '改名' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('deleteOrgNode — 节点不在 scope 内 → 拒绝', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => {
      selectCall++
      const limit = vi.fn().mockResolvedValue(
        selectCall === 1
          ? [{ parentId: 'market-other' }]
          : [{ parentId: null }]
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await deleteOrgNode('dept-other')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.update).not.toHaveBeenCalled()
  })
})
