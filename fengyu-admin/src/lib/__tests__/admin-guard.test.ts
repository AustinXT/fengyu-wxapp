import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
    scopeId: 'scope_id',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: {
    employeeId: 'employee_id',
    isResigned: 'is_resigned',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), { raw: vi.fn((s: string) => s) }),
}))

import { countActiveAdmins, isAdminEmployee } from '../admin-guard'
import { db } from '@/db'

function setupCountSelect(returnValue: number) {
  const limit = vi.fn().mockResolvedValue([{ c: returnValue }])
  const where = vi.fn().mockReturnValue({ limit })
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ where, innerJoin })
  ;(db.select as any).mockReturnValue({ from })
  // 同时让 .where(...) 直接 await 出 array（countActiveAdmins 不带 .limit）
  where.mockImplementation(() => Promise.resolve([{ c: returnValue }]))
  // 但 isAdminEmployee 带 .limit，需要支持链
  return { limit, where, innerJoin, from }
}

describe('admin-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('countActiveAdmins', () => {
    it('返回活跃 admin 行数（is_resigned=false JOIN）', async () => {
      const where = vi.fn().mockResolvedValue([{ c: 3 }])
      const innerJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ innerJoin })
      ;(db.select as any).mockReturnValue({ from })

      const n = await countActiveAdmins()
      expect(n).toBe(3)
      expect(db.select).toHaveBeenCalledTimes(1)
    })

    it('无行时返回 0（空结果）', async () => {
      const where = vi.fn().mockResolvedValue([])
      const innerJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ innerJoin })
      ;(db.select as any).mockReturnValue({ from })

      const n = await countActiveAdmins()
      expect(n).toBe(0)
    })
  })

  describe('isAdminEmployee', () => {
    it('该员工持有 admin 角色 → true', async () => {
      const limit = vi.fn().mockResolvedValue([{ c: 1 }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      ;(db.select as any).mockReturnValue({ from })

      const r = await isAdminEmployee('EMP-001')
      expect(r).toBe(true)
    })

    it('该员工无 admin 角色 → false', async () => {
      const limit = vi.fn().mockResolvedValue([{ c: 0 }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      ;(db.select as any).mockReturnValue({ from })

      const r = await isAdminEmployee('EMP-002')
      expect(r).toBe(false)
    })
  })
})
