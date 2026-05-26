/**
 * cron-13：STEP spendingTier 端到端
 *
 * 业务口径（src/cron/steps/refresh-spending-tier.ts）：
 *   spending_tier = 终身累计净额分档，净额 = Σ GREATEST(received - refunded_amount, 0)
 *   FILTER (sale_order_type IN ('销售单','转换单'))。不加时间过滤；仅写变更行。
 *   档位：>=100000 '10W+' / >=60000 '6-10W' / >=30000 '3-6W' / >=10000 '1-3W' /
 *         >=1990 '1990-1W' / else '<1990'。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, insertSaleOrder, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { getSpendingTier } from './_helpers/cron-asserts'

function runSpendingTier(): unknown {
  const out = runCronStep('spendingTier')
  const summary = parseStepSummary(out, 'spendingTier')
  if (summary === null) throw new Error(`spendingTier summary 解析失败:\n${out}`)
  return summary
}

const STORE_ID = psql(`SELECT store_id FROM stores LIMIT 1`)
if (!STORE_ID) throw new Error('需要 stores fixture')
const PAID = '2026-01-01' // 终身口径不看时间，给任意值

test.describe.serial('cron-13 refreshSpendingTier', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('13.1 净额 100000 → 10W+', () => {
    const uid = upsertClient('ST_21', { customerType: '会员客' })
    insertSaleOrder('ST_21', { storeId: STORE_ID, clientUserId: uid, received: 100000, paidAt: PAID })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('10W+')
  })

  test('13.2 净额 30000 → 3-6W', () => {
    const uid = upsertClient('ST_22', { customerType: '会员客' })
    insertSaleOrder('ST_22', { storeId: STORE_ID, clientUserId: uid, received: 30000, paidAt: PAID })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('3-6W')
  })

  test('13.3 净额 2000 → 1990-1W（跨过 1990 下界）', () => {
    const uid = upsertClient('ST_23', { customerType: '会员客' })
    insertSaleOrder('ST_23', { storeId: STORE_ID, clientUserId: uid, received: 2000, paidAt: PAID })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('1990-1W')
  })

  test('13.4 净额 1000（< 1990）→ <1990', () => {
    const uid = upsertClient('ST_24', { customerType: '会员客' })
    insertSaleOrder('ST_24', { storeId: STORE_ID, clientUserId: uid, received: 1000, paidAt: PAID })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('<1990')
  })

  test('13.5 退款扣减：received 100000 - refunded 95000 = 净 5000 → <1990', () => {
    const uid = upsertClient('ST_25', { customerType: '会员客' })
    insertSaleOrder('ST_25', {
      storeId: STORE_ID, clientUserId: uid, received: 100000, refundedAmount: 95000, paidAt: PAID,
    })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('<1990')
  })

  test('13.6 内部单不计入净额：100000 内部单 → <1990', () => {
    const uid = upsertClient('ST_26', { customerType: '会员客' })
    insertSaleOrder('ST_26', {
      storeId: STORE_ID, clientUserId: uid, saleOrderType: '内部单', received: 100000, paidAt: PAID,
    })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('<1990')
  })

  test('13.7 多单累加：20000 + 20000 = 净 40000 → 3-6W', () => {
    const uid = upsertClient('ST_27', { customerType: '会员客' })
    insertSaleOrder('ST_27_a', { storeId: STORE_ID, clientUserId: uid, received: 20000, paidAt: PAID })
    insertSaleOrder('ST_27_b', { storeId: STORE_ID, clientUserId: uid, received: 20000, paidAt: PAID })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('3-6W')
  })

  test('13.8 转换单计入净额：30000 转换单 → 3-6W', () => {
    const uid = upsertClient('ST_28', { customerType: '会员客' })
    insertSaleOrder('ST_28', {
      storeId: STORE_ID, clientUserId: uid, saleOrderType: '转换单', received: 30000, paidAt: PAID,
    })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('3-6W')
  })

  test('13.9 无任何订单顾客 → <1990（COALESCE 0）', () => {
    const uid = upsertClient('ST_29', { customerType: '流量客' })
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe('<1990')
  })

  test('13.10 幂等：连跑两次结果一致', () => {
    const uid = upsertClient('ST_30', { customerType: '会员客' })
    insertSaleOrder('ST_30', { storeId: STORE_ID, clientUserId: uid, received: 60000, paidAt: PAID })
    runSpendingTier()
    const first = getSpendingTier(uid)
    runSpendingTier()
    expect(getSpendingTier(uid)).toBe(first)
    expect(first).toBe('6-10W')
  })

  test('13.11 cleanup', () => {
    cleanupCronE2E()
    expect(
      Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}ST_%'`)),
    ).toBe(0)
  })
})
