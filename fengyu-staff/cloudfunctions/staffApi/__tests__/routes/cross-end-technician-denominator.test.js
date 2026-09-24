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
 * ⚠️ 要件 6~9 是双谱系评审逐轮逼出来的，成因都是同一个：**钉住了一层，就漏下一层**。
 * 第 1 轮漏可见性 helper（归一化后只剩 `?`）、第 2 轮漏「有没有真的调它」、
 * 第 4 轮漏「调的那个 helper 内部有没有被掏空」和「计数读的是哪张 CTE」。
 * 加断言时请顺着这条链往外再想一跳。
 *
 * ## 本文件**不**负责的一层（别在这里重复造断言）
 *
 * 「路由 handler 有没有真的调用 `queryEmployeeCount`」由**行为测试**覆盖：
 * `__tests__/routes/mgmt-dashboard.test.js` 直接 `await summary(ctx)`，再从
 * `pg.query.mock.calls` 里找 `technician_base` 那条 SQL 并断言其形态与**实参数组**
 * （market/store/all 三个 scope 各一组）。行为测试比字面量更强 —— 它连「函数存在但没人调」
 * 都能抓到。admin 侧同理：`fengyu-admin/src/actions/data-center/__tests__/consistency.sales.test.ts`
 * 断言 `sales.ts` 出现 `technicianCountSql(session, scope, range.end)` 且
 * 不再出现 `FROM staff_wechat_users`。
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

/**
 * 抽出计数查询那条 `WHERE`（到 SQL 模板结束为止），用于**整段等值比较**。
 *
 * 为什么必须等值比较而不是「包含若干子串」：见要件 5 的注释 —— 追加一个 `OR` 分支
 * 就能让单店 scope 重新计入全部直挂技师，而子串式断言一条都不会红。
 *
 * 入参是**已归一化**（`${}`/`$n` → `?`、空白压缩）的片段。
 *
 * ⚠️ admin 侧这条 WHERE 在 `technician_scoped` CTE 里，结尾多一个**独立成段**的 `)`。
 * 剥它必须只认「空白 + `)`」这种形态 —— 写成 `[\s)]*$` 会把分支自己的 `AND ?)` 那个
 * 右括号一起吃掉，两端都退化成松断言（等值比较就白做了）。
 */
function countingWhere(normalizedSection) {
  const i = normalizedSection.indexOf('WHERE (tb.store_id')
  if (i < 0) throw new Error('未找到计数查询的 WHERE（形态已变，先读要件 5 的注释）')
  return normalizedSection
    .slice(i)
    .split('`')[0]
    .trim()
    .replace(/(?:\s\))+$/, '')
}

/**
 * 抽出 `technician_base` CTE 的 `FROM … WHERE …` 全段，用于**整段等值比较**。
 *
 * 为什么这一段也必须等值而不是「包含若干子串」：第 5 轮 GLM 变异实测 —— 在这段 WHERE
 * 末尾追加一条 `AND sw.store_id IS NOT NULL`，人池里的直挂技师被整池剔掉、**#320 直接复发**
 * （166→152、人均虚高约 9%），而当时要件 1~4 全是「包含」式断言，一条都不红。
 * 任何**单端**新增过滤（`AND sw.status = '在职'` 之类）同理会造成两端静默分叉。
 *
 * 截断点取「空白 + 右括号」这第一处 —— 那是 CTE 的收尾。WHERE 内部
 * `(sw.resigned_at IS NULL OR …)` 的右括号前面没有空白，不会误伤（同 `countingWhere`）。
 */
function baseFromWhere(normalizedSection) {
  const i = normalizedSection.indexOf('FROM staff_wechat_users sw')
  if (i < 0) throw new Error('未找到 technician_base 的 FROM（形态已变，先读要件 4 的注释）')
  const rest = normalizedSection.slice(i)
  const j = rest.indexOf(' )')
  if (j < 0) throw new Error('未找到 technician_base CTE 的收尾右括号')
  return rest.slice(0, j).trim()
}

describe('产能技师分母跨端字面量守护（#320）', () => {
  let staffSection
  /** 同一段的**未归一化**原文（槽位顺序只有它能钉住，见要件 8） */
  let staffRaw
  let adminSection
  /** 两端「无门店技师可见性」helper 的源文本（保留 `${}`） */
  let staffAnchorFn
  let adminAnchorFn
  /** 两端「启用门店过滤」与「门店分支 scope 构造」的源文本 */
  let staffActiveFn
  let staffWithActiveFn
  let staffStaffScopeFn
  let staffMgmtScopeFn
  let adminActiveFn
  let adminScopeFilterFn

  beforeAll(() => {
    const staffSrc = readFile(FILES.staffDashboard)
    const adminScopeSrc = readFile(FILES.adminScopeSql)

    staffRaw = squeeze(
      extractSection(
        staffSrc,
        'async function queryEmployeeCount(',
        '\n/**\n * 门店数（截面快照',
      ),
    )
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
    staffWithActiveFn = squeeze(
      extractSection(staffSrc, 'function withActiveStoreCondition(', '\n/**'),
    )
    staffStaffScopeFn = squeeze(
      extractSection(staffSrc, 'function buildStaffScope(', '\n/**'),
    )
    staffMgmtScopeFn = squeeze(
      extractSection(
        readFile(path.resolve(__dirname, '../../utils/scope.js')),
        'function buildManagementStoreScope(',
        '\n/**',
      ),
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

  /**
   * 要件 4 —— 人池那段 `FROM … WHERE …` 必须**逐字**是这些，不能多一条过滤。
   *
   * 两端唯一的合法差异是参数的 cast：staff 传 text 参数自己 `::date`，
   * admin 由 drizzle 绑字符串、不需要再 cast。所以按端各写一份期望值，
   * 而不是拿两端互相比（互相比会因为这个 `::date` 恒红）。
   */
  it('要件 4：两端人池的 FROM/JOIN/WHERE 逐字固定（不得追加任何过滤）', () => {
    const JOINS =
      'FROM staff_wechat_users sw' +
      ' LEFT JOIN org_nodes o ON o.id = sw.org_node_id' +
      ' LEFT JOIN org_nodes op ON op.id = o.parent_id' +
      ' LEFT JOIN stores ds ON ds.org_node_id = sw.org_node_id' +
      " WHERE sw.skills && ARRAY['美容师','养生师']::text[]" +
      ' AND sw.hired_at IS NOT NULL'
    const EXPECTED = {
      staff: `${JOINS} AND sw.hired_at::date <= ?::date AND (sw.resigned_at IS NULL OR sw.resigned_at::date > ?::date)`,
      admin: `${JOINS} AND sw.hired_at::date <= ? AND (sw.resigned_at IS NULL OR sw.resigned_at::date > ?)`,
    }
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(baseFromWhere(src), `${end} 侧人池形态漂移`).toBe(EXPECTED[end])
      // 旧口径 is_resigned 实时快照不得回归（它会让历史月份数字随时间漂移）
      expect(src, `${end} 侧不该再用 is_resigned 快照`).not.toMatch(/is_resigned/)
    }
  })

  /**
   * 要件 5 —— 计数那条 WHERE 必须**逐字**是这两个分支，不能多一条。
   *
   * 第 4 轮 GLM 变异实测：原先三条松 regex
   * （`store_id IS NOT NULL AND` / `store_id IS NULL AND` / 两者以 OR 相连）
   * 挡不住**追加第三个 OR 分支** —— 例如加 `OR (tb.anchor_market_id IS NOT NULL)`：
   * 不动任何 helper、不加参数，单店 scope 就重新计入全部直挂技师（#320 直接复发、
   * 违反「单店不计入」这条验收标准），而当时 13 条断言全绿。括号与优先级也完全没钉。
   * 所以改成**整段等值比较**。
   */
  it('要件 5：两端计数 WHERE 逐字等于「门店分支 OR 无门店分支」两条，不得追加第三条', () => {
    const EXPECTED = 'WHERE (tb.store_id IS NOT NULL AND ?) OR (tb.store_id IS NULL AND ?)'
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(countingWhere(src), `${end} 侧计数 WHERE 形态漂移`).toBe(EXPECTED)
    }
    /**
     * WHERE 之外的 `SELECT`/`FROM` 也要钉：第 5 轮 GLM 变异实测，只钉 WHERE 时
     * 把 staff 的 `COUNT(*)` 改成 `COUNT(DISTINCT tb.store_id)`（数门店当人数）全绿。
     */
    expect(
      staffSection.slice(staffSection.indexOf('SELECT COUNT(*) AS v')).split('`')[0].trim(),
      'staff 计数语句形态漂移（SELECT / FROM 也在守护范围内）',
    ).toBe(`SELECT COUNT(*) AS v FROM technician_base tb ${EXPECTED}`)
    /**
     * admin 侧对应的是 `technician_scoped` 这段 CTE，整段等值 ——
     * 它的 SELECT 列表与 staff 不同（多带 `anchor_market_name`，给 byMarket 用），
     * 所以只能按端写期望值。
     */
    expect(
      adminSection.slice(adminSection.indexOf('technician_scoped AS (')).split('`')[0].trim(),
      'admin technician_scoped 形态漂移',
    ).toBe(
      'technician_scoped AS ( SELECT tb.employee_id, tb.store_id, tb.anchor_market_id,' +
        ` tb.anchor_market_name FROM technician_base tb ${EXPECTED} )`,
    )
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
    /**
     * 整行钉，不是 presence 钉：第 5 轮 GLM 变异实测，presence 写法挡不住
     * `(tb.anchor_market_id = $${startIdx}) OR TRUE` —— market 口径分母膨胀成全部直挂技师。
     */
    expect(staffAnchorFn, 'staff 侧 market 分支形态漂移').toContain(
      'return { sql: `tb.anchor_market_id = $${startIdx}`, params: [scopeId] }',
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
     * ⚠️ 必须钉 `return sql`EXISTS (`` 这个完整开头，不能只写 `/EXISTS \(/` ——
     * 后者能被 `NOT EXISTS (` 命中。第 4 轮 GLM 变异实测：在这里加一个 `NOT`，
     * 非超管的集团分母就翻成「锚定市场下**没有**可见启用门店」的补集（生产上约 1 人），
     * 而当时 13 条断言全绿。
     */
    expect(adminAnchorFn, 'admin 侧非超管 all 分支必须走可见启用门店 EXISTS（且不得取反）').toMatch(
      /return sql`EXISTS \([\s\S]*vn\.type = '门店'[\s\S]*vn\.is_active = TRUE[\s\S]*vn\.parent_id = \$\{col\}/,
    )
    expect(adminAnchorFn, 'admin 侧 EXISTS 被取反了').not.toMatch(/NOT EXISTS/)
  })

  /**
   * 要件 6b —— **已登记的跨端分叉**（#334）。本条绿 ≠ 两端一致，别这么读。
   *
   * staff 的 `all` 恒 TRUE；admin 的 `all` 只对**超管**恒 TRUE，非超管走
   * `EXISTS(锚定市场下存在本账号可见的启用门店)`。差异只在「锚定市场下一家启用门店都没有」时显形：
   *
   *   2026-09-24 生产只读实测 —— 「品项公司」`org-部门-1780556585278`（`type=市场`、
   *   直属门店 0 家）下有 **1 名**在职产能技师；落在「总部」类型节点上的**非超管**绑定共
   *   **14 个**（finance×1 / hr×1 / manager×10 / product×2）。这 14 个账号在 admin 看「集团」
   *   分母 165、在 staff 看「全部」分母 166；超管两边都是 166。
   *
   * 第 1 轮我在这里写过「等价、不构成分叉」，第 2 轮 codex 把它推翻了 —— 前提错在
   * `isAdminScope` 判的是**超管位**（`roles.some(r => r.isSuperAdmin)`），不是「持总部 scope」。
   * 之所以把分叉**钉下来**而不是悄悄放过：#283 那批审计的教训是
   * 「consistency 快照只防漂移不保口径，错误写法会反被钉死」。所以这里把两侧写法连同
   * **它不一致这件事**一起写进断言 —— 任一侧改动都会红，迫使回来读 #334 而不是顺手抹平。
   *
   * #334 落地（两端统一）时，本条应删除，并把要件 6 的 all 分支改成真正的等价断言。
   *
   * ⚠️ **本条守不住的一跳（有意，已登记）**：`isAdminScope` 的**函数体**不在本文件读取的
   * 任何文件里（它在 `fengyu-admin/src/lib/permissions.ts`）。把它改成恒真，
   * admin 的 all 分支与权限交集会一起对那 14 个非超管总部账号漂移 —— 恰好把 #334 的分叉
   * 「抹平」，从而绕过本条哨兵，而本文件全绿。它是认证原语（类比 `pg` 本身），
   * 归 #334 落地时在 admin 侧守护里钉。
   */
  it('要件 6b：已登记分叉 —— staff 的 all 无条件恒真、admin 的 all 只对超管恒真（#334）', () => {
    // staff：`all` 不看任何账号上下文（helper 连 auth 都不收）
    expect(staffAnchorFn).not.toMatch(/auth|session|isAdminScope|scopeStoreIds/)
    expect(staffAnchorFn).toMatch(/if \(scopeType === 'all'\) return \{ sql: 'TRUE', params: \[\] \}/)
    // admin：`all` 的恒真挂在超管位上，非超管另有一条按门店判定的分支
    expect(adminAnchorFn).toMatch(/isAdminScope\(session\)/)
    expect(adminAnchorFn).toMatch(/session\.permissions\.scopeStoreIds/)
    /**
     * 承重事实：admin 那条分支只认**门店**，对「没有门店的市场」永远判不出可见 ——
     * 这就是分叉的机制本身。若将来它改成按组织节点判定（#334 的修法方向），本断言会红。
     */
    expect(adminAnchorFn).toMatch(/FROM stores vs[\s\S]*vs\.store_id IN/)
  })

  /**
   * 要件 7 —— 门店分支覆盖九成以上人头，它的 scope 语义同样必须两端一致。
   * 若只有一端叠「启用门店」过滤，凡停用门店还挂着在职技师，两端分母立刻分叉，
   * 而要件 1~6 一条都不会红（那些只看 CTE 与锚分支）。
   */
  it('要件 7：两端门店分支都叠加「仅启用门店」过滤', () => {
    /**
     * 整段等值，不是 token presence。第 6 轮 GLM 变异实测：只钉 `type = '门店'` 与
     * `is_active = TRUE` 两个 token 时，下面三种改法全绿且在真实数据上静默算错分母 ——
     *   A. `IN (` → `NOT IN (`：门店分支取补集（集团口径变成「直挂 + 停用门店技师」）
     *   B. `SELECT active_store.store_id` → `SELECT active_node.id`：
     *      store_id 与组织节点 id 空间不相交 → 子查询恒空集 → 门店分支整池消失
     *   C. 子查询内追加 `AND active_node.parent_id IS NOT NULL`（该列真实存在）→
     *      启用门店集合缩水、staff 单端与 admin 静默分叉
     * 这个函数被 sale / client / staff 三条 scope 共用，「顺手改一处」的现实概率不低。
     *
     * 两端除插值名（`${column}` vs `${storeCol}`）与 `sql` 模板标记外逐字同构，
     * 故按端各写期望字面量（不违反禁止跨端共享代码目录那条 invariant —— 这里共享的是断言，
     * 不是实现）。
     */
    const SUBQUERY =
      'SELECT active_store.store_id' +
      ' FROM stores active_store' +
      ' JOIN org_nodes active_node ON active_store.org_node_id = active_node.id' +
      " WHERE active_node.type = '门店'" +
      ' AND active_node.is_active = TRUE'
    expect(staffActiveFn, 'staff 侧启用门店过滤形态漂移').toBe(
      'function activeStoreCondition(column) {' +
        ` return \`\${column} IN ( ${SUBQUERY} )\` }`,
    )
    expect(adminActiveFn, 'admin 侧启用门店过滤形态漂移').toBe(
      'function activeStoreCondition(storeCol: SQL): SQL {' +
        ` return sql\` \${storeCol} IN ( ${SUBQUERY} ) \` }`,
    )
    /**
     * 过滤器存在还不够，必须真的被技师分母那条 scope 用上 —— 而且整段等值。
     *
     * 第 7 轮 GLM：这个函数体此前只有一条 presence 断言（含 `withActiveStoreCondition(`），
     * 它对 `buildManagementStoreScope` 的调用、`column` 的列推导、`scopeType`/`startIdx` 透传
     * 全部裸奔。要件 7 把 `buildManagementStoreScope` 三分支整行钉死了 ——
     * 但没人调它就是死代码。三种绿变异：
     *   · 内联 `{ sql: 'TRUE' }` 或写死 `buildManagementStoreScope('all', …)`
     *     → 单店/市场口径分母膨胀成全部启用门店技师（单店看板直接显示集团数）
     *   · `column` 改错列 → 门店分支整池消失，`all` 口径退回 152（#320 反向复发）
     *   · `startIdx` 写死 → 现有三个 scope 下恒等、不可观测（同要件 8 第三种形态）
     *
     * ⚠️ 同文件有**三个**同构的 scope helper：`buildSaleScope` / `buildClientScope` /
     * `buildStaffScope`，函数体除列名外逐字相同（分别取 `store_id` / `bound_store_id` /
     * `store_id`）。本守护只钉 `buildStaffScope` —— 分母走的是它。
     * 做红检时用函数名定位，别按「第一处匹配」改，否则会改到 `buildSaleScope` 上、
     * 结果不红而误判成守护失灵（我第二次栽在同一个坑上，另一次是 `utils/scope.js` 的孪生函数）。
     */
    expect(staffStaffScopeFn, 'staff 的 buildStaffScope 形态漂移').toBe(
      'function buildStaffScope(scopeType, scopeId, alias, startIdx) {' +
        ' const column = `${alias}.store_id`' +
        ' return withActiveStoreCondition(' +
        ' buildManagementStoreScope(scopeType, scopeId, column, startIdx), column, ) }',
    )
    expect(adminScopeFilterFn, 'admin 的 scopeFilterSql 未叠加启用门店过滤').toMatch(
      /parts: SQL\[\] = \[activeStoreCondition\(col\)\]/,
    )
    /**
     * admin `scopeFilterSql` 的**store 分支**与**最终拼接**也要钉。
     * （第 7 轮 GLM P2-1。注意它与已撤销的那条 P3-2 不同：那条说的是消费者
     * byStore/byMarket 的 WHERE、已有 admin 测试覆盖；这条是 scope helper 内部。）
     * 删掉 store 分支的 `parts.push`、或把 `join` 的 ` AND ` 改成 ` OR `，
     * admin 单店口径分母就变成「权限交集 ∩ 全部启用门店」（超管 = 全集团），与 staff 分叉。
     *
     * 这里不做整段等值：该函数体内有三条行内 `//` 注释，整段钉会让任何注释改动都变红 ——
     * 口径守护不该被注释措辞绑死。
     */
    expect(adminScopeFilterFn, 'admin 的 store 分支丢了等值收窄').toContain(
      "if (scope.type === 'store') { parts.push(sql`${col} = ${scope.id}`) }",
    )
    expect(adminScopeFilterFn, 'admin 的 scope 片段不是以 AND 拼接').toContain(
      'return sql.join(parts, sql` AND `)',
    )
    /**
     * ⚠️ 只钉「`buildStaffScope` 里出现了 `withActiveStoreCondition(` 这个名字」还不够 ——
     * 第 4 轮 GLM 变异实测：把 `withActiveStoreCondition` 的**函数体**改成 `return scope`
     * （整条过滤消失），`buildStaffScope` 的文本一个字没变，13 条断言全绿，
     * 停用门店的技师全部回流进分母、且与 admin 分叉。链路中段那一节也得钉。
     */
    expect(staffWithActiveFn, 'staff 的 withActiveStoreCondition 未把过滤以 AND 拼进来').toContain(
      '`(${scope.sql}) AND ${activeStoreCondition(column)}`',
    )
    /**
     * admin 门店分支的 market 展开与权限交集同理 —— 只钉 `activeStoreCondition` 那一行时，
     * 把 market 分支改成「只取直接子门店」或丢掉权限交集都不会红。
     */
    expect(adminScopeFilterFn, 'admin 的 market 分支未走递归后代展开').toContain(
      '${col} IN ${orgNodeStoreIdsSubquery(scope.id)}',
    )
    expect(adminScopeFilterFn, 'admin 丢了账号权限交集（非超管应按 scopeStoreIds 收窄）').toMatch(
      /if \(!isAdminScope\(session\)\)[\s\S]*session\.permissions\.scopeStoreIds[\s\S]*if \(ids\.length === 0\) return sql`FALSE`/,
    )
    /**
     * staff 镜像：`buildManagementStoreScope` 的**三个分支都要整行钉**。
     * 第 5 轮 GLM 变异实测：只钉 market 那行时，把 `all` 分支改成 `{ sql: 'FALSE' }`
     * 会让首页「全部」口径分母静默归零（所有人均显示 `--`），本文件全绿。
     */
    expect(staffMgmtScopeFn, 'staff 的 all 分支形态漂移').toContain(
      "if (scopeType === 'all') return { sql: 'TRUE', params: [] }",
    )
    expect(staffMgmtScopeFn, 'staff 的 store 分支形态漂移').toContain(
      'return { sql: `${column} = $${startIndex}`, params: [scopeId] }',
    )
    expect(staffMgmtScopeFn, 'staff 的 market 分支未走 descendantStoresSqlForRoot').toContain(
      'descendantStoresSqlForRoot(column, startIndex)',
    )
  })

  /**
   * 要件 8 —— 钉「承重接线」。
   *
   * 要件 1~5 钉 `queryEmployeeCount` 的 SQL 文本、要件 6~7 钉两个 helper 的**源码**，
   * 但「这条 SQL 真的用了那两个 helper」此前没有任何断言：把 `buildStaffScope(...)` 换成
   * `buildManagementStoreScope(...)`、把 anchor 换成内联 `{sql:'TRUE',params:[]}`、
   * 或把 `2 + sc.params.length` 写死 —— 七条要件可以全绿。
   * （前两种今天会被 `mgmt-dashboard.test.js` 的 SQL 形态断言抓到，第三种在现有三个
   * scopeType 下是恒等变换、不可观测；但守护不该指望「另一个文件恰好也测了」。）
   */
  it('要件 8：queryEmployeeCount 必须真的调用那两个 helper，且参数按 sc → anchor 顺序拼接', () => {
    expect(staffSection, '门店分支未走 buildStaffScope（会丢启用门店过滤）').toContain(
      "buildStaffScope(scopeType, scopeId, 'tb', 2)",
    )
    expect(staffSection, '锚分支未走 buildTechnicianOrgAnchorScope').toContain(
      'buildTechnicianOrgAnchorScope(scopeType, scopeId, 2 + sc.params.length)',
    )
    // 起始下标必须由前一段的 params 长度推导，不能写死
    expect(staffSection).not.toMatch(/buildTechnicianOrgAnchorScope\(scopeType, scopeId, \d+\)/)
    expect(staffSection).toContain('[date, ...sc.params, ...anchor.params]')
    /**
     * ⚠️ **槽位顺序**必须读未归一化原文才钉得住。
     * 第 5 轮 GLM 变异实测：把两个插值互换（门店分支塞 `${anchor.sql}`、锚分支塞 `${sc.sql}`），
     * 归一化后逐字不变 → 要件 5 的等值比较通过，要件 8 的 `toContain` 是无序的、也通过。
     * 运行期后果不报错：`all` 口径下无门店分支变成 `store_id IS NULL AND (store_id IN …)` 恒假，
     * 直挂技师整体丢失（166→152）；单店口径恒 0，被上游 safeDiv 吞成全零人均。
     */
    expect(staffRaw, 'staff 两个 scope 片段的槽位被对调了').toContain(
      'WHERE (tb.store_id IS NOT NULL AND ${sc.sql})' +
        ' OR (tb.store_id IS NULL AND ${anchor.sql})',
    )
    /**
     * base CTE 里那两个 `$1` 也只有读原文才钉得住（归一化后都是 `?`）。
     * 改成 `$2` 会绑到 scopeId 上 —— 后果是**响亮的**报错（date 转换失败或参数不存在）
     * 而非静默错数，所以级别不高；但项目 invariant 明列「占位符序号错位」是已知风险点，
     * 而守护成本只有两行。
     */
    expect(staffRaw, 'base CTE 的 hired_at 绑错了参数序号').toContain(
      'AND sw.hired_at::date <= $1::date',
    )
    expect(staffRaw, 'base CTE 的 resigned_at 绑错了参数序号').toContain(
      'AND (sw.resigned_at IS NULL OR sw.resigned_at::date > $1::date)',
    )
  })

  /**
   * 要件 8b —— **admin 侧的接线同样要钉**。
   *
   * 这是第 1 轮那个缺陷的镜像：`adminSection` 经 `normalizeSql` 后，
   * `${scopeFilterSql(session, scope, 'tb.store_id')}` 与 `${orgAnchorScopeSql(...)}`
   * 都成了 `?`。codex 第 4 轮实测：把 admin 门店分支的 `scopeFilterSql(...)` 换成
   * `sql`TRUE``，归一化结果**完全相同**、要件 1~8 全绿，而 admin 会整体越过门店 scope
   * （任何角色看任何 scope 都拿到全集团分母）。所以这里必须读**未归一化**的原文。
   */
  it('要件 8b：admin technicianCteSql 必须真的调用两个 scope helper（未归一化原文）', () => {
    const adminRaw = squeeze(
      extractSection(
        readFile(FILES.adminTechnicianSql),
        'export function technicianCteSql(',
        '/** 产能技师总数',
      ),
    )
    expect(adminRaw, 'admin 门店分支未走 scopeFilterSql').toContain(
      "${scopeFilterSql(session, scope, 'tb.store_id')}",
    )
    expect(adminRaw, 'admin 锚分支未走 orgAnchorScopeSql').toContain(
      "${orgAnchorScopeSql(session, scope, 'tb.anchor_market_id')}",
    )
    // 槽位顺序（同 staff 侧要件 8 的说明：归一化后互换不可见）
    expect(adminRaw, 'admin 两个 scope helper 的槽位被对调了').toContain(
      "WHERE (tb.store_id IS NOT NULL AND ${scopeFilterSql(session, scope, 'tb.store_id')})" +
        " OR (tb.store_id IS NULL AND ${orgAnchorScopeSql(session, scope, 'tb.anchor_market_id')})",
    )
    // 历史化的两个时间锚也必须真的绑 endDate，而不是写死日期或漏掉
    expect(adminRaw).toContain('sw.hired_at::date <= ${endDate}')
    expect(adminRaw).toContain('(sw.resigned_at IS NULL OR sw.resigned_at::date > ${endDate})')
    // 两个 helper 必须是从 scope-sql 模块 import 进来的，不能在本文件另起一份
    const adminSrc = readFile(FILES.adminTechnicianSql)
    expect(adminSrc).toMatch(
      /import \{ scopeFilterSql, orgAnchorScopeSql \} from '@\/lib\/data-center\/scope-sql'/,
    )
    /**
     * ⚠️ **消费端**也要钉。admin 的 CTE 分两段（`technician_base` 未过滤 →
     * `technician_scoped` 过滤后），最终计数必须读**过滤后**那张。
     * 第 4 轮 GLM 变异实测：把 `FROM technician_scoped` 改成 `FROM technician_base`，
     * scoped 段留成死代码 —— 任何角色任何 scope 都拿到全集团分母，而当时 13 条断言全绿
     * （`technicianCountSql` 整个落在抽取区间之外）。
     *
     * staff 侧不存在这个形态：它只有一张 `technician_base`，过滤条件直接写在计数的
     * WHERE 上，由要件 5 的**整段等值比较**守住。
     *
     * ⚠️ **本文件只钉 `technicianCountSql` 这一个消费函数** —— 它才是「人均派生分母」，
     * 也就是本守护的对象。admin 另外两个消费函数（`technicianByStoreSql` /
     * `technicianDirectByMarketSql`，分门店 / 分市场分解）由 admin 侧守护：
     * `fengyu-admin/src/actions/data-center/__tests__/consistency.efficiency.test.ts`
     * 的「⭐ 三个消费函数都必须复用 technicianCteSql 且只读过滤后的 technician_scoped」，
     * 那条同样断言了 `WITH ${technicianCteSql(...)}` 与 `FROM technician_scoped`、
     * 并反向禁 `FROM technician_base`。
     * 别据此以为本文件漏钉了两个 —— 是分工，不是缺口（第 8 轮 GLM 在这里读出过落差，
     * 根因是我在上一轮的总结里把三个都算进了本文件）。
     */
    const adminCount = squeeze(
      extractSection(
        readFile(FILES.adminTechnicianSql),
        'export function technicianCountSql(',
        '/** 产能技师数 by store',
      ),
    )
    expect(adminCount, 'admin 计数没读过滤后的 CTE').toContain(
      'SELECT COUNT(*)::int AS v FROM technician_scoped',
    )
    expect(adminCount, 'admin 计数没复用 technicianCteSql').toContain(
      'WITH ${technicianCteSql(session, scope, endDate)}',
    )
  })

  /**
   * 要件 9 —— market scope 下「市场 → 门店集合」的展开必须两端同构。
   *
   * 门店分支覆盖九成以上人头，而它在 market 口径下的取值完全由这段展开决定：
   * staff `descendantStoresSqlForRoot`（`utils/scope.js`）vs admin `descendantOrgNodeIdsSubquery`
   * + `orgNodeStoreIdsSubquery`（`lib/market-store-sql.ts`）。两端都是「递归后代 + path 防环
   * + 按 `stores.org_node_id` 落店」，逐字核对同构。若一端改成只取直接子节点、或去掉防环，
   * 市场口径分母会静默分叉，而要件 1~8 无一变红。
   */
  it('要件 9：两端市场展开都是「递归后代 + path 防环 + 按 org_node_id 落店」', () => {
    const staffExpand = squeeze(
      extractSection(
        readFile(path.resolve(__dirname, '../../utils/scope.js')),
        'function descendantStoresSqlForRoot(',
        '\n/**',
      ),
    )
    const adminExpand = squeeze(
      extractSection(
        readFile(path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/market-store-sql.ts')),
        'export function descendantOrgNodeIdsSubquery(',
        '/** 返回某组织节点子树内所有关联门店的子查询。 */',
      ),
    )
    /**
     * 同样整段等值。第 6 轮 GLM 变异实测：presence 式的五条断言（递归 CTE / 递推 / 防环 /
     * 种子 / 落店）挡不住在递推的 `WHERE` 后追加 `AND child.is_active = TRUE`
     * （`org_nodes` 真有这一列）—— 停用组织节点被剔出后代树、其下门店整批丢失
     * → **market 口径分母静默缩水**，而当时断言全绿（防环那条 regex 没有尾锚）。
     *
     * staff 侧这一段**单独决定 market 口径的分母**，所以必须逐字钉死。
     *
     * ⚠️ `utils/scope.js` 里有一对孪生函数：`descendantStoresSqlForRoots`（**复数**，收 text[]）
     * 与 `descendantStoresSqlForRoot`（单数，收单个根）。本守护只钉**单数**那个 ——
     * 它才在技师分母链路上（`buildManagementStoreScope` 用它）；复数版服务于
     * `expandScopeStoreIds`（登录时展开账号可见门店），不影响本口径。
     * 做红检时别改错那一个：改复数版**不会**红，那是对的，不是守护失灵（我第一次就改错了）。
     *
     * ⚠️ 用**函数式** replacement：`replaceAll` 的字符串 replacement 里 `$$` 是转义序列
     * （会被折成一个 `$`），直接写 `'$${startIndex}'` 会被悄悄改成 `'${startIndex}'`，
     * 断言变成「期望少一个 `$`」—— 恰好是本文件在防的那类「看着钉住其实钉错」。
     */
    const recursion = (seed) =>
      'WITH RECURSIVE descendants(id, path) AS (' +
      ` SELECT ${seed}::text, ARRAY[${seed}::text]` +
      ' UNION ALL' +
      ' SELECT child.id, descendants.path || child.id' +
      ' FROM org_nodes child' +
      ' JOIN descendants ON child.parent_id = descendants.id' +
      ' WHERE NOT child.id = ANY(descendants.path) )'
    expect(staffExpand, 'staff 侧市场展开形态漂移').toBe(
      'function descendantStoresSqlForRoot(column, startIndex) {' +
        ' return `${column} IN ( ' +
        recursion('$${startIndex}') +
        ' SELECT DISTINCT s.store_id FROM stores s' +
        ' JOIN descendants ON s.org_node_id = descendants.id )` }',
    )
    expect(adminExpand, 'admin 侧市场展开形态漂移').toBe(
      'export function descendantOrgNodeIdsSubquery(rootNodeId: string): SQL {' +
        ' return sql`( ' +
        recursion('${rootNodeId}') +
        ' SELECT id FROM descendants )` }',
    )
    // 落店那一跳：staff 在同一段内 JOIN stores，admin 在外层 orgNodeStoreIdsSubquery 里
    expect(staffExpand).toMatch(/FROM stores s JOIN descendants ON s\.org_node_id = descendants\.id/)
    const adminOuter = squeeze(
      extractSection(
        readFile(path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/market-store-sql.ts')),
        'export function orgNodeStoreIdsSubquery(',
        '/** 任意组织节点列是否落在指定组织节点子树内。 */',
      ),
    )
    /**
     * 整段等值 —— 只钉 FROM/WHERE 会漏掉**投影列**。第 7 轮 GLM 指出：
     * `SELECT s.store_id` → `SELECT s.org_node_id` 时 FROM/WHERE 一字未动、regex 照旧命中，
     * 而运行期 `tb.store_id IN (组织节点 id 集合)` 恒假 → admin 的 market 口径门店分支塌缩，
     * 只剩直挂锚定者（生产上南昌凤御 68 → 约 8），与 staff 静默分叉。
     * 这与第 6 轮变异 B（`active_store.store_id` → `active_node.id`）是同一类，只是落在下一跳。
     */
    expect(adminOuter, 'admin 落店那一跳形态漂移').toBe(
      'export function orgNodeStoreIdsSubquery(rootNodeId: string): SQL {' +
        ' return sql`( SELECT s.store_id FROM stores s' +
        ' WHERE s.org_node_id IN ${descendantOrgNodeIdsSubquery(rootNodeId)} )` }',
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
   *
   * ⚠️ 本条只是**跨端侧的一道副本**，admin 那边有更完整的同名守护：
   * `consistency.efficiency.test.ts` 的「⭐ 单源纪律」同时要求两个文件 import
   * `@/lib/data-center/technician-sql`。那条测试还写明了**为什么不能笼统禁
   * `FROM staff_wechat_users`** —— `efficiency.ts` 的 Part D `producer_base` 合法地扫该表取
   * 员工榜人池（且刻意**不**按 skills 过滤）。所以「只按 store_id 过滤的技师查询」这种形态，
   * 判据只能是 skills 白名单是否在单源之外出现，不能是表名。别照着「表名也禁掉」改。
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
      /**
       * ⚠️ 探测必须**宽松**。精确串 `skills && ARRAY['美容师','养生师']` 在「漏报」方向
       * fail-open：新抄一份写成 `ARRAY[ '美容师' , '养生师' ]`、换成 `skills @> ...`，
       * 语义一样却因格式不匹配而放过 —— 而这条守护的全部价值就在于抓「又抄了一份」。
       * 所以红线是「出现了对 `skills` 的人池过滤」这件事本身（GLM 第 4 轮 P2-3）。
       */
      /**
       * 两个方向都要探：`skills` 在操作符**左侧**（`skills && ARRAY[…]`、`skills @> …`）
       * 与在**右侧**（`'美容师' = ANY(sw.skills)`、`unnest(sw.skills) IN (…)`）——
       * 后者是数组成员判定的自然写法，第 7 轮 GLM 指出只探左侧等于留了一道现成的绕行门。
       */
      const PROBES = [
        // skills 在操作符左侧
        /skills\s*(?:&&\s*ARRAY\s*\[|@>|<@|=\s*ANY)/g,
        // skills 在操作符右侧（数组成员判定的自然写法）
        /ANY\s*\(\s*[\w.]*skills/g,
        /unnest\s*\(\s*[\w.]*skills/g,
        /(?:&&|@>|<@)\s*[\w]+\.skills\b/g,
        /array_position\s*\(\s*[\w.]*skills/g,
      ]
      const hits = PROBES.flatMap((re) => code.match(re) ?? [])
      expect(
        hits,
        `${name} 里又出现了独立的技师人池查询 —— 必须复用 lib/data-center/technician-sql.ts`,
      ).toEqual([])
    }
  })
})
