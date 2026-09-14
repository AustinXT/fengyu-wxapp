/**
 * dashboard 组织层级现金流业绩口径一致性守护
 *
 * SUMMARY v3 §2 #15 / ticket notes/tickets/2026-05-17-dashboard-three-end-consistency-test.md
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/dashboard.ts        (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js (pg / JS)
 *
 * 守护分两层：
 *
 * **① admin 单端：`orderStats` 整条 SQL 完整逐字快照**（2026-09-14 #140 起）。
 * 原策略只做分段的「关键不变量字面量匹配」，但分段断言无论补多少条都有
 * 「截取范围之外」的盲区——评审逐轮演示过：`bounds` 定义在 payment_metrics 之前、
 * 最终投影在之后、`CROSS JOIN` 后还能追加 `WHERE FALSE` 让整条查询返回零行、
 * `order_metrics` 里 `HAVING FALSE` 同理。每补一个分段就暴露下一个边界，
 * 唯一收敛的办法是把整条 SQL 一次锁死。分段断言保留作为**失败定位辅助**。
 *
 * **② 跨端（admin ↔ staff）：仍用关键不变量字面量匹配**——
 * 两端 ORM 不同（Drizzle vs 原生 pg）、admin 用大 CTE 而 staff 按指标拆分多查询，
 * 跨端的完整 SQL snapshot 确实不可行。这层守护的四项不变量：
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
    // SQL 行注释：被测文本是 TS 里的 SQL 模板串，`--` 注释此前会原样留在里面。
    // 若某条 CASE 内的 `--` 注释恰好写着 `(SELECT today FROM bounds)` 之类字样，
    // 就能骗过基于文本的断言（GLM 评审指出的对抗路径）。
    //
    // ⚠ 已知限制：本规则对被测文本一视同仁，若 JS/TS 代码里出现 `i--` 或 `a - -b`，
    // 会连同其后整行一起被吞掉。当前两端被测段落都不含 `--`
    // （由下面 `staff 被测段落不含 -- 序列` 那条测试守护），将来引入时会立刻报红。
    .replace(/--[^\n]*/g, ' ')
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  const to = src.indexOf(end, from + start.length)
  return from === -1 ? '' : src.slice(from, to === -1 ? undefined : to)
}

/**
 * 找模板字符串的真实闭合反引号：跳过被 `\` 转义的那些。
 *
 * 裸 `indexOf('`')` 区分不了闭合符与转义反引号。codex 评审给过构造：
 * 在 `CROSS JOIN order_metrics` 后写一行 SQL 注释 `-- \``，
 * 提取器会在那个转义反引号处提前收尾，`stripComments` 再把注释删掉，
 * 结果恰好等于期望快照 —— 而其后的 `WHERE FALSE` 照样生效，整条查询返回零行。
 */
function findTemplateEnd(src: string, from: number): number {
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1 // 跳过被转义的字符本身
      continue
    }
    if (src[i] === '`') return i
  }
  return -1
}

/**
 * 提取 `orderStats` 的整条 SQL 模板（到模板闭合反引号为止）。
 *
 * 任何一步定位失败都返回空串，由调用方的 `not.toBe('')` 明确报红——
 * **不做 fallback 到文件尾**，那会把「提取器坏了」伪装成「SQL 变了」甚至假绿。
 */
function extractOrderStatsSql(src: string): string {
  const MARK = 'const orderStats = await db.execute(sql`'
  const from = src.indexOf(MARK)
  if (from === -1) return ''
  const start = from + MARK.length
  const anchor = src.indexOf('CROSS JOIN order_metrics', start)
  if (anchor === -1) return ''
  const end = findTemplateEnd(src, anchor)
  if (end === -1) return ''
  // 模板闭合后必须**紧跟 db.execute 的右括号**。
  // Drizzle 的 `sql`...`.append(sql` WHERE FALSE`)` 是正常 builder API（不是恶意构造），
  // 能在模板之外追加条件，而只看模板的快照完全无感——`WHERE FALSE` 会让查询返回零行、
  // 所有指标默认成 0。这里要求 execute 的参数就是单个 tagged template，没有后续组合。
  if (!/^\s*\)/.test(src.slice(end + 1))) return ''
  return normalize(stripComments(src.slice(start, end)))
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

/**
 * `orderStats` 整条 SQL 的**完整逐字快照**（口径权威，任何改动必须显式更新本表）。
 *
 * 为什么最终要上完整快照：分段断言无论补多少条，总有「截取范围之外」的盲区。
 * 评审逐轮演示过——bounds 定义在 payment_metrics 之前（改 `today - 1` 让五指标整体错位）、
 * 最终投影在之后（逐列点名可重算同名字段）、`CROSS JOIN` 之后还能追加 `WHERE FALSE`
 * 让整条查询返回零行把所有指标降为 0、`order_metrics` 里 `HAVING FALSE` 同理。
 * 每补一个分段就暴露下一个边界，唯一收敛的办法是把整条 SQL 一次锁死。
 *
 * 下面那些分段断言（bounds / 六个 CASE / CTE 尾部 / 投影）**保留作为失败定位辅助**：
 * 本条红了只说明「SQL 变了」，分段断言能指出变在哪一段。
 */
const EXPECTED_ORDER_STATS_SQL = [
    "WITH tz_today AS ( SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today ),",
    "bounds AS ( SELECT today, today - 1 AS yesterday FROM tz_today ),",
    "payment_metrics AS ( SELECT COALESCE(SUM(CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN spe.amount::numeric END), 0) AS today_revenue,",
    "COALESCE(SUM(CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款') AND spe.amount::numeric > 0 AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN spe.amount::numeric END), 0) AS today_paid_amount,",
    "COALESCE(SUM(CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付' AND spe.change_type = '退款' AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN ABS(spe.amount::numeric) END), 0) AS today_refunded_amount,",
    "COALESCE(SUM(CASE WHEN spe.performance_date = (SELECT yesterday FROM bounds) AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN spe.amount::numeric END), 0) AS yesterday_revenue,",
    "COALESCE(SUM(CASE WHEN spe.performance_date = (SELECT yesterday FROM bounds) AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款') AND spe.amount::numeric > 0 AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN spe.amount::numeric END), 0) AS yesterday_paid_amount,",
    "COALESCE(SUM(CASE WHEN spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款') AND spe.amount::numeric > 0 AND spe.sale_order_type IN ('销售单', '转换单', '充值单') THEN spe.amount::numeric END), 0) AS total_paid_amount FROM sale_order_performance_events spe WHERE spe.store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)}) AND spe.legacy_source IS DISTINCT FROM 'workfine' ),",
    "order_metrics AS ( SELECT COUNT(DISTINCT CASE WHEN so.sale_order_datetime::date = (SELECT today FROM bounds) AND so.status NOT IN ('已关闭', '支付失败', '未审核', '已作废') AND so.sale_order_type IN ('销售单', '转换单') THEN so.client_user_id END) AS today_opened_customers,",
    "COUNT(CASE WHEN so.status = '待支付' THEN 1 END) AS pending_orders,",
    "COUNT(CASE WHEN so.status IN ('已支付') AND so.allocation_status = '待分配' AND so.sale_order_type IN ('销售单', '转换单') THEN 1 END) AS pending_allocations FROM sale_orders so WHERE so.store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)}) AND so.legacy_source IS DISTINCT FROM 'workfine' ) SELECT payment_metrics.*, order_metrics.* FROM payment_metrics CROSS JOIN order_metrics",
].join(' ')

describe('dashboard 组织层级现金流业绩一致性守护', () => {
  let adminSrc: string
  let staffSrc: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_DASHBOARD, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
  })

  it('orderStats 整条 SQL 逐字快照（关闭一切「截取范围之外」的盲区）', () => {
    const actual = extractOrderStatsSql(adminSrc)
    expect(actual, '未能提取 orderStats SQL 模板').not.toBe('')
    expect(actual, 'orderStats SQL 漂移：改口径必须显式更新 EXPECTED_ORDER_STATS_SQL')
      .toBe(EXPECTED_ORDER_STATS_SQL)
  })

  describe('业绩 = 已支付付款流水的有符号合计', () => {
    it('admin dashboard payment_metrics 使用现金流口径', () => {
      expectCashflowRevenueSql(between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('))
    })

    it('staff 被测段落不含 -- 序列（否则 stripComments 会吞掉整行）', () => {
      // stripComments 的 SQL 注释规则对 JS 源码同样生效：`i--` 会让其后整行消失，
      // 静默改变被测文本。当前为 0 次；将来若在该段落引入递减运算符，这条会先红。
      const seg = between(staffSrc, 'async function queryStoreRevenue', 'async function queryShengmeiRevenue')
      expect(seg, '未能截取 staff queryStoreRevenue 段落').not.toBe('')
      expect(seg.match(/--/g) ?? [], 'staff 被测段落出现 -- 序列，stripComments 会吞掉整行').toHaveLength(0)
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

      /**
       * `tz_today` / `bounds` 的定义也要锁（codex 评审）。
       *
       * 下面的 CASE 快照只锁「引用了 `(SELECT today FROM bounds)`」，
       * 而 `bounds` 自己定义在 `payment_metrics` 之前、在截取范围之外。
       * 把 `bounds.today` 改成 `today - 1`，所有 CASE 快照与 CTE 正向快照都不变、
       * 守护全绿，但五个日期指标**整体错位一天**——这不是对抗构造，
       * 是重构 `bounds` 时真实会犯的错。
       */
      const boundsDef = normalize(stripComments(
        between(adminSrc, 'WITH tz_today AS (', 'payment_metrics AS ('),
      ))
      expect(boundsDef, '未能定位 tz_today / bounds 定义').not.toBe('')
      expect(boundsDef, 'tz_today / bounds 的定义漂移，会让五个日期指标整体错位').toBe(
        "WITH tz_today AS ( SELECT (NOW() AT TIME ZONE 'Asia/Shanghai')::date AS today ),"
        + ' bounds AS ( SELECT today, today - 1 AS yesterday FROM tz_today ),',
      )

      /**
       * 最终投影同样在截取范围之外：`payment_metrics.*` 一旦改成逐列点名，
       * 就能在这里重算同名字段而绕过上面所有块内守护。
       */
      const projection = normalize(stripComments(adminSrc))
        .match(/SELECT payment_metrics\.\*[\s\S]*?CROSS JOIN order_metrics/)
      expect(projection, '未能定位最终投影').toBeTruthy()
      expect(projection![0], '最终投影漂移：只允许 .* 透传两个 CTE，不得在此重算指标').toBe(
        'SELECT payment_metrics.*, order_metrics.* FROM payment_metrics CROSS JOIN order_metrics',
      )
      // between() 找不到起止标记时返回空串，会让下面所有负向断言恒真（假绿）
      expect(paymentMetrics, '未能截取 payment_metrics 片段，后续断言将失去意义').not.toBe('')

      /**
       * 聚合块数量与别名唯一性（GLM 评审）。
       *
       * 下面所有快照都锚定「第一个可达的同名块」。若在 SELECT 尾部再追加一个同名
       * `AS total_paid_amount` 的日期化聚合，快照会命中前面那个干净块而全绿，
       * 但 node-postgres 的行对象**后列覆盖前列**，运行时实际取到的是日期化的值。
       * 先锁死「恰好 6 个聚合、别名两两不同」，这条路就断了。
       */
      const aggregates = paymentMetrics.match(/COALESCE\(SUM\(CASE/g) ?? []
      expect(aggregates, 'payment_metrics 的聚合数量变了（新增/删除指标需同步本测试）')
        .toHaveLength(6)
      const aliases = [...paymentMetrics.matchAll(/END\), 0\) AS ([a-z_]+)/g)].map((m) => m[1])
      expect(aliases, '聚合别名数量与聚合块数量不符').toHaveLength(6)
      expect(new Set(aliases).size, `聚合别名重复（后列会覆盖前列）：${aliases.join(', ')}`)
        .toBe(6)
      /**
       * 六个指标**完整 `CASE ... END`** 的逐字快照。
       *
       * 加固轨迹（每一步都是被评审打穿后才补的）：
       *   1. 只验「块内包含日期条件」→ 追加 `OR TRUE`、放宽 change_type 全假绿
       *   2. 改验第一个 `WHEN ... THEN` 逐字 → 仍可在后面追加
       *      `ELSE spe.amount::numeric` 或第二个宽松 `WHEN` 来改变统计范围而不被发现
       *   3. 现在：整块 `CASE ... END` 逐字比对，连 `THEN` 的金额表达式
       *      （`spe.amount::numeric` vs `ABS(...)` vs 乘系数）与有无 `ELSE` 一并锁死
       *
       * 改这张表前先确认：日期口径（#140 统一为 performance_date）、
       * 付款类型、订单类型、金额符号、聚合表达式五项是不是真的要改。
       */
      const EXPECTED_CASE: Record<string, string> = {
        today_revenue:
          "CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付'"
          + " AND spe.change_type IN ('首次支付', '回款', '退款')"
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN spe.amount::numeric END',
        today_paid_amount:
          "CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付'"
          + " AND spe.change_type IN ('首次支付', '回款') AND spe.amount::numeric > 0"
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN spe.amount::numeric END',
        today_refunded_amount:
          "CASE WHEN spe.performance_date = (SELECT today FROM bounds) AND spe.status = '已支付'"
          + " AND spe.change_type = '退款'"
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN ABS(spe.amount::numeric) END',
        yesterday_revenue:
          "CASE WHEN spe.performance_date = (SELECT yesterday FROM bounds) AND spe.status = '已支付'"
          + " AND spe.change_type IN ('首次支付', '回款', '退款')"
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN spe.amount::numeric END',
        yesterday_paid_amount:
          "CASE WHEN spe.performance_date = (SELECT yesterday FROM bounds) AND spe.status = '已支付'"
          + " AND spe.change_type IN ('首次支付', '回款') AND spe.amount::numeric > 0"
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN spe.amount::numeric END',
        // 累计值：**不带任何日期条件**，这也是快照的一部分
        total_paid_amount:
          "CASE WHEN spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款')"
          + ' AND spe.amount::numeric > 0'
          + " AND spe.sale_order_type IN ('销售单', '转换单', '充值单')"
          + ' THEN spe.amount::numeric END',
      }
      const dated: Array<[string, string]> = [
        ['today_revenue', 'today'],
        ['today_paid_amount', 'today'],
        ['today_refunded_amount', 'today'],
        ['yesterday_revenue', 'yesterday'],
        ['yesterday_paid_amount', 'yesterday'],
      ]
      /**
       * ⚠ 必须**先切出本指标自己的 CASE 块，再在块内查日期绑定**。
       *
       * 曾经写成 `spe\.performance_date = \(SELECT ${bound} FROM bounds\)[\s\S]*?AS ${metric}`，
       * 裸 `[\s\S]*?` 会跨过前面的指标：today_revenue 是第一个且自带
       * `= (SELECT today FROM bounds)`，于是它替 today_paid_amount / today_refunded_amount
       * 永远兜底；yesterday_revenue 同理替 yesterday_paid_amount 兜底。
       * 实际效果是 5 条断言里只有 2 条（两个 revenue）真正生效——
       * 把另外三个指标的日期条件删掉、绑错 bound、甚至塞回 paid_at，断言全绿。
       * pr-ready 的 sibling-auditor 与 boundary-critic **各自独立变异验证**打穿了它。
       *
       * tempered greedy `(?:(?!COALESCE\(SUM\(CASE)[\s\S])*?` 保证匹配不越过下一个
       * `COALESCE(SUM(CASE` 边界，即锁在本指标块内。
       */
      // `(?![A-Za-z0-9_])` 是别名终止边界：没有它，`AS today_paid_amount_broken`
      // 也会被当成 `today_paid_amount` 命中（codex 评审指出）。
      const caseBlockOf = (metric: string) => paymentMetrics.match(
        new RegExp(`COALESCE\\(SUM\\(CASE(?:(?!COALESCE\\(SUM\\(CASE)[\\s\\S])*?AS ${metric}(?![A-Za-z0-9_])`),
      )
      for (const [metric, bound] of dated) {
        const block = caseBlockOf(metric)
        expect(block, `未能定位 ${metric} 的 CASE 块`).toBeTruthy()
        expect(
          block![0],
          `${metric} 的日期口径漂移（必须是 spe.performance_date = ${bound}）`,
        ).toContain(`spe.performance_date = (SELECT ${bound} FROM bounds)`)
      }
      // 整块 CASE ... END 逐字快照：追加 OR TRUE / 第二个 WHEN / ELSE 分支 /
      // 改 THEN 的金额表达式，任何一种都会红
      for (const metric of Object.keys(EXPECTED_CASE)) {
        const block = caseBlockOf(metric)
        expect(block, `未能定位 ${metric} 的 CASE 块`).toBeTruthy()
        const caseExpr = block![0].match(/CASE[\s\S]*?END\), 0\) AS/)
        expect(caseExpr, `未能提取 ${metric} 的 CASE 表达式`).toBeTruthy()
        const normalized = caseExpr![0].replace(/\), 0\) AS$/, '')
        expect(normalized, `${metric} 的 CASE 表达式漂移（改口径必须显式更新 EXPECTED_CASE）`)
          .toBe(EXPECTED_CASE[metric])
      }
      // 资金发生日不得作为任何日期条件回到工作台——那会重新制造「业绩按归属、实付按 paid_at」的双口径。
      // 若财务确实需要资金发生日口径，应另开报表入口而不是改这里（见 dashboard.ts 注释）。
      expect(paymentMetrics, 'paid_at 不得作为工作台的日期口径').not.toMatch(/spe\.paid_at/)
    })

    it('total_paid_amount 是累计值，不得被加上日期条件', () => {
      const paymentMetrics = normalize(stripComments(
        between(adminSrc, 'payment_metrics AS (', 'order_metrics AS ('),
      ))
      // 截取 total_paid_amount 所属的那个聚合块（tempered greedy 保证不越到前一个聚合）
      const totalBlock = paymentMetrics.match(
        /COALESCE\(SUM\(CASE(?:(?!COALESCE\(SUM\(CASE)[\s\S])*?AS total_paid_amount(?![A-Za-z0-9_])/,
      )
      expect(totalBlock, '未能定位 total_paid_amount 片段').toBeTruthy()
      // 只禁 `FROM bounds` 不够（codex 评审）：`spe.performance_date = CURRENT_DATE`
      // 绕过该断言却同样把累计值日期化。这里把所有日期来源一并封死。
      expect(totalBlock![0], 'total_paid_amount 被加上了日期条件')
        .not.toMatch(/FROM bounds|performance_date|paid_at|CURRENT_DATE|CURRENT_TIMESTAMP|NOW\(\)|LOCALTIMESTAMP|\d{4}-\d{2}-\d{2}/)
      /**
       * CTE 的 `FROM ... WHERE ...` 尾部走**正向快照**，不再用黑名单。
       *
       * boundary-critic 先发现「日期条件加到 CTE 的 WHERE 会绕过块内断言」，
       * 我补了黑名单；codex 随即指出黑名单永远不完备——
       * `AND spe.created_at::date = statement_timestamp()::date` 就绕过了当时的清单，
       * 继续补只会留下下一种等价写法。
       *
       * 正向快照直接声明：这个 CTE 只允许门店范围 + legacy_source 两项过滤。
       * 任何新增过滤（不管用什么函数、什么列）都会红。
       */
      const cteTail = paymentMetrics.slice(paymentMetrics.indexOf('FROM sale_order_performance_events'))
      expect(cteTail, '未能定位 payment_metrics 的 FROM/WHERE 尾部').toContain('WHERE')
      expect(
        cteTail.replace(/\s*\),?\s*$/, ''),
        'payment_metrics 的 FROM/WHERE 过滤条件漂移（只允许门店范围 + legacy_source）',
      ).toBe(
        'FROM sale_order_performance_events spe'
        + ' WHERE spe.store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})'
        + " AND spe.legacy_source IS DISTINCT FROM 'workfine'",
      )
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
