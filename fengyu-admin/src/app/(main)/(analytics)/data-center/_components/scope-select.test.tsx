import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'
import { ScopeSelect } from './scope-select'

/**
 * ScopeSelect 锁定规则（#399）：非总部且只有一个可切换范围才锁；
 * 可切换范围 = 可见在营门店 + 直接授权的无门店市场（祖先市场不算）。
 */
function renderWith(options: DataCenterScopeOptions, query: Record<string, string>) {
  const filters = { get: (k: string) => query[k] ?? '', setMany: vi.fn() }
  render(<ScopeSelect scopeOptions={options} filters={filters} showStoreCount />)
  const [marketSelect, storeSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[]
  return { marketSelect, storeSelect }
}

const px = { id: 'PX', name: '品项公司', stores: [], granted: true }
const nc = { id: 'M1', name: '南昌凤御', stores: [{ storeId: 'S1', storeName: '蓝莱店' }], granted: false }

describe('ScopeSelect · 无门店市场（#399）', () => {
  it('只授权品项公司：市场下拉回显品项公司、锁定；门店数 0', () => {
    const { marketSelect, storeSelect } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [px] }, { scope: 'market', scopeId: 'PX' })
    expect(marketSelect.value).toBe('PX')
    expect(marketSelect.disabled).toBe(true)
    expect(storeSelect.disabled).toBe(true)
    expect(screen.getByTestId('scope-store-count').textContent).toBe('共 0 家门店')
  })

  it('单店 + 品项公司：解锁，市场下拉可选品项公司；不出现「全部授权门店」（只有一家店）', () => {
    const { marketSelect } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [nc, px] }, { scope: 'store', scopeId: 'S1' })
    expect(marketSelect.disabled).toBe(false)
    const labels = Array.from(marketSelect.options).map((o) => o.textContent)
    expect(labels).toContain('品项公司')
    expect(labels).not.toContain('全部授权门店')
  })

  it('单店店长（无无门店市场）：仍锁定，行为不变', () => {
    const { marketSelect } = renderWith({ topLevel: 'store', inactiveStores: [], markets: [nc] }, { scope: 'store', scopeId: 'S1' })
    expect(marketSelect.disabled).toBe(true)
  })

  it('唯一门店已停用的店长：祖先市场不计入，仍锁定', () => {
    const ancestor = { id: 'M1', name: '南昌凤御', stores: [], granted: false }
    const { marketSelect } = renderWith({ topLevel: 'store', inactiveStores: [], markets: [ancestor] }, {})
    expect(marketSelect.disabled).toBe(true)
  })

  it('解锁账号切到无门店市场：门店下拉禁用（只剩「全部门店」无意义）；切回有店市场则可选', () => {
    const { storeSelect } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [nc, px] }, { scope: 'market', scopeId: 'PX' })
    expect(storeSelect.disabled).toBe(true)
  })

  it('解锁账号选有店市场：门店下拉可选', () => {
    const { storeSelect } = renderWith({ topLevel: 'market', inactiveStores: [], markets: [nc, px] }, { scope: 'market', scopeId: 'M1' })
    expect(storeSelect.disabled).toBe(false)
  })
})
