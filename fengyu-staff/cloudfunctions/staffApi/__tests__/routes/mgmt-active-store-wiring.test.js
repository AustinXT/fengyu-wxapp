/**
 * 管理层数据中心取数「在营门店」接线守护 —— 运行时闭集（#401，闸门 2 codex round-2 P2）。
 *
 * `cross-end-store-status-snapshot.test.js` 的字面量断言只能证明 helper 与 scope 构造器没被改坏，
 * 证明不了每条取数 SQL 都经过了它：新增一条写死 `WHERE TRUE` 的统计查询，字面量守护全绿，
 * 停用节点的数据却会重新计入（#401 之前 mgmt-traffic / mgmt-product 正是这种形态）。
 * 本文件实际调用每个统计 handler，收集 pg.query 的全部 SQL，逐条要求含在营子查询
 * （utils/store-status.js activeStoreCondition 的完整展开）。
 *
 * 三个闭集：
 *   1. handler 闭集：统计路由的 module.exports 必须全部出现在 CALLS 或 EXEMPT_HANDLERS
 *   2. SQL 豁免闭集：非统计查询（scope 名称 / 品类字典）按全文登记，其余一律须含在营子查询
 *   3. 豁免必须被命中：登记了却没命中的豁免视为过期
 */

const pg = globalThis.__mocks__.pg
const { createCtx } = require('../helpers')

const ROUTES = {
  'mgmt-dashboard': require('../../routes/mgmt-dashboard'),
  'mgmt-traffic': require('../../routes/mgmt-traffic'),
  'mgmt-product': require('../../routes/mgmt-product'),
}

const DATE = '2026-09-10'
/** handler → 入参构造（s = { scopeType, scopeId }） */
const CALLS = [
  ['mgmt-dashboard', 'summary', (s) => ({ date: DATE, ...s })],
  ['mgmt-dashboard', 'storeRanking', (s) => ({ date: DATE, period: 'month', metric: 'revenue', ...s })],
  ['mgmt-dashboard', 'staffRanking', (s) => ({ date: DATE, period: 'month', metric: 'revenue', ...s })],
  ['mgmt-dashboard', 'salesData', (s) => ({ period: 'month', scope: { type: s.scopeType, id: s.scopeId } })],
  ['mgmt-traffic', 'summary', (s) => ({ period: 'month', ...s })],
  ['mgmt-product', 'cardHolders', (s) => ({ ...s })],
  ['mgmt-product', 'cycleStats', (s) => ({ period: 'month', ...s })],
]
/** 非取数 handler：范围下拉数据源（在营过滤由 loadAllMarkets 的 o_store.is_active 与字面量守护覆盖） */
const EXEMPT_HANDLERS = ['mgmt-dashboard:scopeOptions']

/** 非统计 SQL 全文模式（归一空白后整句匹配） */
const EXEMPT_SQL = [
  ['市场名称（scope 展示名）', /^SELECT name FROM org_nodes WHERE id = \$1 AND type = '市场'$/],
  ['门店名称（scope 展示名）', /^SELECT store_name FROM stores WHERE store_id = \$1$/],
  ['品类字典', /^SELECT product_kind, category_name FROM product_categories WHERE product_kind IS NOT NULL AND category_name IS NOT NULL ORDER BY product_kind, category_name$/],
]

const ACTIVE_SUBQUERY =
  "IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )"

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

function hqCtx(payload) {
  return createCtx({
    payload,
    auth: {
      staffLevel: 'headquarters',
      loginLevel: 'management',
      hasDataCenterDashboard: true,
      roleBindings: [{ role: 'admin', scopeId: 'org-hq', scopeType: '总部' }],
      scopeStoreIds: ['store-001'],
      scopeOrgNodeIds: ['org-hq', 'mkt-A'],
    },
  })
}

const SCOPES = [
  { scopeType: 'all' },
  { scopeType: 'market', scopeId: 'mkt-A' },
  { scopeType: 'store', scopeId: 'store-001' },
]

const results = []
const errors = []

beforeAll(async () => {
  for (const [route, name, mk] of CALLS) {
    for (const s of SCOPES) {
      pg.query.mockReset().mockImplementation(async () => [])
      try {
        await ROUTES[route][name](hqCtx(mk(s)))
      } catch (e) {
        errors.push(`${route}:${name} ${s.scopeType}: ${e.message}`)
      }
      for (const call of pg.query.mock.calls) {
        results.push({ handler: `${route}:${name}`, scope: s.scopeType, sql: normalize(call[0]) })
      }
    }
  }
})

describe('#401 管理层取数在营接线 · 运行时闭集', () => {
  it('统计路由的每个导出 handler 都已归类（取数 / 豁免），无遗漏无多余', () => {
    const exported = Object.entries(ROUTES).flatMap(([route, mod]) => Object.keys(mod).map((k) => `${route}:${k}`))
    const classified = [...CALLS.map(([route, name]) => `${route}:${name}`), ...EXEMPT_HANDLERS]
    expect(exported.sort()).toEqual(classified.sort())
  })

  it('每个 handler 在 all / market / store 下都跑通，且各自产生带在营过滤的 SQL（防空跑恒绿）', () => {
    expect(errors).toEqual([])
    for (const [route, name] of CALLS) {
      for (const { scopeType } of SCOPES) {
        const n = results.filter(
          (r) => r.handler === `${route}:${name}` && r.scope === scopeType && r.sql.includes(ACTIVE_SUBQUERY),
        ).length
        expect(n, `${route}:${name} ${scopeType} 没有任何带在营过滤的 SQL`).toBeGreaterThan(0)
      }
    }
  })

  it('除登记豁免外，每条 SQL 都含在营子查询（activeStoreCondition 完整展开）', () => {
    const offenders = results
      .filter((r) => !r.sql.includes(ACTIVE_SUBQUERY))
      .filter((r) => !EXEMPT_SQL.some(([, re]) => re.test(r.sql)))
      .map((r) => `${r.handler} ${r.scope}: ${r.sql.slice(0, 200)}`)
    expect([...new Set(offenders)]).toEqual([])
  })

  it('每条豁免都被真实命中（过期豁免须删除）', () => {
    for (const [reason, re] of EXEMPT_SQL) {
      expect(results.some((r) => re.test(r.sql)), `豁免「${reason}」未命中`).toBe(true)
    }
  })
})
