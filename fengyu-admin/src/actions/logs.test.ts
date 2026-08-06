import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), delete: vi.fn() },
}))

vi.mock('@db/operation-log', () => ({
  operationLogs: {
    id: 'id',
    operatorEmployeeId: 'operator_employee_id',
    operatorName: 'operator_name',
    operatorRole: 'operator_role',
    orgNodeId: 'org_node_id',
    orgNodeName: 'org_node_name',
    action: 'action',
    targetType: 'target_type',
    targetId: 'target_id',
    detail: 'detail',
    source: 'source',
    createdAt: 'created_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    orgNodeId: 'store_org_node_id',
  },
  orgNodes: {
    id: 'org_node_id',
    type: 'type',
    parentId: 'parent_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  like: vi.fn((a, b) => ({ type: 'like', a, b })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  sql: vi.fn((strings: any, ...vals: any[]) => ({ type: 'sql', strings, vals })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  isAdminScope: vi.fn((session: any) => session.roles.some((role: any) => role.role === 'admin')),
  requireAnyPermission: vi.fn((session: any, actions: string[]) => {
    if (!session) throw new Error('NO_SESSION')
    const has = actions.some((a: string) => session.permissions?.actions?.includes(a))
    if (!has) throw new Error(`PERMISSION_DENIED: 无权执行 ${actions.join(' 或 ')}`)
  }),
}))

import { getLogs, getLogsPaginated, getOrderLogs, deleteOperationLog } from './logs'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { eq, inArray, like, gte, lte } from 'drizzle-orm'
import { isAdminScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin' }],
  permissions: { actions: ['operation_log:list', 'sale_order:list'], scopeStoreIds: [] },
}

const mockLogRow = {
  id: 1,
  operatorEmployeeId: 'EMP-001',
  operatorName: '张三',
  operatorRole: 'admin',
  orgNodeId: 'hq-1',
  orgNodeName: '凤御总部',
  action: 'employee.create',
  targetType: 'employee',
  targetId: 'FY-260315001',
  detail: { name: '李四' },
  source: 'admin',
  createdAt: new Date('2026-03-15T10:00:00Z'),
}

/** mock select chain: select → from → where → orderBy，兼容旧 .limit 收口 */
function mockLogChain(rows: any[]) {
  const chain: any = Object.assign(Promise.resolve(rows), {})
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

/** mock select chain without limit: select → from → where → orderBy */
function mockLogChainNoLimit(rows: any[]) {
  const orderBy = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ orderBy })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
}

// ── getLogs ───────────────────────────────────────────────────────────────────

describe('getLogs — 筛选 + LIKE 转义', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无筛选 → 返回日志列表', async () => {
    mockLogChain([mockLogRow])

    const result = await getLogs()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(1)
    expect(result[0].operatorName).toBe('张三')
    expect(result[0].action).toBe('employee.create')
    expect(result[0].createdAt).toBe('2026-03-15T10:00:00.000Z')
  })

  it('operatorName 筛选 → like 被调用', async () => {
    mockLogChain([])

    await getLogs({ operatorName: '张' })

    expect(like).toHaveBeenCalledWith('operator_name', '%张%')
  })

  it('operatorName 含 LIKE 特殊字符 → 转义后传入', async () => {
    mockLogChain([])

    await getLogs({ operatorName: '100%完成' })

    // % 被转义为 \%
    expect(like).toHaveBeenCalledWith('operator_name', '%100\\%完成%')
  })

  it('operatorName 含 _ → 转义', async () => {
    mockLogChain([])

    await getLogs({ operatorName: 'user_1' })

    expect(like).toHaveBeenCalledWith('operator_name', '%user\\_1%')
  })

  it('action 精确匹配（含 .）→ eq 被调用', async () => {
    mockLogChain([])

    await getLogs({ action: 'employee.create' })

    expect(eq).toHaveBeenCalledWith('action', 'employee.create')
  })

  it('action 前缀匹配（不含 .）→ like 被调用', async () => {
    mockLogChain([])

    await getLogs({ action: 'employee' })

    expect(like).toHaveBeenCalledWith('action', 'employee.%')
  })

  it('targetType 筛选 → eq 被调用', async () => {
    mockLogChain([])

    await getLogs({ targetType: 'sale_order' })

    expect(eq).toHaveBeenCalledWith('target_type', 'sale_order')
  })

  it('startDate 筛选 → gte 被调用', async () => {
    mockLogChain([])

    await getLogs({ startDate: '2026-03-01' })

    expect(gte).toHaveBeenCalled()
  })

  it('endDate 筛选 → lte 被调用（含当天 23:59:59 北京字面补偿）', async () => {
    mockLogChain([])

    await getLogs({ endDate: '2026-03-31' })

    const lteCall = (lte as any).mock.calls.find((c: any[]) => c[0] === 'created_at')
    expect(lteCall).toBeTruthy()
    // 日期串拼北京字面 23:59:59::timestamp（不经 new Date——date-only UTC 午夜解析会 +8h）
    expect((lteCall[1] as any).vals[0]).toBe('2026-03-31 23:59:59')
  })

  it('空结果 → 返回 []', async () => {
    mockLogChain([])

    const result = await getLogs()

    expect(result).toEqual([])
  })

  it('detail 为 null → 序列化为 null', async () => {
    mockLogChain([{ ...mockLogRow, detail: null }])

    const result = await getLogs()

    expect(result[0].detail).toBeNull()
  })

  it('分页查询 → count + limit/offset', async () => {
    const countChain: any = {}
    countChain.from = vi.fn().mockReturnValue(countChain)
    countChain.where = vi.fn().mockResolvedValue([{ count: 42 }])

    const dataChain: any = {}
    dataChain.from = vi.fn().mockReturnValue(dataChain)
    dataChain.where = vi.fn().mockReturnValue(dataChain)
    dataChain.orderBy = vi.fn().mockReturnValue(dataChain)
    dataChain.limit = vi.fn().mockReturnValue(dataChain)
    dataChain.offset = vi.fn().mockResolvedValue([mockLogRow])
    ;(db.select as any).mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain)

    const result = await getLogsPaginated({ page: 3, pageSize: 20 })

    expect(result.total).toBe(42)
    expect(result.data).toHaveLength(1)
    expect(dataChain.limit).toHaveBeenCalledWith(20)
    expect(dataChain.offset).toHaveBeenCalledWith(40)
  })

  it('非 admin 合并已展开门店节点与角色市场 scope 节点', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'manager', scopeId: 'market-node-1', scopeType: '市场' }],
      permissions: { actions: ['operation_log:list'], scopeStoreIds: ['store-allowed'] },
    })
    ;(isAdminScope as any).mockReturnValueOnce(false)

    const scopeChain: any = {
      from: vi.fn(),
      where: vi.fn(),
    }
    scopeChain.from.mockReturnValue(scopeChain)
    scopeChain.where.mockResolvedValue([{ orgNodeId: 'store-node-allowed' }])
    ;(db.select as any).mockReturnValueOnce(scopeChain)
    mockLogChain([])

    await getLogs()

    expect(inArray).toHaveBeenCalledWith('store_id', ['store-allowed'])
    expect(inArray).toHaveBeenCalledWith('org_node_id', ['store-node-allowed', 'market-node-1'])
  })

  it('非 admin 无可见门店时仍保留全部角色的实际 scope 节点', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [
        { role: 'manager', scopeId: 'market-node-1', scopeType: '市场' },
        { role: 'finance', scopeId: 'hq-node-1', scopeType: '总部' },
      ],
      permissions: { actions: ['operation_log:list'], scopeStoreIds: [] },
    })
    ;(isAdminScope as any).mockReturnValueOnce(false)
    mockLogChain([])

    await getLogs()

    expect(inArray).toHaveBeenCalledWith('org_node_id', ['market-node-1', 'hq-node-1'])
  })

  it('市场筛选同时包含市场节点日志与其门店节点日志', async () => {
    const marketChain: any = {
      from: vi.fn(),
      where: vi.fn(),
    }
    marketChain.from.mockReturnValue(marketChain)
    marketChain.where.mockResolvedValue([{ id: 'store-node-allowed' }])
    ;(db.select as any).mockReturnValueOnce(marketChain)
    mockLogChain([])

    await getLogs({ marketId: 'market-node-1' })

    expect(inArray).toHaveBeenCalledWith('org_node_id', ['market-node-1', 'store-node-allowed'])
  })
})

// ── getOrderLogs ──────────────────────────────────────────────────────────────

describe('getOrderLogs — 订单操作日志', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('按 targetType=sale_order + targetId 查询', async () => {
    mockLogChainNoLimit([mockLogRow])

    const result = await getOrderLogs('FY-XSD-WX-260315-0001')

    expect(result).toHaveLength(1)
    expect(eq).toHaveBeenCalledWith('target_type', 'sale_order')
    expect(eq).toHaveBeenCalledWith('target_id', 'FY-XSD-WX-260315-0001')
  })

  it('无日志 → 返回 []', async () => {
    mockLogChainNoLimit([])

    const result = await getOrderLogs('FY-XSD-WX-999')

    expect(result).toEqual([])
  })

  it('admin（仅 operation_log:list）也可查看订单日志', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'admin' }],
      permissions: { actions: ['operation_log:list'], scopeStoreIds: [] },
    })
    mockLogChainNoLimit([mockLogRow])

    const result = await getOrderLogs('FY-XSD-WX-260315-0001')

    expect(result).toHaveLength(1)
  })

  it('manager（仅 sale_order:list）也可查看订单日志', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'manager' }],
      permissions: { actions: ['sale_order:list'], scopeStoreIds: ['store-1'] },
    })
    mockLogChainNoLimit([mockLogRow])

    const result = await getOrderLogs('FY-XSD-WX-260315-0001')

    expect(result).toHaveLength(1)
  })

  it('无两个权限 → 抛 PERMISSION_DENIED', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'staff' }],
      permissions: { actions: [], scopeStoreIds: [] },
    })

    await expect(getOrderLogs('FY-XSD-WX-260315-0001')).rejects.toThrow('PERMISSION_DENIED')
  })
})

// ── deleteOperationLog — 物理删除 ─────────────────────────────────────────

describe('deleteOperationLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function mockSelectRow(rows: any[]) {
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)
  }

  it('日志不存在 → 拒绝，不删除', async () => {
    mockSelectRow([])
    const result = await deleteOperationLog(999)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('日志存在 → 物理删除 + 审计', async () => {
    mockSelectRow([{ action: 'order.create', targetType: 'sale_order', targetId: 'O-1', operatorName: '张三', createdAt: new Date('2026-05-01T00:00:00Z') }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    const result = await deleteOperationLog(1)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'operation_log.delete', 'operation_log', '1',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('删除 rowCount=0 → 拒绝', async () => {
    mockSelectRow([{ action: 'x', targetType: 'y', targetId: 'z', operatorName: null, createdAt: new Date() }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 0 }) })
    const result = await deleteOperationLog(1)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })
})
