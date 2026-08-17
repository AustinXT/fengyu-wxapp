import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

let componentDefinition: Record<string, any>
let originalComponent: unknown

beforeAll(async () => {
  originalComponent = (globalThis as any).Component
  ;(globalThis as any).Component = (definition: Record<string, any>) => {
    componentDefinition = definition
  }
  await import('../../components/conversion-panel/conversion-panel')
})

afterAll(() => {
  ;(globalThis as any).Component = originalComponent
})

function createComponent() {
  const instance: Record<string, any> = {
    data: {
      ...componentDefinition.data,
      priceDiff: 1500,
      receivedAmountInput: '1500.00',
      receivedAmount: 1500,
    },
    properties: {
      cardBalance: 0,
      cartItems: [],
    },
    _receivedTouched: false,
    setData(update: Record<string, unknown>) {
      Object.assign(this.data, update)
    },
    triggerEvent: vi.fn(),
  }
  Object.assign(instance, componentDefinition.methods)
  return instance
}

describe('conversion-panel 本次收款输入', () => {
  test('bindinput 保留原始字符串，失焦后才格式化两位小数', () => {
    const component = createComponent()

    component.onReceivedAmountInput({ detail: { value: '5' } })
    expect(component.data.receivedAmountInput).toBe('5')
    expect(component.data.receivedAmount).toBe(5)
    expect(component.data.debtAmountDisplay).toBe('1495.00')

    component.onReceivedAmountBlur()
    expect(component.data.receivedAmountInput).toBe('5.00')
  })

  test('体验转换时普通差额汇总必须隐藏', () => {
    const wxml = fs.readFileSync(
      path.resolve(__dirname, '../../components/conversion-panel/conversion-panel.wxml'),
      'utf8',
    )
    expect(wxml).toContain('<view wx:if="{{!isExperienceConversion}}" class="conv-summary">')
    expect(wxml).toContain('应付与实付均为 ¥0.00')
  })
})

describe('conversion-panel 疗程卡分组', () => {
  test('次数不同的同组卡拆行，选择合并行仍提交原始卡 ID', async () => {
    const component = createComponent()
    const snapshot = {
      saleItemGroupId: 'GROUP-SAME',
      productName: '肩颈舒缓SPA',
      productType: '疗程卡',
      unit: '次',
      remainingQuantity: null,
      unitRealPrice: '100.00',
      deductibleAmount: '100.00',
      quantity: 1,
      sessionCount: 2,
      paidSessions: 2,
      unitPrice: '100.00',
      saleAmount: '200.00',
      received: '200.00',
      pendingReceived: '0.00',
      expireDate: '2026-12-31',
      orderStatus: '已支付',
    }
    vi.mocked(callStaffApi).mockResolvedValue({
      cards: [
        { saleItemId: 'CARD-ONE', sourceSaleOrderId: 'ORDER-ONE', ...snapshot, remainingSessions: 1 },
        { saleItemId: 'CARD-TWO', sourceSaleOrderId: 'ORDER-TWO', ...snapshot, remainingSessions: 2 },
        { saleItemId: 'CARD-THREE', sourceSaleOrderId: 'ORDER-THREE', ...snapshot, remainingSessions: 2 },
      ],
    })

    await component.loadCards('CLIENT-1')

    expect(component.data.cards).toHaveLength(2)
    expect(component.data.cards.map((card: any) => card.sourceItems.length)).toEqual([1, 2])
    expect(component.data.cards.map((card: any) => card.remainingSessions)).toEqual([1, 4])

    component._setGroupSelection(component.data.cards[1], 2)

    expect(component.data.selectedIds).toEqual(['CARD-TWO', 'CARD-THREE'])
    expect(component.data.deductibleSum).toBe(200)
    expect(component.triggerEvent).toHaveBeenLastCalledWith('change', expect.objectContaining({
      selectedSaleItemIds: ['CARD-TWO', 'CARD-THREE'],
      deductibleSum: 200,
    }))
  })
})
