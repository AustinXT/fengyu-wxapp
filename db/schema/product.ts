import { bigserial, boolean, check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { productTypeEnum, salesCategoryEnum } from './enums'

/**
 * 品项分类
 *
 * category_name 不设唯一约束，允许不同 product_kind 下同名分类。
 * sales_category 确定该品项的销售分类，进而决定提成比例。
 */
export const productCategories = pgTable('product_categories', {
  categoryId: text('category_id').primaryKey(),
  categoryName: text('category_name').notNull(),
  productKind: text('product_kind'),
  salesCategory: salesCategoryEnum('sales_category'),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 商品管理 — SKU（独立实体）
 *
 * SKU 是商品管理的原子单元，直接绑定品项分类。
 * spec_name 包含完整名称+规格信息（如"蜜语水润嫩肤护理 10次卡"）。
 * 价格、次数、服务费直接存在 SKU 表中，运行时无外部查询。
 */
export const productSkus = pgTable(
  'product_skus',
  {
    skuId: text('sku_id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => productCategories.categoryId),
    productType: productTypeEnum('product_type').notNull(),
    /** 完整名称+规格（如"蜜语水润嫩肤护理 10次卡"） */
    specName: text('spec_name').notNull(),
    /** 标价/零售价（开单时快照到 sale_items.unit_price） */
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric('special_price', { precision: 10, scale: 2 }),
    /** 疗程次数：疗程卡≥2，单品=1，院装产品=null */
    sessionCount: integer('session_count'),
    sortOrder: integer('sort_order').notNull().default(0),
    serviceFee: numeric('service_fee', { precision: 10, scale: 2 }).notNull().default('0'),
    /** 是否生美（护理项目使用，其他为 null） */
    isShengmei: boolean('is_shengmei'),
    /** 可见范围（null=全部可见） */
    marketScope: text('market_scope'),
    validStart: date('valid_start'),
    validEnd: date('valid_end'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_product_skus_category_id').on(table.categoryId),
    check('chk_sku_price', sql`${table.price} >= 0`),
    check('chk_sku_service_fee', sql`${table.serviceFee} >= 0`),
    check('chk_sku_session_count', sql`${table.sessionCount} IS NULL OR ${table.sessionCount} >= 1`),
  ],
)

/**
 * 商城管理 — 商品分类
 *
 * 自定义展示分类，不含 product_kind，完全自由。
 */
export const mallCategories = pgTable('mall_categories', {
  categoryId: text('category_id').primaryKey(),
  categoryName: text('category_name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 商城管理 — 商城商品
 *
 * 原 products 表改造。category_id 指向 mall_categories（商品分类）。
 * 展示属性（封面图、详情图、描述）和管理范围在此层。
 * is_bundle=true 时为套餐，pick_count 指定 N选M 的 M。
 */
export const products = pgTable('products', {
  productId: text('product_id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .references(() => mallCategories.categoryId),
  name: text('name').notNull(),
  coverImage: text('cover_image'),
  detailImages: text('detail_images').array(),
  description: text('description'),
  isBundle: boolean('is_bundle').notNull().default(false),
  /** 套餐 N选M 的 M（null=全选） */
  pickCount: integer('pick_count'),
  /** 展示价/套餐总价 */
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  specialPrice: numeric('special_price', { precision: 10, scale: 2 }),
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
 * 商城管理 — 商城商品与SKU关联
 *
 * 多对多关联。bundle_price 用于套餐内优惠价。
 */
export const mallProductSkus = pgTable(
  'mall_product_skus',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.productId),
    skuId: text('sku_id')
      .notNull()
      .references(() => productSkus.skuId),
    /** 套餐内优惠价（非套餐为 null） */
    bundlePrice: numeric('bundle_price', { precision: 10, scale: 2 }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_mall_product_skus_product_id').on(table.productId),
    uniqueIndex('uq_mall_product_sku').on(table.productId, table.skuId),
  ],
)

export type ProductCategory = typeof productCategories.$inferSelect
export type NewProductCategory = typeof productCategories.$inferInsert
export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert
export type ProductSku = typeof productSkus.$inferSelect
export type NewProductSku = typeof productSkus.$inferInsert
export type MallCategory = typeof mallCategories.$inferSelect
export type NewMallCategory = typeof mallCategories.$inferInsert
export type MallProductSku = typeof mallProductSkus.$inferSelect
export type NewMallProductSku = typeof mallProductSkus.$inferInsert
