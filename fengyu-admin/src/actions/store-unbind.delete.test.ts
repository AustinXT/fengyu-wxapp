import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), delete: vi.fn() },
}))

vi.mock('@db/store-unbind', () => ({
  storeUnbindRequests: {
    requestId: 'request_id',
    status: 'status',
    fromStoreId: 'from_store_id',
    userId: 'user_id',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: { userId: 'user_id', name: 'name' },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((table, _name) => table),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteUnbindRequest } from './store-unbind'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['store_unbind:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

describe('deleteUnbindRequest — 守卫 + 删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('申请不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deleteUnbindRequest('REQ-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('待处理申请 → 拒绝', async () => {
    mockSelect([{ status: '待处理', fromStoreId: 'S1', userId: 'U1' }])
    const result = await deleteUnbindRequest('REQ-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('待处理')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('超出 scope → 拒绝', async () => {
    mockSelect([{ status: '已通过', fromStoreId: 'S1', userId: 'U1' }])
    ;(isInScope as any).mockReturnValue(false)
    const result = await deleteUnbindRequest('REQ-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('已处理申请 → 删除成功 + 审计', async () => {
    mockSelect([{ status: '已拒绝', fromStoreId: 'S1', userId: 'U1' }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    const result = await deleteUnbindRequest('REQ-3')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'store_unbind.delete', 'store_unbind_request', 'REQ-3',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('删除 rowCount=0 → 提示刷新', async () => {
    mockSelect([{ status: '已通过', fromStoreId: 'S1', userId: 'U1' }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 0 }) })
    const result = await deleteUnbindRequest('REQ-4')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
