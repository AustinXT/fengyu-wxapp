/**
 * ticket 2026-05-18 admin-permission-matrix-db-storage：
 * actions/permission-matrix.ts 单测覆盖 happy/校验/重置/权限拒绝四条主路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { requirePermissionMock, invalidateCacheMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(),
  },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    vi.fn((...args: unknown[]) => ({ type: 'sql', args })),
    { raw: vi.fn(), join: vi.fn() },
  ),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/permissions')>('@/lib/permissions')
  return {
    ...actual,
    requirePermission: requirePermissionMock,
    invalidatePermissionMatrixCache: invalidateCacheMock,
  }
})

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { getMatrix, saveMatrix, resetMatrix } from '../permission-matrix'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { DEFAULT_PERMISSION_MATRIX } from '@/lib/permissions'
import type { RoleType } from '@/lib/types'

const adminSession = {
  employeeId: 'ADM-001',
  name: '测试管理员',
  phone: '13800000000',
  roles: [{ role: 'admin' as RoleType, scopeId: 'hq', scopeType: '总部' as const }],
  permissions: {
    actions: ['system:config', 'permission:assign_admin', 'admin:reset_password'],
    scopeStoreIds: [],
  },
}

/** 一个合法 newMatrix（admin 含必备 3 action，其它角色保持 DEFAULT） */
function buildValidMatrix(): Record<RoleType, string[]> {
  return {
    admin: [
      'dashboard:view',
      'employee:list',
      'org:list',
      'permission:list',
      'system:config',
      'permission:assign_admin',
      'admin:reset_password',
    ],
    manager: ['dashboard:view', 'sale_order:list'],
    finance: [],
    hr: [],
    product: [],
    customer_mgr: [],
    staff: [],
  }
}

function resetDbExecuteMock() {
  ;(db.execute as any).mockReset()
}

describe('getMatrix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDbExecuteMock()
    ;(getSession as any).mockResolvedValue(adminSession)
    requirePermissionMock.mockImplementation(() => {})
  })

  it('DB 行存在时清洗未知权限并规范化排序', async () => {
    const stored = {
      admin: ['store:list', 'unknown:action', 'dashboard:view'],
      manager: [], finance: [], hr: [], product: [], customer_mgr: [], staff: [],
    }
    ;(db.execute as any).mockResolvedValueOnce([{ value: JSON.stringify(stored) }])
    const result = await getMatrix()
    expect(result.admin).toEqual(['dashboard:view', 'store:list'])
  })

  it('DB 行缺失时回退 DEFAULT', async () => {
    ;(db.execute as any).mockResolvedValueOnce([])
    const result = await getMatrix()
    expect(result.admin.length).toBeGreaterThan(0)
    expect(result.admin).toContain('system:config')
  })

  it('DB throw 时回退 DEFAULT，不向上抛', async () => {
    ;(db.execute as any).mockRejectedValueOnce(new Error('boom'))
    const result = await getMatrix()
    expect(result.admin).toEqual([...DEFAULT_PERMISSION_MATRIX.admin].sort())
  })

  it('权限不足时 requirePermission 抛出 → getMatrix 抛出', async () => {
    requirePermissionMock.mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权执行 system:config')
    })
    await expect(getMatrix()).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('saveMatrix — 防自锁校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDbExecuteMock()
    ;(getSession as any).mockResolvedValue(adminSession)
    requirePermissionMock.mockImplementation(() => {})
  })

  it('缺失 system:config 拒绝', async () => {
    const m = buildValidMatrix()
    m.admin = m.admin.filter((a) => a !== 'system:config')
    const res = await saveMatrix(m)
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/INVALID_PARAMS/)
    expect(res.message).toContain('system:config')
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('缺失 permission:assign_admin 拒绝', async () => {
    const m = buildValidMatrix()
    m.admin = m.admin.filter((a) => a !== 'permission:assign_admin')
    const res = await saveMatrix(m)
    expect(res.success).toBe(false)
    expect(res.message).toContain('permission:assign_admin')
  })

  it('缺失 admin:reset_password 拒绝', async () => {
    const m = buildValidMatrix()
    m.admin = m.admin.filter((a) => a !== 'admin:reset_password')
    const res = await saveMatrix(m)
    expect(res.success).toBe(false)
    expect(res.message).toContain('admin:reset_password')
  })
})

describe('saveMatrix — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDbExecuteMock()
    ;(getSession as any).mockResolvedValue(adminSession)
    requirePermissionMock.mockImplementation(() => {})
  })

  it('合法矩阵：UPSERT + logOperation + invalidate cache + revalidate', async () => {
    ;(db.execute as any)
      .mockResolvedValueOnce([]) // before 快照查询：空 → 走 DEFAULT
      .mockResolvedValueOnce([]) // UPSERT
    const m = buildValidMatrix()
    const res = await saveMatrix(m)

    expect(res.success).toBe(true)
    expect(res.message).toContain('权限矩阵已保存')

    // 共两次 execute：查 before + UPSERT
    expect(db.execute).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      adminSession,
      'permission_matrix.update',
      'system_config',
      'permission_matrix',
      expect.objectContaining({ before: expect.any(Object), after: expect.any(Object) }),
    )
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1)
  })

  it('before 已有旧值：diff 中携带 before/after', async () => {
    const oldMatrix = { ...buildValidMatrix(), manager: ['dashboard:view'] }
    ;(db.execute as any)
      .mockResolvedValueOnce([{ value: JSON.stringify(oldMatrix) }])
      .mockResolvedValueOnce([])
    const m = buildValidMatrix()
    await saveMatrix(m)
    expect(logOperation).toHaveBeenCalled()
    const callDetail = (logOperation as any).mock.calls[0][4]
    expect(callDetail.before.manager).toEqual(['dashboard:view'])
    expect(callDetail.after.manager).toEqual(['dashboard:view', 'sale_order:list'])
  })

  it('UPSERT throw 时返回 success:false 且不 invalidate 缓存', async () => {
    ;(db.execute as any)
      .mockResolvedValueOnce([]) // before
      .mockRejectedValueOnce(new Error('db down')) // UPSERT
    const res = await saveMatrix(buildValidMatrix())
    expect(res.success).toBe(false)
    expect(res.message).toContain('保存失败')
    expect(invalidateCacheMock).not.toHaveBeenCalled()
  })

  it('非 system:config 权限拒绝（requirePermission 抛错）', async () => {
    requirePermissionMock.mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权执行 system:config')
    })
    await expect(saveMatrix(buildValidMatrix())).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })
})

describe('resetMatrix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDbExecuteMock()
    ;(getSession as any).mockResolvedValue(adminSession)
    requirePermissionMock.mockImplementation(() => {})
  })

  it('DELETE + log + invalidate + revalidate', async () => {
    ;(db.execute as any).mockResolvedValueOnce([])
    const res = await resetMatrix()
    expect(res.success).toBe(true)
    expect(res.message).toContain('已重置')
    expect(db.execute).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      adminSession,
      'permission_matrix.reset',
      'system_config',
      'permission_matrix',
      expect.any(Object),
    )
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1)
  })

  it('DELETE throw 时返回 success:false', async () => {
    ;(db.execute as any).mockRejectedValueOnce(new Error('db down'))
    const res = await resetMatrix()
    expect(res.success).toBe(false)
    expect(res.message).toContain('重置失败')
    expect(invalidateCacheMock).not.toHaveBeenCalled()
  })

  it('非 system:config 权限拒绝', async () => {
    requirePermissionMock.mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED')
    })
    await expect(resetMatrix()).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })
})
