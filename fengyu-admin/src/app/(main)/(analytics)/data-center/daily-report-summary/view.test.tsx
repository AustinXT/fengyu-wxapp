import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DailyReportSummaryRow } from '@/lib/data-center/daily-report-summary'

const nav = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => '/data-center/daily-report-summary',
  useSearchParams: () => new URLSearchParams('scope=store&scopeId=s1'),
}))

import { DailyReportSummaryView } from './view'

const report: DailyReportSummaryRow = {
  id: 'r1', reportDate: '2026-10-06', employeeId: 'e1', employeeName: '张三',
  positionName: '美容师', storeId: 's1', storeName: '示例门店', marketId: null, marketName: null,
  submittedAt: '2026-10-06T10:00:00.000Z', action: '跟进顾客', growth: '学习手法', plan: '明日复盘',
  mentorEmployeeId: 'e2', peerEmployeeId: 'e3',
  metrics: { date: '2026-10-06', day: { sales: 12500, consumption: 8000, visits: 4, newCustomers: 1, projects: 3 }, week: null, month: null, periodName: null, weekName: null, savedAt: null },
  entries: [{ businessType: 'sale', businessId: 'sale-1', snapshot: { title: '面部护理' }, feedback: '顾客满意', followUp: '三天后联系' }],
}

beforeEach(() => vi.clearAllMocks())

describe('DailyReportSummaryView', () => {
  it('空结果提示无已提交日报并禁用导出', () => {
    render(<DailyReportSummaryView date="2026-10-06" today="2026-10-06" employeeSearch="" reports={[]} />)
    expect(screen.getByText('所选日期和范围内没有已提交日报。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
  })

  it('展示日报总数，展开后可读指标、行动计划和业务反馈跟进', async () => {
    render(<DailyReportSummaryView date="2026-10-06" today="2026-10-06" employeeSearch="" reports={[report]} />)
    expect(screen.getByText('1 份日报 · 1 条业务')).toBeInTheDocument()
    await userEvent.click(screen.getByText('张三'))
    expect(screen.getByText('跟进顾客')).toBeInTheDocument()
    expect(screen.getByText('学习手法')).toBeInTheDocument()
    expect(screen.getByText('明日复盘')).toBeInTheDocument()
    expect(screen.getByText('顾客满意')).toBeInTheDocument()
    expect(screen.getByText('三天后联系')).toBeInTheDocument()
    expect(screen.getByText('¥125.00')).toBeInTheDocument()
  })
})
