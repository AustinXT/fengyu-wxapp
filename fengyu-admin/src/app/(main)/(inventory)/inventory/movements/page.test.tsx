/**
 * 进出明细页（#360）的 SSR 取数口径：主体选项来源、URL 参数归一、非法入参不整页 500。
 * 与单据中心页同一写法：直接 `await Page({searchParams})`，下游组件换成记录 props 的替身。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ApiError } from '@/lib/api-error'

const { captured, mockList, mockMovementOptions, mockGetSession } = vi.hoisted(() => ({
  captured: { props: null as Record<string, unknown> | null },
  mockList: vi.fn(),
  mockMovementOptions: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@/actions/inventory/movements', () => ({ listInventoryMovements: mockList }))
vi.mock('@/actions/inventory/locations', () => ({
  listInventoryMovementLocationFilterOptions: mockMovementOptions,
}))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: vi.fn() }))
vi.mock('../_components/inventory-movements-page', () => ({
  default: (props: Record<string, unknown>) => {
    captured.props = props
    return <div data-testid="inventory-movements-page" />
  },
}))

import Page from './page'

const OPTIONS = {
  headquarters: [],
  markets: [{
    locationId: 'M1',
    name: '南昌市场',
    canSelectInventory: true,
    stores: [{ locationId: 'S3', name: '八一店（已停用）' }],
  }],
  defaultLocationId: 'M1',
}
const EMPTY = { rows: [], total: 0, hasPrev: false, hasNext: false }

async function renderPage(searchParams: Record<string, string | string[] | undefined>) {
  captured.props = null
  render(await Page({ searchParams: Promise.resolve(searchParams) }))
  return captured.props!
}

beforeEach(() => {
  mockList.mockReset()
  mockMovementOptions.mockReset().mockResolvedValue(OPTIONS)
  mockGetSession.mockResolvedValue({
    employeeId: 'E1',
    permissions: { actions: ['inventory:stock_list', 'inventory:list'] },
  })
})

describe('进出明细页 SSR（#360）', () => {
  it('主体选项走含停用主体的进出明细专用来源，停用门店可被 URL 选中并查询', async () => {
    mockList.mockResolvedValue({ ...EMPTY, total: 3 })
    const props = await renderPage({ location: 'S3', batch: 'B-1', start: '2026-09-01' })
    expect(mockMovementOptions).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'S3', batchNo: 'B-1', startDate: '2026-09-01' }))
    expect(props).toMatchObject({ selectedLocationId: 'S3', hasQuery: true, errorMessage: null })
  })

  it('没输入商品编号或批号时不查库', async () => {
    const props = await renderPage({ location: 'M1' })
    expect(mockList).not.toHaveBeenCalled()
    expect(props).toMatchObject({ hasQuery: false, page: EMPTY })
  })

  it('同名参数重复（?sku=A&sku=B）给可读提示、不查库，而不是 .trim() 抛 TypeError 整页 500', async () => {
    const props = await renderPage({ location: 'M1', sku: ['A', 'B'] })
    expect(mockList).not.toHaveBeenCalled()
    expect(props.errorMessage).toBe('查询参数重复，请重新输入条件查询')
  })

  it('本页不消费的参数重复（跟踪参数等）不挡查询', async () => {
    mockList.mockResolvedValue(EMPTY)
    const props = await renderPage({ location: 'M1', batch: 'B-1', utm: ['a', 'b'] })
    expect(mockList).toHaveBeenCalledTimes(1)
    expect(props.errorMessage).toBeNull()
  })

  it('INVALID_PARAMS 转成页面提示；其余错误照常抛出', async () => {
    mockList.mockRejectedValueOnce(new ApiError('INVALID_PARAMS', '开始日期不是有效的日历日期'))
    const props = await renderPage({ location: 'M1', batch: 'B-1', start: '2026-02-31' })
    expect(props.errorMessage).toBe('开始日期不是有效的日历日期')

    mockList.mockRejectedValueOnce(new ApiError('PERMISSION_DENIED', '无权操作该库存主体'))
    await expect(renderPage({ location: 'M1', batch: 'B-1' })).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('组件 key 随 sku|batch 变化（软导航后输入框与表格同步）', async () => {
    const first = await Page({ searchParams: Promise.resolve({ location: 'M1', sku: 'A' }) })
    const second = await Page({ searchParams: Promise.resolve({ location: 'M1', batch: 'A' }) })
    // Next 的 page 文件不允许导出任意函数，key 规则没法抽成纯函数单测，只能从元素树取：
    // 结构是 <div><Suspense><InventoryMovementsPage key=…/></Suspense></div>，页面再包一层元素时这里要跟着改
    const keyOf = (element: unknown) => {
      const suspense = element as { props: { children: { props: { children: { key: string } } } } }
      return suspense.props.children.props.children.key
    }
    expect(keyOf(first)).not.toBe(keyOf(second))
  })
})
