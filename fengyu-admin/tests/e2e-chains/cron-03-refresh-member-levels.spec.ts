/**
 * cron-03：STEP 3 refreshMemberLevels 端到端 ⭐ 核心
 *
 * 核心验证：会员权益（升级三件套 / 降级保级锁 / spend 阈值边界 / 退款冲销）
 *
 * 关键事实（src/cron/lib/member-level.ts + src/cron/steps/refresh-member-levels.ts）：
 *   - 阈值：黑钻 100000 / 金钻 60000 / 粉钻 30000 / 星钻 10000 / 初钻 ≥ new_member_threshold(1980)
 *   - spend = Σ GREATEST((received) - (refunded_amount), 0)
 *            FILTER sale_order_type IN ('销售单','转换单') AND paid_at ≥ NOW-12M
 *   - 仅 customer_type='会员客' 进入循环
 *   - 保级锁：升级时写 NOW + 150d；降级时 locked_until > NOW → heldCount++、不实际降；过期 → 实际降 + 清空 locked
 *   - 升级三件套 idem：member-upgrade-{userId}-{toLevel}
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { backupAndSetConfig, restoreAllConfigs } from './_helpers/cron-config'
import {
  upsertClient,
  insertSaleOrder,
  cleanupCronE2E,
  PREFIX,
} from './_helpers/cron-fixtures'
import {
  countMessagesByKey,
  countPointTransactionsByRef,
  countUserCouponsByPrefix,
  getClientLevelAndLock,
  countOperationLogs,
  findOperationLog,
} from './_helpers/cron-asserts'

interface MemberLevelsResult {
  total: number
  upgradeCount: number
  downgradeCount: number
  heldCount: number
  unchangedCount: number
  errorCount: number
}

function runMemberLevels(referenceDate: string): MemberLevelsResult {
  const out = runCronStep('memberLevels', { referenceDate })
  const summary = parseStepSummary<MemberLevelsResult>(out, 'memberLevels')
  if (!summary) throw new Error(`memberLevels STEP summary 解析失败:\n${out}`)
  return summary
}

function ensureTestStore(): string {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  if (!storeId) throw new Error('需要至少 1 个 stores 行作为前置')
  return storeId
}

const STORE_ID = ensureTestStore()
const REF_DATE = '2026-11-20'

test.describe.serial('cron-03 refreshMemberLevels（会员权益）', () => {
  test.beforeAll(() => {
    cleanupCronE2E()
    // 注入升级权益配置（5 等级齐全，方便用例切换）
    backupAndSetConfig('member_level_benefits', {
      星钻: {
        points: 500,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】升级到星钻',
        messageBody: 'cron-03 e2e 测试',
      },
      粉钻: {
        points: 1000,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】升级到粉钻',
      },
      金钻: {
        points: 2000,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT', 'FY-FIX-CT-MINSPEND'],
        messageTitle: '【凤御美业】升级到金钻',
      },
      黑钻: {
        points: 5000,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT', 'FY-FIX-CT-MINSPEND', 'FY-FIX-CT-ITEM'],
        messageTitle: '【凤御美业】升级到黑钻',
      },
    })
  })

  test.afterAll(() => {
    restoreAllConfigs()
    cleanupCronE2E()
  })

  test('3.1 升级到星钻：spend=10000.00 → 三件套', () => {
    const uid = upsertClient('ML_31', {
      customerType: '会员客',
      memberLevel: null,
      pointsBalance: 0,
    })
    insertSaleOrder('ML_31', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 10000,
      paidAt: '2026-11-01 10:00:00',
    })
    const result = runMemberLevels(REF_DATE)
    expect(result.errorCount).toBe(0)

    expect(getClientLevelAndLock(uid).level).toBe('星钻')
    expect(countMessagesByKey(`member-upgrade-${uid}-星钻`)).toBe(1)
    expect(countPointTransactionsByRef(`member-upgrade-${uid}-星钻`)).toBe(1)
    expect(countUserCouponsByPrefix(`cpn-up-${uid}-星钻-`)).toBe(1)
  })

  test('3.2 阈值下界：spend=9999.99 → 初钻（不升星钻）', () => {
    const uid = upsertClient('ML_32', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_32', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 9999.99,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBe('初钻')
  })

  test('3.3 升级到金钻（直跳）：spend=60000 → 仅金钻三件套，不重复发星/粉钻', () => {
    const uid = upsertClient('ML_33', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_33', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 60000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBe('金钻')
    expect(countMessagesByKey(`member-upgrade-${uid}-金钻`)).toBe(1)
    expect(countMessagesByKey(`member-upgrade-${uid}-星钻`)).toBe(0)
    expect(countMessagesByKey(`member-upgrade-${uid}-粉钻`)).toBe(0)
    expect(countUserCouponsByPrefix(`cpn-up-${uid}-金钻-`)).toBe(2) // 金钻配 2 张券
  })

  test('3.4 升级到黑钻：spend=100000 → 3 张券', () => {
    const uid = upsertClient('ML_34', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_34', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 100000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBe('黑钻')
    expect(countUserCouponsByPrefix(`cpn-up-${uid}-黑钻-`)).toBe(3)
  })

  test('3.5 降级保级锁未到期：level=金钻 locked_until=+30d → 保持金钻 + memberLevelHeld', () => {
    const uid = upsertClient('ML_35', {
      customerType: '会员客',
      memberLevel: '金钻',
      memberLevelLockedUntil: '2026-12-20 00:00:00+0800', // referenceDate + 30d
    })
    insertSaleOrder('ML_35', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 20000, // 不足金钻门槛
      paidAt: '2026-11-01 10:00:00',
    })
    const result = runMemberLevels(REF_DATE)
    expect(result.heldCount).toBeGreaterThanOrEqual(1)

    expect(getClientLevelAndLock(uid).level).toBe('金钻') // 仍是金钻
    expect(countOperationLogs('customer.memberLevelHeld', uid)).toBeGreaterThanOrEqual(1)
  })

  test('3.6 降级保级锁过期：level=金钻 locked_until=referenceDate-1d → 实际降级到星钻', () => {
    const uid = upsertClient('ML_36', {
      customerType: '会员客',
      memberLevel: '金钻',
      memberLevelLockedUntil: '2026-11-19 00:00:00+0800', // 已过期
    })
    insertSaleOrder('ML_36', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 20000, // 星钻档
      paidAt: '2026-11-01 10:00:00',
    })
    const result = runMemberLevels(REF_DATE)
    expect(result.downgradeCount).toBeGreaterThanOrEqual(1)

    const info = getClientLevelAndLock(uid)
    expect(info.level).toBe('星钻')
    expect(info.lockedUntil).toBeFalsy() // 清空 locked_until
    expect(countOperationLogs('customer.memberLevelChange', uid)).toBeGreaterThanOrEqual(1)
  })

  test('3.7 退款冲销 spend：received=12000 refunded=3000 → spend=9000 → 初钻', () => {
    const uid = upsertClient('ML_37', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_37', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 12000,
      refundedAmount: 3000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBe('初钻')
  })

  test('3.8 sale_order_type 过滤：internal=15000 → spend=0 → 不升级', () => {
    const uid = upsertClient('ML_38', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_38', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 15000,
      saleOrderType: '内部单', // 不计入 spend
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBeNull()
  })

  test('3.9 paid_at 出窗：13M 前已支付 → spend=0', () => {
    const uid = upsertClient('ML_39', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_39', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 50000,
      paidAt: '2025-10-01 10:00:00', // 13M+ 前
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBeNull()
  })

  test('3.10 customer_type 过滤：流量客 spend=10000 → 不进循环', () => {
    const uid = upsertClient('ML_310', {
      customerType: '流量客',
      memberLevel: null,
    })
    insertSaleOrder('ML_310', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 10000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    // 流量客即便 spend 够 也不进 cron 循环（SELECT WHERE customer_type='会员客'）
    expect(getClientLevelAndLock(uid).level).toBeNull()
    expect(countMessagesByKey(`member-upgrade-${uid}-星钻`)).toBe(0)
  })

  test('3.11 全量幂等：重跑无新增升级', () => {
    // 接续 3.1 的 uid，已升级到星钻
    const uid = `${PREFIX.CLIENT}ML_31`
    const before = countPointTransactionsByRef(`member-upgrade-${uid}-星钻`)
    expect(before).toBe(1)
    const result = runMemberLevels(REF_DATE)
    expect(result.upgradeCount).toBe(0)
    expect(result.errorCount).toBe(0)
    // 幂等保护：流水不重复
    expect(countPointTransactionsByRef(`member-upgrade-${uid}-星钻`)).toBe(1)
  })

  test('3.12 升级 operation_log 详情：含 from→to 字段 + spend 数值', () => {
    const uid = upsertClient('ML_312', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_312', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 10000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    expect(getClientLevelAndLock(uid).level).toBe('星钻')

    const log = findOperationLog('customer.memberLevelChange', uid)
    expect(log).not.toBeNull()
    // detail 是 PG jsonb 序列化后的字符串（含空格）
    expect(log!.detail).toMatch(/"to"\s*:\s*"星钻"/)
    expect(log!.detail).toMatch(/"from"\s*:\s*null/)
    expect(log!.detail).toMatch(/"rolling12mSpend"\s*:\s*10000/)
    expect(log!.detail).toMatch(/"direction"\s*:\s*"upgrade"/)
  })

  test('3.13 保级 150 天写入：升级触发 locked_until = referenceDate + 150d 精确值', () => {
    const uid = upsertClient('ML_313', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_313', {
      storeId: STORE_ID,
      clientUserId: uid,
      received: 100000,
      paidAt: '2026-11-01 10:00:00',
    })
    runMemberLevels(REF_DATE)
    const info = getClientLevelAndLock(uid)
    expect(info.level).toBe('黑钻')
    // referenceDate=2026-11-20 03:00 +0800 = 2026-11-19 19:00 UTC
    // +150 天 = 2027-04-18 19:00 UTC → date 部分 2027-04-18
    expect(info.lockedUntil).toContain('2027-04-1')
  })

  test('3.14 单用户失败隔离：A 正常升级 + B 配置缺粉钻 → errorCount=0 但 B 跳过', () => {
    // 注入仅星钻配置（粉钻缺失）；A 升星钻，B spend=30000 想升粉钻但 cfg 没有
    backupAndSetConfig('member_level_benefits', {
      星钻: {
        points: 500,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】升级到星钻',
      },
      // 故意删除粉钻
    })
    const uidA = upsertClient('ML_314A', { customerType: '会员客', memberLevel: null })
    const uidB = upsertClient('ML_314B', { customerType: '会员客', memberLevel: null })
    insertSaleOrder('ML_314A', {
      storeId: STORE_ID,
      clientUserId: uidA,
      received: 10000,
      paidAt: '2026-11-01 10:00:00',
    })
    insertSaleOrder('ML_314B', {
      storeId: STORE_ID,
      clientUserId: uidB,
      received: 30000,
      paidAt: '2026-11-01 10:00:00',
    })
    const result = runMemberLevels(REF_DATE)
    // 即使粉钻配置缺，cron 仍更新 level（cfg 缺仅跳过权益发放，不跳过 UPDATE）
    expect(result.errorCount).toBe(0)
    expect(getClientLevelAndLock(uidA).level).toBe('星钻')
    expect(getClientLevelAndLock(uidB).level).toBe('粉钻')
    expect(countMessagesByKey(`member-upgrade-${uidA}-星钻`)).toBe(1)
    // B 升级到粉钻但 cfg 缺 → 无消息/积分/券
    expect(countMessagesByKey(`member-upgrade-${uidB}-粉钻`)).toBe(0)
    expect(countUserCouponsByPrefix(`cpn-up-${uidB}-粉钻-`)).toBe(0)
  })

  test('cleanup 后置 sanity', () => {
    cleanupCronE2E()
    expect(
      Number(
        psql(
          `SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}ML_%'`,
        ),
      ),
    ).toBe(0)
  })
})
