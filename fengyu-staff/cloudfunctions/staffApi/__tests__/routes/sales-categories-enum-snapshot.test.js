/**
 * 销售归属分类字面量守护测试（issue #123 建立，issue #136 收敛后重写）
 *
 * 用户已 veto cloudfunctions-shared：`sales_category` 四值在 db/schema、staffApi、admin、
 * payNotify 各持独立副本，**跨端**一致性只能靠 snapshot 守护（同 cross-end-sql-snapshot.test.js 思路）。
 *
 * 本测试锁死两件事：
 *   1. 各端单源与 db/schema/enums.ts::salesCategoryEnum 逐字一致
 *      —— 漏同步时，performanceDetail 会先零填充出一个「幽灵旧分类」（永远 ¥0.00、点了筛不出东西），
 *         再把有数据的新分类追加到末尾；本期无新分类数据时新分类甚至完全不显示。
 *   2. 数组顺序固定 —— 顺序即绩效页 4 个格子 / admin 下拉 / 人效表 4 列的展示顺序。
 *
 * ⚠️ **本测试是词法守护，只证明字面量在文件里，不证明它被接线**。举例：若整个
 *    `revenue_by_emp_cat` CTE 变成死代码（外层 SELECT 不再 JOIN 它），下方断言仍会全绿而页面全空。
 *    真正面向用户的那一环（metrics 装配 → 页面/导出取数）由文件末尾的「链路完整性」用例覆盖；
 *    端到端正确性仍需 L2/L3 与实效验证，别把这里的绿当成全链路保证。
 *
 * ── 覆盖边界（issue #136 收敛后的实际状态）──────────────────────────────────
 * issue #136 把**端内**副本收敛到了两个单源，生产源码中剩下的四元组只有 4 处，全部在下方守护：
 *
 *   ① db/schema/enums.ts                              权威单源（本测试的比较基准）
 *   ② staffApi/utils/sales-categories.js              staffApi 端内单源
 *   ③ fengyu-admin/src/lib/sales-categories.ts        admin 端内单源
 *   ④ payNotify/index.js 的费率骨架                    跨端副本（禁收敛，只能守护）
 *   ⑤ admin actions/data-center/efficiency.ts         员工人效「销售额 / 实耗」各 4 列 FILTER SQL
 *
 * ⑤ 有意保留字面量而非由常量生成：该表拆 4 列是**产品展示决策**（文件内注释明写「现实数据几乎
 *    只有自销自耗非零，拆 4 列意义不大」）；生成式只能自动出 SQL 列，metrics 装配与展示仍需手改，
 *    反而会产出「SQL 有列但页面不展示」的新不一致。
 *
 *    ⚠️ 别误读成「列的增删是自由的」：下方断言要求这 4 列**恰好齐全且与单源同序**，
 *    自由度为 0。产品若真要撤掉某一列（如不再展示生态合作），测试会红且文案暗示「把列加回来」
 *    —— 那个红的正确含义是「你正在改一个受守护的口径，请显式改测试并在此记录豁免」，
 *    不是「你改错了」。守护的是「不被无意改动」，不是「不许改」。
 *
 * 已知**未**覆盖，且都是有意豁免（非遗漏）：
 *   - **有意子集** `sales_category IN ('自销自耗','他销自耗')`：全仓 11 处（efficiency.ts ×5、
 *     customer.ts ×2、mgmt-dashboard.js ×3、mgmt-traffic.js ×1），是「项目数只统计自耗类」的
 *     业务口径，受 `consistency.*.test.ts` 守护。**扩成四值会改报表口径**，绝不可「修正」。
 *     本测试的 efficiency 正则用 `= '单值'` 锚定，与 `IN (…)` 精确区分，不会误伤。
 *   - **单值 fallback** `|| '自销自耗'`：全仓 14 处（allocations.ts、allocation.js、payNotify、
 *     payment-allocation-groups.ts、allocation-group.ts、service-commission.ts、revenue-allocation.ts），
 *     是「NULL 时归入自销自耗」的业务默认值，**不随枚举加值而变化**，不是四元组副本。
 *   - **admin `SALES_CATEGORY_COLUMN_KEYS`**：`Record<SalesCategory, string>` 已由 tsc 保证键完备
 *     （加值即报缺键），比 snapshot 更早失败，无需在此重复守护；但它的**值**与 efficiency.ts 的
 *     SQL 列别名对应关系 tsc 管不到，由下方独立用例守护。
 *   - 各端测试 fixture、`db/scripts/` 运维脚本、`src/db/seed.ts` 种子数据、`db/migrations/` 历史
 *     快照里的分类名（不影响生产行为）。
 *   - `fengyu-admin/dist/export-worker.mjs`：git 跟踪的**构建产物**，内含一份四元组且已过期。
 *     生产走 `docker/Dockerfile.admin` 重新 build，不影响线上；守护构建产物无意义，故不纳入。
 *
 * ── collect 模式的两个前提（将来撞上了就该改测试，不是 bug）─────────────────
 *   a. 假定每个 pattern 在目标文件里**只有一处** 4 列块。若将来 efficiency.ts 新增环比 / 去年同期
 *      CTE（同形状再来一组 FILTER），命中会变 8 而必红 —— 届时应把正则按 CTE 名收窄，不要删断言。
 *   b. `toEqual` 连**顺序**一起断言。SQL 内 4 个 FILTER 的先后对行为零影响（列语义由 `AS` 别名承载、
 *      展示顺序由 columns.ts 从单源生成），所以纯 reorder 会红属**假阳性** —— 该断言是为 diff 稳定性
 *      服务的附赠品。真正的语义守护力在文件末尾的「链路完整性」用例：别名互换那种真错误由它精确抓住。
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs')
const path = require('node:path')

const { SALES_CATEGORIES, UNCATEGORIZED, createSalesCategoryRates } = require('../../utils/sales-categories')

const REPO = path.resolve(__dirname, '../../../../..')
const ENUMS_TS = path.join(REPO, 'db/schema/enums.ts')
const ADMIN_SINGLE_SOURCE_TS = path.join(REPO, 'fengyu-admin/src/lib/sales-categories.ts')
const EFFICIENCY_TS = path.join(REPO, 'fengyu-admin/src/actions/data-center/efficiency.ts')

const read = (file) => fs.readFileSync(file, 'utf8')

/** 抽出一组引号字面量，顺序保留（用于数组 / 联合类型 / 对象键 / z.enum） */
const pickLiterals = (text) =>
  (text.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1))

/**
 * 收敛后仍存在的运行时副本清单 —— 每一处都是「枚举加值时会漏同步」的真实风险点。
 * 漏同步的后果不是报错，而是静默降级。
 *
 * ⚠️ 费率骨架少一个键的真实后果**不是**下游读出 undefined 崩溃 —— lookup 侧一律
 * `(hit && hit.orderRates[cat]) || 0` 兜底，undefined 与 0 行为等价。它 load-bearing 的地方是
 * `getCommissionRates` / `serviceCommission.detail` **回传给前端的键完备性**：少一个键，
 * 提成矩阵表格就少渲染一格，店长看不到那一类可填。
 */
const COPIES = [
  {
    label: 'fengyu-admin lib/sales-categories.ts — admin 端内单源',
    file: ADMIN_SINGLE_SOURCE_TS,
    // `Object.freeze(…)` 包装可选：两端单源都用 freeze 加固（运行时只读），
    // 但正则若写死 `= [` 会在加固时命中 0 并以「未能定位目标声明」误报
    pattern: /SALES_CATEGORIES\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]+)\]/g,
    extract: pickLiterals,
  },
  {
    // 跨端副本：payNotify 属 client 端，禁与 staffApi 共享目录，只能靠本测试守护。
    // 当前该文件只有 orderRates 一处骨架（自动分配只走销售单）；正则一并覆盖 serviceRates，
    // 是为了将来新增时自动纳入守护 —— 勿据 label 误判为「漏守护了 serviceRates」
    label: 'payNotify index.js — orderRates 费率骨架（跨端副本）',
    file: path.join(REPO, 'fengyu-client/cloudfunctions/payNotify/index.js'),
    pattern: /(?:orderRates|serviceRates):\s*\{([^}]+)\}/g,
    extract: pickLiterals,
  },
  {
    // 别名 si + 单值等号 —— 与同文件 `sit.sales_category IN ('自销自耗','他销自耗')`
    // 那 5 处**有意子集**精确区分，不会误伤
    label: 'fengyu-admin efficiency.ts — 员工人效「销售额」4 列 FILTER SQL',
    file: EFFICIENCY_TS,
    pattern: /FILTER \(WHERE si\.sales_category = '([^']+)'\)/g,
    collect: true,
  },
  {
    label: 'fengyu-admin efficiency.ts — 员工人效「实耗」4 列 FILTER SQL',
    file: EFFICIENCY_TS,
    pattern: /FILTER \(WHERE sit\.sales_category = '([^']+)'\)/g,
    collect: true,
  },
]

describe('sales_category 跨端字面量一致性', () => {
  test('utils/sales-categories.js 与 db/schema/enums.ts::salesCategoryEnum 逐字一致', () => {
    const source = read(ENUMS_TS)
    // 锚定到具名导出声明，避免命中注释里残留的旧 pgEnum 片段而假阳性放行
    const match = source.match(
      /salesCategoryEnum\s*=\s*pgEnum\(\s*["']sales_category["']\s*,\s*\[([^\]]+)\]/
    )
    expect(match, `未能在 ${ENUMS_TS} 中定位 salesCategoryEnum 声明，枚举定义可能已改写`).toBeTruthy()

    expect(SALES_CATEGORIES).toEqual(pickLiterals(match[1]))
  })

  test('固定 4 值与顺序锁定（顺序 = 绩效页格子 / admin 下拉 / 人效表列的展示顺序）', () => {
    expect(SALES_CATEGORIES).toEqual(['自销自耗', '他销自耗', '他销他耗', '生态合作'])
  })

  test('常量被 freeze，防跨请求污染（模块作用域在云函数容器内跨请求复用）', () => {
    expect(Object.isFrozen(SALES_CATEGORIES)).toBe(true)
  })

  test('UNCATEGORIZED 字面量固定 —— 前端 chip 与后端归类靠它对齐', () => {
    expect(UNCATEGORIZED).toBe('未分类')
  })

  // 以下各端保留独立副本（跨端禁共享目录），只能靠本测试守护
  test.each(COPIES)('$label 与单源一致', ({ file, pattern, extract, collect }) => {
    const source = read(file)
    const matches = [...source.matchAll(pattern)]

    expect(matches.length, `未能在 ${file} 定位目标声明，格式可能已改写`).toBeGreaterThan(0)

    if (collect) {
      // 每处命中只贡献一个分类（如 efficiency.ts 的 4 个 FILTER 表达式），
      // 捕获组即分类名本身，合起来才是完整四元组
      const all = matches.map((m) => m[1])
      expect(all, `${file} 合并后的分类集合与单源不一致`).toEqual([...SALES_CATEGORIES])
      return
    }

    // 校验**每一处**命中而非只看第一处：payNotify 内部可能有多份同样的骨架，
    // 只验第一处会让「改了一处漏了另一处」静默通过；注释里残留的旧声明也会在此响亮失败
    matches.forEach((m, i) => {
      expect(extract(m[1]), `${file} 第 ${i + 1} 处命中与单源不一致`).toEqual([...SALES_CATEGORIES])
    })
  })
})

describe('createSalesCategoryRates 费率骨架', () => {
  test('键集合 = 单源四分类，值全 0', () => {
    const rates = createSalesCategoryRates()
    expect(Object.keys(rates)).toEqual([...SALES_CATEGORIES])
    // 跟随单源而非硬编码 [0,0,0,0]：本用例守的是「每个键初始值为 0」，
    // 枚举加值时它应自动适配，不该跟着变红——红的必须都是真需要人工同步的点
    expect(Object.values(rates)).toEqual(SALES_CATEGORIES.map(() => 0))
  })

  test('每次调用返回全新可变对象 —— 调用方会原地写入，共享实例会跨请求串数据', () => {
    const a = createSalesCategoryRates()
    const b = createSalesCategoryRates()
    expect(a).not.toBe(b)

    a['自销自耗'] = 0.15
    expect(b['自销自耗']).toBe(0)
    expect(Object.isFrozen(a)).toBe(false)
  })
})

describe('efficiency.ts 员工人效四分类列链路完整性', () => {
  /**
   * 「按技师人效」表的每个分类列，从常量到页面要穿过 **5 个环节**，环环用的都是同一个
   * 后缀（zxzh / txzh / txth / eco）。tsc 只保证第 0 环（`Record<SalesCategory, string>` 键完备），
   * 其余 5 环全是字符串约定，**漏任何一环都不报错、只静默出错**：
   *
   *   ① CTE 销售额   FILTER (WHERE si.sales_category = 'X'), 0) AS sale_<sfx>
   *   ② CTE 实耗     FILTER (WHERE sit.sales_category = 'X'), 0) AS consume_<sfx>
   *   ③ 外层 SELECT  COALESCE(r.sale_<sfx>, …) AS sale_<sfx> ＋ COALESCE(c.consume_<sfx>, …)
   *   ④ metrics 装配 sale<Camel>: Number(r.sale_<sfx> ?? 0)
   *   ⑤ consumeTotal 求和项 Number(r.consume_<sfx> ?? 0)
   *
   * 漏 ④ → `registry.ts` 的 `?.[definition.key]` 取到 undefined，页面与导出该列**恒为空**；
   * 漏 ⑤ → 「实耗合计」**静默少算一类金额**。两者都比报错难查得多，故在此逐环锁死。
   *
   * ⚠️ 本组列口径是 `allocated_amount`（营业额份额），与 staff 绩效页同名 4 格的
   *    `commission_amount`（提成）差一个费率量级，勿对齐。
   */
  const toSnake = (camel) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

  const efficiencySource = read(EFFICIENCY_TS)

  /**
   * 只在 `SALES_CATEGORY_COLUMN_KEYS = {…}` 块**内部**提取，不扫全文件 ——
   * 否则文件任何角落（尤其注释）出现一个 `自销自耗: 'saleOld'` 形状的串，
   * `new Map` 的 last-wins 就会把它覆盖进来，测试红在「列 key 与 SQL 别名对不上」，
   * 而真正根因是注释，错误信息指错方向。键的引号可有可无。
   */
  const columnKeysBlock = read(ADMIN_SINGLE_SOURCE_TS).match(
    /SALES_CATEGORY_COLUMN_KEYS[^=]*=\s*(?:Object\.freeze\(\s*)?\{([^}]+)\}/
  )
  const columnKeyByCategory = new Map(
    [...(columnKeysBlock?.[1] ?? '').matchAll(/['"]?([^\s'",:{}]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)]
      .map((m) => [m[1], m[2]])
  )

  test('能定位 SALES_CATEGORY_COLUMN_KEYS 声明块', () => {
    expect(columnKeysBlock, `未能在 ${ADMIN_SINGLE_SOURCE_TS} 定位列 key 映射，声明形式可能已改写`).toBeTruthy()
  })

  test.each([...SALES_CATEGORIES])('「%s」在链路 5 个环节全部齐全', (category) => {
    const columnKey = columnKeyByCategory.get(category)
    expect(columnKey, `SALES_CATEGORY_COLUMN_KEYS 缺少「${category}」的列 key`).toBeTruthy()

    const saleAlias = toSnake(columnKey) // saleZxzh → sale_zxzh
    // 显式断言命名约定，而不是静默假设：后面 consume 别名靠剥 `sale_` 前缀推导，
    // 若新分类的列 key 不叫 sale<Camel>，在这里精确报错，而不是滑到「缺少 FILTER 列」
    expect(
      saleAlias.startsWith('sale_'),
      `列 key「${columnKey}」不符合 sale<Camel> 命名约定，本用例的 consume_ 别名推导依赖它`
    ).toBe(true)
    const consumeAlias = `consume_${saleAlias.slice('sale_'.length)}`

    expect(
      efficiencySource,
      `① CTE 销售额缺「${category}」的 FILTER 列，或其 AS 别名不是 ${saleAlias}`
    ).toContain(`FILTER (WHERE si.sales_category = '${category}'), 0) AS ${saleAlias}`)

    expect(
      efficiencySource,
      `② CTE 实耗缺「${category}」的 FILTER 列，或其 AS 别名不是 ${consumeAlias}`
    ).toContain(`FILTER (WHERE sit.sales_category = '${category}'), 0) AS ${consumeAlias}`)

    expect(
      efficiencySource,
      `③ 外层 SELECT 未透出 ${saleAlias}，该列不会出现在结果行里`
    ).toContain(`COALESCE(r.${saleAlias}, 0)::numeric AS ${saleAlias}`)
    expect(
      efficiencySource,
      `③ 外层 SELECT 未透出 ${consumeAlias}，实耗合计会少算「${category}」`
    ).toContain(`COALESCE(c.${consumeAlias}, 0)::numeric AS ${consumeAlias}`)

    expect(
      efficiencySource,
      `④ metrics 装配缺 ${columnKey}: Number(r.${saleAlias} ?? 0) —— 页面与导出该列会恒为空`
    ).toMatch(new RegExp(`${columnKey}:\\s*Number\\(r\\.${saleAlias}\\s*\\?\\?\\s*0\\)`))
  })

  test('⑤ consumeTotal 的求和项与四分类一一对应（漏加会静默少算金额）', () => {
    const expr = efficiencySource.match(/consumeTotal:([\s\S]*?)newMember:/)
    expect(expr, 'efficiency.ts 未能定位 consumeTotal 求和表达式，装配结构可能已改写').toBeTruthy()

    const terms = [...expr[1].matchAll(/Number\(r\.(consume_\w+)\s*\?\?\s*0\)/g)].map((m) => m[1])
    const expected = SALES_CATEGORIES.map((category) => {
      const columnKey = columnKeyByCategory.get(category)
      expect(columnKey, `SALES_CATEGORY_COLUMN_KEYS 缺少「${category}」的列 key`).toBeTruthy()
      return `consume_${toSnake(columnKey).replace(/^sale_/, '')}`
    })

    expect(
      [...terms].sort(),
      '实耗合计的加项与四分类对不上：多加会重复计金额，漏加会静默少算一类'
    ).toEqual([...expected].sort())
  })
})
