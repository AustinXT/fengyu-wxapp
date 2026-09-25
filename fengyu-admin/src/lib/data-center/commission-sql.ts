/**
 * 员工提成日报 / 提成明细（#375）的 SQL 单源。
 *
 * 业绩提成 = sale_payment_item_allocations.commission_amount，按款项归属日期（spe.performance_date）归日；
 * 消耗提成 = service_commissions.commission_amount，按 so.service_date 归日。
 * 两侧关键条件与 staff 管理层「员工收入」（mgmt-dashboard.js querySalesCommissionIncome /
 * queryServiceCommissionIncome）、admin 人效板收入同源，由 consistency.commission.test.ts 字面量守护：
 *   业绩：spia.is_void = FALSE ∩ so.sale_order_type IN ('销售单', '转换单') ∩ spe.status = '已支付'
 *   消耗：sc.is_void = FALSE ∩ so.status = '已完成'
 *
 * 读落库的提成额与费率快照，不按「分配金额 × 提成点」重算（服务提成分项舍入；#379 划卡阈值上线后差更多）。
 * 不加 >0 / HAVING >0 过滤（#290）：负数冲销行照常参与格子与合计。
 * 日期一律是 date 列与 'YYYY-MM-DD' 字面量比较，不经过会话时区（#291）。
 */
import { sql, type SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import type { DataCenterScope, ResolvedRange } from './types'
import { scopeFilterSql } from './scope-sql'
import {
  NO_POSITION_LABEL,
  type CommissionDetailFilters,
  type CommissionDetailKey,
  type CommissionRowGrain,
} from './commission-daily'

export interface CommissionLineFilters {
  range: ResolvedRange
  employeeId?: string | null
  storeId?: string | null
  source?: 'sale' | 'service' | null
}

/**
 * 业绩提成的取数链（FROM + JOIN）与关键条件（WHERE）。日报、明细、KPI 共用；拆成两段是为了让明细
 * 在两者之间补展示用的 LEFT JOIN，而取数链与条件本身仍只有这一份。
 */
const SALE_FROM = sql`
      FROM sale_payment_item_allocations spia
      JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id`

function saleWhere(session: AuthSession, scope: DataCenterScope, filters: CommissionLineFilters): SQL {
  return sql`
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND spia.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.performance_date BETWEEN ${filters.range.start} AND ${filters.range.end}
        ${filters.employeeId ? sql`AND spia.employee_id = ${filters.employeeId}` : sql``}
        ${filters.storeId ? sql`AND so.store_id = ${filters.storeId}` : sql``}`
}

/** 消耗提成的取数链与关键条件（同上） */
const SERVICE_FROM = sql`
      FROM service_commissions sc
      JOIN service_items sit ON sit.service_item_id = sc.service_item_id
      JOIN service_orders so ON so.service_order_id = sit.service_order_id`

function serviceWhere(session: AuthSession, scope: DataCenterScope, filters: CommissionLineFilters): SQL {
  return sql`
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sc.is_void = FALSE
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${filters.range.start} AND ${filters.range.end}
        ${filters.employeeId ? sql`AND sc.employee_id = ${filters.employeeId}` : sql``}
        ${filters.storeId ? sql`AND so.store_id = ${filters.storeId}` : sql``}`
}

function sourceParts<T>(source: CommissionLineFilters['source'], sale: T, service: T): T[] {
  return source === 'sale' ? [sale] : source === 'service' ? [service] : [sale, service]
}

/**
 * 统一提成行 CTE（`commission_lines`）：一行 = 一条 spia 或一条 service_commissions。
 * 产出列：source, source_id, employee_id, store_id, biz_date, sale_commission, service_commission, order_key。
 * order_key 带来源前缀：销售单号与服务单号是两套编号，去重单数按「销售单号 + 服务单号」计（含 0 提成订单）。
 */
export function commissionLinesCteSql(
  session: AuthSession,
  scope: DataCenterScope,
  filters: CommissionLineFilters,
): SQL {
  const sale = sql`
      SELECT 'sale'::text AS source, spia.id AS source_id, spia.employee_id, so.store_id,
             spe.performance_date AS biz_date,
             COALESCE(spia.commission_amount::numeric, 0) AS sale_commission,
             0::numeric AS service_commission,
             'S:' || so.sale_order_id AS order_key
      ${SALE_FROM}
      ${saleWhere(session, scope, filters)}`
  const service = sql`
      SELECT 'service'::text AS source, sc.id AS source_id, sc.employee_id, so.store_id,
             so.service_date AS biz_date,
             0::numeric AS sale_commission,
             sc.commission_amount::numeric AS service_commission,
             'V:' || so.service_order_id AS order_key
      ${SERVICE_FROM}
      ${serviceWhere(session, scope, filters)}`
  return sql`commission_lines AS (${sql.join(sourceParts(filters.source, sale, service), sql` UNION ALL `)})`
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 行键表达式（与 commission-daily.ts 的 CommissionDailyRow.key 同一构造） */
function groupKeySql(grain: CommissionRowGrain): SQL {
  if (grain === 'position') return sql`COALESCE(NULLIF(TRIM(sw.position_name), ''), ${NO_POSITION_LABEL})`
  if (grain === 'employee') return sql`cl.employee_id`
  return sql`cl.employee_id || '|' || cl.store_id`
}

/**
 * 日报矩阵：GROUPING SETS 一次出格子 (gk,d)、行合计 (gk)、按日合计 (d)、总计 ()。
 * 去重单数 / 去重人数只能在 SQL 里算，所以表尾合计也从这里取，不由前端逐行相加。
 *
 * - `search`：员工姓名 / 岗位 / 单据门店名，筛掉的是提成行（再聚合），表尾随之变化；指标卡不随搜索变化（另查）。
 * - `hideZero`：☆ 只隐藏**行合计 = 0** 的行（`<> 0`，负数行保留，不是 #290 禁止的 >0 过滤）；
 *   先定行键再聚合，表尾与隐藏后的可见行一致。
 */
export function commissionMatrixSql(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  grain: CommissionRowGrain,
  options: { search: string; hideZero: boolean },
): SQL {
  const pattern = options.search ? `%${escapeLike(options.search)}%` : null
  return sql`
    WITH ${commissionLinesCteSql(session, scope, { range })},
    tagged AS (
      SELECT cl.*, ${groupKeySql(grain)} AS gk,
             sw.name AS employee_name, sw.position_name, st.store_name
      FROM commission_lines cl
      LEFT JOIN staff_wechat_users sw ON sw.employee_id = cl.employee_id
      LEFT JOIN stores st ON st.store_id = cl.store_id
      ${pattern
        ? sql`WHERE (sw.name ILIKE ${pattern} OR sw.position_name ILIKE ${pattern} OR st.store_name ILIKE ${pattern})`
        : sql``}
    ),
    visible AS (
      SELECT * FROM tagged
      ${options.hideZero
        ? sql`WHERE gk IN (
            SELECT gk FROM tagged GROUP BY gk
            HAVING SUM(sale_commission + service_commission) <> 0
          )`
        : sql``}
    )
    SELECT gk,
           biz_date::text AS d,
           GROUPING(gk) AS g_gk,
           GROUPING(biz_date) AS g_d,
           SUM(sale_commission) AS sale,
           SUM(service_commission) AS service,
           COUNT(DISTINCT order_key) AS orders,
           COUNT(DISTINCT employee_id) AS employees,
           COUNT(DISTINCT store_id) AS stores,
           MIN(employee_id) AS employee_id,
           MIN(employee_name) AS employee_name,
           MIN(position_name) AS position_name,
           MIN(store_id) AS store_id,
           MIN(store_name) AS store_name
    FROM visible
    GROUP BY GROUPING SETS ((gk, biz_date), (gk), (biz_date), ())
  `
}

/**
 * 指标卡（按当前范围全量，不随员工搜索 / 隐藏 0 行变化）：
 * 业绩 / 消耗提成、净提成 > 0 的去重员工数（KPI 口径定义，不是行过滤）、有任意提成行的去重员工数、去重订单数。
 */
export function commissionKpiSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): SQL {
  return sql`
    WITH ${commissionLinesCteSql(session, scope, { range })},
    per_employee AS (
      SELECT employee_id, SUM(sale_commission + service_commission) AS net
      FROM commission_lines
      GROUP BY employee_id
    )
    SELECT
      (SELECT COALESCE(SUM(sale_commission), 0) FROM commission_lines) AS sale,
      (SELECT COALESCE(SUM(service_commission), 0) FROM commission_lines) AS service,
      (SELECT COUNT(DISTINCT order_key) FROM commission_lines)::int AS orders,
      (SELECT COUNT(*) FROM per_employee WHERE net > 0)::int AS earning_employees,
      (SELECT COUNT(*) FROM per_employee)::int AS employees
  `
}

/**
 * 待分配提示：口径与 /allocations「待分配」筛选（actions/allocations.ts getPendingPayments）同源——
 * allocation_status = '待分配' 且存在非 0 receipt 没有有效分配（或整笔没有 receipt 但订单仍有净实收），
 * 限销售单 / 转换单、非 workfine 历史单；另按款项归属日期落在所选月、当前 scope 内。
 */
export function pendingAllocationSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): SQL {
  return sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(sop.amount::numeric), 0) AS amount
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
      AND sop.allocation_status = '待分配'
      AND so.sale_order_type IN ('销售单', '转换单')
      AND so.legacy_source IS DISTINCT FROM 'workfine'
      AND sop.performance_attribution_date BETWEEN ${range.start} AND ${range.end}
      AND (
        EXISTS (
          SELECT 1
            FROM sale_payment_item_receipts spir
           WHERE spir.sale_payment_id = sop.id
             AND spir.amount::numeric <> 0
             AND NOT EXISTS (
               SELECT 1
                 FROM sale_payment_item_allocations spia
                WHERE spia.sale_payment_item_receipt_id = spir.id
                  AND spia.is_void = false
             )
        )
        OR (
          NOT EXISTS (SELECT 1 FROM sale_payment_item_receipts spir WHERE spir.sale_payment_id = sop.id)
          AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) > 0
        )
      )
  `
}

/** 明细下拉：期内在当前范围有提成行的员工（按 employee_id 去重，含期内离职） */
export function commissionEmployeeOptionsSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): SQL {
  return sql`
    WITH ${commissionLinesCteSql(session, scope, { range })}
    SELECT e.employee_id, sw.name, sw.position_name,
           COALESCE(home.store_name, org.name) AS home_name
    FROM (SELECT DISTINCT employee_id FROM commission_lines) e
    LEFT JOIN staff_wechat_users sw ON sw.employee_id = e.employee_id
    LEFT JOIN stores home ON home.store_id = sw.store_id
    LEFT JOIN org_nodes org ON org.id = sw.org_node_id
    ORDER BY COALESCE(home.store_name, org.name) ASC NULLS LAST, sw.name ASC NULLS LAST, e.employee_id ASC
  `
}


/** 明细筛选 → 取数条件：当日明细把期间收窄到这一天，其余沿用所选月份 */
export function detailLineFilters(filters: CommissionDetailFilters, month: ResolvedRange): CommissionLineFilters {
  return {
    range: filters.date ? { start: filters.date, end: filters.date } : month,
    employeeId: filters.employeeId,
    storeId: filters.storeId,
    source: filters.source,
  }
}

/**
 * 明细行（统一两张表的展示字段），作 `detail_rows` CTE。产出列：
 * source, source_id, biz_date, store_id, store_name, employee_id, employee_name, position_name,
 * order_id, payment_id, customer_name, order_kind, product_name, category_l1, category_l2,
 * received, consume_amount, allocated, rate, commission
 *
 * 分配金额：销售行 = spia.allocated_amount；服务行 = round(round(单价 × 次数, 2) × allocation_ratio, 2)，
 * 与服务提成导出（actions/services.ts selectServiceCommissionExportRows）同一算法。
 * 实收金额：销售行 = 这笔款项落在该商品行上的金额（spir.amount，退款为负）；服务行 0，另给「消耗额」。
 */
function detailRowsCteSql(session: AuthSession, scope: DataCenterScope, filters: CommissionLineFilters): SQL {
  const sale = sql`
      SELECT 'sale'::text AS source, spia.id AS source_id, spe.performance_date AS biz_date,
             so.store_id, COALESCE(st.store_name, so.store_name) AS store_name,
             spia.employee_id, sw.name AS employee_name, sw.position_name,
             so.sale_order_id AS order_id, spir.sale_payment_id AS payment_id,
             COALESCE(cw.name, so.customer_name) AS customer_name,
             so.sale_order_type::text || '·' || spe.change_type::text AS order_kind,
             si.product_name, pc.product_kind AS category_l1, pc.category_name AS category_l2,
             spir.amount::numeric AS received,
             NULL::numeric AS consume_amount,
             spia.allocated_amount::numeric AS allocated,
             spia.commission_rate::numeric AS rate,
             COALESCE(spia.commission_amount::numeric, 0) AS commission
      ${SALE_FROM}
      LEFT JOIN stores st ON st.store_id = so.store_id
      LEFT JOIN staff_wechat_users sw ON sw.employee_id = spia.employee_id
      LEFT JOIN client_wechat_users cw ON cw.user_id = so.client_user_id
      LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
      LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
      ${saleWhere(session, scope, filters)}`
  const service = sql`
      SELECT 'service'::text AS source, sc.id AS source_id, so.service_date AS biz_date,
             so.store_id, st.store_name,
             sc.employee_id, sw.name AS employee_name, sw.position_name,
             so.service_order_id AS order_id, NULL::bigint AS payment_id,
             cw.name AS customer_name,
             '服务单' || COALESCE('·' || so.service_order_type::text, '') AS order_kind,
             si.product_name, pc.product_kind AS category_l1, pc.category_name AS category_l2,
             0::numeric AS received,
             ROUND(sit.unit_real_price::numeric * sit.session_used, 2) AS consume_amount,
             ROUND(ROUND(sit.unit_real_price::numeric * sit.session_used, 2) * sc.allocation_ratio::numeric, 2) AS allocated,
             sc.commission_rate::numeric AS rate,
             sc.commission_amount::numeric AS commission
      ${SERVICE_FROM}
      LEFT JOIN stores st ON st.store_id = so.store_id
      LEFT JOIN staff_wechat_users sw ON sw.employee_id = sc.employee_id
      LEFT JOIN client_wechat_users cw ON cw.user_id = so.client_user_id
      LEFT JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
      LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
      ${serviceWhere(session, scope, filters)}`
  return sql`detail_rows AS (${sql.join(sourceParts(filters.source, sale, service), sql` UNION ALL `)})`
}

/**
 * 明细一页（keyset）。排序 = (biz_date DESC, source ASC, source_id DESC)：spia 与 service_commissions 的 id
 * 各自自增会撞号，唯一键必须是 (source, source_id)（#239 / #282）。
 * ⚠️ 首键 biz_date **可变**：款项归属日期可调整、重新分配 = 作废旧 spia 插新 id。键唯一保证不会死循环、
 * 静止数据下不重不漏；但翻页 / 分批导出期间恰好发生上述写入时，个别行可能重复或遗漏（导出是「开始时刻的近似」）。
 *
 * - `after`：取排在游标**之后**的行（下一页）；`before`：取排在游标**之前**的行（上一页，SQL 反向取、调用方再翻转）。
 * - 多取一行作探测行，调用方据此判断是否还有下一页。
 */
export function commissionDetailPageSql(
  session: AuthSession,
  scope: DataCenterScope,
  filters: CommissionLineFilters,
  page: { limit: number; after?: CommissionDetailKey | null; before?: CommissionDetailKey | null },
): SQL {
  const seek = page.after
    ? sql`WHERE (biz_date < ${page.after.d}::date
            OR (biz_date = ${page.after.d}::date AND source > ${page.after.t})
            OR (biz_date = ${page.after.d}::date AND source = ${page.after.t} AND source_id < ${page.after.id}))`
    : page.before
      ? sql`WHERE (biz_date > ${page.before.d}::date
            OR (biz_date = ${page.before.d}::date AND source < ${page.before.t})
            OR (biz_date = ${page.before.d}::date AND source = ${page.before.t} AND source_id > ${page.before.id}))`
      : sql``
  const order = page.before && !page.after
    ? sql`ORDER BY biz_date ASC, source DESC, source_id ASC`
    : sql`ORDER BY biz_date DESC, source ASC, source_id DESC`
  return sql`
    WITH ${detailRowsCteSql(session, scope, filters)}
    SELECT source, source_id, biz_date::text AS biz_date, store_id, store_name, employee_id, employee_name,
           position_name, order_id, payment_id, customer_name, order_kind, product_name, category_l1, category_l2,
           received, consume_amount, allocated, rate, commission
    FROM detail_rows
    ${seek}
    ${order}
    LIMIT ${page.limit + 1}
  `
}

/**
 * 明细汇总（按全量筛选，不随翻页变化）：条数、各项合计、去重单数。
 * 平均提成点 = Σ提成 ÷ Σ分配金额（含负数行与 0 费率行），由调用方计算。
 * 直接对取数链聚合，不经展示字段的 LEFT JOIN。
 */
export function commissionDetailSummarySql(
  session: AuthSession,
  scope: DataCenterScope,
  filters: CommissionLineFilters,
): SQL {
  const sale = sql`
      SELECT 'sale'::text AS source, 'S:' || so.sale_order_id AS order_key,
             spir.amount::numeric AS received,
             spia.allocated_amount::numeric AS allocated,
             COALESCE(spia.commission_amount::numeric, 0) AS commission
      ${SALE_FROM}
      ${saleWhere(session, scope, filters)}`
  const service = sql`
      SELECT 'service'::text AS source, 'V:' || so.service_order_id AS order_key,
             0::numeric AS received,
             ROUND(ROUND(sit.unit_real_price::numeric * sit.session_used, 2) * sc.allocation_ratio::numeric, 2) AS allocated,
             sc.commission_amount::numeric AS commission
      ${SERVICE_FROM}
      ${serviceWhere(session, scope, filters)}`
  return sql`
    WITH summary_rows AS (${sql.join(sourceParts(filters.source, sale, service), sql` UNION ALL `)})
    SELECT COUNT(*)::int AS count,
           COUNT(DISTINCT order_key)::int AS orders,
           COALESCE(SUM(received), 0) AS received,
           COALESCE(SUM(allocated), 0) AS allocated,
           COALESCE(SUM(commission), 0) AS commission,
           COALESCE(SUM(commission) FILTER (WHERE source = 'sale'), 0) AS sale,
           COALESCE(SUM(commission) FILTER (WHERE source = 'service'), 0) AS service
    FROM summary_rows
  `
}
