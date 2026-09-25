import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'
import { DATA_CENTER_REPORT_LIST } from '@/lib/data-center/reports'

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
vi.mock('../_components/sales/sales-board', () => ({ SalesBoard: () => <div data-testid="board" /> }))
vi.mock('../_components/customer/customer-board', () => ({ CustomerBoard: () => null }))
vi.mock('../_components/efficiency/efficiency-board', () => ({ EfficiencyBoard: () => null }))
vi.mock('../_components/product/product-board', () => ({ ProductBoard: () => null }))

import Page from './page'

/** 总部账号：topLevel 'all'，不需要补 scope。 */
const hqOptions: DataCenterScopeOptions = {
  topLevel: 'all', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}

/** 单店账号（店长）：只有一家可见门店 → 默认落到该店。 */
const singleStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}

/** 多店账号（市场财务）：多家可见门店 → 默认落到授权汇总。 */
const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'market', inactiveStores: [],
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
  topLevel: 'store', inactiveStores: [],
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

  it('剔除遗留的 tab 参数，不让它永久滞留在板块 URL 上', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('sales', { tab: 'customer', preset: 'year' })).rejects.toThrow(/REDIRECT:/)

    const target = redirect.mock.calls[0][0] as string
    expect(target).not.toContain('tab=')
    expect(target).toContain('preset=year')
  })

  it('默认 scope 不可用时降级成空态，不进入无限重定向', async () => {
    // 契约被破坏的假想场景：非总部却拿到空 storeId。
    // 若不收口，redirect 后 parseScope 认不出空 scopeId → 回落 'all' → 再次 redirect → 浏览器转死。
    getDataCenterScopeOptions.mockResolvedValue({
      topLevel: 'store', inactiveStores: [],
      markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: '', storeName: '坏数据店' }] }],
    } satisfies DataCenterScopeOptions)

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

describe('数据中心板块页 · 重复 query key 规范化', () => {
  // 服务端按首值判定 scope，板块组件（client）用 Object.fromEntries 按末值取数。
  // 不规范化的话 ?scope=store&scope=all 会让服务端放行、客户端被 validateScope 拒成「数据加载失败」——
  // 正是这条 invariant 最怕的症状，且走的是「不触发默认 scope redirect」那条分支，
  // 只重复 preset 的用例抓不到它。
  it('scope 重复且首值合法时仍规范化成单值 URL（服务端/客户端不能看到不同 scope）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('customer', { scope: ['store', 'all'], scopeId: 'S1' })).rejects.toThrow(/REDIRECT:/)

    const target = redirect.mock.calls[0][0] as string
    expect(target).toBe('/data-center/customer?scope=store&scopeId=S1')
  })

  it('规范化后不再二次跳转（终止性）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(singleStoreOptions)

    await expect(call('customer', { scope: 'store', scopeId: 'S1' })).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('无重复 key 时不做多余跳转', async () => {
    getDataCenterScopeOptions.mockResolvedValue(hqOptions)

    await expect(call('sales', { preset: 'year' })).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
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

  // 2026-09-21 实测：给 data-center 段加 loading.tsx 后，/data-center/<非法段> 的 404 页
  // 整棵 React 树的客户端导航全部失效——点侧边栏、点面包屑逃生链接都毫无反应，只能手动刷新。
  // （硬导航正常，确认是 Suspense 边界与同段 notFound() 的组合问题；放到 [board]/ 下同样复现，
  //  而 /orders/<不存在 id> 的 404 页软导航正常，可见是本段特有。）
  // 骨架屏的收益远不及「404 页点什么都没反应」的代价，故不设 loading 边界。
  //
  // #367 起 data-center 下多了经营明细报表的静态段（含 commission-daily/detail 两层），
  // 守护改为递归扫描整个 data-center 目录，并显式核对登记表里的每个报表段都在扫描范围内。
  it('data-center 段下（含全部子段）不得存在 loading.tsx', () => {
    const dir = path.resolve(__dirname, '..')
    const offenders: string[] = []
    const scanned = new Set<string>()
    const walk = (current: string) => {
      scanned.add(current)
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name)
        if (entry.isDirectory()) walk(target)
        else if (/^loading\.(tsx|ts|jsx|js)$/.test(entry.name)) offenders.push(target)
      }
    }
    walk(dir)
    // 祖先段（(analytics) / (main)）的 loading 同样会在 data-center 段外包一层 Suspense 边界
    for (const ancestor of [path.resolve(dir, '..'), path.resolve(dir, '..', '..')]) {
      for (const name of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) {
        if (existsSync(path.join(ancestor, name))) offenders.push(path.join(ancestor, name))
      }
    }
    expect(offenders, '这些 loading 文件会让同段 404 页客户端导航失效').toEqual([])

    for (const report of DATA_CENTER_REPORT_LIST) {
      const segment = path.join(dir, ...report.path.replace(/^\/data-center\//, '').split('/'))
      expect(existsSync(path.join(segment, 'page.tsx')), `${report.path} 缺 page.tsx`).toBe(true)
      expect(scanned.has(segment), `${report.path} 不在扫描范围`).toBe(true)
    }
  })

  it('四个合法板块都能渲染', async () => {
    getDataCenterScopeOptions.mockResolvedValue(hqOptions)

    for (const board of ['sales', 'customer', 'efficiency', 'product']) {
      await expect(call(board), `板块 ${board} 渲染失败`).resolves.toBeTruthy()
    }
    expect(notFound).not.toHaveBeenCalled()
  })
})

describe('数据中心板块页 · 已停用门店空态（#293）', () => {
  const withInactive: DataCenterScopeOptions = {
    ...hqOptions,
    inactiveStores: [{ storeId: 'X1', storeName: '南昌龙大店', marketId: 'M1' }],
  }

  it('选中已停用门店：渲染「已停用」空态，不挂板块（不取数、满屏 0 不会出现）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(withInactive)
    render(await call('sales', { scope: 'store', scopeId: 'X1' }))

    expect(screen.getByTestId('scope-empty-state')).toHaveTextContent('「南昌龙大店」已停用，无可展示数据')
    expect(screen.queryByTestId('board')).not.toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('范围下拉被锁定的账号（只剩一家在营门店）：空态给出回到默认范围的链接，停在当前板块', async () => {
    getDataCenterScopeOptions.mockResolvedValue({
      ...singleStoreOptions,
      inactiveStores: [{ storeId: 'X1', storeName: '南昌龙大店', marketId: 'M1' }],
    } satisfies DataCenterScopeOptions)
    render(await call('customer', { scope: 'store', scopeId: 'X1', preset: 'year' }))

    expect(screen.getByRole('link', { name: '回到默认范围' }))
      .toHaveAttribute('href', '/data-center/customer?preset=year&scope=store&scopeId=S1')
  })

  it('在营门店照常挂板块（本期无业绩由板块显示 0）', async () => {
    getDataCenterScopeOptions.mockResolvedValue(withInactive)
    render(await call('sales', { scope: 'store', scopeId: 'S1' }))

    expect(screen.getByTestId('board')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-empty-state')).not.toBeInTheDocument()
  })
})
