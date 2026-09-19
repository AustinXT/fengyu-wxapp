import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { InventoryLocationFilterOptions } from '@/lib/inventory/types'
import InventoryLocationFilter from './inventory-location-filter'

const options: InventoryLocationFilterOptions = {
  headquarters: [{ locationId: 'HQ', name: '总部' }],
  markets: [{
    locationId: 'M1',
    name: '南昌市场',
    canSelectInventory: true,
    stores: [{ locationId: 'S1', name: '红谷滩店' }],
  }],
  defaultLocationId: 'HQ',
}

/** 降级成只读后仍要保住无障碍名：断言「不是下拉」而不是「找不到这个字段」。 */
function expectFixedLevel(ariaLabel: string, text: string, locationId: string) {
  expect(screen.queryByRole('combobox', { name: ariaLabel })).not.toBeInTheDocument()
  const fixed = screen.getByLabelText(ariaLabel)
  expect(fixed).toHaveTextContent(text)
  expect(fixed).toHaveAttribute('data-fixed-subject', locationId)
}

describe('InventoryLocationFilter', () => {
  it('总部、市场、门店都提交单个精确库存主体', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <InventoryLocationFilter options={options} value="HQ" onChange={onChange} />,
    )

    expect(screen.getByLabelText('库存市场层级')).toHaveDisplayValue('总部（供应链）')
    // 总部层级下二级候选只有「供应链库存」自己 —— 一个永远只有一项的下拉没有意义，
    // 降级为只读（#189）。
    expectFixedLevel('库存门店层级', '供应链库存', 'HQ')

    fireEvent.change(screen.getByLabelText('库存市场层级'), { target: { value: 'M1' } })
    expect(onChange).toHaveBeenLastCalledWith('M1')

    rerender(<InventoryLocationFilter options={options} value="M1" onChange={onChange} />)
    expect(screen.getByLabelText('库存门店层级')).toHaveDisplayValue('该市场库存')
    fireEvent.change(screen.getByLabelText('库存门店层级'), { target: { value: 'S1' } })
    expect(onChange).toHaveBeenLastCalledWith('S1')
  })

  it('门店级 scope 不暴露市场本级库存选项', () => {
    const storeOnly: InventoryLocationFilterOptions = {
      headquarters: [],
      markets: [{
        locationId: 'M1',
        name: '南昌市场',
        canSelectInventory: false,
        stores: [{ locationId: 'S1', name: '红谷滩店' }],
      }],
      defaultLocationId: 'S1',
    }

    render(<InventoryLocationFilter options={storeOnly} value="S1" onChange={vi.fn()} />)

    expect(screen.queryByRole('option', { name: '该市场库存' })).not.toBeInTheDocument()
    // 市场、门店两级候选都只剩一个，两个下拉一起降级为只读。
    expectFixedLevel('库存市场层级', '南昌市场', 'M1')
    expectFixedLevel('库存门店层级', '红谷滩店', 'S1')
  })

  it('候选多于一个时仍是可选下拉（只读降级不能退化成"全都不给选"）', () => {
    const onChange = vi.fn()
    const twoStores: InventoryLocationFilterOptions = {
      headquarters: [],
      markets: [{
        locationId: 'M1',
        name: '南昌市场',
        canSelectInventory: false,
        stores: [{ locationId: 'S1', name: '红谷滩店' }, { locationId: 'S2', name: '世纪店' }],
      }],
      defaultLocationId: 'S1',
    }

    render(<InventoryLocationFilter options={twoStores} value="S1" onChange={onChange} />)

    // 市场只有一个 → 只读；门店有两家 → 仍要能切换。
    expectFixedLevel('库存市场层级', '南昌市场', 'M1')
    fireEvent.change(screen.getByLabelText('库存门店层级'), { target: { value: 'S2' } })
    expect(onChange).toHaveBeenLastCalledWith('S2')
  })

  it('市场本级可选 + 无门店时，二级只剩「该市场库存」也降级为只读', () => {
    const marketOnly: InventoryLocationFilterOptions = {
      headquarters: [{ locationId: 'HQ', name: '总部' }],
      markets: [{ locationId: 'M1', name: '南昌市场', canSelectInventory: true, stores: [] }],
      defaultLocationId: 'M1',
    }

    render(<InventoryLocationFilter options={marketOnly} value="M1" onChange={vi.fn()} />)

    // 一级有总部 + 市场两项，仍是下拉；二级只剩市场本级一项。
    expect(screen.getByLabelText('库存市场层级')).toHaveDisplayValue('南昌市场')
    expectFixedLevel('库存门店层级', '该市场库存', 'M1')
  })

  it('完全没有可用主体时给出空态而不是空下拉', () => {
    const empty: InventoryLocationFilterOptions = {
      headquarters: [],
      markets: [],
      defaultLocationId: null,
    }

    render(<InventoryLocationFilter options={empty} value={null} onChange={vi.fn()} />)

    expect(screen.getByLabelText('库存市场层级')).toBeDisabled()
    expect(screen.getByRole('option', { name: '暂无可用库存主体' })).toBeInTheDocument()
  })
})
