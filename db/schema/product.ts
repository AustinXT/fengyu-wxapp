import { boolean, check, date, index, integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { productKindEnum, productTypeEnum, salesCategoryEnum } from './enums'

/**
 * 品项分类
 *
 * category_name 不设唯一约束，允许不同 product_kind 下同名分类。
 */
export const productCategories = pgTable('product_categories', {
  categoryId: text('category_id').primaryKey(),
  categoryName: text('category_name').notNull(),
  productKind: productKindEnum('product_kind').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 商品主表
 *
 * valid_start + valid_end 替代 is_active，通过日期控制上下架。
 * is_bundle=true 时，其关联的 product_skus 记录是套餐组成部分。
 */
export const products = pgTable('products', {
  productId: text('product_id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .references(() => productCategories.categoryId),
  name: text('name').notNull(),
  coverImage: text('cover_image'),
  detailImages: text('detail_images').array(),
  description: text('description'),
  /** 是否生美（护理项目使用，其他为 null） */
  isShengmei: boolean('is_shengmei'),
  isBundle: boolean('is_bundle').notNull().default(false),
  /** 标价/原价（展示用，交易以 SKU 价格为准） */
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  specialPrice: numeric('special_price', { precision: 10, scale: 2 }),
  salesCategory: salesCategoryEnum('sales_category'),
  /** 管理范围（null=总部管理） */
  manageScope: text('manage_scope'),
  /** 可见范围（null=全部可见） */
  marketScope: text('market_scope'),
  sortOrder: integer('sort_order').notNull().default(0),
  validStart: date('valid_start'),
  validEnd: date('valid_end'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 商品规格
 *
 * 价格、次数、服务费直接存在 SKU 表中，运行时无外部查询。
 * 有效期与商品层叠加校验：商品有效 AND 规格有效才展示。
 */
export const productSkus = pgTable(
  'product_skus',
  {
    skuId: text('sku_id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.productId),
    productType: productTypeEnum('product_type').notNull(),
    specName: text('spec_name').notNull(),
    /** 标价/零售价（开单时快照到 sale_items.unit_price） */
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric('special_price', { precision: 10, scale: 2 }),
    /** 疗程次数：疗程卡≥2，单品=1，院装产品=null */
    sessionCount: integer('session_count'),
    isBundleSku: boolean('is_bundle_sku').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    serviceFee: numeric('service_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    validStart: date('valid_start'),
    validEnd: date('valid_end'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_product_skus_product_id').on(table.productId),
    check('chk_sku_price', sql`${table.price} >= 0`),
    check('chk_sku_service_fee', sql`${table.serviceFee} >= 0`),
    check('chk_sku_session_count', sql`${table.sessionCount} IS NULL OR ${table.sessionCount} >= 1`),
  ],
)

export type ProductCategory = typeof productCategories.$inferSelect
export type NewProductCategory = typeof productCategories.$inferInsert
export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert
export type ProductSku = typeof productSkus.$inferSelect
export type NewProductSku = typeof productSkus.$inferInsert
