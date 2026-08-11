import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoleDefinitions: {
    roleKey: 'role_key',
    name: 'name',
    description: 'description',
    actions: 'actions',
    canAccessAdmin: 'can_access_admin',
    isSuperAdmin: 'is_super_admin',
    isStoreManager: 'is_store_manager',
    updatedAt: 'updated_at',
  },
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', isResigned: 'is_resigned' },
}))

vi.mock('@/lib/with-permission', () => ({
  withPermission: vi.fn((_action: string, handler: Function) => (
    async (...args: unknown[]) => handler({ employeeId: 'ADMIN-001' }, ...args)
  )),
  withAnyPermission: vi.fn((_actions: string[], handler: Function) => handler),
}))

vi.mock('@/lib/permissions', () => ({
  requireAdmin: vi.fn(),
  invalidatePermissionMatrixCache: vi.fn(),
  KNOWN_PERMISSION_ACTIONS: [],
}))

vi.mock('@/lib/permission-contract', () => ({
  ADMIN_ONLY_ACTIONS: [],
  getMissingUiDependencies: vi.fn(() => []),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
}))

vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((column: unknown) => ({ type: 'asc', column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  ne: vi.fn((left: unknown, right: unknown) => ({ type: 'ne', left, right })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    { raw: vi.fn((value: string) => value) },
  ),
}))

import { db } from '@/db'
import { updateRoleDefinition } from './role-definitions'

function mockSelectOnce(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return { from }
}

describe('updateRoleDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('拒绝将已有非总部授权的角色升级为超级管理员', async () => {
    const before = {
      roleKey: 'role-market-manager',
      name: '市场经理',
      description: null,
      actions: ['dashboard:view'],
      canAccessAdmin: true,
      isSuperAdmin: false,
      isStoreManager: false,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    }
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
    ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ exists: 1 }])

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      isSuperAdmin: true,
      actions: ['system:config', 'permission:assign_admin', 'admin:reset_password'],
    })).rejects.toThrow(/INVALID_STATE.*非总部范围分配.*不能直接升级/)

    expect(db.transaction).not.toHaveBeenCalled()
  })
})
