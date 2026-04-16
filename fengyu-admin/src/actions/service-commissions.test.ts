import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/service-commission', () => ({
  serviceCommissions: {
    id: 'id',
    serviceItemId: 'service_item_id',
    employeeId: 'employee_id',
    roleType: 'role_type',
    allocationRatio: 'allocation_ratio',
    commissionRate: 'commission_rate',
    commissionAmount: 'commission_amount',
    isVoid: 'is_void',
  },
}))

vi.mock('@db/service', () => ({
  serviceOrders: {
    serviceOrderId: 'service_order_id',
    storeId: 'store_id',
    commissionStatus: 'commission_status',
  },
  serviceItems: {
    serviceOrderId: 'service_order_id',
    serviceItemId: 'service_item_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isAdminScope: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { batchSaveServiceCommissions } from './service-commissions'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['allocation:list', 'allocation:save'], scopeStoreIds: ['store-1'] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

// ============================================================
// batchSaveServiceCommissions 的池校验（P2-14 Q5 镜像 allocations）
// ============================================================
describe('batchSaveServiceCommissions — 技能标签池校验（P2-14）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  function mockScopeAndItems(items: Array<{ serviceItemId: string }>) {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      return makeSelectChain(items)()
    })
  }

  function mockTx() {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      }
      return fn(tx)
    })
  }

  it('分配比例非整十 → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.15', commissionRate: '0.30', commissionAmount: '30.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('整十')
  })

  it('同技能标签超过 3 人 → 拒绝（P2-14 Q5）', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-003', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-004', roleType: '美容师', allocationRatio: '0.20', commissionRate: '0.30', commissionAmount: '60.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('最多分配 3 人')
  })

  it('美容师与养生师三池独立校验（P2-14 Q5）', async () => {
    // P2-14 前合并同一池；现独立池，两角色各 70% + 30% 分别属两池皆合法
    mockScopeAndItems([{ serviceItemId: 'si-1' }])
    mockTx()

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', commissionRate: '0.30', commissionAmount: '21.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '养生师', allocationRatio: '0.30', commissionRate: '0.30', commissionAmount: '9.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('同技能标签分配比例超 100% → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', commissionRate: '0.30', commissionAmount: '21.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.40', commissionRate: '0.30', commissionAmount: '12.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('超过 100%')
  })

  it('同技能标签重复员工 → 拒绝', async () => {
    mockScopeAndItems([{ serviceItemId: 'si-1' }])

    const result = await batchSaveServiceCommissions('so-1', [
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
      { serviceItemId: 'si-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', commissionRate: '0.30', commissionAmount: '15.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('重复')
  })
})
