import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryPromotionPlanRow } from '@/lib/inventory/types'

const { urlParams, mockSetMany, mockRefresh } = vi.hoisted(() => ({
  urlParams: {} as Record<string, string>,
  mockSetMany: vi.fn(),
  mockRefresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (key: string, defaultValue = '') => urlParams[key] ?? defaultValue,
    setMany: mockSetMany,
  }),
}))

vi.mock('@/actions/inventory/promotions', () => ({
  createInventoryPromotionPlan: vi.fn(),
  disableInventoryPromotionPlan: vi.fn(),
  updateInventoryPromotionPlan: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./inventory-sku-search-select', () => import('./__stubs__/inventory-sku-search-select.stub'))

import InventoryPromotionsPage from './inventory-promotions-page'

function plan(index: number, status: '启用' | '停用'): InventoryPromotionPlanRow {
  return {
    id: `PLAN-${index}`,
    planNo: `FL-${String(index).padStart(3, '0')}`,
    name: `方案${index}`,
    startsAt: '2026-09-01',
    endsAt: '2026-09-30',
    scopeMarketId: null,
    scopeMarketName: null,
    ruleType: '单品阶梯',
    status,
    remark: null,
    itemCount: 0,
    items: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function renderPage(rows: InventoryPromotionPlanRow[]) {
  return render(
    <InventoryPromotionsPage
      rows={rows}
      marketOptions={[]}
      canCreate={false}
      canUpdate={false}
      canViewPrice
      canManageGlobal
    />,
  )
}

describe('福利方案列表分页（#135）', () => {
  beforeEach(() => {
    for (const key of Object.keys(urlParams)) delete urlParams[key]
    vi.clearAllMocks()
  })

  it('分页发生在筛选之后，而不是之前', () => {
    // 这一页的关键词/市场/状态三个筛选都在组件的 useMemo 里做。若先按页切 20 条
    // 再让客户端去筛，用户筛到的就只是当前页那一屏的匹配项，翻页还会看到不同结果。
    //
    // 数据刻意这样排：前 10 条全是「启用」，后 20 条里才有 5 条「停用」。
    //   先筛后分页（正确）→ 筛出 5 条，第 1 页全部显示
    //   先分页后筛（错误）→ 第 1 页那 10 条里一条停用都没有，显示 0 条
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => plan(i, '启用')),
      ...Array.from({ length: 5 }, (_, i) => plan(10 + i, '停用')),
      ...Array.from({ length: 15 }, (_, i) => plan(15 + i, '启用')),
    ]
    urlParams.status = '停用'
    urlParams.size = '10'
    renderPage(rows)

    expect(screen.getByText('共 5 条')).toBeInTheDocument()
    for (let i = 10; i < 15; i += 1) {
      expect(screen.getByText(`方案${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByText('方案0')).not.toBeInTheDocument()
  })

  it('总数是筛选后的条数，不是全量条数', () => {
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => plan(i, '启用')),
      ...Array.from({ length: 8 }, (_, i) => plan(22 + i, '停用')),
    ]
    urlParams.status = '停用'
    renderPage(rows)

    expect(screen.getByText('共 8 条')).toBeInTheDocument()
    expect(screen.queryByText('共 30 条')).not.toBeInTheDocument()
  })

  it('按 pageSize 切页，第 2 页接着第 1 页', () => {
    const rows = Array.from({ length: 25 }, (_, i) => plan(i, '启用'))
    urlParams.size = '10'
    urlParams.page = '2'
    renderPage(rows)

    expect(screen.getByText('共 25 条')).toBeInTheDocument()
    expect(screen.getByText('方案10')).toBeInTheDocument()
    expect(screen.getByText('方案19')).toBeInTheDocument()
    expect(screen.queryByText('方案9')).not.toBeInTheDocument()
    expect(screen.queryByText('方案20')).not.toBeInTheDocument()
  })

  it('页码越界时夹到最后一页，不显示空列表', () => {
    // searchInput 是本地 state：打字时 filteredRows 立刻变短，而重置 page 的
    // setMany 要等 300ms debounce —— 这中间 page 会越界。不夹一下会闪一屏空白。
    const rows = Array.from({ length: 5 }, (_, i) => plan(i, '启用'))
    urlParams.size = '10'
    urlParams.page = '99'
    renderPage(rows)

    expect(screen.getByText('方案0')).toBeInTheDocument()
    expect(screen.getByText('共 5 条')).toBeInTheDocument()
  })
})
