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
const ADMIN_SALES = path.resolve(__dirname, '../sales.ts')
const TECHNICIAN_SQL = path.resolve(__dirname, '../../../lib/data-center/technician-sql.ts')

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

/**
 * helper 路径的等价强度来源：把 `performanceEventDateBetween` 自身的谓词钉死。
 *
 * ⚠️ 必须同时证「有这两条」和「**只有**这两条」。只证「有」的话，将来给 helper 追加一个条件，
 * Part A/B（走 helper）会跟着变，而 Part C（字面量写法）不变 —— 两者静默分叉、
 * 「KPI == 门店榜」的等式破裂，而所有断言照样全绿。用 `AND` 出现次数锁死谓词个数。
 */
function assertHelperBody(adminSrc: string): void {
  const body = sliceOrFail(adminSrc, 'function performanceEventDateBetween', 'function toMap')
  expect(body).toMatch(/\$\{sql\.raw\(`\$\{eventAlias\}\.status`\)\}\s*=\s*'已支付'/)
  expect(body).toMatch(/\$\{sql\.raw\(`\$\{eventAlias\}\.performance_date`\)\}\s*BETWEEN\s*\$\{start\}\s*AND\s*\$\{end\}/)
  // 恰好 2 个 AND：① 连接 status 与 performance_date 两个谓词 ② `BETWEEN x AND y` 语法自带。
  // 追加第三个谓词 → 3 个 → 红；把 BETWEEN 换成 >=/<= → 1 个 → 也红（同样是值得拦的改动）。
  expect(body.match(/\bAND\b/g) ?? [], 'helper 谓词个数变了：Part A/B 会与 Part C 静默分叉').toHaveLength(2)
  // ⚠️ 只数 AND 不够：闸门 2 round-5 GLM 在 helper 尾部追加
  // `OR ${eventAlias}.status = '部分支付'`，AND 计数不变、两条 toMatch 照样命中，
  // 却把 Part A/B 的状态过滤放宽成「已支付 OR 部分支付」而 Part C 不变（实测 56 条全绿）。
  expect(body, 'helper 里出现 OR：谓词语义被放宽，Part A/B 会与 Part C 分叉').not.toMatch(/\bOR\b/)
  // 同理禁止任何额外的 `${eventAlias}.` 引用（只该有 status 与 performance_date 两处）
  expect(
    (body.match(/\$\{eventAlias\}\./g) ?? []).length,
    'helper 里 ${eventAlias}. 的引用数变了',
  ).toBe(2)
}


/**
 * 抽出一个 SQL 片段里所有**针对 `spe` 的过滤谓词**，归一化后排序返回。
 *
 * 用途：把「门店现金流」三处（Part A 全局大卡 / Part B by store / Part C 门店排名榜）
 * 的谓词集做**集合相等**比较，而不只是逐条 `toMatch` 证明「存在」。
 *
 * ⚠️ 为什么必须比集合：闸门 2 两个谱系**独立**证明了同一个漏洞 ——
 *   - codex：给 Part C 单独加聚合级 `FILTER (WHERE spe.amount > 0)` → 三层守护全绿
 *   - GLM 变异测试：给 Part A **和** Part B 同时加 `AND spe.change_type <> '退款'`
 *     （保持 A 与 B 逐字相同、Part C 不动）→ 53 条断言全绿
 * 「逐条存在」证明不了「没有多出别的」；「A == B」在两边一起改时也失效。
 * 只有「A 的谓词集 == B 的 == C 的」才挡得住。
 */
function expandSpeHelper(segment: string): string {
  // ⚠️ 先把别名大小写归一：PG 对**未加引号**的标识符大小写不敏感，`SPE.change_type`
  // 与 `spe.change_type` 在运行时等价，但正则默认区分大小写 —— 闸门 2 round-5 GLM
  // 就是用 `AND SPE.change_type <> '退款'` 骗过了全部六层（实测 56 条全绿）。
  const normalized = segment.replace(/\bspe\./gi, 'spe.')
  // Part A/B 把 status + performance_date 交给 helper，Part C 写字面量。
  // 先把 helper 调用展开成它实际产出的两个谓词，两边才可比。
  return normalized.replace(
    /\$\{performanceEventDateBetween\('spe', cur\.start, cur\.end\)\}/g,
    "spe.status = '已支付' AND spe.performance_date BETWEEN ${cur.start} AND ${cur.end}",
  )
}

/** 抽谓词，**不去重**（计数核对要用） */
function spePredicatesRaw(segment: string): string[] {
  const expanded = expandSpeHelper(segment)
  const out: string[] = []
  const re = /spe\.(\w+)\s*(IS DISTINCT FROM|IN|BETWEEN|=|<>|>=|<=|>|<)\s*([^]*?)(?=\s+AND\s|\s+GROUP BY|\s+ORDER BY|\s+WHERE\s|`\)|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expanded)) !== null) {
    const col = m[1]
    // store_id 的关联/范围条件（Part C 的 JOIN ON / Part A 的 scopeFilterSql 片段）不算业务谓词
    if (col === 'store_id') continue
    const rhs = m[3].replace(/\$\{[^}]*\}/g, '${ts}').replace(/\s+/g, ' ').trim()
    out.push(`spe.${col} ${m[2]} ${rhs}`)
  }
  return out
}

function spePredicateSet(segment: string): string[] {
  return [...new Set(spePredicatesRaw(segment))].sort()
}

/**
 * **fail-closed 收口**：每一个 `spe.<列>` 引用都必须有归属 ——
 * 要么在聚合 `SUM(spe.amount...)` 里，要么是 `spe.store_id` 的关联/范围条件，
 * 要么是被 `spePredicatesRaw` 识别出的一条业务谓词。数不平就判红。
 *
 * ⚠️ 为什么需要这一层：闸门 2 round-4 codex 找到了第六种绕过 ——
 * 在 Part C 加 `AND COALESCE(spe.amount, 0) > 0`（剔除退款负行）。
 * 谓词正则要求 `spe.<列>` 后**紧跟**运算符，而这里跟的是逗号，
 * 该谓词被**静默丢弃**，于是三处谓词集依然"相等"，55 条断言全绿。
 * 实测复现属实 —— 任何把 `spe.*` 包进函数的写法都能逃掉。
 * 所以不能只比「识别出来的那些」，必须证明「没有识别不出来的」。
 */
function assertEverySpeRefClassified(segment: string, label: string): void {
  const expanded = expandSpeHelper(segment)
  const total = (expanded.match(/\bspe\.\w+/g) ?? []).length
  const inAggregate = (expanded.match(/SUM\(\s*spe\.amount/g) ?? []).length
  const storeIdRefs = (expanded.match(/\bspe\.store_id\b/g) ?? []).length
  const classified = spePredicatesRaw(segment).length
  expect(
    total,
    `${label} 存在无法归类的 spe.* 引用（聚合 ${inAggregate} + store_id ${storeIdRefs} + 谓词 ${classified} ≠ 总计 ${total}）。` +
      '把 spe.* 包进函数（如 COALESCE(spe.amount,0) > 0）就能骗过谓词正则，故此处 fail-closed。',
  ).toBe(inAggregate + storeIdRefs + classified)
}

/**
 * 约束查询的**表骨架**（FROM + 全部 JOIN），按类封死「聚合扇出」。
 *
 * ⚠️ 闸门 2 round-9 codex：为排行榜补一列「员工数」而加
 * `LEFT JOIN staff_wechat_users sw_rank ON sw_rank.store_id = s.store_id`
 * 是完全正常的开发行为，但它是 **1:N**，会在聚合前把 `spe` 行按员工数放大，
 * `SUM(spe.amount)` 随之虚高 —— 而前十层一条都不会红：
 * `spe` 谓词没变、裸 `SUM` 没变、WHERE 形状没变、没有 LIMIT/HAVING，
 * 单源纪律只禁本地 skills 白名单、不禁读 `staff_wechat_users`，
 * 而「12 行进 12 行出」喂的是 mock 结果、根本不执行 SQL。
 *
 * 扇出是聚合查询的经典缺陷类，逐个补正则挡不完。这里直接钉死**表集合**：
 * 今后往这三个查询里加任何一张表都会红，改动者必须显式来改这条断言并说明为什么安全
 *（正确做法通常是「先按门店聚合完，再 JOIN 展示维度」）。
 */
function assertTableSkeleton(segment: string, expected: string[], label: string): void {
  const tables = [...segment.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\b/gi)].map((m) => m[1])
  expect(tables, `${label} 的表骨架变了（新增 JOIN 可能引入聚合扇出，令 SUM 虚高）`).toEqual(expected)
}

/**
 * 约束 `WHERE` 子句的**形状**，而不只是里面的 `spe` 谓词。
 *
 * ⚠️ 前八层全部只盯 `spe.*`，对**门店侧**过滤完全失明 ——
 * 闸门 2 round-6 codex 指出这个方向后实测确认：给 Part C 的
 * `WHERE ${scopeFilterSql(session, scope, 's.store_id')}` 后面追加
 * `AND s.closed_at IS NULL`，门店榜会少掉一批门店、合计不再等于 KPI，
 * 而 56 条断言**全绿**。
 *
 * 规则：
 *   - Part A/B（`spe` 单表）：WHERE 以 `${scopeFilterSql(..., 'spe.store_id')}` 起手，
 *     其余每一项都必须是 `spe.` 谓词或 helper 调用
 *   - Part C（`stores` 驱动 + LEFT JOIN spe）：WHERE **有且仅有**
 *     `${scopeFilterSql(..., 's.store_id')}` 一项，业务过滤全在 JOIN ON 里
 */
function assertWhereShape(segment: string, kind: 'spe-table' | 'store-table', label: string): void {
  const from = segment.indexOf('WHERE ')
  expect(from, `${label} 找不到 WHERE`).toBeGreaterThan(-1)
  const tail = segment.slice(from + 'WHERE '.length)
  const stop = tail.search(/GROUP BY|ORDER BY|`\)/)
  const where = (stop === -1 ? tail : tail.slice(0, stop)).trim()

  if (kind === 'store-table') {
    // ⚠️ 消息措辞很重要：原文写的是「业务过滤必须写在 JOIN ON 里」——
    // 闸门 2 round-11 GLM 指出，这句话会把被本断言拦下的开发者**直接引向**
    // 下面那个当时还没守护的位置（`LEFT JOIN spe ON` 里挂 `s.*` 谓词）。
    // 守护自己的报错不该成为下一个盲区的路标。
    expect(
      where,
      `${label} 的 WHERE 只允许 scopeFilterSql 一项；门店侧过滤（无论写在 WHERE 还是 JOIN ON）` +
        '都会让门店榜合计 ≠ KPI 分子，加之前先评估这条等式',
    ).toBe("${scopeFilterSql(session, scope, 's.store_id')}")

    // `spe` 的 JOIN ON 内，门店侧（`s.*`）引用只许 `spe.store_id = s.store_id` 关联这一处。
    // 在 ON 链尾偷挂 `AND s.closed_at IS NULL` 会静默剔除门店业绩、破坏等式，
    // 而 spe 谓词层 / WHERE 形状层**都不看 ON 子句**（GLM 实测 227 条全绿）。
    const speJoinOn = segment.slice(
      segment.indexOf('LEFT JOIN sale_order_performance_events spe'),
      from,
    )
    expect(
      (speJoinOn.match(/\bs\.\w+/g) ?? []).length,
      `${label} 的 spe JOIN ON 里混入门店侧（s.*）过滤，门店榜会与 KPI 静默分叉`,
    ).toBe(1)
    return
  }

  const terms = where.split(/\s+AND\s+/).map((t) => t.trim()).filter(Boolean)
  expect(terms[0], `${label} 的 WHERE 必须以 scopeFilterSql 起手`).toBe(
    "${scopeFilterSql(session, scope, 'spe.store_id')}",
  )
  for (const t of terms.slice(1)) {
    expect(
      /^spe\.\w+/.test(t) || t.startsWith('${performanceEventDateBetween('),
      `${label} 的 WHERE 里混入了非 spe 过滤项：${t}`,
    ).toBe(true)
  }
}

/** 聚合表达式必须**逐字**是 `COALESCE(SUM(spe.amount::numeric), 0)`，不许挂 FILTER/DISTINCT/CASE */
function assertPlainSumAggregate(segment: string, label: string): void {
  const sums = segment.match(/SUM\(\s*spe\.amount::numeric\s*\)[^,)]*/g) ?? []
  expect(sums.length, `${label} 找不到 SUM(spe.amount::numeric)`).toBeGreaterThan(0)
  for (const frag of sums) {
    expect(
      frag.replace(/\s+/g, ''),
      `${label} 的聚合表达式被改过（FILTER / DISTINCT / CASE 都会让 KPI 与门店榜对不上）`,
    ).toBe('SUM(spe.amount::numeric)')
  }
  // ⚠️ 上面只锁住**内层** SUM。闸门 2 round-10 codex 指出注释比代码强，实测确认：
  // 把输出列包一层 `GREATEST(COALESCE(SUM(...), 0), 0)`（把负业绩门店钳到 0，
  // 是极自然的「别显示负数」改法，本仓 analyst 侧就用过 GREATEST 挡负数）
  // 能让 59 条断言全绿，而门店榜合计不再等于 KPI。
  // 故再锁**完整输出表达式**：`COALESCE(SUM(...), 0)` 后面必须紧跟 ` AS `，
  // 一旦外面再套一层函数，这个子串就不成立。
  expect(
    segment.replace(/\s+/g, ' '),
    `${label} 的输出列被外层函数包过（如 GREATEST(...)），会把负业绩钳掉并破坏等式`,
  ).toContain('COALESCE(SUM(spe.amount::numeric), 0) AS ')
}

/**
 * 抽出一个排行榜查询**最外层**的 `WHERE` 子句正文。
 *
 * ⚠️ 不能取第一个 `WHERE`：这些查询普遍带 CTE（`revenue_by_emp AS (... WHERE ...)`）与
 * 相关子查询（门店榜保有会员的 `EXISTS (... WHERE ...)`），第一个 WHERE 必落在内层，
 * 拿它去比对外层口径会得到「口径没守住」的假红 —— 更危险的是反过来：若内层恰好长得像
 * 期望形状，就成了假绿。
 *
 * 也不能用 `GROUP BY` 当尾锚：员工榜的 CTE 内有 `GROUP BY spia.employee_id`，它在外层
 * WHERE **之前**，会把外层 WHERE 整个切掉。
 *
 * 外层 `ORDER BY` 是唯一可靠的尾锚（两端排行榜都以它收尾，CTE 内不出现排序）；
 * staff 端排序经插值函数 `${staffOrderBy(<value 表达式>)}` 拼出，一并识别。取尾锚之前的**最后一个** WHERE。
 */
const ORDER_BY_ANCHOR = /ORDER BY|\$\{staffOrderBy\(/g

/**
 * ★ `whereClauseOf` 的 fail-closed 前置条件（闸门 1 · boundary-critic P1-2 / P2-1，
 *   concurrency P2-2 / P2-3 —— 两个 reviewer 独立复现了同一族绕过）。
 *
 * 「取尾锚之前最后一个 WHERE」这套定位法**只在切片恰好是一个完整查询时**才等价于
 * 「最外层 WHERE」。实测有两条路径能让它静默放行：
 *
 *   1. **外层再包一层**：`SELECT * FROM (<原查询>) z WHERE z.value > 0`
 *      —— 新 WHERE 落在尾锚**之后**，被 `slice(0, anchor)` 整段丢弃 → GREEN
 *   2. **切片里混进两个查询**：切片锚点是「下一个查询的变量名」，在两个榜之间插入
 *      一个新榜，切片会同时含两个查询，取到的是**第一个**的 WHERE，新榜一字未检 → GREEN
 *      （新增 metric 是完全可预期的常规演进，不是刻意构造）
 *
 * 所以在抽 WHERE 之前先证明「这个切片只有一个查询、且尾锚之后没有过滤」。
 */
function assertSingleOuterQuery(segment: string, label: string): void {
  const anchors = segment.match(ORDER_BY_ANCHOR) ?? []
  expect(
    anchors.length,
    `${label} 的切片里出现了 ${anchors.length} 个 ORDER BY，期望恰好 1 个。两种成因：\n` +
      `  · 切片跨了多个查询（多半是在两个榜之间新增了 metric）—— 请同步给新榜补一条切片断言；\n` +
      '  · CTE 内引入了合法排序（窗口函数 / array_agg(... ORDER BY ...)）—— 请改用不含\n' +
      '    ORDER BY 字面量的写法，或重构本 helper 的尾锚策略。\n' +
      '无论哪种，都不能让入榜口径检查落到错误的 WHERE 上。',
  ).toBe(1)

  const anchorAt = segment.search(ORDER_BY_ANCHOR)
  expect(
    /\bWHERE\b/i.test(segment.slice(anchorAt)),
    `${label} 在 ORDER BY **之后**仍出现 WHERE —— 典型形态是把整个查询包一层\n` +
      '`SELECT * FROM (<原查询>) z WHERE z.value > 0`，它能在不动内层 WHERE 的前提下\n' +
      '重新按 value 剔行，等于静默回退 #290。',
  ).toBe(false)
}

/**
 * 抽出一个排行榜查询**最外层**的 `WHERE` 子句正文。
 *
 * ⚠️ 不能取第一个 `WHERE`：这些查询普遍带 CTE（`revenue_by_emp AS (... WHERE ...)`）与
 * 相关子查询（门店榜保有会员的 `EXISTS (... WHERE ...)`），第一个 WHERE 必落在内层，
 * 拿它去比对外层口径会得到「口径没守住」的假红 —— 更危险的是反过来：若内层恰好长得像
 * 期望形状，就成了假绿。
 *
 * 也不能用 `GROUP BY` 当尾锚：员工榜的 CTE 内有 `GROUP BY spia.employee_id`，它在外层
 * WHERE **之前**，会把外层 WHERE 整个切掉。
 *
 * 以**唯一的** `ORDER BY` 为尾锚（唯一性由 `assertSingleOuterQuery` 先行保证），
 * 取其之前的最后一个 WHERE。staff 端排序经插值函数 `${staffOrderBy(<value 表达式>)}` 拼出，一并识别。
 */
function whereClauseOf(segment: string, label: string): string {
  assertSingleOuterQuery(segment, label)
  const tailAnchor = segment.search(ORDER_BY_ANCHOR)
  expect(tailAnchor, `${label} 找不到外层 ORDER BY，无法定位最外层 WHERE`).toBeGreaterThan(-1)
  const outer = segment.slice(0, tailAnchor)
  const from = outer.lastIndexOf('WHERE ')
  expect(from, `${label} 找不到外层 WHERE`).toBeGreaterThan(-1)
  const raw = outer.slice(from + 'WHERE '.length)
  // 门店榜是 `WHERE <scope> GROUP BY ... ORDER BY ...`，需再截掉 GROUP BY 尾巴；
  // 员工榜外层无 GROUP BY（CTE 内那个在本切片起点之前），此处对它是 no-op。
  const groupBy = raw.search(/GROUP BY/)
  return (groupBy === -1 ? raw : raw.slice(0, groupBy)).trim()
}

/**
 * ★ 金额/次数列**不得设正值下界**（闸门 1 · boundary-critic P2-2）。
 *
 * 前面所有守护都盯着**外层** WHERE，对 metric CTE 内部完全失明。在
 * `revenue_by_emp` / `consume_by_emp` / `sales_comm` / `service_comm` 任一 CTE 里追加
 * `AND spia.allocated_amount > 0`，退款负行会在**聚合前**被剔除 —— 员工净额由负转正，
 * 而外层 WHERE 一字未动、全部形状断言照绿。这与 #290 是同一个缺陷，只是下沉了一层。
 *
 * Part A/B/C 侧由 `assertEverySpeRefClassified` 堵这一层（fail-closed 要求每个 `spe.*`
 * 引用都能被归类），但 Part D 走的是 `spia` / `sc` / `sit`，没有对应分类器。
 *
 * 注：`${producerCte}` 在切片里是**插值引用**而非展开文本，故候选池里那句
 * `cardinality(sw.skills) > 0` 不在扫描范围内，不会误伤。
 */
// ⚠️ 闸门 2 round-1 GLM：原正则要求金额列**紧跟**比较符，隔一个 `)` 或 `,` 即穿透 ——
// `AND COALESCE(spia.allocated_amount, 0) > 0` 就能绕过。现放宽为「列名与 `> 0` 之间
// 允许若干包装字符（不跨行、不跨比较符）」，覆盖 COALESCE/GREATEST/NULLIF 等常见包装。
// 正向的聚合输出行钉死见 assertCteAggregateShape —— 反向枚举只作辅助。
const AMOUNT_FLOOR_RE =
  /\b\w+\.(?:allocated_amount|commission_amount|session_used|unit_real_price|amount|received)\b[^><\n]{0,40}>=?\s*0/i

function assertNoAmountFloorInCte(segment: string, label: string): void {
  const hit = segment.match(AMOUNT_FLOOR_RE)
  expect(
    hit?.[0] ?? null,
    `${label} 对金额/次数列设了正值下界（命中：${hit?.[0]}）。这会在聚合前剔掉退款负行，` +
      '让员工净额由负转正 —— 与 #290 同型，只是下沉到 CTE 层，外层 WHERE 形状断言看不见它。',
  ).toBeNull()
}

/**
 * ★ metric CTE 的聚合输出行**正向钉死**（闸门 2 round-1 GLM P1-2）。
 *
 * 外层 WHERE 有正向形状钉死（`assertStaffRankAdmissionShape`），所以那一层可以放弃反向枚举；
 * 但 CTE 层此前**只有反向枚举**（`AMOUNT_FLOOR_RE`），防护是不对称的 —— 而反向枚举
 * 永远列不完：`COALESCE(x, 0) > 0`、`GREATEST(SUM(...), 0)`、`>= 1`、`FILTER (WHERE ...)`
 * 都能在不动外层的前提下把退款负行在聚合前剔掉，让榜上显示 0.00、负额被吞。
 *
 * 这里改为正向：每个 `AS v` 输出列必须是「裸聚合 + COALESCE 兜底」这几种已知形态之一，
 * 多包一层函数、挂 FILTER、换成条件聚合，都会红。
 */
const CTE_AGG_SHAPES = [
  /^COALESCE\(SUM\([^()]*(?:\([^()]*\)[^()]*)*\), 0\)$/, // COALESCE(SUM(<表达式>), 0)
  /^COUNT\(\*\)$/, // 新会员榜
  /^COUNT\(DISTINCT [\w.]+\)$/, // staff 客流榜（admin 无此 metric）
]
// 注：两种 COUNT 形态恒非负，本就不存在「聚合前剔掉退款负行」的风险；
// 收紧它们只是为了让白名单闭合 —— 换成 SUM 类聚合时必须回来改这条断言。

/** 聚合内部禁止出现的**条件构造** —— 它们能在不改变外层形态的前提下把负值转成 0 */
/** 金额/次数列参与比较（任一侧）—— 它们只应出现在聚合表达式内 */
const AMOUNT_IN_PREDICATE_RE = new RegExp(
  '\\b\\w+\\.(?:allocated_amount|commission_amount|session_used|unit_real_price|amount|received)\\b\\s*(?:=|<>|<=|>=|<|>)' +
    '|(?:=|<>|<=|>=|<|>)\\s*\\w*\\(?\\s*\\w+\\.(?:allocated_amount|commission_amount|session_used|unit_real_price|amount|received)\\b',
  'i',
)

const COND_IN_AGG_RE = /\b(?:CASE|WHEN|FILTER|NULLIF|GREATEST|LEAST|SIGN|ABS|ROUND|FLOOR|CEIL|CEILING)\b/i

function assertCteAggregateShape(segment: string, label: string): void {
  // ⚠️ 起点必须锚到 `SELECT ` 或 `, `：否则 `[A-Za-z_][\w.]*\(` 会从片段最前面的
  // `db.execute(` / `pg.query(` 开始匹配，一路吞到 `AS v`，把整段当成"聚合表达式"。
  const outputs = [
    ...segment.matchAll(/(?:SELECT|,)\s+([A-Za-z_][\w.]*\((?:[^()]|\([^()]*\))*\))\s+AS v\b/g),
  ].map((m) => m[1].replace(/\s+/g, ' ').trim())

  // ★ 计数对账（闸门 2 round-2 codex P1）：提取器只支持两层括号嵌套，
  // `GREATEST(COALESCE(SUM(x), 0), 0) AS v` 这类三层包装会被**静默跳过** ——
  // 而只要同切片内还有另一个合法 `AS v`（收入榜就有两个），`outputs.length > 0`
  // 依然成立，整条守护假绿、销售负提成被钳成零。故必须证明「一个都没漏抽」。
  const declared = (segment.match(/\bAS v\b/g) ?? []).length
  expect(
    outputs.length,
    `${label} 有 \`AS v\` 输出列没被提取到（声明 ${declared} 个，只抽到 ${outputs.length} 个）。` +
      '多半是被外层函数包了一层（如 GREATEST(COALESCE(SUM(...), 0), 0)）导致嵌套超出提取器能力 —— ' +
      '这正是需要被拦下的形态，不能因为"抽不到"就放行。',
  ).toBe(declared)
  expect(declared, `${label} 抽不到任何 \`AS v\` 聚合输出列 —— 切片结构变了（fail-closed）`).toBeGreaterThan(0)

  for (const out of outputs) {
    expect(
      CTE_AGG_SHAPES.some((re) => re.test(out)),
      `${label} 的 CTE 聚合输出列形态变了：\`${out}\`。\n` +
        '只允许 `COALESCE(SUM(<表达式>), 0)` / `COUNT(*)` / `COUNT(DISTINCT <列>)`。',
    ).toBe(true)
    // ★ SUM 内部此前几乎不受约束（闸门 2 round-2 codex P1）：
    // `COALESCE(SUM(CASE WHEN spia.allocated_amount < 0 THEN 0 ELSE ... END), 0)`
    // 完全符合上面的白名单形态，却把退款负行就地转成 0 —— 与 #290 等效。
    expect(
      COND_IN_AGG_RE.test(out),
      `${label} 的聚合内部出现条件构造：\`${out}\`。CASE/WHEN/FILTER/NULLIF/` +
        'GREATEST/LEAST/SIGN 都能在不改变外层形态的前提下把负值转成 0，等同于 #290 原缺陷。',
    ).toBe(false)
  }
}

/**
 * ★ 排序表达式必须与该榜的 WHERE 表达式**逐字一致**（闸门 2 round-2 codex P1）。
 *
 * 此前只检查了「ORDER BY 首键长成 `(<某个展开表达式> <> 0) DESC`」与
 * 「staffOrderBy 的模板形状 + 调用次数」，**从未比较它与 WHERE 用的是不是同一个表达式**。
 * （更糟的是当时的注释还提到了一个根本不存在的 `assertOrderMatchesWhere`。）
 *
 * 复现：把 staff revenue 的调用改成 `staffOrderBy('COALESCE(r.v, 1)')` ——
 * helper 模板断言、六次调用计数、排序正则全部通过，但无产能员工的排序值变成 1，
 * 重新排到负值员工之前，`(value <> 0)` 首键形同虚设。
 */
function assertOrderMatchesWhere(segment: string, label: string): void {
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
  /** 去掉 ::cast 与最外层冗余括号，让 SELECT / WHERE / ORDER BY 三处可比 */
  const canon = (x: string) => {
    let v = norm(x).replace(/::\w+\s*$/, '').trim()
    while (/^\(([\s\S]*)\)$/.test(v)) {
      const inner = v.slice(1, -1)
      let d = 0
      let balanced = true
      for (const ch of inner) {
        if (ch === '(') d++
        else if (ch === ')') d--
        if (d < 0) { balanced = false; break }
      }
      if (!balanced || d !== 0) break
      v = inner.trim()
    }
    return v
  }

  const whereExpr = whereClauseOf(segment, label).match(
    /^\(\s*pe\.has_skills\s+OR\s+([\s\S]+?)\s*<>\s*0\s*\)$/,
  )?.[1]
  expect(whereExpr, `${label} 的 WHERE 里抽不出 value 表达式（形状已被上游断言保证）`).toBeTruthy()
  const base = canon(whereExpr!)

  // ★ 外层 SELECT 的 `AS value` 也必须是同一个表达式（闸门 2 round-3 GLM P1-1）：
  // 把它改成 `GREATEST(COALESCE(r.v, 0), 0)::numeric AS value` 时，行数、名次、排序全对，
  // 唯独**显示值被钳成 0.00** —— 负值员工照常在榜，修复却在 UI 层静默归零。
  // 本文件 Part C 侧早为同型风险加过 `assertPlainSumAggregate` 的 GREATEST 防线，员工榜外层此前完全空白。
  // ⚠️ 必须从 `AS value` **反向**找最近的逗号：正向 `/,\s*([\s\S]+?)\s+AS value/` 会从
  // 片段最前面的逗号开始匹配，把整段 CTE 当成"输出表达式"。
  const asValueAt = segment.indexOf(' AS value')
  expect(asValueAt, `${label} 找不到外层 SELECT 的 \`AS value\`（fail-closed）`).toBeGreaterThan(-1)
  const beforeAsValue = segment.slice(0, asValueAt)
  // 再反向扫出**括号深度为 0** 的那个逗号：`COALESCE(r.v, 0)` 内部也有逗号，
  // 裸 lastIndexOf(',') 会切在它上面，只抽到 `0)`。
  let depth = 0
  let commaAt = -1
  for (let i = beforeAsValue.length - 1; i >= 0; i--) {
    const ch = beforeAsValue[i]
    if (ch === ')') depth++
    else if (ch === '(') depth--
    else if (ch === ',' && depth === 0) {
      commaAt = i
      break
    }
  }
  expect(commaAt, `${label} 定位不到 \`AS value\` 所属的输出列（fail-closed）`).toBeGreaterThan(-1)
  const selectExpr = beforeAsValue.slice(commaAt + 1)
  expect(selectExpr, `${label} 抽不到外层 SELECT 的 \`AS value\` 输出列（fail-closed）`).toBeTruthy()
  expect(
    canon(selectExpr!),
    `${label} 外层 SELECT 的 value 表达式与 WHERE 用的不是同一个。` +
      '任何包装（GREATEST/ABS/ROUND…）都会让负值在**显示层**归零 —— 行还在、数字没了。',
  ).toBe(base)

  const staffCall = segment.match(/\$\{staffOrderBy\('([^']*)'\)\}/)
  if (staffCall) {
    expect(
      canon(staffCall[1]),
      `${label} 传给 staffOrderBy 的表达式与 WHERE 用的不是同一个 —— 排序会按另一个值算`,
    ).toBe(base)
    return
  }
  const orderExpr = segment
    .slice(segment.search(ORDER_BY_ANCHOR))
    .match(/^ORDER BY \(\s*([\s\S]+?)\s*<>\s*0\s*\)\s+DESC,\s*([\s\S]+?)\s+DESC,/)
  expect(orderExpr, `${label} 的 ORDER BY 首键形状不可解析`).toBeTruthy()
  expect(
    [canon(orderExpr![1]), canon(orderExpr![2])],
    `${label} 的 ORDER BY 表达式与 WHERE 用的不是同一个 —— 排序会按另一个值算`,
  ).toEqual([base, base])
}

/**
 * ★ metric CTE 与候选池 CTE 的 **WHERE 不得出现任何数值比较**（闸门 2 round-3 GLM P1-2/P1-3）。
 *
 * 反向枚举列名（`AMOUNT_FLOOR_RE`）永远列不完，GLM 实测两条穿透：
 *   · `AND 0 < spia.allocated_amount` —— 比较符在列名**左侧**
 *   · `AND spia.allocated_amount BETWEEN 0.01 AND 1e9` —— 根本没有 `>` 字符
 * 还有 P1-3：在 `producer_base` 的 WHERE 追加 skills 判定，能把无标签员工**整池**吞掉，
 * 连「OR 非零」兜底要救的人一起拔除 —— 外层 `has_skills OR v<>0` 救不了已不在池里的人。
 *
 * 改为一刀切：这些 CTE 的合法谓词只有 `=` / `IN` / `IS [NOT] NULL` / `IS DISTINCT FROM` /
 * 时间列 `BETWEEN ${插值} AND ${插值}`。**任何**数值比较都判红，改动者必须回来说明理由。
 * 插值 `${...}` 先剔除再判（helper 内部的比较不算）。
 */
function assertCteWhereNoNumericCompare(segment: string, label: string): void {
  const names = [...new Set([...segment.matchAll(/(\w+) AS \(/g)].map((m) => m[1]))]
  expect(names.length, `${label} 抽不到任何 CTE 定义（fail-closed）`).toBeGreaterThan(0)
  for (const name of names) {
    const body = cteBodyOf(segment, name)
    if (!body) continue
    const w = body.indexOf('WHERE ')
    if (w === -1) continue
    const g = body.indexOf('GROUP BY', w)
    const rawWhere = body.slice(w + 'WHERE '.length, g === -1 ? undefined : g)
    const where = rawWhere.replace(/\$\{[^}]*\}/g, ' ') // 插值 helper 内部不算

    // ★ 金额/次数列**不得参与任何比较**（闸门 2 round-4 codex P1-2/P1-3）。
    // 两条穿透了「禁 < >」这条：
    //   · `AND spia.allocated_amount = ABS(spia.allocated_amount)` —— 等式，无 `<`/`>` 字符
    //   · JOIN ON 里挂 `AND 0 < spia.allocated_amount` —— 在 WHERE **之前**，原扫描够不着
    // 故扫描范围从「WHERE 段」扩到「FROM → GROUP BY」全段（含所有 JOIN ON），
    // 判据改为「这些列只许出现在聚合表达式里，不许出现在任何比较的任一侧」。
    const fromAt = body.indexOf('FROM ')
    if (fromAt !== -1) {
      const predicateArea = body
        .slice(fromAt, g === -1 ? undefined : g)
        .replace(/\$\{[^}]*\}/g, ' ')
      const hit = predicateArea.match(AMOUNT_IN_PREDICATE_RE)
      expect(
        hit?.[0] ?? null,
        `${label} 的 CTE \`${name}\` 让金额/次数列参与了比较（命中：${hit?.[0]}）。\n` +
          '这些列只应出现在聚合表达式内。出现在 WHERE 或 JOIN ON 的任一侧，' +
          '都会在聚合前剔掉退款负行 —— 等式（`= ABS(x)`）与反向不等式（`0 < x`）同样致命。',
      ).toBeNull()
    }

    expect(
      /[<>]/.test(where),
      `${label} 的 CTE \`${name}\` 的 WHERE 出现数值比较：\`${rawWhere.trim()}\`。\n` +
        '这些 CTE 只允许 = / IN / IS [NOT] NULL / IS DISTINCT FROM / 时间 BETWEEN ${插值}。\n' +
        '任何数值比较都可能在聚合前剔掉退款负行（或把无标签员工整池吞掉），与 #290 同型。',
    ).toBe(false)

    // BETWEEN 必须在**原始** WHERE 上判（插值已被替换成空格，替换后判会抓到 `AND`）：
    // 左端点必须是 ${} 插值，杜绝 `allocated_amount BETWEEN 0.01 AND 1e9` 这类数值下界。
    for (const m of rawWhere.matchAll(/BETWEEN\s+(\S+)/g)) {
      expect(
        m[1].startsWith('${'),
        `${label} 的 CTE \`${name}\` 出现字面量 BETWEEN（\`${m[0]}\`）—— ` +
          '时间窗必须走 ${} 插值；对金额列做 BETWEEN 等同于设下界',
      ).toBe(true)
    }
  }
}

/**
 * ★ 时间窗端点必须是 `${cur.start}` → `${cur.end}`（闸门 2 round-3 GLM P2-6）。
 *
 * 把 `BETWEEN ${cur.start} AND ${cur.end}` 写成 `AND ${cur.start}` 会让区间塌成一天，
 * 退款负行落到窗外 → 员工净额由负转正。Part C 侧早有同型端点断言，Part D 此前零守护。
 */
function assertTimeWindowEndpoints(segment: string, label: string): void {
  const spans = [...segment.matchAll(/BETWEEN\s+\$\{([^}]*)\}\s+AND\s+\$\{([^}]*)\}/g)]
  // ★ fail-closed（闸门 2 round-4 codex P1-4）：零命中不能算通过 ——
  // 把 `service_date BETWEEN ${cur.start} AND ${cur.end}` 改成 `service_date = ${cur.end}`
  // 时本函数一条都抽不到，for 循环空转即绿，而该榜区间已缩成一天。
  // 业绩/收入榜的时间窗走 helper 插值（admin `performanceEventDateBetween`、
  // staff `performanceEventPeriodWindow`），不是字面 BETWEEN —— 两种形式都算数。
  // admin: performanceEventDateBetween / 字面 BETWEEN；
  // staff: performanceEventPeriodWindow（业绩、收入）、timeWindowPeriod（实耗、项目数、客流、新会员）
  const viaHelper =
    /\$\{(?:performanceEvent(?:DateBetween|PeriodWindow)|timeWindowPeriod)\(/.test(segment)
  expect(
    spans.length > 0 || viaHelper,
    `${label} 既无 \`BETWEEN \${...} AND \${...}\` 字面时间窗、也不走 performanceEvent* / timeWindowPeriod helper ` +
      '—— 多半是被改成了单点等值（区间缩成一天，退款负行落到窗外）。',
  ).toBe(true)
  for (const m of spans) {
    expect(
      [m[1].trim(), m[2].trim()],
      `${label} 的时间窗端点不是 cur.start → cur.end（实得 ${m[1]} → ${m[2]}）—— ` +
        '区间被截窄会让退款负行落在窗外，净额由负转正',
    ).toEqual(['cur.start', 'cur.end'])
  }
}

/**
 * ★ 排序首键必须是「非零优先」（2026-09-24 用户拍板，#290）。
 *
 * 入榜口径放开后，「有标签但本期零产能」的员工大量进榜 —— 生产实测本月业绩榜 94 行、
 * **今日视图 247 行**为 0.00。此时纯 `ORDER BY value DESC` 会把本次要救的负值员工
 * 压到那些 0.00 行**之下**（实测第 252/253 名），修复反而比修复前更难被看见。
 *
 * 加 `(value <> 0) DESC` 首键后：正值 1~157 → 负值 158/159 → 零值并列垫底。
 * 去掉它不会让任何行消失、不会让任何断言红，却会让本次修复的可见性归零 ——
 * 属于「静默削弱」类回归，故必须正面钉死。
 *
 * staff 侧排序经插值函数 `${staffOrderBy(...)}` 拼出，切片里看不到字面量，
 * 由下方单独一条 it 校验常量定义本身。
 */
function assertZeroLastOrdering(segment: string, label: string): void {
  // staff 切片走 ${staffOrderBy(...)} 插值，由单独一条 it 校验函数定义本身。
  // ⚠️ fail-closed：两种锚都找不到时必须红，不能静默跳过（闸门 2 round-1 GLM P3）——
  // 否则 admin 将来若也重构成插值 helper，排序首键检查会无声消失。
  if (!segment.includes('ORDER BY')) {
    expect(
      /\$\{staffOrderBy\(/.test(segment),
      `${label} 既无 ORDER BY 字面量、也不走 staffOrderBy 插值 —— 排序守护无从施加`,
    ).toBe(true)
    return
  }
  const at = segment.indexOf('ORDER BY')
  const clause = segment.slice(at + 'ORDER BY'.length).replace(/`\)[\s\S]*$/, '').trim()
  expect(
    clause,
    `${label} 的排序首键不再是「非零优先」。缺了 (value <> 0) DESC，零产能员工会排在` +
      '负值员工**之前**（实测把负值压到第 252/253 名），本次修复在 UI 上等于白做。',
    // ⚠️ 必须是**展开的数值表达式**，不能是 SELECT 别名 `value`：PG 只允许别名作为
    // 独立排序项，参与表达式时按真实列解析 → `column "value" does not exist`
    //（闸门 2 round-1 codex 抓到，当时本断言反把无效语法钉死了）。
    // 同时要求排序表达式与该榜 WHERE 里的表达式一致（下方 assertOrderMatchesWhere）。
  ).toMatch(/^\((?!\s*value\s*<>)[^)]*(?:\)[^)]*)*?<>\s*0\)\s+DESC\s*,/)
}

/**
 * 按**括号配对**取出 `<name> AS ( ... )` 的完整 CTE 体。
 * 正则做不到：CTE 体内有嵌套括号（JOIN/函数调用），`[\s\S]*?\)` 会在第一个 `)` 就停。
 *
 * ⚠️ 已知限制：**不感知字符串字面量**。生产 SQL 里的字面量（'销售单' 等）都不含括号，
 * 故现状正确；将来若 CTE 内出现含 `(` / `)` 的字面量，本函数会返回 null 或截断片段 ——
 * 两个失效方向都是 fail-closed（断言判红），但报错会是费解的「不是本切片内定义的 CTE」。
 */
function cteBodyOf(segment: string, name: string): string | null {
  const head = `${name} AS (`
  const start = segment.indexOf(head)
  if (start === -1) return null
  let depth = 1
  let i = start + head.length
  while (i < segment.length && depth > 0) {
    if (segment[i] === '(') depth++
    else if (segment[i] === ')') depth--
    i++
  }
  return depth === 0 ? segment.slice(start, i) : null
}

/**
 * ★ 员工榜的 metric JOIN 形状（闸门 1 · concurrency P2-2 判定为**最危险**的一条）。
 *
 * 两条绕过路径，都能在**完全不动外层 WHERE** 的前提下回滚本次修复：
 *
 *   1. **把过滤挪进 ON**：`LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id AND r.v > 0`
 *      —— ON 不满足时 LEFT JOIN 产出 NULL → `COALESCE(r.v, 0)` 兜成 0：
 *      无标签者被外层 WHERE 剔除，**有标签者的 `value` 被静默篡改成 0.00**，
 *      负值员工的金额直接消失。这是最像"性能优化"的一种写法。
 *   2. **`LEFT JOIN` 退化成 `JOIN`** —— 比原缺陷更糟：连"有标签零值"者也全部掉榜，
 *      而 WHERE 形状逐字未变，形状断言照绿。
 *
 * 故此处钉死：`FROM producer_employees pe` 之后的每个 JOIN 都必须是 `LEFT JOIN`，
 * 且每个 `ON` 子句**有且仅有** `<别名>.employee_id = pe.employee_id` 一项。
 */
function assertMetricJoinShape(segment: string, label: string): void {
  const fromAt = segment.indexOf('FROM producer_employees pe')
  expect(fromAt, `${label} 找不到 FROM producer_employees pe`).toBeGreaterThan(-1)
  const anchorAt = segment.search(ORDER_BY_ANCHOR)
  const joinArea = segment.slice(fromAt, anchorAt === -1 ? undefined : anchorAt)

  expect(
    /(?<!LEFT\s)(?<!LEFT OUTER\s)\bJOIN\b/i.test(joinArea),
    `${label} 的 metric 关联出现了非 LEFT 的 JOIN —— 内连接会把「有技能标签但本期零产能」` +
      '的员工整体剔除，比 #290 原缺陷更狠，且外层 WHERE 形状逐字未变、形状断言发现不了。',
  ).toBe(false)

  // 用 [\s\S] 而非 `.` + `s` 标志：dotAll 需要 target es2018+，本仓 tsconfig 低于该版本
  // （vitest/esbuild 不校验、`tsc --noEmit` 会报 TS1501，两道关卡口径不同）
  // ⚠️ JOIN 数据源必须是裸 CTE 名，不能是内联子查询：
  // `LEFT JOIN (SELECT * FROM revenue_by_emp WHERE v > 0) r ON r.employee_id = pe.employee_id`
  // 能同时通过「是 LEFT JOIN」「ON 只有 employee_id」两条，却让负值关联落空、
  // 有标签员工的 value 被篡改成 0.00（闸门 2 round-1 codex）。
  expect(
    /\bLEFT JOIN\s*\(/i.test(joinArea),
    `${label} 的 metric 关联用了**内联子查询**做数据源。子查询里可以藏任意 value 过滤，` +
      '而 JOIN 类型与 ON 正文两条断言都看不见它 —— 数据源必须是裸 CTE 名。',
  ).toBe(false)

  // ★ 关联的必须是本切片内定义的**聚合** CTE（闸门 2 round-2 codex P1）：
  // 新增一个转发 CTE `positive_revenue_by_emp AS (SELECT * FROM revenue_by_emp WHERE v > 0)`
  // 再 `LEFT JOIN positive_revenue_by_emp r` —— 它仍是裸 CTE 名、仍是 LEFT JOIN、
  // ON 仍只有 employee_id，全部既有断言通过，负值却在转发层被剔掉、兜成 0。
  // 判据：切片内每个 CTE 定义都必须是真聚合（含 GROUP BY），转发 CTE 没有 GROUP BY。
  // `AS <别名>` 是合法写法，正则必须认（闸门 2 round-3 GLM P2-5：不认则多 JOIN 榜只抽到一个就放行）
  const joined = [...joinArea.matchAll(/LEFT JOIN\s+(\w+)\s+(?:AS\s+)?\w+\s+ON/gi)].map((m) => m[1])
  const joinCount = (joinArea.match(/\bLEFT JOIN\b/gi) ?? []).length
  expect(
    joined.length,
    `${label} 有 LEFT JOIN 没被提取到（共 ${joinCount} 个，只抽到 ${joined.length} 个）—— 漏掉的那个不受来源校验`,
  ).toBe(joinCount)
  expect(joined.length, `${label} 抽不到 LEFT JOIN 的 CTE 名（fail-closed）`).toBeGreaterThan(0)
  for (const name of joined) {
    const body = cteBodyOf(segment, name)
    expect(body, `${label} 关联的 \`${name}\` 不是本切片内定义的 CTE —— 来源不可验`).toBeTruthy()
    expect(
      /\bGROUP BY\b/i.test(body!),
      `${label} 关联的 CTE \`${name}\` 没有 GROUP BY —— 它是**转发 CTE**（如 ` +
        '`SELECT * FROM revenue_by_emp WHERE v > 0`），可以在不动任何既有断言的前提下' +
        '把负值行剔掉。metric 关联必须直接指向做聚合的那个 CTE。',
    ).toBe(true)
  }

  const onClauses = [...joinArea.matchAll(/\bON\s+([\s\S]+?)(?=\s*(?:LEFT JOIN|JOIN|WHERE)\b|$)/gi)]
  expect(
    onClauses.length,
    `${label} 没抽到任何 JOIN ... ON —— 切片结构变了，本断言可能已失效（fail-closed）`,
  ).toBeGreaterThan(0)
  for (const m of onClauses) {
    expect(
      m[1].trim(),
      `${label} 的 JOIN ON 里混入了关联之外的条件。把 value 过滤挪进 ON（如 ` +
        '`AND r.v > 0`）会让 LEFT JOIN 落空、COALESCE 兜成 0，从而**静默篡改榜单数值**' +
        '而不改变行数 —— 外层 WHERE 形状断言对此完全失明。',
    ).toMatch(/^\w+\.employee_id\s*=\s*pe\.employee_id$/)
  }
}

/**
 * ★ #290 —— 员工榜（Part D）的入榜口径，**正向钉死整个 WHERE 形状**。
 *
 * 规则：`WHERE (pe.has_skills OR COALESCE(<别名>.v, 0) <> 0)`，收入榜是两项相加。
 * 有且仅有这一项 —— 追加任何 `AND ...` 都会红。
 *
 * ⚠️ 为什么钉形状而不是反向禁 `> 0`：反向列举挡不完（`>= 1`、`> 0.0`、`FILTER`、
 * `HAVING`、`GREATEST(...,0)`、把值包进函数……本文件 Part C 侧为此积累了六层守护，
 * 每一层都是被闸门 2 打穿后补的）。正向钉死「WHERE 必须逐字长这样」是 fail-closed 的：
 * 任何改动都必须回来改这条断言并说明为什么安全。
 */
function assertStaffRankAdmissionShape(segment: string, label: string): void {
  // ⚠️ 结果集完整性：`:492` 的同族禁令只喂了 Part A/B/C 三个切片，**不覆盖员工榜**。
  // 本改动把负值员工放进榜单，而排序是 `ORDER BY value DESC` —— 负值必然排在**最末**。
  // 此时给员工榜加 `LIMIT 20`（"253 行太长了截断一下" 是本改动后最可能的后续优化，
  // 且看起来完全无害）会**第一个砍掉负值行**，把本次修复静默抹掉，而其余守护一条都不会红。
  // `:493-495` 早已预言过这个形态（"给排行榜加 LIMIT 10 是极常见的首屏优化"），
  // 只是当时没把 Part D 纳进去。
  expect(
    /\b(?:LIMIT|OFFSET|FETCH|HAVING)\b/i.test(segment),
    `${label} 出现 LIMIT/OFFSET/FETCH/HAVING —— 员工榜按 value DESC 排序，负值恒在末尾，` +
      '任何截断或聚合级剔行都会优先吃掉它们，等于回退 #290',
  ).toBe(false)
  // 同族防线：外层 WHERE 形状对 CTE 内部与 JOIN ON 都完全失明，各堵一道
  assertNoAmountFloorInCte(segment, label)
  assertCteWhereNoNumericCompare(segment, label)
  assertTimeWindowEndpoints(segment, label)
  assertCteAggregateShape(segment, label)
  assertMetricJoinShape(segment, label)
  assertZeroLastOrdering(segment, label)
  assertOrderMatchesWhere(segment, label)
  expect(
    whereClauseOf(segment, label),
    `${label} 的入榜口径变了。必须是「有技能标签者无条件入榜（含零值/负值），` +
      '无标签者仅在有非零产能时入榜」；任何按 value 设下界的写法都会重新吞掉退款净额为负的员工' +
      '（#290：2026-09-01~22 实测 2 人、−10,902.00），与同板块门店榜规则分裂',
  ).toMatch(
    // 空白放宽为 \s+/\s*：income 那行已 68 字符，手动折行不该判红（fail-closed 方向不变，
    // 因为形状仍被 ^...$ 逐项锚定，只是不再对空格数量斤斤计较）
    /^\(\s*pe\.has_skills\s+OR\s+COALESCE\(\s*\w+\.v\s*,\s*0\s*\)(?:\s*\+\s*COALESCE\(\s*\w+\.v\s*,\s*0\s*\))?\s*<>\s*0\s*\)$/,
  )
}

/**
 * ★ #290 —— 门店榜（Part C）对照面：**不得按 value 剔任何行**。
 *
 * 门店榜的 WHERE 有且仅有 scope 一项（业务过滤在 JOIN ON 里），零值/负值门店照常出行。
 * 2026-09-01~22 实测：43 家门店全部出行（35 正 / 7 零 / 1 负）。
 * 这是 AC4「两榜零值/负值处理规则一致」的另一半 —— 员工榜守 has_skills OR ≠0，
 * 门店榜守「压根不按 value 过滤」，两条合起来才叫规则一致。
 */
function assertStoreRankNoValueCutoff(segment: string, label: string): void {
  // ⚠️ `:492` 的同族禁令在门店榜侧也只喂了 `qStoreRankRevenue` 一个切片，
  // 另外四个（consume / retainedMember / newMember / projectCount）此前无守护。
  // 本 helper 本就遍历全部 5 个切片，顺手覆盖成本为零 ——「站在缺口正上方不补」是闸门 1 的原话。
  expect(
    /\b(?:LIMIT|OFFSET|FETCH|HAVING)\b/i.test(segment),
    `${label} 出现 LIMIT/OFFSET/FETCH/HAVING —— 门店榜不得截断或按聚合值剔行` +
      '（会吞掉净额为负的门店，并让门店榜合计 ≠ KPI 分子）',
  ).toBe(false)
  expect(
    whereClauseOf(segment, label),
    `${label} 的 WHERE 只允许 scopeFilterSql 一项；任何 value 过滤都会让门店榜` +
      '与员工榜的零值/负值规则重新分裂（#290 AC4）',
  ).toBe("${scopeFilterSql(session, scope, 's.store_id')}")
}

describe('数据中心人效板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let salesSrc: string
  let techSrc: string
  let adminBody: string
  let staffBody: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_EFFICIENCY, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
    salesSrc = fs.readFileSync(ADMIN_SALES, 'utf-8')
    techSrc = fs.readFileSync(TECHNICIAN_SQL, 'utf-8')
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

    it('sales.ts runStoreRevenue 同谓词集（efficiency.ts 注释自称与它对齐，这里把该声称变成守护）', () => {
      // 本文件原本**不读** sales.ts，而 efficiency.ts 的注释声称「四处同源」。
      // consistency.sales.test.ts 确实独立守着 sales.ts（实测删掉它的 '充值单' 会红），
      // 但两边各持一份谓词清单、互不为超集 —— 给 sales.ts 加第 4 种单据类型并同步改它自己的
      // 测试后，efficiency.ts 这边仍全绿，四处同源的声称就悄悄失效了。这条让本文件成为超集。
      expectStoreRankCashflow(salesSrc, 'const runStoreRevenue', 'const runShengmeiRevenue')
    })

    it('Part B 分组列用 spe.store_id（与 Part C 同源；视图里它就是 so.store_id 的投影，定义恒等）', () => {
      const n = sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore')
      expect(n).toMatch(/GROUP BY spe\.store_id/i)
      expect(n).not.toMatch(/GROUP BY so\.store_id/i)
    })

    it('⭐ Part A / Part B / Part C 的 spe 谓词集**完全相等**（不只是「都存在」）', () => {
      // 闸门 2 两个谱系独立打穿了旧守护：
      //   codex —— 给 Part C 加聚合级 FILTER (WHERE spe.amount > 0) → 全绿
      //   GLM  —— 给 Part A 和 B **同时**加 AND spe.change_type <> '退款' → 全绿
      // 逐条 toMatch 证明不了「没多出别的」，A==B 在两边一起改时也失效。
      const a = spePredicateSet(sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal'))
      const b = spePredicateSet(sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore'))
      const c = spePredicateSet(sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume'))

      expect(a.length, 'Part A 至少应有 4 个 spe 业务谓词').toBeGreaterThanOrEqual(4)
      expect(b, 'Part B 的 spe 谓词集必须与 Part A 相同').toEqual(a)
      expect(c, 'Part C 门店排名榜的 spe 谓词集必须与 KPI 相同，否则「KPI == 门店榜」不成立').toEqual(a)
    })

    it('⭐ 三处的 WHERE 形状受约束（门店侧过滤也不许偷加）', () => {
      assertWhereShape(sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal'), 'spe-table', 'Part A')
      assertWhereShape(sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore'), 'spe-table', 'Part B')
      assertWhereShape(sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume'), 'store-table', 'Part C')
    })

    it('⭐ Part C 的时间区间端点精确（防 BETWEEN cur.start AND cur.start 这类笔误）', () => {
      // 闸门 2 round-12 codex：谓词集比较会把插值统一归一成 `${ts}`（因为 Part A/B 用
      // cur.start/cur.end、sales.ts 用 range.start/range.end，不归一就没法比），
      // 副作用是 `BETWEEN ${cur.start} AND ${cur.start}` 这种复制笔误与正确写法归一后相同，
      // 十一层全绿。这是正常开发真会出的错，且只需一条精确断言即可挡住。
      const c = sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume')
      expect(c, 'Part C 的 performance_date 区间端点写错了').toContain(
        'spe.performance_date BETWEEN ${cur.start} AND ${cur.end}',
      )
      // Part A/B 走 helper，端点由 helper 调用的字面量形态保证
      //（`performanceEventDateBetween('spe', cur.start, cur.end)`，见 expectStoreRankCashflow）
    })

    it('⭐ 三处的表骨架被钉死（防新增 JOIN 引入聚合扇出）', () => {
      // Part A/B 是 spe 单表，一个 JOIN 都不该有
      assertTableSkeleton(
        sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal'),
        ['sale_order_performance_events'],
        'Part A',
      )
      assertTableSkeleton(
        sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore'),
        ['sale_order_performance_events'],
        'Part B',
      )
      // Part C：stores 驱动 → 两级 org_nodes 拿市场名 → LEFT JOIN spe
      assertTableSkeleton(
        sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume'),
        ['stores', 'org_nodes', 'org_nodes', 'sale_order_performance_events'],
        'Part C',
      )
    })

    it('⭐ Part A/B/C 都不得出现 LIMIT / OFFSET / FETCH / HAVING（结果集完整性）', () => {
      // 闸门 2 收敛轮 codex 的发现，也是迄今**最现实**的一条：
      // 给门店排行榜加 `LIMIT 10` 是极常见的首屏优化，完全不是刻意构造的反常 SQL，
      // 但它会让「排行榜合计 == KPI 分子」直接失效，而前九层一条都不会红
      //（它们只约束聚合、spe 谓词、WHERE 形状与分母单源，**不约束结果集基数**）。
      //
      // `HAVING` 是下一轮 GLM 补的同族逃逸，且它更隐蔽：
      // `HAVING SUM(spe.amount) > 0`（**不带** `::numeric`）能让十层全绿 ——
      //   · 第 2 层谓词正则要求 `spe.<列>` 后紧跟运算符，这里跟的是 `)`，不被抽取
      //   · 第 6 层 fail-closed 的 `SUM(\s*spe.amount` 不要求 cast，把它也算成合法聚合
      //   · 第 9 层 WHERE 形状切到 `GROUP BY` 就停，HAVING 在其后
      // 写成带 `::numeric` 反而会被第 3 层拦下 —— 缺口恰在最自然的手写形态上。
      // 本仓 `product.ts` 曾有 `HAVING SUM(sipe.amount::numeric) > 0` 的先例（#288 已改为只剔除全零组）。
      for (const [label, seg] of [
        ['Part A', sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal')],
        ['Part B', sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore')],
        ['Part C', sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume')],
      ] as const) {
        expect(
          seg,
          `${label} 出现了 LIMIT/OFFSET/FETCH：排行榜一旦截断，其合计就不再等于 KPI 分子`,
        ).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|HAVING)\b/i)
      }
    })

    it('⭐ 三处都不得有**无法归类**的 spe.* 引用（fail-closed，防包装表达式逃逸）', () => {
      assertEverySpeRefClassified(sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal'), 'Part A')
      assertEverySpeRefClassified(sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore'), 'Part B')
      assertEverySpeRefClassified(sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume'), 'Part C')
    })

    it('⭐ 三处的聚合表达式都必须是裸 SUM(spe.amount::numeric)，不许挂 FILTER/CASE', () => {
      // codex 的攻击路径：Part C 单独写成 SUM(...) FILTER (WHERE spe.amount > 0) 剔除退款负行，
      // WHERE 谓词一个没动 → 上面所有谓词类断言全绿，但门店榜合计不再等于 KPI。
      assertPlainSumAggregate(sliceOrFail(adminSrc, 'const qRevenueTotal', 'const qConsumeTotal'), 'Part A')
      assertPlainSumAggregate(sliceOrFail(adminSrc, 'const qRevenueByStore', 'const qConsumeByStore'), 'Part B')
      assertPlainSumAggregate(sliceOrFail(adminSrc, 'const qStoreRankRevenue', 'const qStoreRankConsume'), 'Part C')
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

  describe('人均派生分母 = 产能技师，且必须纳入直挂市场/部门者（#285）', () => {
    // 员工组织归属双轨：store_id（门店 FK）+ org_node_id（组织节点 FK）。
    // 只按 store_id 过滤会漏掉直挂市场/部门的产能技师 —— 他们的产出落在门店上进了分子，
    // 人头却不进分母。2026-09 实测集团 150 vs 164、虚高 +9.33%。
    // 见 memory project-employee-org-direct-attach-market。

    it('technician_base 用 COALESCE(sw.store_id, ds.store_id) 回收直挂门店节点的人', () => {
      expect(techSrc).toMatch(/COALESCE\(\s*sw\.store_id\s*,\s*ds\.store_id\s*\)\s+AS store_id/i)
      expect(techSrc).toMatch(/LEFT JOIN stores ds ON ds\.org_node_id = sw\.org_node_id/i)
      expect(techSrc).toMatch(/skills && ARRAY\['美容师','养生师'\]/)
    })

    it('technician_scoped 保留 orgAnchorScopeSql 分支（无门店者按锚定市场判可见）', () => {
      expect(techSrc).toMatch(/tb\.store_id IS NOT NULL AND/i)
      expect(techSrc).toMatch(/tb\.store_id IS NULL AND/i)
      expect(techSrc).toMatch(/orgAnchorScopeSql\(session, scope, 'tb\.anchor_market_id'\)/)
    })

    it('by store / by market 两支互补不重叠', () => {
      const byStore = sliceOrFail(techSrc, 'export function technicianByStoreSql', 'export function technicianDirectByMarketSql')
      expect(byStore).toMatch(/WHERE store_id IS NOT NULL/i)
      expect(byStore).toMatch(/GROUP BY store_id/i)

      const byMarket = techSrc.slice(techSrc.indexOf('export function technicianDirectByMarketSql'))
      expect(byMarket).toMatch(/WHERE store_id IS NULL AND anchor_market_id IS NOT NULL/i)
      expect(byMarket).toMatch(/GROUP BY anchor_market_id/i)
      // market_name 必须带出：品项公司这类市场没有门店，拿不到 skelRows 的名字
      expect(byMarket).toMatch(/anchor_market_name/i)
    })

    /**
     * 消费端必须读**过滤后**的那张 CTE。
     *
     * `technician_base` 是未过滤人池、`technician_scoped` 才叠了 scope / 权限 / 启用门店。
     * #320 的双谱系评审第 4 轮先在 `technicianCountSql` 上抓到这个形态（改读 base → 任何角色
     * 任何 scope 都拿到全集团分母），第 5 轮 GLM 指出同胞的 byStore / byMarket 同样没人钉：
     * 改掉它们会让**分门店/分市场**技师分母变成全集团分布，分门店人均全错，
     * 而当时两端所有断言都不红。三个消费函数一起钉住。
     */
    it('⭐ 三个消费函数都必须复用 technicianCteSql 且只读过滤后的 technician_scoped', () => {
      const CONSUMERS = [
        ['technicianCountSql', 'export function technicianCountSql', 'export function technicianByStoreSql'],
        ['technicianByStoreSql', 'export function technicianByStoreSql', 'export function technicianDirectByMarketSql'],
      ] as const
      for (const [name, from, to] of CONSUMERS) {
        const body = sliceOrFail(techSrc, from, to)
        expect(body, `${name} 没复用 technicianCteSql 单源`).toContain(
          'WITH ${technicianCteSql(session, scope, endDate)}',
        )
        expect(body, `${name} 读的是未过滤的 technician_base`).toMatch(/FROM technician_scoped/)
        expect(body, `${name} 读的是未过滤的 technician_base`).not.toMatch(/FROM technician_base/)
      }
      // byMarket 是文件最后一个函数，没有下一个 marker 可切
      const byMarket = techSrc.slice(techSrc.indexOf('export function technicianDirectByMarketSql'))
      expect(byMarket).toContain('WITH ${technicianCteSql(session, scope, endDate)}')
      expect(byMarket).toMatch(/FROM technician_scoped/)
      expect(byMarket).not.toMatch(/FROM technician_base/)
    })

    it('⭐ 单源纪律：人效板与销售板都引用 technician-sql，且都不再自己扫 staff_wechat_users', () => {
      // 这条是 #285 闸门 2 codex P0 的回归守护：分母只修人效板会让同一个数据中心
      // 两个板块技师数差 14 人（人效 164 / 销售 150），而此前没有任何测试能发现。
      for (const [name, src] of [['efficiency.ts', adminSrc], ['sales.ts', salesSrc]] as const) {
        expect(src, `${name} 必须引用 technician-sql 单源`).toMatch(
          /from '@\/lib\/data-center\/technician-sql'/,
        )
        // 不能笼统禁 `FROM staff_wechat_users`：efficiency.ts 的 Part D `producer_base`
        // 合法地扫该表取员工榜人池（且刻意**不**按 skills 过滤）。
        // 「自己数技师」的特征签名是 skills 白名单——stripComments 后它只该出现在单源模块里。
        expect(
          normalize(stripComments(src)),
          `${name} 不得再自己按 skills 白名单数技师，口径只许来自 technician-sql`,
        ).not.toMatch(/skills && ARRAY\['美容师','养生师'\]/)
      }
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
    it('admin efficiency.ts Part E revenue_by_emp_cat 同为 allocation 口径', () => {
      // describe 标题写的是 Part D/E，就得真的覆盖 E —— Part E 是「按技师人效明细」，
      // 它与 Part D 同源但多一个 sales_category 维度，同样**不得**被改成 spe.amount。
      const n = sliceOrFail(adminSrc, 'revenue_by_emp_cat AS (', 'consume_by_emp_cat AS (')
      expect(n).toMatch(/SUM\(\s*spia\.allocated_amount::numeric\s*\)/i)
      expect(n).toMatch(/spia\.employee_id/i)
      expect(n).toMatch(/is_void\s*=\s*FALSE/i)
      expect(n).not.toMatch(/SUM\(spe\.amount::numeric\)/i)
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
    it('产能员工候选池不用 skills **白名单**截断（2026-05-20 起，两端一致）', () => {
      // 禁的是 `skills && ARRAY[...]` 这种**白名单截断**：2026-09-01~22 实测它会把
      // 品项老师 1,061,191.30 / 推广部 231,767.01 / 售前老师 97,728.00 共 139 万（27.8%）
      // 排出榜单，且与 2026-09-03「品项老师/养生部应当入榜」的放宽改造矛盾。
      //
      // ⚠️ 不禁 has_skills（skills 非空判定）：#290 起它是**入榜口径的左半边**，语义是
      // 「有技能标签 ⇒ 纳入产能考核、无条件入榜」，与白名单截断是两回事 —— 它不排除任何
      // 有产能事实的人（无标签但有非零产能者由 OR 右半边兜底）。`&&` 是数组重叠运算符，
      // 只会命中白名单写法，命不中 `IS NOT NULL AND cardinality(...)`。
      // 注：efficiency.ts 在「店长/技师头数」处仍合法使用 skills，故只校验 producer CTE 段落。
      const adminProducer = adminBody.match(/producer_employees\s+AS\s*\([^)]*?\)/i)?.[0] ?? ''
      const staffProducer = staffBody.match(/producer_employees\s+AS\s*\([^)]*?\)/i)?.[0] ?? ''
      expect(adminProducer).not.toMatch(/skills\s*&&/i)
      expect(staffProducer).not.toMatch(/skills\s*&&/i)
    })
    it('候选池带 has_skills 标记并透传给入榜口径，两端镜像（#290）', () => {
      for (const [body, label] of [
        [adminBody, 'admin efficiency.ts'],
        [staffBody, 'staff mgmt-dashboard.js'],
      ] as const) {
        expect(body, `${label} 的 producer_base 缺 has_skills 列`).toMatch(
          /\(COALESCE\(cardinality\(array_remove\(array_remove\(sw\.skills, ''\), NULL\)\), 0\) > 0\) AS has_skills/i,
        )
        expect(body, `${label} 的 producer_employees 没透传 has_skills`).toMatch(/pb\.has_skills/i)
      }
    })
  })

  /**
   * ★ #290 AC4：员工榜（Part D）与门店榜（Part C）的零值/负值处理规则必须一致。
   *
   * 两榜此前分裂：门店榜从不按 value 剔行（43 家全出行，含 7 零 1 负），员工榜却用
   * `WHERE COALESCE(v,0) > 0` 把净额为负的员工整行吞掉（实测 2 人、−10,902.00），
   * 与「退款负数冲销不删行」硬口径冲突。本组断言把两侧规则同时钉死。
   */
  describe('★ #290 入榜口径：员工榜与门店榜的零值/负值规则一致（两端镜像）', () => {
    it('admin Part D 五个员工榜：WHERE 逐字是 has_skills OR 非零', () => {
      const slices: Array<[string, string, string]> = [
        ['业绩', 'const qStaffRankRevenue', 'const qStaffRankConsume'],
        ['实耗', 'const qStaffRankConsume', 'const qStaffRankNewMember'],
        ['新会员', 'const qStaffRankNewMember', 'const qStaffRankProjectCount'],
        ['项目数', 'const qStaffRankProjectCount', 'const qStaffRankIncome'],
        ['收入', 'const qStaffRankIncome', 'Part E'],
      ]
      for (const [label, start, end] of slices) {
        assertStaffRankAdmissionShape(sliceOrFail(adminSrc, start, end), `admin 员工榜-${label}`)
      }
    })

    it('staff 六个员工榜：WHERE 逐字是 has_skills OR 非零（含 admin 无的 footfall）', () => {
      const slices: Array<[string, string, string]> = [
        ['业绩', 'async function staffRankingRevenue', 'async function staffRankingConsume'],
        ['实耗', 'async function staffRankingConsume', 'async function staffRankingNewMember'],
        ['新会员', 'async function staffRankingNewMember', 'async function staffRankingFootfall'],
        ['客流', 'async function staffRankingFootfall', 'async function staffRankingProjectCount'],
        ['项目数', 'async function staffRankingProjectCount', 'async function staffRankingIncome'],
        ['收入', 'async function staffRankingIncome', 'async function staffRanking(ctx)'],
      ]
      for (const [label, start, end] of slices) {
        assertStaffRankAdmissionShape(sliceOrFail(staffSrc, start, end), `staff 员工榜-${label}`)
      }
    })

    it('admin Part C 五个门店榜：WHERE 只有 scope，不按 value 剔任何行', () => {
      const slices: Array<[string, string, string]> = [
        ['业绩', 'const qStoreRankRevenue', 'const qStoreRankConsume'],
        ['实耗', 'const qStoreRankConsume', 'const qStoreRankRetainedMember'],
        ['保有会员', 'const qStoreRankRetainedMember', 'const qStoreRankNewMember'],
        ['新会员', 'const qStoreRankNewMember', 'const qStoreRankProjectCount'],
        ['项目数', 'const qStoreRankProjectCount', 'Part D'],
      ]
      for (const [label, start, end] of slices) {
        assertStoreRankNoValueCutoff(sliceOrFail(adminSrc, start, end), `admin 门店榜-${label}`)
      }
    })

    /**
     * ★ 切片数与查询数对账（闸门 1 · boundary-critic P2-1 的第二道防线）。
     *
     * 上面三条 it 的切片清单是**硬编码**的（admin 5 / staff 6）。新增一个员工榜 metric 时，
     * 只要没人回来往清单里加一行，那个新榜就永远不会被检查 —— 而
     * `assertSingleOuterQuery` 只能发现「切片内混进了第二个查询」这一种形态，
     * 发现不了「新榜被加在清单覆盖范围之外」（比如加在最后一个榜之后）。
     *
     * 这里直接钉死消费 `producer_employees` 的查询总数：多一个就红，改动者必须回来
     * 同步切片清单并说明新榜为何安全。
     */
    /**
     * ★ JS 装配层不得按 value 剔行（闸门 2 round-3 GLM P1-4）。
     *
     * 本组此前**全部**是 SQL 文本断言，JS 后处理完全在视野外。GLM 实测：
     * 在 staff `rawRows.map(...)` 前插一个 `.filter((r) => Number(r.value || 0) > 0)`
     * → SQL 层十几道守护全部正确，却在最后一层被一行 filter 抹平，66 条断言全绿。
     *
     * 「0.00 行太多，过滤一下」与「榜单太长，加个 LIMIT」是同族的常规演进动机 ——
     * 后者已有禁令，前者此前没有。
     */
    /**
     * ★ 候选池 `producer_base` 的 WHERE **正向钉死**（闸门 2 round-3 GLM P1-3）。
     *
     * 它定义在 `${producerCte}` / `producerEmployeesCte()` 里，各榜切片内只有插值引用、
     * 没有展开文本 —— 所以 `assertCteWhereNoNumericCompare` 等逐榜断言**扫不到它**（实测漏网）。
     *
     * 在这里追加一句 `AND cardinality(array_remove(sw.skills,'')) > 0`，就能把无标签员工
     * **整池**吞掉，连「OR 非零」兜底要救的那批人一起拔除 —— 外层 `has_skills OR v<>0`
     * 救不了已经不在候选池里的人。这正是 2026-05-20 漏算 33% 业绩的同型事故。
     *
     * 该 WHERE 的合法内容只有「入职非空 + 入职早于锚点 + 未离职或离职晚于锚点」三项，
     * 且本就含合法的时间比较（`<=` / `>`），无法用「禁数值比较」一刀切，故逐字钉死。
     */
    it('候选池 producer_base 的 WHERE 只有 hired_at / resigned_at 三项（两端镜像）', () => {
      for (const [body, label, anchor] of [
        [adminBody, 'admin efficiency.ts', '\\$\\{cur\\.end\\}'],
        [staffBody, 'staff mgmt-dashboard.js', 'NOW\\(\\)::date'],
      ] as const) {
        const m = body.match(
          new RegExp(
            'WHERE sw\\.hired_at IS NOT NULL' +
              ' AND sw\\.hired_at::date <= ' + anchor +
              ' AND \\(sw\\.resigned_at IS NULL OR sw\\.resigned_at::date > ' + anchor + '\\)' +
              '\\s*\\)',
          ),
        )
        expect(
          m,
          `${label} 的 producer_base WHERE 形状变了。只允许「入职非空 + 入职 <= 锚点 + ` +
            '未离职或离职 > 锚点」三项；在此追加任何条件（尤其 skills 判定）都会把整批员工' +
            '挡在候选池外，外层的 has_skills OR 兜底救不回来（#290 / 2026-05-20 同型事故）。',
        ).toBeTruthy()
      }
    })

    /**
     * ★ 候选池**第二层** `producer_employees` 的 WHERE（闸门 2 round-4 codex P1-1）。
     *
     * round-3 补的是第一层 `producer_base`；第二层的 scope WHERE 同样没人看守 ——
     * 在它外面包一层再追加 `AND pb.has_skills`，第一层三项断言、外层
     * `has_skills OR v<>0`、查询计数全都不变，但**无标签且有非零产能**的员工
     * 在进入榜单前已被删除（正是「OR 兜底」要救的那批人）。
     */
    it('候选池 producer_employees 的 WHERE 只有两个 scope 分支（两端镜像）', () => {
      for (const [body, label, storeScope, orgScope] of [
        [adminBody, 'admin efficiency.ts',
         "\\$\\{scopeFilterSql\\(session, scope, 'pb\\.store_id'\\)\\}",
         '\\$\\{orgAnchorScopeSql\\(session, scope\\)\\}'],
        [staffBody, 'staff mgmt-dashboard.js',
         '\\$\\{storeFilter\\.sql\\}', '\\$\\{orgScope\\.sql\\}'],
      ] as const) {
        const re = new RegExp(
          'WHERE \\(pb\\.store_id IS NOT NULL AND ' + storeScope + '\\)' +
            ' OR \\(pb\\.store_id IS NULL AND ' + orgScope + '\\)\\s*\\)',
        )
        expect(
          re.test(body),
          `${label} 的 producer_employees WHERE 形状变了。只允许「有门店走 store scope、` +
            '无门店走 org anchor scope」两个分支；在此追加任何条件（尤其 has_skills）' +
            '都会把「无标签但有产能」的员工在进榜前删掉 —— 外层的 OR 兜底救不回来。',
        ).toBe(true)
      }
    })

    it('两端 JS 装配层不得按 value 剔行（SQL 守住了，别在 map 前 filter 掉）', () => {
      // ⚠️ 正向钉死而非禁 `.filter(`（闸门 2 round-4 codex P1-6）：黑名单列不完 ——
      // `.flatMap((r) => r.value < 0 ? [] : [r])`、`.reduce(...)`、`.slice(0, 50)` 都能剔行。
      // 判据改为「`assignRanks(` 之后必须**紧跟** `.map(`」，中间插入任何调用都会红。
      const adminAssembly = sliceOrFail(adminSrc, 'const mapStoreRank', 'const storeRankings')
      const adminChains = [
        ...adminAssembly.matchAll(/assignRanks\(\s*\(rows as [^)]*\)\s*(\.\w+)\(/g),
      ].map((m) => m[1])
      expect(
        adminChains.length,
        'admin 抽不到 mapStoreRank/mapStaffRank 的装配链（fail-closed，结构变了）',
      ).toBe(2)
      expect(
        adminChains,
        'admin 排行榜装配层在 assignRanks 与 .map 之间插入了别的调用 —— ' +
          '任何按 value 剔行/截断都会把 SQL 侧所有「不剔负」守护静默抹平（#290 回退）',
      ).toEqual(['.map', '.map'])

      // staff 两处装配（storeRanking 与 staffRanking）同理
      for (const [start, end, which, src] of [
        ['const rawRows = await METRIC_DISPATCH', 'if (elapsed > 800)', 'storeRanking', 'rawRows'],
        ['const rawRows = await STAFF_METRIC_DISPATCH', 'if (elapsed > 800)', 'staffRanking', 'rawRows'],
      ] as const) {
        const seg = sliceOrFail(staffSrc, start, end)
        const m = seg.match(new RegExp(`assignRanks\\(\\s*${src}\\s*(\\.\\w+)\\(`))
        expect(m, `staff ${which} 抽不到装配链（fail-closed，结构变了）`).toBeTruthy()
        expect(
          m![1],
          `staff ${which} 在 assignRanks 与 .map 之间插入了 ${m![1]}() —— 同上，会把 SQL 侧守护一次抹平`,
        ).toBe('.map')
      }
    })

    it('staff 的 staffOrderBy 单源同样「非零优先」，且六个榜都经由它（两端排序镜像）', () => {
      // staff 六个榜共用一个排序拼接函数，切片里只看得到 ${staffOrderBy(...)} 插值，
      // 故在此校验函数定义本身 + 全部调用点。两端排序必须一致，
      // 否则同一名员工在 admin 榜和 staff 小程序榜上的名次会对不上。
      // `=>` 与模板串之间可能被 prettier 折行；staffBody 虽已 normalize（空白压成单空格），
      // 但仍用 \s* 容错，避免格式化后假红（闸门 2 round-1 GLM）
      const decl = staffBody.match(/const staffOrderBy = \(valueExpr\) =>\s*`([^`]*)`/)?.[1]
      expect(decl, 'staff 找不到 staffOrderBy 单源定义（重命名了？）').toBeTruthy()
      expect(
        decl,
        'staff 排序首键不再是「非零优先」，会与 admin 员工榜名次分叉，' +
          '且负值员工在小程序端会被零值行压到榜底',
      ).toMatch(/^ORDER BY \(\$\{valueExpr\} <> 0\) DESC, \$\{valueExpr\} DESC,/)

      // ⚠️ 排序表达式必须与各榜 SELECT 的 `AS value` **逐字相同**：写成别名 `value` 会让
      // PG 报 `column "value" does not exist`（别名只能做独立排序项，不能参与表达式）。
      // 故此处同时钉死「六个榜都走 staffOrderBy」，不许某个榜自己拼 ORDER BY。
      expect(
        (staffBody.match(/\$\{staffOrderBy\('/g) ?? []).length,
        'staff 六个员工榜必须全部经由 staffOrderBy 拼排序；' +
          '某个榜自己写 ORDER BY 会绕过本组守护，且极易写成别名形式而在运行时报错',
      ).toBe(6)
      expect(
        /ORDER BY \(value <> 0\)/.test(staffBody),
        'staff 出现了 `ORDER BY (value <> 0)` 这种**别名参与表达式**的写法 —— ' +
          'PG 会报 column "value" does not exist，整个 staffRanking 直接失败',
      ).toBe(false)
    })

    it('消费 producer_employees 的查询总数与切片清单对账（新增 metric 必须同步补断言）', () => {
      expect(
        (adminBody.match(/FROM producer_employees pe/g) ?? []).length,
        'admin 侧消费 producer_employees 的查询数变了。期望 6 = Part D 五个员工榜 + Part E 技师明细。\n' +
          '  · 新增员工榜 metric → 请往上面「admin Part D 五个员工榜」的 slices 里补一行；\n' +
          '  · 新增 Part E 同类明细 → 请确认它不按 value 剔行后再改本断言。',
      ).toBe(6)
      expect(
        (staffBody.match(/FROM producer_employees pe/g) ?? []).length,
        'staff 侧消费 producer_employees 的查询数变了。期望 6 个员工榜（比 admin 多 footfall、无 Part E）。\n' +
          '新增 metric 请同步补「staff 六个员工榜」的 slices。',
      ).toBe(6)
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
      // #423：无门店市场行经 perTech 置 null，分子仍须是市场去重客流
      expect(adminBody).toMatch(/techAvgMembers:\s*perTech\(footfallByMarketMap\.get\(m\.marketId\)/i)
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
