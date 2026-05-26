import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/store-unbind', () => ({
  storeUnbindRequests: {
    requestId: 'request_id',
    userId: 'user_id',
    fromStoreId: 'from_store_id',
    status: 'status',
    reviewedBy: 'reviewed_by',
    reviewedAt: 'reviewed_at',
    rejectReason: 'reject_reason',
    createdAt: 'created_at',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
    boundStoreId: 'bound_store_id',
    boundEmployeeId: 'bound_employee_id',
    boundEmployeeName: 'bound_employee_name',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { approveUnbind, rejectUnbind } from './store-unbind'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['store_unbind:approve', 'store_unbind:reject'], scopeStoreIds: [] },
}

const pendingRequest = {
  requestId: 'REQ-001',
  userId: 'CLIENT-001',
  fromStoreId: 'STORE-001',
  toStoreId: 'STORE-002',
  status: '待处理',
  note: null,
  rejectReason: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: new Date('2026-03-01'),
}

function mockSelectRequest(request: any | null) {
  const limit = vi.fn().mockResolvedValue(request ? [request] : [])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  ;(db.select as any).mockReturnValue({ from })
}

// ── approveUnbind ─────────────────────────────────────────────────────────────

describe('approveUnbind — 前置校验 + 事务原子性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('申请不存在 → 拒绝', async () => {
    mockSelectRequest(null)
    const result = await approveUnbind('REQ-999')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('申请已处理（非 pending）→ 拒绝', async () => {
    mockSelectRequest({ ...pendingRequest, status: 'approved' })
    const result = await approveUnbind('REQ-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已处理')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('scope 不匹配 → 拒绝', async () => {
    mockSelectRequest(pendingRequest)
    ;(isInScope as any).mockReturnValue(false)
    const result = await approveUnbind('REQ-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('缺少目标门店 → 拒绝，不走事务', async () => {
    mockSelectRequest({ ...pendingRequest, toStoreId: null })
    const result = await approveUnbind('REQ-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('目标门店')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('正常通过 → 走事务，顾客门店转绑到目标店并清美容师绑定', async () => {
    mockSelectRequest(pendingRequest)

    const clientSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) })
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let updateCall = 0
      const tx = {
        update: vi.fn().mockImplementation(() => {
          updateCall++
          // call 1 = storeUnbindRequests 状态翻转；call 2 = clientWechatUsers 转绑
          if (updateCall === 2) {
            return { set: clientSet }
          }
          return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }) }
        }),
      }
      await fn(tx)
      // 确认两条 update 均被调用
      expect(tx.update).toHaveBeenCalledTimes(2)
    })

    const result = await approveUnbind('REQ-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已通过')
    expect(db.transaction).toHaveBeenCalledOnce()
    // 转店：bound_store_id → toStoreId，清美容师绑定，不动 customer_source
    expect(clientSet).toHaveBeenCalledWith({
      boundStoreId: 'STORE-002',
      boundEmployeeId: null,
      boundEmployeeName: null,
    })
  })

  it('事务内第一条 UPDATE 失败 → 整体回滚，返回友好错误', async () => {
    mockSelectRequest(pendingRequest)
    ;(db.transaction as any).mockRejectedValue(new Error('tx rollback'))

    const result = await approveUnbind('REQ-001')
    expect(result.success).toBe(false)
    expect(result.message).toBe('审批解绑失败，请稍后重试')
  })
})

// ── rejectUnbind ──────────────────────────────────────────────────────────────

describe('rejectUnbind — 前置校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('申请不存在 → 拒绝', async () => {
    mockSelectRequest(null)
    const result = await rejectUnbind('REQ-999', '顾客已重新绑定')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('申请已处理 → 拒绝', async () => {
    mockSelectRequest({ ...pendingRequest, status: 'rejected' })
    const result = await rejectUnbind('REQ-001', '理由')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已处理')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('scope 不匹配 → 拒绝', async () => {
    mockSelectRequest(pendingRequest)
    ;(isInScope as any).mockReturnValue(false)
    const result = await rejectUnbind('REQ-001', '理由')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('正常拒绝 → 成功', async () => {
    mockSelectRequest(pendingRequest)
    const where = vi.fn().mockResolvedValue({})
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await rejectUnbind('REQ-001', '顾客重新绑定')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已拒绝')
    expect(db.update).toHaveBeenCalledOnce()
  })

  it('DB 异常 → 返回友好错误', async () => {
    mockSelectRequest(pendingRequest)
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await rejectUnbind('REQ-001', '理由')
    expect(result.success).toBe(false)
    expect(result.message).toBe('驳回解绑失败，请稍后重试')
  })
})
