import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'
import { ScopeSelect } from './scope-select'

function renderWith(options: DataCenterScopeOptions, query: Record<string, string>) {
  const setMany = vi.fn()
  const filters = { get: (k: string) => query[k] ?? '', setMany }
  render(<ScopeSelect scopeOptions={options} filters={filters} showStoreCount />)
  return { setMany, trigger: screen.getByTestId('scope-picker-trigger') as HTMLButtonElement }
}

const px = { id: 'PX', name: '品项公司', stores: [], granted: true }
const nc = { id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '蓝莱店' }], granted: false }

/**
 * 锁定规则（#399）：非总部且只有一个可切换范围才锁；
 * 可切换范围 = 可见在营门店 + 直接授权的无门店市场（祖先市场不算）。
 */
describe('ScopeSelect · 无门店市场（#399）', () => {
  it('只授权品项公司：回显品项公司、锁定；门店数 0', () => {
    const { trigger } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [px] }, { scope: 'market', scopeId: 'PX' })
    expect(trigger).toHaveTextContent('品项公司')
    expect(trigger).toBeDisabled()
    expect(screen.getByTestId('scope-store-count').textContent).toBe('共 0 家门店')
  })

  it('单店 + 品项公司：解锁，面板里品项公司作为单选项，点即切到该市场；无「全选」外的汇总项', async () => {
    const { trigger, setMany } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [nc, px] }, { scope: 'store', scopeId: 'S1' })
    expect(trigger).not.toBeDisabled()
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /品项公司/ }))
    expect(setMany).toHaveBeenCalledWith({ scope: 'market', scopeId: 'PX' })
  })

  it('单店店长（无无门店市场）：仍锁定', () => {
    const { trigger } = renderWith({ topLevel: 'store', inactiveStores: [], markets: [nc] }, { scope: 'store', scopeId: 'S1' })
    expect(trigger).toBeDisabled()
  })

  it('唯一门店已停用的店长：祖先市场不计入，仍锁定', () => {
    const ancestor = { id: 'M1', name: '南昌凤御', stores: [], granted: false }
    const { trigger } = renderWith({ topLevel: 'store', inactiveStores: [], markets: [ancestor] }, {})
    expect(trigger).toBeDisabled()
  })
})

const multi: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [{ storeId: 'X1', storeName: '九江中辉店', marketId: 'M2' }],
  markets: [
    { id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }] },
    { id: 'M2', name: '九江市场', stores: [{ storeId: 'S3', storeName: '九江店' }, { storeId: 'S4', storeName: '浔阳店' }] },
  ],
}

describe('ScopeSelect · 门店多选（#376）', () => {
  it('打开面板：全选 / 按市场分组，初值为当前范围覆盖的门店', async () => {
    const { trigger } = renderWith(multi, { scope: 'authorized' })
    expect(trigger).toHaveTextContent('全部授权门店')
    const user = userEvent.setup()
    await user.click(trigger)
    expect(screen.getByRole('checkbox', { name: '全选（当前权限范围）' })).toBeChecked()
    const nanchang = screen.getByRole('group', { name: '南昌市场' })
    expect(within(nanchang).getByRole('checkbox', { name: '蓝莱店' })).toBeChecked()
    expect(screen.getByTestId('scope-picker-count')).toHaveTextContent('已选 4 家')
  })

  it('跨市场勾选子集 → stores（升序逗号串）', async () => {
    const { trigger, setMany } = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '九江店' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).toHaveBeenCalledWith({ scope: 'stores', scopeId: 'S1,S3' })
  })

  it('勾满单个市场 → 折叠成 market', async () => {
    const { trigger, setMany } = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '绿湖店' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).toHaveBeenCalledWith({ scope: 'market', scopeId: 'M1' })
  })

  it('全选：非总部 → authorized；总部 → 清空（all）', async () => {
    const user = userEvent.setup()
    const a = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    await user.click(a.trigger)
    await user.click(screen.getByRole('checkbox', { name: '全选（当前权限范围）' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(a.setMany).toHaveBeenCalledWith({ scope: 'authorized', scopeId: '' })
  })

  it('总部全选 → all', async () => {
    const user = userEvent.setup()
    const { trigger, setMany } = renderWith({ ...multi, topLevel: 'all' }, { scope: 'market', scopeId: 'M1' })
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '全选（当前权限范围）' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).toHaveBeenCalledWith({ scope: '', scopeId: '' })
  })

  it('市场标题半选；点击后整组勾上', async () => {
    const { trigger } = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    const header = screen.getByRole('checkbox', { name: '南昌市场' }) as HTMLInputElement
    expect(header.indeterminate).toBe(true)
    await user.click(header)
    expect(screen.getByRole('checkbox', { name: '绿湖店' })).toBeChecked()
  })

  it('全不选时「确定」禁用', async () => {
    const { trigger } = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '蓝莱店' }))
    expect(screen.getByRole('button', { name: '确定' })).toBeDisabled()
  })

  it('门店搜索：按店名过滤，市场名命中时显示整组', async () => {
    const { trigger } = renderWith(multi, { scope: 'authorized' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.type(screen.getByRole('searchbox', { name: '搜索门店' }), '浔阳')
    expect(screen.getByRole('checkbox', { name: '浔阳店' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '蓝莱店' })).not.toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: '搜索门店' }))
    await user.type(screen.getByRole('searchbox', { name: '搜索门店' }), '九江市场')
    expect(screen.getByRole('checkbox', { name: '九江店' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '浔阳店' })).toBeInTheDocument()
  })

  it('取消不写 URL', async () => {
    const { trigger, setMany } = renderWith(multi, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '九江店' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(setMany).not.toHaveBeenCalled()
  })

  it('多店回显店名与门店数', () => {
    const { trigger } = renderWith(multi, { scope: 'stores', scopeId: 'S1,S3' })
    expect(trigger).toHaveTextContent('蓝莱店、九江店')
    expect(screen.getByTestId('scope-store-count').textContent).toBe('共 2 家门店')
  })
})

describe('ScopeSelect · pr-ready 边界整改（#376）', () => {
  const withSingle: DataCenterScopeOptions = {
    ...multi,
    markets: [...multi.markets, { id: 'M3', name: '昭通市场', stores: [{ storeId: 'S5', storeName: '昭通店' }] }],
  }

  it('勾满只有 1 家店的市场 → market（不退化成单店，锚定员工口径不变）', async () => {
    const { trigger, setMany } = renderWith(withSingle, { scope: 'store', scopeId: 'S1' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(screen.getByRole('checkbox', { name: '蓝莱店' }))
    await user.click(screen.getByRole('checkbox', { name: '昭通市场' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).toHaveBeenCalledWith({ scope: 'market', scopeId: 'M3' })
  })

  it('原样确定不写 URL：market 书签、部分停用多店都不会被悄悄改掉', async () => {
    const user = userEvent.setup()
    const a = renderWith(withSingle, { scope: 'market', scopeId: 'M1' })
    await user.click(a.trigger)
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(a.setMany).not.toHaveBeenCalled()
  })

  it('部分停用多店原样确定：不剔除停用门店', async () => {
    const user = userEvent.setup()
    const { trigger, setMany } = renderWith(multi, { scope: 'stores', scopeId: 'S1,X1' })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).not.toHaveBeenCalled()
  })

  it('搜索时市场标题不带复选框（避免「整组已选」的误读）', async () => {
    const { trigger } = renderWith(multi, { scope: 'authorized' })
    const user = userEvent.setup()
    await user.click(trigger)
    await user.type(screen.getByRole('searchbox', { name: '搜索门店' }), '浔阳')
    expect(screen.queryByRole('checkbox', { name: '九江市场' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: '九江市场' })).toHaveTextContent('九江市场')
  })
})

describe('ScopeSelect · 停用门店（#293 / #376）', () => {
  it('单店停用：按钮回显「XX（已停用）」，不显示门店数', () => {
    const { trigger } = renderWith(multi, { scope: 'store', scopeId: 'X1' })
    expect(trigger).toHaveTextContent('九江中辉店（已停用）')
    expect(screen.queryByTestId('scope-store-count')).not.toBeInTheDocument()
  })

  it('多店部分停用：提示 N 家已停用、不计入；门店数只算在营', () => {
    renderWith(multi, { scope: 'stores', scopeId: 'S1,X1' })
    expect(screen.getByTestId('scope-inactive-notice')).toHaveTextContent('所选门店中 1 家已停用（九江中辉店），不计入统计')
    expect(screen.getByTestId('scope-store-count').textContent).toBe('共 1 家门店')
  })

  it('打开面板时停用门店不回填勾选', async () => {
    const { trigger } = renderWith(multi, { scope: 'stores', scopeId: 'S1,X1' })
    const user = userEvent.setup()
    await user.click(trigger)
    expect(screen.getByTestId('scope-picker-count')).toHaveTextContent('已选 1 家')
  })
})
