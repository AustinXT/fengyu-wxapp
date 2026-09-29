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
/** #401 起启用门店过滤收敛到 staff 在营口径 helper（mgmt-dashboard 经 require 引入） */
const STAFF_STORE_STATUS = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/utils/store-status.js',
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

/** #295：只归一投影、分组、末日参数；其余完整SQL必须同义。 */
function storeCountSqls(src: string): string[] {
  return [
    between(src, 'const runStoreCount', 'const runEmployeeCount'),
    between(src, 'const openStoresByStoreSql', 'const ['),
  ].map((block, index) => {
    const query = block.match(/sql`([\s\S]*?)`/)
    expect(query, 'KPI和逐店明细查询必须分别存在').not.toBeNull()
    const shape = normalize(query![1])
    if (index === 1) {
      expect(shape).toMatch(/^SELECT s\.store_id, COUNT\(\*\)::int AS v FROM /)
      expect(shape).toMatch(/ GROUP BY s\.store_id$/)
    } else {
      expect(shape).not.toMatch(/GROUP BY/i)
    }
    return normalize(query![1]
      .replace(/SELECT s\.store_id, COUNT\(\*\)::int AS v/, 'SELECT COUNT(*)::int AS v')
      .replace(/GROUP BY s\.store_id/, '')
      .replace(/\$\{scopeFilterSql\(session, scope, 's\.store_id'\)\}/g, 'SCOPE')
      .replace(/\$\{(?:range|cur)\.end\}/g, 'END'))
  })
}

const STORE_COUNT_SQL = "SELECT COUNT(*)::int AS v FROM stores s JOIN org_nodes o ON s.org_node_id = o.id WHERE o.type = '门店' AND o.is_active = TRUE AND SCOPE AND s.opening_date IS NOT NULL AND s.opening_date::date <= END AND (s.closed_at IS NULL OR s.closed_at::date > END)"

function expectStoreCountEqual(src: string): void {
  const queries = storeCountSqls(src)
  for (const query of queries) expect(query).toBe(STORE_COUNT_SQL)
  expect(queries[1]).toBe(queries[0])
  const body = stripComments(src)
  expect(body).not.toMatch(/m\.storeCount\s*\+=\s*1\b/)
  expect(body).toMatch(/m\.storeCount\s*\+=\s*openMap\.get\(s\.storeId\)\s*\?\?\s*0/)
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

/** 仅归一两个 ORM 的 scope/日期参数及明细投影，整段业务 SQL 必须相等。 */
function shengmeiFragments(admin: string, staff: string): string[] {
  const blocks = [
    between(admin, 'const runShengmeiRevenue', 'const runStoreConsume'),
    between(admin, '// 生美业绩（行级）', '// 新增会员业绩（付款流水 + 客型）'),
    between(staff, 'async function queryShengmeiRevenue', 'async function queryStoreConsume'),
  ]
  return blocks.map((block) => {
    const sql = block.match(/`(SELECT[\s\S]*?)`|sql`([\s\S]*?)`/)
    expect(sql, '生美查询锚点必须存在').not.toBeNull()
    return normalize(stripComments(sql![1] ?? sql![2]))
      .replace(/^SELECT so\.store_id, /, 'SELECT ')
      .replace(/ GROUP BY so\.store_id$/, '')
      .replace(/WHERE \$\{(?:scopeFilterSql\([^}]*\)|sc\.sql)\}/, 'WHERE __SCOPE__')
      .replace(/sipe\.performance_date BETWEEN \$\{(?:range|cur)\.start\} AND \$\{(?:range|cur)\.end\}/,
        '__DATE__')
      .replace(/\$\{timeWindow\('sipe\.performance_date', mode, 1, true\)\}/, '__DATE__')
  })
}

const SHENGMEI_SQL = "SELECT COALESCE(SUM(sipe.amount::numeric), 0) AS v " +
  "FROM sale_item_performance_events sipe " +
  "JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id " +
  "JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id " +
  "WHERE __SCOPE__ AND so.sale_order_type IN ('销售单', '转换单') " +
  "AND (NOT sipe.is_legacy_residual OR so.status <> '已关闭') " +
  "AND si.is_shengmei = TRUE AND __DATE__"

function expectShengmeiEqual(admin: string, staff: string) {
  const fragments = shengmeiFragments(admin, staff)
  expect(fragments).toHaveLength(3)
  fragments.forEach((sql) => expect(sql).toBe(SHENGMEI_SQL))
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

  describe('生美业绩三处整段等值守护（#300）', () => {
    it('admin KPI / admin 明细 / staff 首页的完整业务 SQL 相等', () => {
      expectShengmeiEqual(adminSrc, staffSrc)
    })
    it.each([0, 1, 2])('第 %i 处独自恢复已支付闸门必须报红', (index) => {
      const changed = "AND so.status = '已支付' AND si.is_shengmei = TRUE"
      if (index === 2) {
        const start = staffSrc.indexOf('async function queryShengmeiRevenue')
        const end = staffSrc.indexOf('async function queryStoreConsume', start)
        const block = staffSrc.slice(start,end).replace('AND si.is_shengmei = TRUE', changed)
        expect(() => expectShengmeiEqual(adminSrc, staffSrc.slice(0,start) + block + staffSrc.slice(end))).toThrow()
      } else {
        const anchor = index === 0 ? 'const runShengmeiRevenue' : '// 生美业绩（行级）'
        const start = adminSrc.indexOf(anchor)
        const offset = adminSrc.indexOf('AND si.is_shengmei = TRUE',start)
        const mutated = adminSrc.slice(0,offset) + changed + adminSrc.slice(offset + 'AND si.is_shengmei = TRUE'.length)
        expect(() => expectShengmeiEqual(mutated,staffSrc)).toThrow()
      }
    })
    it('任何一处额外过滤、JOIN 或金额表达式漂移都报红', () => {
      for (const [from,to] of [
        ['JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id','JOIN sale_items si ON si.sale_order_id = sipe.sale_order_id'],
        ['SUM(sipe.amount::numeric)','SUM(ABS(sipe.amount::numeric))'],
        ["so.status <> '已关闭'", "so.status <> '已退款'"],
      ]) expect(() => expectShengmeiEqual(adminSrc.replace(from,to),staffSrc)).toThrow()
    })
  })

  describe('实耗 = unit_real_price * session_used ∩ status=已完成', () => {
    it('admin sales.ts 含 unit_real_price * session_used', () => {
      expect(adminBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(adminSrc).toMatch(/so\.status\s*=\s*'已完成'/)
      expect(adminSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
    })
    it('staff mgmt-dashboard.js 含 unit_real_price * session_used', () => {
      expect(staffBody).toMatch(/unit_real_price::numeric\s*\*\s*sit\.session_used/i)
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已完成'/)
      expect(staffSrc).toMatch(/sit\.is_shengmei\s*=\s*TRUE/)
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
    it('admin 侧 skills 白名单在单源 technician-sql 里（sales.ts 自身只该剩注释）', () => {
      // ⚠️ 原断言是 `expect(adminSrc).toMatch(skills白名单)`，而 adminSrc 是**含注释**的原文。
      // #285 把口径抽走后，sales.ts 里只剩文件头注释提到这个词 —— 断言于是**空转**
      //（闸门 2 GLM round-3 抓到）。现在改为：真实 SQL 必须在单源模块里，
      // 而 sales.ts 剥注释后不得再有这个字面量。
      const tech = fs.readFileSync(TECHNICIAN_SQL, 'utf-8')
      expect(tech).toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
      expect(adminBody).not.toMatch(/skills\s*&&\s*ARRAY\[\s*'美容师'\s*,\s*'养生师'\s*\]/)
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
      /**
       * #320 起 staff 的技师分母走 `technician_base` CTE，`staff_wechat_users` 的别名
       * 从 `s` 改成 `sw`（与 admin `technicianCteSql` 一致）。别名必须跟着改，否则本条
       * 会以「旧别名找不到」的形式变红 —— 那不是口径漂移，是本断言没跟上。
       */
      expect(staffBody).toMatch(/resigned_at\s+IS\s+NULL\s+OR\s+sw\.resigned_at::date\s*>/i)
    })
  })

  describe('门店数 — 当前启用 + opening_date / closed_at 历史化', () => {
    it('KPI与逐店明细全段等值，并固定全部开闭店、组织域和计数规则', () => {
      expectStoreCountEqual(adminSrc)
    })
    it.each([
      ['KPI', 'const runStoreCount', 'const runEmployeeCount'],
      ['明细', 'const openStoresByStoreSql', 'const ['],
    ])('只改单独%s查询时，即使另一块仍含正确条件也报红', (_, start, end) => {
      const block = between(adminSrc, start, end)
      for (const [from, to] of [
        ['s.opening_date::date <=', 's.opening_date::date <'],
        ['s.closed_at::date >', 's.closed_at::date >='],
        ['AND s.opening_date IS NOT NULL', ''],
        ['o.is_active = TRUE', 'o.is_active = FALSE'],
        ['JOIN org_nodes o ON s.org_node_id = o.id', 'JOIN org_nodes o ON s.store_id = o.id'],
      ]) {
        const changed = block.replace(from, to)
        expect(changed).not.toBe(block)
        expect(() => expectStoreCountEqual(adminSrc.replace(block, changed))).toThrow()
      }
    })
    it('有正确逐店SQL但装配回退为骨架计数也报红', () => {
      expect(() => expectStoreCountEqual(adminSrc.replace('m.storeCount += openMap.get(s.storeId) ?? 0', 'm.storeCount += 1'))).toThrow()
    })
    it('逐店查询投影/分组必须保留，KPI不能误加逐店分组', () => {
      const detail = between(adminSrc, 'const openStoresByStoreSql', 'const [')
      for (const [from, to] of [
        ['GROUP BY s.store_id', ''],
        ['SELECT s.store_id, COUNT(*)::int AS v', 'SELECT COUNT(*)::int AS v'],
      ]) {
        expect(() => expectStoreCountEqual(adminSrc.replace(detail, detail.replace(from, to)))).toThrow()
      }
      const kpi = between(adminSrc, 'const runStoreCount', 'const runEmployeeCount')
      const grouped = kpi.replace(/sql`([\s\S]*?)`/, (_, query) => `sql\`${query} GROUP BY s.store_id\``)
      expect(grouped).not.toBe(kpi)
      expect(() => expectStoreCountEqual(adminSrc.replace(kpi, grouped))).toThrow()
    })
    it('装配守护只看代码：旧写法注释不误报，注释不能掩盖++回退', () => {
      expectStoreCountEqual(adminSrc + '\n// m.storeCount += 1')
      const expression = 'm.storeCount += openMap.get(s.storeId) ?? 0'
      const bad = adminSrc.replace(expression, 'm.storeCount++') + '\n// ' + expression
      expect(() => expectStoreCountEqual(bad)).toThrow()
    })
    it('staff mgmt-dashboard.js 门店数同口径（启用节点 + opening_date / closed_at 历史化）', () => {
      expect(staffBody).toContain("require('../utils/store-status')")
      expect(fs.readFileSync(STAFF_STORE_STATUS, 'utf-8')).toMatch(/active_node\.is_active\s*=\s*TRUE/i)
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
