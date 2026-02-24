import { boolean, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { bigCategoryEnum, productTypeEnum, workfineSourceEnum } from './enums'

/**
 * 实体一：SPU 商品概念表
 *
 * 是否展示由关联 SKU 的 is_active 状态决定：
 * 至少一个 is_active=true 的 SKU 存在时才展示该 SPU。
 * 左侧分类选择器从本表动态派生，不查询 WorkFine UDT_M_229。
 */
export const productSpu = pgTable('product_spu', {
  spuId: text('spu_id').primaryKey(),
  /** 商品名称，如"蜜语生玑精华护理疗程" */
  name: text('name').notNull(),
  /** 品项分类，如"蜜语生玑"，对应 UDT_M_229.UDF_M_522，作为左侧一级导航节点 */
  category: text('category').notNull(),
  /**
   * 生美/非生美：服务项目类 SPU 标签，来自 UDT_M_1281/1383；
   * 院装产品：标识院装产品类 SPU，对应 UDT_M_341 数据源
   */
  bigCategory: bigCategoryEnum('big_category').notNull(),
  coverImage: text('cover_image'),
  description: text('description'),
  /** 排序权重，分类顺序由该分类下 sort_order 最小的 SPU 决定 */
  sortOrder: integer('sort_order').notNull().default(0),
})

/**
 * 实体一：SKU↔WorkFine 映射表
 *
 * 价格、疗程服务次数等字段运行时从 WorkFine 实时读取，不存入 PG。
 * UNIQUE(spu_id, workfine_item_id, workfine_source)
 */
export const productSpuSkuMap = pgTable(
  'product_spu_sku_map',
  {
    skuId: text('sku_id').primaryKey(),
    spuId: text('spu_id')
      .notNull()
      .references(() => productSpu.spuId),
    /** WorkFine 疗程项目编号（UDT_M_1281/1383.UDF_M_14503）或商品编号（UDT_M_341.UDF_M_1870） */
    workfineItemId: text('workfine_item_id').notNull(),
    workfineSource: workfineSourceEnum('workfine_source').notNull(),
    /**
     * 疗程卡：session_count≥2，多次核销；
     * 单品：session_count=1，一次核销；
     * 院装产品：支付即完成，不走到店服务流程
     */
    productType: productTypeEnum('product_type').notNull(),
    /** 规格展示名，如"10次卡"、"285ml/瓶" */
    skuDisplayName: text('sku_display_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** SPU 展示状态由所有 SKU 的 is_active 派生 */
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [unique('uq_spu_workfine').on(table.spuId, table.workfineItemId, table.workfineSource)],
)

export type ProductSpu = typeof productSpu.$inferSelect
export type NewProductSpu = typeof productSpu.$inferInsert
export type ProductSpuSkuMap = typeof productSpuSkuMap.$inferSelect
export type NewProductSpuSkuMap = typeof productSpuSkuMap.$inferInsert
