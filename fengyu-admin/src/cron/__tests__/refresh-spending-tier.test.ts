/**
 * STEP spendingTier — spending_tier 重算 SQL 形态测试
 *
 * 口径守护：终身累计净额分档，不加时间过滤；仅写变更行。
 */

import { describe, it, expect } from 'vitest'
import { UPDATE_SPENDING_TIER_SQL } from '../steps/refresh-spending-tier'

describe('cron-worker STEP spendingTier — spending_tier 重算 SQL', () => {
  it("净额 = SUM(GREATEST(received - refunded_amount, 0)) FILTER 销售单/转换单", () => {
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/GREATEST\(/i)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/received/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/refunded_amount/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单',\s*'转换单'\s*\)/)
  })

  it('终身口径：不含任何 paid_at / NOW() 时间过滤（区别于 member_level 12 个月窗口）', () => {
    expect(UPDATE_SPENDING_TIER_SQL).not.toMatch(/paid_at/)
    expect(UPDATE_SPENDING_TIER_SQL).not.toMatch(/INTERVAL/i)
  })

  it('6 档阈值齐全', () => {
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/>=\s*100000\s+THEN\s+'10W\+'/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/>=\s*60000\s+THEN\s+'6-10W'/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/>=\s*30000\s+THEN\s+'3-6W'/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/>=\s*10000\s+THEN\s+'1-3W'/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/>=\s*1990\s+THEN\s+'1990-1W'/)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/ELSE\s+'<1990'/)
  })

  it('cast 成 spending_tier 枚举', () => {
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/::spending_tier/)
  })

  it('仅写变更行（IS DISTINCT FROM）', () => {
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/spending_tier\s+IS\s+DISTINCT\s+FROM/i)
  })

  it('LEFT JOIN sale_orders 保证零订单顾客也落 <1990（COALESCE 0）', () => {
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/LEFT\s+JOIN\s+sale_orders/i)
    expect(UPDATE_SPENDING_TIER_SQL).toMatch(/COALESCE\(/i)
  })
})
