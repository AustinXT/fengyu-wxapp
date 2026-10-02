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

describe('ScopeTimeFilter 范围选择接线', () => {
  it('写 URL 走父级 useUrlFilters 实例：勾选门店子集 → stores', async () => {
    params.scope = 'market'
    params.scopeId = 'M1'
    render(<ScopeTimeFilter scopeOptions={multiStoreOptions} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('scope-picker-trigger'))
    await user.click(screen.getByRole('checkbox', { name: '蓝莱店' }))
    await user.click(screen.getByRole('checkbox', { name: '九江店' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(setMany).toHaveBeenCalledWith({ scope: 'stores', scopeId: 'S2,S3' })
  })

  it('单店账号锁定范围选择', () => {
    params.scope = 'store'
    params.scopeId = 'S1'
    render(<ScopeTimeFilter scopeOptions={{
      topLevel: 'store', inactiveStores: [],
      markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
    }} />)
    expect(screen.getByTestId('scope-picker-trigger')).toBeDisabled()
  })

  it('URL 选中停用门店：回显「XX（已停用）」（#293）', () => {
    params.scope = 'store'
    params.scopeId = 'X1'
    render(<ScopeTimeFilter scopeOptions={{ ...multiStoreOptions, inactiveStores: [{ storeId: 'X1', storeName: '九江中辉店', marketId: 'M2' }] }} />)
    expect(screen.getByTestId('scope-picker-trigger')).toHaveTextContent('九江中辉店（已停用）')
  })
})
