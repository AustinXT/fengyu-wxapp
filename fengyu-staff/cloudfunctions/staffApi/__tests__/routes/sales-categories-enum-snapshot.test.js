/**
 * 销售归属分类字面量守护测试（issue #123）
 *
 * 用户已 veto cloudfunctions-shared：`sales_category` 四值在 db/schema、staffApi、admin、
 * payNotify 各持独立副本，一致性只能靠 snapshot 守护（同 cross-end-sql-snapshot.test.js 思路）。
 *
 * 本测试锁死两件事：
 *   1. staffApi 的 utils/sales-categories.js 与 db/schema/enums.ts::salesCategoryEnum 逐字一致
 *      —— 漏同步时，performanceDetail 会先零填充出一个「幽灵旧分类」（永远 ¥0.00、点了筛不出东西），
 *         再把有数据的新分类追加到末尾；本期无新分类数据时新分类甚至完全不显示。
 *   2. 数组顺序固定 —— 顺序即绩效页 4 个格子的展示顺序。
 *
 * ── 覆盖边界（issue #123 划线，勿误以为已全仓闭环）────────────────────────────
 * 全仓生产源码中出现该四元组的位置有 20+ 处（禁 shared 目录的既有代价）。本测试覆盖
 * 下方 COPIES 列出的**运行时骨架与类型/选项定义**——它们漏同步不会报错，只会静默降级
 * （下拉少一项、提成率骨架缺键、报表少算一类）。
 *
 * 已知**未**覆盖、留待「全仓 sales_category 副本收敛」专项处理的：
 *   - fengyu-admin/src/actions/data-center/efficiency.ts 的四分类 FILTER SQL
 *     （同文件还混有多处**有意的子集**副本，如只统计自销自耗+他销自耗的口径，
 *       精确锚定易误伤，需连同口径一起梳理）
 *   - fengyu-admin/src/actions/{orders,products}.ts 的内联联合类型
 *     （类型注解有 tsc 编译期保护，改名会直接报错，风险低于运行时字面量）
 *   - 各端测试 fixture 里的分类名（不影响生产行为）
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs')
const path = require('node:path')

const { SALES_CATEGORIES, UNCATEGORIZED } = require('../../utils/sales-categories')

const REPO = path.resolve(__dirname, '../../../../..')
const ENUMS_TS = path.join(REPO, 'db/schema/enums.ts')

/** 抽出一组引号字面量，顺序保留（用于数组 / 联合类型 / z.enum） */
const pickLiterals = (text) =>
  (text.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1))

/**
 * 抽出对象字面量的键，顺序保留。
 * 引号可有可无 —— admin `allocations.ts` 写的是 `{ 自销自耗: 0 }`（无引号），
 * 云函数侧写的是 `{ '自销自耗': 0 }`，用 pickLiterals 会漏掉前者。
 */
const pickObjectKeys = (text) =>
  [...text.matchAll(/['"]?([^\s'",:{}]+)['"]?\s*:/g)].map((m) => m[1])

/**
 * 运行时硬编码副本清单 —— 每一处都是「枚举加值时会漏同步」的真实风险点。
 * 漏同步的后果不是报错，而是静默降级：admin 下拉少一个选项、提成率骨架少一个键。
 */
const COPIES = [
  {
    label: 'fengyu-admin types.ts — SalesCategory 联合类型',
    file: path.join(REPO, 'fengyu-admin/src/lib/types.ts'),
    // 跨行捕获：枚举加值后 prettier 可能把联合类型折行，单行正则会只抓到首行而误报
    pattern: /type\s+SalesCategory\s*=\s*([\s\S]*?)(?:\n\n|\nexport|\ninterface|$)/g,
    extract: pickLiterals,
  },
  {
    label: 'fengyu-admin schemas.ts — salesCategory z.enum',
    file: path.join(REPO, 'fengyu-admin/src/lib/schemas.ts'),
    pattern: /salesCategory:\s*z\.enum\(\s*\[([^\]]+)\]/g,
    extract: pickLiterals,
  },
  {
    label: 'fengyu-admin 品项分类页 — SALES_CATEGORY_OPTIONS 下拉',
    file: path.join(REPO, 'fengyu-admin/src/app/(main)/(catalog)/products/categories/_components/categories-page.tsx'),
    pattern: /SALES_CATEGORY_OPTIONS\s*:\s*SalesCategory\[\]\s*=\s*\[([^\]]+)\]/g,
    extract: pickLiterals,
  },
  {
    label: 'fengyu-admin 提成配置页 — SALES_CATEGORY_OPTIONS 下拉',
    file: path.join(REPO, 'fengyu-admin/src/app/(main)/(organization)/commission/_components/commission-page.tsx'),
    pattern: /SALES_CATEGORY_OPTIONS\s*=\s*\[([^\]]+)\]/g,
    extract: pickLiterals,
  },
  // 以下是提成率骨架：漏同步不会报错，只会让新分类的零值键缺席，静默算不出提成
  {
    label: 'fengyu-admin allocations.ts — orderRates 骨架（无引号键）',
    file: path.join(REPO, 'fengyu-admin/src/actions/allocations.ts'),
    pattern: /orderRates:\s*\{([^}]+)\}/g,
    extract: pickObjectKeys,
  },
  {
    label: 'staffApi allocation.js — orderRates / serviceRates 骨架',
    file: path.join(REPO, 'fengyu-staff/cloudfunctions/staffApi/routes/allocation.js'),
    pattern: /(?:orderRates|serviceRates):\s*\{([^}]+)\}/g,
    extract: pickObjectKeys,
  },
  {
    label: 'staffApi serviceCommission.js — serviceRates 骨架',
    file: path.join(REPO, 'fengyu-staff/cloudfunctions/staffApi/routes/serviceCommission.js'),
    pattern: /serviceRates:\s*\{([^}]+)\}/g,
    extract: pickObjectKeys,
  },
  {
    label: 'payNotify index.js — orderRates / serviceRates 骨架',
    file: path.join(REPO, 'fengyu-client/cloudfunctions/payNotify/index.js'),
    pattern: /(?:orderRates|serviceRates):\s*\{([^}]+)\}/g,
    extract: pickObjectKeys,
  },
  {
    label: 'fengyu-admin 品项分类页 — 本地 SalesCategory 联合类型',
    file: path.join(REPO, 'fengyu-admin/src/app/(main)/(catalog)/products/categories/_components/categories-page.tsx'),
    pattern: /type\s+SalesCategory\s*=\s*([^\n]+)/g,
    extract: pickLiterals,
  },
  {
    // 数据中心员工效率表的 4 个分类列（口径是 allocated_amount，与绩效页的提成不同，勿混）
    // 4 处命中各出一个 label，合起来才是完整四元组 → collect
    label: 'fengyu-admin data-center/columns.ts — 员工效率表分类列',
    file: path.join(REPO, 'fengyu-admin/src/lib/data-center/columns.ts'),
    pattern: /key:\s*['"]sale(?:Zxzh|Txzh|Txth|Eco)['"],\s*label:\s*['"]([^'"]+)['"]/g,
    collect: true,
  },
]

describe('sales_category 跨端字面量一致性', () => {
  test('utils/sales-categories.js 与 db/schema/enums.ts::salesCategoryEnum 逐字一致', () => {
    const source = fs.readFileSync(ENUMS_TS, 'utf8')
    // 锚定到具名导出声明，避免命中注释里残留的旧 pgEnum 片段而假阳性放行
    const match = source.match(
      /salesCategoryEnum\s*=\s*pgEnum\(\s*["']sales_category["']\s*,\s*\[([^\]]+)\]/
    )
    expect(match, `未能在 ${ENUMS_TS} 中定位 salesCategoryEnum 声明，枚举定义可能已改写`).toBeTruthy()

    expect(SALES_CATEGORIES).toEqual(pickLiterals(match[1]))
  })

  test('固定 4 值与顺序锁定（顺序 = 绩效页格子展示顺序）', () => {
    expect(SALES_CATEGORIES).toEqual(['自销自耗', '他销自耗', '他销他耗', '生态合作'])
  })

  test('常量被 freeze，防跨请求污染（模块作用域在云函数容器内跨请求复用）', () => {
    expect(Object.isFrozen(SALES_CATEGORIES)).toBe(true)
  })

  test('UNCATEGORIZED 字面量固定 —— 前端 chip 与后端归类靠它对齐', () => {
    expect(UNCATEGORIZED).toBe('未分类')
  })

  // 以下各端保留独立副本（用户已 veto shared 目录），只能靠本测试守护
  test.each(COPIES)('$label 与单源一致', ({ file, pattern, extract, collect }) => {
    const source = fs.readFileSync(file, 'utf8')
    const matches = [...source.matchAll(pattern)]

    expect(matches.length, `未能在 ${file} 定位目标声明，格式可能已改写`).toBeGreaterThan(0)

    if (collect) {
      // 每处命中只贡献一个分类（如 columns.ts 的 4 个列定义），捕获组即分类名本身，
      // 合起来才是完整四元组
      const all = matches.map((m) => m[1])
      expect(all, `${file} 合并后的分类集合与单源不一致`).toEqual([...SALES_CATEGORIES])
      return
    }

    // 校验**每一处**命中而非只看第一处：allocation.js 内部就有 3 份同样的骨架，
    // 只验第一处会让「改了一处漏了另两处」静默通过；注释里残留的旧声明也会在此响亮失败
    matches.forEach((m, i) => {
      expect(extract(m[1]), `${file} 第 ${i + 1} 处命中与单源不一致`).toEqual([...SALES_CATEGORIES])
    })
  })
})
