import {
  calculateGroupedAmounts,
  expandGroupedAllocationLines,
  groupPaymentItems,
} from '../../packageOrder/utils/allocation-group'

const baseItem = {
  product_name: '净化美人',
  product_type: '疗程卡',
  received: '100.00',
  sales_category: '自销自耗',
  item_direction: '购买',
}

describe('groupPaymentItems', () => {
  test('同 SKU 的疗程卡和非疗程商品都按 SKU 合并', () => {
    const groups = groupPaymentItems([
      { ...baseItem, sale_item_id: 'card-1', sku_id: 'sku-card' },
      { ...baseItem, sale_item_id: 'card-2', sku_id: 'sku-card' },
      { ...baseItem, sale_item_id: 'home-1', sku_id: 'sku-home', product_name: '家居精华', product_type: '家居产品' },
      { ...baseItem, sale_item_id: 'home-2', sku_id: 'sku-home', product_name: '家居精华', product_type: '家居产品' },
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.saleItemIds)).toEqual([
      ['card-1', 'card-2'],
      ['home-1', 'home-2'],
    ])
    expect(groups.map((group) => group.received)).toEqual([200, 200])
  })

  test('SKU、销售分类、方向或缺失 SKU 时不合并', () => {
    const groups = groupPaymentItems([
      { ...baseItem, sale_item_id: 'a', sku_id: 'sku-a' },
      { ...baseItem, sale_item_id: 'b', sku_id: 'sku-b' },
      { ...baseItem, sale_item_id: 'c', sku_id: 'sku-a', sales_category: '他销自耗' },
      { ...baseItem, sale_item_id: 'd', sku_id: 'sku-a', item_direction: '转入' },
      { ...baseItem, sale_item_id: 'e', sku_id: null },
      { ...baseItem, sale_item_id: 'f', sku_id: null },
    ])

    expect(groups).toHaveLength(6)
    expect(groups.map((group) => group.sourceCount)).toEqual([1, 1, 1, 1, 1, 1])
  })

  test('已有分配配置不一致时保留独立编辑行', () => {
    const groups = groupPaymentItems(
      [
        { ...baseItem, sale_item_id: 'a', sku_id: 'sku-a' },
        { ...baseItem, sale_item_id: 'b', sku_id: 'sku-a' },
      ],
      new Map([
        ['a', [{ employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' }]],
        ['b', [{ employeeId: 'EMP-2', roleType: '美容师', allocationRatio: '1.000' }]],
      ]),
    )

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.saleItemIds)).toEqual([['a'], ['b']])
  })
})

describe('grouped allocation amounts', () => {
  test('先逐明细取整，再汇总金额和提成额', () => {
    const result = calculateGroupedAmounts([
      { ...baseItem, sale_item_id: 'a', sku_id: 'sku-a', received: '0.01' },
      { ...baseItem, sale_item_id: 'b', sku_id: 'sku-a', received: '0.01' },
    ], 0.5, 0.5)

    expect(result).toEqual({ allocatedAmount: '0.02', commissionAmount: '0.02' })
  })

  test('保存前将组内分配展开为全部独立 saleItemId', () => {
    const result = expandGroupedAllocationLines([
      {
        saleItemIds: ['card-1', 'card-2'],
        employeeId: 'EMP-1',
        roleType: '美容师',
        allocationRatio: '1.000',
      },
    ])

    expect(result).toEqual([
      { saleItemId: 'card-1', employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' },
      { saleItemId: 'card-2', employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' },
    ])
  })
})
