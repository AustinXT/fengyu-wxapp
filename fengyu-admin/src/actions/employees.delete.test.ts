import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', name: 'name', phone: 'phone', storeId: 'store_id', isResigned: 'is_resigned' },
}))
vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id' },
}))
vi.mock('@db/permission', () => ({ permissionRoles: { employeeId: 'employee_id' } }))
vi.mock('@db/admin-auth', () => ({ adminPasswords: { employeeId: 'employee_id' } }))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  desc: vi.fn((c) => ({ type: 'desc', c })),
  asc: vi.fn((c) => ({ type: 'asc', c })),
}))
vi.mock('drizzle-orm/pg-core', () => ({ alias: vi.fn((t) => t) }))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn(async () => 3),
  isAdminEmployee: vi.fn(async () => false),
}))
vi.mock('@/lib/datetime', () => ({ shanghaiToday: vi.fn(() => '2026-06-01') }))
vi.mock('@/lib/list-filters', () => ({ parseEmployeeFilters: vi.fn(() => ({})) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteEmployee } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { isAdminEmployee, countActiveAdmins } from '@/lib/admin-guard'
import { staffWechatUsers } from '@db/user'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

/** 事务：staffWechatUsers 删除按 staffResult 控制（count 或 throw），其余从属删除恒成功 */
function setupTx(staffResult: { count?: number; throwErr?: any }) {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockImplementation((table: any) => ({
        where: vi.fn().mockImplementation(async () => {
          if (table === staffWechatUsers) {
            if (staffResult.throwErr) throw staffResult.throwErr
            return { count: staffResult.count ?? 1 }
          }
          return { count: 1 }
        }),
      })),
    }
    return fn(tx)
  })
}

describe('deleteEmployee — 守卫 + 级联 + FK 兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminEmployee as any).mockResolvedValue(false)
    ;(countActiveAdmins as any).mockResolvedValue(3)
  })

  it('删除自己 → 拒绝', async () => {
    const result = await deleteEmployee('ADMIN-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('自己')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('员工不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deleteEmployee('EMP-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('最后一个活跃管理员 → 拒绝', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false }])
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(1)
    const result = await deleteEmployee('EMP-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('最后一个活跃管理员')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('纯测试号 → 级联删除成功 + 审计', async () => {
    mockSelect([{ name: '测试', phone: '13800000001', storeId: 'S1', isResigned: false }])
    setupTx({ count: 1 })
    const result = await deleteEmployee('EMP-TEST')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'employee.delete', 'employee', 'EMP-TEST',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('被业务表引用（23503）→ 回滚 + 提示改离职', async () => {
    mockSelect([{ name: '老员工', phone: '13800000002', storeId: 'S1', isResigned: false }])
    const fkErr: any = new Error('insert or update violates foreign key constraint')
    fkErr.code = '23503'
    setupTx({ throwErr: fkErr })
    const result = await deleteEmployee('EMP-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('业务关联')
    expect(result.message).toContain('离职')
  })

  it('主表删除 rowCount=0（并发）→ 提示刷新', async () => {
    mockSelect([{ name: 'x', phone: '13800000003', storeId: 'S1', isResigned: false }])
    setupTx({ count: 0 })
    const result = await deleteEmployee('EMP-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
