import { boolean, index, integer, numeric, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { couponStatusEnum, couponTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 券模板
 *
 * 定义券的规则（类型、面额、适用范围、有效期等）。
 */
export const couponTemplates = pgTable('coupon_templates', {
  templateId: text('template_id').primaryKey(),
  name: text('name').notNull(),
  couponType: couponTypeEnum('coupon_type').notNull(),
  /** 现金券/项目券=抵扣金额；折扣券=折扣率(0.85=85折) */
  discountValue: numeric('discount_value', { precision: 10, scale: 2 }).notNull(),
  /** 满减门槛（0=无门槛） */
  minSpend: numeric('min_spend', { precision: 10, scale: 2 }).default('0'),
  /** 折扣券封顶金额（V2） */
  maxDiscount: numeric('max_discount', { precision: 10, scale: 2 }),
  /** 发放总量限制（null=不限量） */
  totalCount: integer('total_count'),
  /** 适用商品ID数组（→ products.product_id），NULL=全部 */
  applicableProductIds: text('applicable_product_ids').array(),
  /** 适用品项分类ID数组（→ product_categories.category_id），NULL=全部 */
  applicableCategoryIds: text('applicable_category_ids').array(),
  /** 适用门店ID数组（→ stores.store_id），NULL=全部门店 */
  applicableStoreIds: text('applicable_store_ids').array(),
  /** 适用市场ID数组（→ org_nodes.id where type='market'），NULL=全部市场 */
  applicableMarketIds: text('applicable_market_ids').array(),
  /** fixed=固定日期区间，days=领取后N天 */
  validityMode: text('validity_mode').default('fixed'),
  /** fixed 模式：生效日期 */
  validFrom: timestamp('valid_from'),
  /** fixed 模式：到期日期 */
  validTo: timestamp('valid_to'),
  /** days 模式：领取后有效天数 */
  validDays: integer('valid_days'),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 用户券实例
 *
 * 每张实际发给用户的券。status 枚举管理生命周期。
 * 下单时通过原子 UPDATE + rowCount 校验防止重用。
 */
export const userCoupons = pgTable(
  'user_coupons',
  {
    couponId: text('coupon_id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => couponTemplates.templateId),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    status: couponStatusEnum('status').notNull().default('未使用'),
    /** 到期时间（发放时根据 validity_mode 计算） */
    expireAt: timestamp('expire_at').notNull(),
    /** 使用时写入的订单ID */
    usedSaleOrderId: varchar('used_sale_order_id', { length: 30 })
      .references(() => saleOrders.saleOrderId),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_coupons_user_status').on(table.userId, table.status),
    index('idx_user_coupons_used_order').on(table.usedSaleOrderId),
    index('idx_user_coupons_expire').on(table.expireAt),
  ],
)

export type CouponTemplate = typeof couponTemplates.$inferSelect
export type NewCouponTemplate = typeof couponTemplates.$inferInsert
export type UserCoupon = typeof userCoupons.$inferSelect
export type NewUserCoupon = typeof userCoupons.$inferInsert
