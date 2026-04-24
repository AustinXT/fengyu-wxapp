/**
 * 开单页"普通商品"目录的排除法常量。
 *
 * 含义：`product_kind NOT IN CARD_PRODUCT_KINDS` 的所有二级分类被视为"普通商品"。
 * 新增非卡 kind 时零代码变更；**新增"卡"类 product_kind 时必须同步更新以下三处**：
 *   - fengyu-admin/src/lib/product-kind.ts (本文件)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/product.js 顶部
 *   - fengyu-staff/miniprogram/pages/order-create/order-create.ts 顶部
 *
 * 折中记录见 ticket 2026-04-24-normal-products-category-exclude-filter.md §2.9。
 */
export const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const

export type CardProductKind = (typeof CARD_PRODUCT_KINDS)[number]
