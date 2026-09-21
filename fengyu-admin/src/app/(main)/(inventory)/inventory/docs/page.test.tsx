/**
 * 单据中心页的**权限口径**守护（#191 后续）。
 *
 * 这个页面只做两件会错的事：算「能建哪些单据类型」和算「能不能收货」。
 * 两者原先共用同一个 `operateByLevel` 对象，放开向下代建时被拆开 —— 拆完之后
 * `canReceive` 的唯一防线只剩一句注释，谁顺手把它接回 `inventoryCreatableGenericDocTypes`，
 * 只有供应链权限的账号就会冒出「确认收货」按钮，而收货是实打实写库存的动作。
 *
 * 页面是 async Server Component：直接 `await Page({searchParams})`，把下游的
 * InventoryDocsPage 换成记录 props 的替身，断言传下去的口径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { InventoryDocType } from '@/lib/inventory/types'
import { INVENTORY_GENERIC_DOC_TYPES } from '@/lib/inventory/types'

const SUPPLY = 'inventory:supply_chain_operate'
const MARKET = 'inventory:market_operate'
const STORE = 'inventory:store_operate'
/** 三个 operate 的 UI 硬依赖（permission-presentation 的 dependencies），缺了 hasUiCapability 恒假。 */
const BASE_ACTIONS = ['inventory:list', 'inventory:stock_list']

const {
  captured, mockListDocs, mockFilterOptions, mockListLocations, mockListSkus,
  mockGetSession, mockRequireCaps,
} = vi.hoisted(() => ({
  captured: { props: null as Record<string, unknown> | null },
  mockListDocs: vi.fn(),
  mockFilterOptions: vi.fn(),
  mockListLocations: vi.fn(),
  mockListSkus: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireCaps: vi.fn(),
}))

vi.mock('@/actions/inventory/docs', () => ({ listInventoryCoreDocs: mockListDocs }))
vi.mock('@/actions/inventory/locations', () => ({
  listInventoryDocLocationFilterOptions: mockFilterOptions,
  listInventoryLocations: mockListLocations,
}))
vi.mock('@/actions/inventory/skus', () => ({ listInventorySkus: mockListSkus }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: mockRequireCaps }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('../_components/inventory-docs-page', () => ({
  default: (props: Record<string, unknown>) => {
    captured.props = props
    return <div data-testid="inventory-docs-page" />
  },
}))

import Page from './page'

interface DocsPageProps {
  canCreate: boolean
  canApprove: boolean
  canReceive: boolean
  allowedCreateDocTypes: readonly InventoryDocType[]
}

/** 用给定 action 集渲染页面，拿到传给 InventoryDocsPage 的 props。 */
async function renderWith(...actions: string[]): Promise<DocsPageProps> {
  mockGetSession.mockResolvedValue({
    employeeId: 'E-1',
    permissions: { actions: [...BASE_ACTIONS, ...actions], scopeStoreIds: [], scopeOrgNodeIds: [] },
    roles: [],
  })
  render(await Page({ searchParams: Promise.resolve({}) }))
  expect(captured.props, '替身没被渲染，props 没抓到').not.toBeNull()
  return captured.props as unknown as DocsPageProps
}

beforeEach(() => {
  vi.clearAllMocks()
  captured.props = null
  // defaultLocationId=null ⇒ selectedOrgNodeId=null ⇒ 页面走空列表分支，不查单据。
  mockFilterOptions.mockResolvedValue({ headquarters: [], markets: [], defaultLocationId: null })
  mockListLocations.mockResolvedValue([])
  mockListSkus.mockResolvedValue({ data: [], total: 0 })
  mockListDocs.mockResolvedValue({ data: [], total: 0, canViewPrice: false })
})

/**
 * 收货**不随代建放开**：#191 放开的只是「替下级建单」，收货仍只认市场 / 门店自己的
 * operate。供应链账号没有收货主体（总部 scope 不展开后代），给它按钮就是给一个必然
 * 403 的动作。
 */
describe('单据中心 · canReceive 口径', () => {
  it('只有供应链 operate → 不给收货', async () => {
    expect((await renderWith(SUPPLY)).canReceive).toBe(false)
  })

  it('市场 operate → 可收货', async () => {
    expect((await renderWith(MARKET)).canReceive).toBe(true)
  })

  it('门店 operate → 可收货', async () => {
    expect((await renderWith(STORE)).canReceive).toBe(true)
  })

  it('市场 + 门店任一即可（双持也为真）', async () => {
    expect((await renderWith(MARKET, STORE)).canReceive).toBe(true)
  })

  it('一个 operate 都没有 → 不给收货', async () => {
    expect((await renderWith()).canReceive).toBe(false)
  })

  it('canReceive 与 canCreate 是两条口径，不能被合并回同一个表达式', async () => {
    // 供应链账号建得了「内部领用」（canCreate=true）却不该收货。
    // 谁把 canReceive 接回 inventoryCreatableGenericDocTypes，这条立刻红。
    const props = await renderWith(SUPPLY)
    expect(props.canCreate).toBe(true)
    expect(props.canReceive).toBe(false)
  })
})

/**
 * 建单下拉只给走得通的选项（P2-a）：代建候选集按「scope 会不会向下展开」收紧后，
 * 只有 supply_chain_operate 的账号下拉里应当只剩「内部领用」，而不是 10 种里 9 种死路。
 */
describe('单据中心 · 建单下拉候选', () => {
  it('只有供应链 operate → 下拉只有内部领用', async () => {
    expect((await renderWith(SUPPLY)).allowedCreateDocTypes).toEqual(['内部领用'])
  })

  it('只有市场 operate → 市场 4 种 + 门店 5 种（市场替门店建单），不含内部领用', async () => {
    const types = (await renderWith(MARKET)).allowedCreateDocTypes
    expect(types).toHaveLength(9)
    expect(types).not.toContain('内部领用')
  })

  it('只有门店 operate → 只有门店 5 种', async () => {
    const types = (await renderWith(STORE)).allowedCreateDocTypes
    expect(types).toHaveLength(5)
    expect(types).not.toContain('市场产品报损')
  })

  it('供应链 + 市场双持 → 10 种全开，canCreate 为真', async () => {
    const props = await renderWith(SUPPLY, MARKET)
    expect(props.allowedCreateDocTypes).toEqual([...INVENTORY_GENERIC_DOC_TYPES])
    expect(props.canCreate).toBe(true)
  })

  it('一个 operate 都没有 → 下拉为空且 canCreate 为假', async () => {
    const props = await renderWith()
    expect(props.allowedCreateDocTypes).toEqual([])
    expect(props.canCreate).toBe(false)
  })
})
