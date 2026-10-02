import { describe, expect, it } from 'vitest'
import { inventoryDocStatusLabel } from './doc-status-label'

describe('inventoryDocStatusLabel（#335 部分入库派生标签）', () => {
  it('待收货且已有入库显示「部分入库」', () => {
    expect(inventoryDocStatusLabel({ status: '待收货', partiallyReceived: true })).toBe('部分入库')
  })

  it('其余情况原样显示单据状态', () => {
    expect(inventoryDocStatusLabel({ status: '待收货', partiallyReceived: false })).toBe('待收货')
    expect(inventoryDocStatusLabel({ status: '已完成' })).toBe('已完成')
  })
})

describe('inventoryDocStatusLabel 防御', () => {
  it('非待收货的单即使带了 partiallyReceived 也显示原状态', () => {
    expect(inventoryDocStatusLabel({ status: '已取消', partiallyReceived: true })).toBe('已取消')
  })
})
