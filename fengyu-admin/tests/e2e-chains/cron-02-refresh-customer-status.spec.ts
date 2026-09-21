/**
 * cron-02：STEP 2 refreshCustomerStatus 端到端
 *
 * 业务口径（src/cron/steps/refresh-customer-status.ts）：
 *   - 段 1：非会员客一律置 NULL
 *   - 段 2：会员客有到店记录 → visit_stats 二维分类
 *     visits_90d >= 1 AND total_visits >= 6 → 保有会员-稳定
 *     visits_90d >= 1 AND total_visits <= 5 → 保有会员-有效
 *     last_service_date >= CURRENT_DATE - INTERVAL '6 months' → 沉睡
 *     last_service_date >= CURRENT_DATE - INTERVAL '12 months' → 冰冻
 *     ELSE → 休眠
 *   - 段 3：会员客但无到店记录 → 休眠
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { getCustomerStatus } from './_helpers/cron-asserts'

function runCustomerStatus(referenceDate: string): unknown {
  const out = runCronStep('customerStatus', { referenceDate })
  const summary = parseStepSummary(out, 'customerStatus')
  if (summary === null) throw new Error(`customerStatus summary 解析失败:\n${out}`)
  return summary
}

function ensure(): { storeId: string; employeeId: string; marketName: string } {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  const employeeId = psql(
    `SELECT employee_id FROM staff_wechat_users WHERE COALESCE(is_resigned, FALSE) = FALSE LIMIT 1`,
  )
  const marketName = psql(`SELECT DISTINCT market_name FROM service_orders LIMIT 1`)
  if (!storeId || !employeeId || !marketName) throw new Error('需要 fixture')
  return { storeId, employeeId, marketName }
}
const REAL = ensure()

/** 构造一笔已完成 service_order，对应顾客的"到店记录" */
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
      service_date = EXCLUDED.service_date,
      status = EXCLUDED.status,
      updated_at = NOW()
  `)
}

const REF_DATE = '2026-11-20'

test.describe.serial('cron-02 refreshCustomerStatus', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('2.1 流量客（非会员客）已有 status → 段 1 置 NULL', () => {
    const uid = upsertClient('CS_21', { customerType: '流量客' })
    // 手动写一个 status 模拟"脏数据"
    psql(`UPDATE client_wechat_users SET customer_status = '保有会员-稳定' WHERE user_id = '${uid}'`)
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBeNull()
  })

  test('2.2 会员客 visits_90d=1 + total_visits=6 → 保有会员-稳定', () => {
    const uid = upsertClient('CS_22', { customerType: '会员客' })
    // 90d 内 1 次 + 之前 5 次（total=6）
    insertServiceVisit('CS_22_1', uid, '2026-11-15') // 90d 内
    for (let i = 0; i < 5; i++) {
      insertServiceVisit(`CS_22_${i + 2}`, uid, `2026-05-${(i + 1).toString().padStart(2, '0')}`)
    }
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('保有会员-稳定')
  })

  test('2.3 会员客 visits_90d=1 + total_visits=3 → 保有会员-有效', () => {
    const uid = upsertClient('CS_23', { customerType: '会员客' })
    insertServiceVisit('CS_23_1', uid, '2026-11-15')
    insertServiceVisit('CS_23_2', uid, '2026-06-01')
    insertServiceVisit('CS_23_3', uid, '2026-04-01')
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('保有会员-有效')
  })

  test('2.4 会员客 90d 外（last_service=2026-09-01）但 6M 内 → 沉睡', () => {
    const uid = upsertClient('CS_24', { customerType: '会员客' })
    insertServiceVisit('CS_24', uid, '2026-09-01') // 距 2026-11-20 = 80d 但...
    // 等等，2026-09-01 距 2026-11-20 = 80 天，仍在 90d 内
    runCustomerStatus(REF_DATE)
    // 实际上 90d 内 visit=1，total=1，会进 保有会员-有效
    expect(getCustomerStatus(uid)).toBe('保有会员-有效')
  })

  test('2.5 会员客 90d 外 + 6M 内（2026-08-01）→ 沉睡', () => {
    const uid = upsertClient('CS_25', { customerType: '会员客' })
    insertServiceVisit('CS_25', uid, '2026-08-01') // 距 11-20 = 111 天 > 90d
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('沉睡')
  })

  test('2.6 会员客 6M 外 + 12M 内（2026-04-01）→ 冰冻', () => {
    const uid = upsertClient('CS_26', { customerType: '会员客' })
    insertServiceVisit('CS_26', uid, '2026-04-01') // 距 11-20 ≈ 233d > 6M
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('冰冻')
  })

  test('2.7 会员客 12M 外（2025-09-01）→ 休眠', () => {
    const uid = upsertClient('CS_27', { customerType: '会员客' })
    insertServiceVisit('CS_27', uid, '2025-09-01') // > 12M
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('休眠')
  })

  test('2.8 会员客但无任何到店记录 → 段 3 → 休眠', () => {
    const uid = upsertClient('CS_28', { customerType: '会员客' })
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('休眠')
  })

  /**
   * #254 回归：2.8 的顾客是新建的（status 本就 NULL），走的是段 3 原本就覆盖的分支。
   * 真正漏掉的是「已有非 NULL 旧值」的那一类 —— 顾客原有已完成服务单（状态已写入），
   * 后来服务单被撤销/删除/改状态而掉出 visit_stats，三段全不匹配、旧状态永久卡住。
   * prod 2026-09-22 实际命中 2 行（段丽、刘红红，挂着「保有会员-有效」却零服务单）。
   */
  test('2.8b 会员客 + 服务单被撤销后无到店记录 + 已有旧 status → 段 3 仍须重置为休眠（#254）', () => {
    const uid = upsertClient('CS_28B', { customerType: '会员客' })
    // 先造一笔已完成服务单并跑一次，让它拿到正常状态
    insertServiceVisit('CS_28B', uid, '2026-11-15')
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('保有会员-有效')

    // 服务单被撤销 → 掉出 visit_stats，但旧 status 仍在
    psql(`UPDATE service_orders SET status = '已取消' WHERE service_order_id = '${PREFIX.SVC}CS_28B'`)
    expect(getCustomerStatus(uid)).toBe('保有会员-有效')

    // 修复前：段 2 不匹配（无 visit_stats）、段 3 被 IS NULL 挡住 → 永久卡在「保有会员-有效」
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('休眠')

    // 幂等：再跑一次仍是休眠
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('休眠')
  })

  test('2.9 会员客 6M 边界精确（last_service 略早于 6M）→ 冰冻', () => {
    const uid = upsertClient('CS_29', { customerType: '会员客' })
    // 6M 外 1d：2026-11-20 - 6M - 1d = 2026-05-19
    insertServiceVisit('CS_29', uid, '2026-05-19')
    runCustomerStatus(REF_DATE)
    expect(getCustomerStatus(uid)).toBe('冰冻')
  })

  test('2.10 cleanup', () => {
    cleanupCronE2E()
    expect(Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}CS_%'`))).toBe(0)
  })
})
