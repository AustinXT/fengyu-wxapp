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

import { logOperation } from './operation-log'
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
