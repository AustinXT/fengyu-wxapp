/**
 * 管理层数据中心模块路由（员工端）
 *
 * mgmtDashboard.scopeOptions — 市场/门店二级筛选器数据源
 *   返回当前账号可见的市场及其下属门店列表，前端用于渲染 mgmt-scope-picker 组件。
 *   - HQ 账号：返回所有市场及其下属门店
 *   - market 账号：仅返回 roleBindings 中 scopeType='市场' 对应的市场
 *   - 5 分钟内存缓存全量 markets，每次请求按 ctx.auth 过滤后返回
 *
 * mgmtDashboard.summary — 数据中心首页 8 卡片汇总接口
 *   一次性返回 4 张大卡（业绩/实耗，含月店均）+ 4 张小卡（客流/客量/新会员/项目数）。
 *   入参：{ date, scopeType: 'all'|'market'|'store', scopeId? }
 *   口径定义：notes/references/metrics.md
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')

// 模块级缓存：存放 HQ 全量 markets 列表（按账号过滤前的视图）
// 不同账号每次请求基于此缓存按 staffLevel + roleBindings 派生自己的视图
const CACHE_TTL_MS = 5 * 60 * 1000
let CACHE = { ts: 0, data: null }

/**
 * 加载 HQ 全量 markets 列表（带 5 分钟内存缓存）
 * @returns {Promise<Array<{id: string, name: string, stores: Array<{storeId: string, storeName: string}>}>>}
 */
async function loadAllMarkets() {
  if (CACHE.data && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return CACHE.data
  }

  const rows = await pg.query(`
    SELECT
      m.id          AS market_id,
      m.name        AS market_name,
      s.store_id    AS store_id,
      s.store_name  AS store_name
    FROM org_nodes m
    LEFT JOIN org_nodes so
      ON so.parent_id = m.id AND so.type = '门店'
    LEFT JOIN stores s
      ON s.org_node_id = so.id AND s.is_closed = false
    WHERE m.type = '市场'
    ORDER BY m.name ASC, s.store_name ASC
  `)

  // 聚合为 markets[].stores[] 结构
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.market_id)) {
      map.set(r.market_id, {
        id: r.market_id,
        name: r.market_name || '',
        stores: [],
      })
    }
    if (r.store_id) {
      map.get(r.market_id).stores.push({
        storeId: r.store_id,
        storeName: r.store_name || '',
      })
    }
  }

  const markets = Array.from(map.values())

  CACHE = { ts: Date.now(), data: markets }
  return markets
}

/**
 * mgmtDashboard.scopeOptions
 * 入参：无（按账号权限自动过滤）
 * 出参：
 *   {
 *     staffLevel: 'headquarters' | 'market',
 *     markets: [{ id, name, stores: [{ storeId, storeName }] }, ...]
 *   }
 */
async function scopeOptions(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const allMarkets = await loadAllMarkets()
  const { staffLevel, roleBindings } = ctx.auth

  let visible = allMarkets
  if (staffLevel === 'market') {
    const allowedMarketIds = new Set(
      (roleBindings || [])
        .filter((rb) => rb && rb.scopeType === '市场')
        .map((rb) => rb.scopeId)
    )
    visible = allMarkets.filter((m) => allowedMarketIds.has(m.id))
  }
  // headquarters 走全量；其它分支由 requireManagementLevel 拦截

  ctx.result = {
    staffLevel,
    markets: visible,
  }
}

module.exports = { scopeOptions }
