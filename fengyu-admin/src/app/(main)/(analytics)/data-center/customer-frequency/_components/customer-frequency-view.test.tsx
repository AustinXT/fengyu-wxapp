import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CustomerFrequencyReport } from '@/actions/data-center/customer-frequency'

/**
 * 顾客频率表页面主体（#370）：9 张指标卡、单元格四种形态、悬停、周末列、合计行、排序 / 开关写 URL、导出 payload。
 */

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))
const exportJobs = vi.hoisted(() => ({ createExportJob: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => '/data-center/customer-frequency',
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/actions/export-jobs', () => exportJobs)

import { CustomerFrequencyView } from './customer-frequency-view'

const cell = (visited: boolean, amount: number | null, patch = {}) => ({ visited, amount, consume: null, items: [], stores: [], ...patch })

const report: CustomerFrequencyReport = {
  month: '2026-02',
  rows: [{
    clientUserId: 'U1', customerName: '张三', phoneMasked: '138****2222', level: '金卡', storeName: '蓝莱店',
    days: {
      1: cell(true, 120, { consume: 80, items: ['面部'], stores: ['蓝莱店'] }),
      2: cell(true, 0),
      3: cell(false, -50),
    },
    visitDays: 2, amount: 70, consume: 80,
  }],
  total: 1,
  filtered: false,
  beforeDataStart: false,
  page: 1,
  pageSize: 50,
  sort: { key: 'visitDays', direction: 'desc' },
  totals: { visitDays: 2, amount: 70 },
  summary: {
    customerCount: 4, visitedCount: 2, visitRate: 0.5,
    tiers: { low: { count: 1, share: 0.5 }, mid: { count: 1, share: 0.5 }, high: { count: 0, share: 0 } },
    visitTotal: 5, visitsPerVisitor: 2.5, amountTotal: 1000, consumeTotal: 1325, consumeRatio: 1.325,
  },
}

function lastUrl() {
  return String(nav.replace.mock.calls.at(-1)?.[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  nav.search = 'scope=store&scopeId=S1&month=2026-02'
})

describe('CustomerFrequencyView', () => {
  it('指标卡 9 张（3 × 3），附到店率 / 分档占比 / 消耗消费比', () => {
    render(<CustomerFrequencyView report={report} />)
    for (const label of [
      '统计顾客数（位）', '本月有到店顾客（位）', '低频顾客（1~2 天）', '中频顾客（3~4 天）', '高频顾客（≥5 天）',
      '本月到店总人次', '人均到店（次）', '本月消费合计（元）', '本月消耗合计（元）',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('到店率 50.00%')).toBeInTheDocument()
    expect(screen.getAllByText('占有到店顾客 50.00%')).toHaveLength(2)
    expect(screen.getByText('消耗 / 消费 132.50%')).toBeInTheDocument()
  })

  it('单元格：✓ + 金额 / 只打 ✓ / 没到店只显示金额（负数标红）/ 留空；2 月横轴 28 天，周末列浅底', () => {
    render(<CustomerFrequencyView report={report} />)
    const table = screen.getByRole('table')
    const [row] = within(table).getAllByRole('row').filter((tr) => tr.closest('tbody'))
    const cells = within(row).getAllByRole('cell')
    // 4 列顾客信息 + 28 天 + 2 列汇总
    expect(cells).toHaveLength(4 + 28 + 2)
    expect(cells.slice(0, 4).map((td) => td.textContent)).toEqual(['张三', '138****2222', '金卡', '蓝莱店'])
    expect(cells[4]).toHaveTextContent('✓120.00')
    expect(cells[5].textContent?.trim()).toBe('✓')
    expect(cells[6]).not.toHaveTextContent('✓')
    expect(cells[6]).toHaveTextContent('-50.00')
    expect(within(cells[6]).getByText('-50.00')).toHaveClass('text-[var(--destructive)]')
    expect(cells[7].textContent).toBe('')
    expect(cells.slice(-2).map((td) => td.textContent)).toEqual(['2', '70.00'])
    // 2026-02-01 周日
    expect(cells[4].className).toContain('bg-[#FAFAF7]')
    expect(cells[5].className).not.toContain('bg-[#FAFAF7]')

    const totals = table.querySelector('tr[data-totals]') as HTMLElement
    const totalCells = within(totals).getAllByRole('cell')
    expect(totalCells[0]).toHaveTextContent('合计')
    expect(totalCells.slice(-2).map((td) => td.textContent)).toEqual(['2', '70.00'])
  })

  it('悬停显示当日消耗、服务项目、发生门店', async () => {
    render(<CustomerFrequencyView report={report} />)
    const [row] = within(screen.getByRole('table')).getAllByRole('row').filter((tr) => tr.closest('tbody'))
    await userEvent.hover(within(row).getByText('120.00'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('当日消费 ¥120.00；当日消耗 ¥80.00；服务项目：面部；发生门店：蓝莱店')
  })

  it('只看有到店、点表头排序写 URL 并回到第 1 页；回到默认排序时清掉参数', async () => {
    const { unmount } = render(<CustomerFrequencyView report={report} />)
    await userEvent.click(screen.getByRole('button', { name: '只看有到店' }))
    expect(lastUrl()).toBe('/data-center/customer-frequency?scope=store&scopeId=S1&month=2026-02&show=visited')

    await userEvent.click(screen.getByRole('button', { name: /消费合计/ }))
    expect(lastUrl()).toBe('/data-center/customer-frequency?scope=store&scopeId=S1&month=2026-02&sort=amount')
    await userEvent.click(screen.getByRole('button', { name: /到店次数/ }))
    expect(lastUrl()).toBe('/data-center/customer-frequency?scope=store&scopeId=S1&month=2026-02&sort=visitDays&dir=asc')
    unmount()

    // 当前按消费排序时点「到店次数」= 回到默认（到店次数降序）：清掉 sort / dir
    nav.search = 'scope=store&scopeId=S1&month=2026-02&sort=amount'
    render(<CustomerFrequencyView report={{ ...report, sort: { key: 'amount', direction: 'desc' } }} />)
    await userEvent.click(screen.getByRole('button', { name: /到店次数/ }))
    expect(lastUrl()).toBe('/data-center/customer-frequency?scope=store&scopeId=S1&month=2026-02')
  }, 20_000) // 多次交互 + 两次渲染，并发负载下 5s 默认超时会误报

  it('导出 payload 带当前 URL 参数、钉住月份与报表视图名；早于数据起点的月份显示空表文案', async () => {
    // URL 不带 month（菜单进来默认上月）时，导出参数仍钉住页面实际取数的月份
    nav.search = 'scope=store&scopeId=S1'
    const { unmount } = render(<CustomerFrequencyView report={report} />)
    exportJobs.createExportJob.mockResolvedValue({ id: 1, reused: false })
    await userEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(exportJobs.createExportJob).toHaveBeenCalledWith({
      exportType: 'data-center',
      payload: { view: 'report-customer-frequency', params: { scope: 'store', scopeId: 'S1', month: '2026-02' } },
    })
    unmount()

    render(<CustomerFrequencyView report={{ ...report, month: '2026-05', rows: [], total: 0, beforeDataStart: true }} />)
    expect(screen.getByText('所选月份早于系统数据起点（2026-07），暂无数据')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled()
  })
})
