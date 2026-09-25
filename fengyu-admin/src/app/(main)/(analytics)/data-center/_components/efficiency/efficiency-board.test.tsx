import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EfficiencyBoardResult } from '@/lib/data-center/types'
import { getDataCenterRankingConfig } from '@/lib/data-center/columns'
import { STAFF_OUTPUT_SCOPE_NOTE } from '@/lib/data-center/staff-output-note'

/**
 * 人效板员工维度口径说明（#299）：「员工排名榜」全部指标 Tab 与「按技师人效」有全域产出说明，
 * 「门店排名榜」「按市场人效」没有。两端逐字一致另由 staffApi cross-end-staff-output-note.test.js 守护。
 */

const board = vi.hoisted(() => ({ getEfficiencyBoard: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/data-center/efficiency',
  useSearchParams: () => new URLSearchParams('scope=authorized'),
}))
vi.mock('@/actions/data-center/efficiency', () => board)
vi.mock('@/actions/export-jobs', () => ({ createExportJob: vi.fn() }))

import { EfficiencyBoard } from './efficiency-board'

const data = {
  kpis: {},
  timeRange: { presetLabel: '本月' },
  noStoreScope: false,
  noStoreMarkets: [],
  byMarket: [],
  byStaff: [],
  storeRankings: {},
  staffRankings: {},
} as unknown as EfficiencyBoardResult

beforeEach(() => {
  vi.clearAllMocks()
  board.getEfficiencyBoard.mockResolvedValue(data)
})

async function openTab(name: string) {
  render(<EfficiencyBoard />)
  await screen.findByRole('tab', { name })
  await userEvent.click(screen.getByRole('tab', { name }))
}

describe('EfficiencyBoard 员工维度口径说明（#299）', () => {
  it('文案定稿', () => {
    expect(STAFF_OUTPUT_SCOPE_NOTE).toBe('数值为员工个人全域产出')
  })

  it('员工排名榜：每个指标 Tab 都显示说明', async () => {
    await openTab('员工排名榜')
    const metrics = getDataCenterRankingConfig('efficiency-staff-ranking').metrics
    expect(metrics.length).toBe(5)
    for (const m of metrics) {
      await userEvent.click(screen.getByRole('tab', { name: m.label }))
      expect(screen.getByRole('tab', { name: m.label })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('ranking-board-note')).toHaveTextContent(STAFF_OUTPUT_SCOPE_NOTE)
    }
    expect(screen.getAllByText(STAFF_OUTPUT_SCOPE_NOTE)).toHaveLength(1)
  })

  it('门店排名榜：不显示说明', async () => {
    await openTab('门店排名榜')
    expect(screen.getByText('门店排名榜', { selector: 'h3' })).toBeInTheDocument()
    expect(screen.queryByTestId('ranking-board-note')).toBeNull()
    expect(screen.queryByText(STAFF_OUTPUT_SCOPE_NOTE)).toBeNull()
  })

  it('按技师人效：显示同一句说明', async () => {
    await openTab('按技师人效')
    const note = screen.getByTestId('efficiency-staff-output-note')
    expect(note).toHaveTextContent(STAFF_OUTPUT_SCOPE_NOTE)
    expect(within(note.parentElement as HTMLElement).getAllByText(STAFF_OUTPUT_SCOPE_NOTE)).toHaveLength(1)
  })

  it('按市场人效（默认 Tab）：不显示说明', async () => {
    render(<EfficiencyBoard />)
    await screen.findByRole('tab', { name: '按市场人效' })
    expect(screen.queryByText(STAFF_OUTPUT_SCOPE_NOTE)).toBeNull()
  })
})
