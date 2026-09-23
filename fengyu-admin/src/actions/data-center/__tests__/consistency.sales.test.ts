/**
 * 销售板块两端口径一致性守护（仿 dashboard.consistency.test.ts）
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/sales.ts（Drizzle raw SQL / TS）
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js（pg / JS）
 *
 * 因两端 ORM 不同（Drizzle sql`` vs 原生 pg）且查询拆分粒度不同，完整 SQL snapshot 不可行。
 * 守护策略 = "关键不变量字面量匹配"（stripComments 后，排除注释里的反例引用）：
 *   1. 组织层级业绩 = SUM(sale_order_performance_events.amount)，按 performance_date 归期
 *   2. 付款 change_type = 首次支付 / 回款 / 退款；sale_order_type 另含充值单
 *   3. 生美 = is_shengmei = TRUE 的行级 SUM(sale_item_performance_events.amount)
 *   4. 实耗 = unit_real_price * session_used ∩ status='已完成'
 *   5. 分客型：customer_type / became_member_at 分型字面量
 *   6. 员工数 skills && ARRAY['美容师','养生师'] + hired_at/resigned_at 历史化
 *   7. 门店数当前启用 + opening_date / closed_at 历史化
 *
 * 任一端口径变更必须双端同步，否则数据中心 admin 与员工端 mgmtDashboard 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_SALES = path.resolve(__dirname, '../sales.ts')
const TECHNICIAN_SQL = path.resolve(__dirname, '../../../lib/data-center/technician-sql.ts')
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

function cashflowFragments(src: string, side: 'admin' | 'staff'): string[] {
  const ranges = side === 'admin'
    ? [
        ['const runStoreRevenue', 'const runShengmeiRevenue'],
        ['const runNewCustomerRevenue', 'const runTrafficCustomerRevenue'],
        ['const runTrafficCustomerRevenue', 'const runStoreCount'],
        ['// 业绩（付款流水现金流）', '// 生美业绩'],
        ['// 新增会员业绩（付款流水 + 客型）', '// 流量客业绩（付款流水 + 客型）'],
        ['// 流量客业绩（付款流水 + 客型）', '// 实耗'],
      ]
    : [
        ['async function queryStoreRevenue', 'async function queryShengmeiRevenue'],
        ['async function rankingRevenue', 'async function rankingConsume'],
        ['// SQL 1: 总业绩', '// SQL 2: 分客型业绩'],
        ['// SQL 2: 分客型业绩', '// SQL 3: 总实耗'],
      ]
  return ranges.map(([start, end]) => between(src, start, end)).filter(Boolean)
}

function expectCashflowFragment(src: string) {
  const n = normalize(stripComments(src))
  expect(n).toMatch(/(?:FROM|LEFT JOIN)\s+sale_order_performance_events\s+spe/i)
  expect(n).toMatch(/spe\.amount::numeric/i)
  expect(n).toMatch(/spe\.status\s*=\s*'已支付'/)
  expect(n).toMatch(/spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/)
  expect(n).toMatch(/(?:spe|so|o)\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'充值单'\s*\)/)
  expect(n).toMatch(/spe\.performance_date/i)
  expect(n).toMatch(/legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/i)
  expect(n).not.toMatch(/储值卡抵扣/)
  expect(n).not.toMatch(/payment_method/i)
}

describe('数据中心销售板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminBody: string
  let staffBody: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_SALES, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
    adminBody = normalize(stripComments(adminSrc))
    staffBody = normalize(stripComments(staffSrc))
  })

  describe('组织层级业绩 = 付款流水有符号合计', () => {
    it('admin sales.ts 的总额、客群和门店明细均使用现金流片段', () => {
      const fragments = cashflowFragments(adminSrc, 'admin')
      expect(fragments).toHaveLength(6)
      fragments.forEach(expectCashflowFragment)
    })

    it('staff mgmt-dashboard.js 的总额、排行榜和销售数据均使用现金流片段', () => {
      const fragments = cashflowFragments(staffSrc, 'staff')
      expect(fragments).toHaveLength(4)
      fragments.forEach(expectCashflowFragment)
    })

    it('组织业绩查询禁用订单快照金额，避免储值卡抵扣混入', () => {
      const adminCashflow = normalize(stripComments(cashflowFragments(adminSrc, 'admin').join('\n')))
      const staffCashflow = normalize(stripComments(cashflowFragments(staffSrc, 'staff').join('\n')))
      expect(adminCashflow).not.toMatch(/SUM\(\s*(?:so|o)\.received/i)
      expect(adminCashflow).not.toMatch(/refunded_amount/i)
      expect(staffCashflow).not.toMatch(/SUM\(\s*(?:so|o)\.received/i)
      expect(staffCashflow).not.toMatch(/refunded_amount/i)
    })
  })

  describe('生美 = 行级 is_shengmei = TRUE', () => {
    it('admin sales.ts 含 si.is_shengmei = TRUE 与 sit.is_shengmei = TRUE', () => {
      expect(adminSrc).toMatch(/si\.is_shengmei\s*=\s*TRUE/)
      expect(adminSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
    })
    it('staff mgmt-dashboard.js 含 si.is_shengmei = TRUE 与 sit.is_shengmei = TRUE', () => {
      expect(staffSrc).toMatch(/si\.is_shengmei\s*=\s*TRUE/)
      expect(staffSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
    })
  })

  describe('实耗 = unit_real_price * session_used ∩ status=已完成', () => {
    it('admin sales.ts 含 unit_real_price * session_used', () => {
      expect(adminBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(adminSrc).toMatch(/so\.status\s*=\s*'已完成'/)
    })
    it('staff mgmt-dashboard.js 含 unit_real_price * session_used', () => {
      expect(staffBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已完成'/)
    })
  })

  describe('分客型业绩 — customer_type / became_member_at 分型', () => {
    it('admin sales.ts 新增会员 = 会员客 AND became_member_at::date >= 区间起', () => {
      expect(adminSrc).toMatch(/c\.customer_type\s*=\s*'会员客'/)
      expect(adminBody).toMatch(/c\.became_member_at::date\s*>=/i)
    })
    it('staff mgmt-dashboard.js 新增会员分型用 customer_type=会员客 + became_member_at', () => {
      expect(staffSrc).toMatch(/c\.customer_type\s*=\s*'会员客'/)
      expect(staffSrc).toMatch(/became_member_at/)
    })
    it('admin sales.ts 流量客业绩 = 仅 customer_type=流量客（2026-05-26 用户拍板）', () => {
      expect(adminSrc).toMatch(/customer_type\s*=\s*'流量客'/)
      // 不再含体验客/小美客
      expect(adminSrc).not.toMatch(/'流量客'\s*,\s*'体验客'\s*,\s*'小美客'/)
    })
  })

  describe('员工数 — skills && ARRAY[美容师,养生师] + hired_at/resigned_at 历史化', () => {
    it('admin sales.ts 含 skills && ARRAY[美容师,养生师]', () => {
      expect(adminSrc).toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
    })
    it('staff mgmt-dashboard.js 含 skills && ARRAY[美容师,养生师]', () => {
      expect(staffSrc).toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
    })
    it('admin 员工数口径已抽为单源 technician-sql，且 sales.ts 不再自己扫 staff_wechat_users', () => {
      // #285：员工数口径从 sales.ts / efficiency.ts 两份内联查询抽成 technician-sql 单源。
      // 只修其中一处会让同一个数据中心的两个板块技师数差 14 人（闸门 2 codex 判 P0）。
      const tech = fs.readFileSync(TECHNICIAN_SQL, 'utf-8')
      expect(tech).toMatch(/hired_at::date\s*<=/i)
      expect(tech).toMatch(/resigned_at\s+IS\s+NULL\s+OR\s+sw\.resigned_at::date\s*>/i)
      expect(tech).toMatch(/skills && ARRAY\['美容师','养生师'\]/)
      // 双轨组织归属：直挂门店节点的人回收 + 直挂市场/部门的人走锚定市场
      expect(tech).toMatch(/COALESCE\(\s*sw\.store_id\s*,\s*ds\.store_id\s*\)/i)
      expect(tech).toMatch(/orgAnchorScopeSql\(session, scope, 'tb\.anchor_market_id'\)/)
      // sales.ts 必须引用单源，且不得再内联一份技师查询
      expect(adminSrc).toMatch(/technicianCountSql\(session, scope, range\.end\)/)
      expect(adminSrc).toMatch(/technicianByStoreSql\(session, scope, cur\.end\)/)
      expect(adminSrc).not.toMatch(/FROM staff_wechat_users/i)
    })
    it('staff mgmt-dashboard.js 员工数同口径（hired_at / resigned_at 历史化）', () => {
      expect(staffBody).toMatch(/hired_at::date\s*<=/i)
      expect(staffBody).toMatch(/resigned_at\s+IS\s+NULL\s+OR\s+s\.resigned_at::date\s*>/i)
    })
  })

  describe('门店数 — 当前启用 + opening_date / closed_at 历史化', () => {
    it('admin sales.ts 门店数用启用节点 + opening_date <= 区间末 + closed_at 守卫', () => {
      expect(adminBody).toMatch(/o\.is_active\s*=\s*TRUE/i)
      expect(adminBody).toMatch(/opening_date::date\s*<=/i)
      expect(adminBody).toMatch(/closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>/i)
    })
    it('staff mgmt-dashboard.js 门店数同口径（启用节点 + opening_date / closed_at 历史化）', () => {
      expect(staffBody).toMatch(/active_node\.is_active\s*=\s*TRUE/i)
      expect(staffBody).toMatch(/o\.is_active\s*=\s*TRUE/i)
      expect(staffBody).toMatch(/opening_date::date\s*<=/i)
      expect(staffBody).toMatch(/closed_at\s+IS\s+NULL\s+OR\s+s\.closed_at::date\s*>/i)
    })
    it('两端 store 维度不再短路为 1，停用门店可返回 0', () => {
      expect(adminSrc).not.toMatch(/scope\.type\s*===\s*'store'\s*\)\s*return\s+1/)
      expect(staffSrc).not.toMatch(/scopeType\s*===\s*'store'\s*\)\s*return\s+1/)
    })
  })

  describe('维护者提醒 — 两端互相提及防漂移', () => {
    it('admin sales.ts 注释提及 mgmt-dashboard / 员工端移植源', () => {
      expect(adminSrc).toMatch(/mgmt-?dashboard|员工端|staffApi/i)
    })
  })
})
