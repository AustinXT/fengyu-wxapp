import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { PermissionError } from '@/lib/permissions'
import { DATA_CENTER_REPORT_LIST, DATA_CENTER_REPORTS, type DataCenterReportKey } from '@/lib/data-center/reports'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'

/**
 * 经营明细报表空壳路由（#367）的入口控制流与骨架渲染。
 *
 * 与 `[board]/page.test.tsx` 同一套被守护的风险：非总部账号不得以 'all' 取数（默认 scope 必须补齐且
 * 停在本页）、重复 key 规范化、权限闸门抛 PERMISSION_DENIED（403 而非 500）。额外钉住报表页特有的：
 * 各页用对了 scope 数据源（= 权限闸门）、页内 `tab` 参数不被当遗留参数丢掉、三种筛选形态与重置。
 */

const nav = vi.hoisted(() => ({
  pathname: '/',
  search: '',
  replace: vi.fn(),
}))

const actions = vi.hoisted(() => ({
  getDataCenterScopeOptions: vi.fn(),
  getCustomerDetailScopeOptions: vi.fn(),
  getStaffCommissionScopeOptions: vi.fn(),
  getDataStartDates: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
  unstable_rethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message.startsWith('REDIRECT:')) throw error
  }),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/actions/data-center/shared', () => actions)

/** 员工提成日报 / 明细的取数 action（#375）：本文件只测入口控制流与骨架，取数给空结果 */
const commission = vi.hoisted(() => ({
  getCommissionDaily: vi.fn(),
  getCommissionDetail: vi.fn(),
}))
vi.mock('@/actions/data-center/commission', () => commission)

function emptyCommissionDaily(month: string) {
  const cell = { sale: 0, service: 0, orders: 0 }
  return {
    month,
    scopeName: '全部',
    isAllScope: true,
    options: { view: 'total', group: 'employee', merge: false, search: '', hideZero: false },
    grain: 'employee-store',
    sort: { key: 'total', direction: 'desc' },
    rows: [],
    totals: { days: {}, total: cell, employeeCount: 0, rowCount: 0 },
    kpis: {
      total: 0, sale: 0, service: 0, saleShare: null, serviceShare: null, earningEmployees: 0, employees: 0,
      technicianCount: 0, perTechnician: null, orders: 0, perOrder: null,
    },
    pending: { count: 0, amount: 0 },
    canLinkAllocations: false,
  }
}

function emptyCommissionDetail(month: string) {
  return {
    month,
    scopeName: '全部',
    filters: { employeeId: null, storeId: null, date: null, source: null },
    pageSize: 50,
    rows: [],
    summary: { count: 0, orders: 0, received: 0, allocated: 0, commission: 0, sale: 0, service: 0, averageRate: null },
    prevCursor: null,
    nextCursor: null,
    employeeOptions: [],
    canLinkOrders: false,
    customerMasked: true,
  }
}

import DailyOverviewPage from '../../daily-overview/page'
import CustomerFrequencyPage from '../../customer-frequency/page'
import RemainingCardsPage from '../../remaining-cards/page'
import OperatingMasterPage from '../../operating-master/page'
import CommissionDailyPage from '../../commission-daily/page'
import CommissionDetailPage from '../../commission-daily/detail/page'

type Query = Record<string, string | string[] | undefined>
type PageComponent = (props: { searchParams: Promise<Query> }) => Promise<ReactElement>

const PAGE_COMPONENTS: Record<DataCenterReportKey, { page: PageComponent; needsStarts: boolean }> = {
  dailyOverview: { page: DailyOverviewPage, needsStarts: true },
  customerFrequency: { page: CustomerFrequencyPage, needsStarts: true },
  remainingCards: { page: RemainingCardsPage, needsStarts: false },
  operatingMaster: { page: OperatingMasterPage, needsStarts: true },
  commissionDaily: { page: CommissionDailyPage, needsStarts: true },
  commissionDetail: { page: CommissionDetailPage, needsStarts: true },
}

/**
 * 该页必须使用的 scope 数据源（= SSR 闸门），由登记表的 requiredActions **推导**而不是手抄：
 * 把顾客明细页错配成 dashboard 数据源（任何 dashboard 角色都能看顾客明细）时这里会红。
 */
function expectedLoader(key: DataCenterReportKey): 'getDataCenterScopeOptions' | 'getCustomerDetailScopeOptions' | 'getStaffCommissionScopeOptions' {
  const required: readonly string[] = DATA_CENTER_REPORTS[key].requiredActions
  if (required.includes('data_center:customer_detail')) return 'getCustomerDetailScopeOptions'
  if (required.includes('data_center:staff_commission')) return 'getStaffCommissionScopeOptions'
  return 'getDataCenterScopeOptions'
}

const PAGES = Object.fromEntries(
  (Object.keys(PAGE_COMPONENTS) as DataCenterReportKey[]).map((key) => [key, { ...PAGE_COMPONENTS[key], loader: expectedLoader(key) }]),
) as Record<DataCenterReportKey, { page: PageComponent; needsStarts: boolean; loader: ReturnType<typeof expectedLoader> }>

const hqOptions: DataCenterScopeOptions = {
  topLevel: 'all', inactiveStores: [],
  markets: [
    { id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }] },
    { id: 'M2', name: '南昌易大师', stores: [{ storeId: 'S3', storeName: '易大师一店' }] },
  ],
}
const singleStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}
const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'market', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }] }],
}
const noStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌凤御', stores: [] }],
}

/** 绿湖店 08-08 才上线、易大师 08-23：默认上月（2026-08）两家都早于起点 */
const starts = {
  S1: { performance: '2026-07-08', service: '2026-07-08' },
  S2: { performance: '2026-08-08', service: '2026-08-01' },
  S3: { performance: '2026-08-23', service: '2026-08-23' },
}

function mockScope(options: DataCenterScopeOptions) {
  actions.getDataCenterScopeOptions.mockResolvedValue(options)
  actions.getCustomerDetailScopeOptions.mockResolvedValue(options)
  actions.getStaffCommissionScopeOptions.mockResolvedValue(options)
}

function call(key: DataCenterReportKey, query: Query = {}) {
  return PAGES[key].page({ searchParams: Promise.resolve(query) })
}

async function renderPage(key: DataCenterReportKey, query: Record<string, string> = {}) {
  nav.pathname = DATA_CENTER_REPORTS[key].path
  nav.search = new URLSearchParams(query).toString()
  return render(await call(key, query))
}

const KEYS = DATA_CENTER_REPORT_LIST.map((report) => report.key)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-25T10:00:00+08:00'))
  actions.getDataStartDates.mockResolvedValue(starts)
  commission.getCommissionDaily.mockImplementation(async (query: Query) => emptyCommissionDaily(String(query.month ?? '2026-08')))
  commission.getCommissionDetail.mockImplementation(async (query: Query) => emptyCommissionDetail(String(query.month ?? '2026-08')))
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(KEYS)('报表页 %s · 入口控制流', (key) => {
  const { path } = DATA_CENTER_REPORTS[key]

  it('单店账号补 scope 时停在本页，不以 all 取数', async () => {
    mockScope(singleStoreOptions)
    await expect(call(key)).rejects.toThrow(`REDIRECT:${path}?scope=store&scopeId=S1`)
  })

  it('多店账号落到授权汇总', async () => {
    mockScope(multiStoreOptions)
    await expect(call(key)).rejects.toThrow(`REDIRECT:${path}?scope=authorized`)
  })

  it('补 scope 时保留页内参数（含 tab 视角参数，不当遗留参数丢掉）', async () => {
    mockScope(singleStoreOptions)
    await expect(call(key, { tab: 'category', month: '2026-08', q: '张' })).rejects.toThrow(
      `REDIRECT:${path}?tab=category&month=2026-08&q=%E5%BC%A0&scope=store&scopeId=S1`,
    )
  })

  it('重复 query key 规范化成单值', async () => {
    mockScope(hqOptions)
    await expect(call(key, { scope: ['market', 'all'], scopeId: 'M1' })).rejects.toThrow(
      `REDIRECT:${path}?scope=market&scopeId=M1`,
    )
  })

  it('用该页对应的 scope 数据源（= SSR 权限闸门），其余数据源不调用', async () => {
    mockScope(hqOptions)
    await expect(call(key)).resolves.toBeTruthy()
    for (const loader of ['getDataCenterScopeOptions', 'getCustomerDetailScopeOptions', 'getStaffCommissionScopeOptions'] as const) {
      expect(actions[loader], loader).toHaveBeenCalledTimes(loader === PAGES[key].loader ? 1 : 0)
    }
    expect(actions.getDataStartDates).toHaveBeenCalledTimes(PAGES[key].needsStarts ? 1 : 0)
  })

  it('闸门抛 PERMISSION_DENIED 时原样上抛（error.tsx 渲染 403，不是 500）', async () => {
    actions[PAGES[key].loader].mockRejectedValue(new PermissionError('PERMISSION_DENIED: 无权执行 data_center:customer_detail'))
    await expect(call(key)).rejects.toMatchObject({ digest: 'PERMISSION_DENIED' })
  })
})

describe('报表页 · 骨架渲染', () => {
  it('区间型（一览表）：默认上月，信息条写明范围与期间，数据起点提示列出上线晚于期间起点的门店', async () => {
    mockScope(hqOptions)
    await renderPage('dailyOverview')

    expect(screen.getByRole('heading', { level: 1, name: '日常数据一览表' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上月', pressed: true })).toBeInTheDocument()
    for (const label of ['本月', '近 30 天', '自定义']) {
      expect(screen.getByRole('button', { name: label, pressed: false })).toBeInTheDocument()
    }
    // 旧板块的预设不出现
    expect(screen.queryByRole('button', { name: '今年' })).not.toBeInTheDocument()
    expect(screen.getByTestId('scope-store-count')).toHaveTextContent('共 3 家门店')
    expect(screen.getByTestId('report-info-bar')).toHaveTextContent('范围全部（3 家门店）')
    expect(screen.getByTestId('report-info-bar')).toHaveTextContent('期间上月（2026年8月） 2026-08-01 ~ 2026-08-31')

    const notice = screen.getByRole('note', { name: '数据起点提示' })
    expect(notice).toHaveTextContent('所选期间（2026-08-01 ~ 2026-08-31）早于部分门店的数据起点')
    expect(notice).toHaveTextContent('业绩 · 南昌凤御 1 家（2026-08-08 起）')
    expect(notice).toHaveTextContent('业绩 · 南昌易大师 1 家（2026-08-23 起）')
    expect(notice).toHaveTextContent('较上期基期（2026-07-01 ~ 2026-07-31）同样早于数据起点（涉及 3 家门店）')
  })

  it('单月型（频率表）：月份下拉最早 2026-07，默认上月', async () => {
    mockScope(hqOptions)
    await renderPage('customerFrequency')

    const select = screen.getByRole('combobox', { name: '月份' })
    expect(select).toHaveValue('2026-08')
    expect(within(select).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['2026-09', '2026-08', '2026-07'])
  })

  it('单月型：URL 手传早于 2026-07 的月份照常显示（空态 + 数据起点提示），不报错', async () => {
    mockScope(hqOptions)
    await renderPage('commissionDaily', { month: '2026-05' })

    expect(screen.getByRole('combobox', { name: '月份' })).toHaveValue('2026-05')
    expect(screen.getByRole('note', { name: '数据起点提示' })).toHaveTextContent('所选月份（2026-05-01 ~ 2026-05-31）')
    // 手传的早月照常取数（action 自己按同一月份解析），表格显示空态而不是报错
    expect(commission.getCommissionDaily).toHaveBeenCalledWith(expect.objectContaining({ month: '2026-05' }))
    expect(screen.getByText('本月暂无提成数据')).toBeInTheDocument()
  })

  it('仅范围型（剩余卡项）：不显示日期、不查数据起点，重置按钮在范围行', async () => {
    mockScope(hqOptions)
    await renderPage('remainingCards')

    expect(screen.queryByRole('combobox', { name: '月份' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '上月' })).not.toBeInTheDocument()
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重置' })).toBeInTheDocument()
    expect(screen.getByTestId('report-info-bar')).not.toHaveTextContent('期间')
  })

  it('单店账号的完整区间不出提示（只看本店起点）', async () => {
    mockScope(singleStoreOptions)
    await renderPage('operatingMaster', { scope: 'store', scopeId: 'S1' })

    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
    expect(screen.getByTestId('scope-store-count')).toHaveTextContent('共 1 家门店')
  })

  it('数据起点取数失败只降级为不提示，页面照常渲染', async () => {
    mockScope(hqOptions)
    actions.getDataStartDates.mockRejectedValue(new Error('connection reset'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderPage('dailyOverview')

    expect(screen.getByRole('heading', { level: 1, name: '日常数据一览表' })).toBeInTheDocument()
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('数据起点取数触发登录跳转（会话过期）时照常上抛，不被降级吞掉', async () => {
    mockScope(hqOptions)
    actions.getDataStartDates.mockRejectedValue(new Error('REDIRECT:/login?expired=1'))
    await expect(call('dailyOverview')).rejects.toThrow('REDIRECT:/login?expired=1')
  })

  it.each(['commissionDaily', 'commissionDetail'] as const)('%s：非总部且无可查看门店时不取数（scope 为 null）', async (key) => {
    mockScope(noStoreOptions)
    await renderPage(key)

    expect(screen.getByText('当前账号暂无可查看的数据范围')).toBeInTheDocument()
    expect(commission.getCommissionDaily).not.toHaveBeenCalled()
    expect(commission.getCommissionDetail).not.toHaveBeenCalled()
  })

  it('非总部且无可查看门店：渲染空态，不出提示', async () => {
    mockScope(noStoreOptions)
    await renderPage('dailyOverview')

    expect(screen.getByText('当前账号暂无可查看的数据范围')).toBeInTheDocument()
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
  })

  it.each(KEYS)('%s：选中已停用门店渲染「已停用」空态，不跳回默认范围、不出提示（#293）', async (key) => {
    mockScope({ ...multiStoreOptions, inactiveStores: [{ storeId: 'X1', storeName: '自贡旭阳店', marketId: 'M1' }] })
    await renderPage(key, { scope: 'store', scopeId: 'X1' })

    expect(screen.getByTestId('scope-empty-state')).toHaveTextContent('「自贡旭阳店」已停用，无可展示数据')
    expect(screen.queryByText('报表建设中，暂无数据')).not.toBeInTheDocument()
    expect(screen.queryByTestId('report-info-bar')).not.toBeInTheDocument()
    expect(screen.queryByRole('note', { name: '数据起点提示' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: '自贡旭阳店（已停用）' })).toBeDisabled()
    expect(screen.queryByTestId('scope-store-count')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到默认范围' }))
      .toHaveAttribute('href', `${DATA_CENTER_REPORTS[key].path}?scope=authorized`)
  })

  it('重置：回到权限默认范围 + 默认期间，清掉其余参数', async () => {
    mockScope(multiStoreOptions)
    await renderPage('customerFrequency', { scope: 'store', scopeId: 'S2', month: '2026-07', q: '张' })

    await userEvent.setup().click(screen.getByRole('button', { name: '重置' }))
    expect(nav.replace).toHaveBeenCalledWith('/data-center/customer-frequency?scope=authorized', { scroll: false })
  })

  it('重置（总部账号）：回到不带参数的页面', async () => {
    mockScope(hqOptions)
    await renderPage('dailyOverview', { scope: 'market', scopeId: 'M1', period: 'last30' })

    await userEvent.setup().click(screen.getByRole('button', { name: '重置' }))
    expect(nav.replace).toHaveBeenCalledWith('/data-center/daily-overview', { scroll: false })
  })

  it('同一次服务端往返内先改月份、再改范围：两次改动都保留（整张卡片共用一个 URL 筛选实例）', async () => {
    mockScope(hqOptions)
    await renderPage('customerFrequency')
    const user = userEvent.setup()

    await user.selectOptions(screen.getByRole('combobox', { name: '月份' }), '2026-07')
    // nav.search 未变 = 服务端还没回来；第二次写入必须基于第一次写入后的参数
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'M2')
    expect(nav.replace).toHaveBeenLastCalledWith(
      '/data-center/customer-frequency?month=2026-07&scope=market&scopeId=M2',
      { scroll: false },
    )
  })

  it('重置后紧接着改范围，不把重置前的参数带回来', async () => {
    mockScope(hqOptions)
    await renderPage('customerFrequency', { month: '2026-07', q: '张' })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '重置' }))
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'M1')
    expect(nav.replace).toHaveBeenLastCalledWith(
      '/data-center/customer-frequency?scope=market&scopeId=M1',
      { scroll: false },
    )
  })

  it('区间型：切到自定义时用当前生效区间预填，近 30 天存相对预设', async () => {
    mockScope(hqOptions)
    await renderPage('dailyOverview')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '自定义' }))
    expect(nav.replace).toHaveBeenLastCalledWith(
      '/data-center/daily-overview?period=custom&start=2026-08-01&end=2026-08-31',
      { scroll: false },
    )
    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    expect(nav.replace).toHaveBeenLastCalledWith('/data-center/daily-overview?period=last30', { scroll: false })
  })
})
