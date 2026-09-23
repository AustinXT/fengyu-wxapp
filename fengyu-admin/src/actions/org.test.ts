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
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
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
  findSubtreeOwnershipConflicts: vi.fn().mockResolvedValue({ conflicts: [], total: 0 }),
  // 「节点自身是否还在我的管辖范围内」按当前树判（#318 第 3 轮）；SQL 语义由真库冒烟负责
  isNodeWithinScopeRoots: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/invariant-locks', async (orig) => await orig())

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { createOrgNode, updateOrgNode, deleteOrgNode } from './org'
import { db } from '@/db'
import { stores } from '@db/org'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { findSubtreeOwnershipConflicts, isNodeWithinScopeRoots } from '@/lib/org-ancestry'
import { logUpdate } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['org:list', 'org:create', 'org:update', 'org:delete'], scopeStoreIds: [] },
}

/**
 * ⚠️ `vi.clearAllMocks()` 只清调用记录、**不清 mockImplementation** —— 某条用例给共享桩设的
 * 实现会一路泄漏到后面所有用例（症状是「无辜的下游用例红」，排查时容易怀疑刚改的实现）。
 *
 * 这个**顶层** `beforeEach` 在每条用例前把共享桩复位成默认值。它先于各 describe 自己的
 * `beforeEach` 执行，而后者的 `clearAllMocks()` 不会把这里设的实现清掉，所以顺序是安全的。
 */
beforeEach(() => {
  ;(isAdminScope as any).mockReturnValue(true)
  ;(db.execute as any).mockResolvedValue([])
  ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({ conflicts: [], total: 0 })
  ;(isNodeWithinScopeRoots as any).mockResolvedValue(true)
  ;(getSession as any).mockResolvedValue(mockSession)
  /**
   * 默认事务桩：一律委托给全局 `db` 的各个桩，这样「只关心业务分支」的用例不必各自接线。
   * 需要拿到句柄本身做同一性断言的用例在自己的 `beforeEach` 里覆盖它（跑在这之后，会赢）。
   */
  ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
    execute: (...a: any[]) => (db as any).execute(...a),
    select: (...a: any[]) => (db as any).select(...a),
    insert: (...a: any[]) => (db as any).insert(...a),
    update: (...a: any[]) => (db as any).update(...a),
    delete: (...a: any[]) => (db as any).delete(...a),
  }))
})

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
  /**
   * 创建走事务了（#318 第 3 轮）：取组织树锁 + 锁内重读父节点类型 + INSERT + 审计同一事务。
   * tx 一律委托给全局 `db` 的桩，既有用例照旧 mock `db.select` / `db.insert` 即可。
   * @returns 记录调用的 `txExecute`（断言取锁用）
   */
  function mockCreateTx() {
    const txExecute = vi.fn().mockResolvedValue([])
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: txExecute,
      select: (...a: any[]) => (db as any).select(...a),
      insert: (...a: any[]) => (db as any).insert(...a),
    }))
    return { txExecute }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockCreateTx()
  })

  /** 与 updateOrgNode 改类型那侧**共用同一把锁** —— 只有两侧互斥，「复核存量子节点」才真的闭合 */
  it('创建取的是与改挂/改类型同一把组织树锁', async () => {
    const t = mockCreateTx()
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '市场' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    await createOrgNode({ id: 'n-1', name: '新店', type: '门店', parentId: 'market-1', sortOrder: 0, isActive: true })

    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
  })

  /** 锁内重读父节点类型 —— 事务外读到的可能已被并发改掉 */
  it('锁内重读父节点类型不合法 → 拒绝且不 INSERT', async () => {
    mockCreateTx()
    ;(db.select as any).mockImplementation(makeSelectChain([{ type: '部门' }]))
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    const result = await createOrgNode({ id: 'n-1', name: '子部门', type: '部门', parentId: 'dept-1', sortOrder: 0, isActive: true })

    expect(result.success).toBe(false)
    expect(values).not.toHaveBeenCalled()
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
   * ## 按「查的是什么」分派，而不是按调用次序
   *
   * `updateOrgNode` 的结构性路径要发四类 select（节点自身 / 目标父节点 / 直接子节点 /
   * 门店映射），且层级校验事务内外各跑一遍 —— 按次序喂的话每加一个查询就要重排所有夹具，
   * 而且排错时症状是「在一个假原因上失败」。这里用 `from()` 的表和 `where()` 的条件分派：
   * `eq` 已被 mock 成 `{ type:'eq', a, b }`，所以 `a === 'parent_id'` 就是查子节点，
   * `b === TARGET_ID` 就是查节点自身。
   *
   * `nodeQueue` / `parentQueue` 支持给**同一类查询**的先后两次不同答案 ——
   * 「事务外读到的与锁内重读的不一致」这类并发场景要靠它。
   */
  const TARGET_ID = 'dept-1'
  function mockOrgSelect(opts: {
    nodeQueue?: any[][]
    parentQueue?: any[][]
    children?: any[]
    storeRows?: any[]
  } = {}) {
    const nodeQueue = [...(opts.nodeQueue ?? [[NODE_ROW]])]
    const parentQueue = [...(opts.parentQueue ?? [[PARENT_ROW]])]
    const children = opts.children ?? []
    const storeRows = opts.storeRows ?? []
    const shift = (q: any[][], fallback: any[]) => (q.length > 1 ? q.shift()! : (q[0] ?? fallback))
    ;(db.select as any).mockImplementation(() => {
      const chain: any = {}
      let table: unknown
      let cond: any
      chain.from = vi.fn((t: unknown) => { table = t; return chain })
      chain.where = vi.fn((c: any) => { cond = c; return chain })
      chain.leftJoin = vi.fn(() => chain)
      chain.orderBy = vi.fn(() => chain)
      const rows = () => {
        if (table === stores) return storeRows
        if (cond?.a === 'parent_id') return children
        return cond?.b === TARGET_ID ? shift(nodeQueue, []) : shift(parentQueue, [])
      }
      chain.limit = vi.fn(() => Promise.resolve(rows()))
      // 查直接子节点是 `.from(t).where(c)` 直接 await（无 .limit()），所以链自身要可 await
      chain.then = (resolve: (v: any[]) => unknown) => resolve(rows())
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
      handedTx = {
        execute: txExecute,
        update: txUpdate,
        select: (...a: any[]) => (db as any).select(...a),
      }
      return fn(handedTx)
    })
    return { tx: () => handedTx, txExecute, txUpdate, order }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(findSubtreeOwnershipConflicts as any).mockResolvedValue({ conflicts: [], total: 0 })
    mockOrgSelect()
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


    const result = await updateOrgNode('dept-1', { type: '门店' })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalled()
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
    expect(findSubtreeOwnershipConflicts).toHaveBeenCalledWith('dept-1', t.tx())
  })

  /**
   * 改 `type` 要**两把都取**（#318 第 4 轮 codew P1）：它判的「节点类型 × 角色白名单 ×
   * 存量绑定」这个三元关系，同时被 `assignRole` 与 `updateRoleDefinition` 改白名单读写，
   * 而那两条路径取的是 ②。只取 ① 的话两边各自按旧状态通过，留下违规授权。
   */
  it('改 type → ① 组织树 + ② admin 计数两把都取，且顺序为 ①→②', async () => {
    const t = setupTx()

    await updateOrgNode('dept-1', { type: '门店' })

    const locks = t.txExecute.mock.calls.map((c: any) => JSON.stringify(c[0]))
    expect(locks[0]).toContain('org_nodes:reparent')
    expect(locks[1]).toContain('admin:active_count')
  })

  /** 只改父节点不改类型 → 不涉及白名单那个三元关系，不必取 ②（别无谓串行化） */
  it('只改挂父节点（不改 type）→ 只取 ①，不取 ②', async () => {
    const t = setupTx()

    await updateOrgNode('dept-1', { parentId: 'market-2' })

    const locks = t.txExecute.mock.calls.map((c: any) => JSON.stringify(c[0])).join('|')
    expect(locks).toContain('org_nodes:reparent')
    expect(locks).not.toContain('admin:active_count')
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
    // 事务外读到节点，锁内重读为空（被并发删除）
    mockOrgSelect({ nodeQueue: [[NODE_ROW], []] })

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
    // 事务外读到的目标父节点是市场（合法），锁内重读时已被并发改成部门
    mockOrgSelect({ parentQueue: [[PARENT_ROW], [{ type: '部门' }]] })

    const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('部门不可嵌套')
    expect(t.txUpdate).not.toHaveBeenCalled()
  })

  /**
   * ## 改 `type` 的连带影响（#318 第 3 轮，codex P1/P2）
   *
   * `validateParentType` 只管「新类型 × 父节点类型」这一对。另外三样在**创建**路径上都有守卫，
   * 改类型这条路上一个都没有 —— 又是「同一条规则只守了一侧」。
   */
  describe('改 type 的连带影响校验', () => {
    it('节点下已有子节点且新类型容不下它 → 拒绝', async () => {
      const t = setupTx()
      // 市场下挂着一个门店子节点，把它改成部门 → 「门店节点下只能创建部门」那条规则反过来被破
      mockOrgSelect({
        nodeQueue: [[{ parentId: 'hq-1', type: '市场' }]],
        parentQueue: [[{ type: '总部' }]],
        children: [{ id: 'store-x', name: 'X 店', type: '门店' }],
      })

      const result = await updateOrgNode('dept-1', { type: '部门' })

      expect(result.success).toBe(false)
      expect(result.message).toContain('X 店')
      expect(t.txUpdate).not.toHaveBeenCalled()
    })

    it('节点上挂着门店（stores.org_node_id 指向它）→ 不许改成非门店类型', async () => {
      const t = setupTx()
      mockOrgSelect({
        nodeQueue: [[{ parentId: 'market-1', type: '门店' }]],
        parentQueue: [[{ type: '市场' }]],
        storeRows: [{ storeName: '凤御一店' }],
      })

      const result = await updateOrgNode('dept-1', { type: '部门' })

      expect(result.success).toBe(false)
      expect(result.message).toContain('凤御一店')
      expect(t.txUpdate).not.toHaveBeenCalled()
    })

    /**
     * DB trigger `permission_validate_role_assignment_scope()` 只在绑定行 INSERT 时按当时的
     * `allowed_scope_types` 校验，改节点类型完全不回溯 —— 于是能留下「角色绑定挂部门节点」
     * 这种 trigger 本该禁止的状态。
     */
    it('节点上已有该层级不允许的角色授权 → 拒绝', async () => {
      const t = setupTx()
      mockOrgSelect({
        nodeQueue: [[{ parentId: 'market-1', type: '门店' }]],
        parentQueue: [[{ type: '市场' }]],
      })
      // 绑定检查走原生 SQL；返回一行表示「有不兼容的授权」
      ;(db.execute as any).mockImplementation((arg: unknown) => (
        JSON.stringify(arg).includes('permission_role_definitions')
          ? Promise.resolve([{ role_name: '门店店长' }])
          : Promise.resolve([])
      ))

      const result = await updateOrgNode('dept-1', { type: '部门' })

      expect(result.success).toBe(false)
      expect(result.message).toContain('门店店长')
      expect(t.txUpdate).not.toHaveBeenCalled()
    })

    it('三样都干净 → 放行', async () => {
      setupTx()
      mockOrgSelect({
        nodeQueue: [[{ parentId: 'market-1', type: '部门' }]],
        parentQueue: [[{ type: '市场' }]],
      })

      const result = await updateOrgNode('dept-1', { type: '门店' })

      expect(result.success).toBe(true)
    })
  })

  /**
   * ## 节点自身的 scope 按**当前树**判（#318 第 3 轮，两谱系共识）
   *
   * ⚠️ 两个谱系都建议「锁内重跑 `isNodeInScope`」—— 那是 **no-op**：它判的是
   * `session.permissions.scopeOrgNodeIds`（构造 session 时展开好的内存集合），
   * 与现在的树无关，同一个纯函数同一份入参，锁内锁外答案必然一样。
   * 所以改用 `isNodeWithinScopeRoots` 拿角色绑定的根节点去查当前树。
   */
  describe('节点自身 scope 按当前树复判', () => {
    const nonAdminSession = {
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'market-1' }],
      permissions: { actions: ['org:update'], scopeStoreIds: [], scopeOrgNodeIds: ['market-1', 'dept-1'] },
    }

    it('非 admin：节点已被并发挪出管辖子树 → 拒绝且不 UPDATE', async () => {
      ;(getSession as any).mockResolvedValue(nonAdminSession)
      ;(isAdminScope as any).mockReturnValue(false)
      ;(isNodeWithinScopeRoots as any).mockResolvedValue(false)
      const t = setupTx()

      const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

      expect(result.success).toBe(false)
      expect(result.message).toContain('无权编辑该节点')
      expect(t.txUpdate).not.toHaveBeenCalled()
      // 判据必须是「角色绑定的根节点」，不是展开后的那份过期集合
      expect((isNodeWithinScopeRoots as any).mock.calls[0][1]).toEqual(['market-1'])
    })

    it('非 admin：节点仍在管辖子树内 → 放行，且锁内也复判过一次', async () => {
      ;(getSession as any).mockResolvedValue(nonAdminSession)
      ;(isAdminScope as any).mockReturnValue(false)
      ;(isNodeWithinScopeRoots as any).mockResolvedValue(true)
      const t = setupTx()

      // 刻意只改 type、不动父节点 —— 换父节点会额外触发「目标父节点是否在我 scope 内」
      // 那条纯内存判据（market-2 不在这个 hr 的 scope 里），会盖掉本条要验的东西
      const result = await updateOrgNode('dept-1', { type: '门店' })

      expect(result.success).toBe(true)
      // 事务外早拒一次 + 锁内权威一次
      expect((isNodeWithinScopeRoots as any).mock.calls.length).toBe(2)
      expect((isNodeWithinScopeRoots as any).mock.calls[1][2], '锁内那次必须走事务句柄').toBe(t.tx())
    })

    /** 目标父节点也可能在 session 构造之后被挪出管辖范围（codex 第 4 轮 P1） */
    it('非 admin：目标父节点已被挪出管辖子树 → 拒绝', async () => {
      ;(getSession as any).mockResolvedValue({
        ...nonAdminSession,
        permissions: { ...nonAdminSession.permissions, scopeOrgNodeIds: ['market-1', 'dept-1', 'market-2'] },
      })
      ;(isAdminScope as any).mockReturnValue(false)
      // 被编辑节点自身还在范围内；目标父节点不在
      ;(isNodeWithinScopeRoots as any).mockImplementation(
        async (nodeId: string) => nodeId !== 'market-2',
      )
      const t = setupTx()

      const result = await updateOrgNode('dept-1', { parentId: 'market-2' })

      expect(result.success).toBe(false)
      expect(result.message).toContain('无权将节点移动到该位置')
      expect(t.txUpdate).not.toHaveBeenCalled()
    })

    it('admin → 不查树（不受 scope 限制）', async () => {
      setupTx()

      await updateOrgNode('dept-1', { parentId: 'market-2' })

      expect(isNodeWithinScopeRoots).not.toHaveBeenCalled()
    })
  })

  /**
   * ## 写库字段走显式白名单（#318 第 8 轮 codex P1）
   *
   * 客户端多塞 `updatedAt` 并写成一个旧时刻 → **持旧版本的请求也能命中 CAS**，
   * 乐观锁整体失效；`id` / `createdAt` 同理。`data: Partial<{…}>` 只是编译期类型。
   */
  it.each(['updatedAt', 'createdAt', 'id'])('多塞的 %s 不会被写进库', async (extraKey) => {
    // 只改 name → 非结构性路径，走全局 db.update（不进事务）
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateOrgNode('dept-1', { name: '新名称', [extraKey]: 'INJECTED' } as any)

    expect(result.success).toBe(true)
    const written = set.mock.calls[0][0]
    expect(Object.keys(written), `${extraKey} 不该出现在写库字段里`).not.toContain(extraKey)
    expect(written.name, '白名单内的字段照常写').toBe('新名称')
  })

  /**
   * 非结构性更新（改名 / 排序 / 启停）**也进事务、也取 ①**（#318 第 9 轮 GLM P2）——
   * 它不改树形态，但 scope 判定依赖树形态，要按当前树判就得有个一致的快照。
   * 不做的是「子树员工归属复核」（树没变，没什么可复核）。
   */
  it('非结构性的普通更新（改名）→ 进事务、取 ①、但不复核子树', async () => {
    const t = setupTx()

    const result = await updateOrgNode('dept-1', { name: '新名称' })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalled()
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
    // 树没变 → 不必复核子树员工归属
    expect(findSubtreeOwnershipConflicts).not.toHaveBeenCalled()
  })

  /** 非结构性路径也按当前树复判 scope —— 三步反例无需并发（见实现里的注释） */
  it('非结构性更新：非 admin 且节点已被挪出管辖子树 → 拒绝且不写库', async () => {
    const t = setupTx()
    ;(getSession as any).mockResolvedValue({
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'market-1' }],
      permissions: { actions: ['org:update'], scopeStoreIds: [], scopeOrgNodeIds: ['market-1', 'dept-1'] },
    })
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isNodeWithinScopeRoots as any).mockResolvedValue(false)

    const result = await updateOrgNode('dept-1', { name: '新名称' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权编辑该节点')
    expect(t.txUpdate).not.toHaveBeenCalled()
  })

  /** 审计也在事务内（写成功但审计抛错时不能留下「用户看到失败、改名已生效」） */
  it('非结构性更新的审计走事务句柄', async () => {
    const t = setupTx()

    await updateOrgNode('dept-1', { name: '新名称' })

    expect((logUpdate as any).mock.calls[0][6], '审计的 executor 必须是事务句柄').toBe(t.tx())
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

/**
 * ## deleteOrgNode 也是「改变树形态」的写入，必须取 ①（#318 第 5 轮 GLM P2）
 *
 * 不取锁的后果不只是守卫失效，而是两条**用户可见的 500**：
 * `updateOrgNode` 在锁内读到目标父节点后本 action 并发删掉它 → 那边 UPDATE 撞 23503 而
 * catch 不认；`assignRole` 锁内确认节点存在后 INSERT → scope 侧 23503 同样不被 catch。
 */
describe('deleteOrgNode — 取组织树锁 + 四项引用检查收进锁内（#318）', () => {
  /** @returns `txExecute` 断言取锁；`txDelete` 断言「引用检查没过就不该删」 */
  function setupDeleteTx(deleteCount = 1) {
    const txExecute = vi.fn().mockResolvedValue([])
    const txDelete = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ count: deleteCount }) }))
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: txExecute,
      select: (...a: any[]) => (db as any).select(...a),
      delete: txDelete,
    }))
    return { txExecute, txDelete }
  }

  /** 四项引用检查按**调用次序**喂：子节点 / 员工 / 门店 / 角色 */
  function mockRefChecks(rows: any[][]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => {
      const r = rows[i] ?? []
      i++
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(r)
      chain.then = (resolve: (v: any[]) => unknown) => resolve(r)
      return chain
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('取的是与改挂/创建同一把组织树锁', async () => {
    const t = setupDeleteTx()
    mockRefChecks([[], [], [], []])

    const result = await deleteOrgNode('dept-1')

    expect(result.success).toBe(true)
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
  })

  it.each([
    [0, '该节点下存在子节点'],
    [1, '该节点下仍有员工'],
    [2, '该节点关联了门店'],
    [3, '该节点被权限角色引用'],
  ])('锁内第 %i 项引用检查命中 → 拒绝且不 DELETE', async (hitIndex, expected) => {
    const t = setupDeleteTx()
    mockRefChecks([0, 1, 2, 3].map((i) => (i === hitIndex ? [{ id: 'x', employeeId: 'x', storeId: 'x' }] : [])))

    const result = await deleteOrgNode('dept-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain(expected)
    expect(t.txDelete, '引用检查没过就不该删').not.toHaveBeenCalled()
  })

  it('DELETE 命中 0 行（已被并发删除）→ 报节点不存在', async () => {
    setupDeleteTx(0)
    mockRefChecks([[], [], [], []])

    const result = await deleteOrgNode('dept-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('节点不存在')
  })
})

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
