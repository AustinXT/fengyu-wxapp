/**
 * 管理层数据中心模块路由（员工端）
 *
 * mgmtDashboard.scopeOptions — 市场/门店二级筛选器数据源
 *   - 总部 scope：返回所有市场及其下属门店
 *   - 其他账号：仅返回账号全部 scope 覆盖的门店及可完整选择的市场
 *   - 不缓存，确保组织节点启停后范围下拉立即刷新
 *
 * mgmtDashboard.summary — 数据中心首页 8 卡片汇总
 *   一次返回 4 张大卡（业绩/实耗，含月店均）+ 4 张小卡（客流/客量/新会员/项目数）
 *   口径定义：notes/references/metrics.md
 *   2026-08 业绩归属日期：组织层级业绩按 sale_order_performance_events 的
 *   performance_date 统计。
 *   ⚠ 2026-09-14 订正（#137 / #140）：原文「首次收款跟随订单归属日期，后续回款/退款仍按
 *   真实发生日」**已失效**。迁移 0041 起视图的 performance_date 一律直读
 *   `sale_order_payments.performance_attribution_date`，回款/退款同样按归属日期；
 *   回退只发生在写入侧 trigger。admin 工作台的实付/退款也已统一到该口径（#140）。
 *
 * **公式 / sale_order_type / status 过滤变更必须同步
 * `fengyu-admin/src/actions/dashboard.ts`
 * 与 `fengyu-admin/src/actions/dashboard.consistency.test.ts`**
 * （字面量守护：SUMMARY v3 §2 #15 / ticket notes/tickets/2026-05-17-dashboard-three-end-consistency-test.md）。
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const {
  validateManagementScope,
  buildManagementStoreScope,
  hasHeadquartersScope,
} = require('../utils/scope')
const { excludeDepositRefundSql } = require('../utils/consume-filter')

/**
 * 取 selectedDate 所属月份的月末日期（YYYY-MM-DD）。
 * 月度业绩是整月维度，对应整月在营/在职的口径，分母用月末快照。
 */
function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  // m 为下一月用 0 号 = 当月月末
  const d = new Date(Date.UTC(y, m, 0))
  const yy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * 加载 HQ 全量 markets 列表。
 *
 * 组织节点的启停必须立即反映到筛选器，因此这里不缓存；汇总/排行榜也在各自 SQL
 * 中附加同一启用门店条件，避免用户绕过下拉后看到停用门店的数据。
 * @returns {Promise<Array<{id: string, name: string, stores: Array<{storeId: string, storeName: string}>}>>}
 */
async function loadAllMarkets() {
  const rows = await pg.query(`
    WITH RECURSIVE market_descendants(market_id, node_id, path) AS (
      SELECT m.id, m.id, ARRAY[m.id]
      FROM org_nodes m
      WHERE m.type = '市场'
      UNION ALL
      SELECT market_descendants.market_id, child.id, market_descendants.path || child.id
      FROM org_nodes child
      JOIN market_descendants ON child.parent_id = market_descendants.node_id
      WHERE NOT child.id = ANY(market_descendants.path)
    )
    SELECT
      m.id          AS market_id,
      m.name        AS market_name,
      s.store_id    AS store_id,
      s.store_name  AS store_name
    FROM org_nodes m
    LEFT JOIN market_descendants d ON d.market_id = m.id
    LEFT JOIN org_nodes o_store
      ON o_store.id = d.node_id
     AND o_store.type = '门店'
     AND o_store.is_active = TRUE
    LEFT JOIN stores s ON s.org_node_id = o_store.id AND s.is_closed = false
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

  return Array.from(map.values())
}

/**
 * mgmtDashboard.scopeOptions
 * 入参：无（按账号权限自动过滤）
 * 出参：
 *   {
 *     staffLevel,
 *     allowAll: boolean,
 *     allowedMarketIds: string[],
 *     markets: [{ id, name, stores: [{ storeId, storeName }] }, ...]
 *   }
 */
async function scopeOptions(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const allMarkets = await loadAllMarkets()
  const { staffLevel, roleBindings, scopeStoreIds, scopeOrgNodeIds } = ctx.auth
  const allowAll = hasHeadquartersScope(roleBindings)
  const allowedStores = new Set(scopeStoreIds || [])
  const allowedNodes = new Set(scopeOrgNodeIds || [])
  const allowedMarketIds = allMarkets
    .filter((market) => allowAll || allowedNodes.has(market.id))
    .map((market) => market.id)
  const visible = allowAll
    ? allMarkets
    : allMarkets
      .map((market) => ({
        ...market,
        stores: (market.stores || []).filter((store) => allowedStores.has(store.storeId)),
      }))
      .filter((market) => market.stores.length > 0)

  ctx.result = {
    staffLevel,
    allowAll,
    allowedMarketIds,
    markets: visible,
  }
}

// =====================================================================
// summary —— 8 卡片汇总
// =====================================================================

/** 当前启用的门店组织节点对应的 store_id 集合（按当前状态作用于全部历史区间）。 */
function activeStoreCondition(column) {
  return `${column} IN (
    SELECT active_store.store_id
    FROM stores active_store
    JOIN org_nodes active_node ON active_store.org_node_id = active_node.id
    WHERE active_node.type = '门店'
      AND active_node.is_active = TRUE
  )`
}

/**
 * 在既有权限/UI scope 外叠加经营门店启用条件；不改共享 scope 工具，避免影响其他路由。
 */
function withActiveStoreCondition(scope, column) {
  return {
    sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`,
    params: scope.params,
  }
}

/** 构造 sale/service 表的 active 门店 scope 过滤片段。 */
function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.store_id`
  return withActiveStoreCondition(
    buildManagementStoreScope(scopeType, scopeId, column, startIdx),
    column,
  )
}

/** client_wechat_users.bound_store_id 的 active 门店 scope。 */
function buildClientScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.bound_store_id`
  return withActiveStoreCondition(
    buildManagementStoreScope(scopeType, scopeId, column, startIdx),
    column,
  )
}

/** staff_wechat_users.store_id 的 active 门店 scope。 */
function buildStaffScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.store_id`
  return withActiveStoreCondition(
    buildManagementStoreScope(scopeType, scopeId, column, startIdx),
    column,
  )
}

/**
 * 时间窗口 SQL 片段
 * @param {string} col 列引用
 * @param {'day'|'month'} mode
 * @param {number} idx $n 下标（指向 date 参数）
 * @param {boolean} isDateColumn col 本身是 date 类型则不必再 ::date
 */
function timeWindow(col, mode, idx, isDateColumn) {
  const dayLeft = isDateColumn ? col : `${col}::date`
  if (mode === 'day') return `${dayLeft} = $${idx}::date`
  return `date_trunc('month', ${col}) = date_trunc('month', $${idx}::date)`
}

/* ----- 7 个指标查询 ----- */

async function queryStoreRevenue(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'spe', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
       FROM sale_order_performance_events spe
      WHERE ${sc.sql}
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND ${timeWindow('spe.performance_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryShengmeiRevenue(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sipe.amount::numeric), 0) AS v
       FROM sale_item_performance_events sipe
       JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
       JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id
      WHERE ${sc.sql}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND si.is_shengmei = TRUE
        AND ${timeWindow('sipe.performance_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryStoreConsume(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryShengmeiConsume(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.is_shengmei = TRUE
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryFootfall(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT so.client_user_id) AS v
       FROM service_orders so
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryHeadcount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM service_orders so
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryProjectCount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

// 「员工收入」口径约定（2026-05-26 落地 staff.pr.spec §3.15 双维度提成模型，勿误改）：
//   销售部分 = SUM(sale_payment_item_allocations.commission_amount) — 真实【销售提成】（= 营业额份额 × 提成率快照）
//   服务部分 = SUM(service_commissions.commission_amount) — 真实【服务提成】
//   收入 = 两者相加（见 staffRankingIncome）。销售/服务两侧均为真实提成收入，
//   与 staffApi/routes/staff.js performanceDetail 三处自洽。
//   注意区分 staffRankingRevenue（纯销售营业额份额 SUM(total_amount)，= 门店视图首卡「今日分成（营业额）」口径）。
async function querySalesCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(spia.commission_amount::numeric), 0) AS v
       FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
       JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
       JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
      WHERE ${sc.sql}
        AND spia.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND ${timeWindow('spe.performance_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryServiceCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sc2.commission_amount::numeric), 0) AS v
       FROM service_commissions sc2
       JOIN service_items sit ON sit.service_item_id = sc2.service_item_id
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${sc.sql}
        AND sc2.is_void = FALSE
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 新会员（2026-04-25 起按 became_member_at 判定）
 *
 * 口径：所选时段内首次成为会员客。
 * 与 metrics.md "新会员"行严格对齐；与 became_member_at（与 customer_type='会员客' 跃迁同事务维护）作权威字段。
 *
 * 旧口径（已废弃）：`old_member_level IS NULL AND member_level IS NOT NULL AND [member_level_upgraded_at]`
 * — 旧口径会把"会员等级内跃迁（初钻→星钻 等）"也算作新会员，与业务语义偏离。
 */
async function queryNewMembers(scopeType, scopeId, date, mode) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND ${timeWindow('c.became_member_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 会员数（截面快照，2026-04-25 T2 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天为止累计成为会员客」 = COUNT(c.became_member_at::date <= $date)
 *
 * 不再用 c.customer_type = '会员客'（那是当前快照，无法反映历史日期）。
 * 改为用 c.became_member_at 时间戳，任意 $date 都可还原"那一天的会员数"。
 *
 * 跃迁路径在 `staffApi/routes/order.js`（recalcCustomerType）和
 * `payNotify/index.js`（重算路径）中已与 customer_type 跃迁同步写入 became_member_at = COALESCE(首笔达标单 paid_at, created_at)。
 * 历史数据由 `db/scripts/backfill-became-member-at.js` 一次性回填。
 */
async function queryMemberCount(scopeType, scopeId, date) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= $1::date`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 保有会员数（方案 B 实时计算，2026-04-25 T5 起）
 *
 * 口径：「$date 那天已是会员客」 ∩ 「$date 前 90 天到店至少 1 次」
 *
 * 不再读 client_wechat_users.customer_status 列（那是当前快照、cronTask 每日重算，
 * 无法反映历史日期）。改为基于 service_orders 实时聚合 + became_member_at 守卫，
 * 任意 $date 都可还原"那一天的保有会员数"。
 */
async function queryRetainedMemberCount(scopeType, scopeId, date) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT so.client_user_id) AS v
       FROM service_orders so
       JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ($1::date - INTERVAL '90 days') AND $1::date
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= $1::date`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 员工数（截面快照，2026-04-25 T3 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天为止已入职且未离职」 =
 *   COUNT(s.hired_at::date <= $date AND (s.resigned_at IS NULL OR s.resigned_at::date > $date))
 *
 * 不再用 s.is_resigned = FALSE（那是当前快照，无法反映历史日期）。
 * 改为用 s.hired_at + s.resigned_at 时间戳，任意 $date 都可还原"那一天的在职员工数"。
 *
 * 字段维护：admin 员工管理表单写入；当前 hired_at 由 created_at::date 兜底（WorkFine 无入职日期源），
 * resigned_at 由 updated_at::date 兜底。后续由管理后台维护。
 */
/**
 * 无门店产能技师（直挂市场/部门组织节点）的可见性片段 —— 与 admin
 * `lib/data-center/scope-sql.ts` 的 `orgAnchorScopeSql` **逐条对齐**（#320）。
 *
 *   - `all`    → 恒真。`validateManagementScope` 已要求 `all` 必须持总部 scope，
 *                等价于 admin 侧的 `isAdminScope(session) → TRUE` 分支
 *   - `market` → 锚定市场等于所选市场才出现
 *   - `store` 及**任何未知取值** → FALSE
 *
 * ⚠️ `all` 必须**按名字显式命中**、未知取值一律 fail-closed，不能写成
 * 「先排掉 store/market，兜底 return TRUE」——那样未知 scopeType 会让门店分支近乎空集
 * （`buildManagementStoreScope` 把未知当 market、按一个不存在的根展开）而锚分支恒真，
 * 分母静默膨胀成「全部直挂技师」。`validateManagementScope` 虽已拒掉未知取值，
 * 但那是另一个函数的责任，这里不借它的势。
 *
 * @param {number} startIdx 本片段自己的 $n 起始下标（不与门店分支共用参数）
 */
function buildTechnicianOrgAnchorScope(scopeType, scopeId, startIdx) {
  if (scopeType === 'all') return { sql: 'TRUE', params: [] }
  if (scopeType === 'market') {
    return { sql: `tb.anchor_market_id = $${startIdx}`, params: [scopeId] }
  }
  return { sql: 'FALSE', params: [] }
}

/**
 * 产能技师在职数（人均派生指标的**分母**）。
 *
 * ## 为什么不能只按 `staff_wechat_users.store_id` 过滤（#320）
 *
 * 员工组织归属是**双轨**的：`store_id`（门店 FK）+ `org_node_id`（组织节点 FK，
 * 可指向 部门/市场/门店 任一类型）。只认 `store_id` 会整体漏掉直挂市场/部门的人 ——
 * 2026-09-24 生产实测：在职产能技师 **166** 人，旧写法只数到 **152**，漏掉 **14** 人：
 * 8 人锚到南昌凤御、4 人锚到昭通凤御、1 人锚到「品项公司」（它 `type` 其实是市场，
 * id 前缀 `org-部门-` 是历史遗留），以上 13 人走市场锚分支；
 * 另 1 人（王志军）直挂门店组织节点、`store_id` 为空，被 `COALESCE` 回收进南昌云暖店。
 *
 * ⚠️ **14 是「产能技师 ∩ `store_id` 为空」这个子集**，不是「全部直挂员工」——
 * 后者生产实测 **95** 人（组织侧的数据治理见 #302）。别把两个数字混用。
 * 他们的产出**落在门店上、计入分子**，人头却不进分母 → 首页所有人均派生指标虚高 **+9.2%**
 * （人均业绩 / 人均生美业绩 / 人均实耗 / 人均生美实耗 / 人均客流 / 人均客量 / 人均新客 /
 * 人均项目数 / 人均提成收入，见 `notes/references/metrics.md` §派生指标）。
 *
 * ## 归属规则（与 admin `lib/data-center/technician-sql.ts` 的 `technicianCteSql` 镜像）
 *
 * 1. `COALESCE(sw.store_id, ds.store_id)` —— 直挂**门店组织节点**的人回收进该门店
 * 2. 回收后仍为 NULL 的（直挂市场/部门）用 `anchor_market_id` 锚到市场，
 *    交给 `buildTechnicianOrgAnchorScope` 判可见性
 *
 * ## 两个容易被当成缺陷的点（已核实，别再"修"）
 *
 * - **回收 join 不会扇出重复计数**：`stores.org_node_id` 上有唯一索引
 *   `stores_org_node_id_unique`（生产已核，2026-09-24 实测该 CTE 166 行 / 166 个不同
 *   `employee_id`），所以 `LEFT JOIN stores ds` 至多匹配一行，`COUNT(*)` 不需要 DISTINCT。
 * - **门店分支叠了启用门店过滤、市场锚分支没有**：这与 admin 一致（admin 的
 *   `scopeFilterSql` 内含 `activeStoreCondition`，`orgAnchorScopeSql` 的 market 分支只比锚定市场）。
 *   代价是「门店全停的市场 + 直挂技师」会分母含人、分子近零 → 人均偏低。属已知取舍：
 *   直挂者不属于任何门店，没有可供判断启停的门店。改它必须两端同步改。
 *
 * ⚠️ 两端是**独立副本**（禁止跨端共享代码目录，见根 CLAUDE.md），一致性由
 * `__tests__/routes/cross-end-technician-denominator.test.js` 的字面量断言守护。改一端必同步另一端。
 */
async function queryEmployeeCount(scopeType, scopeId, date) {
  // $1 = date；门店分支 scope 从 $2 起；市场锚分支接在其后
  const sc = buildStaffScope(scopeType, scopeId, 'tb', 2)
  const anchor = buildTechnicianOrgAnchorScope(scopeType, scopeId, 2 + sc.params.length)
  const rows = await pg.query(
    `WITH technician_base AS (
       SELECT sw.employee_id,
              COALESCE(sw.store_id, ds.store_id) AS store_id,
              CASE WHEN o.type = '市场' THEN o.id
                   WHEN op.type = '市场' THEN op.id
                   ELSE NULL END AS anchor_market_id
         FROM staff_wechat_users sw
         LEFT JOIN org_nodes o  ON o.id  = sw.org_node_id
         LEFT JOIN org_nodes op ON op.id = o.parent_id
         LEFT JOIN stores ds    ON ds.org_node_id = sw.org_node_id
        WHERE sw.skills && ARRAY['美容师','养生师']::text[]
          AND sw.hired_at IS NOT NULL
          AND sw.hired_at::date <= $1::date
          AND (sw.resigned_at IS NULL OR sw.resigned_at::date > $1::date)
     )
     SELECT COUNT(*) AS v
       FROM technician_base tb
      WHERE (tb.store_id IS NOT NULL AND ${sc.sql})
         OR (tb.store_id IS NULL AND ${anchor.sql})`,
    [date, ...sc.params, ...anchor.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 门店数（截面快照，2026-04-25 T4 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天在营」 =
 *   COUNT(s.opening_date::date <= $date AND (s.closed_at IS NULL OR s.closed_at::date > $date))
 *
 * 所有 scope 均查询 stores 表，附加当前 org_nodes.is_active=TRUE；因此停用门店即使
 * 通过 URL 直达也返回 0。opening_date/closed_at 仍负责历史在营口径。
 */
async function queryStoreCount(scopeType, scopeId, date) {
  // 与 summary 其它查询保持一致：$1 固定为日期，scope 参数从 $2 开始。
  const storeScope = buildSaleScope(scopeType, scopeId, 's', 2)
  const rows = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM stores s
       JOIN org_nodes o ON s.org_node_id = o.id
      WHERE ${storeScope.sql}
        AND o.type = '门店'
        AND o.is_active = TRUE
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= $1::date
        AND (s.closed_at IS NULL OR s.closed_at::date > $1::date)`,
    [date, ...storeScope.params],
  )
  return Number(rows[0]?.cnt || 0)
}

async function resolveScopeName(scopeType, scopeId) {
  if (scopeType === 'all') return '全部市场'
  if (scopeType === 'market') {
    const rows = await pg.query(
      "SELECT name FROM org_nodes WHERE id = $1 AND type = '市场'",
      [scopeId],
    )
    return rows[0]?.name || ''
  }
  const rows = await pg.query(
    'SELECT store_name FROM stores WHERE store_id = $1',
    [scopeId],
  )
  return rows[0]?.store_name || ''
}

/**
 * mgmtDashboard.summary
 * 入参：{ date: 'YYYY-MM-DD', scopeType: 'all'|'market'|'store', scopeId? }
 * 出参：见 ticket §1.2
 */
async function summary(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { date, scopeType, scopeId } = ctx.event.payload || {}

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('INVALID_PARAMS: 日期必填，且格式为 YYYY-MM-DD')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 全部/市场/门店')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const monthEnd = lastDayOfMonth(date)

  const t0 = Date.now()
  const [
    storeRevToday, storeRevMonth,
    shengmeiRevToday, shengmeiRevMonth,
    storeConsToday, storeConsMonth,
    shengmeiConsToday, shengmeiConsMonth,
    footfallToday, footfallMonth,
    headcountToday, headcountMonth,
    newMemToday, newMemMonth,
    projectCountToday, projectCountMonth,
    salesCommissionToday, salesCommissionMonth,
    serviceCommissionToday, serviceCommissionMonth,
    memberCount, retainedMemberCount,
    employeeCountDay, storeCountDay,
    employeeCountMonth, storeCountMonth,
    scopeName,
  ] = await Promise.all([
    queryStoreRevenue(scopeType, scopeId, date, 'day'),
    queryStoreRevenue(scopeType, scopeId, date, 'month'),
    queryShengmeiRevenue(scopeType, scopeId, date, 'day'),
    queryShengmeiRevenue(scopeType, scopeId, date, 'month'),
    queryStoreConsume(scopeType, scopeId, date, 'day'),
    queryStoreConsume(scopeType, scopeId, date, 'month'),
    queryShengmeiConsume(scopeType, scopeId, date, 'day'),
    queryShengmeiConsume(scopeType, scopeId, date, 'month'),
    queryFootfall(scopeType, scopeId, date, 'day'),
    queryFootfall(scopeType, scopeId, date, 'month'),
    queryHeadcount(scopeType, scopeId, date, 'day'),
    queryHeadcount(scopeType, scopeId, date, 'month'),
    queryNewMembers(scopeType, scopeId, date, 'day'),
    queryNewMembers(scopeType, scopeId, date, 'month'),
    queryProjectCount(scopeType, scopeId, date, 'day'),
    queryProjectCount(scopeType, scopeId, date, 'month'),
    querySalesCommissionIncome(scopeType, scopeId, date, 'day'),
    querySalesCommissionIncome(scopeType, scopeId, date, 'month'),
    queryServiceCommissionIncome(scopeType, scopeId, date, 'day'),
    queryServiceCommissionIncome(scopeType, scopeId, date, 'month'),
    queryMemberCount(scopeType, scopeId, date),
    queryRetainedMemberCount(scopeType, scopeId, date),
    queryEmployeeCount(scopeType, scopeId, date),     // 当日（selectedDate 当日的在职员工数）
    queryStoreCount(scopeType, scopeId, date),         // 当日（selectedDate 当日在营的门店数）
    queryEmployeeCount(scopeType, scopeId, monthEnd),  // 月末（用于月度派生指标分母）
    queryStoreCount(scopeType, scopeId, monthEnd),     // 月末（月度业绩对应的整月在营门店数）
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  const round2 = (v) => Math.round(Number(v) * 100) / 100
  // monthlyAvgPerStore：分母用月末口径，与"月度业绩 = 整月在营"语义对齐
  const avg = (m) => (storeCountMonth > 0 ? round2(m / storeCountMonth) : 0)

  ctx.result = {
    date,
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    storeRevenue: {
      today: round2(storeRevToday),
      month: round2(storeRevMonth),
      monthlyAvgPerStore: avg(storeRevMonth),
    },
    shengmeiRevenue: {
      today: round2(shengmeiRevToday),
      month: round2(shengmeiRevMonth),
      monthlyAvgPerStore: avg(shengmeiRevMonth),
    },
    storeConsume: {
      today: round2(storeConsToday),
      month: round2(storeConsMonth),
      monthlyAvgPerStore: avg(storeConsMonth),
    },
    shengmeiConsume: {
      today: round2(shengmeiConsToday),
      month: round2(shengmeiConsMonth),
      monthlyAvgPerStore: avg(shengmeiConsMonth),
    },
    footfall: { today: Number(footfallToday), month: Number(footfallMonth) },
    headcount: { today: Number(headcountToday), month: Number(headcountMonth) },
    newMembers: { today: Number(newMemToday), month: Number(newMemMonth) },
    projectCount: { today: Number(projectCountToday), month: Number(projectCountMonth) },
    salesCommissionIncome: {
      today: round2(salesCommissionToday),
      month: round2(salesCommissionMonth),
    },
    serviceCommissionIncome: {
      today: round2(serviceCommissionToday),
      month: round2(serviceCommissionMonth),
    },
    // T6（2026-04-25）：双口径 — day 给屏幕展示与日维度派生分母用，month 给月维度派生分母用
    storeCount: { day: storeCountDay, month: storeCountMonth },
    employeeCount: { day: employeeCountDay, month: employeeCountMonth },
    memberCount,
    retainedMemberCount,
    computedAt: new Date().toISOString(),
  }

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.summary] slow query: ${elapsed}ms`, { scopeType, scopeId, date })
  }
}

// =====================================================================
// storeRanking —— 门店排行榜（mgmt-dashboard ranking tab）
// =====================================================================

/**
 * 落 period 区间（用于业绩/实耗/客流/新会员/项目数）
 * 锚点固定为 NOW()::date，无 date 参数（设计稿无日历组件，3 个 period 固定相对值）
 * @param {string} col 列引用（含别名）
 * @param {'month'|'lastMonth'|'year'} period
 * @param {boolean} _isDateColumn 保留形参便于未来扩展（NOW()::date 与 timestamp 比较时 PG 会自动处理）
 */
function timeWindowPeriod(col, period, _isDateColumn) {
  if (period === 'month') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date)`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
  }
  // year
  return `date_trunc('year', ${col}) = date_trunc('year', NOW()::date)`
}

function performanceEventPeriodWindow(eventAlias, period) {
  return `${eventAlias}.status = '已支付'
    AND ${timeWindowPeriod(`${eventAlias}.performance_date`, period, true)}`
}

/**
 * 保有会员（方案 B）的 refDate SQL 表达式
 * - month / year：本月或本年还未结束 → 用 NOW()::date
 * - lastMonth：上月最后一天
 */
function getRefDateExpr(period) {
  if (period === 'lastMonth') {
    return `(date_trunc('month', NOW()::date) - INTERVAL '1 day')::date`
  }
  return `NOW()::date`
}

function getSalesDataPeriod(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const p = (v) => String(v).padStart(2, '0')
  const today = `${y}-${p(m)}-${p(d)}`
  if (period === 'month') {
    return { startDate: `${y}-${p(m)}-01`, endDate: today }
  }
  if (period === 'lastMonth') {
    const lmY = m === 1 ? y - 1 : y
    const lmM = m === 1 ? 12 : m - 1
    const lastDay = new Date(Date.UTC(lmY, lmM, 0)).getUTCDate()
    return { startDate: `${lmY}-${p(lmM)}-01`, endDate: `${lmY}-${p(lmM)}-${p(lastDay)}` }
  }
  return { startDate: `${y}-01-01`, endDate: today }
}

/**
 * 当前账号可见门店列表
 * @returns {string[] | null} null 表示总部 scope（不过滤）；[] 表示空集
 */
function getVisibleStoreIds(auth) {
  if (hasHeadquartersScope(auth.roleBindings)) return null
  return auth.scopeStoreIds || []
}

/**
 * 构造 stores 表的 store_id 过滤片段
 * @param {string[]|null} visibleStoreIds null=不过滤；[]=空集（返回 FALSE 让 SQL 短路）
 * @param {string} alias 表别名（默认 's'）
 * @param {number} startIdx 起始 $n 下标
 */
function buildStoreFilter(visibleStoreIds, alias, startIdx) {
  const column = `${alias}.store_id`
  if (!visibleStoreIds) {
    return withActiveStoreCondition({ sql: 'TRUE', params: [] }, column)
  }
  if (visibleStoreIds.length === 0) {
    return { sql: 'FALSE', params: [] }
  }
  return withActiveStoreCondition({
    sql: `${column} = ANY($${startIdx}::text[])`,
    params: [visibleStoreIds],
  }, column)
}

/**
 * 同值并列 RANK 跳号语义（标准 SQL RANK()）
 * [200,100,50] → 1/2/3；[100,100,50] → 1/1/3
 * 调用前 rows 必须已按 value DESC 排序
 */
function assignRanks(rows) {
  let rank = 0
  let lastValue = null
  rows.forEach((row, idx) => {
    if (row.value !== lastValue) {
      rank = idx + 1
      lastValue = row.value
    }
    row.rank = rank
  })
  return rows
}

/* ----- 6 个排行榜 metric 子查询 ----- */

async function rankingRevenue(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(spe.amount::numeric), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN sale_order_performance_events spe
       ON spe.store_id = s.store_id
       AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
       AND spe.legacy_source IS DISTINCT FROM 'workfine'
       AND spe.status = '已支付'
       AND spe.change_type IN ('首次支付', '回款', '退款')
       AND ${timeWindowPeriod('spe.performance_date', period, true)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingConsume(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND ${timeWindowPeriod('so2.service_date', period, true)}
       AND ${excludeDepositRefundSql('so2')}
     LEFT JOIN service_items sit ON sit.service_order_id = so2.service_order_id
     LEFT JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingRetainedMember(period, storeFilter) {
  const refDate = getRefDateExpr(period)
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(DISTINCT c.user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN client_wechat_users c
       ON c.bound_store_id = s.store_id
       AND c.became_member_at IS NOT NULL
       AND c.became_member_at::date <= ${refDate}
       AND EXISTS (
         SELECT 1 FROM service_orders so
         WHERE so.client_user_id = c.user_id
           AND so.status = '已完成'
           AND so.service_date BETWEEN (${refDate} - INTERVAL '90 days') AND ${refDate}
       )
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

/**
 * 新会员排名（2026-04-25 起按 became_member_at 判定，与 metrics.md "新会员"行对齐）
 *
 * 旧口径（已废弃）：`old_member_level IS NULL AND member_level IS NOT NULL AND [member_level_upgraded_at]`
 * 旧口径包含"会员等级内跃迁"，与"首次成会员"业务语义偏离。
 */
async function rankingNewMember(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(c.user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN client_wechat_users c
       ON c.bound_store_id = s.store_id
       AND c.became_member_at IS NOT NULL
       AND ${timeWindowPeriod('c.became_member_at', period, false)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingProjectCount(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(sit.session_used), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND ${timeWindowPeriod('so2.service_date', period, true)}
       AND ${excludeDepositRefundSql('so2')}
     LEFT JOIN service_items sit
       ON sit.service_order_id = so2.service_order_id
       AND sit.sales_category IN ('自销自耗', '他销自耗')
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingFootfall(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(DISTINCT so2.client_user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND so2.client_user_id IS NOT NULL
       AND ${timeWindowPeriod('so2.service_date', period, true)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

const METRIC_DISPATCH = {
  revenue: rankingRevenue,
  consume: rankingConsume,
  retainedMember: rankingRetainedMember,
  newMember: rankingNewMember,
  projectCount: rankingProjectCount,
  footfall: rankingFootfall,
}

const VALID_PERIODS = ['month', 'lastMonth', 'year']
const VALID_METRICS = ['revenue', 'consume', 'retainedMember', 'newMember', 'projectCount', 'footfall']

// 用户面错误信息使用中文标签（与 internal enum value 一一对应）
const PERIOD_CN = '本月/上月/本年'
const METRIC_CN = '业绩/实耗/留存会员/新会员/项目数/客流'
const STAFF_METRIC_CN = '业绩/实耗/新会员/客流/项目数/收入'
const SCOPE_TYPE_CN = '全部/市场/门店'

/**
 * mgmtDashboard.storeRanking
 * 入参：{ period: 'month'|'lastMonth'|'year', metric: 6 选 1 }
 * 出参：{ period, metric, unit, rows: [{rank, storeId, storeName, marketName, value}], computedAt }
 */
async function storeRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!VALID_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: 指标必须是 ' + METRIC_CN)
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  const storeFilter = buildStoreFilter(visibleStoreIds, 's', 1)

  const t0 = Date.now()
  const rawRows = await METRIC_DISPATCH[metric](period, storeFilter)
  const elapsed = Date.now() - t0

  const unit = (metric === 'revenue' || metric === 'consume') ? 'amount' : 'count'
  const rows = assignRanks(
    rawRows.map((r) => ({
      storeId: r.store_id,
      storeName: r.store_name,
      marketName: r.market_name,
      value: Number(r.value || 0),
    })),
  )

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.storeRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = {
    period,
    metric,
    unit,
    rows,
    computedAt: new Date().toISOString(),
  }
}

// =====================================================================
// staffRanking —— 员工排行榜（mgmt-dashboard ranking tab 「员工」子视图）
// =====================================================================
//
// 与 storeRanking 的关系：
//   - 复用 helper：timeWindowPeriod / getVisibleStoreIds / buildStoreFilter / assignRanks
//   - 独立 SQL：所有 metric 都先用 producer_employees CTE 锁定"产能员工"再 LEFT JOIN
//   - metric 集合不同：员工无 retainedMember；员工独有 income（销售提成 + 服务提成）
//
// 产能员工口径（2026-05-20 修订，原 skills && ARRAY['美容师','养生师'] 已删除）：
//   hired_at/resigned_at + NOW() 锚点 ∩ scope（store_id 可见列表）
// 不再用 skills 字段门控 — staff_wechat_users.skills 在历史员工档案中 1174/2020 为 NULL/空（如刘恋
// FY-240804002 hired_at=2026-03-13、skills 空但有 888 元 allocation），导致 ranking 漏算 33% 业绩。
// 各 metric 子查询按真实归属事实聚合，不再按 role_type 白名单截断；
// 末尾再用 WHERE COALESCE(value,0) > 0 把零值员工排除（无业绩不入榜）。
// metrics.md employeeCount 指标仍保留 skills 过滤（语义是"产能技师在职数"，与 ranking 候选池语义不同）。

/**
 * 拼接 producer_employees CTE 头部（所有 metric 共享）。
 *
 * ★ 2026-09-03 放宽：候选池不再要求 `store_id ∈ 在营门店`，改为「门店员工 ∪ 直挂组织节点员工」。
 *   缘由：品项公司的品项老师、各市场养生部的养生师 store_id 为空（直挂市场/部门节点），
 *   实耗归属改按服务提成分配后他们能拿到分配额，却被旧候选池整体挡在榜外
 *   （2026-09 生产实测 22 人 / 约 2.6 万元落榜）。
 *
 * 三段口径：
 *   1. store_id 兜底 —— 档案 store_id 为空但直挂的是**门店**节点时，反查该门店（修 1 例档案缺失）；
 *   2. 展示名兜底 —— store_name 为空时显示直挂节点名（如「品项公司」「养生部」），不留空白列；
 *   3. 可见性锚 —— 无门店员工按其**所属市场**判断可见性：直挂节点自身是市场则取自身，
 *      否则取父节点（部门→市场，org 树最多一层）。品项公司是总部直属市场节点、其下无门店，
 *      故只有总部 scope 能看到；养生部锚到南昌凤御，该市场管理层可见。
 *
 * @param {{sql: string, params: any[]}} storeFilter buildStoreFilter('pb', startIdx) 的结果
 * @param {{sql: string}} orgScope buildOrgAnchorScope(visibleStoreIds, startIdx) 的结果（无门店员工分支）
 */
function producerEmployeesCte(storeFilter, orgScope) {
  return `WITH producer_base AS (
  SELECT
    sw.employee_id,
    sw.name                                              AS employee_name,
    COALESCE(sw.store_id, ds.store_id)                   AS store_id,
    COALESCE(s.store_name, ds.store_name, o.name)        AS store_name,
    CASE WHEN o.type = '市场' THEN o.id
         WHEN op.type = '市场' THEN op.id
         ELSE NULL END                                   AS anchor_market_id
  FROM staff_wechat_users sw
  LEFT JOIN stores s     ON s.store_id     = sw.store_id
  LEFT JOIN org_nodes o  ON o.id           = sw.org_node_id
  LEFT JOIN org_nodes op ON op.id          = o.parent_id
  LEFT JOIN stores ds    ON ds.org_node_id = sw.org_node_id
  WHERE sw.hired_at IS NOT NULL
    AND sw.hired_at::date <= NOW()::date
    AND (sw.resigned_at IS NULL OR sw.resigned_at::date > NOW()::date)
),
producer_employees AS (
  SELECT pb.employee_id, pb.employee_name, pb.store_id, pb.store_name
  FROM producer_base pb
  WHERE (pb.store_id IS NOT NULL AND ${storeFilter.sql})
     OR (pb.store_id IS NULL AND ${orgScope.sql})
)`
}

/**
 * 无门店员工（直挂组织节点）的可见性片段，与 buildStoreFilter 配对使用。
 * 总部（visibleStoreIds=null）全可见；其余按「锚定市场下是否有本账号可见门店」判定。
 * @param {string[]|null} visibleStoreIds null=总部不过滤；[]=空集
 * @param {number} startIdx 复用 buildStoreFilter 的同一个 $n（两处引用同一份门店 ID 数组）
 */
function buildOrgAnchorScope(visibleStoreIds, startIdx) {
  if (!visibleStoreIds) return { sql: 'TRUE' }
  if (visibleStoreIds.length === 0) return { sql: 'FALSE' }
  return {
    sql: `EXISTS (
      SELECT 1
      FROM stores vs
      JOIN org_nodes vn ON vs.org_node_id = vn.id
      WHERE vn.type = '门店'
        AND vn.is_active = TRUE
        AND vn.parent_id = pb.anchor_market_id
        AND vs.store_id = ANY($${startIdx}::text[])
    )`,
  }
}

const STAFF_ORDER_BY = `ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC`

/* ----- 6 个员工排行榜 metric 子查询 ----- */

async function staffRankingRevenue(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
revenue_by_emp AS (
  SELECT
    spia.employee_id,
    COALESCE(SUM(spia.allocated_amount::numeric), 0) AS v
  FROM sale_payment_item_allocations spia
  JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
  JOIN sale_items si  ON si.sale_item_id  = spir.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
  WHERE spia.is_void = FALSE
    AND so.sale_order_type IN ('销售单','转换单')
    AND ${performanceEventPeriodWindow('spe', period)}
  GROUP BY spia.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(r.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id
WHERE COALESCE(r.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 实耗排名（2026-09-03 起改按服务提成分配归属，与「营业额分配-服务提成」导出同源）
 *
 * 旧口径（已废弃）：SUM(service_items.unit_real_price × session_used) 归 service_items.employee_id。
 *   service_items.employee_id 是开单时选定的负责美容师，全仓无任何路径可修改；门店事后用
 *   「营业额分配」改提成归属时改不动它，导致实耗长期记在没拿这单提成的人头上
 *   （2026-09 生产实测：103 项 / 7.7 万元错位，占当月实耗 23%）。
 *
 * 新口径：SUM(unit_real_price × session_used × service_commissions.allocation_ratio)
 *   归 service_commissions.employee_id ∩ is_void = FALSE。与 staff.js performanceDetail
 *   个人绩效页（早已按 service_commissions 归属）、admin 服务提成导出三处同源。
 *
 * ⚠️ 所有 role_type 各算一份（2026-09-03 用户拍板，不做角色去重）：同一项目同时挂
 *   美容师 + 品项老师时两人各按自己的 allocation_ratio 全额计入，故**员工榜合计会大于
 *   门店实耗**（2026-09 实测高约 25%）。这是刻意选择——品项老师的工作量要能上榜；
 *   门店榜 / 大卡实耗（rankingConsume / queryConsume）仍走 service_items 原口径，不受影响。
 */
async function staffRankingConsume(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
consume_by_emp AS (
  SELECT
    sc.employee_id,
    COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio), 0) AS v
  FROM service_commissions sc
  JOIN service_items sit ON sit.service_item_id = sc.service_item_id
  JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
  JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
  WHERE sc.is_void = FALSE
    AND so2.status = '已完成'
    AND ${timeWindowPeriod('so2.service_date', period, true)}
    AND ${excludeDepositRefundSql('so2')}
  GROUP BY sc.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(c.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN consume_by_emp c ON c.employee_id = pe.employee_id
WHERE COALESCE(c.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 新会员排名（2026-04-25 起按 became_member_at 判定，与 metrics.md "新会员"行对齐）
 * 旧口径（已废弃）：old_member_level IS NULL ∧ member_level IS NOT NULL ∩ [member_level_upgraded_at]
 *
 * 归属字段：client_wechat_users.bound_employee_id（绑定美容师）
 * bound_employee_id IS NULL 的新会员不归属任何员工（"无归属新会员"由监控关注，本接口不展示）
 */
async function staffRankingNewMember(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
new_member_by_emp AS (
  SELECT
    c.bound_employee_id AS employee_id,
    COUNT(*) AS v
  FROM client_wechat_users c
  WHERE c.bound_employee_id IS NOT NULL
    AND c.became_member_at IS NOT NULL
    AND ${timeWindowPeriod('c.became_member_at', period, false)}
  GROUP BY c.bound_employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(n.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN new_member_by_emp n ON n.employee_id = pe.employee_id
WHERE COALESCE(n.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 客流排名（2026-09-03 起归属改 service_commissions，口径依据见 staffRankingConsume 头注释）
 * COUNT(DISTINCT client_user_id) 天然对同一顾客去重，多角色不会重复计人。
 */
async function staffRankingFootfall(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
footfall_by_emp AS (
  SELECT
    sc.employee_id,
    COUNT(DISTINCT so2.client_user_id) AS v
  FROM service_commissions sc
  JOIN service_items sit ON sit.service_item_id = sc.service_item_id
  JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
  WHERE sc.is_void = FALSE
    AND so2.status = '已完成'
    AND so2.client_user_id IS NOT NULL
    AND ${timeWindowPeriod('so2.service_date', period, true)}
  GROUP BY sc.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(f.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN footfall_by_emp f ON f.employee_id = pe.employee_id
WHERE COALESCE(f.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 项目数排名（2026-09-03 起归属改 service_commissions，口径依据见 staffRankingConsume 头注释）
 *
 * 次数是计数指标，不按 allocation_ratio 拆分（不存在 0.5 次项目）：被分配到的员工各记完整次数，
 * 与「多角色各算一份」一致。内层 DISTINCT 防同一员工在同一项目挂多个 role_type 时重复累加
 * （uq_svc_comm_item_emp_role 允许该组合，当前生产为 0 例）。
 */
async function staffRankingProjectCount(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
project_by_emp AS (
  SELECT
    employee_id,
    COALESCE(SUM(session_used), 0) AS v
  FROM (
    SELECT DISTINCT sc.employee_id, sit.service_item_id, sit.session_used
    FROM service_commissions sc
    JOIN service_items sit ON sit.service_item_id = sc.service_item_id
    JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
    WHERE sc.is_void = FALSE
      AND so2.status = '已完成'
      AND sit.sales_category IN ('自销自耗','他销自耗')
      AND ${timeWindowPeriod('so2.service_date', period, true)}
      AND ${excludeDepositRefundSql('so2')}
  ) t
  GROUP BY employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(p.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
WHERE COALESCE(p.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 收入排名 = 销售提成 + 服务提成（2026-05-26 §3.15：销售部分改用真实提成 commission_amount）
 *   - 销售部分 = SUM(sale_payment_item_allocations.commission_amount)（≠ staffRankingRevenue 的 allocated_amount 营业额份额）
 *   - 服务部分来自 service_commissions.commission_amount（已是计算后的实拿提成）
 *   - 与 querySalesCommissionIncome / staff.js performanceDetail 三处自洽
 * is_void=FALSE，不按 role_type 白名单截断
 */
async function staffRankingIncome(period, storeFilter, orgScope) {
  return pg.query(
    `${producerEmployeesCte(storeFilter, orgScope)},
sales_comm AS (
  SELECT
    spia.employee_id,
    COALESCE(SUM(spia.commission_amount::numeric), 0) AS v
  FROM sale_payment_item_allocations spia
  JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
  JOIN sale_items si  ON si.sale_item_id  = spir.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
  WHERE spia.is_void = FALSE
    AND so.sale_order_type IN ('销售单','转换单')
    AND ${performanceEventPeriodWindow('spe', period)}
  GROUP BY spia.employee_id
),
service_comm AS (
  SELECT
    sc.employee_id,
    COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
  FROM service_commissions sc
  JOIN service_items sit  ON sit.service_item_id   = sc.service_item_id
  JOIN service_orders so2 ON so2.service_order_id  = sit.service_order_id
  WHERE sc.is_void = FALSE
    AND so2.status = '已完成'
    AND ${timeWindowPeriod('so2.service_date', period, true)}
  GROUP BY sc.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  (COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0))::numeric AS value
FROM producer_employees pe
LEFT JOIN sales_comm   sc1 ON sc1.employee_id = pe.employee_id
LEFT JOIN service_comm sc2 ON sc2.employee_id = pe.employee_id
WHERE COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

const STAFF_METRIC_DISPATCH = {
  revenue:      staffRankingRevenue,
  consume:      staffRankingConsume,
  newMember:    staffRankingNewMember,
  footfall:     staffRankingFootfall,
  projectCount: staffRankingProjectCount,
  income:       staffRankingIncome,
}

const VALID_STAFF_METRICS = ['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income']

/**
 * mgmtDashboard.staffRanking
 * 入参：{ period: 'month'|'lastMonth'|'year', metric: 6 选 1 }
 * 出参：{ period, metric, unit, rows: [{rank, employeeId, employeeName, storeId, storeName, value}], computedAt }
 */
async function staffRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!VALID_STAFF_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: 指标必须是 ' + STAFF_METRIC_CN)
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  // 注意：员工查询 store filter 别名是 sw（staff_wechat_users）
  // 候选池别名改 pb（producer_base）：门店员工走 storeFilter，直挂组织节点员工走 orgScope，
  // 两者共用同一个 $1 门店 ID 数组，故 orgScope 不再追加 params。
  const storeFilter = buildStoreFilter(visibleStoreIds, 'pb', 1)
  const orgScope = buildOrgAnchorScope(visibleStoreIds, 1)

  const t0 = Date.now()
  const rawRows = await STAFF_METRIC_DISPATCH[metric](period, storeFilter, orgScope)
  const elapsed = Date.now() - t0

  const unit = (metric === 'revenue' || metric === 'consume' || metric === 'income') ? 'amount' : 'count'
  const rows = assignRanks(
    rawRows.map((r) => ({
      employeeId:   r.employee_id,
      employeeName: r.employee_name || '',
      storeId:      r.store_id || null,
      storeName:    r.store_name || '',
      value:        Number(r.value || 0),
    })),
  )

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.staffRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = {
    period,
    metric,
    unit,
    rows,
    computedAt: new Date().toISOString(),
  }
}

// =====================================================================
// salesData —— 销售数据页（业绩与实耗 + 品项维度汇总）
// =====================================================================

// 销售数据页骨架常量（仅经营类型 — 与 db/schema/enums.ts::salesCategoryEnum 同源）
// 一级/二级品项骨架不在此写死，运行时从 product_categories 表读取（见 SQL 9）
// 单源收敛到 utils/sales-categories.js（issue #123），与 staff.performanceDetail 共用同一份
const { SALES_CATEGORIES: SALES_CATEGORY_SKELETON } = require('../utils/sales-categories')

/**
 * mgmtDashboard.salesData
 * 入参：{ period: 'month'|'lastMonth'|'year', scope: { type: 'all'|'market'|'store', id?: string } }
 * 出参：totalRevenue / 分客型业绩 / totalConsume / 分客型实耗 / 品项汇总
 *
 * 时间轴：BETWEEN period.startDate AND period.endDate（与 summary 的 date_trunc 不同）
 * 顾客分型：取 client_wechat_users 当前快照（新增会员 = became_member_at >= startDate）
 */
async function salesData(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, scope } = ctx.event.payload || {}
  const scopeType = scope?.type
  const scopeId = scope?.id || null

  if (!['month', 'lastMonth', 'year'].includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 ' + SCOPE_TYPE_CN)
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = getSalesDataPeriod(period)
  const fmt = (v) => parseFloat(v || 0).toFixed(2)

  // $1=startDate, $2=endDate, $3...=scope params
  const scSale = buildSaleScope(scopeType, scopeId, 'o', 3)
  const scSvc = buildSaleScope(scopeType, scopeId, 'so', 3)
  const saleP = [startDate, endDate, ...scSale.params]
  const svcP = [startDate, endDate, ...scSvc.params]

  const t0 = Date.now()
  const [revRows, custRevRows, consRows, custConsRows, prodOutRows, catRows, kindRows, nameRows, skeletonRows] =
    await Promise.all([
      // SQL 1: 总业绩（一律按款项业绩归属日期 spe.performance_date；
      //        原注释「后续回款/退款按真实发生日」自 #137 收敛后已失效，见文件头）
      pg.query(
        `SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
           FROM sale_order_performance_events spe
           JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
          WHERE ${scSale.sql}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND o.sale_order_type IN ('销售单', '转换单', '充值单')
            AND o.legacy_source IS DISTINCT FROM 'workfine'
            AND spe.performance_date BETWEEN $1 AND $2`,
        saleP,
      ),
      // SQL 2: 分客型业绩（按同一笔实际现金流分桶）
      //   充值单没有 sale_items，故按付款流水关联订单和顾客，避免漏掉充值现金；
      //   并把 became_member_at IS NULL（历史回填缺口）的"会员客"归到"老会员"（COALESCE 兜底）。
      pg.query(
        `SELECT
            COALESCE(SUM(spe.amount::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(spe.amount::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(spe.amount::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM sale_order_performance_events spe
           JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
           JOIN client_wechat_users c ON c.user_id = o.client_user_id
          WHERE ${scSale.sql}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND o.sale_order_type IN ('销售单', '转换单', '充值单')
            AND o.legacy_source IS DISTINCT FROM 'workfine'
            AND spe.performance_date BETWEEN $1 AND $2`,
        saleP,
      ),
      // SQL 3: 总实耗
      pg.query(
        `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
           JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2
            AND ${excludeDepositRefundSql('so')}`,
        svcP,
      ),
      // SQL 4: 分客型项目实耗（2026-05-20 P0-3 修复：became_member_at NULL 兜底归老会员）
      pg.query(
        `SELECT
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
           JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
           JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2
            AND ${excludeDepositRefundSql('so')}`,
        svcP,
      ),
      // SQL 5: 分客型产品出库（product_type='家居产品' 行级；2026-05-20 P0-3 修复 NULL 兜底）
      pg.query(
        `SELECT
            COALESCE(SUM(sipe.amount::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(sipe.amount::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(sipe.amount::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM sale_item_performance_events sipe
           JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
           JOIN sale_orders o ON o.sale_order_id = sipe.sale_order_id
           JOIN client_wechat_users c ON c.user_id = o.client_user_id
          WHERE ${scSale.sql}
            AND si.product_type = '家居产品'
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND sipe.performance_date BETWEEN $1 AND $2`,
        saleP,
      ),
      // SQL 6: 按经营类型汇总
      pg.query(
        `SELECT si.sales_category AS label,
                COALESCE(SUM(sipe.amount::numeric), 0) AS value
           FROM sale_item_performance_events sipe
           JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
           JOIN sale_orders o ON o.sale_order_id = sipe.sale_order_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND sipe.performance_date BETWEEN $1 AND $2
            AND si.sales_category IS NOT NULL
          GROUP BY si.sales_category
          ORDER BY value DESC`,
        saleP,
      ),
      // SQL 7: 按一级品项汇总
      pg.query(
        `SELECT pc.product_kind AS label,
                COALESCE(SUM(sipe.amount::numeric), 0) AS value
           FROM sale_item_performance_events sipe
           JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
           JOIN sale_orders o ON o.sale_order_id = sipe.sale_order_id
           JOIN product_skus sk ON sk.sku_id = si.sku_id
           JOIN product_categories pc ON pc.category_id = sk.category_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND sipe.performance_date BETWEEN $1 AND $2
            AND pc.product_kind IS NOT NULL
          GROUP BY pc.product_kind
          ORDER BY value DESC`,
        saleP,
      ),
      // SQL 8: 按一二级品项当期销售（嵌套用）
      pg.query(
        `SELECT pc.product_kind AS kind,
                pc.category_name AS label,
                COALESCE(SUM(sipe.amount::numeric), 0) AS value
           FROM sale_item_performance_events sipe
           JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
           JOIN sale_orders o ON o.sale_order_id = sipe.sale_order_id
           JOIN product_skus sk ON sk.sku_id = si.sku_id
           JOIN product_categories pc ON pc.category_id = sk.category_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND sipe.performance_date BETWEEN $1 AND $2
            AND pc.product_kind IS NOT NULL
            AND pc.category_name IS NOT NULL
          GROUP BY pc.product_kind, pc.category_name`,
        saleP,
      ),
      // SQL 9: 品项骨架（不依赖时间窗 / scope，是 product_categories 表的当前全量快照）
      pg.query(
        `SELECT product_kind, category_name
           FROM product_categories
          WHERE product_kind IS NOT NULL
            AND category_name IS NOT NULL
          ORDER BY product_kind, category_name`,
        [],
      ),
    ])

  const elapsed = Date.now() - t0

  const fmtPct = (num, denom) => {
    const d = parseFloat(denom || 0)
    if (d === 0) return '—'
    return ((parseFloat(num || 0) / d) * 100).toFixed(2) + '%'
  }
  const cmpDescByValueAscByLabel = (a, b) => {
    const dv = parseFloat(b.value) - parseFloat(a.value)
    return dv !== 0 ? dv : a.label.localeCompare(b.label, 'zh-Hans-CN')
  }

  // 经营类型骨架（4 行硬展示，pgEnum 序）+ 占比（分母=4 行金额之和）
  const catMap = new Map(catRows.map((r) => [r.label, r.value]))
  const salesCategoryTotal = Array.from(catMap.values())
    .reduce((s, v) => s + parseFloat(v || 0), 0)
  const bySalesCategory = SALES_CATEGORY_SKELETON.map((lbl) => {
    const v = catMap.get(lbl) || 0
    return { label: lbl, value: fmt(v), ratio: fmtPct(v, salesCategoryTotal) }
  })

  // 一级/二级骨架来自 SQL 9 的 product_categories 快照
  const kindTotalMap = new Map(kindRows.map((r) => [r.label, r.value]))
  const leafValueMap = new Map() // `${kind}::${label}` -> value
  for (const r of nameRows) {
    leafValueMap.set(`${r.kind}::${r.label}`, r.value)
  }

  // 品项总额（一级金额之和）— 一级和二级 ratio 的统一分母
  const productKindTotal = kindRows
    .reduce((s, r) => s + parseFloat(r.value || 0), 0)

  // 按 product_kind 分组骨架（children 暂存数值原值供 ratio 计算）
  const groupBuilder = new Map() // kind -> { children: [{label, value}] }
  for (const sk of skeletonRows) {
    if (!groupBuilder.has(sk.product_kind)) {
      groupBuilder.set(sk.product_kind, { children: [] })
    }
    const v = leafValueMap.get(`${sk.product_kind}::${sk.category_name}`) || 0
    groupBuilder.get(sk.product_kind).children.push({
      label: sk.category_name,
      value: fmt(v),
      ratio: fmtPct(v, productKindTotal),
    })
  }

  // 装配最终结构：一级 value 取 kindRows，children 排序，一级整体按 value DESC + label 升序
  const byProductKind = Array.from(groupBuilder.entries())
    .map(([kind, { children }]) => {
      const kv = kindTotalMap.get(kind) || 0
      return {
        label: kind,
        value: fmt(kv),
        ratio: fmtPct(kv, productKindTotal),
        children: children.sort(cmpDescByValueAscByLabel),
      }
    })
    .sort(cmpDescByValueAscByLabel)

  ctx.result = {
    totalRevenue: fmt(revRows[0]?.v),
    xiaomeiRevenue: fmt(custRevRows[0]?.xiaomei),
    newMemberRevenue: fmt(custRevRows[0]?.new_member),
    oldMemberRevenue: fmt(custRevRows[0]?.old_member),
    totalConsume: fmt(consRows[0]?.v),
    xiaomeiProjectConsume: fmt(custConsRows[0]?.xiaomei),
    newMemberProjectConsume: fmt(custConsRows[0]?.new_member),
    oldMemberProjectConsume: fmt(custConsRows[0]?.old_member),
    xiaomeiProductOut: fmt(prodOutRows[0]?.xiaomei),
    newMemberProductOut: fmt(prodOutRows[0]?.new_member),
    oldMemberProductOut: fmt(prodOutRows[0]?.old_member),
    bySalesCategory,
    byProductKind,
  }

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.salesData] slow: ${elapsed}ms`, { period, scopeType, scopeId })
  }
}

module.exports = { scopeOptions, summary, storeRanking, staffRanking, salesData }
