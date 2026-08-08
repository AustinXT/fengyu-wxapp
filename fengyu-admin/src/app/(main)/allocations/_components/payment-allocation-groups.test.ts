import { describe, expect, it } from 'vitest'
import {
  calculateGroupedAmounts,
  expandGroupedAllocationLines,
  groupPaymentItems,
} from './payment-allocation-groups'

const baseItem = {
  productName: '净化美人',
  productType: '疗程卡',
  allocatableAmount: 100,
  received: 100,
  salesCategory: '自销自耗',
  itemDirection: '购买',
  suggestedRate: 0,
}

describe('groupPaymentItems', () => {
  it('同 SKU 的疗程卡和非疗程商品均合并为一个编辑组', () => {
    const groups = groupPaymentItems([
      { ...baseItem, saleItemId: 'card-1', skuId: 'sku-card' },
      { ...baseItem, saleItemId: 'card-2', skuId: 'sku-card' },
      { ...baseItem, saleItemId: 'home-1', skuId: 'sku-home', productName: '家居精华', productType: '家居产品' },
      { ...baseItem, saleItemId: 'home-2', skuId: 'sku-home', productName: '家居精华', productType: '家居产品' },
    ], [])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.saleItemIds)).toEqual([
      ['card-1', 'card-2'],
      ['home-1', 'home-2'],
    ])
  })

  it('SKU、销售分类、方向或缺失 SKU 不跨组', () => {
    const groups = groupPaymentItems([
      { ...baseItem, saleItemId: 'a', skuId: 'sku-a' },
      { ...baseItem, saleItemId: 'b', skuId: 'sku-b' },
      { ...baseItem, saleItemId: 'c', skuId: 'sku-a', salesCategory: '他销自耗' },
      { ...baseItem, saleItemId: 'd', skuId: 'sku-a', itemDirection: '转入' },
      { ...baseItem, saleItemId: 'e', skuId: null },
      { ...baseItem, saleItemId: 'f', skuId: null },
    ], [])

    expect(groups).toHaveLength(6)
  })

  it('已有员工或比例不一致时不合并，避免覆盖历史分配', () => {
    const groups = groupPaymentItems([
      { ...baseItem, saleItemId: 'a', skuId: 'sku-a' },
      { ...baseItem, saleItemId: 'b', skuId: 'sku-a' },
    ], [
      { saleItemId: 'a', employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' },
      { saleItemId: 'b', employeeId: 'EMP-2', roleType: '美容师', allocationRatio: '1.000' },
    ])

    expect(groups.map((group) => group.saleItemIds)).toEqual([['a'], ['b']])
  })
})

describe('grouped allocation helpers', () => {
  it('逐 source item 取整后汇总，并在保存时展开到每个 saleItemId', () => {
    const amounts = calculateGroupedAmounts([
      { ...baseItem, saleItemId: 'a', skuId: 'sku-a', received: 0.01 },
      { ...baseItem, saleItemId: 'b', skuId: 'sku-a', received: 0.01 },
    ], 0.5, 0.5)
    const expanded = expandGroupedAllocationLines([
      { saleItemIds: ['a', 'b'], employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' },
    ])

    expect(amounts).toEqual({ allocatedAmount: '0.02', commissionAmount: '0.02' })
    expect(expanded.map((entry) => entry.saleItemId)).toEqual(['a', 'b'])
  })
})
