import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { Customer, Store } from '@/lib/types'
import type { MarketStoreFilterOptions } from '@/lib/market-store-filter-types'

const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = '') => defaultValue,
    set: vi.fn(),
    setMany: vi.fn(),
    searchParams: new URLSearchParams(),
  }),
}))

const mockCreateCustomer = vi.fn()
vi.mock('@/actions/customers', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
}))

vi.mock('@/actions/export-jobs', () => ({ createExportJob: vi.fn() }))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

import CustomersPage from './customers-page'

const stores: Store[] = [
  {
    storeId: 'store-1',
    storeName: '南昌旗舰店',
    orgNodeId: 'node-store-1',
    openingDate: null,
    bedCount: null,
    isClosed: false,
    closedAt: null,
    coverImage: null,
    images: null,
    district: null,
    streetAddress: null,
    latitude: null,
    longitude: null,
    phone: null,
    businessHours: null,
    description: null,
    announcement: null,
    parkingInfo: null,
    lakalaMerchantId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    marketName: '南昌市场',
  },
]

const filterOptions: MarketStoreFilterOptions = {
  markets: [{ marketId: 'market-1', marketName: '南昌市场' }],
  stores: [
    {
      storeId: 'store-1',
      storeName: '南昌旗舰店',
      marketId: 'market-1',
      marketName: '南昌市场',
    },
  ],
}
const customers: Customer[] = []

function renderPage() {
  render(
    <CustomersPage
      customers={customers}
      stores={stores}
      filterOptions={filterOptions}
      total={0}
      canCreate
    />,
  )
}

describe('CustomersPage — 新增顾客绑定门店', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateCustomer.mockResolvedValue({ success: true, message: '顾客创建成功', userId: 'FYGK-test' })
  })

  it('选择门店后创建顾客时提交 boundStoreId', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: '新增顾客' }))

    expect(screen.getByText('绑定门店')).toBeInTheDocument()
    const storeSelect = screen.getByDisplayValue('暂不绑定门店')
    await user.selectOptions(storeSelect, 'store-1')
    await user.type(screen.getByPlaceholderText('请输入手机号'), '13812345678')
    await user.type(screen.getByPlaceholderText('请输入姓名'), '张三')
    await user.click(screen.getByRole('button', { name: '确认创建' }))

    await waitFor(() => {
      expect(mockCreateCustomer).toHaveBeenCalledWith({
        phone: '13812345678',
        name: '张三',
        boundStoreId: 'store-1',
      })
    })
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('不选择门店时创建顾客提交 boundStoreId=null', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: '新增顾客' }))
    await user.type(screen.getByPlaceholderText('请输入手机号'), '13812345679')
    await user.type(screen.getByPlaceholderText('请输入姓名'), '李四')
    await user.click(screen.getByRole('button', { name: '确认创建' }))

    await waitFor(() => {
      expect(mockCreateCustomer).toHaveBeenCalledWith({
        phone: '13812345679',
        name: '李四',
        boundStoreId: null,
      })
    })
  })
})
