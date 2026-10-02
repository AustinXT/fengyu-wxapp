import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { CustomerBoardResult, DataCenterScopeOptions } from '@/lib/data-center/types'
import type { StoreDataStarts } from '@/lib/data-center/data-start'

/**
 * 客量板数据起点提示（#289）：跨 scope 内门店数据起点的区间整块提示，完全位于起点之后的区间不提示。
 * 判定走 lib/data-center/data-start.ts 的 evaluateDataStart（不另写判定），这里只钉接线：
 * 期间取自与数字同一次取数的 timeRange、门店取自同一次取数的 scope、轴 = 业绩 + 服务。
 */
const { getCustomerBoard, query } = vi.hoisted(() => ({ getCustomerBoard: vi.fn(), query: { value: '' } }))

vi.mock('@/actions/data-center/customer', () => ({ getCustomerBoard }))
vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({ searchParams: new URLSearchParams(query.value) }),
}))
// 明细表与本用例无关，且依赖导出链路
vi.mock('../breakdown-table', () => ({ BreakdownTable: () => null }))

import { CustomerBoard } from './customer-board'

const scopeOptions: DataCenterScopeOptions = {
  topLevel: 'all',
  inactiveStores: [],
  markets: [
    { id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '青云店' }] },
    { id: 'M2', name: '昭通', stores: [{ storeId: 'S2', storeName: '昭阳店' }] },
  ],
}
const starts: StoreDataStarts = {
  S1: { performance: '2026-07-03', service: '2026-07-08' },
  S2: { performance: '2026-09-14', service: '2026-09-14' },
}

function result(
  start: string,
  end: string,
  previous: { start: string; end: string } | null = null,
): CustomerBoardResult {
  return {
    scope: { type: 'all', id: null, name: '全部' },
    timeRange: { start, end, presetLabel: '自定义', previous, lastYear: null },
    kpis: {},
    byMarket: [],
    byStore: [],
  } as unknown as CustomerBoardResult
}

async function renderBoard(res: CustomerBoardResult, dataStarts: StoreDataStarts | null = starts) {
  getCustomerBoard.mockResolvedValue(res)
  render(<CustomerBoard scopeOptions={scopeOptions} dataStarts={dataStarts} />)
  await waitFor(() => expect(getCustomerBoard).toHaveBeenCalled())
  await screen.findByText('注册与保有')
}

beforeEach(() => {
  vi.clearAllMocks()
  query.value = ''
})

describe('客量板 · 数据起点提示（#289）', () => {
  it('「今年」跨两家店的起点：整块板显示提示，按市场列出业绩与服务两条轴', async () => {
    await renderBoard(result('2026-01-01', '2026-09-26'))
    const note = await screen.findByRole('note', { name: '数据起点提示' })
    expect(note).toHaveTextContent('所选期间（2026-01-01 ~ 2026-09-26）早于部分门店的数据起点')
    expect(note).toHaveTextContent('业绩 · 南昌凤御 1 家（2026-07-03 起）')
    expect(note).toHaveTextContent('服务 · 南昌凤御 1 家（2026-07-08 起）')
    expect(note).toHaveTextContent('业绩 · 昭通 1 家（2026-09-14 起）')
  })

  it('完全位于全部门店起点之后的区间不提示', async () => {
    await renderBoard(result('2026-09-15', '2026-09-26'))
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
  })

  it('只看单店时只按该店的起点判定（门店随取数时的 scope 展开）', async () => {
    query.value = 'scope=store&scopeId=S1'
    await renderBoard(result('2026-08-01', '2026-08-31'))
    expect(getCustomerBoard.mock.calls[0][0].scope).toEqual({ type: 'store', id: 'S1' })
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
  })

  it('当期完整、环比基期跨起点：提示基期', async () => {
    await renderBoard(result('2026-09-15', '2026-09-26', { start: '2026-09-03', end: '2026-09-14' }))
    const note = await screen.findByRole('note', { name: '数据起点提示' })
    expect(note).toHaveTextContent('环比基期（2026-09-03 ~ 2026-09-14）早于部分门店的数据起点')
    expect(note).toHaveTextContent('昭通 1 家（2026-09-14 起）')
  })

  it('关掉同比环比（cmp=0）时基期不参与提示', async () => {
    query.value = 'cmp=0'
    await renderBoard(result('2026-09-15', '2026-09-26', { start: '2026-09-03', end: '2026-09-14' }))
    expect(getCustomerBoard.mock.calls[0][0].withComparison).toBe(false)
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
  })

  it('数据起点缺失（取数失败降级 / 未下发）时不提示', async () => {
    await renderBoard(result('2026-01-01', '2026-09-26'), {})
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
  })

  it('取数失败时正常渲染错误卡（提示的 hook 不能写在 error 早退之后）', async () => {
    getCustomerBoard.mockRejectedValue(new Error('boom'))
    render(<CustomerBoard scopeOptions={scopeOptions} dataStarts={starts} />)
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument()
  })

  it('新客客单卡注明含 WorkFine 历史单', async () => {
    await renderBoard(result('2026-09-15', '2026-09-26'))
    expect(screen.getByText('含 WorkFine 历史单（订单级实收）')).toBeInTheDocument()
  })
})
