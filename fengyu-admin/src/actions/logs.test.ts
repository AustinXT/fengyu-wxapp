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

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  like: vi.fn((a, b) => ({ type: 'like', a, b })),
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
  requireAnyPermission: vi.fn((session: any, actions: string[]) => {
    if (!session) throw new Error('NO_SESSION')
    const has = actions.some((a: string) => session.permissions?.actions?.includes(a))
    if (!has) throw new Error(`PERMISSION_DENIED: 无权执行 ${actions.join(' 或 ')}`)
  }),
}))

import { getLogs, getOrderLogs, deleteOperationLog } from './logs'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { eq, like, gte, lte } from 'drizzle-orm'

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

/** mock select chain: select → from → where → orderBy → limit */
function mockLogChain(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
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

  it('endDate 筛选 → lte 被调用（含 T23:59:59 补偿）', async () => {
    mockLogChain([])

    await getLogs({ endDate: '2026-03-31' })

    expect(lte).toHaveBeenCalledWith('created_at', new Date('2026-03-31T23:59:59'))
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
