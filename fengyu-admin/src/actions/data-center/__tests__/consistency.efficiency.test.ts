/**
 * 人效板块两端口径一致性守护（仿 consistency.sales.test.ts）
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/efficiency.ts（Drizzle raw SQL / TS）
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js（pg / JS，storeRanking + staffRanking + summary）
 *
 * 因两端 ORM 不同（Drizzle sql`` vs 原生 pg）+ 时间窗口口径不同（本板块吃 TimeRange 区间，
 * staff 用 period 锚 NOW），完整 SQL snapshot 不可行。守护策略 = "关键不变量字面量匹配"
 * （stripComments 后，排除注释里的反例引用）：
 *   1. 业绩(员工) = SUM(sale_payment_item_allocations.allocated_amount) 归 employee_id
 *   2. 不按 role_type 白名单截断 ∩ is_void = FALSE
 *   3. 实耗 = unit_real_price * session_used ∩ status='已完成'
 *   4. 收入 服务部分 = service_commissions.commission_amount
 *   5. 新会员 = became_member_at 归 bound_employee_id
 *   6. 项目数 = session_used ∩ sales_category IN ('自销自耗','他销自耗')
 *   7. 产能员工 producer_employees：hired_at/resigned_at 历史化
 *   8. sale_payment_item_allocations 按 sale_order_performance_events.performance_date 归期
 *
 * ★ 额外守护（本板块改造）：efficiency.ts 的 ranking 必须用 BETWEEN 区间，
 *   而非 staff 的 date_trunc period（timeWindowPeriod）。任一端漂移则数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_EFFICIENCY = path.resolve(__dirname, '../efficiency.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/** 剥离 JS/TS 行注释 + 块注释（避开 URL 的 //；排除 docstring 反例引用） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  const to = src.indexOf(end, from + start.length)
  return from === -1 ? '' : src.slice(from, to === -1 ? undefined : to)
}

describe('数据中心人效板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminBody: string
  let staffBody: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_EFFICIENCY, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
    adminBody = normalize(stripComments(adminSrc))
    staffBody = normalize(stripComments(staffSrc))
  })

  describe('业绩(员工) = SUM(sale_payment_item_allocations.allocated_amount) 归 employee_id', () => {
    it('admin efficiency.ts 含 SUM(spia.allocated_amount) 归 spia.employee_id', () => {
      expect(adminBody).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)
      expect(adminBody).toMatch(/spia\.employee_id/i)
    })
    it('staff mgmt-dashboard.js 含 SUM(spia.allocated_amount) 归 spia.employee_id', () => {
      expect(staffBody).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)
      expect(staffBody).toMatch(/spia\.employee_id/i)
    })
  })

  describe('业绩维度不按 role_type 白名单截断 ∩ is_void = FALSE', () => {
    it('admin efficiency.ts 不含 spia.role_type IN (美容师, 养生师)', () => {
      expect(adminBody).not.toMatch(/spia\.role_type\s+IN\s*\(\s*'美容师'\s*,\s*'养生师'\s*\)/i)
      expect(adminBody).toMatch(/is_void\s*=\s*FALSE/i)
    })
    it('staff mgmt-dashboard.js 不含 spia.role_type IN (美容师, 养生师)', () => {
      expect(staffBody).not.toMatch(/spia\.role_type\s+IN\s*\(\s*'美容师'\s*,\s*'养生师'\s*\)/i)
      expect(staffBody).toMatch(/is_void\s*=\s*FALSE/i)
    })
  })

  describe('销售单/转换单 + 已支付回款分配（业绩/销售提成口径）', () => {
    it('admin efficiency.ts 含 IN (销售单, 转换单) + 业绩事件归期', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
      expect(adminSrc).toMatch(/JOIN sale_payment_item_receipts spir ON spir\.id = spia\.sale_payment_item_receipt_id/)
      expect(adminSrc).toMatch(/JOIN sale_order_performance_events spe ON spe\.sale_payment_id = spir\.sale_payment_id/)
      expect(adminSrc).toMatch(/function performanceEventDateBetween/)
      expect(adminSrc).toMatch(/eventAlias}\.status/)
      expect(adminSrc).toMatch(/eventAlias}\.performance_date/)
      expect(adminSrc).toMatch(/performanceEventDateBetween\('spe', cur\.start, cur\.end\)/)
    })
    it('staff mgmt-dashboard.js 含 IN (销售单, 转换单) + 业绩事件归期', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
      expect(staffSrc).toMatch(/JOIN sale_payment_item_receipts spir ON spir\.id = spia\.sale_payment_item_receipt_id/)
      expect(staffSrc).toMatch(/JOIN sale_order_performance_events spe ON spe\.sale_payment_id = spir\.sale_payment_id/)
      expect(staffSrc).toMatch(/spe\.status = '已支付'/)
      expect(staffSrc).toMatch(/spe\.performance_date/)
    })
  })

  describe('实耗 = unit_real_price * session_used ∩ status=已完成', () => {
    it('admin efficiency.ts 含 unit_real_price * session_used + status=已完成', () => {
      expect(adminBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(adminSrc).toMatch(/status\s*=\s*'已完成'/)
    })
    it('staff mgmt-dashboard.js 含 unit_real_price * session_used + status=已完成', () => {
      expect(staffBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(staffSrc).toMatch(/status\s*=\s*'已完成'/)
    })
  })

  describe('收入 服务部分 = service_commissions.commission_amount', () => {
    it('admin efficiency.ts 含 SUM(sc.commission_amount) FROM service_commissions', () => {
      expect(adminBody).toMatch(/SUM\(\s*sc\.commission_amount::numeric\s*\)/i)
      expect(adminBody).toMatch(/FROM\s+service_commissions\s+sc/i)
    })
    it('staff mgmt-dashboard.js 含 service_commissions.commission_amount', () => {
      expect(staffBody).toMatch(/SUM\(\s*sc\.commission_amount::numeric\s*\)/i)
      expect(staffBody).toMatch(/FROM\s+service_commissions\s+sc/i)
    })
    it('admin efficiency.ts 销售提成部分用 SUM(spia.commission_amount)', () => {
      expect(adminBody).toMatch(/SUM\(\s*spia\.commission_amount::numeric\s*\)/i)
    })
  })

  describe('新会员 = became_member_at 归 bound_employee_id', () => {
    it('admin efficiency.ts 含 became_member_at + bound_employee_id', () => {
      expect(adminBody).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/i)
      expect(adminBody).toMatch(/c\.bound_employee_id/i)
    })
    it('staff mgmt-dashboard.js 含 became_member_at + bound_employee_id', () => {
      expect(staffBody).toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/i)
      expect(staffBody).toMatch(/c\.bound_employee_id/i)
    })
  })

  describe('项目数 = session_used ∩ sales_category IN (自销自耗, 他销自耗)', () => {
    it('admin efficiency.ts 含 sales_category IN (自销自耗, 他销自耗)', () => {
      expect(adminSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
    it('staff mgmt-dashboard.js 含 sales_category IN (自销自耗, 他销自耗)', () => {
      expect(staffSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
  })

  describe('产能员工 producer_employees — hired_at / resigned_at 历史化', () => {
    it('admin efficiency.ts 含 producer_employees CTE + hired_at / resigned_at 守卫', () => {
      expect(adminBody).toMatch(/producer_employees\s+AS\s*\(/i)
      expect(adminBody).toMatch(/sw\.hired_at\s+IS\s+NOT\s+NULL/i)
      expect(adminBody).toMatch(/sw\.resigned_at\s+IS\s+NULL\s+OR\s+sw\.resigned_at::date\s*>/i)
    })
    it('staff mgmt-dashboard.js 含 producer_employees CTE + hired_at / resigned_at 守卫', () => {
      expect(staffBody).toMatch(/producer_employees\s+AS\s*\(/i)
      expect(staffBody).toMatch(/sw\.hired_at\s+IS\s+NOT\s+NULL/i)
      expect(staffBody).toMatch(/sw\.resigned_at\s+IS\s+NULL\s+OR\s+sw\.resigned_at::date\s*>/i)
    })
    it('产能员工不再用 skills 过滤（2026-05-20 起，两端一致）', () => {
      // producer_employees CTE 内不应出现 skills 过滤（员工榜候选池口径）。
      // 注：efficiency.ts 在「店长/技师头数」处仍合法使用 skills，故只校验 producer CTE 段落。
      const adminProducer = adminBody.match(/producer_employees\s+AS\s*\([^)]*?\)/i)?.[0] ?? ''
      const staffProducer = staffBody.match(/producer_employees\s+AS\s*\([^)]*?\)/i)?.[0] ?? ''
      expect(adminProducer).not.toMatch(/skills\s*&&/i)
      expect(staffProducer).not.toMatch(/skills\s*&&/i)
    })
  })

  describe('保有会员（门店榜）= became_member_at 守卫 + 90 天到店窗口', () => {
    it('admin efficiency.ts 门店榜保有会员含 90 days 窗口 + became_member_at 守卫', () => {
      expect(adminBody).toMatch(/INTERVAL\s+'90 days'/i)
      expect(adminBody).toMatch(/c\.became_member_at::date\s*<=/i)
    })
    it('staff mgmt-dashboard.js 同口径（90 days + became_member_at）', () => {
      expect(staffBody).toMatch(/INTERVAL\s+'90 days'/i)
      expect(staffBody).toMatch(/c\.became_member_at::date\s*<=/i)
    })
  })

  describe('市场人效客流在市场内去重', () => {
    it('市场技师人均会员量使用 market_id + DISTINCT 顾客，不累加门店客流', () => {
      expect(adminBody).toMatch(/qFootfallByMarket/i)
      expect(adminBody).toMatch(/SELECT\s+sk\.market_id\s*,\s*COUNT\(DISTINCT\s+so\.client_user_id\)\s+AS\s+v/i)
      expect(adminBody).toMatch(/GROUP BY\s+sk\.market_id/i)
      expect(adminBody).toMatch(/techAvgMembers:\s*ratio\(footfallByMarketMap\.get\(m\.marketId\)/i)
      expect(adminBody).not.toMatch(/m\.footfall\s*\+=/i)
    })
  })

  describe('★ 改造守护：efficiency.ts ranking 用 BETWEEN 区间，而非 date_trunc period', () => {
    it('admin efficiency.ts 含 BETWEEN 区间过滤（跟随顶部 TimeRange）', () => {
      // 业绩/实耗/项目数/新会员 等均按 performance_date/service_date/became_member_at BETWEEN 区间。
      expect(adminBody).toMatch(/performance_date\s+BETWEEN/i)
      expect(adminBody).toMatch(/service_date\s+BETWEEN/i)
      expect(adminBody).toMatch(/became_member_at::date\s+BETWEEN/i)
    })

    it('admin efficiency.ts 禁用 date_trunc period / timeWindowPeriod（防回退到 staff 锚 NOW 口径）', () => {
      expect(adminBody).not.toMatch(/date_trunc\(\s*'month'/i)
      expect(adminBody).not.toMatch(/date_trunc\(\s*'year'/i)
      expect(adminBody).not.toMatch(/timeWindowPeriod/i)
      // 也不应出现 staff 的 NOW() 锚点（区间已显式传入）
      expect(adminBody).not.toMatch(/NOW\(\)::date\s*-\s*INTERVAL\s+'1 month'/i)
    })

    it('staff mgmt-dashboard.js 仍用 timeWindowPeriod / date_trunc（本板块移植源锚 NOW）', () => {
      // 守护"移植源"语义不被误改；本板块刻意背离它（改吃区间）。
      expect(staffSrc).toMatch(/timeWindowPeriod/)
      expect(staffBody).toMatch(/date_trunc\(\s*'month'/i)
    })
  })

  describe('门店排行榜业绩 = 付款流水现金流（员工榜/提成口径保持独立）', () => {
    function expectStoreRankCashflow(src: string, start: string, end: string) {
      const n = normalize(stripComments(between(src, start, end)))
      expect(n).toMatch(/(?:FROM|LEFT JOIN)\s+sale_order_performance_events\s+spe/i)
      expect(n).toMatch(/SUM\(spe\.amount::numeric\)/i)
      expect(n).toMatch(/spe\.status\s*=\s*'已支付'/)
      expect(n).toMatch(/spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/)
      expect(n).toMatch(/spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'充值单'\s*\)/)
      expect(n).toMatch(/spe\.performance_date\s+BETWEEN|timeWindowPeriod\('spe\.performance_date'|date_trunc\([^)]*spe\.performance_date/i)
      expect(n).toMatch(/legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/i)
      expect(n).not.toMatch(/refunded_amount|so\.received/i)
    }

    it('admin efficiency.ts 门店榜业绩按现金流', () => {
      expectStoreRankCashflow(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume')
    })

    it('staff mgmt-dashboard.js 门店榜业绩按现金流', () => {
      expectStoreRankCashflow(staffSrc, 'async function rankingRevenue', 'async function rankingConsume')
    })
  })

  describe('assignRanks — 两端并列跳号语义', () => {
    it('admin efficiency.ts 含 assignRanks（rank = idx + 1 跳号）', () => {
      expect(adminSrc).toMatch(/assignRanks/)
      expect(adminBody).toMatch(/rank\s*=\s*idx\s*\+\s*1/i)
    })
    it('staff mgmt-dashboard.js 含 assignRanks（rank = idx + 1 跳号）', () => {
      expect(staffSrc).toMatch(/assignRanks/)
      expect(staffBody).toMatch(/rank\s*=\s*idx\s*\+\s*1/i)
    })
  })

  describe('★ Part E 按技师人效明细 — 销/耗按 sales_category 拆分（员工维度全口径）', () => {
    it('销售额按 sale_items.sales_category FILTER 四枚举值齐全', () => {
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+si\.sales_category\s*=\s*'自销自耗'\s*\)/)
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+si\.sales_category\s*=\s*'他销自耗'\s*\)/)
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+si\.sales_category\s*=\s*'他销他耗'\s*\)/)
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+si\.sales_category\s*=\s*'生态合作'\s*\)/)
    })
    it('销售额与当月业绩同源（revenue_by_emp_cat 含 SUM(spia.allocated_amount) AS total）', () => {
      expect(adminBody).toMatch(/revenue_by_emp_cat\s+AS\s*\(/i)
      expect(adminBody).toMatch(/COALESCE\(\s*SUM\(spia\.allocated_amount::numeric\)\s*,\s*0\)\s+AS\s+total/i)
    })
    it('实耗端纳入 他销他耗/生态合作（员工维度放开，区别于门店口径排除）', () => {
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+sit\.sales_category\s*=\s*'他销他耗'\s*\)/)
      expect(adminSrc).toMatch(/FILTER\s*\(\s*WHERE\s+sit\.sales_category\s*=\s*'生态合作'\s*\)/)
    })
    it('服务人头 COUNT(DISTINCT client_user_id) 区别于服务人次 COUNT(DISTINCT service_order_id)', () => {
      expect(adminBody).toMatch(/COUNT\(DISTINCT\s+so2\.client_user_id\)\s+AS\s+headcount/i)
      expect(adminBody).toMatch(/COUNT\(DISTINCT\s+sit\.service_order_id\)\s+AS\s+visits/i)
    })
    it('byStaff 行带门店/职级文本列（producer CTE 取 position_name + labels 映射）', () => {
      expect(adminBody).toMatch(/sw\.position_name/i)
      expect(adminSrc).toMatch(/store:\s*r\.store_name/)
      expect(adminSrc).toMatch(/position:\s*r\.position_name/)
    })
  })

  describe('维护者提醒 — admin 注释提及移植源防漂移', () => {
    it('admin efficiency.ts 注释提及 mgmt-dashboard / 员工端移植源', () => {
      expect(adminSrc).toMatch(/mgmt-?dashboard|员工端|staffApi/i)
    })
  })
})
