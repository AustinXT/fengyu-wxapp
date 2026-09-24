/**
 * 提货录入按销售单分组（#350）。
 *
 * 会议 §2.11「选顾客 → 选销售单 → 领取」：同一顾客有多张销售单待提时，必须能看出每件货属于哪张单。
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/actions/customers', () => ({ searchCustomerByPhone: vi.fn() }))
vi.mock('@/actions/pickup-records', () => ({
  createPickupRecord: vi.fn(),
  getAvailablePickupItems: vi.fn(),
  getPickupInventorySkuOptions: vi.fn(),
}))

import type { AvailablePickupItem } from '@/actions/pickup-records'
import { PickupOrderGroupRows, groupAvailablePickupItemsByOrder } from './pickup-record-create-page'

function item(overrides: Partial<AvailablePickupItem>): AvailablePickupItem {
  return {
    saleItemId: 'SI-1',
    saleItemGroupId: null,
    sourceSaleItemIds: ['SI-1'],
    saleOrderId: 'ORDER-A',
    skuId: 'sku-1',
    productName: '面霜',
    quantity: 2,
    pickedUpQuantity: 0,
    paidQuantity: 2,
    remaining: 2,
    unitRealPrice: '199.00',
    storeId: 'store-1',
    storeName: '红谷滩店',
    orderDate: '2026-09-20',
    ...overrides,
  }
}

describe('groupAvailablePickupItemsByOrder', () => {
  it('同一顾客两张销售单各有待提商品 → 两个分组，组头带单号、下单日期、开单门店', () => {
    const groups = groupAvailablePickupItemsByOrder([
      item({ saleItemId: 'SI-B1', saleOrderId: 'ORDER-B', orderDate: '2026-09-22', storeName: '九江店' }),
      item({ saleItemId: 'SI-A1', saleOrderId: 'ORDER-A' }),
      item({ saleItemId: 'SI-B2', saleOrderId: 'ORDER-B', orderDate: '2026-09-22', storeName: '九江店' }),
    ])
    expect(groups.map((g) => g.saleOrderId)).toEqual(['ORDER-B', 'ORDER-A'])
    expect(groups[0]).toMatchObject({ orderDate: '2026-09-22', storeName: '九江店' })
    expect(groups[0].items.map((i) => i.saleItemId)).toEqual(['SI-B1', 'SI-B2'])
    expect(groups[1].items.map((i) => i.saleItemId)).toEqual(['SI-A1'])
  })

  it('分组键是销售单号：同门店、同下单日期的两张单仍是两组', () => {
    // 上一条用例的单号 / 门店 / 日期一一对应，按 storeName 或 orderDate 分组也能过 —— 这条钉住分组键
    const groups = groupAvailablePickupItemsByOrder([
      item({ saleItemId: 'SI-A1', saleOrderId: 'ORDER-A' }),
      item({ saleItemId: 'SI-C1', saleOrderId: 'ORDER-C' }),
    ])
    expect(groups.map((g) => g.saleOrderId)).toEqual(['ORDER-A', 'ORDER-C'])
  })

  it('空清单 → 空分组', () => {
    expect(groupAvailablePickupItemsByOrder([])).toEqual([])
  })
})

describe('PickupOrderGroupRows', () => {
  it('组头显示销售单号 / 下单日期 / 开单门店，明细显示顾客实际单价，点选回传 saleItemId', () => {
    const onSelect = vi.fn()
    const [group] = groupAvailablePickupItemsByOrder([
      item({ saleItemId: 'SI-A1', unitRealPrice: '199.5' }),
      item({ saleItemId: 'SI-A2', productName: '精华', unitRealPrice: '0' }),
    ])
    render(
      <table><tbody>
        <PickupOrderGroupRows group={group} selectedItemId={null} onSelect={onSelect} />
      </tbody></table>,
    )
    const rows = screen.getAllByRole('row')
    expect(rows[0].textContent).toContain('ORDER-A')
    expect(rows[0].textContent).toContain('下单日期 2026-09-20')
    expect(rows[0].textContent).toContain('开单门店 红谷滩店')
    expect(within(rows[1]).getByText('¥199.50')).toBeTruthy()
    expect(within(rows[2]).getByText('¥0.00')).toBeTruthy()
    fireEvent.click(rows[2])
    expect(onSelect).toHaveBeenCalledWith('SI-A2')
  })

  it('下单日期 / 门店缺失时显示占位符，不渲染 null', () => {
    const [group] = groupAvailablePickupItemsByOrder([item({ orderDate: null, storeName: null })])
    render(
      <table><tbody>
        <PickupOrderGroupRows group={group} selectedItemId="SI-1" onSelect={() => {}} />
      </tbody></table>,
    )
    const head = screen.getAllByRole('row')[0].textContent ?? ''
    expect(head).toContain('下单日期 —')
    expect(head).toContain('开单门店 —')
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true)
  })
})
