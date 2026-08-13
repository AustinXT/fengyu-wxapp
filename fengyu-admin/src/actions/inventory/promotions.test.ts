import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, mockEngine } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
  mockEngine: {
    createInventoryPromotionPlan: vi.fn(),
    disableInventoryPromotionPlan: vi.fn(),
    getInventoryPromotionPlanById: vi.fn(),
    listInventoryPromotionPlans: vi.fn(),
    updateInventoryPromotionPlan: vi.fn(),
  },
}))

vi.mock('@/db', () => ({ db: mockDb }))
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  isAdminScope: vi.fn((session) => session.roles.some((role: { role: string }) => role.role === 'admin')),
  requirePermission: vi.fn(),
}))
vi.mock('@/lib/inventory/engine', () => mockEngine)
vi.mock('@db/inventory', () => ({
  inventoryPromotionPlans: { id: 'id', scopeMarketId: 'scope_market_id' },
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))

import { getSession } from '@/lib/auth'
import {
  disableInventoryPromotionPlan,
  updateInventoryPromotionPlan,
} from './promotions'

const MARKET_SESSION = {
  employeeId: 'E001',
  name: '市场财务',
  phone: '13800000000',
  roles: [{ role: 'finance', scopeId: 'M1', scopeType: '市场' }],
  permissions: { actions: ['inventory:update'], scopeStoreIds: [] },
}

const HQ_SESSION = {
  ...MARKET_SESSION,
  roles: [{ role: 'finance', scopeId: 'HQ', scopeType: '总部' }],
}

const INPUT = {
  name: '福利方案',
  startsAt: '2026-08-01',
  endsAt: '2026-08-31',
  items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
}

function mockPlanScope(scopeMarketId: string | null): void {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ scopeMarketId }],
      }),
    }),
  })
}

describe('库存福利方案全局范围保护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(MARKET_SESSION as never)
    mockEngine.updateInventoryPromotionPlan.mockResolvedValue({ success: true })
    mockEngine.disableInventoryPromotionPlan.mockResolvedValue({ success: true })
  })

  it('市场用户不能修改全局福利方案', async () => {
    mockPlanScope(null)

    await expect(updateInventoryPromotionPlan('P1', INPUT)).rejects.toThrow('市场用户不能修改或停用全局福利方案')
    expect(mockEngine.updateInventoryPromotionPlan).not.toHaveBeenCalled()
  })

  it('市场用户不能停用全局福利方案', async () => {
    mockPlanScope(null)

    await expect(disableInventoryPromotionPlan('P1')).rejects.toThrow('市场用户不能修改或停用全局福利方案')
    expect(mockEngine.disableInventoryPromotionPlan).not.toHaveBeenCalled()
  })

  it('总部范围用户可以维护全局福利方案', async () => {
    vi.mocked(getSession).mockResolvedValue(HQ_SESSION as never)
    mockPlanScope(null)

    await expect(updateInventoryPromotionPlan('P1', INPUT)).resolves.toEqual({ success: true })
    expect(mockEngine.updateInventoryPromotionPlan).toHaveBeenCalledWith('P1', INPUT)
  })

  it('市场用户仍可维护本市场福利方案', async () => {
    mockPlanScope('M1')

    await expect(disableInventoryPromotionPlan('P1')).resolves.toEqual({ success: true })
    expect(mockEngine.disableInventoryPromotionPlan).toHaveBeenCalledWith('P1')
  })
})
