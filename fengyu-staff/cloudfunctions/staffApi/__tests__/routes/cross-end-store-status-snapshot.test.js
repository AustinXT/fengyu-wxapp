/**
 * 数据中心「在营门店」口径的跨端守护（issue #401）。
 *
 * 口径拍板（2026-09-25）：数据中心的取数范围、筛选器下拉、#293 停用空态**只看门店组织节点
 * `org_nodes.is_active`**；`stores.is_closed` 是营业时间轴（配合 closed_at 做时点在营），
 * 不参与统计范围。单源 helper 各端一份独立副本（禁止跨端共享代码目录）：
 *   - admin `fengyu-admin/src/lib/store-status.ts`
 *   - staff `utils/store-status.js`
 *   - 经营分析站 `fengyu-analyst/src/lib/store-status.ts`（#421 跟随，全部源码纳入闭集与单源）
 *
 * `activeStoreCondition` 函数体的两端整段等值由 `cross-end-technician-denominator.test.js`
 * 要件 7 负责（那里已逐字钉死，本文件不重复）。本文件守三件事：
 *   1. 闭集：数据中心消费方源码里**一个** `is_closed` / `isClosed` token 都不许出现
 *      （按目录枚举文件，不手列清单 —— 新增报表文件自动纳入）
 *   2. 单源：两端 `function activeStoreCondition(` 各**恰好一处**定义，且在 helper 文件里
 *   3. 接线：消费方确实从 helper 取定义（scope-sql / mgmt-dashboard / shared / dashboard）
 */

const fs = require('node:fs')
const path = require('node:path')

const ADMIN_SRC = path.resolve(__dirname, '../../../../../fengyu-admin/src')
const STAFF_ROOT = path.resolve(__dirname, '../..')
// 经营分析站（#421 跟随 #401）：第三份副本。analyst 自己的 vitest 不进 CI（#382），闭集 / 单源在这里一并守
const ANALYST_SRC = path.resolve(__dirname, '../../../../../fengyu-analyst/src')

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function isTestFile(filePath) {
  return /(^|\/)__tests__\//.test(filePath) || /\.test\.[jt]sx?$/.test(filePath)
}

/** 递归列出目录下的非测试源码文件 */
function listSources(dir, exts) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...listSources(full, exts))
    } else if (exts.some((ext) => entry.name.endsWith(ext)) && !isTestFile(full)) {
      out.push(full)
    }
  }
  return out
}

/**
 * staff 管理层路由分类（闭集）：新增 `routes/mgmt-*.js` 必须在这里归类，否则下面的分类用例变红。
 *   - STATS：数据中心统计子页，取数必须叠加在营口径。⚠️ 归入 STATS 只保证 is_closed / closed_at 被扫描，
 *     不保证真的接了线 —— 新文件须照下方「接线」用例补整段等值 + 调用计数断言自证
 *   - EXEMPT：非统计（顾客档案查询 / 详情），停用门店的顾客档案仍可查，不叠加
 */
const STAFF_MGMT_STATS = ['mgmt-dashboard.js', 'mgmt-product.js', 'mgmt-traffic.js']
const STAFF_MGMT_EXEMPT = ['mgmt-customer.js']

/** 数据中心消费方：admin 三个数据中心目录 + staff 管理层统计路由 */
const CONSUMER_FILES = [
  ...listSources(path.join(ADMIN_SRC, 'lib/data-center'), ['.ts', '.tsx']),
  ...listSources(path.join(ADMIN_SRC, 'actions/data-center'), ['.ts', '.tsx']),
  ...listSources(path.join(ADMIN_SRC, 'app/(main)/(analytics)/data-center'), ['.ts', '.tsx']),
  ...STAFF_MGMT_STATS.map((name) => path.join(STAFF_ROOT, 'routes', name)),
  // 经营分析站全部源码（#421）：范围下拉与三个板块取数都在这里
  ...listSources(ANALYST_SRC, ['.ts', '.tsx']),
]

const rel = (p) => path.relative(path.resolve(ADMIN_SRC, '../..'), p)

describe('#401 数据中心在营口径 · 闭集', () => {
  it('staff routes/mgmt-*.js 全部已归类（统计 / 豁免），无遗漏无多余', () => {
    const actual = fs.readdirSync(path.join(STAFF_ROOT, 'routes')).filter((n) => /^mgmt-.*\.js$/.test(n)).sort()
    expect(actual).toEqual([...STAFF_MGMT_STATS, ...STAFF_MGMT_EXEMPT].sort())
  })

  it('消费方文件枚举非空且覆盖已知入口（防目录改名后扫描落空恒绿）', () => {
    const names = CONSUMER_FILES.map(rel)
    expect(CONSUMER_FILES.length).toBeGreaterThan(20)
    for (const known of [
      'fengyu-admin/src/lib/data-center/scope-sql.ts',
      'fengyu-admin/src/lib/data-center/scope-options.ts',
      'fengyu-admin/src/actions/data-center/shared.ts',
      'fengyu-admin/src/actions/data-center/sales.ts',
      'fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
      'fengyu-analyst/src/lib/analyst-scope.ts',
      'fengyu-analyst/src/lib/store-status.ts',
      'fengyu-analyst/src/lib/repurchase.ts',
    ]) {
      expect(names, `扫描集缺 ${known}`).toContain(known)
    }
  })

  it('数据中心消费方源码不出现 is_closed / isClosed（含注释：统计范围只看节点 is_active）', () => {
    const offenders = []
    for (const file of CONSUMER_FILES) {
      readFile(file).split('\n').forEach((line, i) => {
        if (/\bis_?closed\b/i.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('#401 数据中心在营口径 · helper 本体', () => {
  it('两端 store-status helper 的代码行不出现 is_closed / isClosed（注释可解释口径，代码不许用）', () => {
    const helpers = [
      path.join(ADMIN_SRC, 'lib/store-status.ts'),
      path.join(STAFF_ROOT, 'utils/store-status.js'),
      path.join(ANALYST_SRC, 'lib/store-status.ts'),
    ]
    const offenders = []
    let codeLines = 0
    for (const file of helpers) {
      readFile(file).split('\n').forEach((line, i) => {
        const t = line.trim()
        if (!t || /^(\*|\/\*|\/\/)/.test(t)) return
        codeLines++
        if (/\bis_?closed\b|closed_?at/i.test(t)) offenders.push(`${rel(file)}:${i + 1}: ${t}`)
      })
    }
    expect(offenders).toEqual([])
    expect(codeLines).toBeGreaterThan(15) // 防剥注释把全文剥空
  })
})

describe('#401 数据中心在营口径 · closed_at 白名单', () => {
  /**
   * closed_at 在数据中心只允许一种用法：时点门店数的历史化表达式
   * `(s.closed_at IS NULL OR s.closed_at::date > <截止日>)`。任何别的写法（如
   * `EXISTS (... closed_at IS NULL)`、`isNull(stores.closedAt)`）都等于把「当前是否关店」
   * 偷渡进统计范围，会抹掉关店前的历史业绩 —— 与只禁 is_closed token 互补（闸门 2 codex round-1 P2）。
   * 注释行（`*` / `//` 开头）不计。
   */
  const ALLOWED = /^AND \(s\.closed_at IS NULL OR s\.closed_at::date > (\$\{(?:cur\.end|range\.end)\}|\$1::date)\)(`,)?$/

  it('数据中心消费方代码行里的 closed_at / closedAt 只允许门店数历史化表达式', () => {
    const offenders = []
    let seen = 0
    for (const file of CONSUMER_FILES) {
      readFile(file).split('\n').forEach((line, i) => {
        const t = line.trim()
        if (!/closed_?at/i.test(t)) return
        if (/^(\*|\/\*|\/\/)/.test(t)) return
        seen++
        if (!ALLOWED.test(t)) offenders.push(`${rel(file)}:${i + 1}: ${t}`)
      })
    }
    expect(offenders).toEqual([])
    // 防扫描落空：admin sales/efficiency 三处 + staff queryStoreCount 一处
    expect(seen).toBe(4)
  })
})

describe('#401 数据中心在营口径 · 单源', () => {
  function definitionSites(files) {
    const sites = []
    for (const file of files) {
      const count = readFile(file).split('function activeStoreCondition(').length - 1
      for (let i = 0; i < count; i++) sites.push(file)
    }
    return sites
  }

  it('admin 全部源码只在 lib/store-status.ts 定义一次 activeStoreCondition', () => {
    const sites = definitionSites(listSources(ADMIN_SRC, ['.ts', '.tsx']))
    expect(sites.map(rel)).toEqual(['fengyu-admin/src/lib/store-status.ts'])
  })

  it('staffApi 全部源码只在 utils/store-status.js 定义一次 activeStoreCondition', () => {
    const files = listSources(STAFF_ROOT, ['.js']) // 整个 staffApi（listSources 已跳过 node_modules 与测试文件）
    const sites = definitionSites(files)
    expect(sites.map(rel)).toEqual(['fengyu-staff/cloudfunctions/staffApi/utils/store-status.js'])
  })

  it('analyst 全部源码只在 lib/store-status.ts 定义一次 activeStoreCondition（#421）', () => {
    const sites = definitionSites(listSources(ANALYST_SRC, ['.ts', '.tsx']))
    expect(sites.map(rel)).toEqual(['fengyu-analyst/src/lib/store-status.ts'])
  })

  it('admin TS 谓词整段等值：只看节点 isActive', () => {
    const src = readFile(path.join(ADMIN_SRC, 'lib/store-status.ts'))
    const start = src.indexOf('export function isDataCenterActiveStore(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start).replace(/\s+/g, ' ').trim()
    expect(body).toBe(
      'export function isDataCenterActiveStore(store: { isActive: boolean }): boolean { return store.isActive }',
    )
  })
})

describe('#401 数据中心在营口径 · 接线', () => {
  it('admin scope-sql.ts 从 helper 引入 activeStoreCondition 并用于公共 scope 过滤', () => {
    const src = readFile(path.join(ADMIN_SRC, 'lib/data-center/scope-sql.ts'))
    expect(src).toContain("import { activeStoreCondition } from '@/lib/store-status'")
    expect(src).toMatch(/parts: SQL\[\] = \[activeStoreCondition\(col\)\]/)
  })

  it('admin 筛选器数据源：在营与停用两份列表用同一个谓词分流（#293 空态同口径）', () => {
    const src = readFile(path.join(ADMIN_SRC, 'actions/data-center/shared.ts'))
    expect(src).toContain("import { isDataCenterActiveStore } from '@/lib/store-status'")
    expect(src).toContain('const storeRows = allStoreRows.filter(isDataCenterActiveStore)')
    expect(src).toMatch(/const inactiveStores = allStoreRows\s*\.filter\(\(s\) => !isDataCenterActiveStore\(s\)\)/)
  })

  it('admin 系统概览门店数 = helper 统计范围 ∩ 按今天历史化在营（与数据中心门店数同口径，#422）', () => {
    const src = readFile(path.join(ADMIN_SRC, 'actions/dashboard.ts'))
    expect(src).toContain("import { activeStoreCondition } from '@/lib/store-status'")
    const today = "(NOW() AT TIME ZONE 'Asia/Shanghai')::date"
    expect(src.replace(/\s+/g, ' ')).toContain(
      '(SELECT COUNT(*) FROM stores s WHERE ${activeStoreCondition(sql`s.store_id`)}' +
        ' AND s.opening_date IS NOT NULL' +
        ` AND s.opening_date::date <= ${today}` +
        ` AND (s.closed_at IS NULL OR s.closed_at::date > ${today})) AS total_stores,`,
    )
  })

  it('staff 统计子页（品项 / 客量）的 sale 与 client 两个 scope 构造器都叠加在营口径（整段等值）', () => {
    const squeeze = (t) => t.replace(/\s+/g, ' ').trim()
    const extract = (src, start) => {
      const i = src.indexOf(start)
      const j = src.indexOf('\n}\n', i)
      expect(i, `未找到 ${start}`).toBeGreaterThan(-1)
      return squeeze(src.slice(i, j + 2))
    }
    for (const name of ['mgmt-product.js', 'mgmt-traffic.js']) {
      const src = readFile(path.join(STAFF_ROOT, 'routes', name))
      expect(src, name).toContain("const { activeStoreCondition } = require('../utils/store-status')")
      // 路由内所有 scope 都经这两个构造器：全文件 buildManagementStoreScope 调用恰好 2 处（就是它们俩）
      expect(src.split('buildManagementStoreScope(').length - 1, name).toBe(2)
      for (const [fn, col] of [['buildSaleScope', 'store_id'], ['buildClientScope', 'bound_store_id']]) {
        expect(extract(src, `function ${fn}(`), `${name} ${fn}`).toBe(
          `function ${fn}(scopeType, scopeId, alias, startIdx) {` +
            ` const column = \`\${alias}.${col}\`` +
            ' const scope = buildManagementStoreScope(scopeType, scopeId, column, startIdx)' +
            ' return { sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`, params: scope.params } }',
        )
      }
    }
  })

  it('staff 范围下拉 loadAllMarkets 的节点判定经 helper（不再手写 o_store.is_active）', () => {
    // 闸门 2 codex round-6 P2：下拉原先手写 `o_store.is_active = TRUE`，是 helper 之外的第三份实现
    const src = readFile(path.join(STAFF_ROOT, 'routes/mgmt-dashboard.js'))
    const i = src.indexOf('async function loadAllMarkets(')
    const body = src.slice(i, src.indexOf('\n}\n', i))
    expect(i).toBeGreaterThan(-1)
    expect(body).toContain("AND ${activeStoreNodeCondition('o_store')}")
    expect(src).not.toMatch(/o_store\.is_active/i)
  })

  it('staff helper 内部同源：activeStoreCondition 子查询的 WHERE 正是 activeStoreNodeCondition(active_node)', () => {
    const { activeStoreCondition, activeStoreNodeCondition } = require('../../utils/store-status')
    const squeeze = (t) => t.replace(/\s+/g, ' ').trim()
    expect(squeeze(activeStoreCondition('x.store_id'))).toBe(
      'x.store_id IN ( SELECT active_store.store_id FROM stores active_store' +
        ' JOIN org_nodes active_node ON active_store.org_node_id = active_node.id' +
        ` WHERE ${activeStoreNodeCondition('active_node')} )`,
    )
    expect(activeStoreNodeCondition('n')).toBe("n.type = '门店' AND n.is_active = TRUE")
  })

  it('staff mgmt-dashboard.js 从 helper 引入 activeStoreCondition 并叠加到三条 scope', () => {
    const src = readFile(path.join(STAFF_ROOT, 'routes/mgmt-dashboard.js'))
    expect(src.replace(/\s+/g, ' ')).toContain(
      "const { activeStoreCondition, activeStoreNodeCondition, STORE_NODE_JOIN, STORE_IS_ACTIVE, } = require('../utils/store-status')",
    )
    expect(src).toContain('sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`,')
    // 三个构造器整段等值（buildStaffScope 另由 technician-denominator 要件 7 钉住，这里一并钉，互不依赖）
    const squeeze = (t) => t.replace(/\s+/g, ' ').trim()
    for (const [fn, col] of [['buildSaleScope', 'store_id'], ['buildClientScope', 'bound_store_id'], ['buildStaffScope', 'store_id']]) {
      const i = src.indexOf(`function ${fn}(`)
      expect(i, fn).toBeGreaterThan(-1)
      expect(squeeze(src.slice(i, src.indexOf('\n}\n', i) + 2)), fn).toBe(
        `function ${fn}(scopeType, scopeId, alias, startIdx) {` +
          ` const column = \`\${alias}.${col}\`` +
          ' return withActiveStoreCondition( buildManagementStoreScope(scopeType, scopeId, column, startIdx), column, ) }',
      )
    }
    // 全文件 buildManagementStoreScope 调用恰好 3 处（就是上面三个构造器），没有绕开启用过滤的直调
    expect(src.split('buildManagementStoreScope(').length - 1).toBe(3)
  })
})

describe('#422 范围下拉「（已关店）」展示标记 · 两端 helper', () => {
  /**
   * 展示标记是数据中心链路里 is_closed 唯一合法的用途：判定只许出现在两端 store-closed-label helper 里，
   * 消费方（范围下拉数据源）只拿到 Set，上面的闭集守护照旧禁止消费方出现 is_closed token。
   * 这里整段钉死两个 helper 的查询本体——改成别的谓词（如 closed_at <= 今天、并入节点启停）必须同步两端并改这里。
   */
  const squeeze = (t) => t.replace(/\s+/g, ' ').trim()
  const extract = (src, start, end) => {
    const i = src.indexOf(start)
    expect(i, `未找到 ${start}`).toBeGreaterThan(-1)
    const j = src.indexOf(end, i)
    expect(j, `未找到 ${start} 的结尾`).toBeGreaterThan(i)
    return squeeze(src.slice(i, j + end.length))
  }

  it('staff helper 本体整段等值', () => {
    const src = readFile(path.join(STAFF_ROOT, 'utils/store-closed-label.js'))
    expect(extract(src, 'async function loadClosedStoreIds(', '\n}\n')).toBe(
      'async function loadClosedStoreIds(pg, storeIds) {' +
        ' if (storeIds.length === 0) return new Set()' +
        ' const rows = await pg.query(' +
        " 'SELECT store_id FROM stores WHERE is_closed = TRUE AND store_id = ANY($1::text[])'," +
        ' [storeIds], )' +
        ' return new Set((rows || []).map((row) => row.store_id)) }',
    )
    expect(src).toContain('module.exports = { loadClosedStoreIds }')
  })

  it('admin helper 本体整段等值（与 staff 同一谓词：is_closed = TRUE ∩ 给定门店）', () => {
    const src = readFile(path.join(ADMIN_SRC, 'lib/store-closed-label.ts'))
    expect(extract(src, 'export async function loadClosedStoreIds(', '\n}\n')).toBe(
      'export async function loadClosedStoreIds(storeIds: string[]): Promise<Set<string>> {' +
        ' if (storeIds.length === 0) return new Set()' +
        ' const rows = await db .select({ storeId: stores.storeId }) .from(stores)' +
        ' .where(and(eq(stores.isClosed, true), inArray(stores.storeId, storeIds)))' +
        ' return new Set(rows.map((row) => row.storeId)) }',
    )
  })

  /**
   * 数据中心消费方里凡是碰到关店标记的代码行（helper 名 / 引入路径 / 结果 Set）必须**整行**等于下表（闭集）。
   * 只按文件放行会漏：mgmt-dashboard.js 本身也是统计文件，在 summary 里再调一次 helper、或拿 Set 去
   * `filter(!closedIds.has(...))` 收窄统计范围都不会变红（#422 pr-ready boundary P2）。
   * 换变量名 / 换 import 写法同样会让行对不上而变红——改动须在这里登记并说明为何仍是纯展示。
   */
  it('消费方里关店标记的用法闭集：只在两份下拉数据源里打 closed 标、只在下拉展示里读它', () => {
    const EXPECTED = {
      'fengyu-admin/src/lib/data-center/types.ts': [
        'closed?: boolean',
      ],
      'fengyu-admin/src/lib/data-center/scope-options.ts': [
        'closed?: boolean',
        'export function storeOptionLabel(store: { storeName: string; closed?: boolean }): string {',
        'return store.closed ? `${store.storeName}（已关店）` : store.storeName',
        '...(store.closed ? { closed: true } : {}),',
      ],
      'fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js': [
        "const { loadClosedStoreIds } = require('../utils/store-closed-label')",
        'const closedIds = await loadClosedStoreIds(pg, visible.flatMap((market) => market.stores.map((store) => store.storeId)))',
        "console.error('[mgmtDashboard.scopeOptions] loadClosedStoreIds failed:', err)",
        'const markets = closedIds.size === 0',
        'stores: market.stores.map((store) => (closedIds.has(store.storeId) ? { ...store, closed: true } : store)),',
      ],
      'fengyu-admin/src/actions/data-center/shared.ts': [
        "import { loadClosedStoreIds } from '@/lib/store-closed-label'",
        'const closedIds = await loadClosedStoreIds(storeRows.map((s) => s.storeId)).catch((err: unknown) => {',
        "console.error('[data-center] loadClosedStoreIds failed:', err)",
        '.map((s) => ({ storeId: s.storeId, storeName: s.storeName, ...(closedIds.has(s.storeId) ? { closed: true } : {}) })),',
      ],
    }
    const actual = {}
    for (const file of CONSUMER_FILES) {
      const hits = readFile(file).split('\n')
        // 先剥同一行里的 /* … */ 片段，再按行首判注释：`/* x */ if (s.closed) continue` 不能被整行当注释丢掉
        .map((line) => line.replace(/\/\*.*?\*\//g, '').trim())
        .filter((t) => t && !/^(\*|\/\*|\/\/)/.test(t))
        // 结果 Set / helper 名 / 引入路径，以及**任何**写法的 closed 标识符（`.closed`、`['closed']`、`{ closed }`、
        // `'closed' in s`、`closed:`）——防止消费方拿它把关店店排除出取数范围（#422 闸门 2 codex R1/R2 P2）。
        // `\bclosed\b` 不命中 closed_at（下划线是词字符），后者由上方 closed_at 白名单单独管
        .filter((t) => /closedIds|loadClosedStoreIds|store-closed-label|\bclosed\b/.test(t))
      if (hits.length > 0) actual[rel(file)] = hits
    }
    expect(actual).toEqual(EXPECTED)
  })
})
