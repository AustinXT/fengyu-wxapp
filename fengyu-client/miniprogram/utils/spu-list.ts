// utils/spu-list.ts —— 商品列表行的展示态装配（home / shop 共用）

import { withInitialCoverVisible } from './cover-window';

/**
 * 商品列表每页条数（home / shop 共用一份）。
 *
 * 权威值在云函数 `clientApi/routes/product.js` 的 `PRODUCT_PAGE_SIZE_DEFAULT` / `_MAX`，
 * 后端一律夹取，所以这里只是个 hint —— 但没有理由在两个页面各写一遍字面量。
 */
export const SPU_PAGE_SIZE = 20;

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

export interface DecorateSpuOptions {
  /** 这批行在整个列表中的起始下标：首屏 0，触底追加传当前列表长度 */
  startIndex?: number;
  /**
   * 丢掉 `skuList` 再进 setData。
   *
   * setData 是跨线程序列化，每行的 `skuList` 是 1~5 个 SKU × 14 个字段 ≈ 1~2KB；
   * 一页 20 行就是 20~40KB 白烧。home 两个列表都只跳详情页、从不读 SKU，
   * shop 的「加入购物车」要读（`spu.skuList[0]`），所以按页面选。
   */
  dropSkuList?: boolean;
}

/**
 * @param rows     云函数下发的原始行
 * @param isMember 会员态（展示层用，结算以云函数为准）
 */
export function decorateSpuRows(
  rows: any[],
  isMember: boolean,
  options: DecorateSpuOptions = {}
): DecoratedSpuRow[] {
  const { startIndex = 0, dropSkuList = false } = options;
  return withInitialCoverVisible(
    rows.map((spu: any) => {
      const { skuList, ...rest } = spu;
      return {
        ...(dropSkuList ? rest : spu),
        min_price: isMember ? (spu.priceFrom || '0') : (spu.listPriceFrom || spu.priceFrom || '0'),
        strike_min_price:
          isMember && Number(spu.listPriceFrom) > Number(spu.priceFrom) ? spu.listPriceFrom : '',
      };
    }),
    startIndex
  ) as DecoratedSpuRow[];
}

/**
 * 翻页追加去重。
 *
 * `sort_order` 是 admin 可改的字段：翻页期间被改动时，keyset 可能把同一个 product_id
 * 再发一次。列表 `wx:key="product_id"` 遇到重复 key 会告警并可能串位渲染，
 * 所以在追加侧按主键兜一道。
 *
 * ⚠️ 这只挡住重复，挡不住**对称的漏行**：翻页期间被调大 `sort_order` 的行会越过游标、
 * 在本次浏览里永不出现。无快照分页在可变排序键下本就不是一致读，不加索引/迁移时
 * 消除不了；对浏览场景可接受（下拉刷新即可重来），对账场景绝不可套用。
 */
export function appendUniqueSpuRows<T extends { product_id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((r) => r.product_id));
  return prev.concat(next.filter((r) => !seen.has(r.product_id)));
}

/**
 * 把「追加了哪些行」翻译成 setData 的下标路径补丁。
 *
 * 直接 `setData({ spuList: merged })` 每翻一页都要重发整列 —— 翻到第 5 页发 100 行，
 * 5 页累计 300 行次，是 O(N²) 的跨线程序列化。按下标只发新增的那些行，
 * 单次 payload 恒定在一页。
 *
 * 下标必须紧接在 `fromIndex` 之后连续，否则会在数组里留空洞；
 * 调用方传的是「追加去重后」的结果，所以长度只可能等于或小于预期，不会跳号。
 */
export function buildAppendPatch<T>(
  listKey: string,
  fromIndex: number,
  merged: T[]
): Record<string, T> {
  const patch: Record<string, T> = {};
  for (let i = fromIndex; i < merged.length; i++) {
    patch[`${listKey}[${i}]`] = merged[i];
  }
  return patch;
}
