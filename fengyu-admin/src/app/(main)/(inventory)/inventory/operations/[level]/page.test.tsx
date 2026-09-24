/**
 * 办理台页的「市场间调货接收主体候选」取数口径（#340）。
 *
 * 候选越过了操作人 scope（全部启用市场），所以只在真正用得上的地方取：
 * 市场层办理台、且当前账号能在该层建单。别的层级没有「市场间调货」卡，
 * 只读账号点不开建单表单 —— 两者多拿一份市场名单都没有用处。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const {
  captured, mockListDocs, mockListLocations, mockListMarketTargets, mockListSkus, mockListSuppliers,
  mockGetSession, mockRequireCaps,
} = vi.hoisted(() => ({
  captured: { props: null as Record<string, unknown> | null },
  mockListDocs: vi.fn(),
  mockListLocations: vi.fn(),
  mockListMarketTargets: vi.fn(),
  mockListSkus: vi.fn(),
  mockListSuppliers: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireCaps: vi.fn(),
}))

vi.mock('@/actions/inventory/docs', () => ({ listInventoryCoreDocs: mockListDocs }))
vi.mock('@/actions/inventory/locations', () => ({
  listInventoryLocations: mockListLocations,
  listInventoryMarketTransferTargets: mockListMarketTargets,
}))
vi.mock('@/actions/inventory/skus', () => ({ listInventorySkus: mockListSkus }))
vi.mock('@/actions/inventory/suppliers', () => ({ listInventorySuppliers: mockListSuppliers }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: mockRequireCaps }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  redirect: (url: string) => { throw new Error(`redirect:${url}`) },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('../../_components/inventory-operations-page', () => ({
  default: (props: Record<string, unknown>) => {
    captured.props = props
    return <div data-testid="inventory-operations-page" />
  },
}))

import Page from './page'

const BASE_ACTIONS = ['inventory:list', 'inventory:stock_list']
const TARGETS = [{ orgNodeId: 'M2', name: '九江市场' }]

async function renderWith(level: string, scopeType: string, ...actions: string[]) {
  mockGetSession.mockResolvedValue({
    employeeId: 'E-1',
    permissions: { actions: [...BASE_ACTIONS, ...actions], scopeStoreIds: [], scopeOrgNodeIds: ['N-1'] },
    roles: [{ role: 'r', scopeId: 'N-1', scopeType, actions: [...BASE_ACTIONS, ...actions] }],
  })
  render(await Page({ params: Promise.resolve({ level }), searchParams: Promise.resolve({}) }))
  expect(captured.props, '替身没被渲染，props 没抓到').not.toBeNull()
  return captured.props as { marketTransferTargets: unknown; canCreate: boolean }
}

beforeEach(() => {
  vi.clearAllMocks()
  captured.props = null
  mockListLocations.mockResolvedValue([])
  mockListMarketTargets.mockResolvedValue(TARGETS)
  mockListSkus.mockResolvedValue({ data: [], total: 0 })
  mockListSuppliers.mockResolvedValue({ data: [], total: 0 })
  mockListDocs.mockResolvedValue({ data: [], total: 0, canViewPrice: false })
})

describe('办理台 · 市场间调货接收主体候选（#340）', () => {
  it('市场层 + 市场 operate → 取候选并传给页面', async () => {
    const props = await renderWith('market', '市场', 'inventory:market_operate')
    expect(props.canCreate).toBe(true)
    expect(mockListMarketTargets).toHaveBeenCalledTimes(1)
    expect(props.marketTransferTargets).toEqual(TARGETS)
  })

  it('市场层但只能审批（无 operate）→ 不取', async () => {
    const props = await renderWith('market', '市场', 'inventory:market_approve')
    expect(props.canCreate).toBe(false)
    expect(mockListMarketTargets).not.toHaveBeenCalled()
    expect(props.marketTransferTargets).toEqual([])
  })

  it('门店层 → 不取（门店层没有市场间调货卡）', async () => {
    const props = await renderWith('store', '门店', 'inventory:store_operate')
    expect(props.canCreate).toBe(true)
    expect(mockListMarketTargets).not.toHaveBeenCalled()
    expect(props.marketTransferTargets).toEqual([])
  })
})
