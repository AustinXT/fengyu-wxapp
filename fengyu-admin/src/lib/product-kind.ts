/**
 * 卡类一级品项的 SSoT：`product_categories WHERE productKind IS NULL AND isCardKind=true`。
 *
 * 历史背景：本文件曾经是"硬编码三处常量"的 admin 端。2026-04-25 ticket
 * "product-categories-fully-dynamic" 把 `is_card_kind` 列加到 DB 后，
 * SSoT 已迁移至 DB；本常量保留作为：
 *   - admin 端编译期 fallback（避免顶级模块加载时拉 DB）
 *   - 测试 fixture 默认值
 *   - 同步脚本 `db/scripts/sync-workfine.js` 的兜底
 *
 * 运行时（actions / 路由）请用 `getCardKindNamesFromDb()` 走 DB 查询。
 *
 * @deprecated 不要在新代码里直接引用此常量。新代码应调用 actions/products.ts 的
 *             `getCardKindNamesFromDb()` 或读 `product_categories.is_card_kind` 列。
 */
export const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const

export type CardProductKind = (typeof CARD_PRODUCT_KINDS)[number]
