/**
 * 「门店在营 / 已停用」判定的跨端字面量守护（issue #400，口径对齐 admin #293）。
 *
 * staff `utils/store-status.js`（#401 起 #400 的判定片段并入此文件，原 utils/store-active.js）是 admin `actions/data-center/shared.ts`（inactiveStores 分流）
 * 的**独立副本**（根 CLAUDE.md：禁止跨端共享代码目录，一致性靠字面量 snapshot 守护）。
 *
 * ## 守什么
 *
 * 1. 判定片段整段等值（快照）：只看门店组织节点 `org_nodes.is_active`（type='门店'），
 *    缺节点按停用 —— 与取数 SQL 的 activeStoreCondition 同口径（取数滤掉的门店 = 判停用的门店）。
 * 2. 取数口径两端整段等值：staff `activeStoreCondition` ≡ admin `activeStoreCondition`。
 *    判定片段是照着它写的，它一变，判定就会和「满屏 0」错位。
 * 3. staff 四个使用点（fetchScopedStores / loadInactiveStores / resolveScope / hasActiveAlternative）的 SQL 整段等值，
 *    都经由 1 的常量拼出，不内联另一套判定（比如混进 is_closed——#401 起 hasActiveAlternative 也随范围下拉去掉了关店排除）。
 * 4. admin 侧判定仍是「只看 isActive」且 isActive 取自门店组织节点，不含 isClosed（#401 起经 lib/store-status isDataCenterActiveStore）。
 * 5. 经营分析站 fengyu-analyst（#421 跟随 #401）：第三份副本 lib/store-status.ts 纳入 2 的整段等值；
 *    analyst-scope.ts 取数首位叠在营子查询、范围下拉只看节点 isActive。
 */

const fs = require('node:fs')
const path = require('node:path')

const STAFF = path.resolve(__dirname, '../..')
const ADMIN = path.resolve(__dirname, '../../../../../fengyu-admin/src')
// 经营分析站（#421 跟随 #401）：独立部署，第三份副本。analyst 自己的 vitest 不进 CI（#382），
// 这里在 staff 全量套件（CI 必跑）里补一道源码级守护；完整守护见 analyst src/lib/__tests__/store-status-cross-end.test.ts
const ANALYST = path.resolve(__dirname, '../../../../../fengyu-analyst/src')

const read = (p) => fs.readFileSync(p, 'utf8')
const squeeze = (s) => s.replace(/\s+/g, ' ').trim()

/** 抽出 `start` 到 `end` 之间的源码片段（end 不含） */
function extractSection(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`未找到源码片段起点：${startMarker}`)
  if (src.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`源码片段起点不唯一：${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`未找到源码片段终点：${startMarker} → ${endMarker}`)
  return src.slice(start, end)
}

/** 片段里**唯一**一条反引号 SQL 模板（多于一条说明形态已变，先读本文件注释） */
function onlySqlTemplate(section) {
  const all = section.match(/`[^`]*`/g) || []
  const sqls = all.filter((t) => /\bSELECT\b/.test(t))
  if (sqls.length !== 1) throw new Error(`期望 1 条 SQL 模板，实得 ${sqls.length}`)
  return squeeze(sqls[0].slice(1, -1))
}

/**
 * 经营分析站决定「哪些门店计入」的 7 个文件的整份全文快照（见 test 5）。
 * 改动后按失败输出的 actual 更新——更新前先跑 analyst 本地守护（store-status-cross-end / analyst-scope 测试）。
 */
const ANALYST_FILE_SHA = {
  'lib/store-status.ts': 'ea3b4fb11e2216b5',
  'lib/analyst-scope.ts': 'fa90128b93554c6f',
  'lib/repurchase.ts': '055550992fab536d',
  'lib/new-customer-funnel.ts': 'aa58831a62d68c7c',
  'lib/penetration.ts': '5ba4747866119212',
  // 账号可见门店（须含停用门店，首次基线依赖）与 roles→全局判定的输入源（GLM round-2 P2）
  'lib/permissions.ts': '5a7a96011d83b241',
  'lib/auth.ts': 'd07c3178e77fbdc4',
}

describe('门店在营判定跨端字面量守护（#400）', () => {
  const { STORE_NODE_JOIN, STORE_IS_ACTIVE } = require('../../utils/store-status')

  test('1. 判定片段整段快照', () => {
    expect(STORE_NODE_JOIN).toBe(
      "LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id AND store_node.type = '门店'",
    )
    expect(STORE_IS_ACTIVE).toBe('COALESCE(store_node.is_active, FALSE)')
  })

  test('2. 取数口径 activeStoreCondition 两端整段等值，且与判定片段要件一一对应', () => {
    // #401 起两端 activeStoreCondition 都收敛到各自的 store-status helper
    // 三端：staff / admin / 经营分析站（#421）
    const staffBody = extractSection(
      read(path.join(STAFF, 'utils/store-status.js')),
      'function activeStoreCondition(column) {',
      '\n}\n',
    )
    const adminBody = extractSection(
      read(path.join(ADMIN, 'lib/store-status.ts')),
      'function activeStoreCondition(storeCol: SQL): SQL {',
      '\n}\n',
    )
    const inner = (body) => squeeze(body.slice(body.indexOf('IN ('), body.lastIndexOf(')') + 1))
    const expected = "IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )"
    const analystBody = extractSection(
      read(path.join(ANALYST, 'lib/store-status.ts')),
      'export function activeStoreCondition(storeCol: SQL): SQL {',
      '\n}\n',
    )
    expect(inner(staffBody)).toBe(expected)
    expect(inner(adminBody)).toBe(expected)
    expect(inner(analystBody)).toBe(expected)
    // analyst 副本整段等值（含左操作数 ${storeCol}）：只比 IN (...) 的话，helper 写死列名也全绿（codex round-1 P1）
    expect(squeeze(analystBody) + ' }').toBe(
      "export function activeStoreCondition(storeCol: SQL): SQL { return sql` ${storeCol} " + expected + " ` }",
    )
  })

  test('3. staff 四个使用点 SQL 整段等值（经常量拼出，不内联别的判定）', () => {
    const auth = read(path.join(STAFF, 'routes/auth.js'))
    const dash = read(path.join(STAFF, 'routes/mgmt-dashboard.js'))

    expect(onlySqlTemplate(extractSection(auth, 'async function fetchScopedStores(', '\n}\n'))).toBe(
      'SELECT s.store_id, s.store_name, ${STORE_IS_ACTIVE} AS is_active FROM stores s ${STORE_NODE_JOIN} WHERE s.store_id = ANY($1::text[]) ORDER BY s.store_name ASC',
    )
    expect(onlySqlTemplate(extractSection(dash, 'async function loadInactiveStores(', '\n}\n'))).toBe(
      'SELECT s.store_id, s.store_name FROM stores s ${STORE_NODE_JOIN} WHERE NOT ${STORE_IS_ACTIVE} AND ($1::boolean OR s.store_id = ANY($2::text[])) ORDER BY s.store_name ASC',
    )
    expect(onlySqlTemplate(extractSection(dash, 'async function resolveScope(', '\n}\n'))).toBe(
      'SELECT s.store_name, ${STORE_IS_ACTIVE} AS is_active FROM stores s ${STORE_NODE_JOIN} WHERE s.store_id = $1',
    )
    // 空态第二行「有没有别的门店可切」：在营判定同源 + 与范围下拉同口径（#401 起下拉只看节点在营，不排除关店）
    expect(onlySqlTemplate(extractSection(dash, 'async function hasActiveAlternative(', '\n}\n'))).toBe(
      'SELECT EXISTS ( SELECT 1 FROM stores s ${STORE_NODE_JOIN} WHERE ${STORE_IS_ACTIVE} AND s.store_id <> $1 AND ($2::boolean OR s.store_id = ANY($3::text[])) ) AS has_alternative',
    )
    // 两文件的常量都来自同一个 staff 在营 helper（不在路由里另写一份，也不另立 helper 文件）
    expect(auth).toContain("const { STORE_NODE_JOIN, STORE_IS_ACTIVE } = require('../utils/store-status')")
    expect(squeeze(dash)).toContain("const { activeStoreCondition, activeStoreNodeCondition, STORE_NODE_JOIN, STORE_IS_ACTIVE, } = require('../utils/store-status')")
  })

  test('5. analyst 在营口径的取数层（#421）：范围下拉 / scope SQL / 三板块查询模块整份原文快照 + 使用点闭集', () => {
    /**
     * CI 里覆盖经营分析站的只有这一条（analyst 自身 vitest 不进 CI，#382）。
     * 不挑子串、也不按函数切片（切片会被「注释包住旧函数、另写一个同名实现」或
     * 「别名 import 指向别的模块」绕过——codex round-2），直接把决定「哪些门店计入」的
     * 5 个文件**整份原文**（含 import、注释）钉 sha256：任何改动都会红。
     * 红了先跑 analyst `src/lib/__tests__/store-status-cross-end.test.ts` 与 `analyst-scope.test.ts`
     * （那里有逐段可读的语义断言、import 来源 AST 校验、行为测试），确认口径没漂再更新这里的哈希。
     * 哈希取原始字节（只把 CRLF 规范成 LF）：换行在 JS 里有语义（ASI，`return` 后换行即返回 undefined），
     * 不能做空白归一（codex round-3 P2）。
     *
     * ⚠️ 覆盖范围只到查询模块：页面 / 智能助手 / 导出路由把已校验 scope 传进这些函数的「最后一跳」
     *    是既有接线，不在本条守护内（#421 评审登记的范围外发现）。
     */
    const crypto = require('node:crypto')
    const sha = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
    const actual = Object.fromEntries(
      Object.keys(ANALYST_FILE_SHA).map((file) => [file, sha(read(path.join(ANALYST, file)))]),
    )
    expect(actual).toEqual(ANALYST_FILE_SHA)

    // scopeRangeSql（不含在营）标识符闭集：遍历 analyst 全部源码，按出现次数钉死（别名 import / 命名空间调用也会计入）
    const listTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : listTs(full)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : []
    })
    const files = listTs(ANALYST)
    expect(files.length).toBeGreaterThan(20)
    const mentions = Object.fromEntries(
      files
        .map((f) => [path.relative(ANALYST, f), (read(f).match(/\bscopeRangeSql\b/g) || []).length])
        .filter(([, n]) => n > 0),
    )
    // 查库文件闭集（按 import db 判定）：新增取数文件必须先确认经 scopeFilterSql 过滤在营门店，再加进来
    const dbFiles = files
      .filter((f) => /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:@\/db|(?:\.\.?\/)+db)(?:\/[^"']*)?["']/.test(read(f)))
      .map((f) => path.relative(ANALYST, f))
      .sort()
    expect(dbFiles).toEqual([
      'app/api/health/route.ts',
      'lib/analyst-scope.ts',
      'lib/assistant-chat-store.ts',
      'lib/assistant-product-terms.ts',
      'lib/auth.ts',
      'lib/member-threshold.ts',
      'lib/new-customer-funnel.ts',
      'lib/operation-log.ts',
      'lib/penetration.ts',
      'lib/permissions.ts',
      'lib/repurchase.ts',
    ])
    expect(mentions).toEqual({
      'lib/analyst-scope.ts': 2, // 定义 + 注释
      'lib/new-customer-funnel.ts': 2, // import + 首单基线
      'lib/permissions.ts': 1, // 注释：expandScopeStoreIds 须含停用门店，首次基线依赖它
      'lib/repurchase.ts': 3, // import + 首次进入基线 + 注释
    })
  })

  test('4. admin 侧判定只看组织节点 isActive，不含 isClosed', () => {
    const shared = squeeze(read(path.join(ADMIN, 'actions/data-center/shared.ts')))
    expect(shared).toContain('isActive: orgStore.isActive,')
    expect(shared).toContain('const inactiveStores = allStoreRows .filter((s) => !isDataCenterActiveStore(s)) .map((s) => ({ storeId: s.storeId, storeName: s.storeName, marketId: s.marketId }))')
    // 谓词本体（admin lib/store-status）只看节点 isActive
    expect(squeeze(read(path.join(ADMIN, 'lib/store-status.ts')))).toContain(
      'export function isDataCenterActiveStore(store: { isActive: boolean }): boolean { return store.isActive }',
    )
  })
})
