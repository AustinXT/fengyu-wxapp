import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), delete: vi.fn() },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id', name: 'name', phone: 'phone',
    boundStoreId: 'bound_store_id', memberLevel: 'member_level',
  },
}))
vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name', parentId: 'parent_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((c) => ({ type: 'desc', c })),
  asc: vi.fn((c) => ({ type: 'asc', c })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  isNotNull: vi.fn((c) => ({ type: 'isNotNull', c })),
  getTableColumns: vi.fn(() => ({})),
  sql: Object.assign(
    vi.fn(() => ({ as: vi.fn(() => ({})) })),
    { raw: vi.fn(), join: vi.fn() },
  ),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(), hasRole: vi.fn(() => true) }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isAdminScope: vi.fn(() => true),
  isInScope: vi.fn(() => true),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteCustomer } from './customers'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['customer:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

describe('deleteCustomer — 守卫 + FK 兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('顾客不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deleteCustomer('U-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('无业务关联 → 删除成功 + 审计', async () => {
    mockSelect([{ name: '测试客', phone: '13800000001', boundStoreId: null, memberLevel: '初钻' }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    const result = await deleteCustomer('U-TEST')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'customer.delete', 'customer', 'U-TEST',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('被订单/积分等引用（23503）→ 拒绝', async () => {
    mockSelect([{ name: '老客', phone: '13800000002', boundStoreId: 'S1', memberLevel: '金钻' }])
    const fkErr: any = new Error('violates foreign key constraint')
    fkErr.code = '23503'
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockRejectedValue(fkErr) })
    const result = await deleteCustomer('U-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('业务关联')
  })

  it('删除 rowCount=0（并发）→ 提示刷新', async () => {
    mockSelect([{ name: 'x', phone: '13800000003', boundStoreId: null, memberLevel: null }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 0 }) })
    const result = await deleteCustomer('U-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
