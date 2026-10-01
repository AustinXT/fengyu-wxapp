import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ConversionPanel } from './conversion-panel'

describe('#182 候选金额与件数展示', () => {
  function render(productType: string, amount: string, unitPrice: string, remain: number) {
    return renderToStaticMarkup(<ConversionPanel loading={false} heldCards={[{
      saleItemId: 'source', saleOrderId: 'sale', productName: '折抵来源', productType,
      unit: productType === '家居产品' ? '盒' : '次', quantity: 1, remainingQty: remain,
      remainingSessions: remain, sessionCount: 7, paidSessions: 7, unitRealPrice: unitPrice,
      saleAmount: '1000', saleOrderType: '销售单', deductibleAmount: amount,
    } as any]} selectedIds={[]} onChange={vi.fn()} totalIn={1000}
      isExperienceConversion={false} onExperienceConversionChange={vi.fn()}
      receivedAmountInput="1000" receivedAmount={1000} remainingPayable={1000}
      onReceivedAmountChange={vi.fn()} onReceivedAmountBlur={vi.fn()} />)
  }
  test('overpay次数为0仍明确显示可折金额214', () => {
    const html = render('疗程卡', '214.00', '398', 0)
    expect(html).toContain('可折金额 ¥214.00')
    expect(html).toContain('仅余额（无剩余次数）')
  })
  test('不足一件显示可折0盒与注销1盒，金额594', () => {
    const html = render('家居产品', '594.00', '680', 1)
    expect(html).toContain('可折金额 ¥594.00')
    expect(html).toContain('可折 0 盒')
    expect(html).toContain('注销 1 盒')
  })
  test('16.67×3=50.01按分整除展示3盒', () => {
    expect(render('家居产品', '50.01', '16.67', 3)).toContain('可折 3 盒')
  })
})
