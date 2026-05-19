/**
 * cron-04：STEP 4 grantBirthdayBenefits 端到端
 *
 * 验证矩阵（参考 plan §cron-04）：
 *   4.1  三件套数值精确（积分/券/消息）
 *   4.2  闰年 2/29 非闰年跳过
 *   4.3  闰年 2/29 命中（2028 闰年）
 *   4.4  同日重跑幂等
 *   4.5  跨年再发（YYYY 年度键）
 *   4.6  member_level=NULL 跳过
 *   4.7  配置整体缺失 → 早退
 *   4.8  配置无该等级 → skippedNoConfig
 *   4.9  messageTitle 缺失 → 不发消息
 *   4.10 用户隔离：A 正常 + B 错误 templateId
 *
 * 数据控制：
 *   - 顾客命名空间：CRON_E2E_CLI_BDAY_*
 *   - referenceDate=2026-11-20 注入（PG NOW/CURRENT_DATE 来源）
 *   - system_configs.birthday_benefits 用 backup/inject/restore 模式
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import {
  backupAndSetConfig,
  backupAndDeleteConfig,
  restoreAllConfigs,
} from './_helpers/cron-config'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import {
  countMessagesByKey,
  countPointTransactionsByRef,
  countUserCouponsByPrefix,
  listUserCouponsByPrefix,
  getPointsBalance,
} from './_helpers/cron-asserts'

const REF_DATE = '2026-11-20'
const REF_YEAR = 2026

interface BirthdayResult {
  total: number
  sentCount: number
  skippedNoConfig: number
  errorCount: number
}

function runBirthday(referenceDate = REF_DATE): BirthdayResult {
  const out = runCronStep('birthday', { referenceDate })
  const summary = parseStepSummary<BirthdayResult>(out, 'birthday')
  if (!summary) throw new Error(`birthday STEP summary 解析失败:\n${out}`)
  return summary
}

test.describe.serial('cron-04 grantBirthdayBenefits', () => {
  test.beforeAll(() => {
    cleanupCronE2E()
  })

  test.afterAll(() => {
    restoreAllConfigs()
    cleanupCronE2E()
  })

  test('4.1 三件套数值精确（200 积分 + 1 张券 + 1 条消息）', () => {
    const uid = upsertClient('BDAY_41', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
      pointsBalance: 100,
    })
    backupAndSetConfig('birthday_benefits', {
      星钻: {
        points: 200,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】生日快乐',
        messageBody: '感谢您的支持，送上生日礼券',
      },
    })

    const result = runBirthday()
    expect(result.sentCount).toBeGreaterThanOrEqual(1)
    expect(result.errorCount).toBe(0)

    // 消息 1 条
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(1)
    // 积分流水 +200，余额从 100 → 300
    expect(countPointTransactionsByRef(`birthday-pts-${REF_YEAR}-${uid}`)).toBe(1)
    expect(getPointsBalance(uid)).toBe(300)
    // 优惠券 1 张，coupon_id 精确匹配
    expect(countUserCouponsByPrefix(`bday-${REF_YEAR}-${uid}-`)).toBe(1)
    const coupons = listUserCouponsByPrefix(`bday-${REF_YEAR}-${uid}-`)
    expect(coupons[0].template_id).toBe('FY-FIX-CT-DISCOUNT')
    expect(coupons[0].user_id).toBe(uid)
    expect(coupons[0].status).toBe('未使用')
    // 有效期：FY-FIX-CT-DISCOUNT 是 days=90 模板，referenceDate=2026-11-20 → expire 应为 2027-02-18
    const expireYmd = coupons[0].expire_at.slice(0, 10)
    expect(expireYmd).toBe('2027-02-18')
  })

  test('4.2 闰年 2/29 非闰年（2026-02-28）→ 跳过', () => {
    // 注意：4.1 的 uid 已存在并已收到 11-20 生日礼。这里换 birthday 到 2/29，cron 跑 02-28 应不命中
    const uid = upsertClient('BDAY_42', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1992-02-29',
    })
    // 沿用 4.1 的配置（星钻）
    const before = countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)
    runBirthday('2026-02-28')
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(before) // 无新增
  })

  test('4.3 闰年 2/29 命中（2028-02-29）→ 发放', () => {
    const uid = upsertClient('BDAY_43', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1992-02-29',
    })
    const result = runBirthday('2028-02-29')
    expect(result.sentCount).toBeGreaterThanOrEqual(1)
    expect(countMessagesByKey(`birthday-msg-2028-${uid}`)).toBe(1)
  })

  test('4.4 同日重跑幂等（2026-11-20 二次跑 → 0 新增）', () => {
    const uid = upsertClient('BDAY_44', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
    })
    runBirthday() // 第一次
    const msg1 = countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)
    const pt1 = countPointTransactionsByRef(`birthday-pts-${REF_YEAR}-${uid}`)
    const cp1 = countUserCouponsByPrefix(`bday-${REF_YEAR}-${uid}-`)
    expect(msg1).toBe(1)
    expect(pt1).toBe(1)
    expect(cp1).toBe(1)

    runBirthday() // 第二次
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(1)
    expect(countPointTransactionsByRef(`birthday-pts-${REF_YEAR}-${uid}`)).toBe(1)
    expect(countUserCouponsByPrefix(`bday-${REF_YEAR}-${uid}-`)).toBe(1)
  })

  test('4.5 跨年再发（2027-11-20）→ 年度键 YYYY=2027 重新发放', () => {
    const uid = upsertClient('BDAY_45', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
    })
    runBirthday('2026-11-20')
    expect(countMessagesByKey(`birthday-msg-2026-${uid}`)).toBe(1)

    runBirthday('2027-11-20')
    expect(countMessagesByKey(`birthday-msg-2026-${uid}`)).toBe(1) // 2026 不动
    expect(countMessagesByKey(`birthday-msg-2027-${uid}`)).toBe(1) // 2027 新增
  })

  test('4.6 member_level=NULL → 跳过', () => {
    const uid = upsertClient('BDAY_46', {
      customerType: '会员客',
      memberLevel: null,
      birthday: '1990-11-20',
    })
    runBirthday()
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(0)
  })

  test('4.7 配置整体缺失 → 早退 total=0', () => {
    upsertClient('BDAY_47', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
    })
    backupAndDeleteConfig('birthday_benefits')
    const result = runBirthday()
    expect(result.total).toBe(0)
    expect(result.sentCount).toBe(0)
    expect(result.errorCount).toBe(0)

    // 还原配置给后续 test 用
    backupAndSetConfig('birthday_benefits', {
      星钻: {
        points: 200,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】生日快乐',
      },
    })
  })

  test('4.8 配置无该等级（顾客是黑钻，配置只有星钻）→ skippedNoConfig', () => {
    const uid = upsertClient('BDAY_48', {
      customerType: '会员客',
      memberLevel: '黑钻',
      birthday: '1990-11-20',
    })
    const result = runBirthday()
    expect(result.skippedNoConfig).toBeGreaterThanOrEqual(1)
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(0)
  })

  test('4.9 messageTitle 缺失 → 不发消息（但发积分和券）', () => {
    backupAndSetConfig('birthday_benefits', {
      星钻: {
        points: 200,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        // 故意不设 messageTitle
      },
    })
    const uid = upsertClient('BDAY_49', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
    })
    const result = runBirthday()
    expect(result.sentCount).toBeGreaterThanOrEqual(1)
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uid}`)).toBe(0) // 0 消息
    expect(countPointTransactionsByRef(`birthday-pts-${REF_YEAR}-${uid}`)).toBe(1) // 1 积分流水
    expect(countUserCouponsByPrefix(`bday-${REF_YEAR}-${uid}-`)).toBe(1) // 1 券
  })

  test('4.10 用户隔离：A 正常 + B 不存在 templateId → A 成功 B 跳过', () => {
    backupAndSetConfig('birthday_benefits', {
      星钻: {
        points: 200,
        couponTemplateIds: ['FY-FIX-CT-DISCOUNT'],
        messageTitle: '【凤御美业】生日快乐',
      },
      粉钻: {
        points: 500,
        couponTemplateIds: ['NONEXISTENT_TEMPLATE_ID'], // 模板不存在，循环内 warn 跳过
        messageTitle: '【凤御美业】生日快乐（粉钻）',
      },
    })
    const uidA = upsertClient('BDAY_4A0', {
      customerType: '会员客',
      memberLevel: '星钻',
      birthday: '1990-11-20',
    })
    const uidB = upsertClient('BDAY_4B0', {
      customerType: '会员客',
      memberLevel: '粉钻',
      birthday: '1990-11-20',
    })
    const result = runBirthday()
    expect(result.sentCount).toBeGreaterThanOrEqual(2) // A + B 都进 sentCount（B 仅消息+积分发，券 warn 跳过）
    expect(result.errorCount).toBe(0)
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uidA}`)).toBe(1)
    expect(countMessagesByKey(`birthday-msg-${REF_YEAR}-${uidB}`)).toBe(1)
    // B 的券因为模板不存在被跳过，0 张券
    expect(countUserCouponsByPrefix(`bday-${REF_YEAR}-${uidB}-`)).toBe(0)
  })

  // 防止前面用例的残留干扰外部其他 cron e2e
  test('cleanup 后置 sanity', () => {
    cleanupCronE2E()
    expect(
      Number(
        psql(
          `SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}BDAY_%'`,
        ),
      ),
    ).toBe(0)
  })
})
