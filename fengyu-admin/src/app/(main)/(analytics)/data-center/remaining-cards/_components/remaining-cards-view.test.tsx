import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RemainingCardsReport } from '@/actions/data-center/remaining-cards'

/**
 * 顾客剩余卡项清单页面主体（#371）：四态单元格、悬停、合计行、显示范围 / 搜索 / 排序 / 分页写 URL、导出 payload。
 */

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))
const exportJobs = vi.hoisted(() => ({ createExportJob: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => '/data-center/remaining-cards',
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/actions/export-jobs', () => exportJobs)

import { RemainingCardsView } from './remaining-cards-view'

const report: RemainingCardsReport = {
  columns: [
    { categoryId: 'C1', categoryName: '招牌', kind: '招牌', kindSort: 1, sort: 1 },
    { categoryId: 'C2', categoryName: '美艺美肤', kind: '明星', kindSort: 3, sort: 1 },
    { categoryId: 'C3', categoryName: '功能灸', kind: '王牌', kindSort: 2, sort: 6 },
  ],
  rows: [
    {
      key: 'U1:S1', clientUserId: 'U1', storeId: 'S1', storeName: '蓝莱店', customerName: '张三',
      phoneMasked: '138****2222', level: '金卡', remaining: 5,
      cells: {
        C1: { state: 'remaining', remaining: 5, unpaid: 0, served: 3, convertedOut: 0, deposit: true, frozen: false },
        C2: { state: 'unpaid', remaining: 0, unpaid: 2, served: 0, convertedOut: 0, deposit: false, frozen: true },
      },
    },
    {
      key: 'U2:S1', clientUserId: 'U2', storeId: 'S1', storeName: '蓝莱店', customerName: '李四',
      phoneMasked: '139****3333', level: '会员客', remaining: 0,
      cells: { C1: { state: 'done', remaining: 0, unpaid: 0, served: 4, convertedOut: 6, deposit: false, frozen: false } },
    },
  ],
  total: 2,
  filteredCustomerCount: 2,
  filtered: false,
  page: 1,
  pageSize: 50,
  totals: { remaining: 5, 'cat:C1': 5, 'cat:C2': 0, 'cat:C3': 0 },
  summary: {
    rowCount: 2, customerCount: 2, remainingCustomerCount: 1, remainingCustomerRate: 0.5,
    remainingSessions: 5, remainingCategoryCount: 1, remainingCells: 1, unpaidCells: 1,
    doneCells: 1, neverCells: 3, expiredCells: 0, categoryCount: 3, kindCount: 3,
  },
  asOf: '2026-09-25',
}

function lastUrl() {
  return String(nav.replace.mock.calls.at(-1)?.[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  nav.search = 'scope=store&scopeId=S1'
})

describe('RemainingCardsView', () => {
  it('指标卡：6 张，按范围全量', () => {
    render(<RemainingCardsView report={report} />)
    for (const label of ['统计顾客数', '有剩余卡项顾客', '待服务剩余次数', '有余额品项（项次）', '已服务完（项次）', '未买过（项次）']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('占比 50.00%')).toBeInTheDocument()
    expect(screen.getByText('另有待付清 1 项次')).toBeInTheDocument()
  })

  it('表头两行按一级分组，四态单元格：✓ / 待付清（冻结角标）/ 已服务完 / 留空', () => {
    render(<RemainingCardsView report={report} />)
    const table = screen.getByRole('table')
    const groupHeaders = within(table).getAllByRole('columnheader').filter((th) => th.getAttribute('scope') === 'colgroup')
    expect(groupHeaders.map((th) => th.textContent)).toEqual(['招牌', '明星', '王牌'])

    const [first, second] = within(table).getAllByRole('row').filter((tr) => tr.closest('tbody'))
    const firstCells = within(first).getAllByRole('cell')
    expect(firstCells[0]).toHaveTextContent('蓝莱店')
    expect(firstCells[1]).toHaveTextContent('张三138****2222')
    expect(firstCells[2]).toHaveTextContent('金卡')
    expect(firstCells[3]).toHaveTextContent('✓')
    expect(firstCells[3]).toHaveAttribute('data-tone', 'accent')
    expect(firstCells[4]).toHaveTextContent('待付清冻')
    expect(firstCells[4]).toHaveAttribute('data-tone', 'pending')
    expect(firstCells[5]).toHaveTextContent('')
    expect(firstCells[5]).not.toHaveAttribute('data-tone')
    expect(firstCells[6]).toHaveTextContent('5')
    const secondCells = within(second).getAllByRole('cell')
    expect(secondCells[3]).toHaveTextContent('已服务完')
    expect(secondCells[3]).toHaveAttribute('data-tone', 'muted')

    const totals = table.querySelector('tr[data-totals]')!
    expect(totals).toHaveTextContent('合计')
    expect(within(totals as HTMLElement).getAllByRole('cell').map((td) => td.textContent)).toEqual(['合计', '', '', '5', '0', '0', '5'])
  })

  it('悬停显示格子说明', async () => {
    render(<RemainingCardsView report={report} />)
    const firstRow = within(screen.getByRole('table')).getAllByRole('row').filter((tr) => tr.closest('tbody'))[0]
    await userEvent.hover(within(firstRow).getByText('✓'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('剩余 5 次未服务（已服务 3 次）；含迁移寄存')
  })

  it('显示范围、排序、翻页写 URL 并回到第 1 页', async () => {
    render(<RemainingCardsView report={{ ...report, total: 120 }} />)
    await userEvent.click(screen.getByRole('button', { name: '只看有剩余' }))
    expect(lastUrl()).toBe('/data-center/remaining-cards?scope=store&scopeId=S1&show=remaining')

    await userEvent.click(screen.getByRole('button', { name: /剩余次数/ }))
    expect(lastUrl()).toContain('dir=asc')
  })

  it('搜索防抖后写 q；导出 payload 带当前 URL 参数与报表视图名', async () => {
    vi.useFakeTimers()
    try {
      render(<RemainingCardsView report={report} />)
      fireEvent.change(screen.getByRole('textbox', { name: '顾客搜索' }), { target: { value: ' 13811112222 ' } })
      expect(nav.replace).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(500) })
      expect(lastUrl()).toBe('/data-center/remaining-cards?scope=store&scopeId=S1&q=13811112222')
    } finally {
      vi.useRealTimers()
    }

    exportJobs.createExportJob.mockResolvedValue({ id: 1, reused: false })
    await userEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(exportJobs.createExportJob).toHaveBeenCalledWith({
      exportType: 'data-center',
      payload: { view: 'report-remaining-cards', params: { scope: 'store', scopeId: 'S1' } },
    })
  })
})
