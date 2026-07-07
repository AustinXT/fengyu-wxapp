import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productTypeEnum, salesCategoryEnum } from "./enums";
import { projectSeriesLookup } from "./lookup";


export const productCategories = pgTable("product_categories", {
  categoryId: text("category_id").primaryKey(),
  categoryName: text("category_name").notNull(),
  productKind: text("product_kind"),
  salesCategory: salesCategoryEnum("sales_category"),
  sortOrder: integer("sort_order").notNull().default(0),
  isValid: boolean("is_valid").notNull().default(true),
  displayColor: text("display_color"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`NOW()`),
});


export const productSkus = pgTable(
  "product_skus",
  {
    skuId: text("sku_id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => productCategories.categoryId),
    productType: productTypeEnum("product_type").notNull(),
    
    specName: text("spec_name").notNull(),
    
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric("special_price", { precision: 10, scale: 2 }),
    
    sessionCount: integer("session_count"),
    sortOrder: integer("sort_order").notNull().default(0),
    serviceFee: numeric("service_fee", { precision: 10, scale: 2 }).notNull().default("0"),
    
    isShengmei: boolean("is_shengmei"),
    
    isExperience: boolean("is_experience").notNull().default(false),
    
    isManagerSpecial: boolean("is_manager_special").notNull().default(false),
    
    projectSeriesId: bigint("project_series_id", { mode: "number" }).references(
      () => projectSeriesLookup.id,
    ),
    
    marketScope: text("market_scope"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
    
    deletedAt: timestamp("deleted_at"),
    
    deletedBy: text("deleted_by"),
  },
  (table) => [
    index("idx_product_skus_category_id").on(table.categoryId),
    index("idx_product_skus_is_experience")
      .on(table.isExperience)
      .where(sql`${table.isExperience} = true`),
    index("idx_product_skus_active")
      .on(table.skuId)
      .where(sql`deleted_at IS NULL`),
    check("chk_sku_price", sql`${table.price} >= 0`),
    check("chk_sku_service_fee", sql`${table.serviceFee} >= 0`),
    check("chk_sku_session_count", sql`${table.sessionCount} IS NULL OR ${table.sessionCount} >= 1`),
  ],
);


export const mallCategories = pgTable("mall_categories", {
  categoryId: text("category_id").primaryKey(),
  categoryName: text("category_name").notNull(),
  
  categoryGroup: text("category_group"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`NOW()`),
});


export const products = pgTable(
  "products",
  {
    productId: text("product_id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => mallCategories.categoryId),
    name: text("name").notNull(),
    coverImage: text("cover_image"),
    detailImages: text("detail_images").array(),
    description: text("description"),
    isBundle: boolean("is_bundle").notNull().default(false),
    
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric("special_price", { precision: 10, scale: 2 }),
    
    manageScope: text("manage_scope"),
    
    marketScope: text("market_scope"),
    sortOrder: integer("sort_order").notNull().default(0),
    isVisible: boolean("is_visible").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
    
    deletedAt: timestamp("deleted_at"),
    
    deletedBy: text("deleted_by"),
  },
  (table) => [
    index("idx_products_active")
      .on(table.productId)
      .where(sql`deleted_at IS NULL`),
  ],
);


export const mallBundleGroups = pgTable(
  "mall_bundle_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.productId),
    groupName: text("group_name").notNull(),
    
    pickCount: integer("pick_count"),
    
    unitListPrice: numeric("unit_list_price", { precision: 10, scale: 2 }),
    
    unitMemberPrice: numeric("unit_member_price", { precision: 10, scale: 2 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_bundle_group").on(table.productId, table.groupName),
    
    check(
      "chk_bundle_group_member_le_list",
      sql`${table.unitMemberPrice} IS NULL OR ${table.unitListPrice} IS NULL OR ${table.unitMemberPrice} <= ${table.unitListPrice}`,
    ),
    check("chk_bundle_group_list_nonneg", sql`${table.unitListPrice} IS NULL OR ${table.unitListPrice} >= 0`),
    check("chk_bundle_group_member_nonneg", sql`${table.unitMemberPrice} IS NULL OR ${table.unitMemberPrice} >= 0`),
  ],
);


export const mallProductSkus = pgTable(
  "mall_product_skus",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.productId),
    skuId: text("sku_id")
      .notNull()
      .references(() => productSkus.skuId),
    
    bundleGroupId: bigint("bundle_group_id", { mode: "number" }).references(() => mallBundleGroups.id),
    
    bundlePrice: numeric("bundle_price", { precision: 10, scale: 2 }),
    
    bundleListPrice: numeric("bundle_list_price", { precision: 10, scale: 2 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_mall_product_skus_product_id").on(table.productId),
    uniqueIndex("uq_mall_product_sku").on(table.productId, table.skuId),
  ],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductSku = typeof productSkus.$inferSelect;
export type NewProductSku = typeof productSkus.$inferInsert;
export type MallCategory = typeof mallCategories.$inferSelect;
export type NewMallCategory = typeof mallCategories.$inferInsert;
export type MallBundleGroup = typeof mallBundleGroups.$inferSelect;
export type NewMallBundleGroup = typeof mallBundleGroups.$inferInsert;
export type MallProductSku = typeof mallProductSkus.$inferSelect;
export type NewMallProductSku = typeof mallProductSkus.$inferInsert;
