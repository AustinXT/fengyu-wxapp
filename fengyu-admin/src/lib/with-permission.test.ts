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

import { withAllPermissions, withPermission, withAnyPermission } from './with-permission'
import { ApiError } from './api-error'

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

describe('withAllPermissions', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  it('AND 关系：库存特殊操作必须同时具备基础和特殊权限', async () => {
    const fn = vi.fn(async (session: AuthSession) => session.employeeId)
    const wrapped = withAllPermissions([
      'inventory:create_doc',
      'inventory:self_purchase_receive',
    ], fn)

    mockGetSession.mockResolvedValue(makeSession(['inventory:create_doc']))
    await expect(wrapped()).rejects.toThrow('PERMISSION_DENIED: 无权执行 inventory:self_purchase_receive')
    expect(fn).not.toHaveBeenCalled()

    mockGetSession.mockResolvedValue(makeSession([
      'inventory:create_doc',
      'inventory:self_purchase_receive',
    ]))
    await expect(wrapped()).resolves.toBe('EMP-001')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('业务错误补 digest（穿透 Next.js 生产脱敏）', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  it('白名单前缀业务错误：digest 补为原 message', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:update']))
    const fn = vi.fn(async () => {
      throw new Error('CONFLICT: 数据已被其他人修改，请刷新后重试')
    })

    const wrapped = withPermission('employee:update', fn)
    await expect(wrapped()).rejects.toMatchObject({
      message: 'CONFLICT: 数据已被其他人修改，请刷新后重试',
      digest: 'CONFLICT: 数据已被其他人修改，请刷新后重试',
    })
  })

  it('ApiError：digest = 含前缀的完整 message', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:update']))
    const fn = vi.fn(async () => {
      throw new ApiError('INVALID_STATE', '订单状态不允许该操作')
    })

    const wrapped = withPermission('employee:update', fn)
    await expect(wrapped()).rejects.toMatchObject({
      digest: 'INVALID_STATE: 订单状态不允许该操作',
    })
  })

  it('非白名单系统错误：不补 digest（保持脱敏 → 客户端回退兜底）', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:update']))
    const fn = vi.fn(async () => {
      throw new Error('某处读取了 undefined 的属性导致崩溃')
    })

    const wrapped = withPermission('employee:update', fn)
    let caught: unknown
    try {
      await wrapped()
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toBe('某处读取了 undefined 的属性导致崩溃')
    expect((caught as { digest?: unknown }).digest).toBeUndefined()
  })

  it('已有 digest 的错误（如 PermissionError）：不被覆盖', async () => {
    mockGetSession.mockResolvedValue(makeSession(['employee:update']))
    const fn = vi.fn(async () => {
      // message 命中白名单，但已带 digest → 短路，不覆盖
      const e = new Error('CONFLICT: xxx') as Error & { digest?: string }
      e.digest = 'PERMISSION_DENIED'
      throw e
    })

    const wrapped = withPermission('employee:update', fn)
    await expect(wrapped()).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
  })

  it('withAnyPermission 同样补 digest', async () => {
    mockGetSession.mockResolvedValue(makeSession(['sale_order:refund_approve']))
    const fn = vi.fn(async () => {
      throw new Error('CONFLICT: 退款已被处理')
    })

    const wrapped = withAnyPermission(['sale_order:list', 'sale_order:refund_approve'], fn)
    await expect(wrapped()).rejects.toMatchObject({ digest: 'CONFLICT: 退款已被处理' })
  })
})
