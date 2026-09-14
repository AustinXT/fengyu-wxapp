/**
 * 款项业绩归属日期口径单源的直接单测（issue #137）
 *
 * 在此之前这个模块只有 `orders.test.ts` / `allocations.test.ts` 的间接覆盖，
 * 而那两处把 drizzle 整个 mock 掉了 —— 口径本身（读哪张表的哪一列、区间是开还是闭）
 * 反而没有一条直接断言。收敛成"直读一列"之后更需要守住：表达式越简单，
 * 越容易在某次重构里被"顺手"改回订单级而没人发现。
 */

import { describe, it, expect } from 'vitest'
import { saleOrderPayments, saleOrders } from '@db/order'
import {
  resolvePaymentAttributionDate,
  paymentAttributionDateSql,
  paymentAttributionRangeConditions,
} from '../performance-attribution'

/**
 * 抽出 drizzle SQL 里的字面量片段。
 * 不能用 JSON.stringify —— chunk 里的 Column 持有 table 反向引用，会直接抛循环结构。
 */
function textOf(expr: unknown): string {
  const chunks = (expr as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value
      if (Array.isArray(v)) return v.join('')
      if (typeof v === 'string') return v
      // 嵌套 SQL（paymentAttributionDateSql 的返回值就被嵌在区间条件里）
      if ((c as { queryChunks?: unknown[] }).queryChunks) return textOf(c)
      return ''
    })
    .join('')
}

describe('resolvePaymentAttributionDate — JS 版口径', () => {
  it('有款项行 → 直读款项级列，即使与订单级不同也不回退', () => {
    expect(
      resolvePaymentAttributionDate({ payment: '2026-09-05', order: '2026-09-01' }),
    ).toBe('2026-09-05')
  })

  it('无款项行（旧的订单维度分配没有 sale_payment_id）→ 用订单级', () => {
    expect(resolvePaymentAttributionDate({ payment: null, order: '2026-09-01' })).toBe('2026-09-01')
    expect(resolvePaymentAttributionDate({ payment: undefined, order: '2026-09-01' })).toBe('2026-09-01')
  })

  it('两者都没有 → null，不编造日期', () => {
    expect(resolvePaymentAttributionDate({ payment: null, order: null })).toBeNull()
  })

  it('空串是合法的"有值"，不触发订单级分支（?? 而非 ||）', () => {
    expect(resolvePaymentAttributionDate({ payment: '', order: '2026-09-01' })).toBe('')
  })
})

describe('paymentAttributionDateSql — SQL 版口径', () => {
  it('无别名 → 引用的是 sale_order_payments 的列，不是 sale_orders 的', () => {
    const expr = paymentAttributionDateSql()
    // drizzle 的 SQL chunks 里带的是 Column 实例，直接比引用最可靠：
    // 两张表的列名一模一样，比字符串会漏掉"读错表"这种回归。
    const chunks = (expr as unknown as { queryChunks: unknown[] }).queryChunks
    expect(chunks).toContain(saleOrderPayments.performanceAttributionDate)
    expect(chunks).not.toContain(saleOrders.performanceAttributionDate)
  })

  it('带别名 → 拼成 <alias>.performance_attribution_date（EXISTS 半连接用）', () => {
    const expr = paymentAttributionDateSql('payment_attribution_filter')
    expect(textOf(expr)).toContain('payment_attribution_filter.performance_attribution_date')
    expect(textOf(expr)).not.toContain('sale_orders')
  })
})

describe('paymentAttributionRangeConditions — 闭区间', () => {

  it('两端都给 → 上下界都生成', () => {
    const [from, to] = paymentAttributionRangeConditions('2026-09-01', '2026-09-30')
    expect(from).toBeDefined()
    expect(to).toBeDefined()
  })

  it('只给一端 → 另一端是 undefined（调用点按需过滤）', () => {
    expect(paymentAttributionRangeConditions('2026-09-01', undefined)[1]).toBeUndefined()
    expect(paymentAttributionRangeConditions(undefined, '2026-09-30')[0]).toBeUndefined()
    expect(paymentAttributionRangeConditions(undefined, undefined)).toEqual([undefined, undefined])
  })

  it('用闭区间 >= / <=，不是 timestamptz 那套半开区间', () => {
    const [from, to] = paymentAttributionRangeConditions('2026-09-01', '2026-09-30')
    expect(textOf(from)).toContain('>=')
    expect(textOf(to)).toContain('<=')
    // 结束日用 `< 次日零点` 会把结束日整天漏掉 —— date 列不能套那套写法
    expect(textOf(to)).not.toContain('<  ')
  })

  it('两端都显式 ::date 转型，避免绑定参数落到 text 比较', () => {
    const [from, to] = paymentAttributionRangeConditions('2026-09-01', '2026-09-30')
    expect(textOf(from)).toContain('::date')
    expect(textOf(to)).toContain('::date')
  })
})
