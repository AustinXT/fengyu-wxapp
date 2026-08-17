import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

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
