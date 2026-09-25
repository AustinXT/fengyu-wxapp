/**
 * 日常数据一览表（#369）的 SQL 构造（不执行）。取数 action `actions/data-center/daily-overview.ts` 执行它们；
 * 抽出来是为了让验证脚本能在事务里对构造数据跑**同一份** SQL（见 PR 的「未分类兜底实测」）。
 *
 * ★ 口径红线（consistency.daily-overview.test.ts 整段等值守护）：
 *   - 业绩合计 = 销售板「总业绩」：款项过滤条件与 sales.ts runStoreRevenue **逐条相同**，
 *     只是把单据类型拆成「销售单 + 转换单」（按子项拆分）与「充值单」（单列）两段。
 *     不带「父订单已结清」（so.status）过滤——与 #300 同方向；staff 端销售数据页同名汇总带该过滤，口径不同。
 *   - 拆分：receipt.amount × 款项金额 ÷ 该款项全部 receipts 之和；分母为 0 / 无 receipts 的款项整笔进未分类。
 *     sale_items / product_skus 一律 LEFT JOIN，任何一环缺失都只是落进未分类，不会被 INNER JOIN 静默丢钱。
 *   - 服务合计 = 销售板「总实耗」：SQL 与 sales.ts 实耗逐条相同，只多按 sit.sales_category 分组。
 *   - 不加任何 >0 / HAVING 过滤（#290/#288）：负数（退款冲销）原样显示。
 *   - 日界：所有日期条件都是 date 列 BETWEEN 'YYYY-MM-DD'，不依赖会话时区（#291）。
 */
import { sql, type SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import { scopeFilterSql, scopeStoreSkeletonSql } from './scope-sql'
import { excludeDepositRefundSql } from './consume-filter'
import type { DataCenterScope, ResolvedRange } from './types'

/** 业绩合计（= 销售板总业绩，与 sales.ts runStoreRevenue 同一组过滤条件） */
export function performanceTotalSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange) {
  return sql`
    SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
    FROM sale_order_performance_events spe
    WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
      AND spe.status = '已支付'
      AND spe.change_type IN ('首次支付', '回款', '退款')
      AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
      AND spe.legacy_source IS DISTINCT FROM 'workfine'
      AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
  `
}

/** 服务合计（= 销售板总实耗） */
export function serviceTotalSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange) {
  return sql`
    SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
    FROM service_orders so
    JOIN service_items sit ON sit.service_order_id = so.service_order_id
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}
      AND ${excludeDepositRefundSql('so')}
  `
}

export interface DailyOverviewQueries {
  stores: SQL
  categories: SQL
  /** 销售单 + 转换单业绩：kind='total' 是逐店款项精确合计，kind='part' 是按子项拆分的片段 */
  performance: SQL
  recharge: SQL
  service: SQL
}

/** 本期取数的 5 条 SQL（结果形状见 action 的 loadInput） */
export function dailyOverviewQueries(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): DailyOverviewQueries {
  return {
    stores: scopeStoreSkeletonSql(session, scope),
    categories: sql`
      SELECT category_id, category_name, product_kind, sort_order, is_valid
      FROM product_categories
    `,
    // 销售单 + 转换单业绩：kind='total' 是逐店款项精确合计，kind='part' 是按子项拆分的片段
    performance: sql`
      WITH pay AS (
        SELECT spe.sale_payment_id, spe.store_id, spe.amount::numeric AS amount
        FROM sale_order_performance_events spe
        WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND spe.sale_order_type IN ('销售单', '转换单')
          AND spe.legacy_source IS DISTINCT FROM 'workfine'
          AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
      ),
      receipt AS (
        SELECT r.sale_payment_id, r.sale_item_id, r.amount::numeric AS amount,
               SUM(r.amount::numeric) OVER (PARTITION BY r.sale_payment_id) AS denominator
        FROM sale_payment_item_receipts r
        WHERE r.sale_payment_id IN (SELECT sale_payment_id FROM pay)
      )
      SELECT 'total' AS kind, pay.store_id, NULL::text AS sales_category, NULL::text AS category_id,
             SUM(pay.amount)::text AS amount
      FROM pay
      GROUP BY pay.store_id
      UNION ALL
      SELECT 'part' AS kind, pay.store_id, si.sales_category::text AS sales_category, sku.category_id,
             SUM(rc.amount * pay.amount / rc.denominator)::text AS amount
      FROM pay
      JOIN receipt rc ON rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0
      LEFT JOIN sale_items si ON si.sale_item_id = rc.sale_item_id
      LEFT JOIN product_skus sku ON sku.sku_id = si.sku_id
      GROUP BY pay.store_id, si.sales_category, sku.category_id
      UNION ALL
      SELECT 'part' AS kind, pay.store_id, NULL::text AS sales_category, NULL::text AS category_id,
             SUM(pay.amount)::text AS amount
      FROM pay
      WHERE NOT EXISTS (
        SELECT 1 FROM receipt rc WHERE rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0
      )
      GROUP BY pay.store_id
    `,
    // 充值单：没有商品明细，单列
    recharge: sql`
      SELECT spe.store_id, SUM(spe.amount::numeric)::text AS amount
      FROM sale_order_performance_events spe
      WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.sale_order_type = '充值单'
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
      GROUP BY spe.store_id
    `,
    // 服务（实耗）按经营类型
    service: sql`
      SELECT so.store_id, sit.sales_category::text AS sales_category,
             SUM(sit.unit_real_price::numeric * sit.session_used)::text AS amount
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${range.start} AND ${range.end}
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id, sit.sales_category
    `,
  }
}
