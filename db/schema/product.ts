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

/**
 * 品项分类
 *
 * category_name 不设唯一约束，允许不同 product_kind 下同名分类。
 * sales_category 确定该品项的销售分类，进而决定提成比例。
 *
 * 一级行（productKind IS NULL）的 capability 列：
 * - displayColor：商品 tag 视觉渲染依据，前端不再硬编码字面量分支。
 *
 * 二级行（productKind 非 NULL）：上述 capability 列 NULL，运行时按需读取父级行。
 *
 * "体验卡"识别由 SKU 级 capability isExperience 标记；
 * 充值卡已退出 SKU/商品域，由 sale_orders.sale_order_type='充值单' 表达（2026-05-19）。
 */
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

/**
 * 商品管理 — SKU（独立实体）
 *
 * SKU 是商品管理的原子单元，直接绑定品项分类。
 * spec_name 包含完整名称+规格信息（如"蜜语水润嫩肤护理 10次卡"）。
 * 价格、次数、服务费直接存在 SKU 表中，运行时无外部查询。
 */
export const productSkus = pgTable(
  "product_skus",
  {
    skuId: text("sku_id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => productCategories.categoryId),
    productType: productTypeEnum("product_type").notNull(),
    /** 完整名称+规格（如"蜜语水润嫩肤护理 10次卡"） */
    specName: text("spec_name").notNull(),
    /** 标价/零售价（开单时快照到 sale_items.unit_price） */
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric("special_price", { precision: 10, scale: 2 }),
    /** 疗程次数：疗程卡≥1（含原单次=1），家居产品=null */
    sessionCount: integer("session_count"),
    sortOrder: integer("sort_order").notNull().default(0),
    serviceFee: numeric("service_fee", { precision: 10, scale: 2 }).notNull().default("0"),
    /** 是否生美（护理项目使用，其他为 null） */
    isShengmei: boolean("is_shengmei"),
    /**
     * 是否体验卡（capability 列）。
     * 取代 product_categories.product_kind='体验卡' 字面量判定，物理隔离体验卡 SKU 与商城商品。
     * client 体验卡入口仅展示 is_experience=true；商城/staff 开单默认排除 is_experience=true。
     * 行级语义在 sale_items.is_experience 快照保留，开单时拷贝，与价格快照同模式。
     */
    isExperience: boolean("is_experience").notNull().default(false),
    /**
     * 是否「店长特别优惠」（capability 列）。
     * true 时 admin / staff 开单（仅销售单 + 普通商品，组合套餐不适用）允许店长手动修改
     * 该明细行的应付金额（最小 0，最大不超过标价）。行级语义在 sale_items.is_manager_special
     * 快照保留，开单时拷贝（权威来源为 DB，不信前端）。
     */
    isManagerSpecial: boolean("is_manager_special").notNull().default(false),
    /** 项目系列（lookup 表外键，NULL=未设置） */
    projectSeriesId: bigint("project_series_id", { mode: "number" }).references(
      () => projectSeriesLookup.id,
    ),
    /** 可见范围（null=全部可见） */
    marketScope: text("market_scope"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
    /** 软删时间戳；NULL=未删。仅"误创建/下架超出 valid_end 范围"等清理场景使用 */
    deletedAt: timestamp("deleted_at"),
    /** 软删操作人（staff_wechat_users.employee_id 字符串快照） */
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

/**
 * 商城管理 — 商品分类
 *
 * 自定义展示分类，不含 product_kind，完全自由。
 */
export const mallCategories = pgTable("mall_categories", {
  categoryId: text("category_id").primaryKey(),
  categoryName: text("category_name").notNull(),
  /** 分组名称（NULL=一级分组/Tab，非 NULL=二级分类，值为一级分组的 categoryName） */
  categoryGroup: text("category_group"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`NOW()`),
});

/**
 * 商城管理 — 商城商品
 *
 * 原 products 表改造。category_id 指向 mall_categories（商品分类）。
 * 展示属性（封面图、详情图、描述）和管理范围在此层。
 * is_bundle=true 时为套餐，分组选择逻辑由 mall_bundle_groups 管理。
 */
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
    /** 展示价/套餐总价 */
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    specialPrice: numeric("special_price", { precision: 10, scale: 2 }),
    /** 管理范围（null=总部管理） */
    manageScope: text("manage_scope"),
    /** 可见范围（null=全部可见） */
    marketScope: text("market_scope"),
    sortOrder: integer("sort_order").notNull().default(0),
    isVisible: boolean("is_visible").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
    /** 软删时间戳；NULL=未删。商城列表/前端展示一律按 deleted_at IS NULL 过滤 */
    deletedAt: timestamp("deleted_at"),
    /** 软删操作人（staff_wechat_users.employee_id 字符串快照） */
    deletedBy: text("deleted_by"),
  },
  (table) => [
    index("idx_products_active")
      .on(table.productId)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * 商城管理 — 套餐分组
 *
 * 每个套餐商品可以有多个分组，每个分组有独立的 pick_count。
 * 例如"护理服务组 5选2 + 家居产品组 3选1"。
 */
export const mallBundleGroups = pgTable(
  "mall_bundle_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.productId),
    groupName: text("group_name").notNull(),
    /** N选M 的 M（null=全选，计入数量=组内 SKU 数） */
    pickCount: integer("pick_count"),
    /**
     * 组「标价单价」（划线价）。组内所有子项共享，下沉到 mall_product_skus.bundle_list_price。
     * DB 可空（migration 只加列不回填），应用层 createBundleGroup/updateBundleGroup 强制必填 > 0。
     */
    unitListPrice: numeric("unit_list_price", { precision: 10, scale: 2 }),
    /** 组「会员价单价」（成交价）。null = 该组不打折，按标价单价成交。须 ≤ unit_list_price。 */
    unitMemberPrice: numeric("unit_member_price", { precision: 10, scale: 2 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_bundle_group").on(table.productId, table.groupName),
    // 成交价 ≤ 标价（任一为 null 放行）：sale_items.unit_real_price ≤ unit_price 不变量的源头守护
    check(
      "chk_bundle_group_member_le_list",
      sql`${table.unitMemberPrice} IS NULL OR ${table.unitListPrice} IS NULL OR ${table.unitMemberPrice} <= ${table.unitListPrice}`,
    ),
    check("chk_bundle_group_list_nonneg", sql`${table.unitListPrice} IS NULL OR ${table.unitListPrice} >= 0`),
    check("chk_bundle_group_member_nonneg", sql`${table.unitMemberPrice} IS NULL OR ${table.unitMemberPrice} >= 0`),
  ],
);

/**
 * 商城管理 — 商城商品与SKU关联
 *
 * 多对多关联。bundle_price 用于套餐内优惠价。
 * bundle_group_id 关联套餐分组（非套餐为 null）。
 */
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
    /** 套餐分组（非套餐为 null；套餐子项强制非空，所有子项必须归入分组） */
    bundleGroupId: bigint("bundle_group_id", { mode: "number" }).references(() => mallBundleGroups.id),
    /**
     * 成交价副本 = coalesce(所属组 unit_member_price, unit_list_price)，落 sale_items.unit_real_price。
     * 由 syncBundleGroupSkuPrices 从组级单价下沉；派生缓存，权威源为 mall_bundle_groups。
     */
    bundlePrice: numeric("bundle_price", { precision: 10, scale: 2 }),
    /** 标价单价副本 = 所属组 unit_list_price，落 sale_items.unit_price（划线）。同为下沉派生缓存。 */
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
