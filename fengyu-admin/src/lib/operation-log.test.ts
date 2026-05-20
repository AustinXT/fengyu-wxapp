import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock db — capture last detail passed to values() for assertion
const capturedValues: Array<Record<string, unknown>> = []
const mockValues = vi.fn(async (v: Record<string, unknown>) => {
  capturedValues.push(v)
  return {}
})
const mockInsert = vi.fn().mockReturnValue({ values: mockValues })
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
    capturedValues.length = 0
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
    expect(capturedValues[0]!.detail).toBeNull()
  })

  it('detail.phone 入库时被 mask（sanitizeDetail 接入）', async () => {
    const session = mockSession()
    await logOperation(session, 'customer.update', 'customer', 'C-001', {
      phone: '13812345678',
      name: '张三',
      idCard: '110101199001011234',
      email: 'foo@bar.com',
      openid: 'oABC1234XYZ5678',
      amount: 100,
    })
    expect(mockInsert).toHaveBeenCalled()
    const detail = capturedValues[0]!.detail as Record<string, unknown>
    expect(detail.phone).toBe('138****5678')
    expect(detail.name).toBe('张三') // name 不在 SENSITIVE_KEYS 默认表
    expect(detail.idCard).toBe('1101**********1234')
    expect(detail.email).toBe('f*o@bar.com')
    expect(detail.openid).toBe('oABC*******5678')
    expect(detail.amount).toBe(100) // 非敏感字段保持原值
  })

  it('detail 嵌套对象内 phone 也被脱敏', async () => {
    const session = mockSession()
    await logOperation(session, 'customer.update', 'customer', 'C-001', {
      snapshot: { phone: '13812345678', nickname: '小明' },
    })
    const detail = capturedValues[0]!.detail as { snapshot: { phone: string; nickname: string } }
    expect(detail.snapshot.phone).toBe('138****5678')
    expect(detail.snapshot.nickname).toBe('小明')
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
  beforeEach(() => { vi.clearAllMocks(); capturedValues.length = 0 })

  it('有变更 → 写入 _v:3 _t:update detail', async () => {
    const session = mockSession()
    await logUpdate(session, 'store.update', 'store', 'S001', { storeName: '旧名' }, { storeName: '新名' })
    expect(mockInsert).toHaveBeenCalled()
    const detail = capturedValues[0]!.detail as { _v: number; _t: string }
    expect(detail._v).toBe(3)
    expect(detail._t).toBe('update')
  })

  it('无实际变更 → 不写入日志', async () => {
    const session = mockSession()
    await logUpdate(session, 'store.update', 'store', 'S001', { storeName: '同' }, { storeName: '同' })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('changes.phone.from/to 通过继承 key 上下文被脱敏（ticket §6.5 验证项）', async () => {
    const session = mockSession()
    await logUpdate(session, 'customer.update', 'customer', 'C-001',
      { phone: '13800000000' },
      { phone: '13812345678' })
    const detail = capturedValues[0]!.detail as { changes: Record<string, { from: unknown; to: unknown }> }
    expect(detail.changes.phone.from).toBe('138****0000')
    expect(detail.changes.phone.to).toBe('138****5678')
  })

  it('changes.amount 等非敏感 diff 字段保持原值', async () => {
    const session = mockSession()
    await logUpdate(session, 'order.update', 'sale_order', 'ORD-001',
      { amount: '100.00' },
      { amount: '200.00' })
    const detail = capturedValues[0]!.detail as { changes: Record<string, { from: unknown; to: unknown }> }
    expect(detail.changes.amount.from).toBe('100.00')
    expect(detail.changes.amount.to).toBe('200.00')
  })
})

describe('logTransition', () => {
  beforeEach(() => { vi.clearAllMocks(); capturedValues.length = 0 })

  it('写入 _v:3 _t:transition detail', async () => {
    const session = mockSession()
    await logTransition(session, 'order.confirmPayment', 'sale_order', 'ORD-001', '待支付', '已支付', {
      customerName: '张三', totalAmount: '1980.00',
    })
    expect(mockInsert).toHaveBeenCalled()
    const detail = capturedValues[0]!.detail as { _v: number; _t: string }
    expect(detail._v).toBe(3)
    expect(detail._t).toBe('transition')
  })

  it('无 context 时不含 context 字段', async () => {
    const session = mockSession()
    await logTransition(session, 'service.start', 'service_order', 'SVC-001', '待服务', '服务中')
    expect(mockInsert).toHaveBeenCalled()
  })

  it('context.phone 字段被脱敏', async () => {
    const session = mockSession()
    await logTransition(session, 'order.confirmPayment', 'sale_order', 'ORD-001', '待支付', '已支付', {
      phone: '13812345678', amount: '100.00',
    })
    const detail = capturedValues[0]!.detail as { context: { phone: string; amount: string } }
    expect(detail.context.phone).toBe('138****5678')
    expect(detail.context.amount).toBe('100.00')
  })
})
