import {
  bigserial,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productCategories, productSkus } from "./product";

/**
 * WorkFine 原品项 → 新品项分类（product_categories）/SKU 映射表
 *
 * 用于将历史 WorkFine 订单明细中的 `商品名称`（一年以上的旧品项，变体上千）
 * 归一到 new `product_categories.category_id`（或精确到 product_skus.sku_id）。
 *
 * 数据来源（source 字段）：
 *  - 'ai_inferred'：夜航星基于 AI 推断的初版（导入 admin 后供业务方核对）
 *  - 'business_confirmed'：张凯（业务方）回传的正式映射
 *  - 'manual_override'：admin 在页面上手动覆盖（最高优先级）
 *
 * 写入策略：UPSERT (legacy_product_name, legacy_product_code) 唯一约束。
 *
 * D13=A：允许 target_category_id / target_sku_id 同时 NULL，
 * 该行视为「待映射」可保留但不参与归一；admin 上传页只警告不拒绝。
 *
 * FK 行为：均为 ON DELETE SET NULL，避免 product_categories / product_skus 删除时
 * 把映射表行也连带删掉（mapping 行有审计价值，应保留）。
 */
export const legacyProductMapping = pgTable(
  "legacy_product_mapping",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** WorkFine 原品项名（dbo.商品信息表.商品名称 或 B_销售订单明细.商品名称） */
    legacyProductName: text("legacy_product_name").notNull(),
    /**
     * WorkFine 原品项编号（若有；可能为空字符串，按名称匹配兜底）。
     * 默认空串而非 NULL：避免 PG 唯一索引把多个 NULL 视为不冲突。
     */
    legacyProductCode: text("legacy_product_code").notNull().default(""),
    /** 映射到 new product_categories.category_id（二级分类，优先） */
    targetCategoryId: text("target_category_id").references(
      () => productCategories.categoryId,
      { onDelete: "set null" },
    ),
    /** 映射到 new product_skus.sku_id（如能精确到 SKU；可与 targetCategoryId 并存） */
    targetSkuId: text("target_sku_id").references(() => productSkus.skuId, {
      onDelete: "set null",
    }),
    /** 来源：'ai_inferred' | 'business_confirmed' | 'manual_override' */
    source: text("source").notNull(),
    /** 业务方确认状态（张凯打勾或 admin 手动确认时置 true） */
    confirmed: boolean("confirmed").notNull().default(false),
    /** 备注（张凯填，可记"此变体含义"或映射依据） */
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_legacy_product_name_code").on(
      t.legacyProductName,
      t.legacyProductCode,
    ),
    index("idx_lpm_target_category").on(t.targetCategoryId),
    index("idx_lpm_target_sku").on(t.targetSkuId),
    index("idx_lpm_unmapped")
      .on(t.confirmed)
      .where(sql`confirmed = false`),
  ],
);

export type LegacyProductMapping = typeof legacyProductMapping.$inferSelect;
export type NewLegacyProductMapping = typeof legacyProductMapping.$inferInsert;
