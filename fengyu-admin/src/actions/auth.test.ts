import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}

// sessionCookieOptions 读取 x-forwarded-proto 判定 Secure；默认无该头（→ HTTP，不加 Secure）
const mockHeaders = {
  get: vi.fn(() => null),
}

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
  headers: vi.fn(() => Promise.resolve(mockHeaders)),
}))

vi.mock('jose', () => {
  // SignJWT 需要可被 new 调用，用 class mock
  class MockSignJWT {
    setProtectedHeader() { return this }
    setExpirationTime() { return this }
    setIssuedAt() { return this }
    async sign() { return 'mock-jwt-token' }
  }
  return {
    SignJWT: MockSignJWT,
    jwtVerify: vi.fn(),
  }
})

vi.mock('bcryptjs', () => ({
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$2b$12$hashed'),
}))

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@db/admin-auth', () => ({
  adminPasswords: {
    id: 'id',
    employeeId: 'employee_id',
    passwordHash: 'password_hash',
    mustChange: 'must_change',
    lastChangedAt: 'last_changed_at',
  },
}))

vi.mock('@db/login-attempt', () => ({
  loginAttempts: {
    phone: 'phone',
    failCount: 'fail_count',
    lockedUntil: 'locked_until',
    lastFailedAt: 'last_failed_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: {
    employeeId: 'employee_id',
    name: 'name',
    phone: 'phone',
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    employeeId: 'employee_id',
    role: 'role',
    scopeId: 'scope_id',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', type: 'type' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(
    vi.fn((...args) => ({ type: 'sql', args })),
    {},
  ),
}))

vi.mock('@/lib/permissions', () => ({
  computeActions: vi.fn(() => ['dashboard:view']),
  expandScopeStoreIds: vi.fn(async () => ['store-1']),
  expandScopeDeptNodeIds: vi.fn(async () => ['dept-1']),
  // 登录闸 / 会话二次闸用：真实判定（持任一非 staff 角色即可入后台）
  canAccessAdmin: vi.fn((roles: Array<{ role: string }>) => roles.some((r) => r.role !== 'staff')),
  // 2026-05-17 PR-Z2 后：resetEmployeePassword/resetToDefaultPassword 走 withPermission HOF，
  // HOF 内部会调 requirePermission；mock 模拟真实语义 — null session 抛 UNAUTHORIZED，
  // 缺权限抛 PERMISSION_DENIED（让"未登录 / 非 admin"测试用例短路到 catch 块）
  requirePermission: vi.fn((session: any, action: string) => {
    if (!session) {
      throw new Error('UNAUTHORIZED: 未登录或登录已过期')
    }
    if (!session.permissions?.actions?.includes(action)) {
      throw new Error(`PERMISSION_DENIED: 仅系统管理员可操作`)
    }
  }),
}))

// HOF 用 getSession（lib/auth.ts）拿 session；默认返回 admin session，
// 单测可通过 vi.mocked(getSession).mockResolvedValueOnce(null|otherSession) 覆盖
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => ({
    employeeId: 'EMP-001',
    name: '测试 admin',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' as const }],
    permissions: { actions: ['admin:reset_password'], scopeStoreIds: [] },
  })),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  login,
  logout,
  changePassword,
  getSessionFromCookie,
  resetEmployeePassword,
  resetToDefaultPassword,
  checkMustChange,
} from './auth'
import { db } from '@/db'
import { loginAttempts } from '@db/login-attempt'
import { compare, hash } from 'bcryptjs'
import { jwtVerify, SignJWT } from 'jose'
import { computeActions, expandScopeStoreIds, expandScopeDeptNodeIds } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { encryptPassword } from '@/lib/password-encrypt'

// ── Helpers ───────────────────────────────────────────────────────────────────

// login/changePassword 现接收 RSA 密文：测试用真实公钥加密，服务端真实私钥解密。
// 密钥对由 tests/setup.ts 注入到 RSA_PRIVATE_KEY / NEXT_PUBLIC_RSA_PUBLIC_KEY。
const enc = (plain: string) => encryptPassword(plain)

function mockSelectChain(results: any[]) {
  const limit = vi.fn().mockResolvedValue(results)
  const where = vi.fn().mockReturnValue({ limit })
  const leftJoin = vi.fn().mockReturnValue({ where, leftJoin: vi.fn().mockReturnValue({ where }) })
  const from = vi.fn().mockReturnValue({ where, limit, leftJoin })
  return vi.fn().mockReturnValue({ from })
}

function mockUpdateChain() {
  const where = vi.fn().mockResolvedValue({ count: 1 })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
  return { set, where }
}

/** 一个返回固定结果的 select 链段。
 *  where 返回值同时支持 .limit()（checkLock / staff / admin_passwords 查询）
 *  与直接 await（登录闸的 adminRoleRows 查询无 .limit()，靠 thenable 解析）。 */
function selectChainResult(results: any[]) {
  const limit = vi.fn().mockResolvedValue(results)
  const where = vi.fn().mockReturnValue({
    limit,
    then: (resolve: (v: any[]) => unknown) => resolve(results),
  })
  const from = vi.fn().mockReturnValue({ where, limit })
  return { from }
}

/** 配置 PG 登录锁定 mock：insert(.onConflictDoUpdate) + delete(.where) */
function mockLockWrites() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue({})
  ;(db.insert as any).mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoUpdate }),
  })
  const deleteWhere = vi.fn().mockResolvedValue({})
  ;(db.delete as any).mockReturnValue({ where: deleteWhere })
  return { onConflictDoUpdate, deleteWhere }
}

const staffRow = { employeeId: 'EMP-001', name: '张三', phone: '13800001111' }
const pwRow = { passwordHash: '$2b$12$existing', mustChange: false }
const pwRowMustChange = { passwordHash: '$2b$12$existing', mustChange: true }

// ── login ─────────────────────────────────────────────────────────────────────

describe('login — 认证 + 锁定（PG 持久化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieStore.get.mockReturnValue(undefined)
    mockCookieStore.set.mockReturnValue(undefined)
    mockLockWrites()
  })

  // login 现在的 select 顺序：① checkLock(login_attempts) ② staff ③ admin_passwords
  // 用 results 数组依次喂给每次 db.select() 调用（密码仍走 enc() RSA 密文）
  function mockSelectSequence(sequence: any[][]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => selectChainResult(sequence[i++] ?? []))
  }

  it('员工不存在 → 失败 + 记录失败（PG upsert 自增）', async () => {
    const { onConflictDoUpdate } = mockLockWrites()
    // ① 未锁定 ② staff 不存在
    mockSelectSequence([[], []])

    const result = await login('13900000001', enc('wrong'))

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号或密码错误')
    expect(db.insert).toHaveBeenCalledWith(loginAttempts)
    expect(onConflictDoUpdate).toHaveBeenCalled()
  })

  it('无 admin_passwords 记录 → 失败', async () => {
    // ① 未锁定 ② staff 存在 ③ 无密码记录
    mockSelectSequence([[], [staffRow], []])

    const result = await login('13900000002', enc('test'))

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号或密码错误')
  })

  it('密码错误 → 失败', async () => {
    // ① 未锁定 ② staff ③ 密码记录
    mockSelectSequence([[], [staffRow], [pwRow]])
    ;(compare as any).mockResolvedValue(false)

    const result = await login('13900000003', enc('wrong'))

    expect(result.success).toBe(false)
    expect(compare).toHaveBeenCalledWith('wrong', '$2b$12$existing')
  })

  it('密码正确 → 成功 + 清除失败 + 设置 cookie + 返回 mustChange', async () => {
    const { deleteWhere } = mockLockWrites()
    // ① 未锁定 ② staff ③ 密码记录（mustChange）④ 角色（含 admin → 准入）
    mockSelectSequence([[], [staffRow], [pwRowMustChange], [{ role: 'admin' }]])
    ;(compare as any).mockResolvedValue(true)

    const result = await login('13900000004', enc('correct'))

    expect(result.success).toBe(true)
    expect(result.mustChange).toBe(true)
    expect(db.delete).toHaveBeenCalledWith(loginAttempts)
    expect(deleteWhere).toHaveBeenCalled()
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'fy-admin-token',
      'mock-jwt-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    )
  })

  it('已锁定（locked_until 未来）→ 直接拒绝且不查员工', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000)
    // ① checkLock 返回锁定行
    mockSelectSequence([[{ lockedUntil: future }]])

    const result = await login('13900000005', enc('any'))

    expect(result.success).toBe(false)
    expect(result.message).toContain('已锁定')
    // 仅查了一次（checkLock），未继续查 staff
    expect((db.select as any).mock.calls.length).toBe(1)
  })

  it('锁定已过期（locked_until 过去）→ 放行继续认证', async () => {
    const past = new Date(Date.now() - 60 * 1000)
    // ① checkLock 返回已过期锁定 ② staff ③ 密码记录 ④ 角色（含 manager → 准入）
    mockSelectSequence([[{ lockedUntil: past }], [staffRow], [pwRow], [{ role: 'manager' }]])
    ;(compare as any).mockResolvedValue(true)

    const result = await login('13900000006', enc('correct'))

    expect(result.success).toBe(true)
  })

  it('密码正确但仅 staff 角色 → 拒绝登录（账号权限不足，不签 token）', async () => {
    // ① 未锁定 ② staff ③ 密码记录 ④ 角色仅 staff → canAccessAdmin=false
    mockSelectSequence([[], [staffRow], [pwRow], [{ role: 'staff' }]])
    ;(compare as any).mockResolvedValue(true)

    const result = await login('13900000007', enc('correct'))

    expect(result.success).toBe(false)
    expect(result.message).toContain('账号权限不足')
    // 拒发 token：未设置 cookie
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })
})

// ── logout ────────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('删除 cookie', async () => {
    await logout()

    expect(mockCookieStore.delete).toHaveBeenCalledWith('fy-admin-token')
  })
})

// ── changePassword ────────────────────────────────────────────────────────────

describe('changePassword — 密码变更 + JWT 重签', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未登录 → 失败', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const result = await changePassword(enc('newPass123'))

    expect(result.success).toBe(false)
    expect(result.message).toContain('未登录')
  })

  it('已登录 → 更新密码 + mustChange=false + 重签 JWT', async () => {
    // mock getSessionFromCookie: cookie → jwtVerify → staff → roles → permissions
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })

    let selectCallIndex = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallIndex++
      if (selectCallIndex === 1) {
        // staff lookup
        const limit = vi.fn().mockResolvedValue([staffRow])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // roles lookup
      const where = vi.fn().mockResolvedValue([{ role: 'admin', scopeId: 'hq', scopeType: '总部' }])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })
    mockUpdateChain()

    const result = await changePassword(enc('newSecure123'))

    expect(result.success).toBe(true)
    expect(hash).toHaveBeenCalledWith('newSecure123', 12)
    expect(db.update).toHaveBeenCalled()
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'fy-admin-token', 'mock-jwt-token', expect.anything(),
    )
  })
})

// ── getSessionFromCookie ──────────────────────────────────────────────────────

describe('getSessionFromCookie — JWT → AuthSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无 cookie → null', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const result = await getSessionFromCookie()

    expect(result).toBeNull()
  })

  it('JWT 验证失败 → null', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'invalid-token' })
    ;(jwtVerify as any).mockRejectedValue(new Error('invalid'))

    const result = await getSessionFromCookie()

    expect(result).toBeNull()
  })

  it('员工不存在 → null', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-GONE' } })
    ;(db.select as any).mockImplementation(mockSelectChain([]))

    const result = await getSessionFromCookie()

    expect(result).toBeNull()
  })

  it('正常 → 返回 AuthSession（含 roles + permissions）', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })

    let selectCallIndex = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallIndex++
      if (selectCallIndex === 1) {
        // staff
        const limit = vi.fn().mockResolvedValue([staffRow])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // roles
      const where = vi.fn().mockResolvedValue([
        { role: 'manager', scopeId: 'store-node-1', scopeType: '门店' },
      ])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })

    const result = await getSessionFromCookie()

    expect(result).not.toBeNull()
    expect(result!.employeeId).toBe('EMP-001')
    expect(result!.name).toBe('张三')
    expect(result!.roles).toEqual([
      { role: 'manager', scopeId: 'store-node-1', scopeType: '门店' },
    ])
    expect(computeActions).toHaveBeenCalled()
    expect(expandScopeStoreIds).toHaveBeenCalled()
    expect(expandScopeDeptNodeIds).toHaveBeenCalled()
    expect(result!.permissions.actions).toEqual(['dashboard:view'])
    expect(result!.permissions.scopeStoreIds).toEqual(['store-1'])
    expect(result!.permissions.scopeDeptNodeIds).toEqual(['dept-1'])
  })

  it('scopeType 为 null → 默认 store', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })

    let selectCallIndex = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallIndex++
      if (selectCallIndex === 1) {
        const limit = vi.fn().mockResolvedValue([staffRow])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      const where = vi.fn().mockResolvedValue([
        { role: 'hr', scopeId: 'node-1', scopeType: null },
      ])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })

    const result = await getSessionFromCookie()

    expect(result!.roles[0].scopeType).toBe('门店')
  })

  it('仅 staff 角色 → null（普通员工禁入后台，二次闸拦截）', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })

    let i = 0
    ;(db.select as any).mockImplementation(() => {
      i++
      if (i === 1) {
        const limit = vi.fn().mockResolvedValue([staffRow])
        const where = vi.fn().mockReturnValue({ limit })
        return { from: vi.fn().mockReturnValue({ where }) }
      }
      const where = vi.fn().mockResolvedValue([
        { role: 'staff', scopeId: 'node-1', scopeType: '门店' },
      ])
      const leftJoin = vi.fn().mockReturnValue({ where })
      return { from: vi.fn().mockReturnValue({ leftJoin }) }
    })

    const result = await getSessionFromCookie()

    expect(result).toBeNull()
  })
})

// ── resetEmployeePassword ─────────────────────────────────────────────────────

describe('resetEmployeePassword — admin UPSERT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockLoggedInAdmin() {
    mockCookieStore.get.mockReturnValue({ value: 'admin-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'ADMIN-001' } })

    // HOF 直接从 mocked `@/lib/auth` 取 session，不再调 db；action 内只剩 1 个 db.select（existing password check）
    ;(db.select as any).mockImplementation(() => {
      // existing password check 默认返回空数组（INSERT 路径）；
      // "已有记录 → UPDATE" 用例自行覆盖
      const limit = vi.fn().mockResolvedValue([])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
  }

  // 旧 "未登录"/"非 admin" 旁路已由 withPermission HOF 接管，原 throw 检测改在
  // src/lib/with-permission.test.ts 覆盖；此处仅保留业务路径（admin/UPSERT）测试。
  it('未登录 → HOF redirect /login (by with-permission.test.ts)', async () => {
    const { requirePermission } = await import('@/lib/permissions')
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('NEXT_REDIRECT:/login?expired=1')
    })

    await expect(resetEmployeePassword('EMP-002', 'newPass'))
      .rejects.toThrow(/NEXT_REDIRECT/)
  })

  it('非 admin → HOF throw PERMISSION_DENIED', async () => {
    const { requirePermission } = await import('@/lib/permissions')
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权执行 admin:reset_password')
    })

    await expect(resetEmployeePassword('EMP-002', 'newPass'))
      .rejects.toThrow('PERMISSION_DENIED: 无权执行 admin:reset_password')
  })

  it('admin + 无现有记录 → INSERT', async () => {
    mockLoggedInAdmin()
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    const result = await resetEmployeePassword('EMP-002', 'resetPass')

    expect(result.success).toBe(true)
    expect(result.message).toContain('重置成功')
    expect(hash).toHaveBeenCalledWith('resetPass', 12)
    expect(db.insert).toHaveBeenCalled()
    expect(logOperation).toHaveBeenCalledWith(
      expect.anything(), 'auth.resetPassword', 'admin_password', 'EMP-002',
      expect.objectContaining({ isNewAccount: true }),
    )
  })

  it('admin + 有现有记录 → UPDATE', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'admin-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'ADMIN-001' } })

    let selectCallIndex = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallIndex++
      if (selectCallIndex === 1) {
        const limit = vi.fn().mockResolvedValue([{ employeeId: 'ADMIN-001', name: '管理员', phone: '13800000000' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      if (selectCallIndex === 2) {
        const where = vi.fn().mockResolvedValue([
          { role: 'admin', scopeId: 'hq-1', scopeType: '总部' },
        ])
        const leftJoin = vi.fn().mockReturnValue({ where })
        const from = vi.fn().mockReturnValue({ leftJoin })
        return { from }
      }
      // existing password → found
      const limit = vi.fn().mockResolvedValue([{ id: 1 }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateChain()

    const result = await resetEmployeePassword('EMP-002', 'resetPass')

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalled()
    expect(logOperation).toHaveBeenCalledWith(
      expect.anything(), 'auth.resetPassword', 'admin_password', 'EMP-002',
      expect.objectContaining({ isNewAccount: false }),
    )
  })
})

// ── resetToDefaultPassword ────────────────────────────────────────────────────

describe('resetToDefaultPassword — 手机号后 6 位', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockAdminSession() {
    mockCookieStore.get.mockReturnValue({ value: 'admin-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'ADMIN-001' } })
  }

  function mockAdminRoles(selectCallIndex: { value: number }) {
    if (selectCallIndex.value === 1) {
      // admin staff lookup
      const limit = vi.fn().mockResolvedValue([{ employeeId: 'ADMIN-001', name: '管理员', phone: '13800000000' }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    }
    // admin roles
    const where = vi.fn().mockResolvedValue([
      { role: 'admin', scopeId: 'hq-1', scopeType: '总部' },
    ])
    const leftJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ leftJoin })
    return { from }
  }

  it('未登录 → 失败', async () => {
    const { requirePermission } = await import('@/lib/permissions')
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('NEXT_REDIRECT:/login?expired=1')
    })

    await expect(resetToDefaultPassword('EMP-002'))
      .rejects.toThrow(/NEXT_REDIRECT/)
  })

  it('非 admin → HOF throw PERMISSION_DENIED', async () => {
    const { requirePermission } = await import('@/lib/permissions')
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权执行 admin:reset_password')
    })

    await expect(resetToDefaultPassword('EMP-002'))
      .rejects.toThrow('PERMISSION_DENIED: 无权执行 admin:reset_password')
  })

  it('员工无手机号 → 失败', async () => {
    mockAdminSession()

    // HOF 接管 session 注入；首个 db.select 即"目标员工手机号"查询
    ;(db.select as any).mockImplementation(() => {
      const limit = vi.fn().mockResolvedValue([{ phone: null }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await resetToDefaultPassword('EMP-002')

    expect(result.success).toBe(false)
    expect(result.message).toContain('未绑定手机号')
  })

  it('正常 → 使用手机号后 6 位 + mustChange + INSERT', async () => {
    mockAdminSession()

    const counter = { value: 0 }
    ;(db.select as any).mockImplementation(() => {
      counter.value++
      // HOF 接管 session 注入，原 mockAdminRoles 不再被触发
      if (counter.value === 1) {
        // target employee phone
        const limit = vi.fn().mockResolvedValue([{ phone: '15958024944' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // existing password check — not found
      const limit = vi.fn().mockResolvedValue([])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })

    const result = await resetToDefaultPassword('EMP-002')

    expect(result.success).toBe(true)
    expect(result.message).toContain('初始密码')
    expect(hash).toHaveBeenCalledWith('024944', 12)
    expect(db.insert).toHaveBeenCalled()
    expect(logOperation).toHaveBeenCalledWith(
      expect.anything(), 'auth.resetToDefault', 'admin_password', 'EMP-002',
      expect.objectContaining({ isNewAccount: true }),
    )
  })

  it('已有密码记录 → UPDATE', async () => {
    mockAdminSession()

    const counter = { value: 0 }
    ;(db.select as any).mockImplementation(() => {
      counter.value++
      // HOF 接管 session 注入，原 mockAdminRoles 不再被触发
      if (counter.value === 1) {
        // target employee phone
        const limit = vi.fn().mockResolvedValue([{ phone: '13812345678' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // existing password — found
      const limit = vi.fn().mockResolvedValue([{ id: 1 }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateChain()

    const result = await resetToDefaultPassword('EMP-002')

    expect(result.success).toBe(true)
    expect(hash).toHaveBeenCalledWith('345678', 12)
    expect(db.update).toHaveBeenCalled()
  })
})

// ── checkMustChange ───────────────────────────────────────────────────────────

describe('checkMustChange — middleware 预检', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无 cookie → false', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    expect(await checkMustChange()).toBe(false)
  })

  it('JWT 无效 → false', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'bad-token' })
    ;(jwtVerify as any).mockRejectedValue(new Error('expired'))

    expect(await checkMustChange()).toBe(false)
  })

  it('mustChange=true → true', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })
    ;(db.select as any).mockImplementation(() => {
      const limit = vi.fn().mockResolvedValue([{ mustChange: true }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    expect(await checkMustChange()).toBe(true)
  })

  it('mustChange=false → false', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })
    ;(db.select as any).mockImplementation(() => {
      const limit = vi.fn().mockResolvedValue([{ mustChange: false }])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    expect(await checkMustChange()).toBe(false)
  })

  it('无密码记录 → false', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'valid-token' })
    ;(jwtVerify as any).mockResolvedValue({ payload: { employeeId: 'EMP-001' } })
    ;(db.select as any).mockImplementation(() => {
      const limit = vi.fn().mockResolvedValue([])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    expect(await checkMustChange()).toBe(false)
  })
})
