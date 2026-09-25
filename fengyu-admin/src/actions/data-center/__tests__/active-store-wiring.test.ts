/**
 * 数据中心取数「在营门店」接线守护 —— 运行时闭集（#401，闸门 2 codex round-2 P2）。
 *
 * 字面量守护（staffApi `cross-end-store-status-snapshot.test.js`）只能证明 helper 本体与 scope 构造器
 * 没被改坏，证明不了「每条取数 SQL 都真的经过了它」：把某处 `scopeFilterSql(...)` 换成 `sql\`TRUE\``
 * 字面量守护全绿，但停用节点的数据会重新计入。本文件改走**运行时**：用真 drizzle 跑每个数据中心
 * action，把 `db.execute` 收到的每条 SQL 渲染成文本，逐条要求含在营子查询（lib/store-status
 * `activeStoreCondition` 的完整展开）。
 *
 * 三个闭集：
 *   1. action 闭集：actions/data-center 下每个 `export const X = with…` 必须出现在 CALLS 或 EXEMPT_ACTIONS
 *   2. SQL 豁免闭集：非统计查询（配置 / 字典 / 会话参数 / 数据起点）按全文模式登记，其余一律须含在营子查询
 *   3. 豁免必须被命中：登记了却一次没命中的豁免视为过期（防豁免表只增不减、变成后门）
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthSession } from '@/lib/types'

const { captured, mockGetSession } = vi.hoisted(() => ({ captured: [] as unknown[], mockGetSession: vi.fn() }))

/** drizzle 链式查询替身：scope 数据源 / 配置读取走 db.select，统一给空结果 */
function chain(): unknown {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy', 'offset']) c[m] = () => c
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject)
  return c
}

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
// 市场 scope 校验要查组织树：固定放行 MKT-A，其余逻辑走真实实现
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  expandVisibleMarketIds: vi.fn(async () => ['MKT-A']),
}))
vi.mock('@/db', () => {
  const execute = vi.fn(async (q: unknown) => {
    captured.push(q)
    return []
  })
  return { db: { execute, select: () => chain(), transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) } }
})

const ACTIONS = ['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission']

function sessionOf(role: AuthSession['roles'][number]): AuthSession {
  return {
    employeeId: 'EMP-1',
    name: '测试',
    phone: '13800000000',
    roles: [role],
    permissions: { actions: ACTIONS, scopeStoreIds: role.scopeStoreIds ?? [] },
  } as AuthSession
}
const MARKET_SESSION = sessionOf({ role: 'manager', scopeId: 'MKT-A', scopeType: '市场', actions: ACTIONS, scopeStoreIds: ['S1', 'S2'], scopeOrgNodeIds: ['MKT-A'] })
const HQ_SESSION = sessionOf({ role: 'admin', scopeId: 'HQ', scopeType: '总部', actions: ACTIONS, scopeStoreIds: [], scopeOrgNodeIds: ['HQ'] })

type Scope = { type: 'all' } | { type: 'authorized' } | { type: 'market'; id: string } | { type: 'store'; id: string }
const board = (scope: Scope) => ({ scope, timeRange: { preset: 'month' }, withComparison: true })
const raw = (scope: Scope) => ({ scope: scope.type, scopeId: 'id' in scope ? scope.id : undefined, period: 'month' })

/** 每个取数 action 的调用方式（模块文件名 → 导出名 → 入参构造） */
const CALLS: Array<[file: string, name: string, args: (s: Scope) => unknown[]]> = [
  ['sales', 'getSalesBoard', (s) => [board(s)]],
  ['customer', 'getCustomerBoard', (s) => [board(s)]],
  ['efficiency', 'getEfficiencyBoard', (s) => [board(s)]],
  ['product', 'getProductBoard', (s) => [board(s)]],
  ['daily-overview', 'getDailyOverview', (s) => [raw(s)]],
  ['operating-master', 'getOperatingMaster', (s) => [{ scope: s, month: '2026-09' }]],
  ['commission', 'getCommissionDaily', (s) => [raw(s)]],
  ['commission', 'getCommissionDetail', (s) => [raw(s)]],
  ['commission', 'exportCommissionDetail', (s) => [raw(s)]],
  ['customer-frequency', 'getCustomerFrequencyReport', (s) => [raw(s)]],
  ['customer-frequency', 'exportCustomerFrequencyReport', (s) => [raw(s)]],
  ['remaining-cards', 'getRemainingCardsReport', (s) => [raw(s)]],
  ['remaining-cards', 'exportRemainingCardsReport', (s) => [raw(s)]],
]

/** 不取统计数的 action：筛选器数据源（在营 / 停用分流另由 shared.test 与字面量守护覆盖）、数据起点 */
const EXEMPT_ACTIONS = new Set([
  'shared:getDataCenterScopeOptions',
  'shared:getCustomerDetailScopeOptions',
  'shared:getStaffCommissionScopeOptions',
  'shared:getDataStartDates',
])

/** 非统计 SQL 全文模式（归一空白后整句匹配）。新增须写明理由，且必须真的被命中 */
const EXEMPT_SQL: Array<[reason: string, pattern: RegExp]> = [
  ['会员门槛配置', /^SELECT value FROM system_configs WHERE key = 'new_member_threshold'$/],
  ['品项板一二级字典', /^SELECT DISTINCT pc\.product_kind AS kind, pc\.category_name AS category FROM product_categories pc WHERE pc\.product_kind IS NOT NULL ORDER BY pc\.product_kind, pc\.category_name$/],
  ['日报品类字典', /^SELECT category_id, category_name, product_kind, sort_order, is_valid FROM product_categories$/],
  ['剩余卡项品类字典', /^-- 一级名没有唯一约束：[^\n]*? SELECT c\.category_id, c\.category_name, c\.product_kind, c\.sort_order, MIN\(kind_row\.sort_order\) AS kind_sort FROM product_categories c [^;]*$/],
  ['报表会话参数', /^SET LOCAL (statement_timeout = '\d+s'|jit = off|enable_nestloop = off)$/],
  // 各门店数据起点（loadStoreDataStarts）：只用于判定较上期是否跨割点，按门店分组、不汇总统计值
  ['数据起点·款项', /^SELECT so\.store_id, to_char\(MIN\(p\.performance_attribution_date\), 'YYYY-MM-DD'\) AS start FROM sale_order_payments p JOIN sale_orders so ON so\.sale_order_id = p\.sale_order_id [^;]*GROUP BY so\.store_id$/],
  ['数据起点·服务单', /^SELECT store_id, to_char\(MIN\(service_date\), 'YYYY-MM-DD'\) AS start FROM service_orders WHERE status = '已完成' GROUP BY store_id$/],
]

/** lib/store-status activeStoreCondition 的完整展开（归一空白后） */
const ACTIVE_SUBQUERY =
  "IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )"

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

interface Captured { action: string; scope: string; sql: string }
const results: Captured[] = []
const errors: string[] = []

beforeAll(async () => {
  const dialect = new PgDialect()
  const runs: Array<[AuthSession, Scope]> = [
    [HQ_SESSION, { type: 'all' }],
    [MARKET_SESSION, { type: 'authorized' }],
    [MARKET_SESSION, { type: 'market', id: 'MKT-A' }],
    [MARKET_SESSION, { type: 'store', id: 'S1' }],
  ]
  for (const [file, name, args] of CALLS) {
    const mod = (await import(`../${file}`)) as Record<string, (...a: unknown[]) => Promise<unknown>>
    for (const [session, scope] of runs) {
      mockGetSession.mockResolvedValue(session)
      captured.length = 0
      const label = `${file}:${name}`
      try {
        await mod[name](...args(scope))
      } catch (e) {
        errors.push(`${label} ${scope.type}: ${(e as Error).message}`)
      }
      for (const q of captured) {
        const sql = normalize(dialect.sqlToQuery(q as never).sql)
        results.push({ action: label, scope: scope.type, sql })
      }
    }
  }
}, 60_000)

describe('#401 数据中心取数在营接线 · 运行时闭集', () => {
  it('actions/data-center 的每个导出 action 都已归类（取数 / 豁免），无遗漏无多余', () => {
    const dir = path.resolve(__dirname, '..')
    const exported: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^export const (\w+) = with\w+\(/gm)) {
        exported.push(`${f.replace(/\.ts$/, '')}:${m[1]}`)
      }
    }
    const classified = [...CALLS.map(([file, name]) => `${file}:${name}`), ...EXEMPT_ACTIONS]
    expect(exported.sort()).toEqual(classified.sort())
  })

  it('每个 action 在 all / authorized / market / store 四种范围下都跑通，且各自产生统计 SQL（防空跑恒绿）', () => {
    expect(errors).toEqual([])
    for (const [file, name] of CALLS) {
      for (const scope of ['all', 'authorized', 'market', 'store']) {
        const n = results.filter((r) => r.action === `${file}:${name}` && r.scope === scope && r.sql.includes(ACTIVE_SUBQUERY)).length
        expect(n, `${file}:${name} ${scope} 没有任何带在营过滤的 SQL`).toBeGreaterThan(0)
      }
    }
  })

  it('除登记豁免外，每条 SQL 都含在营子查询（activeStoreCondition 完整展开）', () => {
    const offenders = results
      .filter((r) => !r.sql.includes(ACTIVE_SUBQUERY))
      .filter((r) => !EXEMPT_SQL.some(([, re]) => re.test(r.sql)))
      .map((r) => `${r.action} ${r.scope}: ${r.sql.slice(0, 200)}`)
    expect([...new Set(offenders)]).toEqual([])
  })

  it('每条豁免都被真实命中（过期豁免须删除）', () => {
    for (const [reason, re] of EXEMPT_SQL) {
      expect(results.some((r) => re.test(r.sql)), `豁免「${reason}」未命中`).toBe(true)
    }
  })
})
