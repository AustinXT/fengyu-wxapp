/**
 * 数据中心 scope 冒烟（impl）。由 dc-scope-smoke.mjs wrapper 以
 * `bun --preload _dc-smoke-preload.mjs` 在 cwd=fengyu-admin/ 启动。
 *
 * 目标（只读 5433 线上库，不写任何数据）：
 *   1. 4 板块 action 的真实 SQL 能在 5433 schema 上跑通（catch mock 单测漏掉的列/语法错误）
 *   2. scope 隔离：admin 看全部市场；市场账号只看本市场且越权选「全部」被拒
 *
 * 注入 session 走 _dc-smoke-preload.mjs 的 getSession mock（读 globalThis.__DC_SESSION）。
 */
import path from 'node:path'
import postgres from 'postgres'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

// 连接串可配置（默认 5433 开发库，与同目录 smoke 一致）；跑 5433 线上库：
//   DATABASE_URL='postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp' bun tests/e2e-actions/dc-scope-smoke.mjs
// 必须在 import '@/db' 前设置（db 单例 module-load 期读 DATABASE_URL）。
const CONN =
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
process.env.DATABASE_URL = CONN
process.env.PG_CONNECTION_STRING = CONN

const A = (...p) => 'file://' + path.join(ADMIN_DIR, ...p)

// ── 读真实市场/门店（独立只读连接）──────────────────────────────
const sql = postgres(CONN, { max: 2 })
let report = []
let failed = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

function setSession(s) {
  globalThis.__DC_SESSION = s
}
const ADMIN_SESSION = {
  employeeId: 'SMOKE_ADMIN',
  name: 'smoke-admin',
  phone: '00000000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] },
}

try {
  const markets = await sql`
    SELECT o.id, o.name, COUNT(s.store_id)::int AS store_cnt
    FROM org_nodes o
    LEFT JOIN org_nodes so ON so.parent_id = o.id AND so.type = '门店'
    LEFT JOIN stores s ON s.org_node_id = so.id
    WHERE o.type = '市场'
    GROUP BY o.id, o.name
    ORDER BY store_cnt DESC, o.name ASC
  `
  console.log(`[5433] 市场数=${markets.length}；门店分布：` + markets.map((m) => `${m.name}(${m.store_cnt})`).join(', '))

  const topMarket = markets.find((m) => m.store_cnt > 0) ?? markets[0]
  let marketStoreIds = []
  if (topMarket) {
    const rows = await sql`
      SELECT s.store_id FROM stores s
      JOIN org_nodes o ON s.org_node_id = o.id
      WHERE o.parent_id = ${topMarket.id} AND o.type = '门店'
    `
    marketStoreIds = rows.map((r) => r.store_id)
  }

  // ── 动态 import 4 板块 action（真实 permissions/scope/db）──────────
  const { getSalesBoard } = await import(A('src', 'actions', 'data-center', 'sales.ts'))
  const { getCustomerBoard } = await import(A('src', 'actions', 'data-center', 'customer.ts'))
  const { getEfficiencyBoard } = await import(A('src', 'actions', 'data-center', 'efficiency.ts'))
  const { getProductBoard } = await import(A('src', 'actions', 'data-center', 'product.ts'))

  const TR = { preset: 'year' }
  const allParams = { scope: { type: 'all' }, timeRange: TR, withComparison: false }

  // ════ 场景 1：admin 全局 —— 4 板块 SQL 必须跑通 ════
  setSession(ADMIN_SESSION)
  let adminSales
  try {
    adminSales = await getSalesBoard(allParams)
    check('销售板块 SQL 跑通(admin/all)', true, `byMarket=${adminSales.byMarket.length} 行, storeRevenue=${adminSales.kpis.storeRevenue?.value}`)
  } catch (e) {
    check('销售板块 SQL 跑通(admin/all)', false, e.message)
  }
  try {
    const r = await getCustomerBoard(allParams)
    check('客量板块 SQL 跑通(admin/all)', true, `byMarket=${r.byMarket.length} 行, 注册=${r.kpis.registeredMembers?.value}, 单次客耗=${r.kpis.consumePerVisit?.value}`)
  } catch (e) {
    check('客量板块 SQL 跑通(admin/all)', false, e.message)
  }
  try {
    const r = await getEfficiencyBoard(allParams)
    const storeRankN = (r.storeRankings?.revenue ?? []).length
    check('人效板块 SQL 跑通(admin/all)', true, `byMarket=${r.byMarket.length} 行, 店长人均会员=${r.kpis.managerAvgMembers?.value}, 门店业绩榜=${storeRankN} 行`)
  } catch (e) {
    check('人效板块 SQL 跑通(admin/all)', false, e.message)
  }
  try {
    const r = await getProductBoard(allParams)
    check('品项板块 SQL 跑通(admin/all)', true, `filterOptions=${r.filterOptions.length} 一级, byMarket=${r.byMarket.length} 行, 持卡=${r.kpis.cardHolders?.value}`)
  } catch (e) {
    check('品项板块 SQL 跑通(admin/all)', false, e.message)
  }

  // ════ 场景 2：scope 隔离 ════
  if (topMarket && marketStoreIds.length > 0) {
    const MARKET_SESSION = {
      employeeId: 'SMOKE_MKT',
      name: 'smoke-market',
      phone: '00000000001',
      roles: [{ role: 'manager', scopeId: topMarket.id, scopeType: '市场' }],
      permissions: { actions: ['data_center:dashboard'], scopeStoreIds: marketStoreIds },
    }

    // 2a. admin 看到的市场数 = 全部
    const adminMarketCount = adminSales ? adminSales.byMarket.length : -1

    // 2b. 市场账号选本市场 → byMarket 仅 1（本市场），byStore ⊆ 本市场门店
    setSession(MARKET_SESSION)
    try {
      const r = await getSalesBoard({ scope: { type: 'market', id: topMarket.id }, timeRange: TR, withComparison: false })
      const onlyOwn = r.byMarket.length <= 1 && (r.byMarket.length === 0 || r.byMarket[0].groupId === topMarket.id)
      const storesSubset = r.byStore.every((row) => marketStoreIds.includes(row.groupId))
      check('市场账号·按市场只见本市场', onlyOwn, `byMarket=${r.byMarket.length} 行（市场 ${topMarket.name}）`)
      check('市场账号·按门店⊆本市场门店', storesSubset, `byStore=${r.byStore.length} 行 / 本市场${marketStoreIds.length}店`)
      check('admin 市场数 ≥ 市场账号可见市场数（scope 收窄）', adminMarketCount >= r.byMarket.length, `admin=${adminMarketCount} ≥ market=${r.byMarket.length}`)
    } catch (e) {
      check('市场账号·按市场只见本市场', false, e.message)
    }

    // 2c. 市场账号越权选「全部」→ 必须抛 PERMISSION_DENIED
    setSession(MARKET_SESSION)
    try {
      await getSalesBoard(allParams)
      check('市场账号选「全部」被拒(PERMISSION_DENIED)', false, '未抛错（越权未拦截！）')
    } catch (e) {
      check('市场账号选「全部」被拒(PERMISSION_DENIED)', /PERMISSION_DENIED/.test(e.message), e.message)
    }
  } else {
    check('scope 隔离场景', false, '5433 无含门店的市场，跳过 scope 隔离（仅验证了 SQL 跑通）')
  }
} catch (e) {
  check('冒烟整体', false, '致命错误：' + (e?.stack || e?.message || String(e)))
} finally {
  await sql.end({ timeout: 5 })
}

console.log('\n──────── 数据中心 5433 冒烟报告 ────────')
for (const line of report) console.log(line)
console.log(`────────────────────────────────────\n${failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌'}`)
process.exit(failed === 0 ? 0 : 1)
