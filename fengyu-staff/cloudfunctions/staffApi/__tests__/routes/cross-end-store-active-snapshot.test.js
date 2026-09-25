/**
 * 「门店在营 / 已停用」判定的跨端字面量守护（issue #400，口径对齐 admin #293）。
 *
 * staff `utils/store-active.js` 是 admin `actions/data-center/shared.ts`（inactiveStores 分流）
 * 的**独立副本**（根 CLAUDE.md：禁止跨端共享代码目录，一致性靠字面量 snapshot 守护）。
 *
 * ## 守什么
 *
 * 1. 判定片段整段等值（快照）：只看门店组织节点 `org_nodes.is_active`（type='门店'），
 *    缺节点按停用 —— 与取数 SQL 的 activeStoreCondition 同口径（取数滤掉的门店 = 判停用的门店）。
 * 2. 取数口径两端整段等值：staff `activeStoreCondition` ≡ admin `activeStoreCondition`。
 *    判定片段是照着它写的，它一变，判定就会和「满屏 0」错位。
 * 3. staff 三个使用点（fetchScopedStores / loadInactiveStores / resolveScope）的 SQL 整段等值，
 *    都经由 1 的常量拼出，不内联另一套判定（比如混进 is_closed）。
 * 4. admin 侧判定仍是「只看 isActive」且 isActive 取自门店组织节点，不含 isClosed。
 */

const fs = require('node:fs')
const path = require('node:path')

const STAFF = path.resolve(__dirname, '../..')
const ADMIN = path.resolve(__dirname, '../../../../../fengyu-admin/src')

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
  const { STORE_NODE_JOIN, STORE_IS_ACTIVE } = require('../../utils/store-active')

  test('1. 判定片段整段快照', () => {
    expect(STORE_NODE_JOIN).toBe(
      "LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id AND store_node.type = '门店'",
    )
    expect(STORE_IS_ACTIVE).toBe('COALESCE(store_node.is_active, FALSE)')
  })

  test('2. 取数口径 activeStoreCondition 两端整段等值，且与判定片段要件一一对应', () => {
    const staffBody = extractSection(
      read(path.join(STAFF, 'routes/mgmt-dashboard.js')),
      'function activeStoreCondition(column) {',
      '\n}\n',
    )
    const adminBody = extractSection(
      read(path.join(ADMIN, 'lib/data-center/scope-sql.ts')),
      'function activeStoreCondition(storeCol: SQL): SQL {',
      '\n}\n',
    )
    const inner = (body) => squeeze(body.slice(body.indexOf('IN ('), body.lastIndexOf(')') + 1))
    const expected = "IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )"
    expect(inner(staffBody)).toBe(expected)
    expect(inner(adminBody)).toBe(expected)
  })

  test('3. staff 三个使用点 SQL 整段等值（经常量拼出，不内联别的判定）', () => {
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
    // 两文件的常量都来自同一个 staff 工具（不在路由里另写一份）
    for (const src of [auth, dash]) {
      expect(src).toContain("const { STORE_NODE_JOIN, STORE_IS_ACTIVE } = require('../utils/store-active')")
    }
  })

  test('4. admin 侧判定只看组织节点 isActive，不含 isClosed', () => {
    const shared = squeeze(read(path.join(ADMIN, 'actions/data-center/shared.ts')))
    expect(shared).toContain('isActive: orgStore.isActive,')
    expect(shared).toContain('const inactiveStores = allStoreRows .filter((s) => !s.isActive) .map((s) => ({ storeId: s.storeId, storeName: s.storeName, marketId: s.marketId }))')
  })
})
