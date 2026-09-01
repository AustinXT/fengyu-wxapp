import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockImpl, mockGetSession } = vi.hoisted(() => ({
  mockImpl: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/inventory/settlements', () => ({
  listInventorySettlements: mockImpl,
}))

import { listInventorySettlements } from './settlements'

const INVENTORY_SESSION = {
  employeeId: 'E001',
  name: '市场库存财务',
  phone: '13800000000',
  roles: [{
    role: 'inventory_market_finance',
    scopeId: 'M1',
    scopeType: '市场',
    scopeStoreIds: [],
    scopeOrgNodeIds: ['M1'],
    actions: ['inventory:list', 'inventory:market_price_view'],
  }],
  permissions: {
    actions: ['inventory:list', 'inventory:market_price_view'],
    scopeStoreIds: [],
    scopeOrgNodeIds: ['M1'],
  },
} as never

const NO_INVENTORY_SESSION = {
  employeeId: 'E002',
  name: '店长',
  phone: '13800000001',
  roles: [{
    role: 'manager',
    scopeId: 'S1',
    scopeType: '门店',
    scopeStoreIds: ['S1'],
    scopeOrgNodeIds: ['S1'],
    actions: ['sale_order:list'],
  }],
  permissions: { actions: ['sale_order:list'], scopeStoreIds: ['S1'], scopeOrgNodeIds: ['S1'] },
} as never

describe('货款结算 Server Action 薄壳', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('持 inventory:list 时转发筛选参数给实现层', async () => {
    mockGetSession.mockResolvedValue(INVENTORY_SESSION)
    mockImpl.mockResolvedValue({ marketRows: [], storeRows: [] })

    await expect(listInventorySettlements({ startDate: '2026-09-01', endDate: '2026-09-02' }))
      .resolves.toEqual({ marketRows: [], storeRows: [] })
    expect(mockImpl).toHaveBeenCalledWith({ startDate: '2026-09-01', endDate: '2026-09-02' })
  })

  it('缺 inventory:list 抛 PERMISSION_DENIED 且不触达实现层', async () => {
    mockGetSession.mockResolvedValue(NO_INVENTORY_SESSION)

    await expect(listInventorySettlements()).rejects.toThrow('PERMISSION_DENIED')
    expect(mockImpl).not.toHaveBeenCalled()
  })
})
