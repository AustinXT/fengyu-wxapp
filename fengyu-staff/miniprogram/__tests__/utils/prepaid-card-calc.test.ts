/**
 * prepaid-card-calc.ts 单测（新模型 v2）
 *
 * 新签名：computePrepaidDeduction({ payableAmount, customerCardBalance, useCard })
 * - 调用方先算好"应付合计" payableAmount = Σ 行 saleAmount（含订单级券摊算）
 * - 本函数仅负责把应付合计按充值卡余额拆为 prepaidCardAmount + paidAmount
 * - 与新开单流程中 cart-calc.ts 的 calcCartTotal / allocateCouponPerLine 配合一致
 */
import { computePrepaidDeduction } from '../../utils/prepaid-card-calc'

describe('computePrepaidDeduction — 充值卡预选抵扣计算', () => {
  test('余额 > 应付，useCard=true → 全额抵扣、实付=0、按钮组隐藏', () => {
    const r = computePrepaidDeduction({
      payableAmount: 300,
      customerCardBalance: 500,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(300)
    expect(r.paidAmount).toBe(0)
    expect(r.showPayMethodGroup).toBe(false)
  })

  test('用户关闭开关 → prepaid=0、paid=payable、按钮组展示', () => {
    const r = computePrepaidDeduction({
      payableAmount: 300,
      customerCardBalance: 500,
      useCard: false,
    })
    expect(r.prepaidCardAmount).toBe(0)
    expect(r.paidAmount).toBe(300)
    expect(r.showPayMethodGroup).toBe(true)
  })

  test('部分抵扣：余额 < 应付 → 抵扣=余额、实付=应付-余额、按钮组展示', () => {
    const r = computePrepaidDeduction({
      payableAmount: 300,
      customerCardBalance: 100,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(100)
    expect(r.paidAmount).toBe(200)
    expect(r.showPayMethodGroup).toBe(true)
  })

  test('余额=0 → 即使 useCard=true，prepaid=0、按钮组展示', () => {
    const r = computePrepaidDeduction({
      payableAmount: 300,
      customerCardBalance: 0,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(0)
    expect(r.paidAmount).toBe(300)
    expect(r.showPayMethodGroup).toBe(true)
  })

  test('应付=0（券+其他抵扣已扣光）：prepaid=0、paid=0、按钮组隐藏', () => {
    const r = computePrepaidDeduction({
      payableAmount: 0,
      customerCardBalance: 500,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(0)
    expect(r.paidAmount).toBe(0)
    expect(r.showPayMethodGroup).toBe(false)
  })

  test('浮点精度：余额 0.30、应付 0.30 → prepaid=0.30、paid=0', () => {
    const r = computePrepaidDeduction({
      payableAmount: 0.3,
      customerCardBalance: 0.3,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(0.3)
    expect(r.paidAmount).toBe(0)
  })

  test('负数 / 非法入参防御：返回非负值', () => {
    const r = computePrepaidDeduction({
      payableAmount: -100,
      customerCardBalance: -50,
      useCard: true,
    })
    expect(r.prepaidCardAmount).toBe(0)
    expect(r.paidAmount).toBe(0)
    expect(r.showPayMethodGroup).toBe(false)
  })
})

describe('order.create payload 契约（Wave 3G）', () => {
  // 模拟 onSubmitOrder 中 useCard / prepaidCardAmount 透传逻辑：
  //   useCard=true 且 prepaid>0 才真正写入 payload；prepaid=0 时回归 false
  function buildSubmitPayload(state: {
    payableAmount: number
    customerCardBalance: number
    useCard: boolean
  }) {
    const calc = computePrepaidDeduction(state)
    const useCard = state.useCard && calc.prepaidCardAmount > 0
    const prepaidCardAmount = useCard ? calc.prepaidCardAmount : 0
    return { useCard, prepaidCardAmount }
  }

  test('开关 on + 余额够 → useCard=true、prepaidCardAmount>0', () => {
    expect(
      buildSubmitPayload({ payableAmount: 300, customerCardBalance: 500, useCard: true })
    ).toEqual({ useCard: true, prepaidCardAmount: 300 })
  })

  test('开关 off → useCard=false、prepaidCardAmount=0', () => {
    expect(
      buildSubmitPayload({ payableAmount: 300, customerCardBalance: 500, useCard: false })
    ).toEqual({ useCard: false, prepaidCardAmount: 0 })
  })

  test('开关 on 但余额=0 → 自动归正', () => {
    expect(
      buildSubmitPayload({ payableAmount: 300, customerCardBalance: 0, useCard: true })
    ).toEqual({ useCard: false, prepaidCardAmount: 0 })
  })

  test('部分抵扣：payload 携带余额值（不是 payable）', () => {
    expect(
      buildSubmitPayload({ payableAmount: 300, customerCardBalance: 100, useCard: true })
    ).toEqual({ useCard: true, prepaidCardAmount: 100 })
  })
})
