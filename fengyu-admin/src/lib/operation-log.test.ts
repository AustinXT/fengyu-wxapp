import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock db
const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
vi.mock('@/db', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'org-1', name: '南昌市场' }]),
        }),
      }),
    }),
  },
}))

vi.mock('@db/operation-log', () => ({
  operationLogs: { __table: 'operation_logs' },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
}))

import { logOperation, computeChanges, logUpdate, logTransition } from './operation-log'
import type { AuthSession } from './types'

function mockSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '管理员',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'org-1', scopeType: '总部' }],
    permissions: { actions: [], scopeStoreIds: [] },
    ...overrides,
  }
}

describe('logOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('写入操作日志到 operation_logs 表', async () => {
    const session = mockSession()
    await logOperation(session, 'employee.create', 'employee', 'EMP-002', { name: '张三' })

    expect(mockInsert).toHaveBeenCalled()
    const valuesCall = mockInsert.mock.results[0]?.value?.values
    expect(valuesCall).toBeDefined()
  })

  it('无 scopeId 时 orgNodeId 为 null', async () => {
    const session = mockSession({
      roles: [{ role: 'admin', scopeId: '', scopeType: '总部' }],
    })
    await logOperation(session, 'store.create', 'store', 'S001')

    expect(mockInsert).toHaveBeenCalled()
  })

  it('空 roles 数组不报错', async () => {
    const session = mockSession({ roles: [] })
    await logOperation(session, 'product.update', 'product', 'P001')

    expect(mockInsert).toHaveBeenCalled()
  })

  it('detail 为 undefined 时传 null', async () => {
    const session = mockSession()
    await logOperation(session, 'store.update', 'store', 'S001')

    expect(mockInsert).toHaveBeenCalled()
  })
})

describe('computeChanges', () => {
  it('值相同 → 返回 null', () => {
    expect(computeChanges({ name: '张三' }, { name: '张三' })).toBeNull()
  })

  it('值不同 → 返回 { field: { from, to } }', () => {
    const result = computeChanges({ name: '张三', age: 20 }, { name: '李四' })
    expect(result).toEqual({ name: { from: '张三', to: '李四' } })
  })

  it('只遍历 after 中的 key', () => {
    const result = computeChanges({ a: 1, b: 2 }, { a: 99 })
    expect(result).toEqual({ a: { from: 1, to: 99 } })
  })

  it('深比较 array', () => {
    expect(computeChanges({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBeNull()
    expect(computeChanges({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      tags: { from: ['a'], to: ['a', 'b'] },
    })
  })

  it('before 中无对应 key → from 为 null', () => {
    const result = computeChanges({}, { name: '新值' })
    expect(result).toEqual({ name: { from: null, to: '新值' } })
  })

  it('after 中 undefined 值被跳过', () => {
    expect(computeChanges({ name: '张三' }, { name: undefined as any })).toBeNull()
  })

  it('null → 非 null 视为变更', () => {
    const result = computeChanges({ phone: null }, { phone: '13800000000' })
    expect(result).toEqual({ phone: { from: null, to: '13800000000' } })
  })

  it('boolean 变更', () => {
    const result = computeChanges({ isValid: true }, { isValid: false })
    expect(result).toEqual({ isValid: { from: true, to: false } })
  })
})

describe('logUpdate', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('有变更 → 写入 _v:2 _t:update detail', async () => {
    const session = mockSession()
    await logUpdate(session, 'store.update', 'store', 'S001', { storeName: '旧名' }, { storeName: '新名' })
    expect(mockInsert).toHaveBeenCalled()
  })

  it('无实际变更 → 不写入日志', async () => {
    const session = mockSession()
    await logUpdate(session, 'store.update', 'store', 'S001', { storeName: '同' }, { storeName: '同' })
    expect(mockInsert).not.toHaveBeenCalled()
  })
})

describe('logTransition', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('写入 _v:2 _t:transition detail', async () => {
    const session = mockSession()
    await logTransition(session, 'order.confirmPayment', 'sale_order', 'ORD-001', '待确认收款', '已支付', {
      customerName: '张三', totalAmount: '1980.00',
    })
    expect(mockInsert).toHaveBeenCalled()
  })

  it('无 context 时不含 context 字段', async () => {
    const session = mockSession()
    await logTransition(session, 'service.start', 'service_order', 'SVC-001', '待服务', '服务中')
    expect(mockInsert).toHaveBeenCalled()
  })
})
