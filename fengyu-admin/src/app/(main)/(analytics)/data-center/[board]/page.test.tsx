import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'

/**
 * 守护数据中心板块页的入口控制流（#212）。
 *
 * 这里盯的是本次改造**最高风险**的一段：非总部账号无有效 scope 时的默认 scope redirect。
 * 它删掉、跳成裸路径、或把目标硬编码成 sales，dc-scope-smoke（直调 Server Action，不走路由）
 * 与 navigation.spec（用总部 admin 账号，压根不触发 redirect）都照样全绿——所以必须在这一层断言。
 * 背景见 memory `project-data-center-default-scope-non-hq`：scope='all' 抵达板块会抛
 * PERMISSION_DENIED，生产脱敏后表现为板块内联红字「数据加载失败」。
 */

const { getDataCenterScopeOptions, redirect, notFound } = vi.hoisted(() => ({
  getDataCenterScopeOptions: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ redirect, notFound }))
vi.mock('@/actions/data-center/shared', () => ({ getDataCenterScopeOptions }))
vi.mock('../_components/scope-time-filter', () => ({ ScopeTimeFilter: () => null }))
vi.mock('../_components/sales/sales-board', () => ({ SalesBoard: () => null }))
vi.mock('../_components/customer/customer-board', () => ({ CustomerBoard: () => null }))
vi.mock('../_components/efficiency/efficiency-board', () => ({ EfficiencyBoard: () => null }))
vi.mock('../_components/product/product-board', () => ({ ProductBoard: () => null }))

import Page from './page'

/** 总部账号：topLevel 'all'，不需要补 scope。 */
const hqOptions: DataCenterScopeOptions = {
  topLevel: 'all',
  markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}

/** 单店账号（店长）：只有一家可见门店 → 默认落到该店。 */
const singleStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store',
  markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}

/** 多店账号（市场财务）：多家可见门店 → 默认落到授权汇总。 */
const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'market',
  markets: [
    {
      id: 'M1',
      name: '南昌市场',
      stores: [
        { storeId: 'S1', storeName: '蓝莱店' },
        { storeId: 'S2', storeName: '绿湖店' },
      ],
    },
  ],
}

/** 非总部但一家可见门店都没有 → resolveDefaultDataCenterScope 返回 null。 */
const noStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store',
  markets: [{ id: 'M1', name: '南昌市场', stores: [] }],
}

function call(board: string, query: Record<string, string | string[] | undefined> = {}) {
  return Page({ params: Promise.resolve({ board }), searchParams: Promise.resolve(query) })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('数据中心板块页 · 非总部默认 scope 解析', () => {
  it('单店账号补 scope 时【停在当前板块】，不退回裸路径、不回落销售', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('customer')).rejects.toThrow('REDIRECT:/data-center/customer?scope=store&scopeId=S1')

    const target = redirect.mock.calls[0][0] as string
    expect(target.startsWith('/data-center/customer?'), '补 scope 后被弹回别的板块').toBe(true)
  })

  it('多店账号落到 authorized 授权汇总，同样停在当前板块', async () => {
    getDataCenterScopeOptions.mockResolvedValue(multiStoreOptions)

    await expect(call('efficiency')).rejects.toThrow('REDIRECT:/data-center/efficiency?scope=authorized')
  })

  it('补 scope 时保留其余 query（时间维度/同比环比不被吞掉）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('product', { preset: 'year', cmp: '0' })).rejects.toThrow(/REDIRECT:/)

    const target = redirect.mock.calls[0][0] as string
    expect(target).toContain('preset=year')
    expect(target).toContain('cmp=0')
    expect(target).toContain('scope=store')
  })

  it('URL 已带合法 scope 时不再 redirect（避免二次跳转/循环）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('sales', { scope: 'store', scopeId: 'S1' })).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('总部账号不补 scope', async () => {
    getDataCenterScopeOptions.mockResolvedValue(hqOptions)

    await expect(call('sales')).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('非总部且无可见门店时不 redirect，交给页面渲染空态', async () => {
    getDataCenterScopeOptions.mockResolvedValue(noStoreOptions)

    await expect(call('customer')).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('重复 query key 取首值，不会把 "store,market" 这种脏值写进 URL', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('sales', { preset: ['year', 'month'] })).rejects.toThrow(/REDIRECT:/)

    const target = redirect.mock.calls[0][0] as string
    expect(target).toContain('preset=year')
    expect(target).not.toContain('month')
  })
})

describe('数据中心板块页 · 动态段收口', () => {
  it('非法板块段走 notFound，且不查库（权限闸门之前就拦下）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(hqOptions)

    await expect(call('zzz')).rejects.toThrow('NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
    expect(getDataCenterScopeOptions).not.toHaveBeenCalled()
  })

  it('大小写不做容错', async () => {
    await expect(call('Sales')).rejects.toThrow('NOT_FOUND')
  })

  it('四个合法板块都能渲染', async () => {
    getDataCenterScopeOptions.mockResolvedValue(hqOptions)

    for (const board of ['sales', 'customer', 'efficiency', 'product']) {
      await expect(call(board), `板块 ${board} 渲染失败`).resolves.toBeTruthy()
    }
    expect(notFound).not.toHaveBeenCalled()
  })
})
