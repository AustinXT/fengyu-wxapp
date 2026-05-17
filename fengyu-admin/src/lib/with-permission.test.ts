import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AuthSession } from './types'

const { mockRedirect } = vi.hoisted(() => {
  const mockRedirect = vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  })
  return { mockRedirect }
})
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { withPermission, withAnyPermission } from './with-permission'

function makeSession(actions: string[]): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '测试用户',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: { actions, scopeStoreIds: [] },
  }
}

describe('withPermission', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  it('成功路径：fn 收到非空 session + 透传 args', async () => {
    const session = makeSession(['employee:update'])
    mockGetSession.mockResolvedValue(session)
    const fn = vi.fn(async (s: AuthSession, a: number, b: string) => `${s.employeeId}-${a}-${b}`)

    const wrapped = withPermission('employee:update', fn)
    const result = await wrapped(42, 'hello')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(session, 42, 'hello')
    expect(result).toBe('EMP-001-42-hello')
  })

  it('session=null：触发 redirect(/login?expired=1) 且 fn 不被调用', async () => {
    mockGetSession.mockResolvedValue(null)
    const fn = vi.fn()

    const wrapped = withPermission('employee:update', fn)
    await expect(wrapped()).rejects.toThrow('NEXT_REDIRECT:/login?expired=1')
    expect(mockRedirect).toHaveBeenCalledWith('/login?expired=1')
    expect(fn).not.toHaveBeenCalled()
  })

  it('权限不足：throw PERMISSION_DENIED 且 fn 不被调用', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:list'])) // 无 employee:update
    const fn = vi.fn()

    const wrapped = withPermission('employee:update', fn)
    await expect(wrapped()).rejects.toThrow('PERMISSION_DENIED: 无权执行 employee:update')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('withAnyPermission', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  it('OR 关系：任一命中即通过', async () => {
    mockGetSession.mockResolvedValue(makeSession(['sale_order:refund_approve']))
    const fn = vi.fn(async (s: AuthSession) => s.employeeId)

    const wrapped = withAnyPermission(['sale_order:list', 'sale_order:refund_approve'], fn)
    await expect(wrapped()).resolves.toBe('EMP-001')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('全部不命中：throw PERMISSION_DENIED 含全部 actions', async () => {
    mockGetSession.mockResolvedValue(makeSession(['dashboard:view']))
    const fn = vi.fn()

    const wrapped = withAnyPermission(['sale_order:list', 'sale_order:refund_approve'], fn)
    await expect(wrapped()).rejects.toThrow(
      'PERMISSION_DENIED: 无权执行 sale_order:list 或 sale_order:refund_approve',
    )
    expect(fn).not.toHaveBeenCalled()
  })

  it('session=null：redirect 且 fn 不被调用', async () => {
    mockGetSession.mockResolvedValue(null)
    const fn = vi.fn()

    const wrapped = withAnyPermission(['anything'], fn)
    await expect(wrapped()).rejects.toThrow('NEXT_REDIRECT:/login?expired=1')
    expect(fn).not.toHaveBeenCalled()
  })
})
