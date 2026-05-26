/**
 * recalcMemberLevel 跨端 SQL 结构守卫测试
 *
 * 背景：member_level（钻石等级）原只由 admin cron 每日凌晨 3:00 重算，顾客达标后最多滞后 ~24h。
 * 2026-05-23 起改为支付结算时即时「只升不降」重算，三端各保留独立副本
 * （staffApi/utils + clientApi/utils + payNotify 根目录），禁止抽取 cloudfunctions-shared。
 *
 * 本测试做**源文件文本结构守卫**：
 *   1. 三端 utils/member-level.js 字节级完全一致（任一端漂移即失败）
 *   2. 滚动 12 月 spend 口径与 cron refresh-member-levels.ts 一致
 *      （GREATEST(received - refunded_amount) + sale_order_type IN('销售单','转换单') + INTERVAL '12 months'）
 *   3. determineMemberLevel 阈值与 db/utils/member-level.ts（口径权威）逐行一致
 *   4. 只升不降 + 150 天保级期 + 审计日志关键结构存在
 */

const fs = require('node:fs')
const path = require('node:path')

const STAFF_HELPER = path.resolve(__dirname, '../../utils/member-level.js')
const CLIENT_HELPER = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/clientApi/utils/member-level.js'
)
const PAYNOTIFY_HELPER = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/payNotify/member-level.js'
)
const CRON_TS = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/cron/steps/refresh-member-levels.ts'
)
const DB_UTIL_TS = path.resolve(
  __dirname,
  '../../../../../db/utils/member-level.ts'
)

const read = (p) => fs.readFileSync(p, 'utf8')
const norm = (s) => s.replace(/\s+/g, ' ').trim()

/** 提取 determineMemberLevel 的 5 行阈值判定（归一化后比对） */
function extractThresholdLogic(src) {
  const m = src.match(/if \(spend >= 100000\)[\s\S]*?return null/m)
  if (!m) throw new Error('未找到 determineMemberLevel 阈值段')
  return norm(m[0])
}

describe('recalcMemberLevel 跨端 SQL 守卫', () => {
  const staff = read(STAFF_HELPER)
  const client = read(CLIENT_HELPER)
  const paynotify = read(PAYNOTIFY_HELPER)
  const cron = read(CRON_TS)
  const dbUtil = read(DB_UTIL_TS)

  test('三端 member-level.js 字节级完全一致', () => {
    expect(client).toBe(staff)
    expect(paynotify).toBe(staff)
  })

  describe('滚动 12 月 spend 口径与 cron 一致', () => {
    test('helper 含 GREATEST(received - refunded_amount) 净额表达式', () => {
      expect(staff).toContain(
        'GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)'
      )
    })
    test('helper 仅纳入 销售单 + 转换单', () => {
      expect(staff).toContain("so.sale_order_type IN ('销售单','转换单')")
    })
    test('helper 限定滚动 12 个月', () => {
      expect(staff).toContain("INTERVAL '12 months'")
    })
    test('cron 与 helper 用相同净额表达式（防口径漂移）', () => {
      expect(cron).toContain(
        'GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)'
      )
      expect(cron).toContain("so.sale_order_type IN ('销售单','转换单')")
      expect(cron).toContain("INTERVAL '12 months'")
    })
  })

  describe('determineMemberLevel 阈值与 db/utils/member-level.ts 一致', () => {
    test('helper 阈值段与 TS 权威逐行一致（归一化后）', () => {
      expect(extractThresholdLogic(staff)).toBe(extractThresholdLogic(dbUtil))
    })
    test('五档阈值字面量齐全', () => {
      for (const lit of ['100000', '60000', '30000', '10000']) {
        expect(staff).toContain(lit)
      }
      for (const lvl of ['黑钻', '金钻', '粉钻', '星钻', '初钻']) {
        expect(staff).toContain(lvl)
      }
    })
  })

  describe('只升不降 + 保级期 + 审计日志', () => {
    test('只升不降守卫存在', () => {
      expect(staff).toContain('if (rank(newLevel) <= rank(oldLevel)) return')
    })
    test('升级写 150 天保级期', () => {
      expect(staff).toContain("INTERVAL '150 days'")
    })
    test('只发审计日志，不发礼包（礼包留给 cron）', () => {
      expect(staff).toContain("'customer.memberLevelChange'")
      // 不调用 grantUpgradeBenefits、不写礼包三件套（消息/积分/优惠券）—— 礼包仅由 cron 幂等发放
      expect(staff).not.toContain('grantUpgradeBenefits(')
      expect(staff).not.toContain('INSERT INTO point_transactions')
      expect(staff).not.toContain('INSERT INTO user_coupons')
      expect(staff).not.toContain('INSERT INTO messages')
    })
  })

  describe('cron 支付升级后幂等补发礼包', () => {
    test('cron 在 newLevel===oldLevel 分支对近期升级用户补发', () => {
      expect(cron).toContain('wasRecentlyUpgraded')
      expect(cron).toContain('member_level_upgraded_at')
    })
  })
})
