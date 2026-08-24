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

describe('InventoryLocationFilter', () => {
  it('总部、市场、门店都提交单个精确库存主体', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <InventoryLocationFilter options={options} value="HQ" onChange={onChange} />,
    )

    expect(screen.getByLabelText('库存市场层级')).toHaveDisplayValue('总部（供应链）')
    expect(screen.getByLabelText('库存门店层级')).toHaveDisplayValue('供应链库存')
    expect(screen.getByLabelText('库存门店层级')).toBeDisabled()

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
    expect(screen.getByLabelText('库存门店层级')).toHaveDisplayValue('红谷滩店')
  })
})
