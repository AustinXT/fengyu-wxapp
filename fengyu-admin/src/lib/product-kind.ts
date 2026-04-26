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
 * 2026-04-26 capability 列方案补充：
 *   - 充值卡判定改用 `product_skus.is_recharge_card` capability 列
 *     （helper：`@/lib/recharge` `isRechargeCardSku(sku)`）
 *   - 体验卡判定改用 `product_skus.is_experience` capability 列
 *   - 本常量 `CARD_PRODUCT_KINDS` 仅供分类标签 / fallback / 测试 fixture，
 *     新代码业务判定不要再用本常量。
 *
 * @deprecated 不要在新代码里直接引用此常量做业务判定。
 *             - SKU 维度判定 → 用 `isRechargeCardSku(sku)` / `sku.isExperience`
 *             - 分类维度查询 → 调 `getCardKindNamesFromDb()` 或读 `product_categories.is_card_kind` 列
 */
export const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const

export type CardProductKind = (typeof CARD_PRODUCT_KINDS)[number]
