import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
    // getMarketStoreIds 走原生 SQL
    execute: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    updatedAt: 'updated_at',
    isClosed: 'is_closed',
    closedAt: 'closed_at',
  },
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    parentId: 'parent_id',
    sortOrder: 'sort_order',
    isActive: 'is_active',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  // 保留模板实参：取锁那条断言要能看见 SQL 文本里的 lock key（#318）
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), {
    raw: vi.fn((v: string) => v),
    param: vi.fn((v: unknown) => ({ param: v })),
  }),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn(() => ({
    id: 'alias_id',
    name: 'alias_name',
    parentId: 'alias_parent_id',
  })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined), // admin 返回 undefined（不过滤）
  hasPermission: vi.fn((session: any, action: string) => session.permissions.actions.includes(action)),
  isAdminScope: vi.fn(() => true), // 默认 admin（不按树复判 scope）
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/node-scope', () => ({
  isNodeInScope: vi.fn(() => Promise.resolve(true)), // 默认在 scope 内
}))

// 「节点是否还在管辖范围内」按当前树判（#318 第 6 轮）；SQL 语义由真库冒烟负责
vi.mock('@/lib/org-ancestry', () => ({
  isNodeWithinScopeRoots: vi.fn(() => Promise.resolve(true)),
  // 那条 SQL 抽到 lib 里了，语义由真库冒烟负责（#318 第 8 轮）
  findSiblingStoreIds: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { getStores, getAvailableStoreNodes, createStore, updateStore, getMarketStoreIds } from './stores'
import { db } from '@/db'
import { isAdminScope, isInScope } from '@/lib/permissions'
import { isNodeWithinScopeRoots, findSiblingStoreIds } from '@/lib/org-ancestry'
import { getSession } from '@/lib/auth'
import { scopeCondition } from '@/lib/permissions'
import { isNodeInScope } from '@/lib/node-scope'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { shanghaiToday } from '@/lib/datetime'

/**
 * ⚠️ `vi.clearAllMocks()` 只清调用记录、**不清 mockImplementation** —— 某条用例给共享桩设的
 * 实现会泄漏到后面所有用例。这个**顶层** `beforeEach` 先于各 describe 自己的那个执行，
 * 而后者的 `clearAllMocks()` 不会清掉这里设的实现，所以顺序是安全的。
 */
beforeEach(() => {
  ;(isAdminScope as any).mockReturnValue(true)
  ;(isNodeWithinScopeRoots as any).mockResolvedValue(true)
  ;(isInScope as any).mockReturnValue(true)
  ;(findSiblingStoreIds as any).mockResolvedValue([])
})

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['store:list', 'store:create', 'store:update', 'store:lakala_config'], scopeStoreIds: [] },
}

// createStore 现在接收 { storeId, orgNodeId, ...details }
const baseStoreData = {
  storeId: 'STORE-001',
  orgNodeId: 'node-门店-1',
}

/** 模拟 drizzle 0.44+ 包装错误：真实 pg 错误码/约束名在 cause 下。 */
function wrappedPgError(code: string, constraint?: string) {
  const inner = Object.assign(new Error('pg error'), {
    code,
    ...(constraint ? { constraint_name: constraint } : {}),
  })
  return Object.assign(new Error('Failed query: ...'), { cause: inner })
}

// ── getStores — scope 隔离 ──────────────────────────────────────────────────

describe('getStores — scope 隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setupSelectChain(returnValue: any[]) {
    const orderBy = vi.fn().mockResolvedValue(returnValue)
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin2 = vi.fn().mockReturnValue({ where })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    ;(db.select as any).mockReturnValue({ from })
    return { where }
  }

  it('admin 角色 → scopeCondition 返回 undefined（不过滤）', async () => {
    ;(getSession as any).mockResolvedValue(mockSession)
    setupSelectChain([])

    await getStores()

    expect(scopeCondition).toHaveBeenCalled()
  })

  it('hr 角色 → scopeCondition 被调用以过滤 stores', async () => {
    const hrSession = {
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'store-1' }],
      permissions: { actions: ['store:list'], scopeStoreIds: ['store-1'] },
    }
    ;(getSession as any).mockResolvedValue(hrSession)
    ;(scopeCondition as any).mockReturnValue({ type: 'inArray' })
    setupSelectChain([])

    await getStores()

    expect(scopeCondition).toHaveBeenCalledWith(hrSession, 'store_id')
  })
})

// ── getAvailableStoreNodes ──────────────────────────────────────────────────

describe('getAvailableStoreNodes — 候选门店节点', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isNodeInScope as any).mockResolvedValue(true)
  })

  function setupNodesChain(rows: any[]) {
    const orderBy = vi.fn().mockResolvedValue(rows)
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin2 = vi.fn().mockReturnValue({ where })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    ;(db.select as any).mockReturnValue({ from })
  }

  it('返回 scope 内的门店节点（带市场名）', async () => {
    setupNodesChain([
      { id: 'n1', name: '南昌蓝茉店', marketName: '南昌市场', parentId: 'm1' },
      { id: 'n2', name: '南昌江信店', marketName: '南昌市场', parentId: 'm1' },
    ])
    const result = await getAvailableStoreNodes()
    expect(result).toEqual([
      { id: 'n1', name: '南昌蓝茉店', marketName: '南昌市场' },
      { id: 'n2', name: '南昌江信店', marketName: '南昌市场' },
    ])
  })

  it('scope 外的节点被过滤掉', async () => {
    setupNodesChain([
      { id: 'n1', name: '在范围内', marketName: 'M', parentId: 'm1' },
      { id: 'n2', name: '范围外', marketName: 'M', parentId: 'm2' },
    ])
    ;(isNodeInScope as any).mockImplementation(async (_s: any, id: string) => id === 'n1')
    const result = await getAvailableStoreNodes()
    expect(result).toEqual([{ id: 'n1', name: '在范围内', marketName: 'M' }])
  })
})

// ── createStore ─────────────────────────────────────────────────────────────

describe('createStore — 挂载到门店节点', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isNodeInScope as any).mockResolvedValue(true)
  })

  /** mock 节点查询：db.select(...).from().where().limit() → [node] */
  function mockNodeLookup(node: any) {
    const limit = vi.fn().mockResolvedValue(node ? [node] : [])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })
  }

  /**
   * mock db.transaction：tx.insert(stores).values(...)；valuesImpl 控制 insert 行为（resolve/reject）。
   *
   * 创建走事务了（#318 第 5 轮）：取组织树锁 + 锁内重读节点类型 + INSERT + 审计同一事务，
   * 所以 tx 还要有 `execute`（取锁）与 `select`（重读节点类型）。
   * @param lockedNodeType 锁内重读到的节点类型；传别的值就能造「事务外是门店、锁内已被改掉」
   */
  function mockInsertTx(valuesImpl: any, lockedNodeType: string | null = '门店') {
    const txInsert = vi.fn().mockReturnValue({ values: valuesImpl })
    const txExecute = vi.fn().mockResolvedValue([])
    const txSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            // 门店名以组织节点为权威，锁内一并复读（#318 第 7 轮）
            lockedNodeType === null ? [] : [{ type: lockedNodeType, name: '南昌蓝茉店' }],
          ),
        }),
      }),
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      insert: txInsert, execute: txExecute, select: txSelect,
    }))
    return { txInsert, txExecute }
  }

  const storeNode = { id: 'node-门店-1', name: '南昌蓝茉店', type: '门店' }

  /**
   * `stores.org_node_id` 是「门店 ↔ 组织节点」映射的写入方，而 org 侧改类型的守卫要查
   * 「本节点上有没有门店映射」。两边不共锁就能交叉穿透（codex 第 5 轮 P1）。
   */
  it('创建取的是与 org 侧同一把组织树锁', async () => {
    mockNodeLookup(storeNode)
    const t = mockInsertTx(vi.fn().mockResolvedValue({}))

    const result = await createStore(baseStoreData)

    expect(result.success).toBe(true)
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('org_nodes:reparent')
  })

  it('锁内重读发现节点已不是门店类型 → 拒绝且不 INSERT', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values, '部门')

    const result = await createStore(baseStoreData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不是门店类型')
    expect(values).not.toHaveBeenCalled()
  })

  /**
   * 节点是否**还**在管辖范围内要按当前树判（codex 第 6 轮 P1）：
   * 事务外走的是 session 快照，窗口是整个 JWT 寿命 —— 节点在登录后被改挂到另一个市场，
   * 旧 session 照样放行。
   */
  it('非 admin：节点已被挪出管辖子树 → 拒绝且不 INSERT', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isNodeWithinScopeRoots as any).mockResolvedValue(false)

    const result = await createStore(baseStoreData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权在该节点下创建门店')
    expect(values).not.toHaveBeenCalled()
  })

  it('锁内重读发现节点已被删除 → 拒绝且不 INSERT', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values, null)

    const result = await createStore(baseStoreData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('门店节点不存在')
    expect(values).not.toHaveBeenCalled()
  })

  it('节点不存在 → 友好提示', async () => {
    mockNodeLookup(null)
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店节点不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('节点非门店类型 → 拒绝', async () => {
    mockNodeLookup({ id: 'node-市场-1', name: '南昌市场', type: '市场' })
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('scope 外 → 拒绝，不插入', async () => {
    mockNodeLookup(storeNode)
    ;(isNodeInScope as any).mockResolvedValue(false)
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('正常创建 → 成功，门店名取节点名', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(true)
    expect(result.message).toContain('门店创建成功')
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ storeName: '南昌蓝茉店', orgNodeId: 'node-门店-1' }))
  })

  it('节点已挂门店（23505 + org_node_id 唯一，包装错误）→ 友好提示', async () => {
    mockNodeLookup(storeNode)
    mockInsertTx(vi.fn().mockRejectedValue(wrappedPgError('23505', 'stores_org_node_id_unique')))
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('该门店节点已创建过门店信息')
  })

  it('门店名占用（23505 但非 org_node 唯一约束）→ 友好提示', async () => {
    mockNodeLookup(storeNode)
    mockInsertTx(vi.fn().mockRejectedValue(wrappedPgError('23505', 'stores_store_name_unique')))
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店名称已被占用')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    mockNodeLookup(storeNode)
    mockInsertTx(vi.fn().mockRejectedValue(new Error('connection lost')))
    await expect(createStore(baseStoreData)).rejects.toThrow('connection lost')
  })

  /**
   * is_closed ↔ closed_at 双写一致（#422）：UI 不传 isClosed，但 Server Action 可直调，
   * 建档即关店时原先只写 is_closed=true、closed_at 留空。
   */
  it('isClosed=true → 同时写 closedAt=今天（上海），审计记下关店状态', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    const result = await createStore({ ...baseStoreData, isClosed: true })
    expect(result.success).toBe(true)
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ isClosed: true, closedAt: shanghaiToday() }))
    expect((logOperation as any).mock.calls[0][4]).toEqual({
      storeName: '南昌蓝茉店', orgNodeId: 'node-门店-1', isClosed: true, closedAt: shanghaiToday(),
    })
  })

  it.each([
    ['未传 isClosed', {}],
    ['isClosed=false', { isClosed: false }],
  ])('%s → closedAt 为 null', async (_label, extra) => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    await createStore({ ...baseStoreData, ...extra })
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ isClosed: false, closedAt: null }))
  })

  it('isClosed 传非布尔值（字符串 "true"）→ 按未关店建档，不写闭店日期', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    await createStore({ ...baseStoreData, isClosed: 'true' } as any)
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ isClosed: false, closedAt: null }))
  })

  it('多塞的 closedAt 不会被写进库（建档只按 isClosed 推导）', async () => {
    mockNodeLookup(storeNode)
    const values = vi.fn().mockResolvedValue({})
    mockInsertTx(values)
    await createStore({ ...baseStoreData, closedAt: '2020-01-01' } as any)
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ isClosed: false, closedAt: null }))
  })
})

// ── updateStore ─────────────────────────────────────────────────────────────

/**
 * `getMarketStoreIds` 原先既不校验入参门店是否在 scope 内、也不过滤结果 ——
 * 市场 A 的管理员传一个市场 B 的 storeId 就能枚举 B 的全部门店 id（#318 第 7 轮 GLM P2）。
 */
describe('getMarketStoreIds — scope 隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('非 admin：入参门店不在 scope 内 → 直接返回空，连查询都不发', async () => {
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isInScope as any).mockReturnValue(false)

    const result = await getMarketStoreIds('store-other-market')

    expect(result).toEqual([])
    expect(findSiblingStoreIds).not.toHaveBeenCalled()
  })

  it('非 admin：结果里超出 scope 的兄弟门店被过滤掉', async () => {
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isInScope as any).mockImplementation((_s: any, id: string) => id !== 'store-outside')
    ;(findSiblingStoreIds as any).mockResolvedValue(['store-mine', 'store-outside'])

    const result = await getMarketStoreIds('store-mine')

    expect(result).toEqual(['store-mine'])
  })

  it('admin：不过滤', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(findSiblingStoreIds as any).mockResolvedValue(['a', 'b'])

    const result = await getMarketStoreIds('a')

    expect(result).toEqual(['a', 'b'])
  })

  /** 兄弟集合为空（门店没映射/查不到）→ 兜底成 [自身]，不能返回空让调用方误判 */
  it('查不到兄弟 → 兜底返回自身', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(findSiblingStoreIds as any).mockResolvedValue([])

    expect(await getMarketStoreIds('solo')).toEqual(['solo'])
  })
})

describe('updateStore — count 检测 + 节点名同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
  })

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

  /** mock db.transaction：tx.update(...).set().where() → { count }；返回 tx 以便断言调用次数 */
  function setupUpdateTx(count: number) {
    const txUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count }) }),
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ update: txUpdate }))
    return { txUpdate }
  }

  it('count=0，无乐观锁 → 报告门店不存在', async () => {
    setupUpdateTx(0)
    const result = await updateStore('nonexistent', { storeName: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店不存在')
  })

  it('count=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdateTx(0)
    const result = await updateStore('STORE-001', { storeName: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('count=1 → 成功', async () => {
    setupUpdateTx(1)
    const result = await updateStore('STORE-001', { bedCount: 5 })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })

  it('改名 → 同步更新 org_nodes.name（tx.update 调用两次）', async () => {
    mockSelectBefore([{ orgNodeId: 'node-1', storeName: '旧名' }])
    const { txUpdate } = setupUpdateTx(1)
    const result = await updateStore('STORE-001', { storeName: '新名称' })
    expect(result.success).toBe(true)
    expect(txUpdate).toHaveBeenCalledTimes(2) // stores + org_nodes
  })

  it('未改名 → 不同步节点名（tx.update 仅一次）', async () => {
    mockSelectBefore([{ orgNodeId: 'node-1', storeName: '同名' }])
    const { txUpdate } = setupUpdateTx(1)
    const result = await updateStore('STORE-001', { storeName: '同名', bedCount: 3 })
    expect(result.success).toBe(true)
    expect(txUpdate).toHaveBeenCalledTimes(1)
  })

  it('改名撞 uq_org_nodes_parent_name（23505 包装错误）→ 友好提示', async () => {
    mockSelectBefore([{ orgNodeId: 'node-1', storeName: '旧名' }])
    ;(db.transaction as any).mockRejectedValue(wrappedPgError('23505', 'uq_org_nodes_parent_name'))
    const result = await updateStore('STORE-001', { storeName: '撞名' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('同市场下已有同名门店')
  })
  /**
   * ## 写库字段必须走显式白名单（#318 第 7 轮 GLM P1）
   *
   * `data: Partial<{…}>` 只是编译期类型；Server Action 是可直接调用的端点，
   * 入参原样到达。裸 `{ ...data }` 进 `.set()` 时，客户端多塞一个 `orgNodeId`
   * （`stores` 的合法列）就能改掉「门店 ↔ 组织节点」映射 ——
   * 绕过 `createStore` 那三层守卫（① 锁 / 锁内复读节点类型 / 按树复判 scope）。
   * 同理还能改 `storeId`（主键）与 `updatedAt`（伪造乐观锁基线）。
   */
  it.each(['orgNodeId', 'storeId', 'updatedAt', 'createdAt'])(
    '多塞的 %s 不会被写进库（显式白名单）',
    async (extraKey) => {
      const { txUpdate } = setupUpdateTx(1)
      ;(db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ storeName: '旧名' }]) }),
        }),
      })

      const result = await updateStore('store-1', {
        storeName: '新名',
        [extraKey]: 'INJECTED',
      } as any)

      expect(result.success).toBe(true)
      const written = txUpdate.mock.results[0].value.set.mock.calls[0][0]
      expect(Object.keys(written), `${extraKey} 不该出现在写库字段里`).not.toContain(extraKey)
      expect(written.storeName, '白名单内的字段照常写').toBe('新名')
    },
  )

})

// ── updateStore — is_closed ↔ closed_at 双写（#422）────────────────────────────

describe('updateStore — 关店时 closedAt 推导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ storeName: '南昌蓝茉店', isClosed: true, closedAt: '2026-01-05' }]),
        }),
      }),
    })
  })

  /** tx.update().set().where() → { count }；tx.select 模拟落库后回读到的闭店日期 */
  function setupTx(count: number, closedAtAfter: string | null) {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count }) })
    const txUpdate = vi.fn().mockReturnValue({ set })
    const limit = vi.fn().mockResolvedValue([{ closedAt: closedAtAfter }])
    const txSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ update: txUpdate, select: txSelect }))
    return { set, txSelect }
  }

  /** 把 mock 的 sql 模板对象拍平成文本：字符串片段 + 插值（列名 / 参数值） */
  function sqlText(v: any): string {
    const [strings, ...values] = v.args
    return strings.reduce((acc: string, part: string, i: number) => acc + part + (i < values.length ? String(values[i]) : ''), '')
  }

  /**
   * 已关店再关店不能覆盖原闭店日期（与 sync-workfine STORE_UPSERT_SQL 的
   * `COALESCE(stores.closed_at, ...)` 一致）。写成 SET 内的 COALESCE、而不是按事务外读到的
   * before 判断 —— 后者在并发重新开业时会留下 is_closed=true + closed_at=NULL。
   */
  it('isClosed=true → closedAt 写成 COALESCE(原 closed_at, 今天)，已有日期保留', async () => {
    const { set } = setupTx(1, '2026-01-05')
    const result = await updateStore('STORE-001', { isClosed: true })
    expect(result.success).toBe(true)
    const written = set.mock.calls[0][0]
    expect(written.isClosed).toBe(true)
    expect(written.closedAt?.type, 'closedAt 必须是 SQL 表达式而非固定日期').toBe('sql')
    expect(sqlText(written.closedAt)).toBe(`COALESCE(closed_at, ${shanghaiToday()}::date)`)
  })

  it('审计记录的是落库后的真实闭店日期，不是 SQL 表达式', async () => {
    const { txSelect } = setupTx(1, '2026-01-05')
    await updateStore('STORE-001', { isClosed: true })
    expect(txSelect).toHaveBeenCalledTimes(1)
    const after = (logUpdate as any).mock.calls[0][5]
    expect(after).toEqual({ isClosed: true, closedAt: '2026-01-05' })
  })

  it('更新 0 行（门店不存在 / 乐观锁冲突）→ 不回读、不记审计', async () => {
    const { txSelect } = setupTx(0, null)
    const result = await updateStore('STORE-001', { isClosed: true }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(txSelect).not.toHaveBeenCalled()
    expect(logUpdate).not.toHaveBeenCalled()
  })

  it('isClosed=false（重新开业）→ closedAt 清空，不回读', async () => {
    const { set, txSelect } = setupTx(1, null)
    await updateStore('STORE-001', { isClosed: false })
    expect(set.mock.calls[0][0]).toEqual({ isClosed: false, closedAt: null })
    expect(txSelect).not.toHaveBeenCalled()
  })

  /**
   * closedAt 不接受直传（#422 pr-ready P2）：直调 Server Action 传 closedAt 曾能写出
   * is_closed 与 closed_at 不一致的行，而系统概览门店数按 closed_at 历史化。
   */
  it.each([
    ['关店 + closedAt=null', { isClosed: true, closedAt: null }, true],
    ['关店 + 任意日期', { isClosed: true, closedAt: '2026-03-01' }, true],
    ['重新开业 + 日期', { isClosed: false, closedAt: '2026-01-01' }, false],
  ])('多塞 closedAt（%s）→ 忽略，仍按 isClosed 推导', async (_label, data, closing) => {
    const { set } = setupTx(1, '2026-01-05')
    await updateStore('STORE-001', data as any)
    const written = set.mock.calls[0][0]
    expect(written.isClosed).toBe(closing)
    if (closing) expect(sqlText(written.closedAt)).toBe(`COALESCE(closed_at, ${shanghaiToday()}::date)`)
    else expect(written.closedAt).toBeNull()
  })

  it('只传 closedAt（不带 isClosed）→ 不写任何闭店字段', async () => {
    const { set } = setupTx(1, null)
    await updateStore('STORE-001', { bedCount: 6, closedAt: '2026-03-01' } as any)
    expect(set.mock.calls[0][0]).toEqual({ bedCount: 6 })
  })

  it.each([
    ['只传 closedAt', { closedAt: '2026-03-01' }],
    ['只传非白名单字段', { orgNodeId: 'node-x' }],
    ['空对象', {}],
  ])('白名单过滤后无可写字段（%s）→ 友好拒绝，不开事务', async (_label, data) => {
    setupTx(1, null)
    const result = await updateStore('STORE-001', data as any)
    expect(result).toEqual({ success: false, message: '没有可更新的字段' })
    expect(db.select, '早退在查旧值之前').not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('isClosed 传非布尔值（字符串 "false"）→ 按未关店处理', async () => {
    const { set } = setupTx(1, null)
    await updateStore('STORE-001', { isClosed: 'false' } as any)
    expect(set.mock.calls[0][0]).toEqual({ isClosed: false, closedAt: null })
  })

  it('不碰 isClosed → 不写 closedAt', async () => {
    const { set } = setupTx(1, null)
    await updateStore('STORE-001', { bedCount: 6 })
    expect(Object.keys(set.mock.calls[0][0])).toEqual(['bedCount'])
  })
})

// ── updateStore — 关联收款商户 ─────────────────────────────────────────────
// 收款字段（商户名/号/终端号/启用）已迁出门店页，归「商户管理」(/merchants) 维护；
// 门店仅选择关联哪个商户（写 stores.lakala_merchant_id 外键）。

describe('updateStore — 关联收款商户', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  /** 按调用顺序 mock db.select：每个 rowSet 对应一次 select().from().where().limit() */
  function mockSelectSequence(...rowSets: any[][]) {
    for (const rows of rowSets) {
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(rows)
      ;(db.select as any).mockReturnValueOnce(chain)
    }
  }

  function setupTx(count = 1) {
    const txInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const txUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count }) }),
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ insert: txInsert, update: txUpdate }))
    return { txInsert, txUpdate }
  }

  it('选择已有商户 → 校验商户存在后写外键（tx.update 被调）', async () => {
    // db.select 顺序：① 商户存在校验 ② before store
    mockSelectSequence(
      [{ id: 'lm_x' }],
      [{ orgNodeId: 'node-1', storeName: '蓝茉店', lakalaMerchantId: null }],
    )
    const { txUpdate } = setupTx(1)
    const result = await updateStore('STORE-001', { lakalaMerchantId: 'lm_x' })
    expect(result.success).toBe(true)
    expect(txUpdate).toHaveBeenCalled()
  })

  it('不关联（lakalaMerchantId=null）→ 跳过商户校验直接清空外键', async () => {
    // 不查商户存在，db.select 仅 before store 一次
    mockSelectSequence([{ orgNodeId: 'node-1', storeName: '蓝茉店', lakalaMerchantId: 'lm_old' }])
    const { txUpdate } = setupTx(1)
    const result = await updateStore('STORE-001', { lakalaMerchantId: null })
    expect(result.success).toBe(true)
    expect(txUpdate).toHaveBeenCalled()
  })

  it('所选商户不存在 → 在写库前拦截（不进事务）', async () => {
    // 商户存在校验返回空 → 早退
    mockSelectSequence([])
    const { txUpdate } = setupTx(1)
    const result = await updateStore('STORE-001', { lakalaMerchantId: 'lm_missing' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('收款商户不存在')
    expect(txUpdate).not.toHaveBeenCalled()
  })

  it('无 store:lakala_config 权限 → 拒绝改收款商户绑定', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['store:list', 'store:update'], scopeStoreIds: [] },
    })
    const { txUpdate } = setupTx(1)
    const result = await updateStore('STORE-001', { lakalaMerchantId: 'lm_x' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(txUpdate).not.toHaveBeenCalled()
  })
})
