import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    updatedAt: 'updated_at',
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
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
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
}))

vi.mock('@/lib/node-scope', () => ({
  isNodeInScope: vi.fn(() => Promise.resolve(true)), // 默认在 scope 内
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { getStores, getAvailableStoreNodes, createStore, updateStore } from './stores'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { scopeCondition } from '@/lib/permissions'
import { isNodeInScope } from '@/lib/node-scope'

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

  /** mock db.transaction：tx.insert(stores).values(...)；valuesImpl 控制 insert 行为（resolve/reject） */
  function mockInsertTx(valuesImpl: any) {
    const txInsert = vi.fn().mockReturnValue({ values: valuesImpl })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ insert: txInsert }))
    return { txInsert }
  }

  const storeNode = { id: 'node-门店-1', name: '南昌蓝茉店', type: '门店' }

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
})

// ── updateStore ─────────────────────────────────────────────────────────────

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
