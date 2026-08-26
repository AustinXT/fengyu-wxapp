import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSetMany, mockCreateExportJob, params } = vi.hoisted(() => ({
  mockSetMany: vi.fn(),
  mockCreateExportJob: vi.fn(),
  params: new URLSearchParams('status=已支付&q=冯桂仙'),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/refunds',
  useSearchParams: () => params,
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (key: string, defaultValue = '') => params.get(key) ?? defaultValue,
    setMany: mockSetMany,
  }),
}))

vi.mock('@/actions/export-jobs', () => ({
  createExportJob: mockCreateExportJob,
}))

import RefundsPage from './refunds-page'

describe('RefundsPage — 搜索、状态筛选与导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateExportJob.mockResolvedValue({ id: 1, reused: false })
  })

  it('状态和搜索变更重置页码', () => {
    vi.useFakeTimers()
    render(<RefundsPage refunds={[]} total={0} page={1} pageSize={20} />)

    fireEvent.change(screen.getByRole('combobox', { name: '退款状态' }), {
      target: { value: '已关闭' },
    })
    fireEvent.change(screen.getByPlaceholderText(/搜索退款单号/), {
      target: { value: '211783' },
    })
    vi.advanceTimersByTime(300)

    expect(mockSetMany).toHaveBeenCalledWith({ status: '已关闭', page: '' })
    expect(mockSetMany).toHaveBeenCalledWith({ q: '211783', page: '' })
    vi.useRealTimers()
  })

  it('按当前 URL 筛选条件创建退款导出任务', async () => {
    const user = userEvent.setup()
    render(<RefundsPage refunds={[]} total={0} page={1} pageSize={20} />)

    await user.click(screen.getByRole('button', { name: '导出' }))

    await waitFor(() => expect(mockCreateExportJob).toHaveBeenCalledWith({
      exportType: 'refunds',
      payload: { status: '已支付', q: '冯桂仙' },
    }))
  })
})
