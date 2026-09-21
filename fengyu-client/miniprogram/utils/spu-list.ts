// utils/spu-list.ts —— 商品列表行的展示态装配（home / shop 共用）

import { withInitialCoverVisible } from './cover-window';

/**
 * 会员价分流：会员看会员起价（`priceFrom`）+ 划线标价起价；非会员只看标价起价（`listPriceFrom`）。
 * 与云函数 `order.create` 的权威定价同口径，避免列表预览与实收不一致。
 *
 * 抽出来的原因有两个：
 * 1. home 有 3 处（shopInit / spuList / search）、shop 有 2 处在重复同一段表达式，
 *    issue #248 又要给每处叠加分页的 `startIndex`，重复面进一步放大。
 * 2. `member-pricing-cross-end.test.ts` 只守护两份**云函数**副本字节一致，
 *    完全不覆盖页面层的 `min_price` / `strike_min_price` 装配 —— 这里补上测试入口。
 */
export interface DecoratedSpuRow {
  min_price: string;
  strike_min_price: string;
  coverVisible: boolean;
  [key: string]: any;
}

/**
 * @param rows       云函数下发的原始行
 * @param isMember   会员态（展示层用，结算以云函数为准）
 * @param startIndex 这批行在整个列表中的起始下标：首屏 0，触底追加传当前列表长度
 */
export function decorateSpuRows(
  rows: any[],
  isMember: boolean,
  startIndex = 0
): DecoratedSpuRow[] {
  return withInitialCoverVisible(
    rows.map((spu: any) => ({
      ...spu,
      min_price: isMember ? (spu.priceFrom || '0') : (spu.listPriceFrom || spu.priceFrom || '0'),
      strike_min_price:
        isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom) ? spu.listPriceFrom : '',
    })),
    startIndex
  ) as DecoratedSpuRow[];
}

/**
 * 翻页追加去重。
 *
 * `sort_order` 是 admin 可改的字段：翻页期间被改动时，keyset 可能把同一个 product_id
 * 再发一次。列表 `wx:key="product_id"` 遇到重复 key 会告警并可能串位渲染，
 * 所以在追加侧按主键兜一道。
 */
export function appendUniqueSpuRows<T extends { product_id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((r) => r.product_id));
  return prev.concat(next.filter((r) => !seen.has(r.product_id)));
}
