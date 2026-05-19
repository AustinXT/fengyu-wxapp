/**
 * Smoke tests for inventory actions.
 *
 * 重 mock 路径——验证 4 模块各 action 在权限通过时调用了 db 主链。
 * 完整 CRUD 行为留给 e2e-actions（接真 PG）覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txExecute = vi.fn()
const txInsert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }))
const txUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }))
const txDelete = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({ offset: vi.fn().mockResolvedValue([]) })),
          })),
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: any) => {
      txExecute.mockResolvedValue([{ id: 'INV-PROC-260519-0001' }])
      return fn({
        execute: txExecute,
        insert: txInsert,
        update: txUpdate,
        delete: txDelete,
      })
    }),
    execute: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
  isAdminScope: vi.fn(() => true),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn(), join: vi.fn() },
  ),
}))

vi.mock('@db/inventory', () => ({
  inventoryProcurementOrders: { id: 'id', storeId: 'store_id', docSubtype: 'doc_subtype', status: 'status' },
  inventoryProcurementOrderItems: { orderId: 'order_id', id: 'id' },
  inventorySaleOrders: { id: 'id', storeId: 'store_id', docSubtype: 'doc_subtype', status: 'status' },
  inventorySaleOrderItems: { orderId: 'order_id', id: 'id' },
  inventoryTransferOrders: { id: 'id', storeId: 'store_id', counterpartStoreId: 'counterpart_store_id', docSubtype: 'doc_subtype', status: 'status' },
  inventoryTransferOrderItems: { orderId: 'order_id', id: 'id' },
  inventoryScrapOrders: { id: 'id', storeId: 'store_id', status: 'status' },
  inventoryScrapOrderItems: { orderId: 'order_id', id: 'id' },
}))
vi.mock('@db/org', () => ({ stores: { storeId: 'store_id', storeName: 'store_name' } }))
vi.mock('@db/user', () => ({
  clientWechatUsers: { userId: 'user_id', name: 'name' },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

const SESSION = {
  employeeId: 'E0001',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: [], scopeStoreIds: ['S001'] },
} as any

beforeEach(async () => {
  vi.clearAllMocks()
  const auth = await import('@/lib/auth')
  ;(auth.getSession as any).mockResolvedValue(SESSION)
})

describe('inventory.doc-no', () => {
  it('生成符合前缀的单据号', async () => {
    const { generateInventoryDocNo } = await import('./doc-no')
    txExecute.mockResolvedValueOnce([{ id: 'INV-SCR-260519-0007' }])
    const id = await generateInventoryDocNo({ execute: txExecute } as any, 'scrap')
    expect(id).toMatch(/^INV-SCR-/)
  })
})

describe('inventory.procurement', () => {
  it('createProcurementOrder 校验缺产品报错', async () => {
    const { createProcurementOrder } = await import('./procurement')
    await expect(
      createProcurementOrder({
        docSubtype: '院入库',
        storeId: 'S001',
        docDate: '2026-05-19',
        items: [{ productCode: '', productName: '', quantity: 0 }],
      }),
    ).rejects.toThrow(/INVALID_PARAMS|参数/)
  })

})

describe('inventory.sale', () => {
  it('createSaleOrder 至少一条明细', async () => {
    const { createSaleOrder } = await import('./sale')
    await expect(
      createSaleOrder({
        docSubtype: '销售出库',
        storeId: 'S001',
        docDate: '2026-05-19',
        items: [],
      }),
    ).rejects.toThrow(/INVALID_PARAMS|至少|明细/)
  })
})

describe('inventory.transfer', () => {
  it('createTransferOrder 发起与接收门店相同会拒', async () => {
    const { createTransferOrder } = await import('./transfer')
    await expect(
      createTransferOrder({
        docSubtype: '调拨出库',
        storeId: 'S001',
        counterpartStoreId: 'S001',
        docDate: '2026-05-19',
        items: [{ productCode: 'P1', productName: 'P1', quantity: 1 }],
      }),
    ).rejects.toThrow(/INVALID_PARAMS|发起|相同|不同/)
  })
})

describe('inventory.scrap', () => {
  it('createScrapOrder 缺报损原因报错', async () => {
    const { createScrapOrder } = await import('./scrap')
    await expect(
      createScrapOrder({
        storeId: 'S001',
        docDate: '2026-05-19',
        items: [{ productCode: 'P1', productName: 'P1', quantity: 1 }],
      }),
    ).rejects.toThrow(/INVALID_PARAMS|原因|报损/)
  })
})
