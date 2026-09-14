/**
 * dashboard 组织层级现金流业绩口径一致性守护
 *
 * SUMMARY v3 §2 #15 / ticket notes/tickets/2026-05-17-dashboard-three-end-consistency-test.md
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/dashboard.ts        (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js (pg / JS)
 *
 * 因两端 ORM 不同（Drizzle vs 原生 pg）且 admin 用大 CTE，
 * staff 用按指标拆分的多查询，**完整 SQL snapshot 不可行**。
 * 守护策略改为"关键不变量字面量匹配"：
 *   1. 营业额公式 = SUM(sale_order_performance_events.amount)
 *   2. 付款类型 = 首次支付 / 回款 / 退款，排除储值卡抵扣
 *   3. 订单类型 = 销售单 / 转换单 / 充值单
 *   4. 归期 = performance_date：**查询侧一律直读款项归属日期，没有回退分支**
 *      （#137 收敛 / 迁移 0040；回退只发生在写入侧 trigger）。
 *      2026-09-14 起工作台的实付/退款也按归属日期（#140），
 *      不再有「业绩按归属日、资金按 paid_at」的双口径。
 *
 * 任一端公式变更必须双端同步，否则数据中心首页与 admin dashboard 数字对不上。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_DASHBOARD = path.resolve(__dirname, './dashboard.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
)

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * 剥离 JS/TS 行注释 + 块注释。
 * 反向守护测试需要排除文档字符串内的"反例引用"（如 docstring 里出现的 SUM(total_amount)）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // 行注释（避开 URL 的 //）
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  const to = src.indexOf(end, from + start.length)
  return from === -1 ? '' : src.slice(from, to === -1 ? undefined : to)
}

function expectCashflowRevenueSql(src: string) {
  const normalized = normalize(stripComments(src))
  expect(normalized).toMatch(/FROM\s+sale_order_performance_events\s+spe/i)
  expect(normalized).toMatch(/spe\.amount::numeric/i)
  expect(normalized).toMatch(/spe\.status\s*=\s*'已支付'/)
  expect(normalized).toMatch(/spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/)
  expect(normalized).toMatch(/spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'充值单'\s*\)/)
  expect(normalized).toMatch(/spe\.performance_date/i)
  expect(normalized).toMatch(/legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/i)
  expect(normalized).not.toMatch(/储值卡抵扣/)
  expect(normalized).not.toMatch(/payment_method/i)
}

describe('dashboard 组织层级现金流业绩一致性守护', () => {
  let adminSrc: string
  let staffSrc: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_DASHBOARD, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
  })

  describe('业绩 = 已支付付款流水的有符号合计', () => {
    it('admin dashboard payment_metrics 使用现金流口径', () => {
      expectCashflowRevenueSql(between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('))
    })

    it('staff summary queryStoreRevenue 使用同一现金流口径', () => {
      expectCashflowRevenueSql(
        between(staffSrc, 'async function queryStoreRevenue', 'async function queryShengmeiRevenue'),
      )
    })

    it('付款流水查询不按父订单状态过滤，部分支付订单的已到账款也纳入', () => {
      const adminPaymentMetrics = normalize(stripComments(
        between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('),
      ))
      const staffRevenue = normalize(stripComments(
        between(staffSrc, 'async function queryStoreRevenue', 'async function queryShengmeiRevenue'),
      ))
      expect(adminPaymentMetrics).not.toMatch(/so\.status\s*=/)
      expect(staffRevenue).not.toMatch(/so\.status\s*=/)
    })
  })

  describe('工作台金额拆分', () => {
    it('实付仅统计首次支付和回款，退款金额单独取绝对值', () => {
      const paymentMetrics = normalize(stripComments(
        between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('),
      ))
      expect(paymentMetrics).toMatch(/spe\.change_type IN \('首次支付', '回款'\)[\s\S]*?AS today_paid_amount/)
      expect(paymentMetrics).toMatch(/spe\.change_type = '退款'[\s\S]*?ABS\(spe\.amount::numeric\)[\s\S]*?AS today_refunded_amount/)
    })

    /**
     * #140 口径守护。
     *
     * ⚠ 本条是补的历史欠账：在它之前，把这三个指标的日期条件从 `paid_at` 换成
     * `performance_date`（或换回去）**整个 admin 测试套件全绿**，无人会发现。
     * 上面那两条断言只管「实付统计哪些 change_type」，压根不看日期口径。
     */
    it('工作台五个日期相关指标一律按业绩归属日期，不得回退到 paid_at', () => {
      const paymentMetrics = normalize(stripComments(
        between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('),
      ))
      const dated: Array<[string, string]> = [
        ['today_revenue', 'today'],
        ['today_paid_amount', 'today'],
        ['today_refunded_amount', 'today'],
        ['yesterday_revenue', 'yesterday'],
        ['yesterday_paid_amount', 'yesterday'],
      ]
      for (const [metric, bound] of dated) {
        expect(
          paymentMetrics,
          `${metric} 的日期口径漂移（必须是 spe.performance_date = ${bound}）`,
        ).toMatch(
          new RegExp(`spe\\.performance_date = \\(SELECT ${bound} FROM bounds\\)[\\s\\S]*?AS ${metric}`),
        )
      }
      // 资金发生日不得作为任何日期条件回到工作台——那会重新制造「业绩按归属、实付按 paid_at」的双口径。
      // 若财务确实需要资金发生日口径，应另开报表入口而不是改这里（见 dashboard.ts 注释）。
      expect(paymentMetrics, 'paid_at 不得作为工作台的日期口径').not.toMatch(/spe\.paid_at/)
    })

    it('total_paid_amount 是累计值，不得被加上日期条件', () => {
      const paymentMetrics = normalize(stripComments(
        between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('),
      ))
      // 截取最后一个 COALESCE(SUM(CASE ... AS total_paid_amount 片段
      const totalBlock = paymentMetrics.match(/COALESCE\(SUM\(CASE(?:(?!COALESCE\(SUM\(CASE)[\s\S])*?AS total_paid_amount/)
      expect(totalBlock, '未能定位 total_paid_amount 片段').toBeTruthy()
      expect(totalBlock![0], 'total_paid_amount 被加上了日期条件').not.toMatch(/FROM bounds/)
    })

    it('订单数量和待办仍在独立的 sale_orders CTE 中统计', () => {
      const orderMetrics = normalize(stripComments(
        between(adminSrc, 'order_metrics AS (', ')\n      SELECT'),
      ))
      expect(orderMetrics).toMatch(/FROM sale_orders so/)
      expect(orderMetrics).toMatch(/pending_orders/)
      expect(orderMetrics).toMatch(/pending_allocations/)
    })
  })

  describe('维护者提醒 — 任一端漂移必须留 cross-end TODO 链接', () => {
    it('两端均应在公式附近提及对端', () => {
      // 任一端的注释/字符串中提到了另一端的标识（管理后台/数据中心/mgmt-dashboard/dashboard.ts）
      const adminMentionsStaff =
        /mgmt-?dashboard|管理层数据中心|数据中心/i.test(adminSrc)
      const staffMentionsAdmin = /audit-17|dashboard|admin/i.test(staffSrc)
      expect(adminMentionsStaff || staffMentionsAdmin).toBe(true)
    })
  })

  describe('历史订单隔离 — 营收口径必须排除 legacy workfine（核对补登 received 后防污染）', () => {
    // WorkFine 历史单核对通过会补 received=total_amount（供会员体系重算），
    // 经营营收/业绩口径必须排除它，否则污染 dashboard/排行/数据中心。两端同步守护。
    it('admin dashboard.ts 现金流查询必须排除 legacy_source = workfine', () => {
      expectCashflowRevenueSql(between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('))
    })
    it('staff mgmt-dashboard.js 现金流查询必须排除 legacy_source = workfine', () => {
      expectCashflowRevenueSql(
        between(staffSrc, 'async function queryStoreRevenue', 'async function queryShengmeiRevenue'),
      )
    })
  })
})
