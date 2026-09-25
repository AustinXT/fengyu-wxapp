import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'

const { params, setMany } = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  setMany: vi.fn(),
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (key: string) => params[key] ?? '',
    setMany,
  }),
}))

import { ScopeTimeFilter } from './scope-time-filter'

const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [],
  markets: [
    {
      id: 'M1',
      name: '南昌市场',
      stores: [
        { storeId: 'S1', storeName: '蓝莱店' },
        { storeId: 'S2', storeName: '绿湖店' },
      ],
    },
    {
      id: 'M2',
      name: '九江市场',
      stores: [{ storeId: 'S3', storeName: '九江店' }],
    },
  ],
}

beforeEach(() => {
  for (const key of Object.keys(params)) delete params[key]
  setMany.mockReset()
})

describe('ScopeTimeFilter 多门店权限', () => {
  it('授权汇总时显示“全部授权门店”并允许选择市场', async () => {
    params.scope = 'market'
    params.scopeId = 'M1'
    render(<ScopeTimeFilter scopeOptions={multiStoreOptions} />)

    const [marketSelect, storeSelect] = screen.getAllByRole('combobox')
    expect(marketSelect).not.toBeDisabled()
    expect(screen.getByRole('option', { name: '全部授权门店' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '蓝莱店' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '绿湖店' })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.selectOptions(storeSelect, 'S2')
    expect(setMany).toHaveBeenCalledWith({ scope: 'store', scopeId: 'S2' })
  })

  it('从市场切回全部授权门店时清除 scopeId', async () => {
    params.scope = 'market'
    params.scopeId = 'M1'
    render(<ScopeTimeFilter scopeOptions={multiStoreOptions} />)

    const [marketSelect] = screen.getAllByRole('combobox')
    const user = userEvent.setup()
    await user.selectOptions(marketSelect, '')
    expect(setMany).toHaveBeenCalledWith({ scope: 'authorized', scopeId: '' })
  })

  it('单店账号锁定市场和门店下拉', () => {
    params.scope = 'store'
    params.scopeId = 'S1'
    render(<ScopeTimeFilter scopeOptions={{
      topLevel: 'store', inactiveStores: [],
      markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
    }} />)

    const [marketSelect, storeSelect] = screen.getAllByRole('combobox')
    expect(marketSelect).toBeDisabled()
    expect(storeSelect).toBeDisabled()
  })

  it('总部账号切回全部市场时仍使用全局 all', async () => {
    params.scope = 'market'
    params.scopeId = 'M1'
    render(<ScopeTimeFilter scopeOptions={{ ...multiStoreOptions, topLevel: 'all' }} />)

    const [marketSelect] = screen.getAllByRole('combobox')
    const user = userEvent.setup()
    await user.selectOptions(marketSelect, '')
    expect(setMany).toHaveBeenCalledWith({ scope: '', scopeId: '' })
  })
})

describe('ScopeTimeFilter 已停用门店回显（#293）', () => {
  it('URL 选中停用门店：市场下拉回显其市场，门店下拉回显「XX（已停用）」且不可选', () => {
    params.scope = 'store'
    params.scopeId = 'X1'
    render(<ScopeTimeFilter scopeOptions={{ ...multiStoreOptions, inactiveStores: [{ storeId: 'X1', storeName: '九江中辉店', marketId: 'M2' }] }} />)

    const [marketSelect, storeSelect] = screen.getAllByRole('combobox')
    expect(marketSelect).toHaveValue('M2')
    expect(storeSelect).toHaveValue('X1')
    expect(screen.getByRole('option', { name: '九江中辉店（已停用）' })).toBeDisabled()
  })

  it('未选中停用门店时下拉里不出现它', () => {
    params.scope = 'market'
    params.scopeId = 'M2'
    render(<ScopeTimeFilter scopeOptions={{ ...multiStoreOptions, inactiveStores: [{ storeId: 'X1', storeName: '九江中辉店', marketId: 'M2' }] }} />)

    expect(screen.queryByRole('option', { name: '九江中辉店（已停用）' })).not.toBeInTheDocument()
  })
})
