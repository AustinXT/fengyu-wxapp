import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEngine } = vi.hoisted(() => ({
  mockEngine: {
    createInventoryPromotionPlan: vi.fn(),
    disableInventoryPromotionPlan: vi.fn(),
    getInventoryPromotionPlanById: vi.fn(),
    listInventoryPromotionPlans: vi.fn(),
    updateInventoryPromotionPlan: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
// 权限判定按会话级 actions 真实模拟：缺动作即 PERMISSION_DENIED（与 requirePermission 同前缀）
vi.mock('@/lib/permissions', () => {
  type Session = { roles: Array<{ role: string; isSuperAdmin?: boolean }>; permissions: { actions: string[] } }
  const hasPermission = (session: Session, action: string) => session.permissions.actions.includes(action)
  return {
    hasPermission,
    isAdminScope: (session: Session) => session.roles.some((role) => role.isSuperAdmin ?? role.role === 'admin'),
    requirePermission: (session: Session, action: string) => {
      if (!hasPermission(session, action)) throw new Error(`PERMISSION_DENIED: ${action}`)
    },
    requireAnyPermission: (session: Session, actions: string[]) => {
      if (!actions.some((action) => hasPermission(session, action))) throw new Error(`PERMISSION_DENIED: ${actions.join('|')}`)
    },
  }
})
vi.mock('@/lib/inventory/engine', () => mockEngine)

import { getSession } from '@/lib/auth'
import {
  createInventoryPromotionPlan,
  disableInventoryPromotionPlan,
  listInventoryPromotionPlans,
  updateInventoryPromotionPlan,
} from './promotions'

const MANAGE = 'inventory:supply_chain_master_data_manage'
const MARKET_FINANCE_ACTIONS = [
  'inventory:list', 'inventory:stock_list', 'inventory:market_operate', 'inventory:market_price_view',
]
const SUPPLY_CHAIN_ACTIONS = ['inventory:list', 'inventory:stock_list', MANAGE, 'inventory:supply_chain_price_view']

function session(scopeType: '总部' | '市场', scopeId: string, actions: string[], role = 'inventory_role') {
  return {
    employeeId: 'E001',
    name: '测试',
    phone: '13800000000',
    roles: [{ role, scopeId, scopeType, actions, scopeStoreIds: [], scopeOrgNodeIds: [scopeId] }],
    permissions: { actions, scopeStoreIds: [], scopeOrgNodeIds: [scopeId] },
  }
}

const MARKET_FINANCE = session('市场', 'M1', MARKET_FINANCE_ACTIONS, 'inventory_market_finance')
// 市场绑定被误授了供应链维护动作：动作级放行，但不是总部 scope，仍须拒绝
const MARKET_WITH_MANAGE = session('市场', 'M1', [...MARKET_FINANCE_ACTIONS, MANAGE])
const SUPPLY_CHAIN = session('总部', 'HQ', SUPPLY_CHAIN_ACTIONS, 'inventory_supply_chain_operator')
const SUPER_ADMIN = { ...session('总部', 'HQ', [MANAGE]), roles: [{ ...session('总部', 'HQ', [MANAGE]).roles[0], role: 'admin', isSuperAdmin: true }] }

const INPUT = {
  name: '福利方案',
  startsAt: '2026-08-01',
  endsAt: '2026-08-31',
  items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
}

describe('报货福利方案只由总部供应链维护（#354）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEngine.createInventoryPromotionPlan.mockResolvedValue({ id: 'P1' })
    mockEngine.updateInventoryPromotionPlan.mockResolvedValue({ success: true })
    mockEngine.disableInventoryPromotionPlan.mockResolvedValue({ success: true })
    mockEngine.listInventoryPromotionPlans.mockResolvedValue([])
  })

  it.each([
    ['市场库存财务', MARKET_FINANCE],
    ['市场绑定误授供应链维护动作', MARKET_WITH_MANAGE],
  ])('%s：新建、修改、停用均 PERMISSION_DENIED，且不进引擎', async (_label, current) => {
    vi.mocked(getSession).mockResolvedValue(current as never)

    await expect(createInventoryPromotionPlan(INPUT)).rejects.toThrow(/^PERMISSION_DENIED/)
    await expect(updateInventoryPromotionPlan('P1', INPUT)).rejects.toThrow(/^PERMISSION_DENIED/)
    await expect(disableInventoryPromotionPlan('P1')).rejects.toThrow(/^PERMISSION_DENIED/)
    expect(mockEngine.createInventoryPromotionPlan).not.toHaveBeenCalled()
    expect(mockEngine.updateInventoryPromotionPlan).not.toHaveBeenCalled()
    expect(mockEngine.disableInventoryPromotionPlan).not.toHaveBeenCalled()
  })

  it('市场库存财务仍可查看福利方案列表', async () => {
    vi.mocked(getSession).mockResolvedValue(MARKET_FINANCE as never)
    await expect(listInventoryPromotionPlans()).resolves.toEqual([])
  })

  it.each([
    ['总部供应链（非超管）', SUPPLY_CHAIN],
    ['超级管理员', SUPER_ADMIN],
  ])('%s：新建（全局 / 指定市场）、修改、停用均放行到引擎', async (_label, current) => {
    vi.mocked(getSession).mockResolvedValue(current as never)

    await expect(createInventoryPromotionPlan(INPUT)).resolves.toEqual({ id: 'P1' })
    await expect(createInventoryPromotionPlan({ ...INPUT, scopeMarketId: 'M1' })).resolves.toEqual({ id: 'P1' })
    await expect(updateInventoryPromotionPlan('P1', INPUT)).resolves.toEqual({ success: true })
    await expect(disableInventoryPromotionPlan('P1')).resolves.toEqual({ success: true })
    expect(mockEngine.createInventoryPromotionPlan).toHaveBeenCalledWith({ ...INPUT, scopeMarketId: 'M1' })
    expect(mockEngine.updateInventoryPromotionPlan).toHaveBeenCalledWith('P1', INPUT)
    expect(mockEngine.disableInventoryPromotionPlan).toHaveBeenCalledWith('P1')
  })
})
