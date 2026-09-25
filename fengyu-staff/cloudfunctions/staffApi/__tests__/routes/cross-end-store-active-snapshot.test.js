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
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error(`未找到源码片段：${startMarker} → ${endMarker}`)
  return src.slice(start, end)
}

/** 片段里**唯一**一条反引号 SQL 模板（多于一条说明形态已变，先读本文件注释） */
function onlySqlTemplate(section) {
  const all = section.match(/`[^`]*`/g) || []
  const sqls = all.filter((t) => /\bSELECT\b/.test(t))
  if (sqls.length !== 1) throw new Error(`期望 1 条 SQL 模板，实得 ${sqls.length}`)
  return squeeze(sqls[0].slice(1, -1))
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

  test('5. analyst 取数与范围下拉接线（#421）：取数首位叠在营子查询，下拉只看节点 isActive', () => {
    const scope = read(path.join(ANALYST, 'lib/analyst-scope.ts'))
    expect(scope).toContain('import { activeStoreCondition } from "./store-status"')
    const filter = squeeze(extractSection(scope, 'export function scopeFilterSql(', '\n}\n'))
    expect(filter).toContain('if (!range) return sql`FALSE`')
    expect(filter).toContain('return sql.join([activeStoreCondition(range.col), ...range.parts], sql` AND `)')
    expect(filter).not.toMatch(/sql`TRUE`/)
    // 不含在营的 scopeRangeSql 只许出现在新客首单 / 复购首次进入两处基线（#421 拍板：首次判定用全历史）
    const rangeUsers = ['lib/repurchase.ts', 'lib/penetration.ts', 'lib/new-customer-funnel.ts']
      .filter((f) => read(path.join(ANALYST, f)).includes('scopeRangeSql('))
    expect(rangeUsers).toEqual(['lib/repurchase.ts', 'lib/new-customer-funnel.ts'])
    const options = squeeze(extractSection(scope, 'export async function getAnalystScopeOptions(', '\n}\n'))
    expect(options).toContain('eq(storeNode.type, "门店"), eq(storeNode.isActive, true),')
    expect(scope).not.toMatch(/is_closed|isClosed/)
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
