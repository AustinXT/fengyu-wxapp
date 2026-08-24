import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { OnboardingListItem } from '@/actions/lakala-onboarding'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    setMany: vi.fn(),
  }),
}))
vi.mock('../onboarding/_components/onboarding-page', () => ({
  OnboardingList: ({ applications, canCreate, embedded }: {
    applications: OnboardingListItem[]
    canCreate: boolean
    embedded: boolean
  }) => <div data-testid="onboarding-list">{`${applications.length}:${canCreate}:${embedded}`}</div>,
}))

import MerchantsPage from './merchants-page'

const onboardingApplications = [{ id: 'onb-1' }] as OnboardingListItem[]
const filterOptions = { markets: [], stores: [] }

describe('商户管理入网标签', () => {
  it('有 merchant:list 能力时可切换到内嵌入网列表', async () => {
    const user = userEvent.setup()
    render(
      <MerchantsPage
        merchants={[]}
        total={0}
        markets={[]}
        canCreate
        canOnboard
        onboardingApplications={onboardingApplications}
        filterOptions={filterOptions}
      />,
    )

    await user.click(screen.getByRole('tab', { name: '入网申请' }))

    expect(screen.getByTestId('onboarding-list')).toHaveTextContent('1:true:true')
    expect(screen.queryByRole('button', { name: '新建商户' })).not.toBeInTheDocument()
  })

  it('无入网查看能力时不渲染入网标签', () => {
    render(
      <MerchantsPage
        merchants={[]}
        total={0}
        markets={[]}
        canCreate={false}
        canOnboard={false}
        filterOptions={filterOptions}
      />,
    )

    expect(screen.queryByRole('tab', { name: '入网申请' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('onboarding-list')).not.toBeInTheDocument()
  })
})
