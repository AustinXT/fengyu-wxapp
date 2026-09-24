/**
 * 「产能技师」人均分母的跨端字面量守护（issue #320）。
 *
 * staff `routes/mgmt-dashboard.js` 的 `queryEmployeeCount` 与 admin
 * `lib/data-center/technician-sql.ts` 的 `technicianCteSql` 是**两份独立副本**
 * （根 CLAUDE.md：禁止跨端共享代码目录，一致性靠字面量 snapshot 守护）。
 *
 * ## 为什么必须钉在一起
 *
 * 这两处是同一个业务口径的两个出口：staff 首页的人均派生指标、admin 数据中心人效板的
 * 人均派生指标。#285 修了 admin 侧，staff 侧当时**没同步** —— 于是同一天同一区间，
 * 两端人均业绩的分母差 14 人（staff 152 / admin 166，2026-09-24 生产实测），
 * staff 侧所有人均指标虚高 +9.2%。这正是「改一端忘另一端」的典型，所以补本守护。
 *
 * 守的是**归属规则的三个要件**，不是 SQL 全文（两端写法必然有差异：
 * Drizzle `sql` 模板 vs 原生 `pg.query` 字符串、`$n` vs `${}`）：
 *   1. `COALESCE(store_id, ds.store_id)` —— 直挂门店组织节点的人回收进该门店
 *   2. `anchor_market_id` 的 `CASE WHEN type='市场'` 两级兜底（自身 / 父节点）
 *   3. `LEFT JOIN stores ds ON ds.org_node_id = …` —— 回收用的那条 join
 *   4. 人池过滤：`skills && ARRAY['美容师','养生师']` ∩ hired_at/resigned_at 历史化
 *   5. 可见性二选一：门店分支走 store scope、无门店分支走市场锚
 *   6. 无门店分支的三分支语义：all→TRUE / market→锚定相等 / store 及未知→FALSE
 *   7. 门店分支两端都叠「仅启用门店」过滤
 *
 * ⚠️ 要件 6、7 是第一轮双谱系评审（codex P2-1 + GLM P2-1 独立命中同一处）补的：
 * 要件 1~5 抽的是 `queryEmployeeCount` 的源文本，真正决定可见性的两个 helper
 * （`buildTechnicianOrgAnchorScope` / `buildStaffScope`）在归一化后只剩一个 `?`，
 * 把它们改坏五条要件照样全绿 —— 「守护看起来很全但恰好漏掉承重那一段」。
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffDashboard: path.resolve(__dirname, '../../routes/mgmt-dashboard.js'),
  adminTechnicianSql: path.resolve(
    __dirname,
    '../../../../../fengyu-admin/src/lib/data-center/technician-sql.ts',
  ),
  adminScopeSql: path.resolve(
    __dirname,
    '../../../../../fengyu-admin/src/lib/data-center/scope-sql.ts',
  ),
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/** 抽出 `start` 到 `end` 之间的源码片段（end 不含） */
function extractSection(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`未找到源码片段：${startMarker} → ${endMarker}`)
  }
  return src.slice(start, end)
}

/**
 * 归一化：抹掉两端必然不同的占位符与空白，只留下语义 token。
 * `$1` / `${endDate}` 都归成 `?`，多余空白压成单空格。
 */
function normalizeSql(sql) {
  return sql
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 只压空白、**保留 `${}`**。
 *
 * 可见性 helper 不能用 `normalizeSql` —— 它把 `${}` 抹成 `?`，而两端的可见性语义恰恰
 * 全在 `${}` 里（admin 的 `sql`${col} = ${scope.id}`` 会变成 `? = ?`，等于什么都没钉）。
 * 这正是本文件第一版的盲区：要件 1~5 抽的是 `queryEmployeeCount` 的源文本，而
 * `${sc.sql}` / `${anchor.sql}` 归一化后成了 `?`，两端 helper 改坏了 5 条要件照样全绿。
 */
function squeeze(src) {
  return src.replace(/\s+/g, ' ').trim()
}

describe('产能技师分母跨端字面量守护（#320）', () => {
  let staffSection
  let adminSection
  /** 两端「无门店技师可见性」helper 的源文本（保留 `${}`） */
  let staffAnchorFn
  let adminAnchorFn
  /** 两端「启用门店过滤」与「门店分支 scope 构造」的源文本 */
  let staffActiveFn
  let staffStaffScopeFn
  let adminActiveFn
  let adminScopeFilterFn

  beforeAll(() => {
    const staffSrc = readFile(FILES.staffDashboard)
    const adminScopeSrc = readFile(FILES.adminScopeSql)

    staffSection = normalizeSql(
      extractSection(
        staffSrc,
        'async function queryEmployeeCount(',
        '\n/**\n * 门店数（截面快照',
      ),
    )
    adminSection = normalizeSql(
      extractSection(
        readFile(FILES.adminTechnicianSql),
        'export function technicianCteSql(',
        '/** 产能技师总数',
      ),
    )

    staffAnchorFn = squeeze(
      extractSection(staffSrc, 'function buildTechnicianOrgAnchorScope(', '\n/**'),
    )
    adminAnchorFn = squeeze(
      extractSection(adminScopeSrc, 'export function orgAnchorScopeSql(', '\n/**'),
    )
    staffActiveFn = squeeze(
      extractSection(staffSrc, 'function activeStoreCondition(column)', '\n/**'),
    )
    staffStaffScopeFn = squeeze(
      extractSection(staffSrc, 'function buildStaffScope(', '\n/**'),
    )
    adminActiveFn = squeeze(
      extractSection(adminScopeSrc, 'function activeStoreCondition(storeCol: SQL)', '\n/**'),
    )
    adminScopeFilterFn = squeeze(
      extractSection(adminScopeSrc, 'export function scopeFilterSql(', '\n/**'),
    )
  })

  /** 抽取失败会让下面每条都通过（空串 include 恒真），所以先钉住抽取本身 */
  it('两端片段都成功抽到且非空', () => {
    expect(staffSection.length).toBeGreaterThan(200)
    expect(adminSection.length).toBeGreaterThan(200)
    expect(staffSection).toContain('technician_base')
    expect(adminSection).toContain('technician_base')
  })

  it('要件 1：两端都用 COALESCE 把直挂门店节点的人回收进该门店', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺 COALESCE 回收`).toMatch(
        /COALESCE\(sw\.store_id, ds\.store_id\) AS store_id/,
      )
    }
  })

  it('要件 2：两端 anchor_market_id 都是「自身是市场 → 自身，否则父节点是市场 → 父节点」', () => {
    const pattern = /CASE WHEN o\.type = '市场' THEN o\.id WHEN op\.type = '市场' THEN op\.id ELSE NULL END AS anchor_market_id/
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧锚定市场口径漂移`).toMatch(pattern)
    }
  })

  it('要件 3：两端都用同一条 join 回收门店（ds.org_node_id）', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺回收 join`).toMatch(
        /LEFT JOIN stores ds ON ds\.org_node_id = sw\.org_node_id/,
      )
      expect(src, `${end} 侧缺 org_nodes 两级 join`).toMatch(
        /LEFT JOIN org_nodes o ON o\.id = sw\.org_node_id/,
      )
      expect(src).toMatch(/LEFT JOIN org_nodes op ON op\.id = o\.parent_id/)
    }
  })

  it('要件 4：两端人池过滤一致（技能标签 + hired_at/resigned_at 历史化）', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧技能过滤漂移`).toMatch(
        /sw\.skills && ARRAY\['美容师','养生师'\]::text\[\]/,
      )
      expect(src).toMatch(/sw\.hired_at IS NOT NULL/)
      expect(src).toMatch(/sw\.hired_at::date <= \?/)
      expect(src).toMatch(/sw\.resigned_at IS NULL OR sw\.resigned_at::date > \?/)
      // 旧口径 is_resigned 实时快照不得回归
      expect(src, `${end} 侧不该再用 is_resigned 快照`).not.toMatch(/is_resigned/)
    }
  })

  it('要件 5：两端可见性都是「有门店走 store scope / 无门店走市场锚」二选一', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺门店分支`).toMatch(/store_id IS NOT NULL AND/)
      expect(src, `${end} 侧缺市场锚分支`).toMatch(/store_id IS NULL AND/)
      // 两个分支必须是 OR 关系（AND 会把无门店的人整体排除，退回 #320 之前）
      expect(src).toMatch(/store_id IS NOT NULL AND[\s\S]*OR[\s\S]*store_id IS NULL AND/)
    }
  })

  /**
   * 要件 6 —— 真正决定「单店不计入 / 市场锚计入」的是**可见性 helper**，不是 CTE。
   *
   * 要件 1~5 抽的是 `queryEmployeeCount` 的源文本，而里面的 `${sc.sql}` / `${anchor.sql}`
   * 是运行期拼出来的字符串：helper 改坏（market 比错 id、store 改成 TRUE）五条要件照样全绿。
   * 两端语言不同（JS 字符串拼接 vs drizzle `sql` 模板），无法逐字比对，
   * 因此各自钉三分支语义，再断言两端分支划分一致。
   */
  it('要件 6：两端无门店技师可见性都是 all→TRUE / market→锚定相等 / store→FALSE', () => {
    // --- staff 侧 ---
    expect(staffAnchorFn, 'staff 侧 all 分支必须按名字显式命中').toMatch(
      /if \(scopeType === 'all'\) return \{ sql: 'TRUE', params: \[\] \}/,
    )
    expect(staffAnchorFn, 'staff 侧 market 分支必须比锚定市场').toMatch(
      /if \(scopeType === 'market'\)[\s\S]*tb\.anchor_market_id = \$\$\{startIdx\}/,
    )
    /**
     * fail-closed：整个函数里 `'TRUE'` 只允许出现一次，且必须在 `'all'` 那一行。
     * 写成「先排掉 store/market、兜底 return TRUE」时未知 scopeType 会让分母
     * 静默膨胀成「全部直挂技师」（门店分支近乎空集、锚分支恒真）。
     */
    expect(staffAnchorFn.match(/'TRUE'/g) ?? []).toHaveLength(1)
    expect(staffAnchorFn, 'staff 侧兜底必须是 FALSE').toMatch(
      /return \{ sql: 'FALSE', params: \[\] \} \}$/,
    )

    // --- admin 侧 ---
    expect(adminAnchorFn, 'admin 侧 store 分支必须恒假').toMatch(
      /if \(scope\.type === 'store'\) return sql`FALSE`/,
    )
    expect(adminAnchorFn, 'admin 侧 market 分支必须比锚定市场').toMatch(
      /if \(scope\.type === 'market'\) return sql`\$\{col\} = \$\{scope\.id\}`/,
    )
    expect(adminAnchorFn, 'admin 侧 all 分支对超管恒真').toMatch(
      /if \(isAdminScope\(session\)\) return sql`TRUE`/,
    )
    /**
     * admin 多一个 staff 没有的分支：非超管选 all/authorized 时按「锚定市场下是否有本账号
     * 可见的启用门店」判定。staff 侧的 `all` 已由 `validateManagementScope` 要求持总部 scope，
     * 等价于 admin 的 `isAdminScope → TRUE`，所以这个分支**不构成口径分叉**。
     * 但它必须继续带启用门店条件，否则 admin 侧会把停用门店当可见凭据。
     */
    expect(adminAnchorFn, 'admin 侧非超管 all 分支必须走可见启用门店 EXISTS').toMatch(
      /EXISTS \([\s\S]*vn\.type = '门店'[\s\S]*vn\.is_active = TRUE[\s\S]*vn\.parent_id = \$\{col\}/,
    )
  })

  /**
   * 要件 7 —— 门店分支覆盖九成以上人头，它的 scope 语义同样必须两端一致。
   * 若只有一端叠「启用门店」过滤，凡停用门店还挂着在职技师，两端分母立刻分叉，
   * 而要件 1~6 一条都不会红（那些只看 CTE 与锚分支）。
   */
  it('要件 7：两端门店分支都叠加「仅启用门店」过滤', () => {
    for (const [end, active] of [['staff', staffActiveFn], ['admin', adminActiveFn]]) {
      expect(active, `${end} 侧启用门店过滤缺 type='门店'`).toMatch(/type = '门店'/)
      expect(active, `${end} 侧启用门店过滤缺 is_active = TRUE`).toMatch(/is_active = TRUE/)
    }
    // 过滤器存在还不够，必须真的被技师分母那条 scope 用上
    expect(staffStaffScopeFn, 'staff 的 buildStaffScope 未叠加启用门店过滤').toMatch(
      /withActiveStoreCondition\(/,
    )
    expect(adminScopeFilterFn, 'admin 的 scopeFilterSql 未叠加启用门店过滤').toMatch(
      /parts: SQL\[\] = \[activeStoreCondition\(col\)\]/,
    )
  })

  /**
   * 反向守护：admin 侧那份注释声明「这是单源，别在别处再抄一份」。
   * 若 admin 内部又出现只按 `store_id` 过滤的技师查询，两端就会再次分叉 ——
   * #285 的 codex 谱系把这种情形判过 P0（同一数据中心两个板块差 14 人）。
   *
   * ⚠️ 局限（有意接受）：① 注释剥离是启发式的，字符串字面量里出现 `/*` 会造成漏报；
   * ② 只盯 `efficiency.ts` / `sales.ts` 两个文件 —— 它们是历史上出过分叉的那两处。
   * 新板块若自己抄一份技师人池，本条抓不到，靠代码评审。
   */
  it('admin 侧的技师查询只有 technician-sql.ts 这一份单源', () => {
    const efficiency = readFile(
      path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/data-center/efficiency.ts'),
    )
    const sales = readFile(
      path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/data-center/sales.ts'),
    )
    for (const [name, src] of [['efficiency.ts', efficiency], ['sales.ts', sales]]) {
      // 剥注释后再找：注释里为解释口径而提到技能标签是允许的
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
      const hits = code.match(/skills && ARRAY\['美容师','养生师'\]/g) ?? []
      expect(
        hits,
        `${name} 里又出现了独立的技师人池查询 —— 必须复用 lib/data-center/technician-sql.ts`,
      ).toEqual([])
    }
  })
})
