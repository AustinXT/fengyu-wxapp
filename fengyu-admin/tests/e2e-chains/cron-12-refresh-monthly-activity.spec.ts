/**
 * cron-12：STEP monthlyActivity 端到端
 *
 * 业务口径（src/cron/steps/refresh-monthly-activity.ts），按「当月到店天数」service_date 去重：
 *   段 1：全表 monthly_activity 置 NULL
 *   段 2：当月有到店记录顾客（含非会员）按去重天数 → 二次(>=2)/一次(=1) 客活
 *   段 3：会员客当月未到店 → 0次客活（非会员未到店保持 NULL）
 *
 * 用 CRON_REFERENCE_DATE 注入 2026-11-20 → 当月窗口 = 2026-11 整月。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { getMonthlyActivity } from './_helpers/cron-asserts'

function runMonthlyActivity(referenceDate: string): unknown {
  const out = runCronStep('monthlyActivity', { referenceDate })
  const summary = parseStepSummary(out, 'monthlyActivity')
  if (summary === null) throw new Error(`monthlyActivity summary 解析失败:\n${out}`)
  return summary
}

function ensure(): { storeId: string; employeeId: string; marketName: string } {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  const employeeId = psql(
    `SELECT employee_id FROM staff_wechat_users WHERE COALESCE(is_resigned, FALSE) = FALSE LIMIT 1`,
  )
  const marketName = psql(`SELECT DISTINCT market_name FROM service_orders WHERE market_name IS NOT NULL LIMIT 1`)
  if (!storeId || !employeeId || !marketName) throw new Error('需要 fixture')
  return { storeId, employeeId, marketName }
}
const REAL = ensure()

/** 构造一笔已完成 service_order（一次「到店」），service_date 决定计入哪天 */
function insertServiceVisit(suffix: string, clientUserId: string, serviceDate: string): void {
  const soid = `${PREFIX.SVC}${suffix}`
  psql(`
    INSERT INTO service_orders (
      service_order_id, store_id, client_user_id, service_date,
      status, market_name, assigned_employee_id, service_order_type,
      created_at, updated_at
    )
    VALUES (
      '${soid}', '${REAL.storeId}', '${clientUserId}', '${serviceDate}',
      '已完成', '${REAL.marketName.replace(/'/g, "''")}', '${REAL.employeeId}', '售前',
      NOW(), NOW()
    )
    ON CONFLICT (service_order_id) DO UPDATE SET
      service_date = EXCLUDED.service_date, status = EXCLUDED.status, updated_at = NOW()
  `)
}

const REF_DATE = '2026-11-20'

test.describe.serial('cron-12 refreshMonthlyActivity', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('12.1 会员客当月到店 2 天（不同日）→ 二次客活', () => {
    const uid = upsertClient('MA_21', { customerType: '会员客' })
    insertServiceVisit('MA_21_1', uid, '2026-11-05')
    insertServiceVisit('MA_21_2', uid, '2026-11-10')
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe('二次客活')
  })

  test('12.2 会员客当月同一天 3 单 → 去重 1 天 → 一次客活', () => {
    const uid = upsertClient('MA_22', { customerType: '会员客' })
    insertServiceVisit('MA_22_1', uid, '2026-11-05')
    insertServiceVisit('MA_22_2', uid, '2026-11-05')
    insertServiceVisit('MA_22_3', uid, '2026-11-05')
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe('一次客活')
  })

  test('12.3 会员客当月未到店（仅上月有单）→ 0次客活', () => {
    const uid = upsertClient('MA_23', { customerType: '会员客' })
    insertServiceVisit('MA_23', uid, '2026-10-15') // 上月，不计入当月
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe('0次客活')
  })

  test('12.4 非会员客当月未到店 → NULL（不是 0次客活）', () => {
    const uid = upsertClient('MA_24', { customerType: '流量客' })
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBeNull()
  })

  test('12.5 非会员客当月到店 2 天 → 二次客活（段 2 不限会员）', () => {
    const uid = upsertClient('MA_25', { customerType: '流量客' })
    insertServiceVisit('MA_25_1', uid, '2026-11-03')
    insertServiceVisit('MA_25_2', uid, '2026-11-18')
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe('二次客活')
  })

  test('12.6 未完成服务单不计入到店（待客户确认）→ 0次客活', () => {
    const uid = upsertClient('MA_26', { customerType: '会员客' })
    // 当月一笔非「已完成」状态的服务单：不应计为到店
    psql(`
      INSERT INTO service_orders (
        service_order_id, store_id, client_user_id, service_date,
        status, market_name, assigned_employee_id, service_order_type, created_at, updated_at
      ) VALUES (
        '${PREFIX.SVC}MA_26', '${REAL.storeId}', '${uid}', '2026-11-08',
        '待客户确认', '${REAL.marketName.replace(/'/g, "''")}', '${REAL.employeeId}', '售前', NOW(), NOW()
      ) ON CONFLICT (service_order_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
    `)
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe('0次客活')
  })

  test('12.7 幂等：连跑两次结果一致', () => {
    const uid = upsertClient('MA_27', { customerType: '会员客' })
    insertServiceVisit('MA_27_1', uid, '2026-11-05')
    insertServiceVisit('MA_27_2', uid, '2026-11-10')
    runMonthlyActivity(REF_DATE)
    const first = getMonthlyActivity(uid)
    runMonthlyActivity(REF_DATE)
    expect(getMonthlyActivity(uid)).toBe(first)
    expect(first).toBe('二次客活')
  })

  test('12.8 cleanup', () => {
    cleanupCronE2E()
    expect(
      Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}MA_%'`)),
    ).toBe(0)
  })
})
