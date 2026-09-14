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
 *    只有自销自耗非零，拆 4 列意义不大」），新增分类是否配一列应由人决定；生成式只能自动出 SQL 列，
 *    metrics 装配与展示仍需手改，反而会产出「SQL 有列但页面不展示」的新不一致。
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
 * 漏同步的后果不是报错，而是静默降级：提成率骨架少一个键、人效报表少算一类。
 */
const COPIES = [
  {
    label: 'fengyu-admin lib/sales-categories.ts — admin 端内单源',
    file: ADMIN_SINGLE_SOURCE_TS,
    pattern: /SALES_CATEGORIES\s*=\s*\[([^\]]+)\]\s*as const/g,
    extract: pickLiterals,
  },
  {
    // 跨端副本：payNotify 属 client 端，禁与 staffApi 共享目录，只能靠本测试守护
    label: 'payNotify index.js — orderRates / serviceRates 骨架（跨端副本）',
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

describe('admin 人效表列 key 与 efficiency.ts SQL 列别名对应', () => {
  /**
   * columns.ts 的 4 个分类列自 #136 起由 `SALES_CATEGORY_COLUMN_KEYS` 生成，
   * tsc 保证「键」完备，但保证不了「值」（camelCase 列 key）与 efficiency.ts
   * SQL 列别名（snake_case）对得上 —— 写错了页面该列恒为空，不报错。
   */
  const toSnake = (camel) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

  test('每个分类的列 key 转 snake_case 后 = SQL 的 AS 别名', () => {
    const keyMap = new Map(
      [...read(ADMIN_SINGLE_SOURCE_TS).matchAll(/([^\s,{}:]+):\s*'(sale[A-Za-z]+)'/g)]
        .map((m) => [m[1], m[2]])
    )
    const aliasMap = new Map(
      [...read(EFFICIENCY_TS).matchAll(/FILTER \(WHERE si\.sales_category = '([^']+)'\), 0\) AS (\w+)/g)]
        .map((m) => [m[1], m[2]])
    )

    for (const category of SALES_CATEGORIES) {
      expect(keyMap.get(category), `SALES_CATEGORY_COLUMN_KEYS 缺少「${category}」的列 key`).toBeTruthy()
      expect(aliasMap.get(category), `efficiency.ts 销售额 CTE 缺少「${category}」的 FILTER 列`).toBeTruthy()
      expect(
        toSnake(keyMap.get(category)),
        `「${category}」的列 key 与 SQL 别名对不上，人效表该列会恒为空`
      ).toBe(aliasMap.get(category))
    }
  })
})
