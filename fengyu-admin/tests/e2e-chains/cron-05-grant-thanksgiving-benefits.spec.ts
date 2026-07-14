/**
 * cron-05：STEP 5 grantThanksgivingBenefits 端到端
 *
 * 核心验证：
 *   - day20 短路（非 20 号直接返回 skippedNotDay20=true）
 *   - 当日完成服务 + 会员客 → 三件套发放
 *   - 优惠券硬有效期 10 天（忽略 coupon_templates.validity_mode/days）
 *   - 月度幂等键 thx-{YYYY-MM}-* 防止月内重发
 *   - status IN ('已完成','服务中') 都触发
 *   - client_user_id=NULL / member_level=NULL 跳过
 *
 * 注：service_orders 是 cron 扫描源，需要构造 store + 顾客 + 服务单
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { backupAndSetConfig, restoreAllConfigs } from './_helpers/cron-config'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import {
  countMessagesByKey,
  countPointTransactionsByRef,
  countUserCouponsByPrefix,
  listUserCouponsByPrefix,
  getPointsBalance,
} from './_helpers/cron-asserts'

interface ThxResult {
  total: number
  sentCount: number
  skippedNoConfig: number
  errorCount: number
  skippedNotDay20?: boolean
}

function runThx(referenceDate: string): ThxResult {
  const out = runCronStep('thanksgiving', { referenceDate })
  const summary = parseStepSummary<ThxResult>(out, 'thanksgiving')
  if (!summary) throw new Error(`thanksgiving STEP summary 解析失败:\n${out}`)
  return summary
}

/** 找一对测试用 store + employee（取已有真实数据，避免 FK 构造开销） */
function ensureTestStoreAndEmployee(): { storeId: string; marketName: string; employeeId: string } {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  if (!storeId) throw new Error('需要至少 1 个 stores 行作为前置')
  const marketName = psql(`SELECT DISTINCT market_name FROM service_orders LIMIT 1`)
  if (!marketName) throw new Error('需要至少 1 个 service_orders.market_name 作为前置')
  const employeeId = psql(
    `SELECT employee_id FROM staff_wechat_users WHERE COALESCE(is_resigned, FALSE) = FALSE LIMIT 1`,
  )
  if (!employeeId) throw new Error('需要至少 1 个在职 staff_wechat_users 作为前置')
  return { storeId, marketName, employeeId }
}

const REAL = ensureTestStoreAndEmployee()
const STORE_ID = REAL.storeId

function insertServiceOrder(opt: {
  suffix: string
  storeId: string
  clientUserId: string | null
  serviceDate: string // 'YYYY-MM-DD'
  status: '已完成' | '服务中' | '待服务' | '已取消'
}): string {
  const soid = `${PREFIX.SVC}${opt.suffix}`
  const clientCol = opt.clientUserId === null ? 'NULL' : `'${opt.clientUserId}'`
  psql(`
    INSERT INTO service_orders (
      service_order_id, store_id, client_user_id, service_date,
      status, market_name, assigned_employee_id, service_order_type,
      created_at, updated_at
    )
    VALUES (
      '${soid}', '${opt.storeId}', ${clientCol}, '${opt.serviceDate}',
      '${opt.status}', '${REAL.marketName.replace(/'/g, "''")}', '${REAL.employeeId}', '售前',
      NOW(), NOW()
    )
    ON CONFLICT (service_order_id) DO UPDATE SET
      service_date = EXCLUDED.service_date,
      status = EXCLUDED.status,
      updated_at = NOW()
  `)
  return soid
}

test.describe.serial('cron-05 grantThanksgivingBenefits', () => {
  test.beforeAll(() => {
    cleanupCronE2E()
    // 注入感恩日权益配置（10 天硬有效期断言依赖此模板）
    backupAndSetConfig('thanksgiving_benefits', {
      星钻: {
        points: 300,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'], // validity_mode=days, valid_days=90 → 但 thx 硬约束 10 天
        messageTitle: '【凤御美业】感恩日',
        messageBody: 'thanksgiving e2e',
      },
    })
  })

  test.afterAll(() => {
    restoreAllConfigs()
    cleanupCronE2E()
  })

  test('5.1 非 20 号短路返回 skippedNotDay20=true，0 写入', () => {
    const uid = upsertClient('THX_51', {
      customerType: '会员客',
      memberLevel: '星钻',
    })
    insertServiceOrder({
      suffix: 'THX_51',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-11-19',
      status: '已完成',
    })
    const result = runThx('2026-11-19')
    expect(result.skippedNotDay20).toBe(true)
    expect(result.total).toBe(0)
    expect(result.sentCount).toBe(0)
    expect(countMessagesByKey(`thx-msg-2026-11-${uid}`)).toBe(0)
  })

  test('5.2 20 号当日服务+会员 → 三件套 + 券 valid_to=referenceDate+10天', () => {
    const uid = upsertClient('THX_52', {
      customerType: '会员客',
      memberLevel: '星钻',
      pointsBalance: 50,
    })
    insertServiceOrder({
      suffix: 'THX_52',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-11-20',
      status: '已完成',
    })
    const result = runThx('2026-11-20')
    expect(result.skippedNotDay20).toBeFalsy()
    expect(result.sentCount).toBeGreaterThanOrEqual(1)
    expect(result.errorCount).toBe(0)

    // 数值精确：消息 1 / 积分 +300（balance 50→350）/ 券 1 张
    expect(countMessagesByKey(`thx-msg-2026-11-${uid}`)).toBe(1)
    expect(countPointTransactionsByRef(`thx-pts-2026-11-${uid}`)).toBe(1)
    expect(getPointsBalance(uid)).toBe(350)
    expect(countUserCouponsByPrefix(`thx-2026-11-${uid}-`)).toBe(1)

    // 券有效期硬约束 10 天
    // referenceDate=2026-11-20 03:00 +0800 = 2026-11-19 19:00 UTC
    // +10d = 2026-11-29 19:00 UTC = 2026-11-30 03:00 +08（migration 0076 后 expire_at 为 timestamptz；
    // listUserCouponsByPrefix 的 expire_at::text 按 session TZ Asia/Shanghai 显示，slice 取 +08 日历日）
    const coupons = listUserCouponsByPrefix(`thx-2026-11-${uid}-`)
    expect(coupons[0].expire_at.slice(0, 10)).toBe('2026-11-30')
    expect(coupons[0].template_id).toBe('FY-FIX-CT-DISCOUNT')
  })

  test('5.3 月度幂等：同月二次跑 → 0 新增（thx-{YYYY-MM} 键冲突）', () => {
    // 接续 5.2 的数据；再跑一次 11-20
    runThx('2026-11-20')
    const result2 = runThx('2026-11-20')
    expect(result2.errorCount).toBe(0)
    // 5.2 的 uid 仍然只有 1 条消息、1 张券
    const msgRow = psql(
      `SELECT COUNT(*) FROM messages WHERE idempotency_key LIKE 'thx-msg-2026-11-${PREFIX.CLIENT}THX_52'`,
    )
    expect(Number(msgRow)).toBe(1)
    const ptRow = psql(
      `SELECT COUNT(*) FROM point_transactions WHERE external_ref LIKE 'thx-pts-2026-11-${PREFIX.CLIENT}THX_52'`,
    )
    expect(Number(ptRow)).toBe(1)
    expect(countUserCouponsByPrefix(`thx-2026-11-${PREFIX.CLIENT}THX_52-`)).toBe(1)
  })

  test('5.4 跨月再发（2026-12-20 同顾客 12 月服务）', () => {
    const uid = PREFIX.CLIENT + 'THX_52'
    // 12 月 20 号当日服务单
    insertServiceOrder({
      suffix: 'THX_52_DEC',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-12-20',
      status: '已完成',
    })
    const result = runThx('2026-12-20')
    expect(result.sentCount).toBeGreaterThanOrEqual(1)
    expect(result.errorCount).toBe(0)
    // 12 月幂等键 thx-{2026-12}-uid 应有 1 张券（与 11 月独立）
    expect(countUserCouponsByPrefix(`thx-2026-12-${uid}-`)).toBe(1)
    expect(countMessagesByKey(`thx-msg-2026-12-${uid}`)).toBe(1)
  })

  test("5.5 status='服务中' 也发放（IN 子句包含）", () => {
    const uid = upsertClient('THX_55', {
      customerType: '会员客',
      memberLevel: '星钻',
    })
    insertServiceOrder({
      suffix: 'THX_55',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-11-20',
      status: '服务中',
    })
    const result = runThx('2026-11-20')
    expect(result.errorCount).toBe(0)
    expect(countMessagesByKey(`thx-msg-2026-11-${uid}`)).toBe(1)
  })

  test('5.6 非当日服务（service_date=2026-11-19 + 跑 11-20）→ 跳过该顾客', () => {
    const uid = upsertClient('THX_56', {
      customerType: '会员客',
      memberLevel: '星钻',
    })
    insertServiceOrder({
      suffix: 'THX_56',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-11-19', // 不是 20 号
      status: '已完成',
    })
    runThx('2026-11-20')
    expect(countMessagesByKey(`thx-msg-2026-11-${uid}`)).toBe(0)
  })

  test('5.7 券有效期不读 validity_mode/days（即使模板 days=90 也是 10 天）', () => {
    const uid = PREFIX.CLIENT + 'THX_52'
    // 已在 5.2 测过，这里追加显式断言：FY-FIX-CT-DISCOUNT.valid_days=90，但 thx 强制 10 天
    const out = psql(`SELECT valid_days FROM coupon_templates WHERE template_id = 'FY-FIX-CT-DISCOUNT'`)
    expect(Number(out)).toBe(90) // 模板确实是 90
    const coupons = listUserCouponsByPrefix(`thx-2026-11-${uid}-`)
    expect(coupons.length).toBe(1)
    // expire 距 11-20 应为 10 天而非 90
    const expireDate = new Date(coupons[0].expire_at + 'Z')
    const issued = new Date('2026-11-19T19:00:00Z') // referenceDate UTC
    const daysDiff = Math.round((expireDate.getTime() - issued.getTime()) / 86400000)
    expect(daysDiff).toBe(10)
  })

  test('5.8 client_user_id=NULL 的服务单 → 跳过（不出现在循环中）', () => {
    insertServiceOrder({
      suffix: 'THX_58',
      storeId: STORE_ID,
      clientUserId: null,
      serviceDate: '2026-11-20',
      status: '已完成',
    })
    const result = runThx('2026-11-20')
    expect(result.errorCount).toBe(0)
    // SQL JOIN 自动排除 client_user_id=NULL，所以该 service_order 不进入循环
  })

  test('5.9 顾客 member_level=NULL → 跳过', () => {
    const uid = upsertClient('THX_59', {
      customerType: '会员客',
      memberLevel: null,
    })
    insertServiceOrder({
      suffix: 'THX_59',
      storeId: STORE_ID,
      clientUserId: uid,
      serviceDate: '2026-11-20',
      status: '已完成',
    })
    runThx('2026-11-20')
    expect(countMessagesByKey(`thx-msg-2026-11-${uid}`)).toBe(0)
  })

  test('cleanup 后置 sanity', () => {
    cleanupCronE2E()
    expect(
      Number(
        psql(
          `SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}THX_%'`,
        ),
      ),
    ).toBe(0)
  })
})
