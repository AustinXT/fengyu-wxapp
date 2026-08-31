import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSetMany = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    set: vi.fn(),
    setMany: mockSetMany,
  }),
}))

vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <input aria-label={ariaLabel} />
  ),
}))

vi.mock('@/components/ui/export-button', () => ({
  ExportButton: () => <button type="button">导出</button>,
}))

vi.mock('@/components/return-context', () => ({
  PreserveListContextLink: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

import AllocationsPageClient from './allocations-page'

const commonProps = {
  filterOptions: { markets: [], stores: [] },
  canSave: false,
  canViewOrders: false,
  canViewServices: false,
}

describe('AllocationsPageClient — 日期口径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('销售提成可切换到款项发生日期并重置分页', async () => {
    const user = userEvent.setup()
    render(<AllocationsPageClient {...commonProps} tab="sale" />)

    await user.selectOptions(screen.getByRole('combobox', { name: '日期口径' }), 'payment')

    expect(mockSetMany).toHaveBeenCalledWith({ dateBasis: 'payment', page: '' })
  })

  it('服务提成不显示款项日期口径并保留服务日期标签', () => {
    render(<AllocationsPageClient {...commonProps} tab="service" />)

    expect(screen.queryByRole('combobox', { name: '日期口径' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('服务开始日期')).toBeInTheDocument()
    expect(screen.getByLabelText('服务结束日期')).toBeInTheDocument()
  })
})
