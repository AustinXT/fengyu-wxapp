/**
 * 报货福利方案页的维护入口口径（#354）：福利方案只由总部供应链维护，市场账号只读。
 *
 * 页面是 async Server Component：直接 `await Page()` 渲染真实的 InventoryPromotionsPage，
 * 断言市场账号看得到列表、却没有新建 / 编辑 / 停用入口。
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryPromotionPlanRow } from '@/lib/inventory/types'

const { mockListPlans, mockListLocations, mockGetSession } = vi.hoisted(() => ({
  mockListPlans: vi.fn(),
  mockListLocations: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@/actions/inventory/promotions', () => ({
  listInventoryPromotionPlans: mockListPlans,
  createInventoryPromotionPlan: vi.fn(),
  disableInventoryPromotionPlan: vi.fn(),
  updateInventoryPromotionPlan: vi.fn(),
}))
vi.mock('@/actions/inventory/locations', () => ({ listInventoryLocations: mockListLocations }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/inventory/promotions',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({ get: (_key: string, defaultValue = '') => defaultValue, setMany: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../_components/inventory-sku-search-select', () => import('../_components/__stubs__/inventory-sku-search-select.stub'))
vi.mock('../_components/inventory-master-data-tabs', () => ({ InventoryMasterDataTabs: () => null }))

import Page from './page'

const MANAGE = 'inventory:supply_chain_master_data_manage'
const BASE = ['inventory:list', 'inventory:stock_list']

function plan(id: string, scopeMarketId: string | null): InventoryPromotionPlanRow {
  return {
    id,
    planNo: `FL-${id}`,
    name: `方案${id}`,
    startsAt: '2026-09-01',
    endsAt: '2026-09-30',
    scopeMarketId,
    scopeMarketName: scopeMarketId ? '市场一' : null,
    ruleType: '单品阶梯',
    status: '启用',
    remark: null,
    itemCount: 0,
    items: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function sessionWith(scopeType: '总部' | '市场', scopeId: string, actions: string[]) {
  const all = [...BASE, ...actions]
  return {
    employeeId: 'E-1',
    roles: [{ role: 'inventory_role', scopeId, scopeType, actions: all, scopeStoreIds: [], scopeOrgNodeIds: [scopeId] }],
    permissions: { actions: all, scopeStoreIds: [], scopeOrgNodeIds: [scopeId] },
  }
}

describe('报货福利方案页维护入口（#354）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListPlans.mockResolvedValue([plan('G', null), plan('M', 'M1')])
    mockListLocations.mockResolvedValue([{ locationId: 'M1', locationType: '市场', name: '市场一' }])
  })

  it('只有 market_operate 的市场账号：列表可见，不渲染新建、编辑、停用入口', async () => {
    mockGetSession.mockResolvedValue(sessionWith('市场', 'M1', ['inventory:market_operate', 'inventory:market_price_view']))
    render(await Page())
    expect(screen.getByText('方案G')).toBeInTheDocument()
    expect(screen.getByText('方案M')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /新建方案/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /停用/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(2)
  })

  it('市场绑定即便带供应链维护动作也不给入口（权限须来自总部 scope）', async () => {
    mockGetSession.mockResolvedValue(sessionWith('市场', 'M1', [MANAGE, 'inventory:market_price_view']))
    render(await Page())
    expect(screen.queryByRole('button', { name: /新建方案/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument()
  })

  it('总部供应链：全局与市场方案都有编辑、停用入口，可新建', async () => {
    mockGetSession.mockResolvedValue(sessionWith('总部', 'HQ', [MANAGE, 'inventory:supply_chain_price_view']))
    render(await Page())
    expect(screen.getByRole('button', { name: /新建方案/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /编辑/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /停用/ })).toHaveLength(2)
  })
})
