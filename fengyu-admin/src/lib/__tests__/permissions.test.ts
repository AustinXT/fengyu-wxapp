import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AuthSession } from '@/lib/types'

// requireAdmin 在 session 为 null 时调 next/navigation 的 redirect
// （真实环境靠抛 NEXT_REDIRECT 中止调用方）。测试里 mock 成纯记录：
// 不抛 → requireAdmin 会 fall-through 到 isAdminScope(null) 抛 TypeError，
// 故 null 用例用 try/catch 吞掉，只断言「redirect 被以登录 URL 触发」这一核心契约。
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

// permissions.ts 顶部 import 了 @/db / @db/org / drizzle-orm（模块加载即求值）。
// requireAdmin 本身不依赖它们，mock 成最小空对象即可隔离，
// 免连 DB、免拉 Drizzle schema（与 admin-guard.test.ts 同套路）。
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@db/org', () => ({ orgNodes: {}, stores: {} }))
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}))

import { redirect } from 'next/navigation'
import { requireAdmin, PermissionError } from '../permissions'

const mockedRedirect = vi.mocked(redirect)

function makeSession(roles: AuthSession['roles'], actions: string[] = []): AuthSession {
  return {
    employeeId: 'emp_test',
    name: '测试',
    phone: '13800000000',
    roles,
    permissions: { actions, scopeStoreIds: [] },
  }
}

describe('requireAdmin — 仅系统管理员硬闸（物理删除 + 不可授权的敏感写操作）', () => {
  beforeEach(() => mockedRedirect.mockClear())

  it('session 为 null → redirect("/login?expired=1")', () => {
    try {
      requireAdmin(null)
    } catch {
      // mock 不抛时 requireAdmin fall-through 到 isAdminScope(null) 抛 TypeError，吞掉
    }
    expect(mockedRedirect).toHaveBeenCalledWith('/login?expired=1')
    expect(mockedRedirect).toHaveBeenCalledTimes(1)
  })

  it('非 admin 即便矩阵勾了 :delete → 抛 PermissionError（威胁模型核心）', () => {
    // 运营在权限矩阵 UI 给 manager 勾上 sale_order:delete / customer:delete，
    // withPermission 能放行，但物理删除硬闸仍以角色为准拦下。
    const session = makeSession(
      [{ role: 'manager', scopeId: 's1', scopeType: '门店' }],
      ['sale_order:delete', 'customer:delete'],
    )

    let caught: unknown
    try {
      requireAdmin(session)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(PermissionError)
    expect((caught as PermissionError).message).toMatch(/仅系统管理员/)
    expect((caught as PermissionError).digest).toBe('PERMISSION_DENIED')
    expect(mockedRedirect).not.toHaveBeenCalled()
  })

  it('admin 角色 → 放行（无抛出、无 redirect）', () => {
    const session = makeSession([{ role: 'admin', scopeId: 'hq', scopeType: '总部' }], [])
    expect(() => requireAdmin(session)).not.toThrow()
    expect(mockedRedirect).not.toHaveBeenCalled()
  })

  it('多角色中含 admin → 放行（isAdminScope 走 .some）', () => {
    const session = makeSession([
      { role: 'manager', scopeId: 's1', scopeType: '门店' },
      { role: 'admin', scopeId: 'hq', scopeType: '总部' },
    ])
    expect(() => requireAdmin(session)).not.toThrow()
  })

  it('空 roles → 拦下', () => {
    const session = makeSession([], ['sale_order:delete'])
    expect(() => requireAdmin(session)).toThrow(PermissionError)
    expect(mockedRedirect).not.toHaveBeenCalled()
  })

  // 上面的用例都不带 isSuperAdmin，走的是 `r.isSuperAdmin ?? r.role === 'admin'` 的回退支。
  // 但生产 session 从 permission_roles.is_super_admin（notNull + default false，
  // db/schema/permission.ts:25）直读，该字段永远是 boolean —— 回退支在生产不可达，
  // 真正生效的是下面两条。#211 把本闸门从物理删除扩到日常增改后，这两条更需锁定。
  it('isSuperAdmin=true 的自定义角色 → 放行（不要求 role 字面量是 admin）', () => {
    const session = makeSession([
      { role: 'custom_ops', scopeId: 'hq', scopeType: '总部', isSuperAdmin: true },
    ])
    expect(() => requireAdmin(session)).not.toThrow()
    expect(mockedRedirect).not.toHaveBeenCalled()
  })

  it('isSuperAdmin=false 但 role 字面量是 admin → 拦下（?? 不回退，false 是有效值）', () => {
    const session = makeSession([
      { role: 'admin', scopeId: 'hq', scopeType: '总部', isSuperAdmin: false },
    ])
    expect(() => requireAdmin(session)).toThrow(PermissionError)
    expect(mockedRedirect).not.toHaveBeenCalled()
  })
})
