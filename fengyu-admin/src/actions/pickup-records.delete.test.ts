import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}))

vi.mock('@db/pickup', () => ({
  pickupRecords: {
    id: 'id',
    saleItemId: 'sale_item_id',
    pickupQuantity: 'pickup_quantity',
    storeId: 'store_id',
    clientUserId: 'client_user_id',
    confirmedBy: 'confirmed_by',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: { saleItemId: 'sale_item_id', pickedUpQuantity: 'picked_up_quantity' },
}))

vi.mock('@db/org', () => ({ stores: { storeId: 'store_id', storeName: 'store_name' } }))

vi.mock('@db/user', () => ({
  clientWechatUsers: { userId: 'user_id', name: 'name', phone: 'phone' },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

vi.mock('@db/product', () => ({ productSkus: { skuId: 'sku_id', specName: 'spec_name' } }))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deletePickupRecord } from './pickup-records'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['pickup_record:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

function setupTx(deleteCount: number, captureExecute?: (sqlArg: any) => void) {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: deleteCount }) }),
      execute: vi.fn().mockImplementation(async (arg: any) => { captureExecute?.(arg); return undefined }),
    }
    return fn(tx)
  })
}

describe('deletePickupRecord — 删除 + 回退已提数量', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('记录不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deletePickupRecord(404)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('记录存在 → 删除 + 回退计数 + 审计', async () => {
    mockSelect([{ saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1' }])
    let executed = false
    setupTx(1, () => { executed = true })
    const result = await deletePickupRecord(1)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(executed).toBe(true) // 事务内回退 picked_up_quantity
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'pickup_record.delete', 'pickup_record', '1',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('删除 rowCount=0（并发）→ 回滚提示', async () => {
    mockSelect([{ saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1' }])
    setupTx(0)
    const result = await deletePickupRecord(1)
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
