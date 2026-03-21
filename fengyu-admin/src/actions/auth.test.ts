import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
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
    isVoid: 'is_void',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: { id: 'id', type: 'type' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
}))

vi.mock('@/lib/permissions', () => ({
  computeActions: vi.fn(() => ['dashboard:view']),
  expandScopeStoreIds: vi.fn(async () => ['store-1']),
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
import { compare, hash } from 'bcryptjs'
import { jwtVerify, SignJWT } from 'jose'
import { computeActions, expandScopeStoreIds } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const staffRow = { employeeId: 'EMP-001', name: '张三', phone: '13800001111' }
const pwRow = { passwordHash: '$2b$12$existing', mustChange: false }
const pwRowMustChange = { passwordHash: '$2b$12$existing', mustChange: true }

// ── login ─────────────────────────────────────────────────────────────────────

describe('login — 认证 + 锁定', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieStore.get.mockReturnValue(undefined)
    mockCookieStore.set.mockReturnValue(undefined)
  })

  it('员工不存在 → 失败 + 记录尝试次数', async () => {
    ;(db.select as any).mockImplementation(mockSelectChain([]))

    const result = await login('13900000001', 'wrong')

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号或密码错误')
  })

  it('无 admin_passwords 记录 → 失败', async () => {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // staff query
        const limit = vi.fn().mockResolvedValue([staffRow])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // admin_passwords query
      const limit = vi.fn().mockResolvedValue([])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await login('13900000002', 'test')

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号或密码错误')
  })

  it('密码错误 → 失败', async () => {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      const limit = vi.fn().mockResolvedValue(callIndex === 1 ? [staffRow] : [pwRow])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    ;(compare as any).mockResolvedValue(false)

    const result = await login('13900000003', 'wrong')

    expect(result.success).toBe(false)
    expect(compare).toHaveBeenCalledWith('wrong', '$2b$12$existing')
  })

  it('密码正确 → 成功 + 设置 cookie + 返回 mustChange', async () => {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      const limit = vi.fn().mockResolvedValue(callIndex === 1 ? [staffRow] : [pwRowMustChange])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    ;(compare as any).mockResolvedValue(true)

    const result = await login('13900000004', 'correct')

    expect(result.success).toBe(true)
    expect(result.mustChange).toBe(true)
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'fy-admin-token',
      'mock-jwt-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    )
  })

  it('连续 5 次失败 → 账号锁定', async () => {
    ;(db.select as any).mockImplementation(mockSelectChain([]))
    const phone = '13900000005'

    // 5 次失败
    for (let i = 0; i < 5; i++) {
      await login(phone, 'wrong')
    }

    // 第 6 次被锁
    const result = await login(phone, 'any')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已锁定')
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

    const result = await changePassword('newPass123')

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
      const where = vi.fn().mockResolvedValue([{ role: 'admin', scopeId: 'hq', scopeType: 'headquarters' }])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })
    mockUpdateChain()

    const result = await changePassword('newSecure123')

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
        { role: 'manager', scopeId: 'store-node-1', scopeType: 'store' },
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
      { role: 'manager', scopeId: 'store-node-1', scopeType: 'store' },
    ])
    expect(computeActions).toHaveBeenCalled()
    expect(expandScopeStoreIds).toHaveBeenCalled()
    expect(result!.permissions.actions).toEqual(['dashboard:view'])
    expect(result!.permissions.scopeStoreIds).toEqual(['store-1'])
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

    expect(result!.roles[0].scopeType).toBe('store')
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

    let selectCallIndex = 0
    ;(db.select as any).mockImplementation(() => {
      selectCallIndex++
      if (selectCallIndex === 1) {
        // staff
        const limit = vi.fn().mockResolvedValue([{ employeeId: 'ADMIN-001', name: '管理员', phone: '13800000000' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      if (selectCallIndex === 2) {
        // roles
        const where = vi.fn().mockResolvedValue([
          { role: 'admin', scopeId: 'hq-1', scopeType: 'headquarters' },
        ])
        const leftJoin = vi.fn().mockReturnValue({ where })
        const from = vi.fn().mockReturnValue({ leftJoin })
        return { from }
      }
      // existing password check（selectCallIndex === 3）
      const limit = vi.fn().mockResolvedValue([])
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
  }

  it('未登录 → 失败', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const result = await resetEmployeePassword('EMP-002', 'newPass')

    expect(result.success).toBe(false)
    expect(result.message).toContain('未登录')
  })

  it('非 admin → 失败', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'token' })
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
      // roles: manager, not admin
      const where = vi.fn().mockResolvedValue([
        { role: 'manager', scopeId: 'store-1', scopeType: 'store' },
      ])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })

    const result = await resetEmployeePassword('EMP-002', 'newPass')

    expect(result.success).toBe(false)
    expect(result.message).toContain('仅系统管理员')
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
          { role: 'admin', scopeId: 'hq-1', scopeType: 'headquarters' },
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
      { role: 'admin', scopeId: 'hq-1', scopeType: 'headquarters' },
    ])
    const leftJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ leftJoin })
    return { from }
  }

  it('未登录 → 失败', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const result = await resetToDefaultPassword('EMP-002')

    expect(result.success).toBe(false)
    expect(result.message).toContain('未登录')
  })

  it('非 admin → 失败', async () => {
    mockCookieStore.get.mockReturnValue({ value: 'token' })
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
        { role: 'manager', scopeId: 'store-1', scopeType: 'store' },
      ])
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })

    const result = await resetToDefaultPassword('EMP-002')

    expect(result.success).toBe(false)
    expect(result.message).toContain('仅系统管理员')
  })

  it('员工无手机号 → 失败', async () => {
    mockAdminSession()

    const counter = { value: 0 }
    ;(db.select as any).mockImplementation(() => {
      counter.value++
      if (counter.value <= 2) return mockAdminRoles(counter)
      // target employee phone lookup — no phone
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
      if (counter.value <= 2) return mockAdminRoles(counter)
      if (counter.value === 3) {
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
      if (counter.value <= 2) return mockAdminRoles(counter)
      if (counter.value === 3) {
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
