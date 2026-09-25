/**
 * 顾客剩余卡项清单（#371）取数 SQL。当前快照、不设期间；按卡的权益门店（sale_items.store_id）归属 scope。
 *
 * 一条语句产出全部行（同一快照）：有卡顾客按（顾客，卡权益门店）聚合出各二级品项的格；
 * 全局没有任何计入卡行的顾客按绑定门店出一行。格态 / 指标 / 搜索 / 排序在 `remaining-cards.ts`。
 *
 * 卡行口径：
 *   - 基础集与「已退完」守卫取自 lib/card-entitlement.ts（与 /cards 卡包、持卡折抵同源）
 *   - 寄存单只计「已支付」（待审批 / 已作废不计）；WorkFine 历史单（legacy_source 非空）不计
 *   - 过期按上海日界（参数 today，不依赖会话时区 #291）
 *   - 剩余 = 已付未用（paidUnusedSessionsExpr）；不加 >0 过滤（#290/#288），0 值格照样判态
 */
import { and, sql } from 'drizzle-orm'
import { db } from '@/db'
import { cardBaseConditions, cardNotFullyRefundedCondition } from '@/lib/card-entitlement'
import { paidUnusedSessionsExpr } from '@/lib/paid-sessions'
import type { AuthSession } from '@/lib/types'
import type { RemainingCardsCategory, RemainingCardsSqlRow, RemainingCellAggregate } from './remaining-cards'
import { scopeFilterSql } from './scope-sql'
import type { DataCenterScope } from './types'

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** json_build_array 的列顺序，与下方 SQL 一致 */
function toCell(raw: unknown): RemainingCellAggregate {
  const [categoryId, remaining, unpaid, activeRows, expiredRows, served, convertedOut, deposit, frozen] = raw as unknown[]
  return {
    categoryId: categoryId == null ? null : String(categoryId),
    remaining: num(remaining),
    unpaid: num(unpaid),
    activeRows: num(activeRows),
    expiredRows: num(expiredRows),
    served: num(served),
    convertedOut: num(convertedOut),
    deposit: deposit === true,
    frozen: frozen === true,
  }
}

type Executor = Pick<typeof db, 'execute'>

export interface RemainingCardsSnapshot {
  rows: RemainingCardsSqlRow[]
  categories: RemainingCardsCategory[]
}

/**
 * 取一次快照：REPEATABLE READ 只读事务内依次查行与品项字典（两条语句共用事务快照；
 * 默认 READ COMMITTED 下每条语句各取快照，字典与行可能错开）。只读 RR 事务不会有序列化失败。
 *
 * 规划器设置（仅本事务 SET LOCAL，不影响连接池里的其它查询）——prod 2026-09-25 实测全国范围：
 *   - 默认：3.3s，其中 JIT 编译 1.2s（「已退完」守卫的 hashed SubPlan 把代价估到 800 万，触发 JIT）；
 *     卡行 CTE 被低估成 3.4 万行，选了嵌套循环，对 sale_orders / product_skus 各探 11.7 万次
 *   - jit=off + enable_nestloop=off：0.62s（全部改走 hash join）
 * 不改写成别名表是因为卡行条件引用的是与 /cards 共用的 drizzle 列（lib/card-entitlement.ts）。
 *
 * 每次翻页 / 搜索都重算整张快照（筛选在内存里做）；statement_timeout 给单条语句一个硬上限，
 * 计划劣化时也不会长时间占住连接池（max 5）。
 */
export async function loadRemainingCardsSnapshot(
  session: AuthSession,
  scope: DataCenterScope,
  today: string,
): Promise<RemainingCardsSnapshot> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '20s'`)
    await tx.execute(sql`SET LOCAL jit = off`)
    await tx.execute(sql`SET LOCAL enable_nestloop = off`)
    const rows = await queryRemainingCardsRows(tx, session, scope, today)
    const categories = await queryRemainingCardsCategories(tx)
    return { rows, categories }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function queryRemainingCardsRows(
  executor: Executor,
  session: AuthSession,
  scope: DataCenterScope,
  today: string,
): Promise<RemainingCardsSqlRow[]> {
  const rows = await executor.execute(sql`
    WITH card AS MATERIALIZED (
      SELECT sale_items.sale_item_id,
             sale_orders.client_user_id,
             sale_items.store_id,
             ps.category_id,
             sale_items.remaining_sessions,
             ${paidUnusedSessionsExpr.sql} AS paid_unused,
             (sale_items.expire_date IS NOT NULL AND sale_items.expire_date < ${today}::date) AS expired,
             (sale_orders.sale_order_type = '寄存单') AS deposit,
             EXISTS (
               SELECT 1 FROM sale_order_payments frozen_sop
               WHERE frozen_sop.sale_order_id = sale_items.sale_order_id
                 AND frozen_sop.change_type = '退款' AND frozen_sop.status = '待审批'
             ) AS frozen
      FROM sale_items
      JOIN sale_orders ON sale_orders.sale_order_id = sale_items.sale_order_id
      LEFT JOIN product_skus ps ON ps.sku_id = sale_items.sku_id
      WHERE ${and(...cardBaseConditions(), cardNotFullyRefundedCondition())}
        AND (sale_orders.sale_order_type <> '寄存单' OR sale_orders.status = '已支付')
        AND sale_orders.legacy_source IS NULL
        AND sale_orders.client_user_id IS NOT NULL
    ),
    scoped AS MATERIALIZED (
      SELECT * FROM card WHERE ${scopeFilterSql(session, scope, 'card.store_id')}
    ),
    -- 已服务 / 转出次数按全表聚合后再 LEFT JOIN：两张表都只有几万行，
    -- 用 IN (scoped) 预过滤反而逼出 11 万次索引探测（prod 实测多 350ms）
    served AS (
      SELECT sit.sale_item_id, SUM(sit.session_used) AS served
      FROM service_items sit
      JOIN service_orders svo ON svo.service_order_id = sit.service_order_id
      WHERE svo.status = '已完成'
      GROUP BY sit.sale_item_id
    ),
    converted AS (
      SELECT out_item.ref_sale_item_id AS sale_item_id, SUM(out_item.quantity) AS converted_out
      FROM sale_items out_item
      JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
      WHERE out_item.item_direction = '转出'
        AND conv_order.status <> '已关闭'
      GROUP BY out_item.ref_sale_item_id
    ),
    cells AS (
      SELECT s.client_user_id, s.store_id, s.category_id,
             COALESCE(SUM(s.paid_unused) FILTER (WHERE NOT s.expired), 0) AS remaining,
             COALESCE(SUM(GREATEST(s.remaining_sessions - s.paid_unused, 0)) FILTER (WHERE NOT s.expired), 0) AS unpaid,
             COUNT(*) FILTER (WHERE NOT s.expired) AS active_rows,
             COUNT(*) FILTER (WHERE s.expired) AS expired_rows,
             -- 悬停说明只描述参与判态的未过期卡行（只剩过期卡的格显示「已过期」，不用这三项）
             COALESCE(SUM(sv.served) FILTER (WHERE NOT s.expired), 0) AS served,
             COALESCE(SUM(cv.converted_out) FILTER (WHERE NOT s.expired), 0) AS converted_out,
             COALESCE(BOOL_OR(s.deposit) FILTER (WHERE NOT s.expired), FALSE) AS deposit,
             COALESCE(BOOL_OR(s.frozen) FILTER (WHERE NOT s.expired), FALSE) AS frozen
      FROM scoped s
      LEFT JOIN served sv ON sv.sale_item_id = s.sale_item_id
      LEFT JOIN converted cv ON cv.sale_item_id = s.sale_item_id
      GROUP BY s.client_user_id, s.store_id, s.category_id
    ),
    card_rows AS (
      SELECT client_user_id, store_id,
             json_agg(json_build_array(category_id, remaining, unpaid, active_rows, expired_rows, served, converted_out, deposit, frozen)) AS cells
      FROM cells
      GROUP BY client_user_id, store_id
    ),
    no_card_rows AS (
      SELECT c.user_id AS client_user_id, c.bound_store_id AS store_id, NULL::json AS cells
      FROM client_wechat_users c
      WHERE c.bound_store_id IS NOT NULL
        AND ${scopeFilterSql(session, scope, 'c.bound_store_id')}
        AND NOT EXISTS (SELECT 1 FROM card WHERE card.client_user_id = c.user_id)
    )
    SELECT r.client_user_id, r.store_id, r.cells,
           u.name AS customer_name, u.phone,
           u.member_level::text AS member_level, u.customer_type::text AS customer_type,
           st.store_name
    FROM (SELECT * FROM card_rows UNION ALL SELECT * FROM no_card_rows) r
    JOIN client_wechat_users u ON u.user_id = r.client_user_id
    JOIN stores st ON st.store_id = r.store_id
  `)

  return (rows as unknown as Record<string, unknown>[]).map((row) => {
    const cells = parseJson(row.cells)
    return {
      clientUserId: String(row.client_user_id),
      storeId: String(row.store_id),
      storeName: String(row.store_name ?? ''),
      customerName: row.customer_name == null ? null : String(row.customer_name),
      phone: row.phone == null ? null : String(row.phone),
      memberLevel: row.member_level == null ? null : String(row.member_level),
      customerType: row.customer_type == null ? null : String(row.customer_type),
      cells: Array.isArray(cells) ? cells.map(toCell) : [],
    }
  })
}

/**
 * 二级品项字典 + 一级排序权重（与日常数据一览表视角③共用 product_categories）。
 * 一级行 = product_kind 为空、category_name 即一级名的行；停用的分类也返回（历史卡仍挂在上面）。
 */
async function queryRemainingCardsCategories(executor: Executor): Promise<RemainingCardsCategory[]> {
  const rows = await executor.execute(sql`
    -- 一级名没有唯一约束：同名一级行有多条时取最小排序权重，保证每个二级只出一行、同一级排序一致
    SELECT c.category_id, c.category_name, c.product_kind, c.sort_order,
           MIN(kind_row.sort_order) AS kind_sort
    FROM product_categories c
    LEFT JOIN product_categories kind_row
      ON kind_row.product_kind IS NULL AND kind_row.category_name = c.product_kind
    WHERE c.product_kind IS NOT NULL
    GROUP BY c.category_id, c.category_name, c.product_kind, c.sort_order
  `)
  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    categoryId: String(row.category_id),
    categoryName: String(row.category_name),
    kind: String(row.product_kind),
    // 找不到一级行的分组排在已知一级之后
    kindSort: row.kind_sort == null ? Number.MAX_SAFE_INTEGER - 1 : num(row.kind_sort),
    sort: num(row.sort_order),
  }))
}
