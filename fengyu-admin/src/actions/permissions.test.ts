import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB and schema modules before importing the action
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
    scopeId: 'scope_id',
    isVoid: 'is_void',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    voidedAt: 'voided_at',
    updatedBy: 'updated_by',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { name: 'name', employeeId: 'employee_id' },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', name: 'name' },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  hasRole: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
}))

import { getRoles } from './permissions'
import { db } from '@/db'
import { getSession, hasRole } from '@/lib/auth'
import { inArray } from 'drizzle-orm'

function makeRow(scopeId: string) {
  return {
    id: 1,
    employeeId: 'EMP-001',
    role: 'manager',
    scopeId,
    isVoid: false,
    createdBy: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    employeeName: '张三',
    scopeName: '门店A',
  }
}

function setupDbSelect(returnValue: any[]) {
  const orderBy = vi.fn().mockResolvedValue(returnValue)
  const where = vi.fn().mockReturnValue({ orderBy })
  const leftJoin2 = vi.fn().mockReturnValue({ where })
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
  const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
  ;(db.select as any).mockReturnValue({ from })
  return { where }
}

describe('getRoles — scope filtering (AC-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin 用户：不加 scope 过滤，inArray 不被调用', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
    ;(hasRole as any).mockReturnValue(true)
    setupDbSelect([makeRow('store-1'), makeRow('store-2')])

    const result = await getRoles()

    expect(result).toHaveLength(2)
    expect(inArray).not.toHaveBeenCalled()
  })

  it('非 admin 用户：inArray 被调用，仅传入自身 scopeIds', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'HR-001',
      roles: [{ role: 'hr', scopeId: 'store-42' }],
    })
    ;(hasRole as any).mockReturnValue(false)
    setupDbSelect([makeRow('store-42')])

    const result = await getRoles()

    expect(result).toHaveLength(1)
    expect(inArray).toHaveBeenCalledOnce()
    const [, scopeIds] = (inArray as any).mock.calls[0]
    expect(scopeIds).toEqual(['store-42'])
  })

  it('非 admin 用户 scopeIds 为空：直接返回空数组，不查 DB', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'EMP-002',
      roles: [],
    })
    ;(hasRole as any).mockReturnValue(false)

    const result = await getRoles()

    expect(result).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('返回结果字段映射正确（createdAt 转 ISO 字符串）', async () => {
    ;(getSession as any).mockResolvedValue({
      employeeId: 'ADMIN-001',
      roles: [{ role: 'admin', scopeId: 'hq-1' }],
    })
    ;(hasRole as any).mockReturnValue(true)
    setupDbSelect([makeRow('store-1')])

    const result = await getRoles()

    expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(result[0].updatedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(result[0].employeeName).toBe('张三')
    expect(result[0].scopeName).toBe('门店A')
  })
})
