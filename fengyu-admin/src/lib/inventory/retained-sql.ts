import { sql, type SQL } from 'drizzle-orm'

/**
 * 已取消采购订单上、原始市场报货行仍保留的「已采购」量（#335）。
 *
 * 市场行可以部分入库后关单：已入库的部分仍占着原始市场报货行的额度（也可能已经发了货），
 * 未入库的部分释放。原始报货行与采购行之间只有 `市场报货采购订单` 血缘、不记 fulfilled，
 * 所以保留量要按「采购行已入库量 × 该血缘在采购行里的占比」现算。
 *
 * 必须在**分**上按最大余数法分配，与 business.ts `allocateRetainedQuantity` 同一算法：
 * 先按比例向下取整，余下的分按小数部分降序（同值按来源明细 id 升序）每行补 1 分。
 * 直接按浮点比例算的话，三来源各 1 件、入库 1 件时每行保留 0.3333，再下单剩余 2 件
 * 会按 0.67 × 3 落库，合计 2.01 超出采购量（#335 评审 codex P2）。
 * 由「Σ 小数部分 = 余数（整数）且每个小数部分 < 1」可知补分的行都是有小数部分的行，
 * 补 1 分后仍不超过自身血缘量，无需额外封顶。
 *
 * 建单容量（allocateSummaryToMarketReportItems）与报货履约进度（engine）共用本片段，保证同源。
 *
 * 同一原始报货行可以分批汇总进两张汇总单、再在同一采购行里合并，于是同一对
 * (原始行, 采购行) 会有多条血缘 —— 先按这对端点聚合再分配，否则调用方按端点连接会重复累计
 * （#335 评审 codex round-2 P2）。
 *
 * 返回列：report_item_id / purchase_item_id / retained_quantity（numeric，两位小数），
 * 每对 (report_item_id, purchase_item_id) 恰好一行。
 * `reportItemIds` 是一个产出原始报货明细 id 的子查询，用来把计算范围收窄到相关采购行。
 */
export function cancelledMarketReportRetainedSql(reportItemIds: SQL): SQL {
  return sql`
    SELECT
      retained_ranked.from_item_id AS report_item_id,
      retained_ranked.to_item_id AS purchase_item_id,
      (retained_ranked.floor_cents
        + CASE WHEN retained_ranked.fraction_rank <= retained_ranked.remainder_cents THEN 1 ELSE 0 END
      ) / 100.0 AS retained_quantity
      FROM (
        SELECT
          retained_floor.from_item_id,
          retained_floor.to_item_id,
          retained_floor.floor_cents,
          retained_floor.received_cents
            - SUM(retained_floor.floor_cents) OVER (PARTITION BY retained_floor.to_item_id) AS remainder_cents,
          ROW_NUMBER() OVER (
            PARTITION BY retained_floor.to_item_id
            ORDER BY retained_floor.exact_cents - retained_floor.floor_cents DESC, retained_floor.from_item_id
          ) AS fraction_rank
          FROM (
            SELECT
              retained_share.from_item_id,
              retained_share.to_item_id,
              retained_share.received_cents,
              retained_share.exact_cents,
              FLOOR(retained_share.exact_cents) AS floor_cents
              FROM (
                SELECT
                  retained_pair.from_item_id,
                  retained_pair.to_item_id,
                  LEAST(
                    retained_pair.received_cents,
                    SUM(retained_pair.link_cents) OVER (PARTITION BY retained_pair.to_item_id)
                  ) AS received_cents,
                  retained_pair.link_cents
                    * LEAST(
                      retained_pair.received_cents,
                      SUM(retained_pair.link_cents) OVER (PARTITION BY retained_pair.to_item_id)
                    )
                    / NULLIF(SUM(retained_pair.link_cents) OVER (PARTITION BY retained_pair.to_item_id), 0)
                    AS exact_cents
                  FROM (
                    SELECT
                      retained_link.from_item_id,
                      retained_link.to_item_id,
                      SUM(ROUND(COALESCE(retained_link.quantity, 0) * 100)) AS link_cents,
                      MAX(ROUND(COALESCE(retained_purchase_item.fulfilled_quantity, 0) * 100)) AS received_cents
                      FROM inventory_doc_links retained_link
                      JOIN inventory_docs retained_purchase_doc
                        ON retained_purchase_doc.id = retained_link.to_doc_id
                       AND retained_purchase_doc.status = '已取消'
                      JOIN inventory_doc_items retained_purchase_item
                        ON retained_purchase_item.id = retained_link.to_item_id
                     WHERE retained_link.relation_type = '市场报货采购订单'
                       AND retained_link.to_item_id IN (
                         SELECT scope_link.to_item_id
                           FROM inventory_doc_links scope_link
                          WHERE scope_link.relation_type = '市场报货采购订单'
                            AND scope_link.from_item_id IN (${reportItemIds})
                       )
                     GROUP BY retained_link.from_item_id, retained_link.to_item_id
                  ) retained_pair
              ) retained_share
          ) retained_floor
      ) retained_ranked
  `
}
