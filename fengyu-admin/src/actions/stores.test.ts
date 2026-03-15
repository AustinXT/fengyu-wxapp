import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    updatedAt: 'updated_at',
  },
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    parentId: 'parent_id',
    sortOrder: 'sort_order',
    isActive: 'is_active',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn(() => ({
    id: 'alias_id',
    name: 'alias_name',
    parentId: 'alias_parent_id',
  })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
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

import { createStore, updateStore } from './stores'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['store:list', 'store:create', 'store:update'], scopeStoreIds: [] },
}

const baseStoreData = {
  storeId: 'STORE-001',
  storeName: '凤御华南店',
  marketId: 'market-1',
}

// ── createStore ───────────────────────────────────────────────────────────────

describe('createStore — 事务错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function mockTx() {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(tx)
    })
  }

  it('门店编号重复（23505）→ 友好消息', async () => {
    ;(db.transaction as any).mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' })
    )
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店编号已存在')
  })

  it('所属市场不存在（23503）→ 友好消息', async () => {
    ;(db.transaction as any).mockRejectedValue(
      Object.assign(new Error('FK violation'), { code: '23503' })
    )
    const result = await createStore({ ...baseStoreData, marketId: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('所属市场不存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    await expect(createStore(baseStoreData)).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    mockTx()
    const result = await createStore(baseStoreData)
    expect(result.success).toBe(true)
    expect(result.message).toContain('门店创建成功')
  })
})

// ── updateStore ───────────────────────────────────────────────────────────────

describe('updateStore — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupUpdate(rowCount: number) {
    const where = vi.fn().mockResolvedValue({ rowCount })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告门店不存在（而非静默成功）', async () => {
    setupUpdate(0)
    const result = await updateStore('nonexistent', { storeName: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('门店不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateStore('STORE-001', { storeName: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)
    const result = await updateStore('STORE-001', { storeName: '新名称' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })

  it('正常更新含乐观锁 → 成功', async () => {
    setupUpdate(1)
    const result = await updateStore('STORE-001', { storeName: '新名称', bedCount: 5 }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(true)
  })
})
