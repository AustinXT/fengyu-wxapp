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
 *   1. 业绩**两套口径，按聚合粒度分**（#285，2026-09-23）：
 *      1a. Part A/B 全局大卡 + by store = SUM(sale_order_performance_events.amount) 门店现金流，
 *          与 Part C 门店排名榜 / sales.ts runStoreRevenue / staff queryStoreRevenue 同源
 *      1b. Part D/E 员工榜 + 技师明细 = SUM(spia.allocated_amount) 归 employee_id
 *      ⚠️ 断言必须按 Part 分段（sliceOrFail()），文件级 toMatch 分不清两者 —— 2026-07-27
 *          23405ddf 把 A/B 也写成 spia 时，旧的文件级断言恒绿，缺陷活了两个月
 *   2. 员工榜不按 role_type 白名单截断 ∩ is_void = FALSE（恢复白名单不是 #285 的修法）
 *   3. 实耗 = unit_real_price * session_used ∩ status='已完成'
 *      3b. 员工维度归属 = service_commissions.employee_id ∩ is_void=FALSE，实耗乘 allocation_ratio
 *          （2026-09-03 变更；门店榜/大卡仍走 service_items.employee_id）
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

/**
 * 按首尾锚点切片 + 归一化，并**断言两个锚点都命中**。
 *
 * ⚠️ 前身 `between()` 是 fail-open 的：`start` 找不到返回**空串**，`end` 找不到一路切到**文件尾**。
 * 空串能通过任何 `not.toMatch`（本文件有 4 条），文件尾则让切片范围静默膨胀到全文 ——
 * 两种都是「守护恒绿不是因为没违规，而是扫描根避开了现场」。本仓在 #281 / #282 反复踩过，
 * 这次切片锚点是函数名/变量名（重命名即失效），必须 fail-closed。
 */
function sliceOrFail(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  expect(from, `切片起点锚未命中：${start}`).toBeGreaterThan(-1)
  const to = src.indexOf(end, from + start.length)
  expect(to, `切片终点锚未命中：${end}`).toBeGreaterThan(-1)
  return normalize(stripComments(src.slice(from, to)))
}

/**
 * 「门店现金流口径」= SUM(sale_order_performance_events.amount) 那一整套谓词。
 *
 * 用于三处同源查询：admin Part A/B 全局大卡与 by store（#285 起）、admin Part C 门店排名榜、
 * staff 大卡 queryStoreRevenue。任一处漂移，KPI 就会和同页门店榜对不上账。
 *
 * `statusDateVia`：admin Part A/B/C 里「status + performance_date」有两种写法 ——
 *   - `'literal'`：谓词直接写在 SQL 里（Part C / staff）
 *   - `'helper'` ：走 `performanceEventDateBetween('spe', ...)`（Part A/B）
 *     此时改为钉死 helper **自身**的实现（见下方 assertHelperBody），等价强度。
 */
function expectStoreRankCashflow(
  src: string,
  start: string,
  end: string,
  statusDateVia: 'literal' | 'helper' = 'literal',
): void {
  const n = sliceOrFail(src, start, end)
  expect(n).toMatch(/(?:FROM|LEFT JOIN)\s+sale_order_performance_events\s+spe/i)
  expect(n).toMatch(/SUM\(spe\.amount::numeric\)/i)
  expect(n).toMatch(/spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/)
  expect(n).toMatch(/spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'充值单'\s*\)/)
  expect(n).toMatch(/legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/i)
  expect(n).not.toMatch(/refunded_amount|so\.received/i)
  // #285 回归守护：这三处一律不得回退到 allocation 口径（跨员工求和 = 同一笔钱算 2~3 次）
  expect(n).not.toMatch(/spia\.allocated_amount/i)

  if (statusDateVia === 'literal') {
    expect(n).toMatch(/spe\.status\s*=\s*'已支付'/)
    // staff 两处归期写法不同：门店榜用 timeWindowPeriod(锚 NOW)，大卡用 timeWindow(锚 date 参数)
    expect(n).toMatch(
      /spe\.performance_date\s+BETWEEN|timeWindow(?:Period)?\('spe\.performance_date'|date_trunc\([^)]*spe\.performance_date/i,
    )
  } else {
    expect(n).toMatch(/performanceEventDateBetween\('spe', cur\.start, cur\.end\)/)
  }
}

/** helper 路径的等价强度来源：把 performanceEventDateBetween 自身的两个谓词钉死 */
function assertHelperBody(adminSrc: string): void {
  const body = sliceOrFail(adminSrc, 'function performanceEventDateBetween', '/** 行表')
  expect(body).toMatch(/\$\{sql\.raw\(`\$\{eventAlias\}\.status`\)\}\s*=\s*'已支付'/)
  expect(body).toMatch(/\$\{sql\.raw\(`\$\{eventAlias\}\.performance_date`\)\}\s*BETWEEN\s*\$\{start\}\s*AND\s*\$\{end\}/)
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

  // ─────────────────────────────────────────────────────────────────────────
  // 业绩有**两套口径**，按聚合粒度分（#285，2026-09-23）
  //
  // 2026-07-27 `23405ddf` 换表时把「全局大卡 / by store」一并留在了 allocation 口径，
  // 并把本文件的守护断言反向钉死（原断言是文件级 `toMatch`，分不清 Part A/B 与 Part D，
  // 两边都写 spia 时恒绿）。结果 KPI 与同页门店排名榜差 111 万、虚高 32.3%。
  // 现在按 Part 分段断言 —— 这是唯一能同时表达「A/B 必须是现金流」「D 必须是归属额」的写法。
  // ─────────────────────────────────────────────────────────────────────────

  describe('业绩 Part A/B（全局大卡 + by store）= 门店现金流，与门店排名榜同源', () => {
    it('performanceEventDateBetween 自身钉死 已支付 + performance_date BETWEEN', () => {
      assertHelperBody(adminSrc)
    })

    it('admin efficiency.ts Part A qRevenueTotal 走 spe.amount 现金流', () => {
      expectStoreRankCashflow(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal', 'helper')
    })

    it('admin efficiency.ts Part B qRevenueByStore 走 spe.amount 现金流', () => {
      expectStoreRankCashflow(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore', 'helper')
    })

    it('staff mgmt-dashboard.js 大卡 queryStoreRevenue 走 spe.amount 现金流（两端同源）', () => {
      expectStoreRankCashflow(
        staffSrc,
        'async function queryStoreRevenue',
        'async function queryShengmeiRevenue',
      )
    })

    it('Part B 分组列用 spe.store_id（与 Part C 同源；视图里它就是 so.store_id 的投影，定义恒等）', () => {
      const n = sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore')
      expect(n).toMatch(/GROUP BY spe\.store_id/i)
      expect(n).not.toMatch(/GROUP BY so\.store_id/i)
    })

    it('Part A 与 Part B 的 WHERE 子句逐字相同（两者只允许差 SELECT 列与 GROUP BY）', () => {
      // 这条才是「KPI 大卡 == byMarket 合计」的结构保证：上面的谓词清单断言只能证明
      // 「四个业务过滤都在」，证明不了两段没有各自多出别的条件。
      const whereOf = (start: string, end: string): string => {
        const seg = sliceOrFail(adminSrc, start, end)
        const from = seg.indexOf('WHERE ')
        expect(from).toBeGreaterThan(-1)
        const tail = seg.slice(from)
        const stop = tail.search(/GROUP BY|`\)/)
        return (stop === -1 ? tail : tail.slice(0, stop)).trim()
      }
      const a = whereOf('const qRevenueTotal', 'const qConsumeTotal')
      const b = whereOf('const qRevenueByStore', 'const qConsumeByStore')
      expect(a).not.toBe('')
      expect(b).toBe(a)
    })
  })

  describe('业绩 Part D/E（员工榜 + 技师明细）= 角色归属额，归 employee_id', () => {
    it('admin efficiency.ts revenue_by_emp 含 SUM(spia.allocated_amount) 归 spia.employee_id', () => {
      const n = sliceOrFail(adminSrc, 'revenue_by_emp AS (', 'consume_by_emp AS (')
      expect(n).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)
      expect(n).toMatch(/spia\.employee_id/i)
      expect(n).toMatch(/GROUP BY spia\.employee_id/i)
      expect(n).toMatch(/is_void\s*=\s*FALSE/i)
    })
    it('staff mgmt-dashboard.js staffRankingRevenue 含 SUM(spia.allocated_amount) 归 spia.employee_id', () => {
      const n = sliceOrFail(staffSrc, 'async function staffRankingRevenue', 'async function staffRankingConsume')
      expect(n).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)
      expect(n).toMatch(/spia\.employee_id/i)
      expect(n).toMatch(/is_void\s*=\s*FALSE/i)
    })
  })

  describe('员工榜业绩不按 role_type 白名单截断（所有角色各算一份，用户拍板）', () => {
    // ⚠️ 这条只约束 Part D/E。恢复白名单**不是** #285 的修法：
    // 实测（2026-09-01~09-21 集团）白名单只留美容师+养生师 = 3,515,204.60，
    // 距门店业绩 3,679,035.98 仍差 −4.45%，且偏差幅度随品项老师/推广部占比漂移，
    // 是一次偶然的部分去重而非正确口径。真正的修法是 Part A/B 换成 spe.amount。
    it('admin efficiency.ts 员工榜段不含 spia.role_type IN (美容师, 养生师)', () => {
      const n = sliceOrFail(adminSrc, 'revenue_by_emp AS (', 'consume_by_emp AS (')
      expect(n).not.toMatch(/spia\.role_type\s+IN\s*\(\s*'美容师'\s*,\s*'养生师'\s*\)/i)
    })
    it('staff mgmt-dashboard.js 员工榜段不含 spia.role_type IN (美容师, 养生师)', () => {
      const n = sliceOrFail(staffSrc, 'async function staffRankingRevenue', 'async function staffRankingConsume')
      expect(n).not.toMatch(/spia\.role_type\s+IN\s*\(\s*'美容师'\s*,\s*'养生师'\s*\)/i)
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

  /**
   * 2026-09-03 口径变更守护：员工维度的实耗 / 项目数 / 客流(客量) 归属改
   * service_commissions.employee_id（is_void=FALSE），实耗额外乘 allocation_ratio。
   * 变更缘由：service_items.employee_id 开单后不可修改，门店改「营业额分配-服务提成」
   * 纠正归属时改不动它 → 实耗长期记在没拿这单提成的人头上。
   * 门店榜 / 全局大卡实耗仍走 service_items，不在本守护范围。
   */
  describe('员工归属 = service_commissions.employee_id（2026-09-03 起）', () => {
    it('admin efficiency.ts 员工实耗按 allocation_ratio 归 sc.employee_id', () => {
      expect(adminBody).toMatch(
        /SUM\(\s*sit\.unit_real_price::numeric\s*\*\s*sit\.session_used\s*\*\s*sc\.allocation_ratio\s*\)/i,
      )
      expect(adminBody).toMatch(/GROUP BY\s+sc\.employee_id/i)
      expect(adminBody).toMatch(/FROM\s+service_commissions\s+sc\s+JOIN\s+service_items\s+sit\s+ON\s+sit\.service_item_id\s*=\s*sc\.service_item_id/i)
    })
    it('staff mgmt-dashboard.js 员工实耗按 allocation_ratio 归 sc.employee_id', () => {
      expect(staffBody).toMatch(
        /SUM\(\s*sit\.unit_real_price::numeric\s*\*\s*sit\.session_used\s*\*\s*sc\.allocation_ratio\s*\)/i,
      )
      expect(staffBody).toMatch(/GROUP BY\s+sc\.employee_id/i)
      expect(staffBody).toMatch(/FROM\s+service_commissions\s+sc\s+JOIN\s+service_items\s+sit\s+ON\s+sit\.service_item_id\s*=\s*sc\.service_item_id/i)
    })
    it('两端员工实耗/项目数不再挂 service_items.employee_id（旧口径已废弃）', () => {
      // 员工榜 CTE 名 consume_by_emp / project_by_emp / consume_by_emp_cat 内不得再出现
      // GROUP BY sit.employee_id（门店榜按 store_id 聚合，不受影响）。
      expect(adminBody).not.toMatch(/consume_by_emp[a-z_]*\s+AS\s*\([^)]*GROUP BY\s+sit\.employee_id/i)
      expect(adminBody).not.toMatch(/project_by_emp\s+AS\s*\([^)]*GROUP BY\s+sit\.employee_id/i)
      expect(staffBody).not.toMatch(/consume_by_emp\s+AS\s*\([^)]*GROUP BY\s+sit\.employee_id/i)
      expect(staffBody).not.toMatch(/project_by_emp\s+AS\s*\([^)]*GROUP BY\s+sit\.employee_id/i)
    })
    it('项目数为计数指标：不乘 allocation_ratio，用 DISTINCT 防同员工多角色重复累加', () => {
      expect(adminBody).toMatch(/SELECT DISTINCT\s+sc\.employee_id\s*,\s*sit\.service_item_id\s*,\s*sit\.session_used/i)
      expect(staffBody).toMatch(/SELECT DISTINCT\s+sc\.employee_id\s*,\s*sit\.service_item_id\s*,\s*sit\.session_used/i)
      expect(adminBody).not.toMatch(/SUM\(\s*sit\.session_used\s*\*\s*sc\.allocation_ratio\s*\)/i)
      expect(staffBody).not.toMatch(/SUM\(\s*sit\.session_used\s*\*\s*sc\.allocation_ratio\s*\)/i)
    })
    it('所有 role_type 各算一份 — 员工归属侧不得按角色白名单截断', () => {
      expect(adminBody).not.toMatch(/sc\.role_type\s+IN\s*\(/i)
      expect(adminBody).not.toMatch(/sc\.role_type\s*=\s*'美容师'/i)
      expect(staffBody).not.toMatch(/sc\.role_type\s+IN\s*\(/i)
      expect(staffBody).not.toMatch(/sc\.role_type\s*=\s*'美容师'/i)
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
    /**
     * 2026-09-03 放宽：候选池 = 门店员工 ∪ 直挂组织节点员工（store_id 为空的品项老师/养生师）。
     * 三段兜底必须两端字面镜像，否则同一个人在 staff 榜和 admin 榜的门店名/可见性会不一致。
     */
    it('候选池含直挂组织节点员工：store_id / store_name / anchor_market_id 三段兜底（两端镜像）', () => {
      for (const body of [adminBody, staffBody]) {
        expect(body).toMatch(/producer_base\s+AS\s*\(/i)
        // 1. store_id 兜底：直挂门店节点时反查该门店
        expect(body).toMatch(/COALESCE\(sw\.store_id,\s*ds\.store_id\)/i)
        expect(body).toMatch(/LEFT JOIN stores ds\s+ON ds\.org_node_id\s*=\s*sw\.org_node_id/i)
        // 2. 展示名兜底到直挂节点名（不留空白「所属门店」列）
        expect(body).toMatch(/COALESCE\(s\.store_name,\s*ds\.store_name,\s*o\.name\)/i)
        // 3. 可见性锚：直挂节点自身是市场则取自身，否则取父节点
        expect(body).toMatch(/CASE WHEN o\.type\s*=\s*'市场' THEN o\.id/i)
        expect(body).toMatch(/WHEN op\.type\s*=\s*'市场' THEN op\.id/i)
        expect(body).toMatch(/AS anchor_market_id/i)
        // 两分支：有门店走 store scope，无门店走 anchor scope
        expect(body).toMatch(/pb\.store_id IS NOT NULL AND/i)
        expect(body).toMatch(/pb\.store_id IS NULL AND/i)
      }
    })
    it('无门店员工的可见性锚定到「市场下的在营门店」（两端镜像）', () => {
      // staff 端内联 EXISTS；admin 端走 orgAnchorScopeSql（src/lib/data-center/scope-sql.ts，
      // 由 scope-sql.test.ts 单独守护），此处只校验 admin 确实调用了该 helper。
      expect(staffBody).toMatch(/vn\.parent_id\s*=\s*pb\.anchor_market_id/i)
      expect(staffBody).toMatch(/vn\.is_active\s*=\s*TRUE/i)
      expect(adminBody).toMatch(/orgAnchorScopeSql\(session,\s*scope\)/i)
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
